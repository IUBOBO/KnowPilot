import { AppError } from '@knowpilot/shared';
import { GlobalFonts, PDFDocument, type CanvasRenderingContext2D } from '@napi-rs/canvas';
import { bodyKinds, mapNoteInline, readNoteTable } from './markdown.ts';
import { noteMetadata, RESTRICTED_EXPORT_NOTICE, SOURCE_ACCESS_NOTICE, type NoteExport } from './snapshot.ts';

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const PAGE_BOTTOM = PAGE_HEIGHT - MARGIN - 12;
const FONTS = [
  'SimHei', 'Microsoft YaHei', 'SimSun', 'PingFang SC', 'Noto Sans CJK SC',
  'Noto Sans SC', 'Source Han Sans SC', 'WenQuanYi Zen Hei', 'Droid Sans Fallback',
];
const GRAPHEMES = new Intl.Segmenter('zh', { granularity: 'grapheme' });

function wrap(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const { segment } of GRAPHEMES.segment(text.replace(/\t/gu, '    '))) {
    if (line !== '' && context.measureText(line + segment).width > width) {
      lines.push(line);
      line = '';
    }
    line += segment;
  }
  lines.push(line);
  return lines;
}

function printText(text: string): string {
  return mapNoteInline(text, (prose) => prose
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/gu, (_, alt: string) => '图表：' + (alt || '未提供说明'))
    .replace(/\[([^\]]+)\]\([^\n)]*\)/gu, '$1')
    .replace(/\*\*([^*\n]+)\*\*/gu, '$1'));
}

export function renderNotePdf(note: NoteExport): Buffer {
  const family = FONTS.find((name) => GlobalFonts.has(name));
  if (family === undefined) {
    throw new AppError('internal', '服务缺少中文 PDF 字体。可下载 Markdown，或请管理员安装 Noto Sans CJK SC 后重试。');
  }
  const pdf = new PDFDocument({ title: note.title, creator: 'KnowPilot' });
  let page = pdf.beginPage(PAGE_WIDTH, PAGE_HEIGHT);
  let pageNumber = 1;
  let y = MARGIN;
  const latin = ['Arial', 'Liberation Sans', 'DejaVu Sans'].find((name) => GlobalFonts.has(name));
  const families = (latin === undefined ? '' : '"' + latin + '", ') + '"' + family + '", sans-serif';
  const font = (size: number, bold = false) => (bold ? 'bold ' : '') + String(size) + 'px ' + families;

  function endPage() {
    page.font = font(9);
    page.textBaseline = 'top';
    page.fillStyle = '#475569';
    page.fillText('KnowPilot  ·  ' + String(pageNumber), MARGIN, PAGE_BOTTOM + 20);
    pdf.endPage();
  }

  function newPage() {
    endPage();
    page = pdf.beginPage(PAGE_WIDTH, PAGE_HEIGHT);
    pageNumber += 1;
    y = MARGIN;
  }

  function text(content: string, size = 11, bold = false, spacing = 4, indent = 0): void {
    const lineHeight = size + 5;
    const style = font(size, bold);
    const renderText = (line: string) => {
      page.font = style;
      page.textBaseline = 'top';
      page.fillStyle = '#17233a';
      page.fillText(line, MARGIN + indent, y);
      y += lineHeight;
    };
    page.font = style;
    for (const line of wrap(page, content.replace(/[\r\n\u2028\u2029]+/gu, ' '), CONTENT_WIDTH - indent)) {
      if (y + lineHeight > PAGE_BOTTOM) newPage();
      renderText(line);
    }
    y += spacing;
  }

  function table(headers: readonly string[], rows: readonly (readonly string[])[]): void {
    // Split wide tables into bands with repeated first column instead of shrinking the font.
    if (headers.length > 5) {
      for (let start = 1; start < headers.length; start += 4) {
        table(
          [headers[0]!, ...headers.slice(start, start + 4)],
          rows.map((row) => [row[0]!, ...row.slice(start, start + 4)]),
        );
      }
      return;
    }
    const columnWidth = CONTENT_WIDTH / headers.length;
    const line = 15;
    const padding = 5;
    const rowWrap = (cells: readonly string[], bold = false) => {
      page.font = font(10, bold);
      return cells.map((value) => wrap(page, printText(value), columnWidth - 2 * padding));
    };
    let header = rowWrap(headers, true);
    let headerLength = Math.max(...header.map((column) => column.length));
    if (headerLength > 12) {
      // Long labels remain intact above the table; the repeating header stays short enough for data.
      for (const [index, title] of headers.entries()) text('列 ' + String(index + 1) + '：' + printText(title), 10);
      header = headers.map((_, index) => ['列 ' + String(index + 1)]);
      headerLength = 1;
    }
    const headerHeight = headerLength * line + 2 * padding;
    function paintRow(wrapped: readonly string[][], offset: number, count: number, bold: boolean) {
      const height = count * line + 2 * padding;
      page.font = font(10, bold);
      page.textBaseline = 'top';
      for (let i = 0; i < wrapped.length; i += 1) {
        const x = MARGIN + i * columnWidth;
        page.fillStyle = bold ? '#e7eef7' : '#ffffff';
        page.fillRect(x, y, columnWidth, height);
        page.strokeStyle = '#9aaac0';
        page.lineWidth = 0.5;
        page.strokeRect(x, y, columnWidth, height);
        page.fillStyle = '#17233a';
        wrapped[i]!.slice(offset, offset + count).forEach((value, row) => {
          page.fillText(value, x + padding, y + padding + row * line);
        });
      }
      y += height;
    }
    function nextTablePage() {
      newPage();
      paintRow(header, 0, headerLength, true);
    }
    if (y + headerHeight + line + 2 * padding > PAGE_BOTTOM) newPage();
    paintRow(header, 0, headerLength, true);
    for (const row of rows) {
      const wrapped = rowWrap(row);
      const length = Math.max(...wrapped.map((column) => column.length));
      const freshCapacity = Math.floor((PAGE_BOTTOM - MARGIN - headerHeight - 2 * padding) / line);
      const remainingCapacity = () => Math.floor((PAGE_BOTTOM - y - 2 * padding) / line);
      // Keep ordinary rows whole and split only cells too tall for a fresh page.
      if (length <= freshCapacity && length > remainingCapacity()) nextTablePage();
      for (let offset = 0; offset < length;) {
        if (remainingCapacity() < 1) nextTablePage();
        const count = Math.min(length - offset, remainingCapacity());
        paintRow(wrapped, offset, count, false);
        offset += count;
      }
    }
    y += 8;
  }

  function body(markdown: string) {
    const lines = markdown.split(/\r\n?|\n/u);
    const kinds = bodyKinds(lines);
    for (let i = 0; i < lines.length;) {
      const value = lines[i]!;
      const kind = kinds[i++];
      if (kind === 'fence') continue;
      if (kind === 'code' || kind === 'math') {
        text(value, 10, false, 0, 8);
        continue;
      }
      const parsed = readNoteTable(lines, kinds, i - 1);
      if (parsed !== null) {
        table(parsed.headers, parsed.rows);
        i = parsed.end;
        continue;
      }
      const heading = /^(#{1,6})[ \t]+(.+)$/u.exec(value);
      const list = /^([ \t]*)([-+*]|\d{1,9}[.)])[ \t]+(.+)$/u.exec(value);
      if (heading !== null) text(printText(heading[2]!), heading[1]!.length <= 2 ? 15 : 13, true, 6);
      else if (list !== null) {
        const indent = 8 + Math.min(40, list[1]!.replace(/\t/gu, '    ').length * 4);
        const mark = /[0-9]/u.test(list[2]!) ? list[2] : '•';
        text(mark + ' ' + printText(list[3]!), 11, false, 2, indent);
      } else if (value.trim() === '') y += 7;
      else text(printText(value));
    }
  }

  text(note.title, 22, true, 12);
  if (note.restricted) text(RESTRICTED_EXPORT_NOTICE);
  else {
    for (const entry of noteMetadata(note)) text(entry, 10, false, 2);
    y += 8;
    body(note.body);
  }
  text('来源与访问条件', 15, true, 6);
  text(SOURCE_ACCESS_NOTICE, 10);
  if (note.sources.length === 0) text('本笔记未关联可核验的来源。', 10);
  for (const source of note.sources) text(source, 10);
  endPage();
  return pdf.close();
}
