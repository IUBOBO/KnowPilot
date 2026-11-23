/**
 * 中文检索的分词约定 —— 索引侧与查询侧【必须】共用这里的函数。
 *
 * 背景（已实测，不是推测）：
 *   SQLite FTS5 的两种常见方案对中文都不成立：
 *     · tokenize='unicode61'（默认）：整个中文串被当作一个 token →
 *       搜「注意力机制」返回 0 命中。
 *     · tokenize='trigram'（三字符切片）：长度 < 3 的查询返回 0 命中 →
 *       搜「论文」「投稿」「影像」这类两字词全部落空。
 *
 * 采用的方案：逐字切分 + 短语查询。
 *   索引时把每个 CJK 字符用空格拆开（"投稿记录" → "投 稿 记 录"），
 *   查询时同样拆开并整体包成一个 FTS5 短语（"投 稿"）。
 *   短语要求 token 连续出现，等价于精确子串匹配，且长度 1 到 n 均成立。
 *
 * 为什么这一个文件很关键：
 *   索引侧与查询侧若各写一份切分逻辑，一旦其中一侧被改动，
 *   搜索结果会【静默】变成空 —— 不报错、不崩溃，只是搜不到。
 *   这是最难排查的一类故障，因此只允许有一个实现。
 */

/** CJK 及日韩文字范围。这些文字没有词间空格，需要逐字切分。 */
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x3040, 0x30ff], // 日文假名
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区
  [0xf900, 0xfaff], // CJK 兼容表意
  [0xac00, 0xd7af], // 韩文音节
];

/**
 * 判断一个 code point 是否属于 CJK 范围。
 *
 * 导出而非私有：解析器要用它判断"这个换行是排版折行还是真段落分隔"
 * （见 apps/server/src/documents/extract.ts）。同一份 CJK 范围表只能有一处，
 * 否则将来补范围（比如加注音符号）时必然漏掉一边。
 */
export function isCjk(codePoint: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return true;
  }
  return false;
}

/**
 * 把文本转成"逐字切分"的索引形态。仅用于写入 FTS 表，不用于展示。
 *
 * 逐字遍历（而非正则 replace）是为了正确处理增补平面字符（如 emoji、
 * 生僻字），它们占 2 个 UTF-16 code unit，用正则容易切坏代理对。
 */
export function segmentForIndex(text: string): string {
  const out: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isCjk(cp)) {
      out.push(ch);
    } else if (/\s/.test(ch)) {
      out.push(' ');
    } else {
      // ASCII / 其它文字：整串保留为一个 token
      const last = out.length - 1;
      const prev = last >= 0 ? out[last] : undefined;
      if (prev !== undefined && !isCjk(prev.codePointAt(0) ?? 0) && !/\s/.test(prev)) {
        out[last] = prev + ch;
      } else {
        out.push(ch);
      }
    }
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 把用户输入的查询词转成 FTS5 MATCH 表达式。
 *
 * 整体包成一个短语，而不是把原始字符串直接丢给 MATCH —— 这一层包裹同时解决两件事：
 *   1. 语义：短语 = 连续出现的 token = 子串匹配（正是我们想要的）。
 *   2. 安全：用户输入里的 `"`、`AND`、`*`、`^` 等 FTS5 语法字符被关在引号内，
 *      退化为普通字符，不会造成语法错误。双引号按 FTS5 规则写成 `""`。
 *
 * 不做这层包裹，用户搜一句带引号的话就会让 MATCH 抛语法异常，
 * 表现为"随便打点什么就 500"。
 */
export function buildMatchQuery(raw: string): string {
  const segmented = segmentForIndex(raw);
  if (segmented.length === 0) return '';
  return '"' + segmented.replaceAll('"', '""') + '"';
}

/**
 * 长问题的宽松关键词：按语言词边界取实词，再交给同一套逐字索引规则。
 * 只用于精确短语候选不足时补召回；不把整句的虚词当成 OR 候选。
 */
const QUERY_STOP_WORDS = new Set([
  '的', '了', '是', '在', '和', '与', '及', '或', '有', '用', '把', '被', '对',
  '如何', '怎么', '什么', '哪些', '哪个', '是否', '可以', '请问', '一下',
  '关于', '有关', '需要', '请', '吗', '呢',
]);

export function searchTerms(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  for (const part of segmenter.segment(raw)) {
    if (!part.isWordLike) continue;
    const term = part.segment.trim();
    const key = term.toLowerCase();
    if (term === '' || QUERY_STOP_WORDS.has(key) || seen.has(key)) continue;
    // 多词问题中的中文单字通常是虚词/分词残片；单字查询仍走精确短语。
    if (term.length === 1 && isCjk(term.codePointAt(0) ?? 0)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= 12) break;
  }
  return out;
}

export function buildRelaxedMatchQuery(terms: readonly string[]): string {
  return terms
    .map((term) => buildMatchQuery(term))
    .filter((match) => match !== '')
    .join(' OR ');
}

/** 高亮结果的一段。hit 为 true 表示这段命中了查询词。 */
export interface TextSegment {
  text: string;
  hit: boolean;
}

/**
 * 按查询词把原文切成"命中 / 未命中"的片段，供前端渲染高亮。
 *
 * 为什么不用 SQLite 的 snippet()：
 *   FTS 表里存的是逐字切分后的文本（"投稿" 存成 "投 稿"），而 snippet()
 *   是拿这个列来生成摘要的，于是展示出来会变成「投 稿 记 录」这种带空格的样子。
 *   正确的分工是：FTS 只负责"哪一条命中、排第几"，展示文本一律从原文列取。
 *
 * 为什么返回分段而不是拼 HTML 字符串：
 *   拼 HTML 意味着要把用户可控的查询词和文档内容塞进标签里，
 *   这是 XSS 的经典入口。返回结构化的分段，由 React 渲染 <mark>，
 *   转义交给框架处理，从源头消灭这个风险。
 *
 * 匹配按不区分大小写的子串进行 —— 与 FTS 那边的短语查询语义一致。
 */
export function highlightMatches(text: string, query: string): TextSegment[] {
  const needle = query.trim();
  if (needle === '') return [{ text, hit: false }];

  const haystack = text.toLowerCase();
  const lowered = needle.toLowerCase();
  const segments: TextSegment[] = [];

  let cursor = 0;
  for (;;) {
    const at = haystack.indexOf(lowered, cursor);
    if (at === -1) break;
    if (at > cursor) segments.push({ text: text.slice(cursor, at), hit: false });
    segments.push({ text: text.slice(at, at + needle.length), hit: true });
    cursor = at + needle.length;
  }

  if (segments.length === 0) return [{ text, hit: false }];
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}
