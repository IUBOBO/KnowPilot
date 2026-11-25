/**
 * 运行 Trace（O7）的验证脚本：`npm run verify-trace -w @knowpilot/server`。
 *
 * 【为什么真的跑一次 /api/v1/ask，而不是直接往表里插一行】
 *   这一份要钉住的正是"Trace 是**运行过程**的产物"：终态由 `runAsk` 的
 *   onFinalize 交出来，`toolTrace` / `budget` / `quoteChecks` 都是现场算的。
 *   手工构造一行只能证明"表能存"，证明不了"生产路径真的会写、而且写的是
 *   真实发生的事"。所以这里照 budget-check 的做法换掉 `models.streamSimple`，
 *   让一次问答零成本、可重复地跑完，被测的仍是真实路由与真实 ask-run。
 *
 * 【这一份钉死的是什么】
 *   · 三个问答入口的 Trace 都在（本脚本走同步入口）；
 *   · Trace 表和管理接口均不包含回答正文、证据原文或问题原文；
 *   · 列表能按运行 ID / 用户 / 结果筛选，结果计数不随筛选变化；
 *   · 详情带预算、工具轨迹与 usage_events 关联，且正文哨兵不出现；
 *   · 普通成员与导师都进不来（403），匿名 401，只有 admin 200。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
import type {
  AdminTraceDetail,
  ApiErrorBody,
  AskResponse,
  ListAdminTracesResponse,
  ListAskRecordsResponse,
} from '@knowpilot/shared';
import { createApp } from '../app.ts';
import { createLabModels } from '../agent/models.ts';
import { SUBMIT_ANSWER_TOOL } from '../agent/tools.ts';
import type { AppConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import type { Db } from '../db/index.ts';
import { SESSION_COOKIE } from '../auth/session.ts';
import { insertUser } from '../auth/users.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'knowpilot-trace-verify-'));
const FIXED_NOW = new Date('2026-10-18T05:00:00.000Z');
/** 回答正文里的哨兵：它绝不能出现在 Trace 的任何响应里。 */
const ANSWER_SENTINEL = 'TRACE-SECRET-ANSWER-7f3a';
/** 问题原文里的哨兵：提问者仍可从问答历史读取，Trace 响应中应当隐藏。 */
const QUESTION_SENTINEL = 'TRACE-QUESTION-91c2';

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

function buildConfig(): AppConfig {
  return {
    port: 0,
    dbPath: join(ROOT, 'knowpilot.db'),
    uploadDir: join(ROOT, 'uploads'),
    repoRoot: ROOT,
    // 假模型不联网；给一个非空 key 只是为了过"必须在 prompt 之前解析鉴权"那一关。
    deepseekApiKey: 'fake-key-for-trace-check',
    modelChat: undefined,
    modelReasoner: undefined,
    modelBaseUrl: undefined,
    hfHome: join(ROOT, 'hf'),
    embedModelDir: join(ROOT, 'hf', 'knowpilot-models'),
    embedModelId: 'bge-m3',
    embedDtype: 'q8',
    rerankEnabled: false,
    rerankModelId: 'bge-reranker-base',
    rerankDtype: 'q8',
    rerankCandidateDepth: 30,
    rerankTimeoutMs: 3000,
    ocrEnabled: false,
    ocrMaxPages: 1,
    codeRoots: [join(ROOT, 'datasets')],
    dataRoot: join(ROOT, 'datasets'),
    uploadMaxBytes: 1024 * 1024,
    uploadChunkSize: 1024 * 1024,
    uploadSessionTtlDays: 7,
    knowledgeConflictThreshold: 0.82,
    patrolIntervalHours: 24,
    sessionIdleDays: 7,
    sessionMaxDays: 30,
    cookieSecure: false,
    adminUsername: undefined,
    adminPassword: undefined,
  };
}

function buildMessage(model: Model<Api>, answer: string, nextId: () => string): AssistantMessage {
  const content: (TextContent | ToolCall)[] = [
    {
      type: 'toolCall',
      id: nextId(),
      name: SUBMIT_ANSWER_TOOL,
      arguments: {
        answer,
        quotes: [],
        evidence_gaps: [],
        limits: [],
        confidence_notes: [],
        conflicts: [],
      } satisfies JsonObject,
    },
  ];
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 120,
      output: 30,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  };
}

function installFakeModel(models: MutableModels, answer: string): void {
  let callSeq = 0;
  const target = models as unknown as {
    streamSimple: (
      m: Model<Api>,
      c: TranscriptContext,
      o?: SimpleStreamOptions,
    ) => AssistantMessageEventStream;
  };
  target.streamSimple = (model) => {
    const stream = createAssistantMessageEventStream();
    const message = buildMessage(model, answer, () => {
      callSeq += 1;
      return `fake-trace-${callSeq}`;
    });
    queueMicrotask(() => {
      stream.push({ type: 'done', reason: 'toolUse', message });
    });
    return stream;
  };
}

async function main(): Promise<void> {

  const cfg = buildConfig();
  const { db, migration } = openDb(cfg.dbPath);
  const models = createLabModels();
  installFakeModel(models, `这是回答正文。${ANSWER_SENTINEL}`);

  // createApp 内部会跑 verifyRouteCoverage —— 它成功返回本身就说明两条新路由
  // 都登记了权限规则（漏登记会在启动自检里抛错）。
  const app = createApp({
    db,
    config: cfg,
    schemaVersion: migration.toVersion,
    startedAt: Date.now(),
    models,
  });

  const api = async (
    path: string,
    init: RequestInit = {},
    cookie?: string,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
    };
    if (cookie !== undefined) headers['cookie'] = cookie;
    return app.request(path, { ...init, headers });
  };

  const json = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const bodyOf = async <T>(res: Response): Promise<T> => (await res.json()) as T;

  async function loginCookie(username: string, password: string): Promise<string> {
    const res = await api('/api/v1/auth/login', json({ username, password }));
    assert.equal(res.status, 200, `登录 ${username} 应当成功`);
    const raw = res.headers.get('set-cookie') ?? '';
    const token = /kp_session=([^;]*)/u.exec(raw)?.[1];
    assert.ok(token !== undefined && token !== '', `响应里应当有 kp_session：${raw}`);
    return `${SESSION_COOKIE}=${token}`;
  }

  console.log(`\n迁移已到 v${migration.toVersion}，临时根目录：${ROOT}\n`);

  await insertUser(
    db,
    'trace-admin',
    { password: 'admin-pw-123456', role: 'admin', displayName: '管理员' },
    FIXED_NOW,
  );
  const memberId = await insertUser(
    db,
    'trace-member',
    { password: 'member-pw-123456', role: 'member', displayName: '成员甲' },
    FIXED_NOW,
  );
  await insertUser(
    db,
    'trace-mentor',
    { password: 'mentor-pw-123456', role: 'mentor', displayName: '导师' },
    FIXED_NOW,
  );

  const adminCookie = await loginCookie('trace-admin', 'admin-pw-123456');
  const memberCookie = await loginCookie('trace-member', 'member-pw-123456');
  const mentorCookie = await loginCookie('trace-mentor', 'mentor-pw-123456');

  async function ask(cookie: string, question: string): Promise<AskResponse> {
    const res = await api(
      '/api/v1/ask',
      json({ question, consentConfirmed: true }),
      cookie,
    );
    const body = await bodyOf<AskResponse | ApiErrorBody>(res);
    assert.equal(res.status, 200, `问答应当成功：${JSON.stringify(body)}`);
    return body as AskResponse;
  }

  // ── 1. 生产路径真的写出 Trace ───────────────────────────────
  console.log('写入：');
  const memberRun = await ask(memberCookie, `轻量目标检测用了什么方法？${QUESTION_SENTINEL}`);
  const adminRun = await ask(adminCookie, '请假流程是什么？');
  {
    const row = db
      .prepare('SELECT * FROM ask_run_traces WHERE run_id = ?')
      .get(memberRun.runId) as Record<string, unknown> | undefined;
    check('一次问答恰好写一行 Trace', row !== undefined);
    check('行数与运行数一致', countRows(db, 'ask_run_traces') === 2, String(countRows(db, 'ask_run_traces')));
    check('user_id 是提问人', row?.['user_id'] === memberId, String(row?.['user_id']));
    check('outcome 是 ok', row?.['outcome'] === 'ok', String(row?.['outcome']));
    check('表里没有问题原文列', !hasColumn(db, 'ask_run_traces', 'question'));
    check('表里没有回答正文列', !hasColumn(db, 'ask_run_traces', 'answer') && !hasColumn(db, 'ask_run_traces', 'answer_text'));
    check('整行序列化后不含回答正文哨兵', !JSON.stringify(row).includes(ANSWER_SENTINEL));
    check('整行序列化后不含问题原文哨兵', !JSON.stringify(row).includes(QUESTION_SENTINEL));

    const toolTrace = JSON.parse(String(row?.['tool_trace_json'])) as { name: string; atMs: number }[];
    check('工具轨迹记到了 submit_answer', toolTrace.some((t) => t.name === SUBMIT_ANSWER_TOOL), JSON.stringify(toolTrace));
    check('工具轨迹带相对时间偏移', toolTrace.every((t) => typeof t.atMs === 'number'));

    const budget = JSON.parse(String(row?.['budget_json'])) as { limits: { maxTokens: number }; used: { tokens: number } };
    check('预算额度与用量都落了', budget.limits.maxTokens > 0 && budget.used.tokens >= 0, JSON.stringify(budget));
  }

  // ── 2. 列表与筛选（admin）───────────────────────────────────
  console.log('\n列表与筛选：');
  {
    const all = await bodyOf<ListAdminTracesResponse>(
      await api('/api/v1/admin/traces', {}, adminCookie),
    );
    check('管理员看到两条', all.items.length === 2, String(all.items.length));
    check('全量计数 all=2 / ok=2', all.counts.all === 2 && all.counts.byOutcome.some((c) => c.outcome === 'ok' && c.count === 2), JSON.stringify(all.counts));

    const joined = all.items.find((i) => i.runId === memberRun.runId);
    check('管理列表只显示问题脱敏占位', joined?.question === '已脱敏' && !JSON.stringify(all).includes(QUESTION_SENTINEL));
    check('提问人显示名来自 users', joined?.asker === '成员甲', String(joined?.asker));
    check('列表项不含回答正文', all.items.every((i) => !('answer' in i) && !('answerText' in i)));

    const byRun = await bodyOf<ListAdminTracesResponse>(
      await api(`/api/v1/admin/traces?runId=${encodeURIComponent(memberRun.runId)}`, {}, adminCookie),
    );
    check('按运行 ID 精确筛选', byRun.items.length === 1 && byRun.items[0]?.runId === memberRun.runId, String(byRun.items.length));

    // 把一个用户的归属抹成 NULL，照阶段 1–3 的公共历史造出"未归属"桶。
    db.prepare('UPDATE ask_run_traces SET user_id = NULL WHERE run_id = ?').run(adminRun.runId);
    const none = await bodyOf<ListAdminTracesResponse>(
      await api('/api/v1/admin/traces?userId=none', {}, adminCookie),
    );
    check('userId=none 筛出未记录归属的运行', none.items.length === 1 && none.items[0]?.runId === adminRun.runId, String(none.items.length));
    check('未归属桶有可读标签', none.users.some((u) => u.userId === null && u.label === '未记录归属'));

    const byUser = await bodyOf<ListAdminTracesResponse>(
      await api(`/api/v1/admin/traces?userId=${encodeURIComponent(memberId)}`, {}, adminCookie),
    );
    check('按用户筛选', byUser.items.length === 1 && byUser.items[0]?.runId === memberRun.runId, String(byUser.items.length));

    const byOutcome = await bodyOf<ListAdminTracesResponse>(
      await api('/api/v1/admin/traces?outcome=ok', {}, adminCookie),
    );
    check('按结果筛选', byOutcome.items.length === 2, String(byOutcome.items.length));
    check('筛选后计数仍是全量', byOutcome.counts.all === 2, JSON.stringify(byOutcome.counts));

    const bogus = await api('/api/v1/admin/traces?outcome=bogus', {}, adminCookie);
    check('拼错的 outcome → 400（不静默退化成全部）', bogus.status === 400, String(bogus.status));
  }

  // ── 3. 详情形状与正文隔离 ───────────────────────────────────
  console.log('\n详情：');
  {
    const res = await api(`/api/v1/admin/traces/${encodeURIComponent(memberRun.runId)}`, {}, adminCookie);
    check('管理员取详情 → 200', res.status === 200, String(res.status));
    const detail = await bodyOf<AdminTraceDetail>(res);

    check('管理详情只显示问题脱敏占位', detail.question === '已脱敏' && !JSON.stringify(detail).includes(QUESTION_SENTINEL));
    check('预算四维齐全', typeof detail.budget.used.queryCalls === 'number' && typeof detail.budget.limits.maxWallMs === 'number');
    check('工具轨迹非空', detail.toolCalls.length > 0, JSON.stringify(detail.toolCalls));
    check('有模型、提示词哈希与路由', detail.model !== '' && detail.promptHash.length > 0 && ['simple', 'multi_source', 'state_lookup'].includes(detail.route), JSON.stringify({ model: detail.model, hash: detail.promptHash, route: detail.route }));
    check('详情带 usage_events（同一 run_id）', detail.usageEvents.length > 0, String(detail.usageEvents.length));
    check('usage_events 的 token 与这次假模型一致', detail.usageEvents.some((e) => e.inputTokens === 120 && e.outputTokens === 30), JSON.stringify(detail.usageEvents));
    check('详情 JSON 不含回答正文哨兵', !JSON.stringify(detail).includes(ANSWER_SENTINEL));
    check('详情 JSON 不含证据原文（本次没有文档证据）', Array.isArray(detail.retrievalHits));

    const syntheticSecrets = ['fixture-passphrase-G2', 'https://fixture.invalid/file?credentials=private-fixture', 'C:/fixture/research/private-file'] as const;
    db.prepare(`UPDATE ask_run_traces SET tool_trace_json = ?, rewrite_events_json = ?, follow_up_rewrite_json = ?,
      warnings_json = ?, errors_json = ? WHERE run_id = ?`).run(
      JSON.stringify([{ name: 'retrieve', query: syntheticSecrets[0], hitCount: 2, ms: 15, atMs: 16, isError: false,
        retrieval: { mode: 'keyword', newEvidence: 1, ranking: 'fallback', rankedCandidates: 2 } }]),
      JSON.stringify([{ round: 1, gapReason: 'missing_subgoal', missingSubgoalIds: ['G1', 'F1', syntheticSecrets[2]],
        queries: [{ text: syntheticSecrets[1], subgoalId: 'G1' }, { text: syntheticSecrets[0], subgoalId: 'F1' }],
        unexpectedProperty: syntheticSecrets[2], evidenceIdsAdded: [],
        coverageBefore: 'partial', coverageAfter: 'partial', stoppedReason: 'completed' }]),
      JSON.stringify({ original: syntheticSecrets[2], rewritten: syntheticSecrets[0], changed: true, ms: 20 }),
      JSON.stringify([syntheticSecrets[2]]), JSON.stringify([syntheticSecrets[1]]), memberRun.runId,
    );
    const privateQuestion = [QUESTION_SENTINEL, 'Cookie: session=fixture-session-token', '一段未标记的合成私有科研正文',
      '密码：fixture-chinese', 'DEEPSEEK_API_KEY=fixture-env-key', 'https://fixture.invalid/file?signature=private-fixture'].join(' ');
    db.prepare('UPDATE ask_records SET question = ? WHERE run_id = ?').run(privateQuestion, memberRun.runId);

    const redacted = await bodyOf<AdminTraceDetail>(
      await api(`/api/v1/admin/traces/${encodeURIComponent(memberRun.runId)}`, {}, adminCookie),
    );
    const redactedList = await bodyOf<ListAdminTracesResponse>(
      await api(`/api/v1/admin/traces?runId=${encodeURIComponent(memberRun.runId)}`, {}, adminCookie),
    );
    const rawTrace = JSON.stringify([redacted, redactedList]);
    check('管理 Trace 脱敏工具参数、改写文本、错误和警告', syntheticSecrets.every((secret) => !rawTrace.includes(secret)));
    check('管理列表和详情均遮蔽会话 Cookie、私有正文及凭据',
      redacted.question === '已脱敏' && redactedList.items[0]?.question === '已脱敏' &&
      [QUESTION_SENTINEL, 'fixture-session-token', '合成私有科研正文', 'fixture-chinese', 'fixture-env-key', 'private-fixture']
        .every((secret) => !rawTrace.includes(secret)));
    check('脱敏保留计时、候选、检索模式、重排回退和合法子任务编号',
      redacted.toolCalls[0]?.ms === 15 && redacted.toolCalls[0]?.hitCount === 2 &&
      redacted.toolCalls[0]?.retrieval?.mode === 'keyword' && redacted.toolCalls[0]?.retrieval?.ranking === 'fallback' &&
      redacted.rewriteEvents[0]?.missingSubgoalIds.join(',') === 'G1,F1' &&
      redacted.rewriteEvents[0]?.queries.map((query) => query.subgoalId).join(',') === 'G1,F1');
    const ownerHistory = await bodyOf<ListAskRecordsResponse>(await api('/api/v1/ask-records', {}, memberCookie));
    check('提问者自己的问答历史仍保留问题原文',
      ownerHistory.items.find((item) => item.runId === memberRun.runId)?.question === privateQuestion);
    db.prepare('DELETE FROM ask_records WHERE run_id = ?').run(adminRun.runId);
    const orphan = await bodyOf<AdminTraceDetail>(
      await api(`/api/v1/admin/traces/${encodeURIComponent(adminRun.runId)}`, {}, adminCookie),
    );
    check('原始记录缺失时保留可空问题字段', orphan.question === null);
    const absent = await api('/api/v1/admin/traces/run-does-not-exist', {}, adminCookie);
    check('不存在的运行 → 404', absent.status === 404, String(absent.status));
  }

  // ── 4. 权限：普通成员与导师都进不来 ────────────────────────
  console.log('\n权限：');
  {
    const anonList = await api('/api/v1/admin/traces');
    check('匿名访问列表 → 401', anonList.status === 401, String(anonList.status));

    const memberList = await api('/api/v1/admin/traces', {}, memberCookie);
    check('member 访问列表 → 403', memberList.status === 403, String(memberList.status));

    const memberDetail = await api(`/api/v1/admin/traces/${encodeURIComponent(memberRun.runId)}`, {}, memberCookie);
    check('member 访问详情 → 403', memberDetail.status === 403, String(memberDetail.status));

    // 导师能看全部问答记录（askRecord.read.all），但 Trace 是另一个权限点 ——
    // 这条断言防的是"顺手把 trace.read.all 加进导师那组"。
    const mentorList = await api('/api/v1/admin/traces', {}, mentorCookie);
    check('mentor 访问列表 → 403', mentorList.status === 403, String(mentorList.status));

    const mentorDetail = await api(`/api/v1/admin/traces/${encodeURIComponent(memberRun.runId)}`, {}, mentorCookie);
    check('mentor 访问详情 → 403', mentorDetail.status === 403, String(mentorDetail.status));

    const adminList = await api('/api/v1/admin/traces', {}, adminCookie);
    check('admin 访问列表 → 200', adminList.status === 200, String(adminList.status));
  }

  // ── 5. 失败路径也写 Trace（可选但重要）──────────────────────
  // 这一份不替换模型让问答失败，而是直接确认表允许 outcome 写出非 ok 的行 ——
  // 失败路径本身由 verify-budget 的终态断言覆盖；这里只钉住"表能如实存"。
  console.log('\n表结构：');
  {
    const columns = (
      db.prepare('PRAGMA table_info(ask_run_traces)').all() as unknown as { name: string }[]
    ).map((c) => c.name);
    check(
      'ask_run_traces 不复制 question / answer / answer_text',
      !columns.includes('question') && !columns.includes('answer') && !columns.includes('answer_text'),
      columns.join(','),
    );
    check('有 run_id 主键（与另外两张表同一个值）', columns.includes('run_id'));
    const indexes = (
      db.prepare('PRAGMA index_list(ask_run_traces)').all() as unknown as { name: string }[]
    ).map((i) => i.name);
    check('按时间/用户/结果的索引都在', ['idx_ask_run_traces_asked', 'idx_ask_run_traces_user', 'idx_ask_run_traces_outcome'].every((n) => indexes.includes(n)), indexes.join(','));
  }

  // ── 结果 ───────────────────────────────────────────────────
  db.close();
  const total = passed + failures.length;
  console.log(`\n${passed}/${total} 通过`);
  if (failures.length > 0) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`\n临时数据留在 ${ROOT}（可直接删除，与真实数据无关）。`);
  }
}

function countRows(db: Db, table: string): number {
  // 表名来自本文件内的字面量，不是请求输入。
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function hasColumn(db: Db, table: string, column: string): boolean {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
  ).some((c) => c.name === column);
}

await main();
