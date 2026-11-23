/**
 * 巡检规则的读写、待办的读写。数据库列名是 snake_case，对外契约是 camelCase，
 * 转换只在这一个文件里发生（与 submissions/repo.ts 同一条约定）。
 *
 * 【本文件里没有"模型"两个字】巡检是 T3：比较时间戳。判定在 scan.ts 的纯函数里，
 *   这里只负责把它算出来的结论落库、以及把库里的行读成契约形状。
 */
import { randomUUID } from 'node:crypto';
import type {
  PatrolRule,
  PatrolSubjectStatus,
  PatrolTask,
  PatrolTaskStatus,
} from '@knowpilot/shared';
import type { Db } from '../db/index.ts';

/**
 * 谁能看/动一条待办。
 *
 * 【为什么不复用 auth/scope.ts 的 RowScope / scopePredicate】
 *   那边的判据是"`owner IS NULL` = 公共历史数据，谁都能看"。这条待办的归属列
 *   `patrol_tasks.owner_id` 为 NULL 的含义**完全不同**：它说的是"这条投稿本身
 *   就没有归属人"（阶段 1–3 的无主投稿）。把它当成公共数据，等于给每个成员
 *   看一条他既看不懂、也无权处理的待办 —— 那不是透明，是噪音。
 *   所以待办的可见性是更简单的一条：**有 patrol.manage 看全部，否则只看严格
 *   属于自己的**；无主待办因此只有管理员看得到。
 */
export interface PatrolViewer {
  userId: string;
  /** 持有 `patrol.manage`（本项目里即管理员）。看全部、能忽略任何一条。 */
  canManageAll: boolean;
}

const RULE_COLUMNS = `r.status, r.threshold_days, r.enabled, r.notify_channel,
  r.updated_at, r.updated_by, u.display_name AS updated_by_name`;

const RULE_FROM = `FROM patrol_rules r LEFT JOIN users u ON u.id = r.updated_by`;

interface RuleRow {
  status: string;
  threshold_days: number;
  enabled: number;
  notify_channel: string;
  updated_at: string;
  updated_by: string | null;
  updated_by_name: string | null;
}

function toRule(row: RuleRow): PatrolRule {
  return {
    status: row.status as PatrolSubjectStatus,
    thresholdDays: row.threshold_days,
    enabled: row.enabled === 1,
    notifyChannel: row.notify_channel,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    updatedByName: row.updated_by_name,
  };
}

/**
 * 全部规则，按状态固定顺序（不是字母序：界面上四行要按投稿流程排）。
 *
 * 排序在 SQL 里用一个 CASE，而不是在 JS 里按 PATROL_SUBJECT_STATUSES 重排 ——
 * 规则表里理论上可能有词表之外的档（历史遗留），那样重排会把它悄悄丢掉。
 * 这里用 CASE 兜底到 99，认不出的档排在最后但**不会被吞掉**。
 */
export function listRules(db: Db): PatrolRule[] {
  const rows = db
    .prepare(
      `SELECT ${RULE_COLUMNS} ${RULE_FROM}
       ORDER BY CASE r.status
         WHEN 'pending_initial' THEN 0
         WHEN 'under_review' THEN 1
         WHEN 'revision_resubmitted' THEN 2
         WHEN 'accepted_pending' THEN 3
         ELSE 99 END`,
    )
    .all() as unknown as RuleRow[];
  return rows.map(toRule);
}

/**
 * 改一条规则。只改 `threshold_days` / `enabled` 两个字段（缺省 = 不动它）。
 *
 * 【为什么返回 null 而不是抛错】调用方（handler）已经校验过 status 在词表内，
 *   走到这里还查不到，说明规则表和词表分叉了 —— 那是个需要被如实报告的状态，
 *   不是"假装改成功了"。返回 null，handler 转成 400/404，别静默。
 *
 * 状态本身不可改（它是主键，也是分档的判据）：要停用某一档就把 enabled 置 0，
 * 而不是把它的键改掉 —— 后者会让历史上的待办失去对应的规则。
 */
export function updateRule(
  db: Db,
  status: PatrolSubjectStatus,
  patch: { thresholdDays?: number; enabled?: boolean },
  actorId: string,
  now: string,
): PatrolRule | null {
  const exists = db
    .prepare('SELECT 1 AS x FROM patrol_rules WHERE status = ?')
    .get(status) as unknown as { x: number } | undefined;
  if (exists === undefined) return null;

  db.prepare(
    `UPDATE patrol_rules
        SET threshold_days = COALESCE(?, threshold_days),
            enabled        = COALESCE(?, enabled),
            updated_at     = ?,
            updated_by     = ?
      WHERE status = ?`,
  ).run(
    patch.thresholdDays ?? null,
    patch.enabled === undefined ? null : patch.enabled ? 1 : 0,
    now,
    actorId,
    status,
  );
  return getRule(db, status);
}

function getRule(db: Db, status: string): PatrolRule | null {
  const row = db
    .prepare(`SELECT ${RULE_COLUMNS} ${RULE_FROM} WHERE r.status = ?`)
    .get(status) as unknown as RuleRow | undefined;
  return row === undefined ? null : toRule(row);
}

// ── 待办 ────────────────────────────────────────────────────────

const TASK_COLUMNS = `t.id, t.target_type, t.target_id, t.owner_id, t.status,
  t.threshold_days, t.overdue_days, t.observed_updated_at, t.created_at,
  t.dismissed_by, t.dismissed_at, t.dismiss_reason, t.resolved_at,
  u.display_name AS owner_name,
  s.title AS submission_title, s.status AS submission_status, s.updated_at AS submission_updated_at`;

/**
 * 待办连着投稿与归属人。
 *
 * 两个 LEFT JOIN 都不能换成内连接：`owner_id` 可空（无主投稿）、
 *   `target_id` 理论上可能指向一个已不存在的对象（target_type 是可扩展的）。
 *   换成内连接，这些待办会从列表里整条消失 —— 而它们恰恰是最需要被人看到的。
 */
const TASK_FROM = `FROM patrol_tasks t
  LEFT JOIN users u ON u.id = t.owner_id
  LEFT JOIN submissions s ON s.id = t.target_id`;

/** open 在最前，其次 dismissed，resolved 最后；同类里新生成的在前。 */
const TASK_ORDER = `ORDER BY CASE t.status
    WHEN 'open' THEN 0 WHEN 'dismissed' THEN 1 ELSE 2 END,
  t.created_at DESC`;

/**
 * 列表只给"活着"的待办（open / dismissed）。
 *
 * 【为什么把 resolved 挡在列表外】resolved 说的是"这条待办**已经不成立了**"
 *   —— 投稿改了版本、进了终态，或规则被停用。它在库里必须留着（谁在何时
 *   对哪一版判定过，是可审计的痕），但它不是一个**待办**：把它显示出来，
 *   等于让已经处理完的事继续占着人的注意力。历史在库里，不在列表里。
 *   与 listTasksByOwner 用同一条谓词，两处的"活着"必须是一件事。
 */
const LIVE_TASK_WHERE = `t.status IN ('open','dismissed') AND s.deleted_at IS NULL`;

interface TaskRow {
  id: string;
  target_type: string;
  target_id: string;
  owner_id: string | null;
  status: string;
  threshold_days: number;
  overdue_days: number;
  observed_updated_at: string;
  created_at: string;
  dismissed_by: string | null;
  dismissed_at: string | null;
  dismiss_reason: string | null;
  resolved_at: string | null;
  owner_name: string | null;
  submission_title: string | null;
  submission_status: string | null;
  submission_updated_at: string | null;
}

function toTask(row: TaskRow): PatrolTask {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    status: row.status as PatrolTaskStatus,
    thresholdDays: row.threshold_days,
    overdueDays: row.overdue_days,
    observedUpdatedAt: row.observed_updated_at,
    createdAt: row.created_at,
    dismissedBy: row.dismissed_by,
    dismissedAt: row.dismissed_at,
    dismissReason: row.dismiss_reason,
    resolvedAt: row.resolved_at,
    submissionTitle: row.submission_title,
    submissionStatus: row.submission_status as PatrolTask["submissionStatus"],
    submissionUpdatedAt: row.submission_updated_at,
  };
}

function loadTask(db: Db, id: string): PatrolTask | null {
  const row = db
    .prepare(`SELECT ${TASK_COLUMNS} ${TASK_FROM} WHERE t.id = ? AND s.deleted_at IS NULL`)
    .get(id) as unknown as TaskRow | undefined;
  return row === undefined ? null : toTask(row);
}

/**
 * 待办列表（管理端看全部，成员端只看自己的）。只含"活着"的（见 LIVE_TASK_WHERE）。
 *
 * 可见性在 WHERE 里收口（同 auth/scope.ts 顶部那条理由：先查再筛会让 LIMIT 变形）。
 * 这里手写谓词而不用 scopePredicate —— 见 PatrolViewer 上方的说明。
 */
export function listTasks(db: Db, limit: number, viewer: PatrolViewer): PatrolTask[] {
  const rows = viewer.canManageAll
    ? (db
        .prepare(`SELECT ${TASK_COLUMNS} ${TASK_FROM} WHERE ${LIVE_TASK_WHERE} ${TASK_ORDER} LIMIT ?`)
        .all(limit) as unknown as TaskRow[])
    : (db
        .prepare(
          `SELECT ${TASK_COLUMNS} ${TASK_FROM}
            WHERE t.owner_id = ? AND ${LIVE_TASK_WHERE} ${TASK_ORDER} LIMIT ?`,
        )
        .all(viewer.userId, limit) as unknown as TaskRow[]);
  return rows.map(toTask);
}

/**
 * 某个人自己投稿上的待办（首页「我的待办」用）。严格 `owner_id = 我`。
 *
 * 【为什么含 dismissed】首页要能显示"这条我忽略过了"。只给 open 的话，
 *   用户点过忽略之后那条会凭空消失，他会以为自己没点成功、再去点一次。
 *   `resolved` 的确实不必显示 —— 它已经不成立了。
 */
export function listTasksByOwner(db: Db, ownerId: string, limit: number): PatrolTask[] {
  const rows = db
    .prepare(
      `SELECT ${TASK_COLUMNS} ${TASK_FROM}
        WHERE t.owner_id = ? AND ${LIVE_TASK_WHERE}
        ${TASK_ORDER} LIMIT ?`,
    )
    .all(ownerId, limit) as unknown as TaskRow[];
  return rows.map(toTask);
}

/**
 * 忽略一条待办：记下忽略人与时间。
 *
 * 返回 null 的三种情况**对外长得一模一样**（都转 404）：
 *   · 没有这条
 *   · 这条不属于你、你又不是管理员（看不见与不存在不区分，同 submissions 的 404 口径）
 *   · 这条已经 resolved（忽略一个自己不成立的待办没有意义）
 * 已经 dismissed 的**再点一次是幂等的**（返回它原样）—— 界面上的双击、重试都会走到这里，
 * 报错只会让人以为哪里坏了。
 */
export function dismissTask(
  db: Db,
  taskId: string,
  viewer: PatrolViewer,
  reason: string | null,
  now: string,
): PatrolTask | null {
  const row = db
    .prepare('SELECT owner_id, status FROM patrol_tasks WHERE id = ?')
    .get(taskId) as unknown as { owner_id: string | null; status: string } | undefined;
  if (row === undefined) return null;
  if (row.status === 'resolved') return null;

  const visible = viewer.canManageAll || (row.owner_id !== null && row.owner_id === viewer.userId);
  if (!visible) return null;

  if (row.status === 'open') {
    db.prepare(
      `UPDATE patrol_tasks
          SET status = 'dismissed', dismissed_by = ?, dismissed_at = ?, dismiss_reason = ?
        WHERE id = ?`,
    ).run(viewer.userId, now, reason, taskId);
  }
  return loadTask(db, taskId);
}

// ── 巡检引擎（scan.ts）用的读写原语 ─────────────────────────────

/** 一次判定要看的投稿字段。**只取这几列**：巡检不需要标题、期刊、时间线。 */
export interface PatrolSubmissionInput {
  id: string;
  userId: string | null;
  status: string;
  updatedAt: string;
}

/**
 * 全库存量投稿的最小投影。
 *
 * 【为什么不在这里按状态过滤】"哪些档该被盯"的判据是 `isInProgressStatus()`，
 *   它住在 shared、是唯一的权威。在 SQL 里再写一遍 IN (...) 就有了第二份词表，
 *   加档位时必漏一处。单实验室的台账是几十到几百行，全量取出来在 JS 里筛，
 *   换来的是一条判据、一个真相。
 */
export function listPatrolSubmissionInputs(db: Db): PatrolSubmissionInput[] {
  const rows = db
    .prepare('SELECT id, user_id, status, updated_at FROM submissions WHERE deleted_at IS NULL')
    .all() as unknown as { id: string; user_id: string | null; status: string; updated_at: string }[];
  return rows.map((r) => ({ id: r.id, userId: r.user_id, status: r.status, updatedAt: r.updated_at }));
}

/** 当前"活着"的待办（open 或 dismissed）。resolved 的不参与对账。 */
export interface LiveTask {
  id: string;
  targetId: string;
  status: 'open' | 'dismissed';
  observedUpdatedAt: string;
}

export function listLiveTasks(db: Db): LiveTask[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.target_id, t.status, t.observed_updated_at
         ${TASK_FROM} WHERE ${LIVE_TASK_WHERE}`,
    )
    .all() as unknown as {
    id: string;
    target_id: string;
    status: 'open' | 'dismissed';
    observed_updated_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    targetId: r.target_id,
    status: r.status,
    observedUpdatedAt: r.observed_updated_at,
  }));
}

/**
 * 建一条待办。应用内通知 = 生成即已通知，所以 `notified_at` 落 `now`。
 *
 * 调用方负责"同一版本不重复建"的判定（scan.ts）；万一漏了，
 * 数据库上的局部唯一索引 `idx_patrol_tasks_live` 会直接拒绝插入 ——
 * 那是一个**响亮**的失败，好过悄悄堆出一串重复待办。
 */
export function insertPatrolTask(
  db: Db,
  input: {
    targetId: string;
    ownerId: string | null;
    thresholdDays: number;
    overdueDays: number;
    observedUpdatedAt: string;
  },
  now: string,
): void {
  db.prepare(
    `INSERT INTO patrol_tasks
       (id, target_type, target_id, owner_id, status, threshold_days, overdue_days,
        observed_updated_at, created_at, notified_at)
     VALUES (?, 'submission', ?, ?, 'open', ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.targetId,
    input.ownerId,
    input.thresholdDays,
    input.overdueDays,
    input.observedUpdatedAt,
    now,
    now,
  );
}

/** 消解一条待办：不再超期了，或它的投稿已经换了一版（旧版本被新版本取代）。 */
export function resolvePatrolTask(db: Db, id: string, now: string): void {
  db.prepare(
    `UPDATE patrol_tasks SET status = 'resolved', resolved_at = ?
      WHERE id = ? AND status IN ('open','dismissed')`,
  ).run(now, id);
}

/** 库里挂了多少条 open 待办。巡检结果里的 `stillOpen`。 */
export function countOpenTasks(db: Db): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM patrol_tasks WHERE status = 'open'`)
    .get() as unknown as { n: number };
  return row.n;
}

/**
 * 有没有配过任何配额行。
 *
 * 只回答"配了没有"，不返回行内容 —— 管理端这一版只读展示，
 * 界面据此写"未设配额（只记录不阻断）"而不是显示一个会被读成"配额 0"的数字。
 */
export function countUserQuotas(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM user_quotas').get() as unknown as { n: number };
  return row.n;
}
