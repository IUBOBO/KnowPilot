/**
 * 撤销一次已经执行过的整理。**与执行同一量级的写动作。**
 *
 * 铁律照旧，一条不少：
 *   1. **只在数据集自己的目录内**：`from_path` / `to_path` 都从库里读出来，
 *      仍然要过 `assertInsideDir` —— 库里的值也是当年从一条 API 请求写进去的。
 *   2. **只增不删**：这个文件里没有 `rm`、`unlink`、`rmdir`。撤销只做反向
 *      移动；整理时新建的目录**原样留在那里**，哪怕它因此变空。删目录属于
 *      "清理"，不在这条链路上。
 *   3. **绝不覆盖**：原位置已经有同名文件就跳过，宁可留着不动也不覆盖。
 *
 * 【为什么撤销前要核对文件指纹】整理之后到撤销之前，用户完全可能又往那个
 *   目标目录里放了东西，甚至把整理出来的文件替换成了另一个同名文件。
 *   此时"按路径移回去"移走的就是**不是当初那个文件**。执行时记下大小与
 *   修改时间，撤销前再核对一遍；不一致就跳过并说明。跳过不是错误 ——
 *   它恰恰是这个功能该有的保守。
 *
 * 【为什么老计划拒绝撤销】指纹是随撤销功能一起上线的（迁移 v21）。在那之前
 *   执行的计划没有指纹，也就失去了"目标还是不是当初那个文件"的唯一判据。
 *   没有判据时**拒绝**，而不是按状态猜 —— 盲移一份数据比撤不了更糟。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  AppError,
  type OrganizeActionRecord,
  type OrganizeUndoResponse,
} from '@knowpilot/shared';
import type { Db } from '../db/index.ts';
import { assertInsideDir } from '../uploads/layout.ts';
import {
  getPlanForUndo,
  insertAction,
  listUndoActions,
  setUndoResult,
  type UndoActionRow,
} from './repo.ts';

export interface UndoInput {
  assetId: string;
  planId: string;
  /** 这条数据集**此刻**的目录。必须与计划冻结的那个一致，否则不撤。 */
  currentDatasetDir: string;
  undoneBy: string | null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function undoPlan(db: Db, input: UndoInput): OrganizeUndoResponse {
  const plan = getPlanForUndo(db, input.assetId, input.planId);
  if (plan === null) throw new AppError('not_found', '没有这份整理计划。');

  if (plan.undoneAt !== null || plan.status === 'undone') {
    throw new AppError('invalid_argument', '这份整理已经撤销过了，不能重复撤销。');
  }
  if (plan.status === 'pending') {
    throw new AppError('invalid_argument', '这份计划还没有执行过，没有可撤销的内容。');
  }
  if (plan.status === 'failed') {
    throw new AppError(
      'invalid_argument',
      '这份计划在执行时失败了（或被执行前就被拒绝），没有可撤销的整理。',
    );
  }

  // 目录在整理之后被改过 → 冻结的路径指向的可能已经不是同一批数据。
  // 这里拒绝，让人去看一眼，而不是把文件移进一个陌生的目录。
  if (resolve(plan.datasetDir) !== resolve(input.currentDatasetDir)) {
    throw new AppError(
      'invalid_argument',
      `这条数据集的目录在整理之后变过：当时是 ${plan.datasetDir}，现在是 ` +
        `${input.currentDatasetDir}。撤销会按当时的路径移动文件，已拒绝。`,
    );
  }

  const datasetDir = plan.datasetDir;
  const planId = plan.id;
  const actions = listUndoActions(db, planId);

  if (actions.length === 0) {
    throw new AppError('invalid_argument', '这次整理没有成功移动任何文件，没有可撤销的内容。');
  }

  // 校验阶段：任何一条没有指纹，整份计划拒绝。不能撤一半才发现撤不了另一半。
  const missingFingerprint = actions.some(
    (a) => a.fromPath === null || a.size === null || a.mtimeMs === null,
  );
  if (missingFingerprint) {
    throw new AppError(
      'invalid_argument',
      '这次整理执行于撤销功能上线前，没有记录文件指纹（大小与修改时间），' +
        '无法确认目标位置还是当初那个文件，因此不能撤销。',
    );
  }

  const records: OrganizeActionRecord[] = [];
  let restored = 0;
  let skipped = 0;
  let failedCount = 0;
  let undoOrd = 0;

  function record(entry: {
    action: UndoActionRow;
    status: 'done' | 'skipped' | 'failed';
    reason: string | null;
    size: number | null;
    mtimeMs: number | null;
  }): void {
    // 撤销动作的 from/to 与执行动作**方向相反**：从整理后的位置出发，回到原位置。
    const fromPath = entry.action.toPath;
    const toPath = entry.action.fromPath ?? '';
    insertAction(db, {
      id: randomUUID(),
      planId,
      ord: undoOrd,
      action: 'move',
      fromPath,
      toPath,
      status: entry.status,
      reason: entry.reason,
      createdAt: new Date().toISOString(),
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      phase: 'undo',
      undoOf: entry.action.id,
    });
    undoOrd += 1;
    records.push({
      action: 'move',
      fromPath,
      toPath,
      status: entry.status,
      reason: entry.reason,
    });
  }

  for (const a of actions) {
    const fromAbs = join(datasetDir, a.fromPath ?? '');
    const toAbs = join(datasetDir, a.toPath);

    try {
      assertInsideDir(datasetDir, fromAbs, `原位置 ${a.fromPath ?? ''}`);
      assertInsideDir(datasetDir, toAbs, `整理后的位置 ${a.toPath}`);

      // 目标（整理后的位置）不在了：整理之后被人移动/删除了。没得撤，跳过。
      const target = statSync(toAbs, { throwIfNoEntry: false });
      if (target === undefined) {
        skipped += 1;
        record({
          action: a,
          status: 'skipped',
          reason: '这个文件已经不在整理后的位置了（可能在整理之后被移动或删除了）。',
          size: null,
          mtimeMs: null,
        });
        continue;
      }
      if (!target.isFile()) {
        skipped += 1;
        record({
          action: a,
          status: 'skipped',
          reason: '整理后的位置上已经不是普通文件，没有动它。',
          size: null,
          mtimeMs: null,
        });
        continue;
      }

      // 指纹核对：这里回答的是"还是当初那个文件吗"。
      if (target.size !== a.size || Math.round(target.mtimeMs) !== a.mtimeMs) {
        skipped += 1;
        record({
          action: a,
          status: 'skipped',
          reason:
            '这个文件在整理之后被改动过（大小或修改时间与执行时不一致），' +
            '为免移走别的文件，没有动它。',
          size: target.size,
          mtimeMs: Math.round(target.mtimeMs),
        });
        continue;
      }

      // 原位置已经有东西：绝不覆盖。
      if (existsSync(fromAbs)) {
        skipped += 1;
        record({
          action: a,
          status: 'skipped',
          reason: '原来的位置已经有同名文件了（可能整理之后又被放进来的），没有覆盖。',
          size: target.size,
          mtimeMs: Math.round(target.mtimeMs),
        });
        continue;
      }

      // 原位置所在的目录在整理之后被删掉了 → 只把它建回来（只增不删）。
      const parent = dirname(fromAbs);
      let recreated = false;
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
        recreated = true;
      }

      renameSync(toAbs, fromAbs);
      restored += 1;
      record({
        action: a,
        status: 'done',
        reason: recreated ? '原位置所在的目录已不存在，已重新建立后移回。' : null,
        size: target.size,
        mtimeMs: Math.round(target.mtimeMs),
      });
    } catch (err) {
      failedCount += 1;
      record({
        action: a,
        status: 'failed',
        reason: messageOf(err),
        size: null,
        mtimeMs: null,
      });
    }
  }

  // 【为什么一条都没移回时不标 undone】"跳过"意味着文件还在整理后的位置，
  //   磁盘上什么都没变。把它标成已撤销，历史里就会写着一件没发生的事，
  //   而且重试的路也被堵死了。保持 executed，人可以处理掉冲突后再试。
  if (restored > 0) {
    const noteParts: string[] = [`${restored} 个文件已移回原位。`];
    if (skipped > 0) noteParts.push(`${skipped} 个被跳过（详见动作明细）。`);
    if (failedCount > 0) noteParts.push(`${failedCount} 个移回失败。`);

    db.exec('BEGIN');
    try {
      setUndoResult(db, plan.id, {
        undoneAt: new Date().toISOString(),
        undoneBy: input.undoneBy,
        moved: restored,
        skipped,
        failedCount,
        note: noteParts.join(''),
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    planId: plan.id,
    restored,
    skipped,
    failedCount,
    actions: records,
  };
}
