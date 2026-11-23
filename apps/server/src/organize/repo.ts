/**
 * 整理计划与动作的读写。只碰数据库。
 *
 * 表的设计理由见 migrations v12 顶部：计划先落（pending）再执行，
 * 每个动作单独一行，为的是"中途断了也能说清本来打算做什么、做到第几条"。
 */
import type { OrganizeActionStatus, OrganizePlanStatus, OrganizePlanSummary } from '@knowpilot/shared';
import type { Db } from '../db/index.ts';

export interface InsertPlanInput {
  id: string;
  assetId: string;
  /** 数据集根的绝对路径，执行时冻结下来。 */
  datasetDir: string;
  summary: string;
  rulesJson: string;
  status: OrganizePlanStatus;
  plannedMoves: number;
  note: string | null;
  createdAt: string;
  /**
   * 发起这次整理的人。
   *
   * 【为什么是"发起"而不是"执行"】计划行是在**执行请求**里落库的
   *   （生成阶段只跑模型拟计划，不写库），所以这一列拿到的就是执行者。
   *   记录下来的价值在于：事后看"这个目录是被谁整理的"，答案不该是 NULL。
   *
   * 这一列**没有外键**（SQLite 加不了，见迁移 v15 的注释），
   * 所以用户被删掉之后这里会留下一个悬空的 id —— 是已知的、可接受的记账不完整。
   */
  createdBy: string | null;
}

export function insertPlan(db: Db, row: InsertPlanInput): void {
  db.prepare(
    `INSERT INTO organize_plans
       (id, asset_id, dataset_dir, summary, rules_json, status, planned_moves,
        moved, failed_count, note, created_by, created_at, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, NULL)`,
  ).run(
    row.id,
    row.assetId,
    row.datasetDir,
    row.summary,
    row.rulesJson,
    row.status,
    row.plannedMoves,
    row.note,
    row.createdBy,
    row.createdAt,
  );
}

/**
 * 执行结束后回写结果。
 *
 * 有失败动作时 status 仍然是 `executed` —— 靠 `failed_count` 与动作明细表达
 * "部分成功"。把它写成 `failed` 会抹掉"其实移动了 87 个"这件事，
 * 而用户下一步要做的判断（"我该不该重跑"）恰恰依赖这个数。
 */
export function setPlanResult(
  db: Db,
  id: string,
  row: {
    status: OrganizePlanStatus;
    moved: number;
    failedCount: number;
    note: string | null;
    executedAt: string;
  },
): void {
  db.prepare(
    `UPDATE organize_plans
        SET status = ?, moved = ?, failed_count = ?, note = ?, executed_at = ?
      WHERE id = ?`,
  ).run(row.status, row.moved, row.failedCount, row.note, row.executedAt, id);
}

export interface InsertActionInput {
  id: string;
  planId: string;
  ord: number;
  action: 'mkdir' | 'move';
  fromPath: string | null;
  toPath: string;
  status: OrganizeActionStatus;
  reason: string | null;
  createdAt: string;
  /**
   * 移动完成时目标文件的指纹。只有 done 的 move 才有；
   * 撤销靠它确认"目标还是当初那个文件"。老行没有（NULL）→ 不可撤销。
   */
  size: number | null;
  mtimeMs: number | null;
  /** execute | undo。撤销动作不覆盖执行动作，两者在同一张表里分阶段记。 */
  phase: 'execute' | 'undo';
  /** 撤销动作指向原执行动作的 id；执行阶段为 null。 */
  undoOf: string | null;
}

export function insertAction(db: Db, row: InsertActionInput): void {
  db.prepare(
    `INSERT INTO organize_actions
       (id, plan_id, ord, action, from_path, to_path, status, reason, created_at,
        size, mtime_ms, phase, undo_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.planId,
    row.ord,
    row.action,
    row.fromPath,
    row.toPath,
    row.status,
    row.reason,
    row.createdAt,
    row.size,
    row.mtimeMs,
    row.phase,
    row.undoOf,
  );
}

interface PlanRow {
  id: string;
  summary: string;
  status: string;
  planned_moves: number;
  moved: number;
  failed_count: number;
  note: string | null;
  created_at: string;
  executed_at: string | null;
  undone_at: string | null;
  undo_moved: number;
  undo_skipped: number;
  undo_failed: number;
  undo_note: string | null;
  done_moves: number;
  fingerprinted_moves: number;
}

/**
 * 某个数据集的整理历史，最近的排前面。
 *
 * `created_at DESC` 而不是 `executed_at`：失败/待执行的计划没有 executed_at，
 * 按它排会让这些行掉到列表末尾 —— 而"上次尝试失败了"正是最该被先看到的一条。
 *
 * 【undoable 为什么在 SQL 里算】它是"这份计划此刻能不能安全撤销"的判据：
 * 状态是 executed、至少成功移动过一个文件、**并且每个成功的移动都记了文件指纹**。
 * 老计划（v21 之前执行）没有指纹，虽然状态也是 executed，但不能撤销 ——
 * 界面不该靠"状态是 executed"去猜，判据只有这一处。
 */
export function listPlans(db: Db, assetId: string, limit: number): readonly OrganizePlanSummary[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.summary, p.status, p.planned_moves, p.moved, p.failed_count,
              p.note, p.created_at, p.executed_at, p.undone_at,
              p.undo_moved, p.undo_skipped, p.undo_failed, p.undo_note,
              (SELECT COUNT(*) FROM organize_actions a
                WHERE a.plan_id = p.id AND a.phase = 'execute'
                  AND a.action = 'move' AND a.status = 'done') AS done_moves,
              (SELECT COUNT(*) FROM organize_actions a
                WHERE a.plan_id = p.id AND a.phase = 'execute'
                  AND a.action = 'move' AND a.status = 'done'
                  AND a.size IS NOT NULL AND a.mtime_ms IS NOT NULL) AS fingerprinted_moves
         FROM organize_plans p
        WHERE p.asset_id = ?
        ORDER BY p.created_at DESC
        LIMIT ?`,
    )
    .all(assetId, limit);

  return (rows as unknown as PlanRow[]).map((r) => {
    const doneMoves = Number(r.done_moves);
    const fingerprinted = Number(r.fingerprinted_moves);
    const undoable =
      r.status === 'executed' && r.undone_at === null && doneMoves > 0 && fingerprinted === doneMoves;
    return {
      id: r.id,
      summary: r.summary,
      // 列上没有 CHECK 约束，所以这里不强转成枚举后抛错 —— 认不出的值原样带出去，
      // 界面上显示成一个陌生状态，总好过让整个历史列表炸掉（同 uploads/repo.ts）。
      status: r.status as OrganizePlanStatus,
      plannedMoves: r.planned_moves,
      moved: r.moved,
      failedCount: r.failed_count,
      note: r.note,
      createdAt: r.created_at,
      executedAt: r.executed_at,
      undoneAt: r.undone_at,
      undoMoved: r.undo_moved,
      undoSkipped: r.undo_skipped,
      undoFailed: r.undo_failed,
      undoNote: r.undo_note,
      undoable,
      undoBlockedReason: undoBlockedReason(r.status, r.undone_at, doneMoves, fingerprinted),
    };
  });
}

/** 已执行却撤不了时，告诉用户为什么。能撤销、或状态根本不适用时为 null。 */
function undoBlockedReason(
  status: string,
  undoneAt: string | null,
  doneMoves: number,
  fingerprinted: number,
): string | null {
  if (status !== 'executed' || undoneAt !== null) return null;
  if (doneMoves === 0) return '这次整理没有成功移动任何文件，没有可撤销的内容。';
  if (fingerprinted < doneMoves) {
    return '这次整理执行于撤销功能上线前，没有记录文件指纹（大小与修改时间），无法安全确认文件没有被改动过，因此不能撤销。';
  }
  return null;
}

/** 撤销前读计划：归属（asset）与状态必须一起核对。 */
export function getPlanForUndo(
  db: Db,
  assetId: string,
  planId: string,
): { id: string; status: string; datasetDir: string; undoneAt: string | null } | null {
  const row = db
    .prepare(
      `SELECT id, status, dataset_dir, undone_at
         FROM organize_plans
        WHERE id = ? AND asset_id = ?`,
    )
    .get(planId, assetId) as
    | { id: string; status: string; dataset_dir: string; undone_at: string | null }
    | undefined;
  if (row === undefined) return null;
  return { id: row.id, status: row.status, datasetDir: row.dataset_dir, undoneAt: row.undone_at };
}

export interface UndoActionRow {
  id: string;
  fromPath: string | null;
  toPath: string;
  size: number | null;
  mtimeMs: number | null;
}

/**
 * 可撤销的移动：执行阶段、状态 done、**按 ord 倒序**。
 *
 * 倒序不只是一般意义上的"反向操作"：重名时后来的文件会被改名成 "名字 (1)"，
 * 如果先撤前面的、再撤后面的，原位置的占用关系会短暂地变复杂。倒着撤回去，
 * 每一步的原位置都恰好是上一步腾出来的那个。
 */
export function listUndoActions(db: Db, planId: string): readonly UndoActionRow[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.from_path, a.to_path, a.size, a.mtime_ms
         FROM organize_actions a
        WHERE a.plan_id = ? AND a.phase = 'execute' AND a.action = 'move' AND a.status = 'done'
          AND NOT EXISTS (
                SELECT 1 FROM organize_actions u
                 WHERE u.plan_id = a.plan_id AND u.phase = 'undo'
                   AND u.undo_of = a.id AND u.status = 'done')
        ORDER BY a.ord DESC`,
    )
    .all(planId);
  return (rows as unknown as {
    id: string;
    from_path: string | null;
    to_path: string;
    size: number | null;
    mtime_ms: number | null;
  }[]).map((r) => ({
    id: r.id,
    fromPath: r.from_path,
    toPath: r.to_path,
    size: r.size,
    mtimeMs: r.mtime_ms,
  }));
}

/** 回写撤销结果。原执行的 moved / failed_count / note 一个字不动。 */
export function setUndoResult(
  db: Db,
  id: string,
  row: {
    undoneAt: string;
    undoneBy: string | null;
    moved: number;
    skipped: number;
    failedCount: number;
    note: string | null;
  },
): void {
  db.prepare(
    `UPDATE organize_plans
        SET status = 'undone', undone_at = ?, undone_by = ?,
            undo_moved = ?, undo_skipped = ?, undo_failed = ?, undo_note = ?
      WHERE id = ?`,
  ).run(row.undoneAt, row.undoneBy, row.moved, row.skipped, row.failedCount, row.note, id);
}
