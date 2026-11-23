/**
 * 解析验证工具：npm run extract -- <文件路径>
 *
 * 为什么需要它：
 *   解析质量决定了后面所有检索的质量，但解析结果在界面上是看不见的 ——
 *   界面只显示命中的那一小段。没有这个工具，就没法回答
 *   "这份论文到底解析出来没有、中文对不对、页码在不在、章节认没认对"。
 *   等到检索出问题再回头查解析，就分不清是解析错了还是切块错了。
 *
 * 用法：
 *   npm run extract -w @knowpilot/server -- "path/to/paper.pdf"
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { loadConfig } from '../config.ts';
import { extractDocument } from './extract.ts';

async function main(): Promise<void> {
  const input = process.argv[2];
  if (input === undefined || input.trim() === '') {
    console.error('用法：npm run extract -w @knowpilot/server -- <文件路径>');
    process.exitCode = 1;
    return;
  }

  // 相对路径锚定到仓库根，不是 cwd ——
  // `npm run -w <子包>` 会把 cwd 切到 apps/server，用 cwd 解析会让
  // 同一个相对路径在两个入口下指向不同文件（阶段 0 踩过的坑）。
  const cfg = loadConfig();
  const abs = isAbsolute(input) ? input : resolve(cfg.repoRoot, input);
  if (!existsSync(abs)) {
    console.error(`文件不存在：${abs}`);
    process.exitCode = 1;
    return;
  }

  const startedAt = Date.now();
  // 与入库走同一套 OCR 策略，否则这个工具的结论不能代表真实入库结果 ——
  // 而它存在的意义正是"在入库之前先看清解析质量"。
  const doc = await extractDocument(abs, {
    ocr: { enabled: cfg.ocrEnabled, maxPages: cfg.ocrMaxPages },
  });
  const elapsedMs = Date.now() - startedAt;

  const body = doc.blocks.filter((b) => b.kind === 'body');
  const headings = doc.blocks.filter((b) => b.kind === 'heading');
  const totalChars = doc.blocks.reduce((n, b) => n + b.text.length, 0);
  const hasPageNumbers = doc.blocks.some((b) => b.page !== null);

  console.log(`文件      : ${abs}`);
  console.log(`标题      : ${doc.title ?? '(元数据里没有)'}`);
  console.log(`作者      : ${doc.author ?? '(元数据里没有)'}`);
  console.log(
    `文本块数  : ${doc.blocks.length}（正文 ${body.length} + 标题 ${headings.length}）` +
      `${hasPageNumbers ? '，每块带页码' : '，无页码（Word/纯文本）'}`,
  );
  console.log(`总字符数  : ${totalChars.toLocaleString()}`);
  console.log(`耗时      : ${elapsedMs} ms`);
  if (hasPageNumbers) {
    console.log(`剔除的页眉页脚行：${doc.droppedBoilerplate}`);
  }
  if (doc.ocrPageCount > 0) {
    // 这一行是"解析慢"的唯一解释：OCR 约 2 秒/页，比取文字层慢两个数量级。
    console.log(`OCR       : ${doc.ocrPageCount} 页（识别结果可能有错字，引用前需核对原件）`);
  }

  if (doc.warnings.length > 0) {
    console.log('警告      :');
    for (const w of doc.warnings) console.log(`  - ${w}`);
  }

  printOutline(doc);

  // 抽样优先取正文：标题块通常只有一行，抽到它看不出解析质量。
  const bodies = doc.blocks.filter((b) => b.kind === 'body' && b.text.length > 0);
  const nonEmpty = bodies.length > 0 ? bodies : doc.blocks.filter((b) => b.text.length > 0);
  const head = nonEmpty[0];
  if (head === undefined) {
    console.log('\n没有任何可展示的内容。');
    process.exitCode = 1;
    return;
  }

  // 抽样两处：开头（看元信息、摘要、标题层级有没有串）和中部（看正文有没有丢字）
  const mid = nonEmpty[Math.floor(nonEmpty.length / 2)] ?? head;
  printSample('开头', head, 400);
  if (mid !== head) printSample('中部', mid, 300);

  // 段落结构是"解析有没有做好"的核心指标，但肉眼很难判断，直接给统计：
  const paragraphCount = body.reduce((n, b) => n + 1, 0);
  const bodyChars = body.reduce((n, b) => n + b.text.length, 0);
  const avgLen = paragraphCount === 0 ? 0 : Math.round(bodyChars / paragraphCount);
  console.log(`\n段落统计  : 约 ${paragraphCount} 段，平均每段 ${avgLen} 字`);

  // 段落数恰好等于页数 = 每页只切出一段，说明行长推断没生效（整页粘成一段）。
  // 这时切块会切出断句，检索仍能用，但回答质量会明显变差 —— 必须报出来。
  const pageCount = new Set(doc.blocks.map((b) => b.page)).size;
  if (paragraphCount === pageCount && pageCount >= 5 && avgLen > 200) {
    console.log('  ⚠ 每页只有一段，且段落很长：段落边界推断没有生效。');
    console.log('    切块时会切出半句话，检索结果的可读性会受影响。');
  }

  // 标题一个都没认出来，说明这份文档的标题既不是"字号更大"也没有编号 ——
  // 章节路径这一层就白做了，必须报出来而不是静默降级。
  if (hasPageNumbers && headings.length === 0) {
    console.log('  ⚠ 没有识别出任何标题：切块时不会有章节路径。');
    console.log('    请检查这份文档的标题是否既无编号、字号也与正文相同。');
  }
}

/** 打印章节大纲 —— 这是"结构感知"是否生效的唯一肉眼可见证据。 */
function printOutline(doc: { blocks: readonly { kind: string; level: number | null; text: string; page: number | null }[] }): void {
  const headings = doc.blocks.filter((b) => b.kind === 'heading');
  if (headings.length === 0) return;
  console.log(`\n─── 章节大纲（${headings.length} 个标题）───`);
  for (const h of headings) {
    const indent = '  '.repeat(Math.max(0, (h.level ?? 1) - 1));
    const page = h.page === null ? '' : `  p${h.page}`;
    console.log(`  ${indent}${h.text.slice(0, 72)}${page}`);
  }
}

function printSample(
  label: string,
  block: { page: number | null; text: string; sectionPath: readonly string[] },
  max: number,
): void {
  const where = block.page === null ? label : `${label} · 第 ${block.page} 页`;
  const section = block.sectionPath.length > 0 ? `   所属章节：${block.sectionPath.join(' > ')}` : '';
  console.log(`\n─── 抽样：${where}（前 ${max} 字）───${section}`);
  console.log(block.text.slice(0, max));
}

main().catch((err: unknown) => {
  console.error('\n解析失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
