/**
 * 上下文预算与证据窗口选择（V3 工作包 S4 / C1+X2a）。
 *
 * 【它解决的不是"怎么切块"，而是"这次让模型看哪几段"】
 *   EvidencePool 里始终保存**完整原文**；截断只发生在"渲染给模型"这一步。
 *   旧实现是每条证据固定取前 2000 字，而且不告诉模型"后面还有"。长证据里
 *   的限制条款、例外、版本条件可能正好落在后面，模型却会以为自己在看全文。
 *
 * 【这一版的策略】
 *   1. 正常情况下（总长度 ≤ 本次预算）**原样全给**，不改变顺序、不做"聪明"的筛选；
 *   2. 超出预算时：
 *      · 先按原文去重（同一段文字只出现一次）；
 *      · 按来源 round-robin，保证每份文档/记录至少有一条先进入，再考虑同来源的第二条；
 *      · 每条证据按**查询词命中的句子**选窗口，而不是无脑取前 N 字；
 *   3. 窗口的 `start/end/isTruncated` 随渲染一起交给模型，模型不能把窗口当全文。
 *
 * 【为什么用字符数当预算，而不是 tokenizer】
 *   本项目的中文语料里 1 个汉字约等于 1 个 token，用字符数是**保守的近似**；
 *   真正的 token 硬上限仍由 T1 的四维预算（`ASK_MAX_TOKENS=200k`）兜底。
 *   这里的 60k 字符/run 是给"证据展示"留的可见预算，不替代 token 账本。
 *
 * 【为什么不做按需回读工具】
 *   X2b 才做 `get_evidence_span`；本轮先把"模型看到了哪一段"说清楚，
 *   不增加新的工具调用面，也不让模型自己扩大上下文。
 */
import type { EvidenceWindow } from './evidence.ts';
import { claimTerms, splitSentences } from './claim-verifier.ts';

/** 单条证据最多展示多少字符。 */
export const MAX_EVIDENCE_WINDOW_CHARS = 2000;

/** 单次检索最多展示多少字符（不是模型上下文的全部，只是这一次工具结果）。 */
export const MAX_RETRIEVAL_CONTEXT_CHARS = 8000;

/** 一次 run 的所有检索工具结果合起来最多展示多少字符。 */
export const MAX_RUN_CONTEXT_CHARS = 60000;

/** 低于这个长度就不值得展示一条证据（切碎后只剩几个字没有核对价值）。 */
const MIN_EVIDENCE_WINDOW_CHARS = 200;

/**
 * 一次 run 的可见证据预算。
 *
 * 它只数"渲染给模型的证据字符"，不数系统提示词、历史消息和模型输出 ——
 * 那些由 T1 的 token 预算负责。两者是互补的：这里防"检索上下文无限膨胀"，
 * T1 防"整次模型调用把额度烧光"。
 */
export class EvidenceContextBudget {
  private used = 0;

  constructor(readonly maxChars: number = MAX_RUN_CONTEXT_CHARS) {}

  get remaining(): number {
    return Math.max(0, this.maxChars - this.used);
  }

  get usedChars(): number {
    return this.used;
  }

  /** 申请一段预算，返回实际可用字符数；到上限后返回 0 而不是负数。 */
  take(max: number): number {
    const granted = Math.min(this.remaining, Math.max(0, Math.trunc(max)));
    this.used += granted;
    return granted;
  }
}

/** 进入预算器的候选：一段原文 + 它属于哪个来源。 */
export interface ContextCandidate {
  /** 来源身份（文档 id / 记录类型:id）；用于来源多样性排序 */
  sourceKey: string;
  text: string;
}

export interface SelectedContextWindow {
  /** 在输入 candidates 里的下标 */
  index: number;
  window: EvidenceWindow;
}

function makeWindow(text: string, start: number, end: number): EvidenceWindow {
  return {
    start,
    end,
    text: text.slice(start, end),
    originalChars: text.length,
    isTruncated: start > 0 || end < text.length,
  };
}

/**
 * 选一个最多 `maxChars` 的窗口，优先覆盖查询词命中的句子。
 *
 * 没有命中时退回开头；这不比旧行为差，只是不再"永远只看开头"。
 * 窗口尽量把命中的整句包进去；如果整句比预算还长，就从该句开头截。
 */
export function chooseEvidenceWindow(
  text: string,
  query: string,
  maxChars: number = MAX_EVIDENCE_WINDOW_CHARS,
): EvidenceWindow {
  const budget = Math.max(1, Math.trunc(maxChars));
  if (text.length <= budget) return makeWindow(text, 0, text.length);

  const queryTerms = new Set(claimTerms(query));
  let best: { start: number; end: number; score: number } | null = null;
  for (const sentence of splitSentences(text)) {
    const sentenceTerms = new Set(claimTerms(sentence.text));
    let hits = 0;
    for (const term of queryTerms) if (sentenceTerms.has(term)) hits += 1;
    const score = queryTerms.size === 0 ? 0 : hits / queryTerms.size;
    if (best === null || score > best.score) {
      best = { start: sentence.start, end: sentence.end, score };
    }
  }

  if (best === null || best.score === 0) return makeWindow(text, 0, budget);

  // 给命中句留前后各约 15% 的上下文；再按预算夹紧。
  const context = Math.floor(budget * 0.15);
  let start = Math.max(0, best.start - context);
  let end = Math.min(text.length, start + budget);
  if (end < best.end) {
    // 命中的句子被右边界切掉了：把它整体挪进来（句子比预算长时从句子开头截）。
    start = Math.max(0, Math.min(best.start, text.length - budget));
    end = Math.min(text.length, start + budget);
    if (end < best.end && best.start + budget <= text.length) {
      start = best.start;
      end = start + budget;
    }
  }
  return makeWindow(text, start, end);
}

/**
 * 在预算内选择本次要给模型的证据窗口。
 *
 * 正常情况（全部原文放得下）保持输入顺序；超预算时才启用去重/来源多样性。
 * 返回值带原下标，调用方据此把选中的候选加入 EvidencePool，**未选中的不加入** ——
 * 这样 Trace 里的 `retrievalHits` 就是"模型真正看到过的证据"，不会出现
 * "评测以为召回了、模型其实没看到"的假阳性。
 */
export function selectContextWindows(
  candidates: readonly ContextCandidate[],
  query: string,
  budgetChars: number,
): SelectedContextWindow[] {
  const budget = Math.max(0, Math.trunc(budgetChars));
  if (budget === 0) return [];

  // 原文完全相同的候选只留一个（不同文档碰巧同文也算同一段内容）。
  const deduped: { candidate: ContextCandidate; index: number }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (candidate === undefined || candidate.text.trim() === '') continue;
    const key = candidate.text.replace(/\s+/gu, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ candidate, index: i });
  }

  const total = deduped.reduce((n, c) => n + c.candidate.text.length, 0);
  if (total <= budget) {
    // 放得下就原样给，不做任何重排 —— 正常问答的行为与改造前完全一致。
    return deduped.map((c) => ({
      index: c.index,
      window: makeWindow(c.candidate.text, 0, c.candidate.text.length),
    }));
  }

  // 超预算：按来源 round-robin，先让每份来源都有一条，再轮到第二、第三条。
  const groups = new Map<string, { candidate: ContextCandidate; index: number }[]>();
  for (const item of deduped) {
    const list = groups.get(item.candidate.sourceKey) ?? [];
    list.push(item);
    groups.set(item.candidate.sourceKey, list);
  }
  const order: { candidate: ContextCandidate; index: number }[] = [];
  const maxGroup = Math.max(0, ...[...groups.values()].map((g) => g.length));
  for (let depth = 0; depth < maxGroup; depth += 1) {
    for (const group of groups.values()) {
      const item = group[depth];
      if (item !== undefined) order.push(item);
    }
  }

  const selected: SelectedContextWindow[] = [];
  let remaining = budget;
  for (let i = 0; i < order.length; i += 1) {
    const item = order[i];
    if (item === undefined) continue;
    const remainingCount = order.length - i;
    const allowance = Math.min(
      MAX_EVIDENCE_WINDOW_CHARS,
      Math.max(MIN_EVIDENCE_WINDOW_CHARS, Math.floor(remaining / Math.max(1, remainingCount))),
    );
    if (remaining < MIN_EVIDENCE_WINDOW_CHARS) break;
    const window = chooseEvidenceWindow(item.candidate.text, query, Math.min(allowance, remaining));
    if (window.text === '') continue;
    selected.push({ index: item.index, window });
    remaining -= window.text.length;
    if (remaining <= 0) break;
  }
  return selected;
}
