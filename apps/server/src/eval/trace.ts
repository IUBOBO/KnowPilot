/**
 * 评测用的 Trace 组装（03 号 §5）。
 *
 * 【为什么是"运行方交事实、这里组装"，不是这里自己去跑一次】
 *   `Trace` 里有三个量事后**复原不出来**：整个证据池（召回全貌）、工具调用轨迹、
 *   以及"当时那段拼好的 system prompt"的哈希。它们只存在于一次运行的过程中。
 *   所以由 `runAsk` 在结束时通过 `hooks.onFinalize` 把 `AskFinalization` 交出来，
 *   这一层只负责把它 + 评测侧的上下文（用例号、数据快照）拼成 `Trace`。
 *   好处是这一层是**纯函数**，可以拿手造的事实零成本地测（见 eval-check.ts）。
 *
 * 【2026-10-16 起：失败的那几条也进 Trace】`onFinalize` 五条终态**全都回调**，
 *   于是 Trace 不再只有成功那几次。K-09 点名的正是这件事：超时 / 中止 / 模型报错
 *   那几条缺 `retrievalHits` 与 `usage`，就无法判断失败发生在检索、模型还是回写。
 *
 * 【Trace 里刻意不记的东西（03 号 §5）】
 *   不记回答正文、不记引用摘录、不采集思维链。理由与 `ask_records` 只存元数据同源：
 *   正文与摘录都是从上传文档里摘的原文，未发表内容不该被复制进第二个留存载体。
 *   要回原文，靠 `retrievalHits` / `citationMap` 里的 `chunkId` 回读 —— 那是能回到
 *   事实来源的指针，本身不含内容。
 */
import type { AskFinalization } from '../agent/ask-run.ts';
import type { Trace } from './types.ts';

/** 组装 Trace 时由评测侧补上的上下文（运行方不知道"这是哪条用例"）。 */
export interface TraceContext {
  caseId: string;
  /** 数据快照摘要。同用例集版本 + 同数据快照 + 同环境 = 可比条件（03 号 §4）。 */
  dataSnapshot: string;
}

/** 把一次运行的**终态事实**组装成一条 `Trace`。纯函数。 */
export function buildTrace(facts: AskFinalization, ctx: TraceContext): Trace {
  return {
    runId: facts.runId,
    caseId: ctx.caseId,
    model: facts.model,
    promptHash: facts.promptHash,
    dataSnapshot: ctx.dataSnapshot,
    toolCalls: facts.toolCalls,
    retrievalHits: facts.retrievalHits,
    recordEvidence: facts.recordEvidence,
    citationMap: facts.citationMap,
    usage: facts.usage,
    warnings: facts.warnings,
    errors: facts.errors,
    outcome: facts.outcome,
    deliveryStatus: facts.deliveryStatus,
    claimChecks: facts.claimChecks,
    route: facts.route,
    plan: facts.plan,
    rewriteRounds: facts.rewriteRounds,
    rewriteEvents: facts.rewriteEvents,
    ...(facts.followUpRewrite !== undefined ? { followUpRewrite: facts.followUpRewrite } : {}),
    turn: facts.turn,
    stopReason: facts.stopReason,
    lastStage: facts.lastStage,
    evidenceCount: facts.evidenceCount,
    contextChars: facts.contextChars,
    budget: facts.budget,
    durationMs: facts.durationMs,
  };
}
