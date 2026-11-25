/**
 * 运行 Trace 的读写（O7）。
 *
 * 【这一张表回答什么】"这次问答过程中发生了什么"：工具按什么顺序调了哪些、
 *   检索的模式与范围、命中几条、预算用掉多少、哪些 Claim 没过、耗时多少。
 *   它不回答"答案写了什么"—— 回答正文与证据摘录从来不进这张表。
 *
 * 【与另外两张表的关系】`run_id` 是同一个值：
 *   · `ask_records` 只用于判断问题记录是否存在，Trace 不选择或返回原文；
 *   · `usage_events` 提供调用级费用（详情页按 run_id 再查一次）；
 *   · 本表提供过程快照。三张表各管一件事，不合并。
 */
import { MATERIALS } from '@knowpilot/shared';
import type {
  AdminTraceDetail,
  AdminTraceListItem,
  AskOutcome,
  ListAdminTracesResponse,
  TraceBudget,
  TraceCitationRef,
  TraceClaimCheck,
  TraceDeliveryStatus,
  TraceLastStage,
  TraceOutcomeCount,
  TracePlan,
  TraceRecordEvidence,
  TraceRetrievalHit,
  TraceRewriteEvent,
  TraceRoute,
  TraceStopReason,
  TraceToolCall,
  TraceUsageEvent,
  TraceUserFacet,
  QuoteCheckSummary,
  FollowUpRewrite,
} from '@knowpilot/shared';
import type { AskFinalization } from '../agent/ask-run.ts';
import type { Db } from '../db/index.ts';

/** 写入一条脱敏的问答运行记录。 */
export interface NewRunTrace {
  finalization: AskFinalization;
  userId: string | null;
  /** 运行开始时刻。与 ask_records.asked_at 同源，保证两张表能按时间对齐。 */
  askedAt: string;
  /** 落库时刻。与 askedAt 分开：排查时钟问题时两者会对不上。 */
  recordedAt: string;
}

export function insertRunTrace(db: Db, input: NewRunTrace): void {
  const f = input.finalization;
  db.prepare(
    `INSERT INTO ask_run_traces (
       run_id, user_id, asked_at, outcome, stop_reason, delivery_status,
       last_stage, model, prompt_hash, route, duration_ms, turn,
       evidence_count, context_chars,
       budget_json, tool_trace_json, retrieval_hits_json, record_evidence_json,
       citation_map_json, claim_checks_json, quote_checks_json, plan_json,
       rewrite_rounds, rewrite_events_json, follow_up_rewrite_json,
       warnings_json, errors_json, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    f.runId,
    input.userId,
    input.askedAt,
    f.outcome,
    f.stopReason,
    f.deliveryStatus,
    f.lastStage,
    f.model,
    f.promptHash,
    f.route,
    f.durationMs,
    f.turn,
    f.evidenceCount,
    f.contextChars,
    JSON.stringify(f.budget),
    JSON.stringify((f.toolTrace ?? []).map(safeToolCall)),
    JSON.stringify(f.retrievalHits),
    JSON.stringify(f.recordEvidence),
    JSON.stringify(f.citationMap),
    JSON.stringify(f.claimChecks),
    f.quoteChecks === undefined ? null : JSON.stringify(f.quoteChecks),
    JSON.stringify(f.plan),
    f.rewriteRounds,
    JSON.stringify(f.rewriteEvents.map(safeRewriteEvent)),
    f.followUpRewrite === undefined ? null : JSON.stringify(safeFollowUp(f.followUpRewrite)),
    JSON.stringify(maskedMessages(f.warnings)),
    JSON.stringify(maskedMessages(f.errors)),
    input.recordedAt,
  );
}

export interface TraceFilter {
  /** 精确匹配运行 ID。空串 = 不筛。 */
  runId?: string;
  /** 用户 ID；'none' = 未记录归属（user_id IS NULL）。 */
  userId?: string;
  outcome?: AskOutcome;
  limit: number;
}

interface TraceListRow {
  run_id: string;
  asked_at: string;
  user_id: string | null;
  asker: string | null;
  has_question: 0 | 1;
  outcome: string;
  stop_reason: string;
  delivery_status: string;
  duration_ms: number;
  evidence_count: number;
}

const LIST_SELECT = `
  SELECT t.run_id, t.asked_at, t.user_id,
         COALESCE(u.display_name, u.username) AS asker,
         (r.question IS NOT NULL) AS has_question,
         t.outcome, t.stop_reason, t.delivery_status,
         t.duration_ms, t.evidence_count
    FROM ask_run_traces t
    LEFT JOIN users u ON u.id = t.user_id
    LEFT JOIN ask_records r ON r.run_id = t.run_id`;

export function listRunTraces(db: Db, filter: TraceFilter): ListAdminTracesResponse {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.runId !== undefined && filter.runId !== '') {
    where.push('t.run_id = ?');
    params.push(filter.runId);
  }
  if (filter.userId === 'none') {
    where.push('t.user_id IS NULL');
  } else if (filter.userId !== undefined && filter.userId !== '') {
    where.push('t.user_id = ?');
    params.push(filter.userId);
  }
  if (filter.outcome !== undefined) {
    where.push('t.outcome = ?');
    params.push(filter.outcome);
  }
  const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
  const rows = db
    .prepare(`${LIST_SELECT}${clause} ORDER BY t.asked_at DESC LIMIT ?`)
    .all(...params, filter.limit) as unknown as TraceListRow[];

  return {
    items: rows.map(toListItem),
    users: listTraceUsers(db),
    counts: traceCounts(db),
  };
}

function toListItem(row: TraceListRow): AdminTraceListItem {
  return {
    runId: row.run_id,
    askedAt: row.asked_at,
    userId: row.user_id,
    asker: row.asker,
    question: row.has_question === 1 ? REDACTED_TRACE_TEXT : null,
    outcome: row.outcome as AskOutcome,
    stopReason: row.stop_reason as TraceStopReason,
    deliveryStatus: row.delivery_status as TraceDeliveryStatus,
    durationMs: row.duration_ms,
    evidenceCount: row.evidence_count,
  };
}

/**
 * 筛选下拉里"有 Trace 的人"。
 *
 * 【为什么要带上未归属桶】阶段 1–3 的问答没有 user_id；如果这一桶被藏起来，
 *   管理员按用户筛选时会发现"列表里的条数怎么都对不上合计"。
 */
function listTraceUsers(db: Db): TraceUserFacet[] {
  const rows = db
    .prepare(
      `SELECT t.user_id,
              COALESCE(u.display_name, u.username) AS label,
              COUNT(*) AS n
         FROM ask_run_traces t
         LEFT JOIN users u ON u.id = t.user_id
        GROUP BY t.user_id
        ORDER BY n DESC, label`,
    )
    .all() as unknown as { user_id: string | null; label: string | null; n: number }[];
  return rows.map((r) => ({
    userId: r.user_id,
    // 用户被删除后 LEFT JOIN 拿不到名字；仍然给它一个可读的标签，
    // 而不是让下拉里出现一个空白项。
    label: r.user_id === null ? '未记录归属' : (r.label ?? `已删除用户 ${r.user_id.slice(0, 8)}`),
    count: r.n,
  }));
}

/** 全量计数，**不随筛选变化**：筛选按钮上要能写"异常 3"，切到别的档不能变 0。 */
function traceCounts(db: Db): { all: number; byOutcome: readonly TraceOutcomeCount[] } {
  const rows = db
    .prepare('SELECT outcome, COUNT(*) AS n FROM ask_run_traces GROUP BY outcome')
    .all() as unknown as { outcome: AskOutcome; n: number }[];
  return {
    all: rows.reduce((sum, r) => sum + r.n, 0),
    byOutcome: rows.map((r) => ({ outcome: r.outcome, count: r.n })),
  };
}

interface TraceDetailRow extends TraceListRow {
  last_stage: string;
  model: string;
  prompt_hash: string;
  route: string;
  turn: number;
  context_chars: number;
  budget_json: string;
  tool_trace_json: string;
  retrieval_hits_json: string;
  record_evidence_json: string;
  citation_map_json: string;
  claim_checks_json: string;
  quote_checks_json: string | null;
  plan_json: string;
  rewrite_rounds: number;
  rewrite_events_json: string;
  follow_up_rewrite_json: string | null;
  warnings_json: string;
  errors_json: string;
  recorded_at: string;
}

const REDACTED_TRACE_TEXT = '已脱敏';

// Trace payloads written before this projection can contain arbitrary user/model/tool text.
const TRACE_TOOL_NAMES = new Set([
  'retrieve', 'read_paper', 'query_submissions', 'probe_dataset', 'query_journal', 'query_patents',
  'query_theses', 'query_people', 'submit_answer', 'repair_quotes', 'follow_up_on_evidence',
]);
function parseTraceArray<T extends object>(raw: string): T[] {
  const value = parseJson<unknown>(raw, []);
  return Array.isArray(value)
    ? value.filter((item): item is T => item !== null && typeof item === 'object' && !Array.isArray(item))
    : [];
}
function maskedMessages(messages: readonly unknown[]): string[] {
  return messages.map(() => REDACTED_TRACE_TEXT);
}

function redactTraceMessages(raw: string): string[] {
  const messages = parseJson<unknown>(raw, []);
  return Array.isArray(messages) ? maskedMessages(messages) : [];
}

function safeRetrieval(value: TraceToolCall['retrieval']): TraceToolCall['retrieval'] {
  if (!value || !['keyword', 'semantic', 'hybrid'].includes(value.mode) || typeof value.newEvidence !== 'number') return undefined;
  const query = value.lookup;
  const lookup = query != null && ['keyword', 'semantic', 'hybrid'].includes(query.requestedMode) &&
    (query.scope === 'library' || query.scope === 'document') && Number.isInteger(query.limit) && query.limit > 0 ? {
      requestedMode: query.requestedMode, scope: query.scope, limit: query.limit,
      ...(query.material !== undefined && MATERIALS.includes(query.material) ? { material: query.material } : {}),
    } : undefined;
  return {
    mode: value.mode,
    newEvidence: value.newEvidence,
    ...(typeof value.order === 'number' && Number.isSafeInteger(value.order) && value.order >= 0 ? { order: value.order } : {}),
    ...(lookup === undefined ? {} : { lookup }),
    ...(value.ranking === 'reranked' || value.ranking === 'fallback' ? { ranking: value.ranking } : {}),
    ...(typeof value.rankedCandidates === 'number' ? { rankedCandidates: value.rankedCandidates } : {}),
    ...(typeof value.rankingMs === 'number' ? { rankingMs: value.rankingMs } : {}),
  };
}

function safeToolCall(call: TraceToolCall): TraceToolCall {
  const retrieval = safeRetrieval(call.retrieval);
  return {
    name: TRACE_TOOL_NAMES.has(call.name) ? call.name : 'unknown',
    ...(call.skipped === 'context_budget' ? { skipped: call.skipped } : {}),
    query: typeof call.query === 'string' ? REDACTED_TRACE_TEXT : null,
    hitCount: typeof call.hitCount === 'number' ? call.hitCount : null,
    ms: typeof call.ms === 'number' ? call.ms : 0,
    atMs: typeof call.atMs === 'number' ? call.atMs : 0,
    isError: call.isError === true,
    ...(retrieval === undefined ? {} : { retrieval }),
  };
}

function safeRewriteEvent(event: TraceRewriteEvent): TraceRewriteEvent {
  const subgoalId = (value: unknown): value is string => typeof value === 'string' && /^[GF]\d+$/u.test(value);
  const evidenceId = (value: unknown): value is string => typeof value === 'string' && /^E\d+$/u.test(value);
  const coverage = ['sufficient', 'partial', 'irrelevant', 'conflicting', 'not_found', 'blocked'];
  const gapReasons = ['term_mismatch', 'too_broad', 'missing_source', 'missing_subgoal', 'conflicting_sources',
    'permission_denied', 'budget_exceeded', 'unknown'];
  const stoppedReasons = ['completed', 'budget', 'empty_queries', 'no_evidence', 'blocked', 'error'];
  return {
    round: typeof event.round === 'number' ? event.round : 0,
    gapReason: gapReasons.includes(event.gapReason) ? event.gapReason : 'unknown',
    missingSubgoalIds: Array.isArray(event.missingSubgoalIds) ? event.missingSubgoalIds.filter(subgoalId) : [],
    queries: Array.isArray(event.queries)
      ? event.queries.map((query) => ({ subgoalId: subgoalId(query?.subgoalId) ? query.subgoalId : '', text: REDACTED_TRACE_TEXT }))
      : [],
    evidenceIdsAdded: Array.isArray(event.evidenceIdsAdded) ? event.evidenceIdsAdded.filter(evidenceId) : [],
    coverageBefore: coverage.includes(event.coverageBefore) ? event.coverageBefore : 'unknown',
    coverageAfter: coverage.includes(event.coverageAfter) ? event.coverageAfter : 'unknown',
    stoppedReason: stoppedReasons.includes(event.stoppedReason) ? event.stoppedReason : 'unknown',
  };
}

function safeFollowUp(rewrite: FollowUpRewrite): FollowUpRewrite {
  return { changed: rewrite.changed === true, ms: typeof rewrite.ms === 'number' ? rewrite.ms : 0,
    original: REDACTED_TRACE_TEXT, rewritten: REDACTED_TRACE_TEXT };
}

export function getRunTrace(db: Db, runId: string): AdminTraceDetail | null {
  const row = db
    .prepare(
      `SELECT t.*, (r.question IS NOT NULL) AS has_question,
              COALESCE(u.display_name, u.username) AS asker
         FROM ask_run_traces t
         LEFT JOIN users u ON u.id = t.user_id
         LEFT JOIN ask_records r ON r.run_id = t.run_id
        WHERE t.run_id = ?`,
    )
    .get(runId) as unknown as TraceDetailRow | undefined;
  if (row === undefined) return null;
  const rewrite = row.follow_up_rewrite_json === null ? null
    : parseJson<FollowUpRewrite | null>(row.follow_up_rewrite_json, null);

  return {
    ...toListItem(row),
    lastStage: row.last_stage as TraceLastStage,
    model: row.model,
    promptHash: row.prompt_hash,
    route: row.route as TraceRoute,
    turn: row.turn,
    contextChars: row.context_chars,
    budget: parseJson<TraceBudget>(row.budget_json, emptyBudget()),
    toolCalls: parseTraceArray<TraceToolCall>(row.tool_trace_json).map(safeToolCall),
    retrievalHits: parseJson<TraceRetrievalHit[]>(row.retrieval_hits_json, []),
    recordEvidence: parseJson<TraceRecordEvidence[]>(row.record_evidence_json, []),
    citationMap: parseJson<TraceCitationRef[]>(row.citation_map_json, []),
    claimChecks: parseJson<TraceClaimCheck[]>(row.claim_checks_json, []),
    quoteChecks:
      row.quote_checks_json === null
        ? null
        : parseJson<QuoteCheckSummary>(row.quote_checks_json, { checked: 0, passed: 0, failed: 0 }),
    plan: parseJson<TracePlan>(row.plan_json, { coverage: 'unknown', coverageRatio: 0, subgoals: [] }),
    rewriteRounds: row.rewrite_rounds,
    rewriteEvents: parseTraceArray<TraceRewriteEvent>(row.rewrite_events_json).map(safeRewriteEvent),
    followUpRewrite: rewrite === null ? null : safeFollowUp(rewrite),
    warnings: redactTraceMessages(row.warnings_json),
    errors: redactTraceMessages(row.errors_json),
    usageEvents: listUsageEventsOfRun(db, runId),
    recordedAt: row.recorded_at,
  };
}

/**
 * 这次运行的模型调用流水。
 *
 * 【为什么详情页要单独查 usage_events，而不是只用 Trace 里的预算】
 *   预算是"这次还用得起吗"的计数；流水是"钱具体花在第几次调用上"的账。
 *   两者通过 run_id 关联，正好在详情页并排给管理员看。
 */
function listUsageEventsOfRun(db: Db, runId: string): TraceUsageEvent[] {
  const rows = db
    .prepare(
      `SELECT event_id, model, purpose, input_tokens, output_tokens,
              cache_read, cache_creation, cost_usd, duration_ms, created_at
         FROM usage_events
        WHERE run_id = ?
        ORDER BY created_at, id`,
    )
    .all(runId) as unknown as {
    event_id: string;
    model: string;
    purpose: string;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read: number | null;
    cache_creation: number | null;
    cost_usd: number | null;
    duration_ms: number | null;
    created_at: string;
  }[];
  return rows.map((r) => ({
    eventId: r.event_id,
    model: r.model,
    purpose: r.purpose,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheRead: r.cache_read,
    cacheCreation: r.cache_creation,
    costUsd: r.cost_usd,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
  }));
}

/**
 * `JSON.parse`，但把损坏的列当作调用方给的兜底值处理。
 *
 * 【为什么不让它抛】Trace 是诊断数据，一条列的 JSON 被人手工改坏，不该让
 *   管理员连"这一行存在"都看不到。列表与详情仍然能显示元数据，坏掉的那一块
 *   显示为空 —— 比整页 500 更接近"如实反映现状"。
 */
function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function emptyBudget(): TraceBudget {
  return {
    limits: { maxQueryCalls: 0, maxToolCalls: 0, maxTokens: 0, maxWallMs: 0 },
    used: { queryCalls: 0, toolCalls: 0, tokens: 0, elapsedMs: 0 },
  };
}
