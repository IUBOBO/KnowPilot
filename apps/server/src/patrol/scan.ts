/**
 * 巡检引擎：判定"哪些投稿超期了"，并把结论对账成待办。
 *
 * 【为什么拆成"纯函数 + 对账"两层】
 *   `evaluateOverdue` 是**纯函数**：给它投稿、规则、当前时间，它给出超期清单，
 *   不碰库、不看钟。这样"什么算超期"这条规则可以用一组固定的输入离线验到底
 *   （patrol-check.ts 的断言 2），而不用先造一堆数据再猜它为什么不对。
 *   `reconcile` 才是有副作用的那层：读库、比对、在一个事务里落库。
 *
 * 【为什么这里一个字都不提"模型"】02 号 §2.1 把巡检定为 T3：比较时间戳。
 *   判定必须**可审计、可复现** —— 同一份台账跑两次给同一个结论。推理做不到
 *   这一点，而这里也根本不需要推理：超期天数是一次减法。
 */
import {
  DAY_MS,
  isInProgressStatus,
  type PatrolRunSummary,
  type SubmissionStatus,
} from '@knowpilot/shared';
import type { Db } from '../db/index.ts';
import {
  countOpenTasks,
  insertPatrolTask,
  listLiveTasks,
  listPatrolSubmissionInputs,
  listRules,
  resolvePatrolTask,
  type PatrolSubmissionInput,
} from './repo.ts';

/** 判定一条投稿是否需要规则。**只有这两个字段** —— 够判定，多给就是多余。 */
export interface PatrolRuleView {
  thresholdDays: number;
  enabled: boolean;
}

/** 一条"确实超期"的判定结果。 */
export interface OverdueHit {
  submissionId: string;
  ownerId: string | null;
  status: SubmissionStatus;
  /** 判定时用的阈值（留痕：以后阈值改了也说得清当时按几天判的） */
  thresholdDays: number;
  overdueDays: number;
  /** 判定时投稿的 updated_at。对账靠它区分"同一版"与"换了一版" */
  observedUpdatedAt: string;
}

/**
 * 从若干投稿里挑出超期的那些。**纯函数，无 IO。**
 *
 * 判据三连（全部满足才算）：
 *   1. 状态属于"进行中"（`isInProgressStatus`）—— 准备中与三个终态永不超期；
 *   2. 该档的规则存在且 enabled；
 *   3. 距上次更新已过的**整天数** `> 阈值`（正好等于阈值不算超期）。
 *
 * 【为什么是"整天数 > 阈值"，而不是"毫秒差 > 阈值天"】
 *   投稿是给人看的，"超期 14 天"这个说法必须能被界面上的人对上。
 *   若用毫秒差，一个 13 天 23 小时 59 分的稿子会因为差一分钟而不算超期，
 *   而界面显示的"更新于 13 天前"让人以为是 13 天整 —— 对不上。
 *   取整天数之后，"界面说 14 天 ⇒ 判定也是 14 天"，两边永远一致。
 */
export function evaluateOverdue(
  submissions: readonly PatrolSubmissionInput[],
  rules: ReadonlyMap<string, PatrolRuleView>,
  now: Date,
): OverdueHit[] {
  const hits: OverdueHit[] = [];
  for (const s of submissions) {
    // 认不出的 status 会落到 isInProgressStatus 的默认 false —— 与"不巡检它"同义，
    // 正是我们要的：分档只认受控词表里的那四档。
    if (!isInProgressStatus(s.status as SubmissionStatus)) continue;

    const rule = rules.get(s.status);
    if (rule === undefined || !rule.enabled) continue;

    const updatedMs = Date.parse(s.updatedAt);
    if (Number.isNaN(updatedMs)) continue; // 脏数据不参与判定，也不假装它超期

    const overdueDays = Math.floor((now.getTime() - updatedMs) / DAY_MS);
    if (overdueDays <= rule.thresholdDays) continue;

    hits.push({
      submissionId: s.id,
      ownerId: s.userId,
      status: s.status as SubmissionStatus,
      thresholdDays: rule.thresholdDays,
      overdueDays,
      observedUpdatedAt: s.updatedAt,
    });
  }
  return hits;
}

/**
 * 跑一次巡检：把当前超期的投稿对账成待办。**一个事务**。
 *
 * 对账四条规则（都在下面的循环里，逐条对应）：
 *   1. 活着的待办，其投稿不再超期 → 消解（`resolved`）。
 *   2. 活着的待办，其投稿换了一版（`updated_at` 变了）→ 先消解旧的（上面那条
 *      的 `observedUpdatedAt !== 投稿.updated_at` 分支），再按新版本重建。
 *   3. 命中的投稿，已有一条**同版本**活待办 → 什么都不做（**幂等**的关键）。
 *      被 `dismissed` 的也落在这条上 —— 同一版本上不会把忽略过的待办再冒出来。
 *   4. 命中的投稿，没有任何同版本活待办 → 新建一条 `open`。
 *
 * 【为什么"消解"要先于"新建"，且都在同一个事务里】
 *   新建时数据库上有局部唯一索引（`idx_patrol_tasks_live`）挡着"一条投稿
 *   两个活待办"。若先建后消，第 2 条场景（版本变了要重建）会撞上索引直接失败 ——
 *   所以顺序不能反。整个对账是一个事务：中途失败就完全回滚，
 *   不会留下"旧的消了、新的没建"这种中间态（那会让一条真实超期静静消失）。
 */
export function reconcile(db: Db, now: Date): PatrolRunSummary {
  const nowIso = now.toISOString();

  const rules = new Map<string, PatrolRuleView>(
    listRules(db).map((r) => [r.status, { thresholdDays: r.thresholdDays, enabled: r.enabled }]),
  );
  const hits = evaluateOverdue(listPatrolSubmissionInputs(db), rules, now);
  const live = listLiveTasks(db);

  const hitByTarget = new Map(hits.map((h) => [h.submissionId, h]));
  // 一条投稿至多一个活待办（数据库唯一索引保证），所以 target → task 是确定的。
  const liveByTarget = new Map(live.map((t) => [t.targetId, t]));

  let created = 0;
  let resolved = 0;

  db.exec('BEGIN');
  try {
    // 规则 1 + 2 的后半段：不再命中，或命中了但版本已变 → 消解。
    for (const t of live) {
      const hit = hitByTarget.get(t.targetId);
      if (hit === undefined || hit.observedUpdatedAt !== t.observedUpdatedAt) {
        resolvePatrolTask(db, t.id, nowIso);
        resolved += 1;
      }
    }

    // 规则 3 + 4：命中的投稿，没有同版本活待办才新建。
    for (const h of hits) {
      const t = liveByTarget.get(h.submissionId);
      if (t !== undefined && t.observedUpdatedAt === h.observedUpdatedAt) continue;
      insertPatrolTask(
        db,
        {
          targetId: h.submissionId,
          ownerId: h.ownerId,
          thresholdDays: h.thresholdDays,
          overdueDays: h.overdueDays,
          observedUpdatedAt: h.observedUpdatedAt,
        },
        nowIso,
      );
      created += 1;
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { created, resolved, stillOpen: countOpenTasks(db), at: nowIso };
}
