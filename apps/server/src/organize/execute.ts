/**
 * 计划执行。**这是整个项目里唯一会改动真实数据的代码。**
 *
 * 所以它通篇只有三条铁律，每一处实现都能对应回其中一条：
 *   1. **只在数据集自己的目录内**：每个路径都过 `assertInsideDir`，越界即拒；
 *   2. **只增不删**：这个文件里没有 `rm`、没有 `unlink`、没有 `rmdir`。
 *      整理做的是"把文件摆整齐"，不是"清理垃圾"。要删东西得是另一个功能，
 *      并且必须再走一次人的确认 —— 混在整理里会让"我只想挪一下"变成一次误删；
 *   3. **绝不覆盖**：目标重名时复用 `dedupeName` 改名，宁可给一个丑名字，
 *      也不让一份数据凭空消失。
 *
 * 失败是**部分失败**：一条动作出问题记一条、继续做下一条，最后如实汇报。
 * 整个循环包在一个 try 里只是为了拦住"意料之外"的崩溃（那时标记整份计划
 * failed），而不是用来回滚 —— 已经移过去的文件不该被"撤销"，那需要第二次
 * 移动，风险比它解决的问题更大。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { AppError, type OrganizeActionRecord, type OrganizePlan } from '@knowpilot/shared';
import type { Db } from '../db/index.ts';
import { assertInsideDir, dedupeName } from '../uploads/layout.ts';
import { expandRules } from './preview.ts';
import { insertAction, insertPlan, setPlanResult } from './repo.ts';

export interface ExecuteInput {
  assetId: string;
  /** 数据集根的绝对路径。 */
  datasetDir: string;
  plan: OrganizePlan;
  /** 用户确认时预览出来的条数。与磁盘现状对不上就拒，见 shared/organize.ts。 */
  expectedMoves: number;
  /** 发起者。落进 organize_plans.created_by，事后能答"这个目录被谁整理过" */
  createdBy: string | null;
}

export interface ExecuteOutcome {
  planId: string;
  moved: number;
  skipped: number;
  failedCount: number;
  actions: readonly OrganizeActionRecord[];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function executePlan(db: Db, input: ExecuteInput): ExecuteOutcome {
  const { datasetDir, plan } = input;

  const expanded = expandRules(datasetDir, plan);

  // ── 校验阶段：有任何一条不对，就"一条都不动" ──────────────────
  //
  // 【为什么校验不通过也要落一行 failed】"谁在什么时候试图执行一份不合法的
  //   计划"本身就是要留痕的事 —— 它是可追溯性的一部分，不是噪音。
  //   而"预览已过期"（expectedMoves 对不上）不落行：那不是一份不合法或不安全
  //   的计划，只是信息旧了，用户在界面上点一下重新预览就没了下文，
  //   记下来只会让历史里堆满没有意义的失败条目。
  const problems = expanded.preview.rules
    .map((r, i) => (r.problem === undefined ? null : `第 ${i + 1} 条规则：${r.problem}`))
    .filter((p): p is string => p !== null);

  if (problems.length > 0) {
    recordRejected(db, input, `计划里有不合法的规则，一条都没有执行：\n${problems.join('\n')}`);
    throw new AppError(
      'invalid_argument',
      `这份计划里有不合法的规则，已拒绝执行（没有移动任何文件）：${problems.join('；')}`,
    );
  }

  if (expanded.moves.length !== input.expectedMoves) {
    throw new AppError(
      'invalid_argument',
      `数据集里的文件在你确认之后变过了：预览时是 ${input.expectedMoves} 个，` +
        `现在匹配到 ${expanded.moves.length} 个。请重新预览、再确认一次。`,
    );
  }

  if (expanded.moves.length === 0) {
    throw new AppError('invalid_argument', '这份计划不会移动任何文件，没有可执行的内容。');
  }

  // ── 落库：先把"打算做什么"记下来，再动手 ─────────────────────
  const planId = randomUUID();
  insertPlan(db, {
    id: planId,
    assetId: input.assetId,
    datasetDir,
    summary: plan.summary,
    rulesJson: JSON.stringify(plan.rules),
    status: 'pending',
    plannedMoves: input.expectedMoves,
    note: null,
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
  });

  const actions: OrganizeActionRecord[] = [];
  let ord = 0;
  let moved = 0;
  let skipped = 0;
  let failedCount = 0;
  /** 已经处理过的目标目录，避免同一个目录记多条 mkdir。 */
  const seenDirs = new Set<string>();

  function record(entry: {
    action: 'mkdir' | 'move';
    fromPath: string | null;
    toPath: string;
    status: 'done' | 'skipped' | 'failed';
    reason: string | null;
    /** 只有 done 的 move 有：撤销时拿它核对"目标还是当初那个文件"。 */
    size?: number | null;
    mtimeMs?: number | null;
  }): void {
    const n = ord;
    ord += 1;
    insertAction(db, {
      id: randomUUID(),
      planId,
      ord: n,
      action: entry.action,
      fromPath: entry.fromPath,
      toPath: entry.toPath,
      status: entry.status,
      reason: entry.reason,
      createdAt: new Date().toISOString(),
      size: entry.size ?? null,
      mtimeMs: entry.mtimeMs ?? null,
      phase: 'execute',
      undoOf: null,
    });
    actions.push({
      action: entry.action,
      fromPath: entry.fromPath,
      toPath: entry.toPath,
      status: entry.status,
      reason: entry.reason,
    });
  }

  try {
    for (const m of expanded.moves) {
      const toDirRel = m.toRel.includes('/') ? m.toRel.slice(0, m.toRel.lastIndexOf('/')) : '';
      const toDirAbs = join(datasetDir, toDirRel);

      // 目标目录：第一次用到它时确保存在。存在的就不记 mkdir —— 动作明细里
      // 每一条都该是"这次确实做了的事"，不是"检查过一遍的事"。
      if (!seenDirs.has(toDirRel)) {
        seenDirs.add(toDirRel);
        if (!existsSync(toDirAbs)) {
          try {
            assertInsideDir(datasetDir, toDirAbs, `目标目录 ${toDirRel}`);
            mkdirSync(toDirAbs, { recursive: true });
            record({ action: 'mkdir', fromPath: null, toPath: toDirRel, status: 'done', reason: null });
          } catch (err) {
            record({
              action: 'mkdir',
              fromPath: null,
              toPath: toDirRel,
              status: 'failed',
              reason: messageOf(err),
            });
          }
        }
      }

      const fromAbs = join(datasetDir, m.fromRel);

      // 源不在了：预览之后被人动过。这是 skipped 的真实用途 —— 它不是错误，
      // 只是"这条没得做了"，而且必须如实说出来，不能让 moved 数字骗人。
      if (!existsSync(fromAbs)) {
        skipped += 1;
        record({
          action: 'move',
          fromPath: m.fromRel,
          toPath: m.toRel,
          status: 'skipped',
          reason: '源文件已不存在（可能在预览之后被移动或删除了）。',
        });
        continue;
      }

      try {
        assertInsideDir(datasetDir, fromAbs, `来源 ${m.fromRel}`);

        const original = basename(m.toRel);
        const taken = (name: string): boolean => existsSync(join(toDirAbs, name));
        let finalName = original;
        let note: string | null = null;
        if (taken(original)) {
          finalName = dedupeName(original, taken);
          note = `目标目录已有同名文件，改名为 "${finalName}"（没有覆盖已有文件）。`;
        }
        const toAbs = join(toDirAbs, finalName);
        assertInsideDir(datasetDir, toAbs, `目标 ${toDirRel}/${finalName}`);

        if (resolve(fromAbs) === resolve(toAbs)) {
          // 理论上到不了这里（目标子树里的文件在展开时已被排除），
          // 但"移动到自己身上"是能想到的最坏结果之一，留一道显式的判断。
          skipped += 1;
          record({
            action: 'move',
            fromPath: m.fromRel,
            toPath: toDirRel === '' ? finalName : `${toDirRel}/${finalName}`,
            status: 'skipped',
            reason: '文件已经在这个位置了。',
          });
          continue;
        }

        renameSync(fromAbs, toAbs);
        moved += 1;
        // 指纹在移动**之后**取：撤销要核对的是目标位置上那个文件。
        // 取不到（极少见）不影响这次移动本身，但这条动作会因此没有指纹，
        // 整份计划随之不可撤销 —— repo.ts 的 undoable 判据就是按这个算的。
        let size: number | null = null;
        let mtimeMs: number | null = null;
        try {
          const st = statSync(toAbs);
          size = st.size;
          mtimeMs = Math.round(st.mtimeMs);
        } catch {
          // 留空即可，理由见上。
        }
        record({
          action: 'move',
          fromPath: m.fromRel,
          toPath: toDirRel === '' ? finalName : `${toDirRel}/${finalName}`,
          status: 'done',
          reason: note,
          size,
          mtimeMs,
        });
      } catch (err) {
        failedCount += 1;
        record({
          action: 'move',
          fromPath: m.fromRel,
          toPath: m.toRel,
          status: 'failed',
          reason: messageOf(err),
        });
      }
    }
  } catch (err) {
    // 意料之外的崩溃：把计划标成 failed 再抛。已经移动过的文件**不回滚** ——
    // 明细里如实记着移到哪了，人可以去核对；"自动撤销"要靠第二次移动，
    // 在半途崩溃的状态下做这件事只会扩大损坏面。
    const note = `执行过程中断：${messageOf(err)}`;
    setPlanResult(db, planId, {
      status: 'failed',
      moved,
      failedCount,
      note,
      executedAt: new Date().toISOString(),
    });
    throw new AppError('internal', `整理执行中断：${messageOf(err)}`);
  }

  const note =
    failedCount > 0
      ? `有 ${failedCount} 个动作没能成功，详见动作明细。`
      : skipped > 0
        ? `有 ${skipped} 个文件在取的时候已经不在了，其余已移动。`
        : null;

  setPlanResult(db, planId, {
    status: 'executed',
    moved,
    failedCount,
    note,
    executedAt: new Date().toISOString(),
  });

  return { planId, moved, skipped, failedCount, actions };
}

/** 记一行"这份计划被拒了"，然后由调用方抛出。 */
function recordRejected(db: Db, input: ExecuteInput, note: string): void {
  insertPlan(db, {
    id: randomUUID(),
    assetId: input.assetId,
    datasetDir: input.datasetDir,
    summary: input.plan.summary,
    rulesJson: JSON.stringify(input.plan.rules),
    status: 'failed',
    plannedMoves: input.expectedMoves,
    note,
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
  });
}
