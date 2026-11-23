/**
 * 表格解析与切块的接线断言：`npm run verify-tables -w @knowpilot/server`。
 *
 * 【为什么这些断言必须零模型、零真实文件】
 *   表格解析真正容易坏的不是「某个数字对不对」，而是**结构在管线里被悄悄拆掉**：
 *   切块把一张表拆成两块、第二块没有表头；小碎块合并又把表格并进正文；
 *   Word 的 `<table>` 又退回成一行行文字。这些都能用合成数据钉死，
 *   不需要样本 PDF，也不需要 BGE-M3。真实样本只作为可选的回归段，
 *   文件不在时如实记 NOT_RUN，不折算成通过。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config.ts';
import { chunkDocument } from './chunk.ts';
import {
  blocksFromDocxElements,
  detectPdfTables,
  extractDocument,
  parseDocxHtml,
  renderTableText,
  type ParsedBlock,
  type ParsedTable,
  type PdfLine,
} from './extract.ts';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${name}${detail === '' ? '' : ` —— ${detail}`}`);
}

function notRun(name: string, reason: string): void {
  console.log(`  · ${name} —— NOT_RUN（${reason}）`);
}

function tableBlock(table: ParsedTable, page: number | null = null): ParsedBlock {
  return { page, text: renderTableText(table), kind: 'table', level: null, sectionPath: [], table };
}

function bodyBlock(text: string): ParsedBlock {
  return { page: null, text, kind: 'body', level: null, sectionPath: [] };
}

// ── 1. 渲染：表题 / 表头 / 分隔行 / 数据行 ─────────────────────
console.log('\n渲染');
{
  const table: ParsedTable = {
    caption: '表 1. 示例',
    headers: ['方法', 'mIoU'],
    rows: [['U-Net', '78.5'], ['A|B', '80.1']],
  };
  const text = renderTableText(table);
  check('表题在首行', text.startsWith('表 1. 示例'));
  check('表头与分隔行都在', text.includes('| 方法 | mIoU |') && text.includes('| --- | --- |'));
  check('数据行完整', text.includes('| U-Net | 78.5 |') && text.includes('| A\\|B | 80.1 |'));
}

// ── 2. 切块：整表不拆、不与正文合并 ───────────────────────────
console.log('\n切块');
{
  const table: ParsedTable = {
    caption: '表 2. 对比',
    headers: ['方法', 'mIoU'],
    rows: [['U-Net', '78.5'], ['DeepLab', '80.1']],
  };
  const before = '前一段正文。'.repeat(20);
  const after = '后一段正文。'.repeat(20);
  const chunks = chunkDocument([bodyBlock(before), tableBlock(table), bodyBlock(after)]);
  const tableChunks = chunks.filter((chunk) => chunk.text.includes('| 方法 | mIoU |'));
  check('整张表只产生一个块', tableChunks.length === 1, `实际 ${tableChunks.length} 个`);
  const tableChunk = tableChunks[0];
  check(
    '表格块包含表题与全部数据行',
    tableChunk !== undefined &&
      tableChunk.text.startsWith('表 2. 对比') &&
      tableChunk.text.includes('| U-Net | 78.5 |') &&
      tableChunk.text.includes('| DeepLab | 80.1 |'),
  );
  check(
    '表格没有并进正文块',
    chunks.filter((chunk) => chunk !== tableChunk).every((chunk) => !chunk.text.includes('78.5')),
  );
}

// ── 3. 切块：超长表按行拆，每块重复表题与表头 ─────────────────
console.log('\n超长表');
{
  const rows = Array.from({ length: 120 }, (_, index) => [
    String(index + 1),
    `方法 ${index + 1}`,
    (70 + (index % 20) / 10).toFixed(1),
    '这是一段用来把表格撑过上限的说明文字',
  ]);
  const table: ParsedTable = {
    caption: '表 3. 超长表',
    headers: ['序号', '方法', 'mIoU', '说明'],
    rows,
  };
  const chunks = chunkDocument([tableBlock(table)]);
  check('超过上限后拆成多块', chunks.length > 1, `实际 ${chunks.length} 块`);
  check(
    '每块都重复表题与表头',
    chunks.every(
      (chunk) =>
        chunk.text.startsWith('表 3. 超长表') &&
        chunk.text.includes('| 序号 | 方法 | mIoU | 说明 |'),
    ),
  );
  const dataRows = chunks.reduce(
    (sum, chunk) => sum + (chunk.text.match(/^\| \d+ \|/gmu)?.length ?? 0),
    0,
  );
  check('数据行一行不少', dataRows === rows.length, `${dataRows}/${rows.length}`);
  check('每块都没有超过硬上限太多', chunks.every((chunk) => chunk.text.length <= 2600));
}

// ── 4. Word：HTML 表格 → ParsedTable → 表块 ────────────────────
console.log('\nWord 表格');
{
  const html =
    '<h1>实验</h1><p>说明 &amp; 结果</p>' +
    '<table><thead><tr><th>方法</th><th>mIoU</th></tr></thead>' +
    '<tbody><tr><td>U-Net</td><td>78.5</td></tr>' +
    '<tr><td>DeepLab</td><td>80.1</td></tr></tbody></table>';
  const elements = parseDocxHtml(html);
  check(
    '元素顺序与类型正确',
    elements.length === 3 &&
      elements[0]?.kind === 'heading' &&
      elements[1]?.kind === 'paragraph' &&
      elements[2]?.kind === 'table',
  );
  const table = elements[2]?.table;
  check(
    'thead 被当作表头',
    table !== undefined &&
      table.headers.join('|') === '方法|mIoU' &&
      table.rows.length === 2 &&
      table.rows[0]?.join('|') === 'U-Net|78.5',
  );
  check('实体已解码', elements[1]?.text === '说明 & 结果');

  const noHead = parseDocxHtml('<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>');
  const noHeadTable = noHead[0]?.table;
  check(
    '没有 thead 时首行做表头',
    noHeadTable !== undefined &&
      noHeadTable.headers.join('|') === 'A|B' &&
      noHeadTable.rows[0]?.join('|') === '1|2',
  );

  const blocks = blocksFromDocxElements(elements);
  check('Word 表格产出 table 块', blocks.some((block) => block.kind === 'table'));
}

// ── 5. Word：表格前的表题并进表块 ──────────────────────────────
console.log('\nWord 表题');
{
  const elements = parseDocxHtml(
    '<p>表 1. 分割结果</p><table><tr><td>方法</td><td>mIoU</td></tr>' +
      '<tr><td>U-Net</td><td>78.5</td></tr></table>',
  );
  const blocks = blocksFromDocxElements(elements);
  const tables = blocks.filter((block) => block.kind === 'table');
  check('表题没有单独成块', blocks.filter((block) => block.kind === 'body').length === 0);
  check(
    '表题进了 table 块',
    tables.length === 1 &&
      tables[0]?.table?.caption === '表 1. 分割结果' &&
      tables[0]?.text.startsWith('表 1. 分割结果'),
  );
}

// ── 6. PDF：列锚点 + 多行表头（合成坐标） ──────────────────────
console.log('\nPDF 表格识别');
{
  const line = (
    y: number,
    text: string,
    cells: { text: string; x: number; end: number }[],
  ): PdfLine => ({
    page: 1,
    text,
    size: 10,
    y,
    x: cells[0]?.x ?? null,
    xEnd: cells[cells.length - 1]?.end ?? null,
    cells,
  });
  const lines: PdfLine[] = [
    line(130, 'Table 1. 合成示例', [{ text: 'Table 1. 合成示例', x: 100, end: 200 }]),
    line(115, 'Alpha Beta Gamma', [{ text: 'Alpha Beta Gamma', x: 100, end: 310 }]),
    line(100, 'X 16 78.5%', [
      { text: 'X', x: 100, end: 110 },
      { text: '16', x: 200, end: 210 },
      { text: '78.5%', x: 300, end: 310 },
    ]),
    line(90, 'X 8 79.1%', [
      { text: 'X', x: 100, end: 110 },
      { text: '8', x: 200, end: 210 },
      { text: '79.1%', x: 300, end: 310 },
    ]),
    line(80, 'X 32 80.2%', [
      { text: 'X', x: 100, end: 110 },
      { text: '32', x: 200, end: 210 },
      { text: '80.2%', x: 300, end: 310 },
    ]),
  ];
  const result = detectPdfTables(lines);
  const table = result.lines.find((item) => item.table !== undefined)?.table;
  check('识别出一张表', result.count === 1);
  check('表题被带上', table?.caption === 'Table 1. 合成示例');
  check(
    '三列锚点各自拿到表头',
    table !== undefined &&
      table.headers.length === 3 &&
      table.headers[0]?.includes('Alpha') === true &&
      table.headers[1]?.includes('Beta') === true &&
      table.headers[2]?.includes('Gamma') === true,
  );
  check(
    '数据行对齐到三列',
    table !== undefined &&
      table.rows.length === 3 &&
      table.rows[0]?.join('|') === 'X|16|78.5%' &&
      table.rows[2]?.join('|') === 'X|32|80.2%',
  );

  const prose = [
    line(100, '第一段很长很长……', [
      { text: '第一段很长很长，长到不像表格的一格，而像正文的一半。', x: 100, end: 400 },
      { text: '第二段也很长，长到这张表不该被识别成表格。', x: 420, end: 700 },
    ]),
    line(90, '第三段同样很长……', [
      { text: '第三段同样很长，长到不像表格的一格，而是双栏正文。', x: 100, end: 400 },
      { text: '第四段也很长，长到这张表不该被识别成表格。', x: 420, end: 700 },
    ]),
  ];
  check('双栏长句不会被误判成表', detectPdfTables(prose).count === 0);
}

// ── 7. 真实样本（可选） ────────────────────────────────────────
console.log('\n真实样本');
{
  const cfg = loadConfig();
  const sample = resolve(cfg.repoRoot, 'data/uploads/Deeplabv3.pdf');
  if (!existsSync(sample)) {
    notRun('Deeplabv3 样本回归', '样本文件不在 data/uploads');
  } else {
    const doc = await extractDocument(sample, {
      ocr: { enabled: cfg.ocrEnabled, maxPages: cfg.ocrMaxPages },
    });
    const tables = doc.blocks.filter((block) => block.kind === 'table');
    check('识别出 7 张表', tables.length === 7, `实际 ${tables.length} 张`);
    check(
      '表 3 的表头包含 Multiply-Adds',
      tables.some(
        (block) =>
          block.text.includes('Table 3.') &&
          block.text.includes('Multiply-Adds') &&
          block.text.includes('mIOU'),
      ),
    );
    check(
      '表 4 的列关系正确',
      tables.some(
        (block) =>
          block.text.includes('| Model | Top-1 Error | Top-5 Error |') &&
          block.text.includes('| Reproduced ResNet-101 | 22.40% | 6.02% |'),
      ),
    );
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}。`);
if (failed > 0) process.exitCode = 1;
