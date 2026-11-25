/**
 * 可续跑任务（S7/X1b）的验证脚本：`npm run verify-resume -w @knowpilot/server`。
 *
 * 【验证什么】
 *   1. Task/Attempt 分离、检查点版本单调、租约过期判 process_lost；
 *   2. 并发 Resume 的 CAS（双击只能有一个执行者）、TTL、归属；
 *   3. 超时 → 任务进入 interrupted → 显式 Resume 继续；
 *   4. 累计预算：上一次 attempt 用掉的查询额度不能被清零；
 *   5. 版本漂移：文档重建索引后，旧证据被丢弃，不拿旧版充数；
 *   6. 检查点不存原文/回答正文（只存可重建的引用与脱敏摘要）；
 *   7. 用户主动停止 → cancelled，**不**自动变成可续跑。
 *
 * 【为什么用假模型】超时与续跑在真实调用里既花钱又慢，而且"超时后到底留下了
 *   什么"没法靠碰运气覆盖。这里只替换 `models.streamSimple`，被测的仍是
 *   `ask-run.ts` 与 `task-store.ts` 的真实逻辑。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonObject,
  type Model,
  type MutableModels,
  type SimpleStreamOptions,
  type TextContent,
  type ToolCall,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { createApp } from '../app.ts';
import { ruleFor } from '../auth/routes.ts';
import { createSession, SESSION_COOKIE } from '../auth/session.ts';
import type { AppConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import type { AuthUser } from '@knowpilot/shared';
import { AskAbortedError, runAsk, type AskFinalization, type AskResumeState } from './ask-run.ts';
import type { BudgetLimits } from './budget.ts';
import { SUBMISSIONS_TOOL } from './live-tools.ts';
import { createLabModels } from './models.ts';
import { SUBMIT_ANSWER_TOOL } from './tools.ts';
import {
  claimResume,
  commitCheckpoint,
  createTask,
  expireStaleTasks,
  finishTask,
  getLatestCheckpoint,
  getTask,
  isResumeAvailable,
  parseCheckpoint,
  startAttempt,
  type TaskCheckpointData,
} from './task-store.ts';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  failures.push(`${name}${detail === '' ? '' : ` —— ${detail}`}`);
  console.log(`  ✗ ${name}${detail === '' ? '' : ` —— ${detail}`}`);
}

const QUESTION = '续跑验证：我的投稿现在到哪一步了？';
const T0 = '2026-10-17T00:00:00.000Z';

function seedUser(db: ReturnType<typeof openDb>['db'], id: string, username: string): void {
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
     VALUES (?, ?, ?, 'x', 'member', ?, ?)`,
  ).run(id, username, username, T0, T0);
}

const OWNER: AuthUser = {
  id: 'u-owner',
  username: 'owner',
  displayName: '任务所有者',
  role: 'member',
  groupId: null,
};

function checkpointData(overrides: Partial<TaskCheckpointData> = {}): TaskCheckpointData {
  return {
    coverage: 'covered',
    coverageRatio: 1,
    subgoals: [],
    documents: [],
    records: [],
    pendingStepIds: [],
    queryHistory: [],
    rewriteRounds: 0,
    rewriteEvents: [],
    cumulative: { queryCalls: 0, toolCalls: 0, tokens: 0, costUsd: 0 },
    stopReason: null,
    ...overrides,
  };
}

function assertNoTextInCheckpoints(
  db: ReturnType<typeof openDb>['db'],
  taskId: string,
  text: string,
  label: string,
): void {
  const rows = db
    .prepare(
      `SELECT plan_json, evidence_json, pending_step_ids_json, query_history_json,
              rewrite_events_json, cumulative_json
         FROM agent_task_checkpoints WHERE task_id = ?`,
    )
    .all(taskId) as unknown as Record<string, string>[];
  const joined = rows.map((r) => Object.values(r).join('\n')).join('\n');
  check(`${label}：检查点不含「${text.slice(0, 12)}…」原文`, !joined.includes(text));
}

// ── 第一部分：Task/Attempt 状态机（纯 SQLite，不调模型）─────────────
console.log('任务状态机：Task/Attempt、版本、租约、CAS、TTL、归属');

{
  const { db } = openDb(':memory:');
  seedUser(db, OWNER.id, OWNER.username);
  seedUser(db, 'u-other', 'other');

  const tableNames = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_task%'")
      .all() as unknown as { name: string }[]
  ).map((r) => r.name);
  check(
    '迁移 v19：三张任务表存在',
    ['agent_tasks', 'agent_task_attempts', 'agent_task_checkpoints'].every((n) =>
      tableNames.includes(n),
    ),
    tableNames.join(', '),
  );

  // ── 创建与检查点版本 ────────────────────────────────────────
  const taskId = randomUUID();
  const attempt1 = randomUUID();
  createTask(db, { taskId, runId: randomUUID(), ownerId: OWNER.id, question: QUESTION, now: T0 });
  startAttempt(db, { attemptId: attempt1, taskId, now: T0, leaseMs: 60_000 });
  let task = getTask(db, taskId);
  check('创建后状态是 running', task?.status === 'running', String(task?.status));
  check('活跃 attempt 已登记', task?.active_attempt_id === attempt1);

  const v1 = commitCheckpoint(db, {
    taskId,
    attemptId: attempt1,
    now: T0,
    data: checkpointData({ queryHistory: ['第一次查询'] }),
  });
  const v2 = commitCheckpoint(db, {
    taskId,
    attemptId: attempt1,
    now: T0,
    data: checkpointData({ queryHistory: ['第一次查询', '第二次查询'] }),
  });
  check('检查点版本从 1 开始且单调递增', v1 === 1 && v2 === 2, `${v1}, ${v2}`);
  check('任务记录最后检查点版本', getTask(db, taskId)?.last_checkpoint_version === v2);

  // 非活跃 attempt 不能写检查点 —— 这是"两个执行者同时写"的结构性防线。
  let rejected = false;
  try {
    commitCheckpoint(db, {
      taskId,
      attemptId: randomUUID(),
      now: T0,
      data: checkpointData(),
    });
  } catch {
    rejected = true;
  }
  check('非活跃 attempt 写检查点被拒绝', rejected);

  finishTask(db, {
    taskId,
    attemptId: attempt1,
    now: T0,
    status: 'interrupted',
    attemptState: 'timeout',
    stopReason: 'wall',
    cumulative: { queryCalls: 1, toolCalls: 2, tokens: 100, costUsd: 0.001 },
  });
  task = getTask(db, taskId);
  check('收尾后状态 interrupted、无活跃 attempt', task?.status === 'interrupted' && task?.active_attempt_id === null);
  check('任务级累计用量已落库', task?.cumulative_query_calls === 1 && task?.cumulative_tokens === 100);
  check('interrupted 且有检查点 → 可续跑', isResumeAvailable(task!, T0));

  // ── 并发 Resume：第一个成功，第二个 busy ────────────────────
  const attempt2 = randomUUID();
  const first = claimResume(db, { taskId, ownerId: OWNER.id, attemptId: attempt2, now: T0 });
  const second = claimResume(db, {
    taskId,
    ownerId: OWNER.id,
    attemptId: randomUUID(),
    now: T0,
  });
  check('第一次 Resume 抢占成功', first.ok);
  check('双击 Resume：第二次被拒绝为 busy', !second.ok && second.reason === 'busy', JSON.stringify(second));

  // 两个执行者都尝试收尾：只有活跃 attempt 生效，另一个静默无效。
  finishTask(db, {
    taskId,
    attemptId: attempt2,
    now: T0,
    status: 'completed',
    attemptState: 'success',
    stopReason: 'completed',
    cumulative: { queryCalls: 2, toolCalls: 3, tokens: 200, costUsd: 0.002 },
  });
  const afterComplete = getTask(db, taskId);
  check('收尾后 completed，不可再续跑', afterComplete?.status === 'completed' && !isResumeAvailable(afterComplete, T0));

  // ── 租约过期（进程崩溃）────────────────────────────────────
  const staleTask = randomUUID();
  const staleAttempt = randomUUID();
  const old = '2026-10-16T00:00:00.000Z';
  createTask(db, { taskId: staleTask, runId: randomUUID(), ownerId: OWNER.id, question: QUESTION, now: old });
  startAttempt(db, { attemptId: staleAttempt, taskId: staleTask, now: old, leaseMs: 1_000 });
  commitCheckpoint(db, { taskId: staleTask, attemptId: staleAttempt, now: old, data: checkpointData() });
  expireStaleTasks(db, T0);
  const stale = getTask(db, staleTask);
  const staleAttemptRow = db
    .prepare('SELECT state, stop_reason FROM agent_task_attempts WHERE id = ?')
    .get(staleAttempt) as unknown as { state: string; stop_reason: string };
  check('租约过期 → attempt 记 process_lost', staleAttemptRow.state === 'process_lost');
  check('租约过期 → 任务 interrupted、清空活跃 attempt', stale?.status === 'interrupted' && stale?.active_attempt_id === null);
  check('进程崩溃后仍可显式续跑', isResumeAvailable(stale!, T0));
  const reclaim = claimResume(db, {
    taskId: staleTask,
    ownerId: OWNER.id,
    attemptId: randomUUID(),
    now: T0,
  });
  check('process_lost 之后能重新抢占', reclaim.ok);

  // ── TTL 过期 ───────────────────────────────────────────────
  const expiredTask = randomUUID();
  const expiredAttempt = randomUUID();
  createTask(db, {
    taskId: expiredTask,
    runId: randomUUID(),
    ownerId: OWNER.id,
    question: QUESTION,
    now: '2020-01-01T00:00:00.000Z',
    ttlDays: 1,
  });
  startAttempt(db, { attemptId: expiredAttempt, taskId: expiredTask, now: '2020-01-01T00:00:00.000Z' });
  commitCheckpoint(db, {
    taskId: expiredTask,
    attemptId: expiredAttempt,
    now: '2020-01-01T00:00:00.000Z',
    data: checkpointData(),
  });
  finishTask(db, {
    taskId: expiredTask,
    attemptId: expiredAttempt,
    now: '2020-01-01T00:00:00.000Z',
    status: 'interrupted',
    attemptState: 'timeout',
    stopReason: 'wall',
    cumulative: { queryCalls: 0, toolCalls: 0, tokens: 0, costUsd: 0 },
  });
  const expiredClaim = claimResume(db, {
    taskId: expiredTask,
    ownerId: OWNER.id,
    attemptId: randomUUID(),
    now: T0,
  });
  check('TTL 过期后拒绝续跑', !expiredClaim.ok && expiredClaim.reason === 'expired');

  // ── 归属与不可续状态 ───────────────────────────────────────
  const otherClaim = claimResume(db, {
    taskId,
    ownerId: 'u-other',
    attemptId: randomUUID(),
    now: T0,
  });
  check('别人的任务一律 not_found', !otherClaim.ok && otherClaim.reason === 'not_found');

  const cancelledTask = randomUUID();
  const cancelledAttempt = randomUUID();
  createTask(db, {
    taskId: cancelledTask,
    runId: randomUUID(),
    ownerId: OWNER.id,
    question: QUESTION,
    now: T0,
  });
  startAttempt(db, { attemptId: cancelledAttempt, taskId: cancelledTask, now: T0 });
  commitCheckpoint(db, { taskId: cancelledTask, attemptId: cancelledAttempt, now: T0, data: checkpointData() });
  finishTask(db, {
    taskId: cancelledTask,
    attemptId: cancelledAttempt,
    now: T0,
    status: 'cancelled',
    attemptState: 'aborted',
    stopReason: 'client_aborted',
    cumulative: { queryCalls: 0, toolCalls: 0, tokens: 0, costUsd: 0 },
  });
  check('用户停止（cancelled）不可续跑', !isResumeAvailable(getTask(db, cancelledTask)!, T0));
  const cancelledClaim = claimResume(db, {
    taskId: cancelledTask,
    ownerId: OWNER.id,
    attemptId: randomUUID(),
    now: T0,
  });
  check('cancelled 续跑返回 not_resumable', !cancelledClaim.ok && cancelledClaim.reason === 'not_resumable');

  // ── 路由权限登记（撤权的第一道门）──────────────────────────
  check(
    'GET 任务详情要求 chat.use',
    ruleFor('GET', '/api/v1/agent-tasks/:taskId') === 'chat.use',
  );
  check(
    'Resume 要求 chat.use（撤权后不能续跑）',
    ruleFor('POST', '/api/v1/agent-tasks/:taskId/resume') === 'chat.use',
  );
}

// ── 假模型 ────────────────────────────────────────────────────────
interface Spec {
  toolCalls?: readonly { name: string; args: JsonObject }[];
  usage?: { input: number; output: number };
  hang?: boolean;
  /** 延迟这么久再产出结果。用于让两个并发请求真的重叠。 */
  delayMs?: number;
}

type Strategy = (turn: number, context: TranscriptContext) => Spec;

function submitSpec(text: string): Spec {
  return {
    toolCalls: [
      {
        name: SUBMIT_ANSWER_TOOL,
        args: {
          answer: text,
          // O2 起提交答案必须带 quotes 字段（没有引用时传空数组）。
          quotes: [],
          evidence_gaps: [],
          limits: [],
          confidence_notes: [],
          conflicts: [],
        },
      },
    ],
  };
}

function buildMessage(model: Model<Api>, spec: Spec, nextId: () => string): AssistantMessage {
  const content: (TextContent | ToolCall)[] = [];
  for (const tc of spec.toolCalls ?? []) {
    content.push({ type: 'toolCall', id: nextId(), name: tc.name, arguments: tc.args });
  }
  const input = spec.usage?.input ?? 10;
  const output = spec.usage?.output ?? 5;
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: spec.toolCalls === undefined || spec.toolCalls.length === 0 ? 'stop' : 'toolUse',
    timestamp: Date.now(),
  };
}

function installFakeModel(
  models: MutableModels,
  strategy: Strategy,
  prompts: string[],
): { turns: () => number } {
  let turns = 0;
  let callSeq = 0;
  const target = models as unknown as {
    streamSimple: (
      m: Model<Api>,
      c: TranscriptContext,
      o?: SimpleStreamOptions,
    ) => AssistantMessageEventStream;
  };
  target.streamSimple = (model, context, options) => {
    try {
      prompts.push(JSON.stringify(context));
    } catch {
      prompts.push('');
    }
    const spec = strategy(turns, context);
    turns += 1;
    const stream = createAssistantMessageEventStream();
    const message = buildMessage(model, spec, () => {
      callSeq += 1;
      return `fake-${callSeq}`;
    });

    if (spec.hang === true) {
      const onAbort = (): void => {
        stream.push({
          type: 'error',
          reason: 'aborted',
          error: { ...message, stopReason: 'aborted' },
        });
      };
      if (options?.signal?.aborted === true) queueMicrotask(onAbort);
      else options?.signal?.addEventListener('abort', onAbort, { once: true });
      return stream;
    }

    const emit = (): void => {
      stream.push({
        type: 'done',
        reason: spec.toolCalls === undefined || spec.toolCalls.length === 0 ? 'stop' : 'toolUse',
        message,
      });
    };
    if ((spec.delayMs ?? 0) > 0) setTimeout(emit, spec.delayMs);
    else queueMicrotask(emit);
    return stream;
  };
  return { turns: () => turns };
}

const CFG = (root: string): AppConfig => ({
  port: 0,
  dbPath: join(root, 'unused.db'),
  uploadDir: join(root, 'uploads'),
  repoRoot: root,
  deepseekApiKey: 'fake-key-for-resume-check',
  modelChat: undefined,
  modelReasoner: undefined,
  modelBaseUrl: undefined,
  hfHome: root,
  embedModelDir: join(root, 'models'),
  embedModelId: 'bge-m3',
  embedDtype: 'q8',
  rerankEnabled: false,
  rerankModelId: 'bge-reranker-base',
  rerankDtype: 'q8',
  rerankCandidateDepth: 30,
  rerankTimeoutMs: 3000,
  ocrEnabled: false,
  ocrMaxPages: 1,
  codeRoots: [],
  dataRoot: join(root, 'datasets'),
  uploadMaxBytes: 1024,
  uploadChunkSize: 512,
  uploadSessionTtlDays: 1,
  knowledgeConflictThreshold: 0.82,
  patrolIntervalHours: 24,
  sessionIdleDays: 7,
  sessionMaxDays: 30,
  cookieSecure: false,
  adminUsername: undefined,
  adminPassword: undefined,
});

const ROOT = mkdtempSync(join(tmpdir(), 'knowpilot-resume-verify-'));

interface RunResult {
  answer?: Awaited<ReturnType<typeof runAsk>>;
  error?: unknown;
  finalizations: AskFinalization[];
  prompts: string[];
}

async function runWithTask(
  db: ReturnType<typeof openDb>['db'],
  task: { taskId: string; attemptId: string; resume?: AskResumeState },
  strategy: Strategy,
  budget: Partial<BudgetLimits>,
  hooks: { signal?: AbortSignal; onEvent?: (ev: { type: string }) => void } = {},
): Promise<RunResult> {
  const models = createLabModels();
  const prompts: string[] = [];
  installFakeModel(models, strategy, prompts);
  const finalizations: AskFinalization[] = [];
  const args = {
    db,
    config: CFG(ROOT),
    models,
  };
  try {
    const answer = await runAsk(
      args,
      {
        question: QUESTION,
        consentConfirmed: true,
        user: OWNER,
        budget,
        task: {
          taskId: task.taskId,
          attemptId: task.attemptId,
          ...(task.resume === undefined ? {} : { resume: task.resume }),
        },
      },
      {
        onFinalize: (f) => finalizations.push(f),
        ...(hooks.signal === undefined ? {} : { signal: hooks.signal }),
        ...(hooks.onEvent === undefined ? {} : { onEvent: hooks.onEvent }),
      },
    );
    return { answer, finalizations, prompts };
  } catch (err) {
    return { error: err, finalizations, prompts };
  }
}

function resumeStateOf(db: ReturnType<typeof openDb>['db'], taskId: string): AskResumeState {
  const row = getLatestCheckpoint(db, taskId);
  if (row === undefined) throw new Error('测试前置失败：没有检查点');
  const p = parseCheckpoint(row);
  return {
    coverage: p.plan.coverage,
    coverageRatio: p.plan.coverageRatio,
    subgoals: p.plan.subgoals,
    documents: p.evidence.documents,
    records: p.evidence.records,
    pendingStepIds: p.pendingStepIds,
    queryHistory: p.queryHistory,
    rewriteRounds: p.rewriteRounds,
    rewriteEvents: p.rewriteEvents,
    cumulative: p.cumulative,
    stopReason: p.stopReason,
  };
}

// ── 第二部分：真实 runAsk 的超时与续跑 ────────────────────────────
console.log('超时与续跑：真实 runAsk + 假模型（零出网）');

{
  const { db } = openDb(':memory:');
  seedUser(db, OWNER.id, OWNER.username);
  db.prepare(
    `INSERT INTO submissions
       (id, user_id, title, status, updated_at, notes, created_at)
     VALUES ('sub-1', ?, '续跑验证稿件', 'under_review', ?, ?, ?)`,
  ).run(OWNER.id, T0, '一篇不该出现在检查点的稿件备注', T0);

  const taskId = randomUUID();
  const attempt1 = randomUUID();
  const runtimeNow = new Date().toISOString();
  createTask(db, { taskId, runId: randomUUID(), ownerId: OWNER.id, question: QUESTION, now: runtimeNow });
  startAttempt(db, { attemptId: attempt1, taskId, now: runtimeNow });

  const first = await runWithTask(
    db,
    { taskId, attemptId: attempt1 },
    (turn) =>
      turn === 0
        ? { toolCalls: [{ name: SUBMISSIONS_TOOL, args: { keyword: '续跑验证' } }] }
        : { hang: true },
    { maxQueryCalls: 1, maxToolCalls: 10, maxTokens: 1_000_000, maxWallMs: 1_500 },
  );

  check('第一次运行：超时返回 interrupted', first.answer?.delivery.status === 'interrupted', String(first.answer?.delivery.status));
  check('第一次运行：交付里带 taskId', first.answer?.delivery.taskId === taskId);
  check('第一次运行：resumeAvailable=true', first.answer?.delivery.resumeAvailable === true);
  check('第一次运行：确实查到了记录证据', (first.answer?.delivery.evidenceCount ?? 0) >= 1);
  check('第一次运行：终态恰好一次', first.finalizations.length === 1);

  const taskAfterTimeout = getTask(db, taskId);
  check('任务落库为 interrupted', taskAfterTimeout?.status === 'interrupted', String(taskAfterTimeout?.status));
  check('任务累计查询次数已记账', taskAfterTimeout?.cumulative_query_calls === 1, String(taskAfterTimeout?.cumulative_query_calls));
  check('租约已释放', taskAfterTimeout?.active_attempt_id === null);
  const attemptRow = db
    .prepare('SELECT state FROM agent_task_attempts WHERE id = ?')
    .get(attempt1) as unknown as { state: string };
  check('attempt 状态为 timeout', attemptRow.state === 'timeout', attemptRow.state);

  const cp1 = getLatestCheckpoint(db, taskId);
  check('超时也写了检查点', cp1 !== undefined);
  check('检查点记录停止原因 wall', cp1?.stop_reason === 'wall', String(cp1?.stop_reason));
  assertNoTextInCheckpoints(db, taskId, '一篇不该出现在检查点的稿件备注', '第一次运行');

  // ── 显式 Resume ────────────────────────────────────────────
  const attempt2 = randomUUID();
  const claimed = claimResume(db, { taskId, ownerId: OWNER.id, attemptId: attempt2, now: new Date().toISOString() });
  check('Resume 抢占成功', claimed.ok, JSON.stringify(claimed));
  const resume = resumeStateOf(db, taskId);
  check('检查点至少有两个版本（工具边界 + 终态）', (cp1?.version ?? 0) >= 2, String(cp1?.version));

  const answerText = '续跑后的答案正文不应入库。';
  const second = await runWithTask(
    db,
    { taskId, attemptId: attempt2, resume },
    (turn) =>
      turn === 0
        ? { toolCalls: [{ name: SUBMISSIONS_TOOL, args: { keyword: '续跑验证' } }] }
        : submitSpec(answerText),
    // 总额度 2 次、上次已用 1 次 → 本次生效额度应只剩 1 次。
    // 终态回报里的 `budget.limits` 是**扣减后**的值，直接断言它。
    { maxQueryCalls: 2, maxToolCalls: 10, maxTokens: 1_000_000, maxWallMs: 10_000 },
  );

  check('续跑没有抛错', second.error === undefined, String(second.error));
  check('续跑返回了回答', second.answer !== undefined);
  check(
    '续跑提示词明确标注【续跑】并带原问题',
    (second.prompts[0] ?? '').includes('【续跑】') && (second.prompts[0] ?? '').includes(QUESTION),
  );
  check(
    '续跑恢复了上次的记录证据（evidenceCount=1）',
    second.answer?.delivery.evidenceCount === 1,
    String(second.answer?.delivery.evidenceCount),
  );
  const f2 = second.finalizations[0];
  check('续跑过程仅记录本次恢复的证据，引用来自最终交付',
    second.answer?.process?.steps.some((step) => step.phase === 'resume' && step.state === 'done') === true &&
    second.answer.process.counts.pooled === 1 && second.answer.process.counts.modelVisible === 1 &&
    second.answer.process.counts.citations === second.answer.answer.citations.length);
  check(
    '累计预算：本次生效的查询额度 = 2 − 1（已用）',
    f2?.budget.limits.maxQueryCalls === 1,
    String(f2?.budget.limits.maxQueryCalls),
  );
  check(
    '累计预算：本次实际用了这 1 次查询',
    f2?.budget.used.queryCalls === 1,
    String(f2?.budget.used.queryCalls),
  );
  const taskAfterResume = getTask(db, taskId);
  check(
    '续跑后任务收尾（completed 或 partial）',
    taskAfterResume?.status === 'completed' || taskAfterResume?.status === 'partial',
    String(taskAfterResume?.status),
  );
  check('续跑后没有活跃 attempt', taskAfterResume?.active_attempt_id === null);
  check(
    '任务累计查询次数 = 两次 attempt 之和（1 + 1）',
    taskAfterResume?.cumulative_query_calls === 2,
    String(taskAfterResume?.cumulative_query_calls),
  );
  assertNoTextInCheckpoints(db, taskId, answerText, '续跑');
  assertNoTextInCheckpoints(db, taskId, '一篇不该出现在检查点的稿件备注', '续跑');

  // ── 版本漂移：文档重建索引后，旧证据必须丢弃 ───────────────
  const DOC_TEXT = '版本漂移测试原文：这条证据不应该被旧检查点带回来。';
  db.prepare(
    `INSERT INTO documents (id, material, title, content_hash, status, created_at, index_version)
     VALUES ('doc-1', 'policy', '版本漂移测试文档', 'hash-1', 'ready', ?, 1)`,
  ).run(T0);
  db.prepare(
    `INSERT INTO doc_chunks (id, doc_id, ordinal, text, text_seg, page, section_path)
     VALUES ('chunk-1', 'doc-1', 0, ?, ?, 1, '["1","1.1"]')`,
  ).run(DOC_TEXT, DOC_TEXT);

  async function docResumeRun(sourceVersion: string, label: string): Promise<RunResult> {
    const tid = randomUUID();
    const aid = randomUUID();
    createTask(db, { taskId: tid, runId: randomUUID(), ownerId: OWNER.id, question: QUESTION, now: T0 });
    startAttempt(db, { attemptId: aid, taskId: tid, now: T0 });
    commitCheckpoint(db, {
      taskId: tid,
      attemptId: aid,
      now: T0,
      data: checkpointData({
        documents: [{ chunkId: 'chunk-1', documentId: 'doc-1', sourceVersion }],
        subgoals: [
          {
            id: 'sg-doc',
            kind: 'document',
            status: 'covered',
            evidenceCount: 1,
            evidenceChunkIds: ['chunk-1'],
          },
        ],
      }),
    });
    finishTask(db, {
      taskId: tid,
      attemptId: aid,
      now: T0,
      status: 'interrupted',
      attemptState: 'timeout',
      stopReason: 'wall',
      cumulative: { queryCalls: 0, toolCalls: 0, tokens: 0, costUsd: 0 },
    });
    const nextAttempt = randomUUID();
    const claim = claimResume(db, { taskId: tid, ownerId: OWNER.id, attemptId: nextAttempt, now: T0 });
    check(`${label}：Resume 抢占成功`, claim.ok, JSON.stringify(claim));
    const result = await runWithTask(
      db,
      { taskId: tid, attemptId: nextAttempt, resume: resumeStateOf(db, tid) },
      () => submitSpec('依据已有材料作答。'),
      { maxQueryCalls: 10, maxToolCalls: 10, maxTokens: 1_000_000, maxWallMs: 10_000 },
    );
    assertNoTextInCheckpoints(db, tid, DOC_TEXT, label);
    return result;
  }

  // 先模拟一次重建索引（版本 1 → 2），再拿旧检查点（sourceVersion=1）恢复。
  db.prepare('UPDATE documents SET index_version = 2 WHERE id = ?').run('doc-1');
  const drifted = await docResumeRun('1', '版本不符');
  check(
    '版本不符：提示旧证据被丢弃',
    (drifted.prompts[0] ?? '').includes('被丢弃'),
    drifted.prompts[0]?.slice(0, 200),
  );
  check(
    '版本不符：旧原文没有进入续跑上下文',
    !(drifted.prompts[0] ?? '').includes(DOC_TEXT),
  );
  check(
    '版本不符：没有可重建证据',
    drifted.answer?.delivery.evidenceCount === 0,
    String(drifted.answer?.delivery.evidenceCount),
  );

  // 新的检查点按 v2 恢复，必须能读回原文。
  const fresh = await docResumeRun('2', '版本一致');
  check('版本一致：证据从库里重新读回', fresh.answer?.delivery.evidenceCount === 1, String(fresh.answer?.delivery.evidenceCount));
  check(
    '版本一致：原文进入续跑上下文',
    (fresh.prompts[0] ?? '').includes(DOC_TEXT),
  );

  // ── 用户停止：cancelled，不自动续跑 ───────────────────────
  const abortTask = randomUUID();
  const abortAttempt = randomUUID();
  createTask(db, { taskId: abortTask, runId: randomUUID(), ownerId: OWNER.id, question: QUESTION, now: new Date().toISOString() });
  startAttempt(db, { attemptId: abortAttempt, taskId: abortTask, now: new Date().toISOString() });
  const controller = new AbortController();
  // 假模型第一步就挂着，不会产生 status（status 只在查库工具开始时发）。
  // 用定时器模拟"用户看着一个卡住的请求，点了停止"。
  const abortTimer = setTimeout(() => controller.abort(), 200);
  const aborted = await runWithTask(
    db,
    { taskId: abortTask, attemptId: abortAttempt },
    () => ({ hang: true }),
    { maxQueryCalls: 10, maxToolCalls: 10, maxTokens: 1_000_000, maxWallMs: 30_000 },
    { signal: controller.signal },
  );
  clearTimeout(abortTimer);
  check('用户停止抛 AskAbortedError', aborted.error instanceof AskAbortedError, String(aborted.error));
  const abortedTask = getTask(db, abortTask);
  check('用户停止 → cancelled', abortedTask?.status === 'cancelled', String(abortedTask?.status));
  check('用户停止不自动变成可续跑', !isResumeAvailable(abortedTask!, new Date().toISOString()));
}

// ── 第三部分：HTTP 路由（归属、并发双击、TTL、禁用账号）──────────
console.log('HTTP 路由：GET/Resume 的归属与并发');

{
  const { db } = openDb(':memory:');
  seedUser(db, OWNER.id, OWNER.username);
  seedUser(db, 'u-other', 'other');

  const models = createLabModels();
  installFakeModel(models, () => ({ ...submitSpec('HTTP 续跑回答。'), delayMs: 250 }), []);
  const app = createApp({
    db,
    config: CFG(ROOT),
    schemaVersion: 19,
    startedAt: Date.now(),
    models,
  });
  const now = new Date();
  const ownerSession = createSession(db, {
    userId: OWNER.id,
    now,
    idleDays: 7,
    maxDays: 30,
    ip: null,
    userAgent: null,
  });
  const otherSession = createSession(db, {
    userId: 'u-other',
    now,
    idleDays: 7,
    maxDays: 30,
    ip: null,
    userAgent: null,
  });
  const cookie = (s: { token: string }): string => `${SESSION_COOKIE}=${s.token}`;

  const taskId = randomUUID();
  const attemptId = randomUUID();
  const nowIso = now.toISOString();
  createTask(db, { taskId, runId: randomUUID(), ownerId: OWNER.id, question: QUESTION, now: nowIso });
  startAttempt(db, { attemptId, taskId, now: nowIso });
  commitCheckpoint(db, { taskId, attemptId, now: nowIso, data: checkpointData() });
  finishTask(db, {
    taskId,
    attemptId,
    now: nowIso,
    status: 'interrupted',
    attemptState: 'timeout',
    stopReason: 'wall',
    cumulative: { queryCalls: 0, toolCalls: 0, tokens: 0, costUsd: 0 },
  });

  const viewRes = await app.request(`http://localhost/api/v1/agent-tasks/${taskId}`, {
    headers: { cookie: cookie(ownerSession) },
  });
  const view = (await viewRes.json()) as {
    status?: string;
    resumeAvailable?: boolean;
    question?: string;
  };
  check('GET：本人可以读到任务', viewRes.status === 200, String(viewRes.status));
  check('GET：状态与可续跑标记正确', view.status === 'interrupted' && view.resumeAvailable === true);
  check('GET：视图不含检查点正文（只有问题）', view.question === QUESTION);

  const otherView = await app.request(`http://localhost/api/v1/agent-tasks/${taskId}`, {
    headers: { cookie: cookie(otherSession) },
  });
  check('GET：别人的任务返回 404', otherView.status === 404, String(otherView.status));

  // 并发双击：一个 200（SSE），一个 409。假模型延迟 250ms 保证真的重叠。
  const resumeUrl = `http://localhost/api/v1/agent-tasks/${taskId}/resume`;
  const [r1, r2] = await Promise.all([
    app.request(resumeUrl, { method: 'POST', headers: { cookie: cookie(ownerSession) } }),
    app.request(resumeUrl, { method: 'POST', headers: { cookie: cookie(ownerSession) } }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  check('并发 Resume：一个成功、一个 409', statuses[0] === 200 && statuses[1] === 409, statuses.join(','));
  const okRes = r1.status === 200 ? r1 : r2;
  const sse = await okRes.text();
  check(
    'Resume SSE 有终态事件',
    /event: (verified_final|partial)/.test(sse),
    sse.slice(-200),
  );
  const afterHttp = getTask(db, taskId);
  check(
    'HTTP 续跑后任务收尾（completed 或 partial）',
    afterHttp?.status === 'completed' || afterHttp?.status === 'partial',
    String(afterHttp?.status),
  );

  const otherResume = await app.request(resumeUrl, {
    method: 'POST',
    headers: { cookie: cookie(otherSession) },
  });
  check('Resume：别人的任务返回 404', otherResume.status === 404, String(otherResume.status));

  // TTL：过期任务即使有检查点也不能续跑。
  const expiredTask = randomUUID();
  const expiredAttempt = randomUUID();
  const oldIso = '2020-01-01T00:00:00.000Z';
  createTask(db, {
    taskId: expiredTask,
    runId: randomUUID(),
    ownerId: OWNER.id,
    question: QUESTION,
    now: oldIso,
    ttlDays: 1,
  });
  startAttempt(db, { attemptId: expiredAttempt, taskId: expiredTask, now: oldIso });
  commitCheckpoint(db, { taskId: expiredTask, attemptId: expiredAttempt, now: oldIso, data: checkpointData() });
  finishTask(db, {
    taskId: expiredTask,
    attemptId: expiredAttempt,
    now: oldIso,
    status: 'interrupted',
    attemptState: 'timeout',
    stopReason: 'wall',
    cumulative: { queryCalls: 0, toolCalls: 0, tokens: 0, costUsd: 0 },
  });
  const expiredRes = await app.request(`http://localhost/api/v1/agent-tasks/${expiredTask}/resume`, {
    method: 'POST',
    headers: { cookie: cookie(ownerSession) },
  });
  check('Resume：TTL 过期返回 410', expiredRes.status === 410, String(expiredRes.status));

  // 撤权：账号被禁用后，旧会话当场失效，任务读不到也续不了。
  db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(OWNER.id);
  const disabledView = await app.request(`http://localhost/api/v1/agent-tasks/${taskId}`, {
    headers: { cookie: cookie(ownerSession) },
  });
  check('撤权后 GET 任务返回 401', disabledView.status === 401, String(disabledView.status));
  const disabledResume = await app.request(
    `http://localhost/api/v1/agent-tasks/${taskId}/resume`,
    { method: 'POST', headers: { cookie: cookie(ownerSession) } },
  );
  check('撤权后 Resume 返回 401', disabledResume.status === 401, String(disabledResume.status));
}

// ── 汇总 ──────────────────────────────────────────────────────────
console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} 项断言失败：`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log(`全部通过：${passed} 项断言。`);
}
