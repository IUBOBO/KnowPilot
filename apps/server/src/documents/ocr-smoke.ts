/**
 * OCR 冒烟测试：确认"没有文字层的页"真的能被认出来，且降级路径写在明处。
 *
 * 用法：npm run ocr-smoke -w @knowpilot/server [源 PDF 路径]
 *
 * 【为什么需要它】OCR 这一路最容易出的问题全都是**静默**的：
 *   模型文件没找到 → 返回空；坐标换错系 → 页码/页眉页脚判定全错但正文照出；
 *   页数上限算错 → 少识别几页而用户不知道。这些都不会抛错，
 *   在界面上只表现为"这份文档搜不全"，回头根本分不清是哪一段的锅。
 *
 * 【怎么造测试件】不往仓库里塞扫描件二进制，而是**现场生成**：
 *   取一份真实 PDF 的前几页，渲染成 JPEG，再手写一份只含图像、没有文字层的
 *   最小 PDF（/DCTDecode 图像 XObject）。这样就得到一个可控的"扫描件"，
 *   且它的正确答案（原文）是已知的 —— 可以拿识别结果去比对。
 *
 * 【为什么这里要 import embed.ts】
 *   不是为了向量化，而是为了让**这个进程的模块图和服务端一致**。
 *   embed.ts 会 import @huggingface/transformers，而那个包在顶层就 require('sharp')。
 *   这个 bug 真发生过：OCR 包和 transformers 各带一份 sharp（两份 libvips，
 *   同进程里互相破坏 GObject 类型注册），服务端每页 OCR 都抛
 *   `colourspace: parameter space not set`，而这个脚本当时**全绿** ——
 *   因为它没 import transformers，进程里只有 OCR 那份 sharp，冲突压根不出现。
 *   教训：冒烟测试若只加载被测模块、不加载真实服务的其余模块，
 *   所有"进程级全局状态"类的问题都会被它漏掉。
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { loadConfig } from '../config.ts';
// 仅为对齐模块图，见文件头注释。没有它，下面 ③ 的正确性不代表真实服务。
import './embed.ts';
import { extractDocument } from './extract.ts';
import { renderPageToRgba } from './rasterize.ts';

/** 生成的 PDF 里每页图像占多少 PDF 点。与 RENDER_SCALE 对应的"1 倍"尺寸。 */
const FIXTURE_PAGES = 3;

/** 从原页文本里挑出来的特征词：识别结果里出现即说明认得对。 */
const KEYWORDS = ['低空技术与工程', '计算机科学与技术', '学科代码'];

const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`);
  if (!ok) failures.push(label);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const source = resolveSource(cfg.repoRoot);
  console.log(`源 PDF  : ${source}\n`);

  const fixturePath = join(cfg.repoRoot, 'data', 'ocr-smoke-fixture.pdf');
  mkdirSync(dirname(fixturePath), { recursive: true });

  try {
    const { jpegPages, sourceText } = await buildFixture(source, fixturePath);
    console.log(`测试件  : ${fixturePath}（${jpegPages} 页，全部只有图像、无文字层）\n`);

    // ── ⓪ 依赖前提：全树只能有一份 sharp ──
    // 这条放在最前面：它是"能不能跑"的前提，不是 OCR 本身的性质。
    // 两份 sharp = 两份 libvips，OCR 会在真实服务里整页整页地失败（详见文件头）。
    console.log('⓪ 依赖前提：OCR 包与 transformers 必须共用同一份 sharp（= 同一份 libvips）');
    const sharpPaths = resolveSharpPaths();
    check(
      'OCR 包解析到的 sharp 与本进程是同一个文件',
      sharpPaths.ok,
      sharpPaths.detail,
    );

    // ── ① 先确认这个测试件确实没有文字层 ──
    // 这一步不能省：如果生成出来的 PDF 意外带了文字层，后面所有断言都会因为
    // "走的是正常路径"而通过，看起来一切正常，实际 OCR 一行都没跑。
    console.log('① 没有文字层时，OCR 关闭应当"一张块都没有、且写明原因"');
    const off = await extractDocument(fixturePath, { ocr: { enabled: false, maxPages: 10 } });
    check('提取不到任何文本块', off.blocks.length === 0, `实际 ${off.blocks.length} 块`);
    check('ocrPageCount 为 0', off.ocrPageCount === 0);
    check(
      '警告里点明是 OCR 被关掉，而不是含糊的"没有文字层"',
      off.warnings.some((w) => w.includes('OCR 已关闭')),
      off.warnings[0]?.slice(0, 60) ?? '(没有警告)',
    );

    // ── ② 页数上限：超出部分必须被明确报出来，不能静默少认 ──
    console.log('\n② 上限为 1 页时，应当只认 1 页，并报出还剩几页没做');
    const capped = await extractDocument(fixturePath, { ocr: { enabled: true, maxPages: 1 } });
    check('只识别了 1 页', capped.ocrPageCount === 1, `实际 ${capped.ocrPageCount} 页`);
    check(
      '警告里写明了剩余页数',
      capped.warnings.some((w) => w.includes(`其余 ${FIXTURE_PAGES - 1} 页`)),
      capped.warnings.find((w) => w.includes('其余'))?.slice(0, 70) ?? '(没有这条警告)',
    );

    // ── ③ 完整跑一遍：内容认得对不对 ──
    console.log(`\n③ 全部 ${FIXTURE_PAGES} 页都识别`);
    const t0 = Date.now();
    const full = await extractDocument(fixturePath, { ocr: { enabled: true, maxPages: 10 } });
    const elapsed = Date.now() - t0;
    check('识别页数正确', full.ocrPageCount === FIXTURE_PAGES, `实际 ${full.ocrPageCount} 页`);
    check('切出了文本块', full.blocks.length > 0, `${full.blocks.length} 块`);
    check(
      '警告里说明了这批文字来自 OCR（引用前需核对）',
      full.warnings.some((w) => w.includes('OCR') && w.includes('核对原件')),
    );

    const text = full.blocks.map((b) => b.text).join('');
    const hits = KEYWORDS.filter((k) => text.includes(k));
    check(
      `特征词至少认对一半（${hits.join('、') || '一个都没有'}）`,
      hits.length >= Math.ceil(KEYWORDS.length / 2),
      `${hits.length}/${KEYWORDS.length}`,
    );
    check('识别出的文字与原文字符重合度 > 60%', overlap(sourceText, text) > 0.6,
      `${(overlap(sourceText, text) * 100).toFixed(1)}%`);
    check('每块都带页码', full.blocks.every((b) => b.page !== null));
    check(
      '页数没有串号（都落在 1..3）',
      full.blocks.every((b) => (b.page ?? 0) >= 1 && (b.page ?? 0) <= FIXTURE_PAGES),
    );
    // 单页 2 秒上下；明显超出说明每页都在重建引擎（见 ocr.ts 的 enginePromise 缓存）。
    const perPage = elapsed / FIXTURE_PAGES;
    check('每页耗时在合理区间（含首次加载模型）', perPage < 15_000, `${Math.round(perPage)} ms/页`);

    console.log('\n─── 识别结果抽样（第 1 页前 200 字）───');
    const first = full.blocks.find((b) => b.page === 1);
    console.log(first?.text.slice(0, 200) ?? '(第 1 页没有内容)');
  } finally {
    // 测试件是我生成的，跑完就清掉，不留垃圾在 data/ 里 ——
    // 除非显式要留下（用来手动走一遍界面上传，验证 HTTP 那一段的接线）。
    if (process.env['OCR_SMOKE_KEEP'] === '1') {
      console.log(`\n（OCR_SMOKE_KEEP=1，测试件保留在 ${fixturePath}）`);
    } else {
      rmSync(fixturePath, { force: true });
    }
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`OCR 冒烟失败，共 ${failures.length} 项：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log('OCR 冒烟全部通过。');
}

/**
 * 源 PDF：命令行参数优先，否则在 data/uploads 里挑一份**有文字层**的 PDF。
 *
 * 为什么要自己挑：这份测试件是把"已知正确的原文"渲染成图再认回来，
 * 所以源文件必须能取出原文 —— 一份本身就是扫描件的 PDF 当不了源。
 */
function resolveSource(repoRoot: string): string {
  const input = process.argv[2];
  if (input !== undefined && input.trim() !== '') {
    const abs = isAbsolute(input) ? input : resolve(repoRoot, input);
    if (!existsSync(abs)) throw new Error(`文件不存在：${abs}`);
    return abs;
  }

  const dir = join(repoRoot, 'data', 'uploads');
  const candidates = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf'))
    : [];
  if (candidates.length === 0) {
    throw new Error(
      `data/uploads 里没有 PDF。请指定一份：npm run ocr-smoke -w @knowpilot/server -- <路径>`,
    );
  }
  // 实测这份公文有文字层且是中文正文，适合当"已知正确答案"的源。
  const preferred = candidates.find((f) => f.startsWith('11e5c4b1'));
  return join(dir, preferred ?? candidates[0] ?? '');
}

/**
 * 生成测试件：把源 PDF 的前 N 页渲染成 JPEG，写进一份只有图像的 PDF。
 * 返回一页的原始文字（用来比对识别质量）。
 */
async function buildFixture(
  source: string,
  outPath: string,
): Promise<{ jpegPages: number; sourceText: string }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(source)),
    useSystemFonts: false,
    isEvalSupported: false,
  }).promise;

  const count = Math.min(FIXTURE_PAGES, doc.numPages);
  if (count < FIXTURE_PAGES) {
    throw new Error(`源文件只有 ${doc.numPages} 页，测试件需要 ${FIXTURE_PAGES} 页。`);
  }

  const images: { jpeg: Buffer; width: number; height: number; boxW: number; boxH: number }[] = [];
  let sourceText = '';

  for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    if (pageNumber === 1) {
      const content = await page.getTextContent();
      for (const item of content.items) {
        const str = (item as { str?: unknown }).str;
        if (typeof str === 'string') sourceText += str;
      }
    }

    // 复用生产代码那套渲染，保证测试件与真实 OCR 输入同源：
    // 走的是 renderPageToRgba，也就是 OCR 实际拿到的像素。
    const raster = await renderPageToRgba(page);
    const canvas = createCanvas(raster.width, raster.height);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(raster.data, raster.width, raster.height), 0, 0);
    const jpeg = await canvas.encode('jpeg', 92);

    // PDF 尺寸取"1 倍"的页面尺寸，这样渲染测试件时的倍率仍是 2，
    // 与生产路径的坐标换算一致（页高用于把像素 y 换回 PDF y）。
    const base = page.getViewport({ scale: 1 });
    images.push({
      jpeg,
      width: raster.width,
      height: raster.height,
      boxW: round2(base.width),
      boxH: round2(base.height),
    });
    page.cleanup();
  }
  await doc.destroy();

  writeFileSync(outPath, writeImageOnlyPdf(images));
  return { jpegPages: count, sourceText };
}

interface FixtureImage {
  jpeg: Buffer;
  width: number;
  height: number;
  boxW: number;
  boxH: number;
}

/**
 * 手写一份最小 PDF：每页只有一张整页 JPEG。
 *
 * 为什么不引 pdf-lib 之类的库：这份测试件的全部价值在于**它一定没有文字层**，
 * 而"往 PDF 里塞一张图"只需要 5 类对象。多引一个库，就多一处
 * "库升级后顺手加了点什么"的可能，而这个前提一旦破了，测试会静默失效。
 *
 * 对象编号：1 目录、2 页面树、3..2+P 页面、3+P..2+2P 图像、3+2P..2+3P 内容流。
 */
function writeImageOnlyPdf(images: readonly FixtureImage[]): Buffer {
  const P = images.length;
  const pageObj = (i: number): number => 3 + i;
  const imageObj = (i: number): number => 3 + P + i;
  const contentObj = (i: number): number => 3 + 2 * P + i;
  const total = 2 + 3 * P;

  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let cursor = 0;

  const push = (b: Buffer | string): void => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    chunks.push(buf);
    cursor += buf.length;
  };

  const addObject = (index: number, dict: string, stream?: Buffer): void => {
    offsets[index] = cursor;
    push(`${index} 0 obj\n${dict}\n`);
    if (stream !== undefined) {
      push('stream\n');
      push(stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  };

  push('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  addObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObject(
    2,
    `<< /Type /Pages /Kids [${images.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${P} >>`,
  );

  images.forEach((img, i) => {
    const content = `q\n${img.boxW} 0 0 ${img.boxH} 0 0 cm\n/Im0 Do\nQ\n`;
    addObject(
      pageObj(i),
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${img.boxW} ${img.boxH}] ` +
        `/Resources << /XObject << /Im0 ${imageObj(i)} 0 R >> >> /Contents ${contentObj(i)} 0 R >>`,
    );
    addObject(
      imageObj(i),
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>`,
      img.jpeg,
    );
    addObject(contentObj(i), `<< /Length ${content.length} >>`, Buffer.from(content, 'latin1'));
  });

  const xrefAt = cursor;
  push(`xref\n0 ${total + 1}\n`);
  push('0000000000 65535 f \r\n');
  for (let i = 1; i <= total; i += 1) {
    // 每行必须恰好 20 字节（含 2 字节行尾），否则阅读器会解析出偏移错误。
    push(`${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \r\n`);
  }
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

/**
 * OCR 包实际会解析到哪一份 sharp，跟本进程用的是不是同一个文件。
 *
 * 用 require.resolve 而不是去数 node_modules 里几个 sharp 目录：
 * 真正决定加载哪一份的是**解析规则**，目录里多一个少一个是表象
 * （提升、嵌套、workspace 软链都会影响）。这里要断言的正是解析结果。
 */
function resolveSharpPaths(): { ok: boolean; detail: string } {
  const localRequire = createRequire(import.meta.url);
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    const ocrMain = localRequire.resolve('@gutenye/ocr-node', { paths: [here] });
    const fromOcr = localRequire.resolve('sharp', { paths: [dirname(ocrMain)] });
    const fromHere = localRequire.resolve('sharp', { paths: [here] });
    return {
      ok: fromOcr === fromHere,
      detail:
        fromOcr === fromHere
          ? fromHere.replace(/\\/gu, '/').replace(/^.*?node_modules\//u, '…/node_modules/')
          : `两份！OCR 包用 ${fromOcr}，本进程用 ${fromHere}`,
    };
  } catch (err) {
    return { ok: false, detail: `解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 识别文本与原文字符的重合度：原文字符有多少比例在识别结果里出现过。 */
function overlap(source: string, recognized: string): number {
  const strip = (s: string): string => s.replace(/[\s　]/gu, '');
  const a = strip(source);
  const b = strip(recognized);
  if (a === '') return 0;
  const pool = new Map<string, number>();
  for (const ch of b) pool.set(ch, (pool.get(ch) ?? 0) + 1);
  let hit = 0;
  for (const ch of a) {
    const left = pool.get(ch) ?? 0;
    if (left > 0) {
      hit += 1;
      pool.set(ch, left - 1);
    }
  }
  return hit / a.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

main().catch((err: unknown) => {
  console.error('\n冒烟脚本自身出错：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
