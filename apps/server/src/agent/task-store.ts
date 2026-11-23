/**
 * 可续跑任务的 SQLite 存储（V3 / S7 X1b）。
 *
 * 【Task 与 Attempt 分开】Task 是"这次调查"的长期身份，可能被续跑多次；
 *   Attempt 是每一次真实运行。把两者合成一张表，就无法表达"上次超时了、
 *   这次续跑正在跑"；也无法在同一任务上做并发 CAS。
 *
 * 【检查点只存可重建的引用】plan/evidence 里只有子目标状态、chunkId+版本、
 *   记录类型/id；**不存 chunk 原文、回答正文或引用摘录**。恢复时按 id+版本
 *   从 documents/doc_chunks 重新读，版本不符就丢掉。这样一张检查点表
 *   不会变成"未发表内容的第二份副本"。
 *
 * 【并发与过期】同一 task 最多一个活跃 attempt：`claimResume` 用
 *   `BEGIN IMMEDIATE` + 条件更新做 CAS。进程崩溃时没有机会写终态，
 *   靠 `lease_expires_at` 在下次 GET/Resume 时判 `process_lost`。
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/index.ts';
import type { RewriteEvent } from './retrieval-reflection.ts';
import type { SubgoalKind } from './planner.ts';

export type AgentTaskStatus =
  | 'running'
  | 'interrupted'
  | 'partial'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused';

export type AgentAttemptState =
  | 'running'
  | 'success'
  | 'timeout'
  | 'aborted'
  | 'model_error'
  | 'exception'
  | 'process_lost';

/**
 * 恢复时用于重建文档证据（按 chunkId + 版本回表）。
 * 记录类证据走 `CheckpointRecordRef`，由 `evidence-restore.ts` 重验可见性与版本后重建。
 */
export interface CheckpointDocumentRef {
  chunkId: string;
  documentId: string;
  sourceVersion: string;
}

export interface CheckpointRecordRef {
  recordType: string;
  recordId: string;
  sourceVersion: string;
}

export interface CheckpointSubgoal {
  id: string;
  kind: SubgoalKind;
  /** 新线索产生的核对目标。只用于恢复任务。 */
  followUpFocus?: string;
  followUpSource?: string;
  status: 'covered' | 'missing';
  evidenceCount: number;
  /** 该子目标名下的文档块 id；恢复时按这些 id 重建证据 */
  evidenceChunkIds: readonly string[];
  /**
   * 该子目标名下的记录证据身份（`recordType:recordId`）。
   * 记录与文档的恢复路径不同（回表重读 vs 按块读回），所以分开存。
   * 旧检查点没有这一项，按空数组处理。
   */
  evidenceRecordIds?: readonly string[];
}

export interface TaskCheckpointData {
  coverage: string;
  coverageRatio: number;
  subgoals: readonly CheckpointSubgoal[];
  documents: readonly CheckpointDocumentRef[];
  records: readonly CheckpointRecordRef[];
  pendingStepIds: readonly string[];
  queryHistory: readonly string[];
  rewriteRounds: number;
  rewriteEvents: readonly RewriteEvent[];
  cumulative: {
    queryCalls: number;
    toolCalls: number;
    tokens: number;
    costUsd: number;
  };
  stopReason: string | null;
}

export interface AgentTaskRow {
  id: string;
  run_id: string;
  owner_id: string;
  question: string;
  question_hash: string;
  status: AgentTaskStatus;
  created_at: string;
  updated_at: string;
  expires_at: string;
  active_attempt_id: string | null;
  last_checkpoint_version: number | null;
  cumulative_query_calls: number;
  cumulative_tool_calls: number;
  cumulative_tokens: number;
  cumulative_cost_usd: number;
}

export interface CheckpointRow {
  task_id: string;
  version: number;
  plan_json: string;
  evidence_json: string;
  pending_step_ids_json: string;
  query_history_json: string;
  rewrite_rounds: number;
  rewrite_events_json: string;
  cumulative_json: string;
  stop_reason: string | null;
  created_at: string;
}

export const DEFAULT_TASK_TTL_DAYS = 7;
const DEFAULT_LEASE_MS = 10 * 60 * 1000;

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function isoPlus(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

export function questionHash(question: string): string {
  return createHash('sha256').update(question.trim(), 'utf8').digest('hex');
}

export function createTask(
  db: Db,
  input: {
    taskId: string;
    runId: string;
    ownerId: string;
    question: string;
    now: string;
    ttlDays?: number;
  },
): AgentTaskRow {
  const now = input.now;
  db.prepare(
    `INSERT INTO agent_tasks
       (id, run_id, owner_id, question, question_hash, status, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
  ).run(
    input.taskId,
    input.runId,
    input.ownerId,
    input.question,
    questionHash(input.question),
    now,
    now,
    addDays(now, input.ttlDays ?? DEFAULT_TASK_TTL_DAYS),
  );
  return getTask(db, input.taskId)!;
}

export function startAttempt(
  db: Db,
  input: { attemptId: string; taskId: string; now: string; leaseMs?: number },
): void {
  const lease = isoPlus(input.now, input.leaseMs ?? DEFAULT_LEASE_MS);
  db.prepare(
    `INSERT INTO agent_task_attempts
       (id, task_id, state, started_at, lease_expires_at)
     VALUES (?, ?, 'running', ?, ?)`,
  ).run(input.attemptId, input.taskId, input.now, lease);
  db.prepare(
    `UPDATE agent_tasks SET active_attempt_id = ?, status = 'running', updated_at = ?
      WHERE id = ?`,
  ).run(input.attemptId, input.now, input.taskId);
}

export function getTask(db: Db, taskId: string): AgentTaskRow | undefined {
  return db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId) as unknown as
    | AgentTaskRow
    | undefined;
}

export function getLatestCheckpoint(db: Db, taskId: string): CheckpointRow | undefined {
  return db
    .prepare(
      `SELECT * FROM agent_task_checkpoints
        WHERE task_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .get(taskId) as unknown as CheckpointRow | undefined;
}

export function parseCheckpoint(row: CheckpointRow): {
  plan: {
    coverage: string;
    coverageRatio: number;
    subgoals: readonly CheckpointSubgoal[];
  };
  evidence: { documents: readonly CheckpointDocumentRef[]; records: readonly CheckpointRecordRef[] };
  pendingStepIds: readonly string[];
  queryHistory: readonly string[];
  rewriteRounds: number;
  rewriteEvents: readonly RewriteEvent[];
  cumulative: TaskCheckpointData['cumulative'];
  stopReason: string | null;
} {
  return {
    plan: JSON.parse(row.plan_json) as {
      coverage: string;
      coverageRatio: number;
      subgoals: readonly CheckpointSubgoal[];
    },
    evidence: JSON.parse(row.evidence_json) as {
      documents: readonly CheckpointDocumentRef[];
      records: readonly CheckpointRecordRef[];
    },
    pendingStepIds: JSON.parse(row.pending_step_ids_json) as readonly string[],
    queryHistory: JSON.parse(row.query_history_json) as readonly string[],
    rewriteRounds: row.rewrite_rounds,
    rewriteEvents: JSON.parse(row.rewrite_events_json) as readonly RewriteEvent[],
    cumulative: JSON.parse(row.cumulative_json) as TaskCheckpointData['cumulative'],
    stopReason: row.stop_reason,
  };
}

/**
 * 在工具完成/终态时写检查点。只有当前活跃 attempt 才能写；版本单调递增。
 * 返回值是本次检查点版本；失败（attempt 不匹配）抛错，由调用方决定是否忽略。
 */
export function commitCheckpoint(
  db: Db,
  input: {
    taskId: string;
    attemptId: string;
    now: string;
    data: TaskCheckpointData;
  },
): number {
  db.exec('BEGIN IMMEDIATE');
  try {
    const task = getTask(db, input.taskId);
    if (task === undefined || task.active_attempt_id !== input.attemptId) {
      throw new Error('检查点写入失败：当前 attempt 不是这个任务的活跃执行者。');
    }
    const row = db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM agent_task_checkpoints WHERE task_id = ?')
      .get(input.taskId) as unknown as { v: number };
    const version = row.v + 1;
    db.prepare(
      `INSERT INTO agent_task_checkpoints
         (task_id, version, plan_json, evidence_json, pending_step_ids_json, query_history_json,
          rewrite_rounds, rewrite_events_json, cumulative_json, stop_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.taskId,
      version,
      JSON.stringify({
        coverage: input.data.coverage,
        coverageRatio: input.data.coverageRatio,
        subgoals: input.data.subgoals,
      }),
      JSON.stringify({ documents: input.data.documents, records: input.data.records }),
      JSON.stringify(input.data.pendingStepIds),
      JSON.stringify(input.data.queryHistory),
      input.data.rewriteRounds,
      JSON.stringify(input.data.rewriteEvents),
      JSON.stringify(input.data.cumulative),
      input.data.stopReason,
      input.now,
    );
    db.prepare(
      `UPDATE agent_tasks
          SET last_checkpoint_version = ?, updated_at = ?,
              cumulative_query_calls = ?, cumulative_tool_calls = ?,
              cumulative_tokens = ?, cumulative_cost_usd = ?
        WHERE id = ?`,
    ).run(
      version,
      input.now,
      input.data.cumulative.queryCalls,
      input.data.cumulative.toolCalls,
      input.data.cumulative.tokens,
      input.data.cumulative.costUsd,
      input.taskId,
    );
    db.prepare(
      'UPDATE agent_task_attempts SET lease_expires_at = ? WHERE id = ?',
    ).run(isoPlus(input.now, DEFAULT_LEASE_MS), input.attemptId);
    db.exec('COMMIT');
    return version;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 把任务收尾到某个终态；只有活跃 attempt 能收尾（幂等：重复调用只生效一次）。 */
export function finishTask(
  db: Db,
  input: {
    taskId: string;
    attemptId: string;
    now: string;
    status: AgentTaskStatus;
    attemptState: AgentAttemptState;
    stopReason: string | null;
    cumulative: TaskCheckpointData['cumulative'];
  },
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const task = getTask(db, input.taskId);
    if (task === undefined || task.active_attempt_id !== input.attemptId) {
      db.exec('COMMIT');
      return;
    }
    db.prepare(
      `UPDATE agent_task_attempts
          SET state = ?, stop_reason = ?, ended_at = ?, lease_expires_at = NULL,
              cumulative_query_calls = ?, cumulative_tool_calls = ?,
              cumulative_tokens = ?, cumulative_cost_usd = ?
        WHERE id = ?`,
    ).run(
      input.attemptState,
      input.stopReason,
      input.now,
      input.cumulative.queryCalls,
      input.cumulative.toolCalls,
      input.cumulative.tokens,
      input.cumulative.costUsd,
      input.attemptId,
    );
    db.prepare(
      `UPDATE agent_tasks
          SET status = ?, active_attempt_id = NULL, updated_at = ?,
              cumulative_query_calls = ?, cumulative_tool_calls = ?,
              cumulative_tokens = ?, cumulative_cost_usd = ?
        WHERE id = ?`,
    ).run(
      input.status,
      input.now,
      input.cumulative.queryCalls,
      input.cumulative.toolCalls,
      input.cumulative.tokens,
      input.cumulative.costUsd,
      input.taskId,
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * 把"running 但 lease 已过期"的任务标成 interrupted/process_lost。
 * 只在 GET/Resume 时调用（不引入后台守护进程）。
 */
export function expireStaleTasks(db: Db, now: string): void {
  const stale = db
    .prepare(
      `SELECT t.id AS task_id, t.active_attempt_id AS attempt_id
         FROM agent_tasks t
         JOIN agent_task_attempts a ON a.id = t.active_attempt_id
        WHERE t.status = 'running'
          AND t.active_attempt_id IS NOT NULL
          AND a.lease_expires_at IS NOT NULL
          AND a.lease_expires_at < ?`,
    )
    .all(now) as unknown as { task_id: string; attempt_id: string }[];
  for (const row of stale) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `UPDATE agent_task_attempts
            SET state = 'process_lost', stop_reason = 'process_lost',
                ended_at = ?, lease_expires_at = NULL
          WHERE id = ?`,
      ).run(now, row.attempt_id);
      db.prepare(
        `UPDATE agent_tasks
            SET status = 'interrupted', active_attempt_id = NULL, updated_at = ?
          WHERE id = ? AND active_attempt_id = ?`,
      ).run(now, row.task_id, row.attempt_id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export type ResumeClaim =
  | { ok: true; task: AgentTaskRow }
  | { ok: false; reason: 'not_found' | 'busy' | 'expired' | 'not_resumable'; status?: AgentTaskStatus };

/**
 * 原子地抢占续跑权。返回 ok=false 时调用方应返回 404/409，不要启动第二个执行者。
 */
export function claimResume(
  db: Db,
  input: { taskId: string; ownerId: string; attemptId: string; now: string; leaseMs?: number },
): ResumeClaim {
  expireStaleTasks(db, input.now);
  db.exec('BEGIN IMMEDIATE');
  try {
    const task = db
      .prepare('SELECT * FROM agent_tasks WHERE id = ?')
      .get(input.taskId) as unknown as AgentTaskRow | undefined;
    if (task === undefined || task.owner_id !== input.ownerId) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    if (task.expires_at < input.now) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'expired', status: task.status };
    }
    // 【先判 busy，再判状态】第一个 Resume 抢占之后任务已经变成 running，
    // 若先看状态，双击的第二次会被报成"running 不可续跑"—— 虽然同样是 409，
    // 但界面拿到的理由是错的（用户以为任务坏了，而不是"正在跑、别急"）。
    if (task.active_attempt_id !== null) {
      // 正常情况下 expireStaleTasks 已清掉过期 attempt；仍非空就是另一个执行者。
      db.exec('ROLLBACK');
      return { ok: false, reason: 'busy', status: task.status };
    }
    if (task.status !== 'interrupted' && task.status !== 'partial') {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'not_resumable', status: task.status };
    }
    if (task.last_checkpoint_version === null) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'not_resumable', status: task.status };
    }
    db.prepare(
      `INSERT INTO agent_task_attempts
         (id, task_id, state, started_at, lease_expires_at)
       VALUES (?, ?, 'running', ?, ?)`,
    ).run(
      input.attemptId,
      input.taskId,
      input.now,
      isoPlus(input.now, input.leaseMs ?? DEFAULT_LEASE_MS),
    );
    db.prepare(
      `UPDATE agent_tasks
          SET status = 'running', active_attempt_id = ?, updated_at = ?
        WHERE id = ? AND status IN ('interrupted','partial') AND active_attempt_id IS NULL`,
    ).run(input.attemptId, input.now, input.taskId);
    db.exec('COMMIT');
    return { ok: true, task: getTask(db, input.taskId)! };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 任务是否可续跑（视图层用；不改变状态）。 */
export function isResumeAvailable(
  task: AgentTaskRow,
  now: string,
): boolean {
  return (
    (task.status === 'interrupted' || task.status === 'partial') &&
    task.last_checkpoint_version !== null &&
    task.expires_at >= now &&
    task.active_attempt_id === null
  );
}
