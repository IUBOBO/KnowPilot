/**
 * 文本提取：把 PDF / Word / 纯文本变成「带位置与结构」的文本块。
 *
 * 这一层不碰数据库、不做切块、不建索引。它回答三个问题：
 *   这份文件里有哪些文字？每段在第几页？每段属于哪一节？
 *
 * 为什么和切块分成两个模块（而不是一个 parse-and-chunk）：
 *   两者的变更原因不同 —— 换解析库不影响切块策略，调块大小也不影响解析。
 *   合在一起，以后只想改块大小却要改到解析代码里，误伤的风险远大于省下的几十行。
 *
 * 为什么 PDF 改走 pdfjs 直调、不再用 pdf-parse 的便捷层（阶段 1 单元 3）：
 *   pdf-parse 只交出「一页一坨文本」，字号与坐标在那一层被抹掉了。
 *   而本项目有两样东西只能从这些信号里来：
 *     · 页眉页脚识别 —— 靠「坐标固定 + 跨页重复」（见 dropRunningHeaders）
 *     · 标题层级识别 —— 靠字号与编号（见 detectHeading）
 *   字号就藏在 textContent 每项 transform 的 [0]/[3] 上（实测 DeepLabv3 正文 9.96、
 *   一级标题 11.96、论文标题 14.35），pdf-parse 不暴露它。
 *
 * 关于 OCR（决策 6）：文字层为空的页会送去识别，识别结果**并回同一套行结构**，
 * 所以后面的页眉页脚剔除、段落重排、标题识别不需要各写一份。
 * 唯一并不回来的是字号（OCR 只有检测框），那一路信号对 OCR 行整体置空 ——
 * 原因见 PdfLine.size 的注释。识别本身在 ocr.ts，页面转像素在 rasterize.ts。
 */
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { AppError, isCjk } from '@knowpilot/shared';
import { renderPageToRgba } from './rasterize.js';
import { OCR_LOW_CONFIDENCE, ocrModelsPresent, recognizeImage, type OcrLine } from './ocr.js';

/** 一张表：表题 + 表头 + 数据行。单元格保留原顺序，空串表示该格无内容。 */
export interface ParsedTable {
  /** 表题（"表 2 …" / "Table 3. …"），没有则 null。 */
  caption: string | null;
  /** 表头单元格。PDF 无表头时取第一行；Word 优先取 `<thead>` 或首行。 */
  headers: readonly string[];
  /** 数据行，每行的长度与 headers 对齐（缺的补空串）。 */
  rows: readonly (readonly string[])[];
}

/** 一个文本块：一段正文、一个标题或一张表，附带它在文档中的位置与所属章节。 */
export interface ParsedBlock {
  /** PDF 页码，从 1 起。Word / 纯文本没有页码概念 → null */
  page: number | null;
  text: string;
  /** heading = 标题行（独立成块，不参与段落合并）；body = 正文段落；table = 结构化表格 */
  kind: 'heading' | 'body' | 'table';
  /** 标题层级，从 1 起；正文与表格为 null */
  level: number | null;
  /**
   * 所属章节路径，从最外层到最内层，例如 ["3 Methods", "3.1 Encoder-Decoder"]。
   * 不含本块自身（本块若为标题，此路径是它的父级链）。
   *
   * 这就是切块时能给出「出自 3.1 节」而不只是「第 5 页」的原因 ——
   * 论文真正的定位单位是章节，页码只是次要线索。
   */
  sectionPath: readonly string[];
  /**
   * `kind === 'table'` 时的结构化内容。`text` 是同一张表的渲染形态
   * （表头 + `|` 分隔的行），两者必须描述同一张表 —— 检索与展示都用 `text`，
   * 这个字段留给测试、调试和以后真正需要按单元格取值的功能。
   */
  table?: ParsedTable;
}

export interface ParsedDocument {
  /** 文档标题，取自 PDF 元数据。没有则 null（调用方回退到文件名）。 */
  title: string | null;
  author: string | null;
  blocks: ParsedBlock[];
  /** 非致命提示。致命问题一律抛 AppError，不走这里。 */
  warnings: string[];
  /** 被判为页眉/页脚而剔除的重复行数（仅 PDF 有意义，其余为 0）。 */
  droppedBoilerplate: number;
  /**
   * 真正跑了 OCR 的页数（其余格式恒为 0）。
   *
   * 落进 IngestReport 是有意的：它决定「这份文档的正文有多少是机器认出来的」——
   * 全是 0 而块数很少，就该怀疑是不是漏了扫描页；而不是 0 时，
   * 出现错别字是可预期的（OCR 结果永远需要人工核对）。
   */
  ocrPageCount: number;
}

/**
 * 解析选项。
 *
 * 【为什么由调用方传，而不是 extract 自己去读 AppConfig】
 *   extract 这一层只回答"这份文件里有什么字"，不碰配置也不碰数据库 ——
 *   这样它可以被单测直接调用，塞一个临时文件进去就行。
 *   "要不要花两秒一页去识别扫描页"是调用方的策略，不是解析的固有属性。
 */
export interface ExtractOptions {
  /** 不传 = 不做 OCR，无文字层的页保持为空。 */
  ocr?: { enabled: boolean; maxPages: number };
}

/**
 * 解析入口。按扩展名分派到具体解析器。
 *
 * 所有失败都转成 AppError('invalid_argument')：解析失败几乎总是文件本身的问题
 * （损坏、加密、格式不符），而不是服务出故障。归成 500 会误导使用方去重试，
 * 而重试一份坏文件永远不会成功。
 */
export async function extractDocument(
  absPath: string,
  options: ExtractOptions = {},
): Promise<ParsedDocument> {
  const ext = extname(absPath).toLowerCase();
  if (ext === '.pdf') return extractPdf(absPath, options.ocr);
  if (ext === '.docx') return extractDocx(absPath);
  if (ext === '.md' || ext === '.txt') return extractPlainText(absPath);
  throw new AppError('invalid_argument', `没有针对 "${ext}" 的解析器。`);
}

// ── PDF ───────────────────────────────────────────────────────

/**
 * PDF 里的一「行」。
 *
 * 注意这不等同于视觉上的排版行，而是「同一 y 坐标上的一串文字」。
 * 分行的依据是 y 而不是 pdfjs 的 hasEOL：实测 DeepLabv3 第 4 页，
 * 页眉（y=692）之后紧跟图片标注（y=659），中间那个 hasEOL 落在了一个空串项上，
 * 只认 hasEOL 会把「页眉 + 图片标注」粘成一行；按 y 分组则天然分开。
 */
export interface PdfLine {
  page: number;
  text: string;
  /**
   * 本行的字号（transform 的缩放分量）。用于标题识别。
   *
   * 【为什么允许 null】OCR 出来的行没有字号，只有检测框。而**框高不能当字号用** ——
   * 这是实测出来的：同一页正文字体（9.96pt）的行，检测框高度在 20–25px 之间浮动
   * （含括号、《》、数字的行更高），而标题行是 20–30px，两者**重叠**。
   * 按框高比去判标题，会把一整批正文行判成标题，把章节路径切得七零八落 ——
   * 而这从检索结果上看不出来（照样有结果，只是分层全乱）。
   * 所以 OCR 行一律给 null：字号这一路信号整体失效，只保留编号与固定章节名这两路
   * 可靠的判据（见 detectHeading 里 size === null 的分支）。
   */
  size: number | null;
  /** PDF 用户坐标系的 y（原点在页面左下角，向上为正）。用于页眉页脚识别。 */
  y: number;
  /** 本行最左侧文字项的 x。OCR 行没有 → null。 */
  x: number | null;
  /** 本行最右侧的 x + 宽度。OCR 行没有 → null。 */
  xEnd: number | null;
  /**
   * 按水平间距切出来的行内片段。表格识别靠它，正文段落不受影响。
   * OCR 行没有 x → 空数组（OCR 出来的表格不做结构化，理由见 detectPdfTables）。
   */
  cells: PdfCell[];
  /**
   * 这一行其实是一张已经识别好的表（由 detectPdfTables 折成一行）。
   * buildBlocks 见到它就直接产出 table 块，不再按段落处理。
   */
  table?: ParsedTable;
}

/** 行内一个片段：一段连续文字 + 它在页面上的水平范围。 */
export interface PdfCell {
  text: string;
  /** 片段起点（PDF 用户坐标系，原点左下）。 */
  x: number;
  /** 片段终点（x + 宽度）。 */
  end: number;
}

/** pdfjs 文本项里我们需要的部分。width 用于判断单元格之间的空隙。 */
interface PdfTextItem {
  str: string;
  transform: readonly number[];
  width?: number;
}

/** pdfjs 的文档句柄。渲染与取文字都要它，故抽出来给 OCR 那一遍共用。 */
type PdfDocument = Awaited<
  ReturnType<typeof import('pdfjs-dist/legacy/build/pdf.mjs')['getDocument']>['promise']
>;

async function extractPdf(
  absPath: string,
  ocr: ExtractOptions['ocr'],
): Promise<ParsedDocument> {
  const file = basename(absPath);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  let doc: PdfDocument | undefined;
  try {
    const data = new Uint8Array(readFileSync(absPath));
    doc = await pdfjs.getDocument({
      data,
      // 不加载系统字体：解析只需要文字内容，加载字体既慢又在无字体环境里报错。
      useSystemFonts: false,
      isEvalSupported: false,
    }).promise;

    // ── 第一遍：逐页取文字层，记下"一个字都没有"的页 ──
    // 分两遍而不是边读边识别：识别比取文字慢两个数量级（约 2 秒/页），
    // 得先把"哪些页真的缺字"确定下来，才谈得上"超上限的页不识别"。
    const perPage: (PdfLine[] | null)[] = [];
    const emptyPages: number[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageLines = itemsToLines(content.items, pageNumber);
      if (pageLines.length === 0) {
        // null = 这一页还空着，等第二遍用 OCR 填。
        perPage.push(null);
        emptyPages.push(pageNumber);
      } else {
        perPage.push(pageLines);
      }
      // 不 cleanup 的话，246 页的文档解析到一半内存就上去了。
      page.cleanup();
    }

    const warnings: string[] = [];
    const ocrPageCount =
      emptyPages.length === 0 ? 0 : await fillPagesWithOcr(doc, emptyPages, perPage, ocr, warnings);

    const lines: PdfLine[] = [];
    for (const pageLines of perPage) {
      if (pageLines !== null) lines.push(...pageLines);
    }

    const droppedBoilerplate = dropRunningHeaders(lines, doc.numPages);
    const kept = lines.filter((l) => l.text !== '');

    // 元数据拿不到不算失败 —— 它只是锦上添花，不该让整份文档解析不了。
    let title: string | null = null;
    let author: string | null = null;
    try {
      const meta = await doc.getMetadata();
      const info = (meta.info ?? {}) as Record<string, unknown>;
      title = asNonEmptyString(info['Title']);
      author = asNonEmptyString(info['Author']);
    } catch {
      // 保持 null
    }

    // 表格识别必须排在页眉页脚剔除之后：表头里的短词（"Method"）在每一页
    // 都出现时，可能先被当成页眉删掉，再拿去判表就只剩一堆数据行。
    const structured = detectPdfTables(kept);
    if (structured.count > 0) {
      warnings.push(
        `识别出 ${structured.count} 张表格，已按「表题 + 表头 + 行」的结构入库；` +
          `没有边框或单元格过长的表仍按正文处理。`,
      );
    }
    const bodySize = estimateBodyFontSize(structured.lines);
    const blocks = buildBlocks(structured.lines, bodySize);

    const totalChars = blocks.reduce((n, b) => n + b.text.length, 0);
    if (totalChars === 0) {
      // 这是最常见的"传了却搜不到"的原因，必须在解析阶段就点破。
      // pdfjs 对无文字层的 PDF 不报错，只是安静地返回空字符串。
      // 具体为什么没救回来（OCR 关了 / 超了页数上限 / 全都识别失败），
      // fillPagesWithOcr 已经逐条写进 warnings 了，这里只补一句总账。
      warnings.push('这份文件没有提取到任何可检索的文字：它的页面只有图像，没有文字层。');
    }

    return { title, author, blocks, warnings, droppedBoilerplate, ocrPageCount };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw translatePdfError(err, file);
  } finally {
    // 不 destroy 会一直占着 pdfjs 的文档句柄与 worker，批量解析时内存持续上涨。
    if (doc !== undefined) {
      try {
        await doc.destroy();
      } catch {
        // 释放失败不影响解析结果，不掩盖原始错误
      }
    }
  }
}

/**
 * 把一页的文本项按 y 坐标归并成行，并在行内按水平间距切出片段。
 *
 * 为什么不再直接拼接（O11）：表格的单元格关系只存在于坐标里。直接拼接会把
 * 「Channels 8 16 32」压成一句话，切块时再按段落合并，一行表格数据就散进了正文。
 * 保留 x 与宽度之后，宽空白（pdfjs 会把列间距吐成一个很宽的 `str === " "` 项）
 * 就能被识别成列分隔，表格才有可能还原成「表头 + 行」。
 *
 * 正文不受影响：行文本仍然是各片段用空格连接，与原先逐项拼接的结果一致。
 */
function itemsToLines(items: readonly unknown[], page: number): PdfLine[] {
  interface RowItem {
    text: string;
    x: number;
    width: number;
  }
  interface Row {
    y: number;
    size: number;
    items: RowItem[];
  }

  const rows: Row[] = [];
  let current: Row | null = null;

  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null || !('str' in raw)) continue;
    const item = raw as PdfTextItem;
    if (item.str === '') continue; // 零宽项只是换行标记，本身没有内容

    const y = item.transform[5] ?? 0;
    const size = Math.abs(item.transform[3] ?? 0);
    const x = item.transform[4] ?? 0;
    const width = item.width ?? 0;

    // 同一行的容差：取字号的 0.5 倍，这样上下标（偏移约 3pt）留在本行，
    // 而正常行距（约 10pt）足以触发换行。
    if (current !== null && Math.abs(y - current.y) <= Math.max(2, current.size * 0.5)) {
      current.items.push({ text: item.str, x, width });
    } else {
      if (current !== null) rows.push(current);
      current = { y, size, items: [{ text: item.str, x, width }] };
    }
  }
  if (current !== null) rows.push(current);

  return rows.map((row) => rowToLine(row, page));
}

/** 一个 y 分组 → 一行：按 x 排序，按水平间距切成片段。 */
function rowToLine(row: { y: number; size: number; items: readonly { text: string; x: number; width: number }[] }, page: number): PdfLine {
  const ordered = [...row.items].sort((a, b) => a.x - b.x);
  const cells: PdfCell[] = [];
  let lastEnd: number | null = null;
  /** 上一个非文字项是宽空白：下一个文字项必须另起一格。 */
  let breakCell = false;

  const append = (text: string, x: number, width: number): void => {
    const gap = lastEnd === null ? Number.POSITIVE_INFINITY : x - lastEnd;
    const last = cells[cells.length - 1];
    // 超过一个字号宽的空隙才当列间隔；正常词距远小于它。
    if (last === undefined || breakCell || gap >= Math.max(4, row.size)) {
      cells.push({ text, x, end: x + width });
    } else {
      last.text += text;
      last.end = Math.max(last.end, x + width);
    }
    breakCell = false;
    lastEnd = x + width;
  };

  for (const item of ordered) {
    if (/^\s*$/u.test(item.text)) {
      // pdfjs 把列间距吐成很宽的空白项。宽度达到 0.8 个字号的，作为一格结束；
      // 窄空白只是一个词间空格，补进当前格。
      if (item.width >= Math.max(6, row.size * 0.8)) {
        breakCell = true;
        lastEnd = Math.max(lastEnd ?? 0, item.x + item.width);
      } else if (cells.length > 0) {
        const last = cells[cells.length - 1];
        if (last !== undefined && !/\s$/u.test(last.text)) last.text += ' ';
        lastEnd = Math.max(lastEnd ?? 0, item.x + item.width);
      }
      continue;
    }
    append(item.text, item.x, item.width);
  }

  const trimmed = cells
    .map((cell) => ({ ...cell, text: cell.text.trim() }))
    .filter((cell) => cell.text !== '');
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return {
    page,
    text: trimmed.map((cell) => cell.text).join(' '),
    size: row.size,
    y: row.y,
    x: first?.x ?? null,
    xEnd: last?.end ?? null,
    cells: trimmed,
  };
}

// ── 表格识别（PDF）─────────────────────────────────────────────

/**
 * 把连续的「多片段行」识别成一张表，并把整张表折成一行。
 *
 * 【为什么要这么保守】PDF 文本层没有「这是表格」的标记，只有坐标。能用的信号
 * 只有三个：一行里有多段、各段的 x 位置在连续几行里重复、每段都很短。
 * 而双栏排版的正文同样满足前两条 —— 左右两栏在同一 y 上就是两段，x 也稳定。
 * 所以判据里必须有「短」：双栏正文的每段通常几十个字，表格单元格通常十几个字。
 * 宁可漏掉一张没有边框、单元格又很长的表，也不要把双栏正文误判成表 ——
 * 后者会把整页正文切碎，检索质量下降得比漏一张表严重得多。
 *
 * 【为什么 OCR 行不参与】OCR 只给整行文本框，没有行内片段。没有列坐标硬猜列边界，
 * 造出来的是假结构：看上去像表，单元格却对不上。宁可保持正文。
 *
 * 【识别不出来时不动原文】识别不出来就一行都不改，正文段落仍然照常入库 ——
 * 这是这个函数唯一的失败方式，它不会丢字。
 */
export function detectPdfTables(lines: readonly PdfLine[]): { lines: PdfLine[]; count: number } {
  const prepared = lines.map((line) => {
    if (line.table !== undefined) return null;
    // 表题不是数据行：它常常和表格同页、紧挨着，粘进候选行会把整张表判死。
    if (line.size === null || isTableCaptionLine(line.text)) return null;
    if (line.cells.length < 2) return null;
    return normalizeTableCells(line.cells);
  });

  interface Region {
    start: number;
    end: number;
    table: ParsedTable;
    captionIndex: number | null;
  }
  const regions: Region[] = [];
  let i = 0;

  while (i < lines.length) {
    const first = prepared[i];
    if (first === null || first === undefined || first.length < 2) {
      i += 1;
      continue;
    }

    const page = lines[i]?.page;
    let runEnd = i;
    while (runEnd + 1 < lines.length) {
      const next = prepared[runEnd + 1];
      if (lines[runEnd + 1]?.page !== page || next === null || next === undefined || next.length < 2) {
        break;
      }
      runEnd += 1;
    }

    // 太长的连续多片段行更像双栏正文（表很少横跨几十行还不出现单片段行）。
    if (runEnd - i + 1 > TABLE_MAX_ROWS) {
      i = runEnd + 1;
      continue;
    }

    let start = i;
    let end = runEnd;
    let found: Region | null = null;
    while (start < runEnd) {
      const rows = prepared.slice(start, end + 1);
      if (rows.every((row): row is PdfCell[] => row !== null) && qualifyTableRows(rows)) {
        // 表头有时会被 pdfjs 挤成一格（列间距不够宽），于是它不在多片段行里，
        // 区域会从第二行开始 —— 表 3/5/7 都出现过；有时表头还横跨两三行。
        // 这里先按数据行学出稳定的列锚点，再把紧邻的表头行投影到同一组锚点上。
        // 锚点比「行内单元格数量的众数」可靠：稀疏的 X 列、合并单元格都不会把它带偏。
        const anchors = collectColumnAnchors(rows);
        const headerLines = anchors.length >= 2 ? collectHeaderLines(lines, start, page, anchors) : [];
        // 区域的第一行也可能本身就是表头（pdfjs 恰好把它断成了多片段行）：
        // 单词、无百分比、没有数字行那种密度。把它从数据行里剥出来，并入表头。
        let peeled = 0;
        while (peeled < 2 && peeled + 1 < rows.length) {
          const candidate = rows[peeled];
          if (candidate === undefined || !isHeaderLikeRow(candidate)) break;
          peeled += 1;
        }
        const headerSources: HeaderSource[] = [
          ...headerLines,
          ...rows.slice(0, peeled).map((cells) => ({ cells })),
        ];
        const headerRow =
          headerSources.length === 0 ? null : mergeHeaderSources(headerSources, anchors);
        const regionStart = start - headerLines.length;
        const aligned = rows.map((row) =>
          anchors.length >= 2 ? alignRowToAnchors(row, anchors) : [],
        );
        const fallbackTarget = modeNumber(rows.map((row) => row.length));
        const dataRows = aligned.every((row) => row.length > 0)
          ? aligned.slice(peeled).map((row) => row.map((cell) => cell.text))
          : rows
              .slice(peeled)
              .map((row) => alignTableRow(row, fallbackTarget).map((cell) => cell.text));
        const allRows = headerRow === null ? dataRows : [headerRow.map((cell) => cell.text), ...dataRows];
        const captionIndex = findTableCaption(lines, regionStart, end, page);
        const table = makeParsedTable(allRows, captionIndex === null ? null : lines[captionIndex]?.text ?? null);
        found = { start: regionStart, end, table, captionIndex };
        break;
      }
      if (end > start + 1) {
        end -= 1;
      } else {
        start += 1;
        end = runEnd;
      }
    }

    if (found === null) {
      i += 1;
      continue;
    }
    regions.push(found);
    i = found.end + 1;
  }

  if (regions.length === 0) return { lines: [...lines], count: 0 };

  const atStart = new Map<number, ParsedTable>();
  const consumed = new Set<number>();
  for (const region of regions) {
    atStart.set(region.start, region.table);
    for (let k = region.start; k <= region.end; k += 1) consumed.add(k);
    if (region.captionIndex !== null) consumed.add(region.captionIndex);
  }

  const out: PdfLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const table = atStart.get(index);
    if (table !== undefined) {
      const line = lines[index];
      out.push({
        page: line?.page ?? 0,
        text: renderTableText(table),
        size: null,
        y: line?.y ?? 0,
        x: null,
        xEnd: null,
        cells: [],
        table,
      });
      continue;
    }
    if (consumed.has(index)) continue;
    const line = lines[index];
    if (line !== undefined) out.push(line);
  }
  return { lines: out, count: regions.length };
}

/** 一张表最多多少行。超过它就不当表 —— 双栏正文可以轻易有几十行「两段」。 */
const TABLE_MAX_ROWS = 60;

/** 表题：`表 1 …` / `Table 3. …` / `Tab. 2 …`。 */
function isTableCaptionLine(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 120 && /^(表|Table|Tab\.)\s*[\d一二三四五六七八九十]/iu.test(t);
}

/**
 * 行内片段 → 表格单元格。
 *
 * pdfjs 常把「77.61% 77.92% 78.16%」吐成**一个**文字项（中间只有单空格）。
 * 若整段都很短、且至少两个 token 像数字，就按空格拆开并按原宽度均分 x ——
 * 这不是精确坐标，但足以让它们落进不同的列，比把三个数挤在一格里强。
 * 长文本不拆：那是句子，拆开等于伪造列。
 */
function normalizeTableCells(cells: readonly PdfCell[]): PdfCell[] {
  const out: PdfCell[] = [];
  for (const cell of cells) {
    const text = cell.text.trim();
    if (text === '') continue;
    const tokens = text.split(/\s+/u).filter((t) => t !== '');
    const numeric = tokens.filter((t) => looksNumeric(t)).length;
    // 带括号的是一整个结构（`[3 × 3, 256] × 2`），拆开就再也拼不回原意。
    const structured = /[[\]()（）]/u.test(text);
    if (
      !structured &&
      tokens.length >= 2 &&
      tokens.length <= 12 &&
      tokens.every((t) => t.length <= 12) &&
      numeric >= 2
    ) {
      const span = (cell.end - cell.x) / tokens.length;
      for (let k = 0; k < tokens.length; k += 1) {
        out.push({ text: tokens[k] ?? '', x: cell.x + k * span, end: cell.x + (k + 1) * span });
      }
    } else {
      out.push({ ...cell, text });
    }
  }
  return out;
}

/** 像数字的单元格：纯数字、百分比、区间、带单位。判表用它，不判内容真伪。 */
function looksNumeric(text: string): boolean {
  return /^[\s\d.,%+\-–—±×xX/()（）mMkKgGμ°:：]+$/u.test(text) && /\d/u.test(text);
}

/** 一段连续的多片段行是否像表。所有阈值都是实测调出来的，改动要重新跑样本。 */
function qualifyTableRows(rows: readonly (readonly PdfCell[])[]): boolean {
  if (rows.length < 2) return false;
  const counts = rows.map((row) => row.length);
  const mode = modeNumber(counts);
  if (mode < 2 || mode > 12) return false;
  // 只有两行时，两列太容易是双栏正文；要求至少三列。
  if (rows.length === 2 && mode < 3) return false;

  const consistent = counts.filter((count) => Math.abs(count - mode) <= 1).length / counts.length;
  if (consistent < 0.7) return false;

  const cells = rows.flat();
  if (cells.length === 0) return false;
  const lengths = cells.map((cell) => cell.text.length);
  const maxLength = Math.max(...lengths);
  if (maxLength > 60 || median(lengths) > 24) return false;

  const numericRatio = cells.filter((cell) => looksNumeric(cell.text)).length / cells.length;
  const shortRatio = lengths.filter((length) => length <= 12).length / lengths.length;
  // 既没有数字、又大多是长文本 → 是句子，不是表。
  if (numericRatio < 0.2 && shortRatio < 0.5) return false;

  const avgRowChars = lengths.reduce((sum, n) => sum + n, 0) / rows.length;
  if (avgRowChars > 90) return false;

  // 列锚点必须在至少两行里重复出现，否则只是「某一行恰好断成几段」。
  return stableColumnCount(rows) >= 2;
}

/** 有多少个 x 位置（±12pt）在至少两行里出现过。 */
function stableColumnCount(rows: readonly (readonly PdfCell[])[]): number {
  const anchors: { x: number; rowCount: number; lastRow: number }[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row === undefined) continue;
    for (const cell of row) {
      const anchor = anchors.find((a) => Math.abs(a.x - cell.x) <= TABLE_COLUMN_TOLERANCE);
      if (anchor === undefined) {
        anchors.push({ x: cell.x, rowCount: 1, lastRow: rowIndex });
      } else if (anchor.lastRow !== rowIndex) {
        anchor.rowCount += 1;
        anchor.lastRow = rowIndex;
      }
    }
  }
  return anchors.filter((anchor) => anchor.rowCount >= 2).length;
}

const TABLE_COLUMN_TOLERANCE = 12;

function modeNumber(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = 0;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value > best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** 表格紧邻的表题：优先前面，其次后面（有的期刊把表题排在表下方）。 */
function findTableCaption(
  lines: readonly PdfLine[],
  start: number,
  end: number,
  page: number | undefined,
): number | null {
  const before = start > 0 ? lines[start - 1] : undefined;
  if (before !== undefined && before.page === page && isTableCaptionLine(before.text)) {
    return start - 1;
  }
  const after = end + 1 < lines.length ? lines[end + 1] : undefined;
  if (after !== undefined && after.page === page && isTableCaptionLine(after.text)) {
    return end + 1;
  }
  return null;
}

/** 表格的一列：数据行里反复出现的 x 区间。 */
interface ColumnAnchor {
  x: number;
  end: number;
  center: number;
}

/**
 * 从数据行学出列锚点。
 *
 * 为什么按**中心**聚类而不是左边界：数字列常右对齐（`8` 与 `16` 的左边界差 2pt），
 * 文字列常左对齐；中心对两者都稳定。只保留至少两行都出现的列 ——
 * 某一行恰好断出来的碎段不配当列。
 */
function collectColumnAnchors(rows: readonly (readonly PdfCell[])[]): ColumnAnchor[] {
  interface Group {
    centers: number[];
    x: number;
    end: number;
    rowCount: number;
    lastRow: number;
    maxCenter: number;
  }
  const points: { center: number; cell: PdfCell; row: number }[] = [];
  rows.forEach((row, rowIndex) => {
    for (const cell of row) points.push({ center: (cell.x + cell.end) / 2, cell, row: rowIndex });
  });
  points.sort((left, right) => left.center - right.center);

  const groups: Group[] = [];
  for (const point of points) {
    const last = groups[groups.length - 1];
    if (last !== undefined && point.center - last.maxCenter <= TABLE_COLUMN_TOLERANCE) {
      last.centers.push(point.center);
      last.x = Math.min(last.x, point.cell.x);
      last.end = Math.max(last.end, point.cell.end);
      last.maxCenter = point.center;
      if (last.lastRow !== point.row) {
        last.rowCount += 1;
        last.lastRow = point.row;
      }
    } else {
      groups.push({
        centers: [point.center],
        x: point.cell.x,
        end: point.cell.end,
        rowCount: 1,
        lastRow: point.row,
        maxCenter: point.center,
      });
    }
  }

  const candidates = groups
    .map((group) => ({
      x: group.x,
      end: group.end,
      center: group.centers.reduce((sum, value) => sum + value, 0) / group.centers.length,
      rowCount: group.rowCount,
    }))
    .sort((left, right) => left.center - right.center);

  // 至少两行出现的列才是稳定列。但**稀疏列**（表 2 的 Conv3 只有一行打 X）
  // 也是真列：它很窄、离左右列都远，保留它比丢掉一整列好。
  const anchors = candidates.filter((group, index) => {
    if (group.rowCount >= 2) return true;
    if (group.end - group.x > 12) return false;
    const previous = candidates[index - 1];
    const next = candidates[index + 1];
    const gapPrevious = previous === undefined ? Number.POSITIVE_INFINITY : group.center - previous.center;
    const gapNext = next === undefined ? Number.POSITIVE_INFINITY : next.center - group.center;
    return Math.min(gapPrevious, gapNext) >= 20;
  });

  // 列数多到这种程度，多半是把双栏正文或长句子误判成了表；交回旧的对齐方式。
  if (anchors.length < 2 || anchors.length > 12) return [];
  return anchors;
}

/**
 * 捞回表格上方紧邻的表头行。
 *
 * 表头可能横跨两三行（`Encoder` / `Decoder MS Flip` / `train OS eval OS`），
 * 而且 pdfjs 常把它挤成一格。判据保守：短、以文字为主、不以句末标点结束、
 * 与表格列区间有重叠、与下一行的基线间距不超过 2.6 倍字号。
 * 「The results are shown in Table 3.」这种句子会被句号和距离挡在外面。
 */
function collectHeaderLines(
  lines: readonly PdfLine[],
  start: number,
  page: number | undefined,
  anchors: readonly ColumnAnchor[],
): PdfLine[] {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (first === undefined || last === undefined) return [];
  const minX = first.x - 24;
  const maxX = last.end + 24;

  const out: PdfLine[] = [];
  let cursor = start - 1;
  let previousY = lines[start]?.y ?? 0;
  while (out.length < 3 && cursor >= 0) {
    const line = lines[cursor];
    if (line === undefined || line.page !== page || line.table !== undefined) break;
    if (isTableCaptionLine(line.text)) break;
    const text = line.text.trim();
    if (text === '' || text.length > 200) break;
    if (/[。！？.!?]$/u.test(text)) break;

    const tokens = text.split(/\s+/u).filter((token) => token !== '');
    // 单 token 的表头行也存在：「Encoder」「mIOU」各自单独一行。
    // 用长度上限挡住正文里的孤立短句。
    if (tokens.length === 0 || (tokens.length === 1 && text.length > 20)) break;
    // 表头可以带尺寸（「3 × 3 Conv」），所以不能只看数字比例；
    // 真正区分数据行的是百分比/单位列，以及有没有成词的内容。
    if (tokens.some((token) => token.includes('%'))) break;
    const words = tokens.filter((token) => /[A-Za-z一-鿿]{2,}/u.test(token)).length;
    if (words / tokens.length < 0.3) break;

    // PDF 坐标的 y 向上增长：表头在表格上方，y 比数据行更大。
    const gap = line.y - previousY;
    const maxGap = Math.max(18, (line.size ?? 10) * 2.6);
    if (gap < 0 || gap > maxGap) break;

    const x0 = line.x;
    const x1 = line.xEnd;
    if (x0 === null || x1 === null || x1 < minX || x0 > maxX) break;

    out.unshift(line);
    previousY = line.y;
    cursor -= 1;
  }
  return out;
}

/** 表头来源：PDF 原始行，或表格区域里被剥出来的第一行。 */
interface HeaderSource {
  cells: readonly PdfCell[];
  text?: string;
  x?: number | null;
  xEnd?: number | null;
}

/** 把若干表头行按列合并成一行；同一列上的多级表头用空格连起来。 */
function mergeHeaderSources(
  sources: readonly HeaderSource[],
  anchors: readonly ColumnAnchor[],
): PdfCell[] {
  const merged = anchors.map((anchor) => ({ text: '', x: anchor.x, end: anchor.end }));
  for (const source of sources) {
    const cells = headerSourceCells(source);
    const aligned = alignRowToAnchors(cells, anchors, 'header');
    for (let i = 0; i < merged.length; i += 1) {
      const text = aligned[i]?.text ?? '';
      if (text === '') continue;
      const current = merged[i];
      if (current === undefined) continue;
      current.text = current.text === '' ? text : `${current.text} ${text}`;
    }
  }
  return merged;
}

/** 表头行 → 带坐标的单元格。已经有多个片段就直接用，否则按 token 均分 x。 */
function headerSourceCells(source: HeaderSource): PdfCell[] {
  if (source.cells.length >= 2) return normalizeTableCells(source.cells);
  const x0 = source.x;
  const x1 = source.xEnd;
  if (x0 === null || x0 === undefined || x1 === null || x1 === undefined) return [];
  return tokenCells(source.text ?? '', x0, x1);
}

/**
 * 表格区域的第一行是不是表头，而不是数据行。
 *
 * 典型例子是表 2 的「Conv2 Conv3 Structure」：它恰好被 pdfjs 断成了多片段行，
 * 于是混进了数据区。判据看「词」的密度：数据行由数字、百分比、X 组成，
 * 表头行由单词组成。宁可漏剥（表头多一行）也不要错剥 —— 错剥会丢掉一行数据。
 */
function isHeaderLikeRow(row: readonly PdfCell[]): boolean {
  const tokens = row.flatMap((cell) => cell.text.trim().split(/\s+/u)).filter((token) => token !== '');
  if (tokens.length === 0 || tokens.length > 12) return false;
  if (tokens.some((token) => token.includes('%') || /^\d/u.test(token))) return false;
  const words = tokens.filter((token) => /[A-Za-z一-鿿]{3,}/u.test(token));
  return words.length / tokens.length >= 0.5;
}

/**
 * 把一行投影到列锚点上：每个 token 落到中心最近的那一列。
 *
 * 合并单元格会横跨几列，按 token 的估算位置逐個分配，比把整格塞进一列更接近原表。
 * token 的 x 由字符数在单元格宽度内插值 —— 精度只到「词」这一级，但足够分列。
 */
function alignRowToAnchors(
  row: readonly PdfCell[],
  anchors: readonly ColumnAnchor[],
  mode: 'data' | 'header' = 'data',
): PdfCell[] {
  const out = anchors.map((anchor) => ({ text: '', x: anchor.x, end: anchor.end }));
  for (const cell of row) {
    const tokens =
      mode === 'data' && (/[[\]()（）]/u.test(cell.text) || /[A-Za-z一-鿿]{3,}/u.test(cell.text))
        ? splitTrailingNumber(cell)
        : tokenCells(cell.text, cell.x, cell.end);
    for (const token of tokens) {
      const index = nearestAnchor(token, anchors, tokens.length === 1 && tokens[0] === cell);
      const target = out[index];
      if (target === undefined) continue;
      target.text = target.text === '' ? token.text : `${target.text} ${token.text}`;
    }
  }
  return out;
}

/**
 * 带括号的单元格默认整格保留（`[3 × 3, 256] × 2` 拆开就废了），
 * 但后面若还粘着一个独立数字（`HOUS-US (2014) 0.5323`），把它分出去 ——
 * 那个数字属于下一列，留在方法名里会让两列都读错。
 */
function splitTrailingNumber(cell: PdfCell): PdfCell[] {
  if (!/[[\]()（）]/u.test(cell.text)) return [cell];
  const tokens = cell.text.trim().split(/\s+/u).filter((token) => token !== '');
  const last = tokens[tokens.length - 1];
  if (tokens.length < 2 || last === undefined || !looksNumeric(last)) return [cell];
  const head = tokens.slice(0, -1).join(' ');
  const ratio = head.length / Math.max(1, cell.text.trim().length);
  const boundary = cell.x + (cell.end - cell.x) * ratio;
  return [
    { text: head, x: cell.x, end: boundary },
    { text: last, x: boundary, end: cell.end },
  ];
}

/** 按字符数把一段文字拆成带估算坐标的 token；空 token 已被丢弃。 */
function tokenCells(text: string, x0: number, x1: number): PdfCell[] {
  const tokens = text.trim().split(/\s+/u).filter((token) => token !== '');
  if (tokens.length === 0) return [];
  const width = Math.max(1, x1 - x0);
  const weights = tokens.map((token) => Math.max(1, token.length));
  const total = weights.reduce((sum, value) => sum + value, 0) + Math.max(0, tokens.length - 1);
  const out: PdfCell[] = [];
  let cursor = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const weight = weights[i] ?? 1;
    const tokenX = x0 + (width * cursor) / total;
    cursor += weight;
    const tokenEnd = x0 + (width * cursor) / total;
    out.push({ text: tokens[i] ?? '', x: tokenX, end: tokenEnd });
    cursor += 1;
  }
  return out;
}

/** token 落在哪一列：优先有重叠的列，再按中心距离；都没有就取最近的一列。 */
function nearestAnchor(
  token: PdfCell,
  anchors: readonly ColumnAnchor[],
  preferOverlap = false,
): number {
  const center = (token.x + token.end) / 2;
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i];
    if (anchor === undefined) continue;
    const overlap = Math.min(token.end, anchor.end) - Math.max(token.x, anchor.x);
    const distance = Math.abs(center - anchor.center);
    const closeEnough = distance <= Math.max(8, (anchor.end - anchor.x) / 2);
    // 宽单元格（`[3 × 3, 256]`、整句方法名）按重叠面积定列：
    // 它的中心可能落在两列之间，中心最近不等于它实际占了哪一列。
    const score = preferOverlap && overlap > 0 ? -overlap : distance;
    if ((overlap > 0 || closeEnough) && score < bestDistance) {
      best = i;
      bestDistance = score;
    }
  }
  if (best >= 0) return best;

  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i];
    if (anchor === undefined) continue;
    const distance = Math.abs(center - anchor.center);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 把一行对齐到表格的列数。
 *
 * 列数取众数：合并单元格会让个别行多一格或少一格，但大多数行是对的。
 * 少了就把最长的多 token 单元格拆开（表头里「Warping Error Rand Error Pixel Error」
 * 常被 pdfjs 吐成一格）；多了就合并水平间隔最小的一对（「HOUS-US」+「(2014)」）。
 * 这不追求像素级还原，只保证同一列在每一行里说的是同一件事。
 */
function alignTableRow(row: readonly PdfCell[], target: number): PdfCell[] {
  const cells = row.map((cell) => ({ ...cell }));
  if (target < 2) return cells;

  while (cells.length < target) {
    let bestIndex = -1;
    let bestTokens = 1;
    let bestWidth = -1;
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      if (cell === undefined) continue;
      const tokens = cell.text.trim().split(/\s+/u).filter((token) => token !== '').length;
      const width = cell.end - cell.x;
      if (tokens > bestTokens || (tokens === bestTokens && width > bestWidth)) {
        bestIndex = i;
        bestTokens = tokens;
        bestWidth = width;
      }
    }
    if (bestIndex < 0 || bestTokens < 2) break;
    const cell = cells[bestIndex];
    if (cell === undefined) break;
    // 一次拆成「还差几格 + 1」份，而不是递归对半：六个 token 要补三格时，
    // 对半会得到「Warping Error Rand / Error Pixel Error」这种错位分组；
    // 均分成三份才是「Warping Error / Rand Error / Pixel Error」。
    const pieces = Math.min(bestTokens, target - cells.length + 1);
    const parts = splitCellInto(cell, pieces);
    if (parts.length < 2) break;
    cells.splice(bestIndex, 1, ...parts);
  }

  while (cells.length > target) {
    let bestIndex = 0;
    let bestGap = Number.POSITIVE_INFINITY;
    for (let i = 0; i + 1 < cells.length; i += 1) {
      const left = cells[i];
      const right = cells[i + 1];
      if (left === undefined || right === undefined) continue;
      const gap = right.x - left.end;
      if (gap < bestGap) {
        bestGap = gap;
        bestIndex = i;
      }
    }
    const left = cells[bestIndex];
    const right = cells[bestIndex + 1];
    if (left === undefined || right === undefined) break;
    cells.splice(bestIndex, 2, {
      text: `${left.text} ${right.text}`.trim(),
      x: left.x,
      end: right.end,
    });
  }

  return cells;
}

/** 把一个单元格的 token 均分成 `pieces` 份；x 范围按 token 比例插值。 */
function splitCellInto(cell: PdfCell, pieces: number): PdfCell[] {
  const tokens = cell.text.trim().split(/\s+/u).filter((token) => token !== '');
  if (tokens.length < 2 || pieces < 2) return [cell];
  const count = Math.min(pieces, tokens.length);
  const base = Math.floor(tokens.length / count);
  const extra = tokens.length % count;
  const out: PdfCell[] = [];
  let index = 0;
  for (let part = 0; part < count; part += 1) {
    const size = base + (part < extra ? 1 : 0);
    const x = cell.x + (cell.end - cell.x) * (index / tokens.length);
    const end = cell.x + (cell.end - cell.x) * ((index + size) / tokens.length);
    out.push({ text: tokens.slice(index, index + size).join(' '), x, end });
    index += size;
  }
  return out;
}

function makeParsedTable(rows: readonly (readonly string[])[], caption: string | null): ParsedTable {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const pad = (row: readonly string[]): string[] => [
    ...row.map(cleanTableCell),
    ...Array.from({ length: Math.max(0, width - row.length) }, () => ''),
  ];
  return {
    caption: caption === null ? null : cleanTableCell(caption),
    headers: pad(rows[0] ?? []),
    rows: rows.slice(1).map(pad),
  };
}

/** 单元格里的 `|` 会破坏表格的列关系，必须转义；换行压成空格。 */
function cleanTableCell(text: string): string {
  return text.replace(/\s+/gu, ' ').replace(/\|/gu, '\\|').trim();
}

/**
 * 把结构化表格渲染成检索与展示共用的文本：表题 + 表头 + 分隔行 + 数据行。
 *
 * 分隔行（`| --- | --- |`）不是装饰：没有它，一段「表头 + 一行数据」的文本
 * 在嵌入模型眼里与普通段落没有区别；有了它，表头与数据行的关系是显式的，
 * 命中这个块时用户也能一眼看出每一列是什么。
 */
export function renderTableText(table: ParsedTable): string {
  const width = Math.max(1, table.headers.length, ...table.rows.map((row) => row.length));
  const cell = (text: string): string =>
    text.replace(/\s+/gu, ' ').replace(/\\?\|/gu, '\\|').trim();
  const pad = (row: readonly string[]): string[] => [
    ...row.map(cell),
    ...Array.from({ length: Math.max(0, width - row.length) }, () => ''),
  ];
  const lines: string[] = [];
  if (table.caption !== null && table.caption !== '') lines.push(table.caption);
  lines.push(`| ${pad(table.headers).join(' | ')} |`);
  lines.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`);
  for (const row of table.rows) lines.push(`| ${pad(row).join(' | ')} |`);
  return lines.join('\n');
}

/**
 * 第二遍：把没有文字层的页交给 OCR，结果就地写回 perPage。
 * 返回真正识别成功的页数。
 *
 * 【为什么失败不抛错，而是写 warnings】
 *   一份 200 页的文档里有两页扫描图，不该因为这两页识别不了就整份入库失败 ——
 *   另外 198 页是好用的。但**也不能静默**：用户必须知道"这几页搜不到"，
 *   否则又是一次"传了却搜不到"。所以走 warnings。
 */
async function fillPagesWithOcr(
  doc: PdfDocument,
  emptyPages: readonly number[],
  perPage: (PdfLine[] | null)[],
  ocr: ExtractOptions['ocr'],
  warnings: string[],
): Promise<number> {
  const where = formatPages(emptyPages);

  if (ocr === undefined || !ocr.enabled) {
    warnings.push(
      `${where} 没有文字层（扫描件或图片版），而 OCR 已关闭（OCR_ENABLED=0），` +
        `这些页的内容检索不到。`,
    );
    return 0;
  }

  if (!ocrModelsPresent()) {
    // 与"没装 OCR"区分开：这是环境缺件，用户自己能修（重装依赖）。
    warnings.push(
      `${where} 没有文字层，而 OCR 模型文件缺失（依赖没装全），这些页的内容检索不到。` +
        `重新执行一次 npm install 可以补上。`,
    );
    return 0;
  }

  const targets = emptyPages.slice(0, ocr.maxPages);
  const skipped = emptyPages.length - targets.length;
  const unclear: string[] = [];
  let done = 0;
  let failed = 0;

  for (const pageNumber of targets) {
    try {
      const page = await doc.getPage(pageNumber);
      // 换算要用渲染时真实的倍率（超大页会被压下来），所以从 RasterizedPage 上取。
      const image = await renderPageToRgba(page);
      const result = await recognizeImage(image.data, image.width, image.height);

      perPage[pageNumber - 1] = ocrLinesToPdfLines(
        result.lines,
        pageNumber,
        page.getViewport({ scale: 1 }).height,
        image.scale,
      );
      done += 1;
      // 只警告、不删行：低置信度不等于错，删了可能连唯一的内容来源都没了。
      if (result.lines.length > 0 && result.meanConfidence < OCR_LOW_CONFIDENCE) {
        unclear.push(`第 ${pageNumber} 页（${result.meanConfidence.toFixed(2)}）`);
      }
      page.cleanup();
    } catch (err) {
      // 单页失败不该毁掉整份文档：其余页照常入库。
      failed += 1;
      warnings.push(
        `第 ${pageNumber} 页 OCR 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (done > 0) {
    warnings.push(
      `${where} 没有文字层，已用 OCR 识别出文字（共 ${done} 页）。` +
        `OCR 结果可能有个别错字，引用前请核对原件。`,
    );
  }
  if (skipped > 0) {
    // 明确报出"还有多少页没做"：这是"上限存在"的代价，必须让用户看得见，
    // 否则他会以为整本都进来了。
    warnings.push(
      `这份文件有 ${emptyPages.length} 页没有文字层，本次只识别了前 ${targets.length} 页` +
        `（上限由 OCR_MAX_PAGES 控制），其余 ${skipped} 页没有内容。`,
    );
  }
  if (unclear.length > 0) {
    warnings.push(`以下几页识别置信度偏低，结果可能不准，建议核对原件：${unclear.join('、')}。`);
  }
  if (failed > 0 && done === 0) {
    // 全失败和部分失败的说服力不同：全失败时"这份文件搜不到"这句话才成立，
    // 所以这里要显式说清，不能让上面那些逐页错误报成"还有几页没读"的观感。
    warnings.push('这些页的 OCR 全部失败，因此这份文件目前没有任何可检索的内容。');
  }

  return done;
}

/** 把页码串成"第 2、5、7 页"这种可读形式，页数多时截断。 */
function formatPages(pages: readonly number[]): string {
  const head = pages.slice(0, 8).map((n) => `第 ${n} 页`).join('、');
  return pages.length <= 8 ? head : `${head} 等 ${pages.length} 页`;
}

/**
 * OCR 的行 → PdfLine。
 *
 * 坐标要换系：OCR 给的是**像素、原点左上、y 向下**，
 * 而 PdfLine 用的是 **PDF 点、原点左下、y 向上**（见 PdfLine.y）。
 * 页眉页脚判定会把所有页的 y 汇到一起算极差（BOILERPLATE_Y_SPREAD=12），
 * 两套坐标系混在一起的话那个极差毫无意义 —— 页眉页脚就再也认不出来了。
 */
function ocrLinesToPdfLines(
  lines: readonly OcrLine[],
  page: number,
  pageHeightPt: number,
  scale: number,
): PdfLine[] {
  if (lines.length === 0) return [];

  // 阅读顺序：先上边再左边。检测框的数组顺序不保证是按阅读顺序排的。
  const ordered = [...lines].sort((a, b) => a.top - b.top || a.left - b.left);

  return ordered.map((line) => ({
    page,
    text: line.text,
    // 字号置空：OCR 只有框高，而框高与字号在正文/标题之间是重叠的，不能当字号用。
    // 依据与实测数据见 PdfLine.size 的注释。
    size: null,
    y: pageHeightPt - line.top / scale,
    // OCR 只给整行文本框，没有行内片段。因此 OCR 出来的表格不做结构化 ——
    // 没有列坐标，硬猜列边界只会造出比原文更糟的假结构（见 detectPdfTables）。
    x: null,
    xEnd: null,
    cells: [],
  }));
}

/**
 * 剔除页眉 / 页脚 / 水印这类「跨页重复且位置固定」的行。直接在数组上就地改 text，
 * 返回剔除的行数（调用方据此过滤空串）。
 *
 * 判据是【两个信号同时成立】，缺一不可：
 *   1. 归一化后（数字全部换成 #）在至少 3 页、且不少于 25% 的页面上出现；
 *   2. 这些页面上的 y 坐标几乎不动（极差 ≤ 12pt）。
 *
 * 为什么必须有第 2 条 —— 这是实测踩出来的，不是理论推演：
 *   Datawhale 案例集（246 页）里有一组问卷模板行
 *   （「Q3：作为FDE，你应用AI的具体场景是什么？」等 8 行）在 24 个页面上重复出现。
 *   它们是新章节的【正文】，只按频次判定会把 24 页的正文全部删掉。
 *   但它们的 y 在 89~758 之间浮动 —— 因为每章正文的长度不同。
 *   而真正的页眉页脚是排版产物，y 是定死的：
 *     · 「7/243」在 219 页上都出现在 y=46
 *     · DeepLabv3 的两条页眉在 9 页 / 8 页上都出现在 y=692
 *   于是「位置固定」把两者干净地分开了。实测这两份文档的 y 极差分别是 0 和 0，
 *   而误删候选（正文）的极差是 99~669，中间隔着两个数量级。
 *
 * 只认归一化文本 + 位置，不看是否在页边距内：Datawhale 那组正文的 y=758
 * 已经落在页面顶部 14% 以内，位置阈值反而会把它算进来。
 */
function dropRunningHeaders(lines: PdfLine[], pageCount: number): number {
  interface Group {
    pages: Set<number>;
    ys: number[];
    indices: number[];
  }

  const groups = new Map<string, Group>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const key = normalizeBoilerplateKey(line.text);
    if (key === '' || key.length > BOILERPLATE_MAX_CHARS) continue;

    let group = groups.get(key);
    if (group === undefined) {
      group = { pages: new Set(), ys: [], indices: [] };
      groups.set(key, group);
    }
    group.pages.add(line.page);
    group.ys.push(line.y);
    group.indices.push(i);
  }

  const minPages = Math.max(BOILERPLATE_MIN_PAGES, Math.ceil(pageCount * BOILERPLATE_MIN_PAGE_RATIO));
  let dropped = 0;

  for (const group of groups.values()) {
    if (group.pages.size < minPages) continue;
    const spread = Math.max(...group.ys) - Math.min(...group.ys);
    if (spread > BOILERPLATE_Y_SPREAD) continue;

    for (const index of group.indices) {
      const line = lines[index];
      if (line !== undefined && line.text !== '') {
        line.text = '';
        dropped += 1;
      }
    }
  }
  return dropped;
}

/** 页眉页脚跨页重复的判定阈值。三者是一组，改动其一要重新实测校准。 */
/** 至少出现在这么多页上（绝对下限）。 */
const BOILERPLATE_MIN_PAGES = 3;
/** 至少出现在这么大比例的页面上（相对下限，防止 3 页文档被误判）。 */
const BOILERPLATE_MIN_PAGE_RATIO = 0.25;
/** y 坐标极差超过此值就不算「位置固定」。实测真页眉为 0，误删候选为 99+。 */
const BOILERPLATE_Y_SPREAD = 12;
/** 超过这个长度就不参与判定：整段正文偶然重复不该被当页眉删掉。 */
const BOILERPLATE_MAX_CHARS = 120;

/**
 * 把一行归一化成「页眉页脚指纹」：压缩空白、把数字全部替换成 #。
 * 数字是页码，逐页不同，不替换就永远匹配不上同一条页眉。
 */
function normalizeBoilerplateKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').replace(/\d+/g, '#');
}

/**
 * 估计正文字号：全文出现字符数最多的那个字号。
 *
 * 用字符数而不是行数加权 —— 正文字号之所以是正文，正因为它承载的字最多。
 * 按行数加权会让「大量短行」（图注、表格单元格）喧宾夺主。
 * 实测 DeepLabv3：9.96 号 24,609 字 > 8.97 号 19,274 字，取 9.96，与肉眼一致。
 *
 * OCR 行（size === null）不参与：它们没有字号，拿一个假数字混进来会把正文基准拉偏。
 * 整份都是扫描件时返回 0，detectHeading 里 `bodySize > 0` 不成立，
 * 于是字号那两路规则自动失效，只剩编号与固定章节名 —— 这是预期的降级。
 */
function estimateBodyFontSize(lines: readonly PdfLine[]): number {
  const charsBySize = new Map<number, number>();
  for (const line of lines) {
    if (line.size === null) continue;
    charsBySize.set(line.size, (charsBySize.get(line.size) ?? 0) + line.text.length);
  }
  let best = 0;
  let bestChars = -1;
  for (const [size, chars] of charsBySize) {
    if (chars > bestChars) {
      best = size;
      bestChars = chars;
    }
  }
  return best;
}

/**
 * 按「标题 + 段落」把行序列组织成块，并维护章节路径栈。
 *
 * 一条硬约束：段落在页边界处断开（不跨页）。块跨页会让页码归属变含糊，
 * 而「带出处的回答」正是本项目的卖点 —— 宁可多出几个小碎块。
 */
function buildBlocks(lines: readonly PdfLine[], bodySize: number): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const sectionPath: string[] = [];
  const sectionLevels: number[] = [];
  let pending: string[] = [];
  let pendingPage: number | null = null;

  // 先整体判一遍标题，得到与 lines 一一对应的 level 数组。
  // 为什么不在遍历里边读边写一个 prevHeading：那样"上一行是不是标题"要跨循环
  // 迭代传递，状态散在三条分支里；而这里要问的问题本质上是「源行流里紧挨着的
  // 前一行是同级标题吗」，直接查上一行的判定结果即可，没有可变状态。
  const levels = lines.map((line) =>
    line.table === undefined ? detectHeading(line.text, line.size, bodySize) : null,
  );

  const flush = (): void => {
    for (const text of splitIntoParagraphs(pending)) {
      blocks.push({
        page: pendingPage,
        text,
        kind: 'body',
        level: null,
        sectionPath: [...sectionPath],
      });
    }
    pending = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;

    if (line.table !== undefined) {
      // 表格必须整块独立：和上下段落切进同一个块，检索命中时看不出哪几行是表，
      // 切块阶段也无法保证它不被拆开。这里先 flush 再单独产出。
      flush();
      blocks.push({
        page: line.page,
        text: line.text,
        kind: 'table',
        level: null,
        sectionPath: [...sectionPath],
        table: line.table,
      });
      continue;
    }

    const level = levels[i] ?? null;

    if (level !== null) {
      flush();
      const text = line.text.trim();

      // 标题被排版折行时，续行会被当成第二个标题（论文标题两行、案例集里
      // 「Q1：…在这个场景下遇到的」+「具体问题长什么样？」都是这样）。
      // 判据只用「字号相同 + 源行紧邻 + 同一页」，不用行宽 ——
      // 大字号标题虽然占满一栏，字符数却比正文行少得多，按宽度判断会把标题漏掉；
      // 而字号相同又紧邻的两个标题，在实测的两份文档里没有出现过反例。
      //
      // OCR 行（size === null）一律不合并：字号缺失时"字号相同"这个条件恒真，
      // 会把同页相邻的两个标题粘成一个，章节路径里出现两条拼接的标题。
      const prevLine = i > 0 ? lines[i - 1] : undefined;
      const isContinuation =
        levels[i - 1] === level &&
        prevLine !== undefined &&
        prevLine.page === line.page &&
        prevLine.size !== null &&
        line.size !== null &&
        prevLine.size === line.size &&
        Math.abs(prevLine.y - line.y) <= line.size * 2;

      if (isContinuation) {
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock !== undefined) {
          // joinAcrossLineBreak 返回的是「要拼上去的那一段」（供 current += 使用），
          // 不是拼接结果本身 —— 直接拿它赋值会把标题的前半截丢掉。
          lastBlock.text += joinAcrossLineBreak(lastBlock.text, text);
          sectionPath[sectionPath.length - 1] = lastBlock.text;
        }
        continue;
      }

      // 同级或更高级标题出现，弹出它及其所有子级
      truncateSectionPath(sectionPath, sectionLevels, level);
      blocks.push({
        page: line.page,
        text,
        kind: 'heading',
        level,
        sectionPath: [...sectionPath],
      });
      sectionPath.push(text);
      sectionLevels.push(level);
      continue;
    }

    if (pendingPage !== null && pendingPage !== line.page) flush();
    pendingPage = line.page;
    pending.push(line.text);
  }
  flush();
  return blocks;
}

/**
 * 判断一行是不是标题，是则返回层级。
 *
 * 两路信号，因为任何单独一路都不够：
 *   · 字号：DeepLabv3 的一级标题 11.96 明显大于正文 9.96 → 可靠。
 *     但二级标题（"3.1 Encoder-Decoder with Atrous Convolution"）与正文同为 9.96，
 *     字号完全抓不到 —— 这是实测出来的，不是假设。
 *   · 编号：抓二级及以下。要求编号后紧跟【大写字母或汉字】，
 *     否则表格单元格「1.5 cm」「4.2 kg」会被误判成标题（小写开头）。
 */
function detectHeading(text: string, size: number | null, bodySize: number | null): number | null {
  const t = text.trim();
  if (t === '' || t.length > MAX_HEADING_CHARS) return null;

  // 比正文还小的一律不是标题：图注、脚注、表格文字都属于这一类。
  if (size !== null && bodySize !== null && bodySize > 0 && size < bodySize * HEADING_MIN_SIZE_RATIO) {
    return null;
  }

  if (size !== null && bodySize !== null && bodySize > 0 && size >= bodySize * HEADING_SIZE_RATIO) {
    return 1;
  }

  const numbered = /^(\d+(?:\.\d+)+)[\s.、]*([\p{Lu}\p{Lo}])/u.exec(t);
  if (numbered !== null) {
    const depth = (numbered[1] ?? '').split('.').length;
    return clampHeadingLevel(depth);
  }

  if (/^第\s*[一二三四五六七八九十百千零〇\d]+\s*[章节篇]/u.test(t)) return 1;
  if (/^第\s*[一二三四五六七八九十百千零〇\d]+\s*条/u.test(t)) return 2;
  if (/^[一二三四五六七八九十]+\s*[、.．]/u.test(t)) return 2;

  const bare = t.replace(/[\s.。:：、]+$/gu, '').toLowerCase();
  if (COMMON_HEADINGS.has(bare)) return 1;

  return null;
}

/**
 * Markdown 的 ATX 标题（`# 一级` … `###### 六级`）。
 *
 * 为什么要单独认：知识点、经验、SOP 这几类材料几乎没有以 PDF 形式存在的 ——
 * 它们就是 Markdown 文件。少了这条规则，整份 .md 的标题会被当成正文段落，
 * 结果是章节路径全空、块边界也只能靠字符数猜，检索结果里「出自哪一节」这一层
 * 直接丢失。这是静默的质量下降，不会有任何报错提示它发生了。
 *
 * 返回标题文字而不是原行：`#` 号必须剥掉，否则章节路径会显示成「# 总则」。
 */
function parseMarkdownHeading(line: string): { level: number; text: string } | null {
  // `#` 后必须跟空格 —— 否则 `#话题标签`、C# 这类写法会被误判成标题。
  const m = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/u.exec(line.trim());
  if (m === null) return null;
  const level = m[1]?.length ?? 0;
  const text = (m[2] ?? '').trim();
  return text === '' || text.length > MAX_HEADING_CHARS ? null : { level, text };
}

/**
 * 把章节路径栈收缩到第 level 级标题的父层。
 *
 * 不能用 path.length 推断标题级别：文档可能直接从 h2 / 2.1 开始。
 * 若只有一个 h2，下一条 h2 仍是同级，必须弹出它，不能误当作 h1 父级。
 * levels 与 path 同步维护实际标题级别；跳级时保留现有较浅祖先即可。
 */
function truncateSectionPath(path: string[], levels: number[], level: number): void {
  while (levels.length > 0 && (levels[levels.length - 1] ?? 0) >= level) {
    levels.pop();
    path.pop();
  }
}

/** 标题不能太长，否则一句「3.1 的结果比 2.5 好」也会被当成标题。 */
const MAX_HEADING_CHARS = 100;/** 字号达到正文的这个倍数即判定为一级标题。 */
const HEADING_SIZE_RATIO = 1.15;
/** 字号低于正文的这个倍数即排除（图注、脚注）。 */
const HEADING_MIN_SIZE_RATIO = 0.95;
/** 无编号也常见的章节名。比较前已去掉尾部标点并转小写。 */
const COMMON_HEADINGS = new Set([
  'references',
  'bibliography',
  'appendix',
  'acknowledgements',
  'acknowledgments',
  'abstract',
  '摘要',
  '参考文献',
  '致谢',
  '附录',
  '目录',
  '引言',
  '结论',
]);

function clampHeadingLevel(depth: number): number {
  if (depth < 1) return 1;
  return depth > 6 ? 6 : depth;
}

// ── 段落重排（PDF 与纯文本共用） ─────────────────────────────────

/**
 * 把一页的文本行重排成【段落 + 合并掉视觉换行】的形态。
 *
 * 为什么必须做（实测依据）：
 *   PDF 文件里根本不存在"段落"这个概念，只有"文字画在坐标 (x, y)"。
 *   pdfjs 提取时对【每一个视觉行】都补一个 \n，于是：
 *     · 一个自然段被切成 5~8 个视觉行；
 *     · 段落之间与行之间用的是【同一个】\n，无法区分。
 *   实测 DatawhaleFDE案例100.pdf 第 2 页：23 个 \n、0 个 \n\n。
 *   所以"连续两个换行 = 段落"这个常见假设在这里完全不成立 ——
 *   不做处理的话整页会粘成一段，切块切出来的全是断句。
 *
 * 怎么恢复段落边界：靠【行长】。
 *   一段的最后一行通常明显短于版心宽度（因为下一行要另起一段），
 *   而段内各行的长度都接近版心宽度。于是：明显短于典型行宽的行 = 段末。
 *   典型行宽取【中位数】而不是平均数 —— 页眉、页码、居中标题都是离群值，
 *   平均数会被它们拉偏，中位数不会（页眉页脚此时已被剔除，中位数更干净了）。
 *
 * 合并规则（只作用于非段末的换行）：只有换行【两侧都不是中文】时才补空格 ——
 *   西文单词之间必须有空格（"end"+"Next" 粘成 "endNext" 就变了词）；
 *   中文（含中文标点）之间绝不能补（中文本来就不分词）。
 */
function splitIntoParagraphs(lines: readonly string[]): string[] {
  const clean = lines.map((l) => l.replace(/[ \t]+$/u, '')).filter((l) => l.trim() !== '');
  const widths = clean.map((l) => l.trim().length);
  const typicalWidth = median(widths);

  // 行数太少或典型行宽太窄时不做段落推断 —— 封面页、表格页、纯标题页
  // 本来就没有"版心"可参照，硬套会切得比不切还碎。
  const canDetect =
    widths.length >= MIN_LINES_FOR_PARAGRAPH_DETECTION && typicalWidth >= MIN_TYPICAL_WIDTH;
  const threshold = typicalWidth * PARAGRAPH_END_RATIO;

  const paragraphs: string[] = [];
  let current = '';
  let lastLineWidth = 0;

  for (const line of clean) {
    const body = line.trim();
    if (current === '') {
      current = body;
    } else if (canDetect && lastLineWidth < threshold) {
      // 上一行明显短于版心 → 那是一个段落的最后一行
      paragraphs.push(current);
      current = body;
    } else {
      current += joinAcrossLineBreak(current, body);
    }
    lastLineWidth = body.length;
  }
  if (current !== '') paragraphs.push(current);
  return paragraphs;
}

/** 段末判定阈值：行长不足典型行宽的这个比例，即认为该段在此结束。 */
const PARAGRAPH_END_RATIO = 0.7;
/** 典型行宽低于此值就不做段落推断（窄栏、表格、封面）。 */
const MIN_TYPICAL_WIDTH = 20;
/** 页面行数低于此值就不做段落推断（样本太少，中位数没有意义）。 */
const MIN_LINES_FOR_PARAGRAPH_DETECTION = 5;

/**
 * 折行处要不要补空格。
 *
 * 只在一侧是"非中文"时才补：
 *   · 西文单词之间必须有空格，粘在一起会变成另一个词（"end" + "Next" → "endNext"）；
 *   · 中文（含中文标点）之间绝不能补，中文本来就不分词。不判断标点的话
 *     "投稿记录。" 换行后会变成 "投稿记录。 第二行"，展示文本里全是脏空格。
 */
function joinAcrossLineBreak(prev: string, next: string): string {
  const before = lastCodePoint(prev);
  const after = firstCodePoint(next);
  if (before === undefined || after === undefined) return next;
  return isCjkOrCjkPunct(before) || isCjkOrCjkPunct(after) ? next : ` ${next}`;
}

/**
 * 中文文字或中文标点。
 *
 * 比 shared 的 `isCjk` 宽，额外覆盖两个全角标点区：
 *   U+3000–U+303F  、。「」『』〈〉《》【】
 *   U+FF00–U+FFEF  ，．：；？！（）“”‘’
 * 那张表是给检索分词用的（回答"哪些字符要逐字拆开"），标点不需要单独成 token，
 * 所以那边不含标点；这里回答的是另一个问题（"排版折行处要不要空格"），
 * 包含标点才正确。两处刻意不同，不是因为疏漏。
 */
function isCjkOrCjkPunct(cp: number): boolean {
  return isCjk(cp) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef);
}

// ── Word ──────────────────────────────────────────────────────

async function extractDocx(absPath: string): Promise<ParsedDocument> {
  const file = basename(absPath);
  const mammoth = (await import('mammoth')).default;

  let raw: { value: string; messages: { type: string; message: string }[] };
  try {
    // O11：从 extractRawText 改用 convertToHtml。纯文提取会把 `<w:tbl>` 抹平成
    // 一堆段落 —— 「方法 | mIoU」变成「方法 mIoU 78.5」再按行长合并，列关系彻底消失。
    // HTML 形态里 mammoth 保留了 `<table>/<tr>/<td>`，这是我们唯一不引新依赖
    // 还能拿到表格结构的路径。
    raw = await mammoth.convertToHtml({ buffer: readFileSync(absPath) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(
      'invalid_argument',
      `Word 文件解析失败，可能已损坏或不是 .docx 格式：${file}（${msg}）`,
      { cause: err },
    );
  }

  const elements = parseDocxHtml(raw.value ?? '');
  let blocks = blocksFromDocxElements(elements);

  // 极少数文档的转换结果里没有任何 `<p>/<h*>/<table>`（样式全丢、只剩裸文本）。
  // 这时退回纯文本提取，至少别把整份文档判成空的。
  if (elements.length === 0) {
    try {
      const plain = await mammoth.extractRawText({ buffer: readFileSync(absPath) });
      blocks = blocksFromParagraphs(paragraphsFromPlainText(plain.value ?? ''), null);
    } catch {
      // 上面已经成功打开过文件，这里再失败就保持空，由 warnings 说明。
    }
  }

  const warnings = raw.messages.map((m) => `Word 解析提示（${m.type}）：${m.message}`);
  const tableCount = blocks.filter((block) => block.kind === 'table').length;
  if (tableCount > 0) {
    warnings.push(`识别出 ${tableCount} 张表格，已按「表头 + 行」的结构入库。`);
  }
  if (blocks.length === 0) warnings.push('这个 Word 文档里没有提取到文字。');

  return { title: null, author: null, blocks, warnings, droppedBoilerplate: 0, ocrPageCount: 0 };
}

/** Word 转换后的一个结构元素。HTML 形态里 `<table>` 与段落/标题是有序并列的。 */
export interface DocxElement {
  kind: 'heading' | 'paragraph' | 'table';
  level?: number;
  text?: string;
  table?: ParsedTable;
}

/**
 * 解析 mammoth 产出的 HTML。只用正则，不引 DOM 库。
 *
 * 为什么可以不用真正的 HTML 解析器：mammoth 的输出是我们能预期的有限标签集
 * （p / h1–h6 / ul / li / table / tr / td / th / strong / em / br），
 * 且一定良构。为一个有限、内部生成的片段再引一个运行时依赖不值得。
 * 代价是它不适用于任意网页 —— 这个函数只给 Word 解析用。
 */
export function parseDocxHtml(html: string): DocxElement[] {
  const normalized = html.replace(/\r\n?/gu, '\n');
  const elements: DocxElement[] = [];
  const tablePattern = /<table\b[^>]*>[\s\S]*?<\/table>/giu;
  let cursor = 0;

  const pushHtml = (fragment: string): void => {
    const blockPattern = /<(h([1-6])|p|li)\b[^>]*>([\s\S]*?)<\/\1>/giu;
    let match: RegExpExecArray | null;
    while ((match = blockPattern.exec(fragment)) !== null) {
      const tag = (match[1] ?? '').toLowerCase();
      const text = htmlToText(match[3] ?? '', tag === 'p' || tag === 'li');
      if (text === '') continue;
      if (tag.startsWith('h') && tag.length === 2) {
        const level = Number.parseInt(tag.slice(1), 10);
        elements.push({ kind: 'heading', level: Number.isFinite(level) ? level : 1, text });
      } else {
        elements.push({ kind: 'paragraph', text });
      }
    }
  };

  for (;;) {
    tablePattern.lastIndex = cursor;
    const match = tablePattern.exec(normalized);
    if (match === null) {
      pushHtml(normalized.slice(cursor));
      break;
    }
    pushHtml(normalized.slice(cursor, match.index));
    const table = parseHtmlTable(match[0]);
    if (table !== null) elements.push({ kind: 'table', table });
    cursor = match.index + match[0].length;
  }
  return elements;
}

/** `<table>` 片段 → ParsedTable。有 `<thead>` 用它做表头，否则首行做表头。 */
function parseHtmlTable(fragment: string): ParsedTable | null {
  const rows: string[][] = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/giu;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(fragment)) !== null) {
    const cells: string[] = [];
    const cellPattern = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/giu;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellPattern.exec(rowMatch[1] ?? '')) !== null) {
      cells.push(htmlToText(cellMatch[2] ?? '', false));
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return null;

  // `<thead>` 存在时，表头是 thead 里的行；否则约定首行为表头。
  const thead = /<thead\b[^>]*>([\s\S]*?)<\/thead>/iu.exec(fragment);
  let headerRows = 1;
  if (thead !== null) {
    headerRows = (thead[1]?.match(/<tr\b/giu) ?? []).length;
    if (headerRows === 0) headerRows = 1;
  }
  const width = Math.max(1, ...rows.map((row) => row.length));
  const pad = (row: readonly string[]): string[] => [
    ...row.map(cleanTableCell),
    ...Array.from({ length: Math.max(0, width - row.length) }, () => ''),
  ];
  return {
    caption: null,
    headers: pad(rows.slice(0, headerRows).flat()),
    rows: rows.slice(headerRows).map(pad),
  };
}

/**
 * HTML 片段取文本：保留 `<br>` 与段落边界，剥掉其余标签，解实体。
 *
 * `singleLine = true` 用于普通段落：Word 里一个 `<p>` 就是一个自然段，
 * 段落内部不应再被换行切开；单元格则相反，多段内容压成一行才能塞进一格。
 */
function htmlToText(fragment: string, singleLine: boolean): string {
  let text = fragment
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(p|li|div)>/giu, '\n')
    .replace(/<[^>]+>/gu, '');
  text = decodeHtmlEntities(text);
  text = text.replace(/\u00a0/gu, ' ');
  if (singleLine) {
    text = text.replace(/\s*\n\s*/gu, ' ');
  }
  return text.replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim();
}

/** 只解 mammoth 会产出的那几种实体 + 数字实体。 */
function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return named[body.toLowerCase()] ?? whole;
  });
}

/** Word 的结构元素 → 块。标题与编号的判据与纯文本路径共用。 */
export function blocksFromDocxElements(elements: readonly DocxElement[]): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const sectionPath: string[] = [];
  const sectionLevels: number[] = [];

  for (const element of elements) {
    if (element.kind === 'heading' && element.text !== undefined) {
      const text = element.text.trim();
      if (text === '') continue;
      const level = element.level ?? 1;
      truncateSectionPath(sectionPath, sectionLevels, level);
      blocks.push({ page: null, text, kind: 'heading', level, sectionPath: [...sectionPath] });
      sectionPath.push(text);
      sectionLevels.push(level);
      continue;
    }

    if (element.kind === 'paragraph' && element.text !== undefined) {
      for (const text of paragraphsFromPlainText(element.text)) {
        const md = parseMarkdownHeading(text);
        const level = md !== null ? md.level : detectHeading(text, null, null);
        const heading = md !== null ? md.text : text;
        if (level !== null) {
          truncateSectionPath(sectionPath, sectionLevels, level);
          blocks.push({
            page: null,
            text: heading,
            kind: 'heading',
            level,
            sectionPath: [...sectionPath],
          });
          sectionPath.push(heading);
          sectionLevels.push(level);
        } else {
          blocks.push({ page: null, text, kind: 'body', level: null, sectionPath: [...sectionPath] });
        }
      }
      continue;
    }

    if (element.kind === 'table' && element.table !== undefined) {
      // Word 里表题通常是紧挨着表格的一个普通段落。把它从正文里拿掉、
      // 并进表块，否则表题会单独成块，检索到它时看不到表。
      const previous = blocks[blocks.length - 1];
      let table = element.table;
      if (
        previous !== undefined &&
        previous.kind === 'body' &&
        isTableCaptionLine(previous.text)
      ) {
        blocks.pop();
        table = { ...table, caption: previous.text };
      }
      blocks.push({
        page: null,
        text: renderTableText(table),
        kind: 'table',
        level: null,
        sectionPath: [...sectionPath],
        table,
      });
    }
  }
  return blocks;
}

// ── 纯文本 ────────────────────────────────────────────────────

function extractPlainText(absPath: string): ParsedDocument {
  let text: string;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch (err) {
    throw new AppError('invalid_argument', `读取文件失败：${basename(absPath)}`, { cause: err });
  }

  // Markdown 的标题必须按**行**识别：`## 2 采集` 后面可以直接跟正文，
  // 中间不要求空行。先走 paragraphsFromPlainText 会把标题行与正文合成一段，
  // 短正文还会因为总长度不到 100 字被整段当成标题（章节路径里出现整节正文）。
  const paragraphs = paragraphsFromMarkdown(text);
  const blocks = blocksFromParagraphs(paragraphs, null);

  const warnings: string[] = [];
  if (paragraphs.length === 0) warnings.push('文件是空的。');

  return { title: null, author: null, blocks, warnings, droppedBoilerplate: 0, ocrPageCount: 0 };
}

/**
 * Word / 纯文本的段落划分：空行是显式的段落分隔（这两种格式里真的存在空行，
 * 与 PDF 不同），空行内部再按行长推断处理折行。
 */
function paragraphsFromPlainText(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/u)) {
    out.push(...splitIntoParagraphs(chunk.split('\n')));
  }
  return out;
}

/**
 * Markdown / 纯文本的段落划分：**先按行切标题**，再在标题之间做段落推断。
 *
 * 为什么不能复用 `paragraphsFromPlainText`：它按空行分段后再按行长合并折行，
 * 而 Markdown 的 ATX 标题只占一行、下一行可以直接是正文（不要求空行）。
 * 先合并会把两者粘成一段；当这一段不足 100 字时，`parseMarkdownHeading`
 * 会把整段都当成标题文字 —— 章节路径里于是出现「2 采集采样器械使用前须经…」。
 * 这个错误不会报错，只会让"同章节"判断失效，进而让邻近上下文扩展整段失灵。
 *
 * 标题行保留 `#` 前缀交给 `blocksFromParagraphs` 解析：它负责剥掉标记并维护
 * 层级栈，这里只负责**不要在标题与正文之间做折行合并**。
 */
function paragraphsFromMarkdown(text: string): string[] {
  const out: string[] = [];
  let buffer: string[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    out.push(...splitIntoParagraphs(buffer));
    buffer = [];
  };

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      flush();
      continue;
    }
    if (parseMarkdownHeading(trimmed) !== null) {
      flush();
      out.push(trimmed);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out;
}

/**
 * 没有字号信息时的块划分：只能靠编号与固定章节名识别标题。
 *
 * 这条路不可避免会弱一些 —— Word 文件里字体信息在 mammoth 的纯文本提取中同样丢失，
 * 而要拿到它就得改走 HTML 提取（阶段 1 不需要保留 Word 样式，故不做）。
 * 标题识别弱一点不影响检索：段落本身照常切块，只是少了「出自第几节」这一层。
 */
function blocksFromParagraphs(paragraphs: readonly string[], page: number | null): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const sectionPath: string[] = [];
  const sectionLevels: number[] = [];

  for (const text of paragraphs) {
    // Markdown 的 `#` 判在前：它是显式声明，比编号/字号这些推断规则更可靠。
    const md = parseMarkdownHeading(text);
    const level = md !== null ? md.level : detectHeading(text, null, null);
    const heading = md !== null ? md.text : text;

    if (level !== null) {
      truncateSectionPath(sectionPath, sectionLevels, level);
      blocks.push({ page, text: heading, kind: 'heading', level, sectionPath: [...sectionPath] });
      sectionPath.push(heading);
      sectionLevels.push(level);
    } else {
      blocks.push({ page, text, kind: 'body', level: null, sectionPath: [...sectionPath] });
    }
  }
  return blocks;
}

// ── 错误翻译与工具 ─────────────────────────────────────────────

/**
 * 把 pdfjs 抛出的异常翻译成我们能处理的 AppError。
 *
 * 按 name 而不是 instanceof 判断：错误可能来自 pdfjs 内部的另一份副本
 * （依赖树里同时存在多个 pdfjs 版本时尤其如此），instanceof 会失灵，name 不会。
 */
function translatePdfError(err: unknown, file: string): AppError {
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);

  if (name === 'PasswordException' || /password/i.test(msg)) {
    return new AppError('invalid_argument', `PDF 已加密，需要密码才能打开：${file}`, {
      cause: err,
    });
  }

  if (
    name === 'InvalidPDFException' ||
    name === 'FormatError' ||
    /invalid pdf|format error/i.test(msg)
  ) {
    return new AppError(
      'invalid_argument',
      `PDF 文件损坏或格式不合法：${file}。请确认文件能正常打开后重新上传。`,
      { cause: err },
    );
  }

  // 其余一律归 internal：可能是我们这边的环境问题（内存不足、worker 起不来），
  // 报成 invalid_argument 会让使用方以为是自己文件的问题，白白排查。
  return new AppError('internal', `解析 PDF 失败：${file}（${name || '未知错误'}：${msg}）`, {
    cause: err,
  });
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function firstCodePoint(s: string): number | undefined {
  return s === '' ? undefined : s.codePointAt(0);
}

/** 取最后一个 code point。不能直接 codePointAt(length-1)：那会取到低代理项。 */
function lastCodePoint(s: string): number | undefined {
  if (s === '') return undefined;
  let i = s.length - 1;
  const unit = s.charCodeAt(i);
  if (unit >= 0xdc00 && unit <= 0xdfff) i -= 1;
  return s.codePointAt(i);
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}
