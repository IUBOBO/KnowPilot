/**
 * 管理端运行 Trace 的契约（O7）。
 *
 * 【这里为什么没有回答正文与证据摘录】一次运行能复盘的东西很多，但**内容**
 *   不属于 Trace：回答正文、引用摘录、证据原文都可能来自未发表材料（迁移 v6
 *   与 v20 同一条口径）。这里只放复现"过程"需要的元数据：工具调用了哪几次、
 *   查了什么词、命中几条、预算用掉多少、哪些 Claim 没通过、证据的 **id 与分数**。
 *   要看原文时仍走既有的"查看原文"接口，由那一路自己再做一次权限校验 ——
 *   Trace 不复制正文，也就不存在"从 Trace 绕过权限读原文"这条路。
 */
import type { AskOutcome, ClaimVerdict, FollowUpRewrite, QuoteCheckSummary } from './answer.ts';

/** 诊断口径的停止原因。取值与 `agent/budget.ts` 的 `ASK_STOP_REASONS` 一致。 */
export type TraceStopReason =
  | 'completed'
  | 'rounds'
  | 'tool_calls'
  | 'tokens'
  | 'wall'
  | 'client_aborted'
  | 'model_error'
  | 'exception';

/** 停止时走到哪一步。与 `ask-run.ts` 的 `ASK_LAST_STAGES` 一致。 */
export type TraceLastStage = 'startup' | 'retrieval' | 'generation' | 'assembly';

/** 交付状态。`failed` 只出现在 Trace 里（shared 的交付状态没有失败档）。 */
export type TraceDeliveryStatus = 'verified' | 'partial' | 'interrupted' | 'failed';

/** 任务路由。 */
export type TraceRoute = 'simple' | 'multi_source' | 'state_lookup';

/** 四维预算的额度。字段与 `agent/budget.ts` 的 `BudgetLimits` 一致。 */
export interface TraceBudgetLimits {
  maxQueryCalls: number;
  maxToolCalls: number;
  maxTokens: number;
  maxWallMs: number;
}

/** 四维预算的实际用量。 */
export interface TraceBudgetUsage {
  queryCalls: number;
  toolCalls: number;
  tokens: number;
  elapsedMs: number;
}

export interface TraceBudget {
  limits: TraceBudgetLimits;
  used: TraceBudgetUsage;
}

/**
 * 一次工具调用。
 *
 * `atMs` 是从这次运行开始到**调用结束**的毫秒偏移。单独给偏移而不是绝对时间：
 * 页面要按时间顺序排、也要显示"第几秒做的"，而绝对时间还得再减一次运行起点。
 */
export interface TraceToolCall {
  name: string;
  /** 查询类工具归一后的查询词；提交答案这类工具没有 */
  query: string | null;
  /** 检索/台账等返回的命中条数；取不到为 null（不填 0 冒充"零命中"） */
  hitCount: number | null;
  ms: number;
  isError: boolean;
  atMs: number;
}

/** 计划摘要。**不含子问题原文**：只有 id、类型、覆盖状态与证据数。 */
export interface TracePlan {
  coverage: string;
  coverageRatio: number;
  subgoals: readonly {
    id: string;
    kind: string;
    status: 'covered' | 'missing';
    evidenceCount: number;
  }[];
}

/** 检索改写事件。查询词是检索用的短语，不是证据原文。 */
export interface TraceRewriteEvent {
  round: number;
  gapReason: string;
  missingSubgoalIds: readonly string[];
  queries: readonly { text: string; subgoalId: string }[];
  evidenceIdsAdded: readonly string[];
  coverageBefore: string;
  coverageAfter: string;
  stoppedReason: string;
}

/** 检索到的文档块。只给 id、分数、名次 —— 正文要回原文接口取。 */
export interface TraceRetrievalHit {
  chunkId: string;
  score: number;
  rank: number;
}

/** 进过证据池的记录（台账 / 数据集 / 分区）。 */
export interface TraceRecordEvidence {
  recordType: string;
  recordId: string;
}

/** 正文实际引用到的证据。 */
export interface TraceCitationRef {
  id: string;
  chunkId: string | null;
  recordId: string | null;
  /** 仅用于复核时按原版本回读台账记录。 */
  sourceVersion?: string;
}

/** Claim 级校验摘要。**不含 Claim 正文**。 */
export interface TraceClaimCheck {
  claimId: string;
  verdict: ClaimVerdict;
  evidenceIds: readonly string[];
  spanEvidenceIds: readonly string[];
}

/** 列表里的一行。 */
export interface AdminTraceListItem {
  runId: string;
  /** 运行开始时刻（与 ask_records.asked_at 同源） */
  askedAt: string;
  /** 提问人；null = 未记录归属（阶段 1–3 的公共历史，或未登录入口） */
  userId: string | null;
  asker: string | null;
  /** 问题原文。来自 `ask_records` 的 JOIN；原始记录缺失时为 null */
  question: string | null;
  outcome: AskOutcome;
  stopReason: TraceStopReason;
  deliveryStatus: TraceDeliveryStatus;
  durationMs: number;
  evidenceCount: number;
}

/** 筛选下拉里的一项。 */
export interface TraceUserFacet {
  userId: string | null;
  label: string;
  count: number;
}

export interface TraceOutcomeCount {
  outcome: AskOutcome;
  count: number;
}

export interface ListAdminTracesResponse {
  items: readonly AdminTraceListItem[];
  /** 有 Trace 的用户（含未归属桶），按条数倒序 */
  users: readonly TraceUserFacet[];
  /** 全量计数，不随筛选变化（筛选按钮上要写"异常 3"） */
  counts: {
    all: number;
    byOutcome: readonly TraceOutcomeCount[];
  };
}

/** 一次模型调用流水（来自 `usage_events`，不是 Trace 表自己的行）。 */
export interface TraceUsageEvent {
  eventId: string;
  model: string;
  purpose: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
  costUsd: number | null;
  durationMs: number | null;
  createdAt: string;
}

/** 详情页。 */
export interface AdminTraceDetail extends AdminTraceListItem {
  lastStage: TraceLastStage;
  model: string;
  promptHash: string;
  route: TraceRoute;
  turn: number;
  contextChars: number;
  budget: TraceBudget;
  toolCalls: readonly TraceToolCall[];
  retrievalHits: readonly TraceRetrievalHit[];
  recordEvidence: readonly TraceRecordEvidence[];
  citationMap: readonly TraceCitationRef[];
  claimChecks: readonly TraceClaimCheck[];
  /** null = 本次走的是自由文本回落路径，没有摘录可核（不是"全部通过"） */
  quoteChecks: QuoteCheckSummary | null;
  plan: TracePlan;
  rewriteRounds: number;
  rewriteEvents: readonly TraceRewriteEvent[];
  followUpRewrite: FollowUpRewrite | null;
  warnings: readonly string[];
  errors: readonly string[];
  usageEvents: readonly TraceUsageEvent[];
  /** Trace 行的写入时刻。与 askedAt 不同：前者是落库时间，后者是运行开始时间 */
  recordedAt: string;
}
