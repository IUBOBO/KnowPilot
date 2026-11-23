/**
 * 一次问答的**四维预算**：查询轮次 / 工具调用 / 总 Token / 单次总时长。
 *
 * 【为什么要有这个模块，而不是把四个 if 散在 `ask-run.ts` 里】
 *   改造前这四个维度只实现了两个半，而且是**混在一起**的：
 *     · 轮次 —— `ASK_MAX_TOOL_ROUNDS`，实现在 `beforeToolCall` 里；
 *     · 时间 —— `ASK_MAX_WALL_MS`，实现在一个 setTimeout 里；
 *     · 工具 —— 只有一句 `totalToolCalls >= ROUNDS + HARD_STOP_EXTRA_TURNS` 的兜底，
 *       数是"非提交类工具"，值是 12+3，**没有名字也不是一档独立预算**；
 *     · **Token —— 压根没有**。约束 5 写明 `token 200k` 是硬上限，但全仓没有任何
 *       累计或判定（`usage` 只被记录、从不被比较）。
 *   缺了 Token 那一维的后果不是报错，而是"某次问答把上游额度烧掉一大截"这件事
 *   既拦不住、也看不出来。把四维收进一个纯函数，才能对每一维单独构造用例断言它
 *   真的生效 —— 这也是 V3 的 T1 要求"独立核算"的落点。
 *
 * 【为什么返回"哪一维先到"而不是一个布尔】停下来的原因必须能如实回报：
 *   预算到顶后模型仍会交付答案（到上限不是失败），此时 `outcome` 是 `ok`，
 *   唯一能说明"这次是被预算掐住收尾的"就是 `stopReason`。返回维度名而不是 true，
 *   是为了让那条回报不需要在别处再猜一次。
 */
import { ASK_MAX_TOKENS, ASK_MAX_TOOL_CALLS, ASK_MAX_TOOL_ROUNDS, ASK_MAX_WALL_MS } from '@knowpilot/shared';

/** 四个维度，各自独立计数、各自独立到顶。 */
export const BUDGET_DIMENSIONS = ['rounds', 'toolCalls', 'tokens', 'wall'] as const;
export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

export interface BudgetLimits {
  /** 查询类工具（检索 / 台账 / 数据集 / 分区）的**成功调用**次数上限 */
  maxQueryCalls: number;
  /** **所有**工具调用尝试的上限（含提交答案、含被拦下的）—— 循环失控的兜底 */
  maxToolCalls: number;
  /** 累计 Token 上限（输入 + 输出 + 缓存读 + 缓存写） */
  maxTokens: number;
  /** 单次问答的总时长上限 */
  maxWallMs: number;
}

/** 一次运行的四维实际用量。四个都记，报告里能直接看出是哪一维顶到了天花板。 */
export interface BudgetUsage {
  queryCalls: number;
  toolCalls: number;
  tokens: number;
  elapsedMs: number;
}

/** 生产默认值。取值来自 04 号阶段 7 与约束 5（轮次 12 / 工具 15 / token 200k / 5 分钟）。 */
export function defaultBudgetLimits(): BudgetLimits {
  return {
    maxQueryCalls: ASK_MAX_TOOL_ROUNDS,
    maxToolCalls: ASK_MAX_TOOL_CALLS,
    maxTokens: ASK_MAX_TOKENS,
    maxWallMs: ASK_MAX_WALL_MS,
  };
}

/**
 * 判定"哪一维到顶了"。
 *
 * 判定顺序固定（rounds → toolCalls → tokens → wall），为的是同一份用量每次都
 * 报出同一维 —— 否则两维同时越线时，报告里的原因会随实现顺序漂移。
 * 调用方负责在同一位置以同样的顺序检查，这样"拦下的原因"与"复盘的原因"一致。
 */
export function exhaustedDimension(limits: BudgetLimits, used: BudgetUsage): BudgetDimension | null {
  if (used.queryCalls >= limits.maxQueryCalls) return 'rounds';
  if (used.toolCalls >= limits.maxToolCalls) return 'toolCalls';
  if (used.tokens >= limits.maxTokens) return 'tokens';
  if (used.elapsedMs >= limits.maxWallMs) return 'wall';
  return null;
}

/**
 * 每一维到顶时给模型看的一句话。
 *
 * 【为什么这句话必须点明是哪一维】模型读到之后要做的动作是一样的（别再查了、
 *   用手上的证据作答），但**人**读 Trace 时要靠它区分"检索次数用完了"还是
 *   "这次问答太长了"。把成因混成一句"已达上限"，复盘时就得回去数数。
 */
export function budgetReason(dim: BudgetDimension, limits: BudgetLimits): string {
  switch (dim) {
    case 'rounds':
      return `已达本次问答的查询次数上限（${limits.maxQueryCalls} 次）。`;
    case 'toolCalls':
      return `已达本次问答的工具调用总量上限（${limits.maxToolCalls} 次）。`;
    case 'tokens':
      return `已达本次问答的 Token 预算上限（${limits.maxTokens}）。`;
    case 'wall':
      return `已达本次问答的时间上限（${Math.round(limits.maxWallMs / 60000)} 分钟）。`;
  }
}

/** 拼给模型看的完整提示：成因 + 该怎么做。四维共用同一句"接下来怎么办"。 */
export function budgetBlockMessage(dim: BudgetDimension, limits: BudgetLimits): string {
  return (
    `${budgetReason(dim, limits)}不要再查了，请基于已经拿到的证据作答；` +
    `确实没有依据的部分写进 evidence_gaps。`
  );
}

/** 维度 → `stopReason` 词表（终态回报用）。 */
export const STOP_REASON_OF_DIMENSION: Record<BudgetDimension, AskStopReason> = {
  rounds: 'rounds',
  toolCalls: 'tool_calls',
  tokens: 'tokens',
  wall: 'wall',
};

/**
 * 一次运行的**终态成因**。
 *
 * 【为什么它与 `AskOutcome` 是两个字段，不能合并】
 *   `outcome` 是**业务口径**（这次问答算成功还是失败），`stopReason` 是**诊断口径**
 *   （它为什么停下来）。两者不是一对一：预算掐住之后模型仍然交付了答案，
 *   那次 `outcome` 是 `ok`、`stopReason` 却是 `rounds` —— 合并成一个字段就必须
 *   在"成功但被截断"和"成功"之间二选一，而这两件事的排查价值完全不同。
 */
export const ASK_STOP_REASONS = [
  'completed',
  'rounds',
  'tool_calls',
  'tokens',
  'wall',
  'client_aborted',
  'model_error',
  'exception',
] as const;
export type AskStopReason = (typeof ASK_STOP_REASONS)[number];
