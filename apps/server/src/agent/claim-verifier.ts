/**
 * Claim→Evidence 支持性校验（V3 工作包 S3 / V1+V2）。
 *
 * 【它修的到底是什么】
 *   在它之前，`[E1]` 只证明"E1 这个编号真实存在"；它**不证明** E1 里的原文
 *   支持正文那句话。一句"所有论文查重率都低于 10% [E1]"可以拿到完全合法的
 *   引用编号，而 E1 里可能写着"博士 < 10%、硕士 < 15%" —— 编号对了，结论错了。
 *
 * 【为什么这一版只有规则层，没有模型 Judge】
 *   模型判"这段原文是否支持这句话"是一个概率判断，必须先有**人工标注的校准集**
 *   才能谈误杀率。本项目目前没有这份标注，硬上一个未校准的 Judge 只会把
 *   "看起来像通过"换成"模型说通过"，反而更难审计。所以这一版：
 *     · 能确定性判的（缺引用、假引用、数值不在原文、同指标数值不一致）→ 直接判；
 *     · 语义上可能成立但规则确认不了的 → `review_required`（**不是通过**）；
 *     · `reviewer` 永远写 `rule`，不伪装成模型或人工已经确认。
 *   模型 Judge 留到有校准集时再加，接口已经预留 `reviewer: 'model'`。
 *
 * 【规则层的四条判据，全部可复现】
 *   1. 没有引用标记 → insufficient；
 *   2. 引用的证据不在本轮证据池 → insufficient（假编号更早被 verifyAnswer 剔除）；
 *   3. 结论里的数值在所引证据中找不到 → insufficient；
 *   4. 同一指标（数值前面那段中文）在原文里对应的是另一个数值 → contradicted；
 *   5. 其余按词面覆盖率分档：≥ 0.5 才有资格 supported；0.25–0.5 review_required；
 *      < 0.25 insufficient。含全称/范围表述（所有、全部、仅、只…）而原文没有
 *      同样表述时，即使覆盖率高也降为 review_required —— 这是"过度泛化"的主要形态。
 *
 * 【为什么 span 要带 start/end】
 *   只给一句"支持"没有用，评审者要能打开原文确认。start/end 是证据文本里的
 *   字符偏移，`quote` 是那段原文本身；引用卡片再用 evidenceId 回读完整块。
 */
import {
  evidenceMarker,
  readAnswerTable,
  type ClaimCheck,
  type ClaimEvidenceSpan,
  type ClaimVerdict,
  type ClaimVerification,
  type ClaimVerificationStatus,
} from '@knowpilot/shared';
import { renderRecordBody, type Evidence } from './evidence.ts';
import { NO_EVIDENCE_PHRASE } from './prompt.ts';

/**
 * 词面覆盖率：达到它才允许规则层判 supported。
 *
 * 0.45 是在本文件的校准样例上取的：0.5 时"可作对照"这类换了说法的同义句
 * 会被误判成待核对（实测 47%）。**这不是准确率**，只是规则层的保守阈值；
 * 换语料/换模型后必须重新看校准表，不能沿用数字。
 */
const SUPPORT_OVERLAP = 0.45;

/** 覆盖率在它以上、SUPPORT_OVERLAP 以下：不能判支持，但也可能是换了个说法。 */
const REVIEW_OVERLAP = 0.25;

/** span 的展示片段上限。完整原文由引用卡片按 evidenceId 回读。 */
const MAX_QUOTE_CHARS = 240;

const SENTENCE_END = new Set(['。', '！', '？', '；', ';', '!', '?']);

export interface SentenceSpan {
  text: string;
  /** 在原文里的起止（end 不含）；text 已去掉首尾空白 */
  start: number;
  end: number;
}

/**
 * 把一段文字切成句子并保留原文偏移。换行单独算句末，不把换行字符带进句子。
 *
 * 导出给上下文预算器复用：两者对"句子边界"必须用同一套判据，
 * 否则窗口选择和 Claim 校验会对同一段原文切出不同的句子。
 */
export function splitSentences(text: string): SentenceSpan[] {
  const out: SentenceSpan[] = [];
  let start = 0;
  const push = (endExclusive: number): void => {
    let s = start;
    let e = endExclusive;
    while (s < e && /\s/u.test(text[s] ?? '')) s += 1;
    while (e > s && /\s/u.test(text[e - 1] ?? '')) e -= 1;
    if (e > s) out.push({ text: text.slice(s, e), start: s, end: e });
    start = endExclusive;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (ch === '\n') {
      push(i);
      start = i + 1;
      continue;
    }
    if (SENTENCE_END.has(ch)) {
      push(i + 1);
    }
  }
  if (start < text.length) push(text.length);
  return out;
}

function stripMarkers(text: string): string {
  return text.replace(evidenceMarker(), '');
}

/**
 * NFKC + 小写 + 去引用标记 + 去书名号里的文献名。
 *
 * 【为什么书名号里的内容要整段去掉】模型常写
 *   「根据《…实施细则-2026版》，硕士论文查重率 < 15% [E1]」——
 *   这里的 2026 是**文献版本号**，不是结论里的数值。不去掉的话，
 *   数值检查会去找"2026 在原文里吗"，把一句本来有据的结论降成待核对。
 *   书名号里的字也不该参与词面覆盖率：那是出处名，不是事实主张。
 */
function normalize(text: string): string {
  return stripMarkers(text)
    .replace(/《[^》]*》/gu, ' ')
    // 先做 NFKC：全角数字「２.」也要能当成列表序号剥掉。
    .normalize('NFKC')
    .toLowerCase()
    // 日期（"2026 年 6 月 30 日" / "2026-10-17"）是出处元数据，不是结论的
    // 数值/内容；整段去掉，既不参与数值检查，也不拉低词面重合度。
    .replace(/\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}[-/]\d{1,2}[-/]\d{1,2}/gu, ' ')
    // 列表序号（"2."、"（1）"、"二、"）不是结论里的数值。模型常在正文里
    // 用编号分点，不剥掉的话数值检查会去找"原文里有 2 吗"，把有据的句子误伤。
    .replace(/^\s*(?:(?:\d{1,3})[.、)]|[（(]\d{1,3}[）)]|[一二三四五六七八九十]{1,3}[、.)]|[-•·])\s*/u, '');
}

/** 常见的功能词 bigram：它们出现在任何句子里，计入覆盖率只会让噪音也"看起来像支持"。 */
const STOP_BIGRAMS = new Set([
  '的是', '了的', '是在', '这是', '那是', '一个', '一种', '以及', '或者',
  '并且', '但是', '因为', '所以', '如果', '因此', '其中', '其他', '这些',
  '那些', '以上', '如下', '可以', '需要', '应当', '进行', '通过', '对于',
]);

/**
 * 取用于覆盖率计算的词项。
 *
 * 中文用 **bigram** 而不是单字：单字（"的"、"是"、"率"）几乎在任何句子里都有，
 * 会把覆盖率抬到接近 1，规则层就会把无关结论判成 supported。bigram 保留
 * "查重""重率"这类真正的搭配信息。
 */
export function claimTerms(text: string): string[] {
  const normalized = normalize(text);
  const out = new Set<string>();

  for (const match of normalized.matchAll(/\d+(?:[.,]\d+)?%?/gu)) {
    const value = canonicalNumber(match[0]);
    if (value !== '') out.add(value);
  }
  for (const match of normalized.matchAll(/[a-z][a-z0-9_-]+/gu)) {
    if (match[0].length >= 2) out.add(match[0]);
  }
  for (const match of normalized.matchAll(/[㐀-鿿豈-﫿]+/gu)) {
    const run = match[0];
    if (run.length === 1) {
      out.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(bigram)) out.add(bigram);
    }
  }
  return [...out];
}

function overlapScore(claim: string, sentence: string): number {
  const claimSet = new Set(claimTerms(claim));
  if (claimSet.size === 0) return 0;
  const sentenceSet = new Set(claimTerms(sentence));
  let hit = 0;
  for (const term of claimSet) if (sentenceSet.has(term)) hit += 1;
  return hit / claimSet.size;
}

function evidenceText(ev: Evidence): string {
  return ev.kind === 'record' ? renderRecordBody(ev.fields) : ev.text;
}

interface BestSpan {
  span: ClaimEvidenceSpan;
  score: number;
  sentence: string;
}

function bestSpanFor(claimText: string, ev: Evidence): BestSpan | null {
  const text = evidenceText(ev);
  const sentences = splitSentences(text);
  let best: BestSpan | null = null;

  /**
   * 允许 1–3 个连续句子拼成一个 span。
   *
   * 【为什么不是只挑单句】模型经常把同一块里相邻的两句事实合成一句
   *   （"申请预答辩须交 1 份查重报告，未通过不能申请"）。只比对单句时，
   *   命中率最高的那一句可能只覆盖后半段，数值落在邻居句里，结果被误判成
   *   "数值不在命中片段中"。窗口把"同一块里相邻的两句"当作一个可核对单元，
   *   既保留 span 可回读，也不会把跨块的证据混在一起。
   *
   * 同分时偏好更短的窗口（少给模型上下文，也少误伤）。
   */
  for (let width = 1; width <= 3; width += 1) {
    for (let i = 0; i + width <= sentences.length; i += 1) {
      const first = sentences[i];
      const last = sentences[i + width - 1];
      if (first === undefined || last === undefined) continue;
      const windowText = sentences
        .slice(i, i + width)
        .map((s) => s.text)
        .join(' ');
      const score = overlapScore(claimText, windowText) - (width - 1) * 0.01;
      if (best === null || score > best.score) {
        const quoteSource = text.slice(first.start, last.end);
        const quote =
          quoteSource.length <= MAX_QUOTE_CHARS
            ? quoteSource
            : `${quoteSource.slice(0, MAX_QUOTE_CHARS)}…`;
        best = {
          span: { evidenceId: ev.id, start: first.start, end: last.end, quote },
          score,
          sentence: windowText,
        };
      }
    }
  }
  return best !== null && best.score > 0 ? best : null;
}

/** 数值统一形态：全角→半角、去千分位逗号、去百分号（10% 与 10 视为同一个数）。 */
function canonicalNumber(raw: string): string {
  return raw.normalize('NFKC').replace(/,/gu, '').replace(/%$/u, '').trim();
}

interface NumberMatch {
  value: string;
  index: number;
  raw: string;
}

/**
 * 数值匹配。**年份/版本号不参与**（1900–2099 且后面紧跟「年」或「版」）。
 *
 * 【为什么年份要单独排除】模型常写「根据 2026 版细则…」，这里的 2026 是
 *   文献版本号，不是结论要核对的数值。不排除的话，一句本来有据的话会因为
 *   "原文里没有 2026 这个数"被降成待核对 —— 实测出现过，属于规则层的误伤。
 *   真正需要年份的分区类结论由 `RecordCitation.version` 校验，不靠这里。
 */
function numberMatches(text: string): NumberMatch[] {
  const normalized = normalize(text);
  // 日期整体跳过（"2026 年 6 月 30 日" / "2026-10-17"）：其中的 6、30 是
  // 日期分量，不是结论要核对的指标；否则一句"落款时间为…"会因为原文命中片段
  // 里没有"30"被误判成待核对。实测出现过，属于规则层误伤。
  const dateRanges: { start: number; end: number }[] = [];
  for (const match of normalized.matchAll(
    /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}[-/]\d{1,2}[-/]\d{1,2}/gu,
  )) {
    const start = match.index ?? 0;
    dateRanges.push({ start, end: start + match[0].length });
  }

  const out: NumberMatch[] = [];
  for (const match of normalized.matchAll(/\d+(?:[.,]\d+)?%?/gu)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (dateRanges.some((r) => index >= r.start && index < r.end)) continue;
    const value = canonicalNumber(raw);
    if (/^\d{4}$/u.test(value)) {
      const year = Number(value);
      const after = normalized.slice(index + raw.length).trimStart()[0] ?? '';
      if (year >= 1900 && year <= 2099 && (after === '年' || after === '版')) continue;
    }
    out.push({ value, index, raw });
  }
  return out;
}

function extractNumbers(text: string): string[] {
  return [...new Set(numberMatches(text).map((m) => m.value))];
}

function containsNumber(text: string, value: string): boolean {
  return extractNumbers(text).includes(value);
}

/** 数值前面的中文指标（去掉"低于/高于/不超过"这类比较词）。 */
function metricBeforeNumber(text: string, at: number): string {
  const before = text.slice(Math.max(0, at - 16), at);
  const cjkRun = (before.match(/[㐀-鿿豈-﫿]+$/u) ?? [''])[0];
  return cjkRun
    .replace(/(?:低于|高于|不超过|不少于|不低于|不高于|大于|小于|超过|达到|约为|少于|多于)$/u, '')
    .slice(-8);
}

interface NumberClaim {
  value: string;
  metric: string;
}

function numberClaims(text: string): NumberClaim[] {
  const normalized = normalize(text);
  return numberMatches(text).map((match) => ({
    value: match.value,
    metric: metricBeforeNumber(normalized, match.index),
  }));
}

const GENERIC_METRICS = new Set(['方法', '实验', '结果', '数据', '指标', '论文', '时间']);

/**
 * 同一指标在原文里对应另一个数值 → contradicted。
 *
 * 【为什么只在**同一句**里比】跨句比较会产生大量假矛盾：一份文档前后文
 *   可能分别讨论两个不同的实验设置。只认同一句里的同指标数值不一致，
 *   是规则层能确定性证明的那一小块；证明不了的留给 review_required。
 */
/**
 * 结论只写了泛化指标（"查重率"），原文里却按对象分别给了不同数值
 * （博士 10%、硕士 15%）—— 这是另一种过度泛化，不能判 supported。
 *
 * 与 `findContradiction` 的分工：矛盾是"同一指标有另一个数"，
 * 这里是"同一指标有多个数，结论没有说明适用对象"。两者都值得用户停下来核对。
 */
function findMetricAmbiguity(
  claimText: string,
  evidenceTexts: readonly string[],
): string | null {
  for (const claim of numberClaims(claimText)) {
    if (claim.metric.length < 2) continue;
    const values = new Set<string>();
    for (const text of evidenceTexts) {
      for (const sentence of splitSentences(text)) {
        for (const found of numberClaims(sentence.text)) {
          if (found.metric.length < 2) continue;
          if (
            found.metric === claim.metric ||
            found.metric.includes(claim.metric) ||
            claim.metric.includes(found.metric)
          ) {
            values.add(found.value);
          }
        }
      }
    }
    if (values.size > 1 && values.has(claim.value)) {
      return (
        `同一指标「${claim.metric}」在原文里有多个取值（${[...values].join('、')}），` +
        `结论没有说明适用对象，可能是过度泛化。`
      );
    }
  }
  return null;
}

function findContradiction(claimText: string, evidenceTexts: readonly string[]): string | null {
  for (const claim of numberClaims(claimText)) {
    if (claim.metric.length < 2 || GENERIC_METRICS.has(claim.metric)) continue;
    for (const text of evidenceTexts) {
      for (const sentence of splitSentences(text)) {
        // 原文这一句已经出现了结论里的数值：可能是"10% 和 15% 都在"的完整表述，
        // 不构成矛盾。只有在同一指标旁边出现**另一个**数值时才判矛盾。
        const values = extractNumbers(sentence.text);
        if (values.includes(claim.value)) continue;
        for (const found of numberClaims(sentence.text)) {
          if (found.metric.length < 2 || GENERIC_METRICS.has(found.metric)) continue;
          if (found.metric === claim.metric && found.value !== claim.value) {
            return (
              `同一指标「${claim.metric}」在所引原文里是 ${found.value}，` +
              `结论写的是 ${claim.value}（原文：${sentence.text.slice(0, 80)}）`
            );
          }
        }
      }
    }
  }
  return null;
}

const UNIVERSAL = /(所有|全部|一律|任何|全都|均)/u;
const ONLY = /(仅|只|唯一)/u;
const NEGATION = /(?:不|没|未|无|非|禁止|不得|不可|无需|避免|没有)/u;

function hasScopeClaim(text: string): boolean {
  return UNIVERSAL.test(text) || ONLY.test(text);
}

function hasScopeInSentence(text: string): boolean {
  return UNIVERSAL.test(text) || ONLY.test(text);
}

function hasNegation(text: string): boolean {
  // "不超过/不少于/不低于" 是比较表述，不是否定；先摘掉再判。
  return NEGATION.test(text.replace(/(?:不超过|不少于|不低于|不高于)/gu, ''));
}

function isRefusal(text: string): boolean {
  return text.includes(NO_EVIDENCE_PHRASE);
}

/** 过程说明 / 建议 / 反问句：不是事实结论，不纳入 Claim 统计。 */
// 【为什么"我"不能单独作为前缀】"我校规定…" 是一句事实主张，不是过程说明；
//   只把"我查 / 我检索 / 我调用"这类过程动作列为过渡句，否则会静默漏掉
//   一类没有引用的断言（漏掉比误报更危险）。
const META_START =
  /^(?:我查|我检索|我查询|我调用|我使用|我建议|本次|以上|下面|建议|如需|如有|请|说明|注意|提示|检索|查询|调用|根据本次)/u;

/**
 * 出处说明 / 澄清句不是"事实主张"。
 *
 * 【为什么要单独列出来】「这条规定出自《…》第 13 页附则 [E1]」是在**指路**，
 *   不是在陈述一个需要证据支持的内容；它引用的页码/章节属于引用卡片的元数据，
 *   而规则层只拿证据正文做词面比对，必然找不到"第 13 页"。不跳过的话，
 *   每份回答都会因为一句出处说明被降成 partial —— 实测出现过。
 *   「不过这一条只说明了…，具体以 <15% 为准」同理，是对上文的澄清，不是新结论。
 */
const PROVENANCE_CLAIM =
  /^(?:这条|该条|本条规定|该规定|上述|原文|出处|来源|依据文件).*(?:出自|见|来源|为准|规定)/u;
const CLARIFICATION_CLAIM =
  /^(?:不过|但|然而|需要说明|需要指出|值得注意|补充说明|另需说明|需要注意|注意).*(?:只说明|只描述|只给|不再给出|为准|没有区分|落款|日期|版本|适用范围|具体口径)/u;

function isFactualClaim(text: string, evidenceIds: readonly string[]): boolean {
  // 先去标记再判断内容：一行只有 `[E1]` 的"句子"不是事实主张，
  // 不能因为它带引用就当成 Claim —— 否则界面会把它列成一条待核对结论。
  const trimmed = stripMarkers(text).trim();
  if (trimmed === '' || trimmed.length < 6) return false;
  if (PROVENANCE_CLAIM.test(trimmed)) return false;
  if (CLARIFICATION_CLAIM.test(trimmed)) return false;
  if (isRefusal(text)) return false;
  if (evidenceIds.length > 0) return true;
  if (/[？?]$/u.test(trimmed)) return false;
  // "查到的是……，分两种场合：" 这类是引出下文的过渡句，不是可以独立核对的事实。
  if (/[：:]$/u.test(trimmed) && extractNumbers(trimmed).length === 0) return false;
  if (META_START.test(trimmed) && !/\d/u.test(trimmed)) return false;
  return trimmed.length >= 8;
}

interface RawClaim {
  text: string;
  evidenceIds: string[];
  /** 原句在回答里的起止；用于判断两句之间有没有空行（段落边界） */
  start: number;
  end: number;
  /** 引用标记来自同段下一句（常见写作习惯："两句事实 + 句末一个引用"） */
  inherited: boolean;
}

/** 把正文切成可核查的 Claim。保留原句，便于界面指出"哪一句没过"。 */
export function splitClaims(answer: string): RawClaim[] {
  const lines = answer.split('\n');
  const spans: SentenceSpan[] = [];
  const tablePositions = new Set<number>();
  let offset = 0;
  let proseStart = 0;
  function addProse(end: number): void {
    for (const span of splitSentences(answer.slice(proseStart, end))) {
      spans.push({ ...span, start: span.start + proseStart, end: span.end + proseStart });
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    const table = readAnswerTable(lines, i);
    if (table === null) {
      offset += lines[i]!.length + 1;
      continue;
    }
    addProse(offset);
    offset += lines[i]!.length + lines[i + 1]!.length + 2;
    for (const [index, row] of table.rows.entries()) {
      const original = lines[i + 2 + index]!;
      const start = offset + original.indexOf(row.line);
      spans.push({ text: row.line, start, end: start + row.line.length });
      tablePositions.add(start);
      offset += original.length + 1;
    }
    i = table.end - 1;
    proseStart = offset;
  }
  addProse(answer.length);
  return spans
    .map((sentence) => {
      const text = sentence.text.trim();
      const ids: string[] = [];
      for (const match of text.matchAll(evidenceMarker())) {
        const id = `E${match[1] ?? ''}`;
        if (!ids.includes(id)) ids.push(id);
      }
      return { text, evidenceIds: ids, start: sentence.start, end: sentence.end, inherited: false };
    })
    .filter((claim) => claim.text !== '')
    .filter((claim) => tablePositions.has(claim.start) || isFactualClaim(claim.text, claim.evidenceIds));
}

function makeCheck(
  claim: RawClaim,
  verdict: ClaimVerdict,
  reasons: readonly string[],
  spans: readonly ClaimEvidenceSpan[] = [],
): ClaimCheck {
  return {
    claimId: '', // 由 verifyClaims 统一编号
    text: claim.text,
    evidenceIds: claim.evidenceIds,
    spans,
    verdict,
    reviewer: 'rule',
    reasons: claim.inherited
      ? ['引用标记由同段下一句携带，已按同段论据核对。', ...reasons]
      : reasons,
  };
}

/** 校验一条 Claim。返回的 claimId 由调用方补齐。 */
function checkClaim(claim: RawClaim, pool: ReadonlyMap<string, Evidence>): Omit<ClaimCheck, 'claimId'> {
  if (claim.evidenceIds.length === 0) {
    return makeCheck(claim, 'insufficient', ['这句话没有引用任何证据。']);
  }

  const evidences: Evidence[] = [];
  for (const id of claim.evidenceIds) {
    const ev = pool.get(id);
    if (ev !== undefined) evidences.push(ev);
  }
  if (evidences.length === 0) {
    return makeCheck(claim, 'insufficient', ['所引证据不在本次运行的证据池里。']);
  }

  const best: BestSpan[] = [];
  for (const ev of evidences) {
    const span = bestSpanFor(claim.text, ev);
    if (span !== null) best.push(span);
  }
  if (best.length === 0) {
    return makeCheck(claim, 'insufficient', ['所引证据里没有找到与这句话相关的原文。']);
  }

  const texts = evidences.map(evidenceText);
  const numbers = extractNumbers(claim.text);
  const missing = numbers.filter((n) => !texts.some((t) => containsNumber(t, n)));
  if (missing.length > 0) {
    return makeCheck(
      claim,
      'insufficient',
      [`结论里的数值 ${missing.join('、')} 在所引证据中找不到。`],
      best.map((b) => b.span),
    );
  }

  // 数值虽然在证据里，但不在命中的那一句里 —— 可能是从别处借来的。不能算支持。
  const numbersOutsideSpan = numbers.filter((n) => !best.some((b) => containsNumber(b.sentence, n)));
  if (numbers.length > 0 && numbersOutsideSpan.length > 0) {
    return makeCheck(
      claim,
      'review_required',
      [`数值 ${numbersOutsideSpan.join('、')} 没有出现在命中的原文片段里，需人工核对。`],
      best.map((b) => b.span),
    );
  }

  const contradiction = findContradiction(claim.text, texts);
  if (contradiction !== null) {
    return makeCheck(claim, 'contradicted', [contradiction], best.map((b) => b.span));
  }

  const ambiguity = findMetricAmbiguity(claim.text, texts);
  if (ambiguity !== null) {
    return makeCheck(claim, 'review_required', [ambiguity], best.map((b) => b.span));
  }

  const score = Math.max(...best.map((b) => b.score));
  const spans = best.map((b) => b.span);

  if (score >= SUPPORT_OVERLAP) {
    if (hasScopeClaim(claim.text) && !best.some((b) => hasScopeInSentence(b.sentence))) {
      return makeCheck(
        claim,
        'review_required',
        ['结论用了全称/范围表述（如"所有""全部""仅"），但所引原文没有同样的限定，可能是过度泛化。'],
        spans,
      );
    }
    if (hasNegation(claim.text) && !best.some((b) => hasNegation(b.sentence))) {
      return makeCheck(
        claim,
        'review_required',
        ['结论含否定/排除表述，规则层无法确认原文是否表达同一层意思。'],
        spans,
      );
    }
    return makeCheck(claim, 'supported', [], spans);
  }

  if (score >= REVIEW_OVERLAP) {
    return makeCheck(
      claim,
      'review_required',
      [`规则层只在原文里找到约 ${(score * 100).toFixed(0)}% 的词面重合，不足以确认语义支持。`],
      spans,
    );
  }

  // 词面重合低，但关键数值确实在命中的原文里 —— 这更像"换了说法的总结"，
  // 不是"没有依据"。降成 review_required，让用户人工核对，而不是判成无据。
  if (numbers.length > 0) {
    return makeCheck(
      claim,
      'review_required',
      [
        `结论与原文的词面重合度较低（约 ${(score * 100).toFixed(0)}%），` +
          `但关键数值能在命中的原文中找到；需人工确认语义是否被过度概括。`,
      ],
      spans,
    );
  }

  return makeCheck(
    claim,
    'insufficient',
    [`结论与所引原文的重合度过低（约 ${(score * 100).toFixed(0)}%）。`],
    spans,
  );
}

/**
 * 对一整段回答做 Claim 校验。
 *
 * 【没有 Claim 时怎么判】
 *   · 空白正文 → `not_checked`；
 *   · 只有「未找到依据」这类拒答 → `verified`（拒答本身是正确的）；
 *   · 其它没有事实 Claim 的文本 → `unverified`（不把它当成"全部通过"）。
 */
export function verifyClaims(answer: string, pool: ReadonlyMap<string, Evidence>): ClaimVerification {
  const raw = splitClaims(answer);

  // 常见写法是"两句事实写完，在第二句末尾挂一个 [E1]"。若前一句没有任何引用、
  // 且与下一句之间**没有空行**（同一段），就把下一句的引用当作这一段共同的引用
  // 去核对。跨空行不继承：那已经是一段新论述，理应各自给出处。
  // 继承来的证据仍要过同一套数值/重合度/范围检查，不会因为是继承就放行。
  for (let i = 0; i < raw.length - 1; i += 1) {
    const claim = raw[i];
    const next = raw[i + 1];
    if (claim === undefined || next === undefined) continue;
    if (claim.evidenceIds.length > 0 || next.evidenceIds.length === 0) continue;
    const between = answer.slice(claim.end, next.start);
    if (/\n\s*\n/u.test(between)) continue;
    claim.evidenceIds = [...next.evidenceIds];
    claim.inherited = true;
  }

  const claims: ClaimCheck[] = raw.map((claim, index) => ({
    ...checkClaim(claim, pool),
    claimId: `C${index + 1}`,
  }));

  const counts: Record<ClaimVerdict, number> = {
    supported: 0,
    contradicted: 0,
    insufficient: 0,
    review_required: 0,
  };
  for (const claim of claims) counts[claim.verdict] += 1;

  let status: ClaimVerificationStatus;
  if (claims.length === 0) {
    const trimmed = stripMarkers(answer).trim();
    if (trimmed === '') status = 'not_checked';
    else if (isRefusal(trimmed)) status = 'verified';
    else status = 'unverified';
  } else if (counts.contradicted > 0) {
    status = counts.supported > 0 ? 'partial' : 'unverified';
  } else if (counts.review_required > 0 || counts.insufficient > 0) {
    status = counts.supported > 0 ? 'partial' : 'unverified';
  } else {
    status = 'verified';
  }

  return { status, claims, counts };
}

/**
 * 引用摘录不合格会先剔除正文标记，随后 Claim 校验可能报“没有引用”。
 * 只在剔除前后句子正文可逐字对应、且该句确有被剔除编号时标注因果；
 * 无法对应的句子维持原判，不推测它的缺口来源。
 */
export function annotateRemovedQuoteClaims(
  originalAnswer: string,
  verification: ClaimVerification,
  removedQuoteIds: readonly string[],
): ClaimVerification {
  if (removedQuoteIds.length === 0) return verification;
  const removed = new Set(removedQuoteIds);
  const keyOf = (text: string): string => stripMarkers(text).replace(/\s+/gu, '');
  const originalByText = new Map<string, ReturnType<typeof splitClaims>>();
  for (const claim of splitClaims(originalAnswer)) {
    const key = keyOf(claim.text);
    const list = originalByText.get(key) ?? [];
    list.push(claim);
    originalByText.set(key, list);
  }
  const claims = verification.claims.map((claim) => {
    const original = originalByText.get(keyOf(claim.text))?.shift();
    const lost = original?.evidenceIds.filter((id) => removed.has(id)) ?? [];
    if (claim.verdict !== 'insufficient' || lost.length === 0) return claim;
    return {
      ...claim,
      reasons: [
        `本句原有引用 ${lost.map((id) => `[${id}]`).join('、')} 因摘录未通过核对而被剔除，当前缺少这部分依据。`,
        ...claim.reasons,
      ],
    };
  });
  return { ...verification, claims };
}
