/**
 * 切块：把解析出的「标题 / 段落」序列切成可检索、可引用的块。
 *
 * 策略：优先章节、段落、句子边界；单句超长时才退到次级标点与硬切。
 *   · 块【绝不跨页】，这样 page 列永远是精确的。宁可多出几个碎块，
 *     也不让"第 5 页"这个引用变得含糊：带出处的回答是本项目的卖点。
 *   · 标题【一定另起一块】，作为这一节的招牌行出现在块首，
 *     这样块自带上下文，搜到它的同时就知道它属于哪一节。
 *
 * 刻意不做块级重叠：FTS 是短语精确匹配，同一句话落在两块里，
 * 用户搜它就会命中两次、返回两条几乎一样的结果，看起来像 bug。
 * 重叠对向量检索才有价值，那属于单元 7：届时在 embedding 层做滑窗，
 * 块本身仍然不重叠。
 */
import { isCjk } from '@knowpilot/shared';
import { renderTableText, type ParsedBlock, type ParsedTable } from './extract.ts';

export interface DocumentChunk {
  /** 文档内的序号，从 0 起。doc_id + ordinal 唯一。 */
  ordinal: number;
  /** 展示用文本（原文，不切分） */
  text: string;
  /** PDF 页码；Word / 纯文本为 null */
  page: number | null;
  /** 所属章节路径。取自块内【第一个】块的归属，见 pathOf 的说明。 */
  sectionPath: readonly string[];
  /** 估算 token 数，供后续上下文预算与用量统计使用 */
  tokenCount: number;
}

/**
 * 目标块大小。
 *
 * 为什么中文按「字」、西文按「字符」分成两档：
 *   BGE-M3 一类的中文模型里，1 个汉字约等于 1 个 token，而英文约 4 个字符 1 个 token。
 *   同一个数字套两种语言，必然一边切太碎、一边超长。
 *   实测中文样本平均每页 497 字，600 字的上限意味着「大半页一块」，与版面对齐。
 */
const MAX_CHARS_CJK = 600;
const MAX_CHARS_LATIN = 1200;

/**
 * 小于这个长度的块会被并掉。
 * 为什么需要：块不跨页，页面末尾常剩下很短的一截（半句话或一个孤零零的小标题），
 * 单独成块只会稀释检索结果，不如并进相邻块。
 */
const MIN_CHUNK_CHARS = 80;

const SENTENCE_SEGMENTER = new Intl.Segmenter('zh', { granularity: 'sentence' });
const SOFT_BREAK = /[，,：:、；;\s]/u;

/** 块内段落之间的分隔。用两个换行：展示时天然分段，也让文本仍可读。 */
const PARAGRAPH_SEP = '\n\n';

/**
 * 表格块允许的最大字符数。
 *
 * 【为什么比正文上限大得多】表格的价值在「行列关系」：把 600 字的中文上限套上去，
 * 一张 8 行的表就会被拆成两块，第二块没有表头，每个数字都不再知道属于哪一列。
 * 这与本项目「引用要能看懂」的目标直接冲突。BGE-M3 能处理 8192 token，
 * 2000 字仍在安全范围内；超过 2000 字的表才按行拆，且每块重复表头。
 */
const MAX_TABLE_CHARS = 2000;

export function chunkDocument(blocks: readonly ParsedBlock[]): DocumentChunk[] {
  const maxChars = isCjkDominant(blocks) ? MAX_CHARS_CJK : MAX_CHARS_LATIN;
  const drafts: Draft[] = [];
  let current: Draft | null = null;

  for (const block of blocks) {
    const text = block.text.trim();
    if (text === '') continue;
    const normalized: ParsedBlock = { ...block, text };

    // 表格整块单独走：它不能与正文合并，也不能被 absorbTinyChunks 拆开。
    if (normalized.kind === 'table' && normalized.table !== undefined) {
      if (current !== null) {
        drafts.push(current);
        current = null;
      }
      for (const table of splitOversizedTable(normalized.table)) {
        drafts.push({
          page: normalized.page,
          atomic: true,
          blocks: [{ ...normalized, text: renderTableText(table), table }],
        });
      }
      continue;
    }

    // 标题另起一块：混进上一节的内容里会让章节归属算错。
    const mustBreak =
      normalized.kind === 'heading' ||
      (current !== null &&
        (current.page !== normalized.page ||
          !samePath(pathOf(current.blocks[0]!), pathOf(normalized)) ||
          draftLength(current) + normalized.text.length > maxChars));

    if (current !== null && mustBreak) {
      drafts.push(current);
      current = null;
    }
    if (current === null) current = { page: normalized.page, blocks: [] };

    if (normalized.text.length > maxChars) {
      // 单段自己就超上限：参考文献、没有分段的长文。
      // 这一段必须硬切，但只在这一种情况下硬切。
      // current 常常是刚创建的空壳；写出它会生成一条空检索块。
      if (current.blocks.length > 0) drafts.push(current);
      current = null;
      for (const piece of splitLongBody(normalized.text, maxChars)) {
        drafts.push({ page: normalized.page, blocks: [{ ...normalized, text: piece }] });
      }
      continue;
    }

    current.blocks.push(normalized);
  }
  if (current !== null) drafts.push(current);

  return absorbTinyChunks(drafts, maxChars).map((draft, ordinal) => {
    const text = draft.blocks.map((b) => b.text).join(PARAGRAPH_SEP);
    const first = draft.blocks[0];
    return {
      ordinal,
      text,
      page: draft.page,
      sectionPath: first === undefined ? [] : pathOf(first),
      tokenCount: estimateTokens(text),
    };
  });
}

interface Draft {
  page: number | null;
  blocks: ParsedBlock[];
  /** 整块不可合并（表格）。小表也不并进相邻正文，否则表头会和别的段落混在一起。 */
  atomic?: boolean;
}

/**
 * 超过上限的表格按行拆，每块重复表题与表头。
 *
 * 这是「整表不拆散」唯一的例外，且只在表格超过 MAX_TABLE_CHARS 时发生。
 * 拆的时候必须重复表头 —— 一块没有表头的数字行，对检索和阅读都是废的。
 */
function splitOversizedTable(table: ParsedTable): ParsedTable[] {
  const whole = renderTableText(table);
  if (whole.length <= MAX_TABLE_CHARS || table.rows.length <= 1) return [table];

  const width = Math.max(1, table.headers.length, ...table.rows.map((row) => row.length));
  const rowLine = (row: readonly string[]): string =>
    `| ${[
      ...row,
      ...Array.from({ length: Math.max(0, width - row.length) }, () => ''),
    ].join(' | ')} |`;
  const headerBlock = renderTableText({ ...table, rows: [] });

  const pieces: ParsedTable[] = [];
  let rows: string[][] = [];
  let length = headerBlock.length;

  const flush = (): void => {
    if (rows.length === 0) return;
    pieces.push({ ...table, rows });
    rows = [];
    length = headerBlock.length;
  };

  for (const row of table.rows) {
    const line = rowLine(row);
    if (rows.length > 0 && length + 1 + line.length > MAX_TABLE_CHARS) flush();
    rows.push([...row]);
    length += 1 + line.length;
  }
  flush();
  return pieces;
}

/**
 * 块的章节路径 = 第一个块自身的归属（标题则把自己也算进去）。
 *
 * 为什么取第一个而不是最后一个：块是从某一节的开头写起的，
 * 首个块代表这块"讲的是哪一节"。若用最后一个，一个块横跨两节时
 * 会把归属算到后面那节去。
 */
function pathOf(block: ParsedBlock): string[] {
  return block.kind === 'heading' ? [...block.sectionPath, block.text] : [...block.sectionPath];
}

function draftLength(draft: Draft): number {
  let n = 0;
  for (const b of draft.blocks) n += b.text.length;
  return n + Math.max(0, draft.blocks.length - 1) * PARAGRAPH_SEP.length;
}

/**
 * 把小碎块并进相邻块。
 *
 * 先向前并、再向后并，顺序不能颠倒：
 *   一个孤零零的小标题（某节内容刚好在上页结束）应该跟它【下面】的内容合在一起，
 *   向前并才能让标题落在块首；只剩无处可去时才向后并。
 * 合并只在同页内进行，否则就破坏了"块不跨页"。
 */
function absorbTinyChunks(drafts: readonly Draft[], maxChars: number): Draft[] {
  const forward: Draft[] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    const draft = drafts[i];
    if (draft === undefined) continue;
    const next = drafts[i + 1];
    if (
      draft.atomic !== true &&
      draftLength(draft) < MIN_CHUNK_CHARS &&
      next !== undefined &&
      next.atomic !== true &&
      next.page === draft.page &&
      sameDraftSection(draft, next) &&
      draftLength(draft) + PARAGRAPH_SEP.length + draftLength(next) <= maxChars
    ) {
      next.blocks.unshift(...draft.blocks);
      continue;
    }
    forward.push(draft);
  }

  const out: Draft[] = [];
  for (const draft of forward) {
    const previous = out[out.length - 1];
    if (
      previous !== undefined &&
      draft.atomic !== true &&
      previous.atomic !== true &&
      draftLength(draft) < MIN_CHUNK_CHARS &&
      previous.page === draft.page &&
      sameDraftSection(previous, draft) &&
      draftLength(previous) + PARAGRAPH_SEP.length + draftLength(draft) <= maxChars
    ) {
      previous.blocks.push(...draft.blocks);
      continue;
    }
    out.push(draft);
  }
  return out;
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameDraftSection(a: Draft, b: Draft): boolean {
  const firstA = a.blocks[0];
  const firstB = b.blocks[0];
  return firstA !== undefined && firstB !== undefined && samePath(pathOf(firstA), pathOf(firstB));
}

/** 长段先按完整句子组块；只有单句超限才在较弱边界切开。 */
function splitLongBody(text: string, maxChars: number): string[] {
  const sentences = [...SENTENCE_SEGMENTER.segment(text)]
    .map((part) => part.segment)
    .filter((part) => part.trim() !== '');

  const pieces: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.trim() !== '') pieces.push(current.trim());
    current = '';
  };
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      flush();
      pieces.push(...splitOversizedSentence(sentence.trim(), maxChars));
      continue;
    }
    if (current.length + sentence.length > maxChars) flush();
    current += current === '' ? sentence.trimStart() : sentence;
  }
  flush();
  return pieces;
}

function splitOversizedSentence(sentence: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > maxChars) {
    const lower = Math.floor(maxChars * 0.55);
    let cut = -1;
    for (let i = maxChars - 1; i >= lower; i -= 1) {
      if (SOFT_BREAK.test(rest[i] ?? '')) {
        cut = i + 1;
        break;
      }
    }
    if (cut < 0) cut = maxChars;
    const part = rest.slice(0, cut).trim();
    if (part !== '') out.push(part);
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim() !== '') out.push(rest.trim());
  return out;
}

/**
 * 判断文档以中文为主。
 *
 * 用"非空白字符里汉字占多大比例"判断，而不是「含不含汉字」——
 * 中文论文里夹大段英文摘要、英文论文里夹中文引用都很常见，
 * 只要出现汉字就按中文档处理，会把英文论文的字数上限砍半。
 */
function isCjkDominant(blocks: readonly ParsedBlock[]): boolean {
  let cjk = 0;
  let total = 0;
  for (const block of blocks) {
    for (const ch of block.text) {
      if (/\s/u.test(ch)) continue;
      total += 1;
      if (isCjk(ch.codePointAt(0) ?? 0)) cjk += 1;
    }
  }
  return total > 0 && cjk / total > 0.3;
}

/**
 * 估算 token 数。汉字按 1 个，其余按 4 字符 1 个。
 * 这是估算，不是精确分词 —— 它的用途是预算与用量统计的量级判断，
 * 精确值要等真正送进模型时才知道（那时以模型返回的 usage 为准）。
 */
function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjk(ch.codePointAt(0) ?? 0)) cjk += 1;
    else if (!/\s/u.test(ch)) other += 1;
  }
  return cjk + Math.ceil(other / 4);
}
