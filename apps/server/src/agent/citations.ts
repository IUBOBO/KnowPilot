/**
 * 引用校验：设计文档 02 §6.1 四项确定性检查里最核心的两项。
 *
 * 【为什么必须是确定性检查，不能交给模型自评】
 *   问模型"你的引用都对吗"，它几乎总是回答"都对"。而引用出错的形态
 *   （编一个不存在的编号）恰好是纯字符串比对就能 100% 抓住的。
 *   能用代码判定的事情交给模型，等于把一道送分题变成一道概率题。
 *
 * 【为什么每一条检查都要产出 warnings 而不是静默处理】
 *   校验不通过说明模型偏离了约定，这次回答的可信度已经下降。
 *   静默剔除坏引用会让回答"看起来正常"，而用户失去的恰恰是判断依据。
 */
import {
  extractEvidenceIds,
  removeEvidenceMarkers,
  type Citation,
  type QuoteCheckSummary,
} from '@knowpilot/shared';
import { renderRecordBody, type Evidence } from './evidence.ts';
import { MIN_QUOTE_CHARS, NO_EVIDENCE_PHRASE } from './prompt.ts';

export interface VerifiedAnswer {
  /** 剔除无效引用标记后的正文 */
  answer: string;
  /** 正文真正引用到的证据，按首次出现顺序 */
  citations: Citation[];
  warnings: string[];
  /** O2 引用片段校验的计数。没有要求校验时三项均为 0。 */
  quoteChecks: QuoteCheckSummary;
  /** 因摘录校验不通过而从正文剔除的证据号；用于标注连带的 Claim 告警。 */
  removedQuoteIds: readonly string[];
}

/** 模型提供的一条摘录。结构上兼容 `SubmittedQuote`，但不 import 工具层。 */
export interface QuoteInput {
  evidenceId: string;
  quote: string;
}

export interface VerifyAnswerOptions {
  /** 模型在 `submit_answer.quotes` 里给出的逐条摘录。 */
  quotes?: readonly QuoteInput[];
  /**
   * true = 正文里的**文档**引用必须有可核对的摘录，缺了或对不上就剔除。
   *
   * 【为什么不是永远开启】模型偶尔不调 `submit_answer`、直接把答案写在回复里
   *   （回落路径）；那时的正文没有结构化的摘录可校验。把回落路径也强制开启，
   *   会让每一次"模型没按约定输出"都变成"所有引用被清空"，把内容也一起丢掉。
   *   回落路径已经有一条更重的告警（"没有调用 submit_answer"），这里不再叠加。
   */
  requireQuotes?: boolean;
}

/** 空白容忍：只比较非空白字符。中文资料里换行/缩进差异不该判成"改字"。 */
function squashWhitespace(text: string): string {
  return text.replace(/\s+/gu, '');
}

/**
 * 一段摘录是否逐字出现在证据原文里。
 *
 * 【为什么只容忍空白，不容忍标点或全半角】"允许空白差异，但不允许改字"是 O2
 *   的验收口径。把全角句号折成半角、把"50%"折成"50 %"都会让"摘录是否真来自原文"
 *   变成一个需要解释的判断；空白是唯一一种不影响语义、且模型最容易因排版产生的差异。
 *
 * 【为什么有最短长度】一个字的摘录（"。"）在任何证据里都能找到，校验会退化成
 *   必然通过。`MIN_QUOTE_CHARS` 与提示词里的数字同源，改一处必须一起改。
 */
export function quoteMatchesEvidence(quote: string, evidenceText: string): boolean {
  const q = squashWhitespace(quote);
  if (q.length < MIN_QUOTE_CHARS) return false;
  return squashWhitespace(evidenceText).includes(q);
}

/** 提交前只检查正文实际引用的文档；记录类证据由服务端生成，不要求模型摘录。 */
export function findQuoteIssues(
  text: string,
  pool: ReadonlyMap<string, Evidence>,
  quotes: readonly QuoteInput[],
): { evidenceId: string; reason: 'missing' | 'mismatch' }[] {
  const issues: { evidenceId: string; reason: 'missing' | 'mismatch' }[] = [];
  for (const id of extractEvidenceIds(text)) {
    const ev = pool.get(id);
    if (ev?.kind !== 'document') continue;
    const candidates = quotes.filter((q) => q.evidenceId === id);
    if (candidates.some((q) => quoteMatchesEvidence(q.quote, ev.text))) continue;
    issues.push({ evidenceId: id, reason: candidates.length === 0 ? 'missing' : 'mismatch' });
  }
  return issues;
}

/**
 * 检出「模型编造出处」时，`warnings` 里必然含有的短串。
 *
 * 【为什么提成常量、而不是评分器再抄一遍这句中文】
 *   阶段 7 的确定性评分器（`eval/scorer.ts` 的 `no-dangling-marker`）要判"这次回答
 *   有没有编造引用"。可用的信号只有 `verifyAnswer` 产出的那条警告 —— 正文里的坏标记
 *   在这里已经被剔干净了，事后从正文上根本看不出来。若评分器自己再写一份中文去匹配，
 *   两边早晚分叉；而分叉的表现是"幻觉引用再也测不出来"（静默全绿），正是评测最该防的腐化。
 *   与 `NO_EVIDENCE_PHRASE` / `UNVERIFIED_WEB_LABEL` 同一条理由：同一串字只留一处。
 */
export const FABRICATED_EVIDENCE_MARK = '不存在的证据';

/**
 * 把证据组装成对外的引用。
 *
 * 两类证据的字段交集很小（只有 id 与摘录），所以这里是一次显式的分支，
 * 而不是"把公共字段抄一遍再补各自的" —— 后者每加一类来源就要再抄一遍，
 * 而漏抄的字段在类型上往往看不出来。
 */
function toCitation(ev: Evidence, verifiedQuote?: string): Citation {
  if (ev.kind === 'record') {
    return {
      id: ev.id,
      sourceType: 'record',
      recordType: ev.recordType,
      recordId: ev.recordId,
      recordTitle: ev.recordTitle,
      queryTime: ev.queryTime,
      recordUpdatedAt: ev.recordUpdatedAt,
      ...(ev.version !== undefined ? { version: ev.version } : {}),
      fields: ev.fields,
      // 摘录是给用户核对的完整字段文本；模型可能只看到其中一段（渲染窗口会标出）。
      excerpt: renderRecordBody(ev.fields),
      originalChars: ev.originalChars,
      sourceVersion: ev.sourceVersion,
    };
  }
  return {
    id: ev.id,
    sourceType: 'document',
    documentId: ev.documentId,
    documentTitle: ev.documentTitle,
    material: ev.material,
    page: ev.page,
    sectionPath: ev.sectionPath,
    chunkId: ev.chunkId,
    excerpt: ev.text,
    originalChars: ev.originalChars,
    sourceVersion: ev.sourceVersion,
    score: ev.score,
    ...(ev.matchedBy !== undefined ? { matchedBy: ev.matchedBy } : {}),
    ...(verifiedQuote !== undefined && verifiedQuote !== '' ? { quote: verifiedQuote } : {}),
  };
}

/**
 * 校验正文里的引用，并组装引用列表。
 *
 * @param text 模型写的正文
 * @param pool 证据号 → 证据。只有这轮真的检索到的块才在里面。
 */
export function verifyAnswer(
  text: string,
  pool: ReadonlyMap<string, Evidence>,
  opts: VerifyAnswerOptions = {},
): VerifiedAnswer {
  const warnings: string[] = [];
  const mentioned = extractEvidenceIds(text);

  const unknown = mentioned.filter((id) => !pool.has(id));
  const known = mentioned.filter((id) => pool.has(id));

  const quoteChecks: QuoteCheckSummary = { checked: 0, passed: 0, failed: 0 };
  const verifiedQuoteById = new Map<string, string>();

  // O2：先核摘录，再组装引用。顺序不能反 —— 摘录不通过的引用必须连同正文标记
  // 一起剔除，否则会出现"引用列表里没有 E3、正文里却还写着 [E3]"的悬空标记。
  const invalidQuoteIds = new Set<string>();
  if (opts.requireQuotes === true) {
    const quotesById = new Map<string, string[]>();
    for (const q of opts.quotes ?? []) {
      const list = quotesById.get(q.evidenceId) ?? [];
      list.push(q.quote);
      quotesById.set(q.evidenceId, list);
    }

    for (const id of known) {
      const ev = pool.get(id);
      // 台账 / 数据集 / 分区由服务端填内容，只核对编号 —— 与 O2 规格一致。
      if (ev === undefined || ev.kind !== 'document') continue;
      quoteChecks.checked += 1;
      const candidates = quotesById.get(id) ?? [];
      const matched = candidates.find((q) => quoteMatchesEvidence(q, ev.text));
      if (matched !== undefined) {
        quoteChecks.passed += 1;
        verifiedQuoteById.set(id, matched);
      } else {
        quoteChecks.failed += 1;
        invalidQuoteIds.add(id);
      }
    }
  }

  const removedIds = new Set<string>([...unknown, ...invalidQuoteIds]);
  const { text: cleaned, removed } = removeEvidenceMarkers(text, removedIds);
  if (removed.length > 0) {
    const fabricated = removed.filter((id) => unknown.includes(id));
    const badQuote = removed.filter((id) => invalidQuoteIds.has(id));
    if (fabricated.length > 0) {
      warnings.push(
        `正文引用了${FABRICATED_EVIDENCE_MARK} ${fabricated.map((id) => `[${id}]`).join('、')}，已剔除。` +
          `这说明模型编造了出处，本次回答的其它部分也应人工核对。`,
      );
    }
    for (const id of badQuote) {
      const index = mentioned.indexOf(id) + 1;
      const hadQuote = (opts.quotes ?? []).some((q) => q.evidenceId === id);
      warnings.push(
        hadQuote
          ? `第 ${index} 条引用（[${id}]）的摘录与原文不符：不是所引证据原文的逐字片段，已剔除该引用。`
          : `第 ${index} 条引用（[${id}]）没有提供可核对的摘录（须从原文逐字摘录至少 ${MIN_QUOTE_CHARS} 个字），已剔除该引用。`,
      );
    }
  }

  const citations: Citation[] = [];
  for (const id of known) {
    if (invalidQuoteIds.has(id)) continue;
    const ev = pool.get(id);
    if (ev !== undefined) citations.push(toCitation(ev, verifiedQuoteById.get(id)));
  }

  // GC-08：一个有效引用都没有时，正文必须明确说"未找到依据"。
  // 允许它为空引用的前提是"它承认没有依据"；不承认又没有引用，
  // 就是一次无出处的断言 —— 这正是本系统最不能容忍的形态。
  if (citations.length === 0 && !cleaned.includes(NO_EVIDENCE_PHRASE)) {
    warnings.push(
      `回答里没有任何可核对的引用，正文里也没出现「${NO_EVIDENCE_PHRASE}」。` +
        `这可能是一次没有出处的断言，请核对后再采用。`,
    );
  }

  return { answer: cleaned, citations, warnings, quoteChecks, removedQuoteIds: [...invalidQuoteIds] };
}

/**
 * 从自由文本里抽「依据缺口：」那一行。
 *
 * 只作为**回落路径**使用：模型按约定调用 submit_answer 时根本不会走到这里。
 * 之所以还要留：模型偶尔会无视工具约定、直接把答案写在回复正文里。
 * 那种情况下宁可少一点结构化信息也要把内容交出来，但同时必须
 * 在 limits 里说明"这次没按结构化格式输出" —— 不能让回落路径悄悄变成常态。
 */
export function extractEvidenceGapLine(text: string): { text: string; gaps: string[] } {
  const lines = text.split('\n');
  const kept: string[] = [];
  const gaps: string[] = [];

  for (const line of lines) {
    const match = /^\s*依据缺口\s*[:：]\s*(.*)$/u.exec(line);
    if (match === null) {
      kept.push(line);
      continue;
    }
    const value = (match[1] ?? '').trim();
    if (value !== '' && value !== '无' && value !== '无。') gaps.push(value);
  }

  return { text: kept.join('\n').trim(), gaps };
}
