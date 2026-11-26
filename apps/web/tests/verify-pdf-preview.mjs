import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { build, preview } from 'vite';
import { createApp } from '../../server/src/app.ts';
import { createLabModels } from '../../server/src/agent/models.ts';
import { insertUser } from '../../server/src/auth/users.ts';
import { loadConfig } from '../../server/src/config.ts';
import { openDb } from '../../server/src/db/index.ts';
import { matchPdfText } from '../src/components/evidence/pdf-text-match.ts';
import { cases } from './fixtures/pdf-preview-cases.mjs';
import { cjkPdf, layeredPdf, mainPdf, otherPdf } from './fixtures/synthetic-pdf.mjs';

const item = (str, x, y, width, hasEOL = false) => ({
  str, transform: [12, 0, 0, 12, x, y], dir: 'ltr', width, height: 12, hasEOL,
});
const match = (items, quote) => matchPdfText(items, quote).kind;
assert.equal(match([item('Ofﬁce　Ａ１２', 10, 100, 72)], 'Office A12'), 'matched');
assert.equal(match([item('Ofﬁce', 10, 100, 40)], 'fi'), 'unmatched');
assert.equal(match([item('inelastic', 10, 100, 48)], 'elastic'), 'unmatched');
assert.equal(match([item('elastic', 10, 100, 36), item('ity', 46, 100, 13)], 'elasticity'), 'matched');
assert.equal(match([item('left', 10, 100, 24), item('right', 270, 100, 30)], 'left right'), 'unmatched');
assert.equal(match([item('cross-', 10, 100, 40, true), item('line', 10, 86, 24)], 'crossline'), 'matched');
assert.equal(match([item('match', 10, 100, 30), item('match', 270, 100, 30)], 'match'), 'ambiguous');
assert.equal(match([item('跨行 ', 10, 100, 24, true), item(' 原文', 10, 86, 24)], '跨行原文'), 'matched');
assert.equal(match([item('结果，', 10, 100, 36, true), item('Result', 10, 86, 30)], '结果，Result'), 'matched');
console.log('PASS 9 synthetic text-layer assertions');

const runner = process.env.KP_UI_PLAYWRIGHT;
assert(runner, 'Set KP_UI_PLAYWRIGHT to the installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(resolve(runner)).href);
const webRoot = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.env.KP_UI_ARTIFACTS ?? join(webRoot, '../../tmp/v2-05/screenshots'));
const root = await mkdtemp(join(tmpdir(), 'knowpilot-v2-05-'));
const uploads = join(root, 'uploads');
const appPort = Number(process.env.KP_PDF_API_PORT ?? 4410);
const webPort = Number(process.env.KP_PDF_WEB_PORT ?? 4411);
const origin = `http://127.0.0.1:${webPort}`;
const fixture = '/tests/fixtures/pdf-preview.html';
const fixtureOutput = join(root, 'web');
await Promise.all([mkdir(output, { recursive: true }), mkdir(uploads, { recursive: true })]);
await Promise.all([
  writeFile(join(uploads, 'main.pdf'), mainPdf),
  writeFile(join(uploads, 'other.pdf'), otherPdf),
  writeFile(join(uploads, 'layers.pdf'), layeredPdf),
  writeFile(join(uploads, 'cjk.pdf'), cjkPdf),
  writeFile(join(uploads, 'invalid.pdf'), 'Synthetic damaged file'),
  writeFile(join(uploads, 'text.txt'), 'Plain text excerpt'),
  writeFile(join(uploads, 'large.pdf'), ''),
]);
await truncate(join(uploads, 'large.pdf'), 64 * 1024 * 1024 + 1);

const now = new Date();
const dbPath = join(root, 'reader.sqlite');
const { db, migration } = openDb(dbPath);
const nowISO = now.toISOString();
const insertDoc = db.prepare(`
  INSERT INTO documents(id, material, title, source_path, content_hash, created_at, file_name, index_version)
  VALUES (?, 'paper', ?, ?, ?, ?, ?, 4)
`);
for (const id of new Set(cases.map(({ doc }) => doc))) {
  const name = id + (id === 'text' ? '.txt' : '.pdf');
  insertDoc.run(id, `合成原件 ${id}`, join(uploads, name), 'test-hash-' + id, nowISO, name);
}
const insertChunk = db.prepare('INSERT INTO doc_chunks(id, doc_id, ordinal, text, text_seg, page) VALUES (?, ?, ?, ?, ?, ?)');
const insertArchive = db.prepare(`
  INSERT INTO archived_doc_chunks(id, doc_id, ordinal, text, page, index_version, doc_title, material, file_name, archived_at)
  VALUES (?, ?, ?, ?, ?, 2, '合成历史原件', 'paper', 'main.pdf', ?)
`);
for (const [i, row] of cases.entries()) {
  if (row.archived) insertArchive.run(row.id, row.doc, i, row.text, row.page, nowISO);
  else insertChunk.run(row.id, row.doc, i, row.text, row.text, row.page);
}

const credentials = { username: 'pdf_fixture_member', password: 'fixture-only-password' };
await insertUser(db, credentials.username, { password: credentials.password, role: 'member' }, now);
const config = {
  ...loadConfig(),
  port: appPort, repoRoot: root, dbPath, uploadDir: uploads,
  hfHome: join(root, 'hf'), embedModelDir: join(root, 'models'),
  deepseekApiKey: undefined, modelChat: undefined, modelReasoner: undefined, modelBaseUrl: undefined,
  rerankEnabled: false, ocrEnabled: false, cookieSecure: false,
};
const app = createApp({ db, config, schemaVersion: migration.toVersion, startedAt: Date.now(), models: createLabModels() });
const api = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: appPort });
let vite, browser, desktop;
try {
  await once(api, 'listening');
  process.env.KP_API_PROXY_TARGET = `http://127.0.0.1:${appPort}`;
  await build({
    root: webRoot,
    logLevel: 'error',
    build: { outDir: fixtureOutput, rolldownOptions: { input: join(webRoot, fixture.slice(1)) } },
  });
  vite = await preview({
    root: webRoot, build: { outDir: fixtureOutput },
    preview: { host: '127.0.0.1', port: webPort, strictPort: true },
  });
  browser = await chromium.launch({ executablePath: process.env.KP_UI_BROWSER });
  desktop = await browser.newPage({ viewport: { width: 1450, height: 900 }, reducedMotion: 'reduce' });
  desktop.setDefaultTimeout(10_000);
  const errors = [];
  const outside = [];
  const requests = [];
  desktop.on('pageerror', (error) => errors.push(error.message));
  desktop.on('request', (request) => {
    const url = new URL(request.url());
    requests.push(url.pathname);
    if (url.origin !== origin) outside.push(url.origin);
  });
  await desktop.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const BrowserWorker = window.Worker;
    window.pdfFixture = { files: [], started: 0, running: 0, workerUrls: [] };
    window.fetch = (url, options) => {
      if (typeof url === 'string' && /^\/api\/v1\/documents\/.*\/file$/u.test(url)) {
        window.pdfFixture.files.push({ url, signal: options.signal, cache: options.cache,
          credentials: options.credentials, mode: options.mode, redirect: options.redirect });
      }
      return originalFetch(url, options);
    };
    window.Worker = class TrackedWorker extends BrowserWorker {
      constructor(url, options) {
        super(url, options);
        window.pdfFixture.started += 1;
        window.pdfFixture.running += 1;
        window.pdfFixture.workerUrls.push(String(url));
      }
      terminate() {
        window.pdfFixture.running -= 1;
        super.terminate();
      }
    };
  });
  const login = await desktop.request.post(origin + '/api/v1/auth/login', { data: credentials });
  assert.equal(login.status(), 200);
  await desktop.goto(origin + fixture);
  const pane = desktop.getByRole('complementary', { name: '证据阅读器' });
  const source = (id) => desktop.getByRole('button', { name: '引用 ' + id, exact: true });
  const openPreview = pane.getByRole('button', { name: '打开 PDF 预览' });
  const highlight = (scope = pane) => scope.locator('[data-pdf-highlight]');
  const image = (number, scope = pane) => scope.getByRole('img', { name: `PDF 第 ${number} 页`, exact: true });
  const mark = (scope = pane) => scope.getByText('已在本页定位摘录。', { exact: true });
  const workers = (expected) => desktop.waitForFunction((count) => window.pdfFixture.running === count, expected);

  async function openCase(id, quote) {
    await source(id).click();
    await pane.locator('mark').filter({ hasText: quote }).waitFor();
  }
  async function show(id, quote, expectedPage, message) {
    await openCase(id, quote);
    if (await openPreview.count() > 0) await openPreview.click();
    await image(expectedPage).waitFor();
    await pane.getByText(message).waitFor();
  }

  await openCase('wrap', /unique elasticity/u);
  assert.equal(requests.filter((path) => /pdf-document-|pdf[.]worker|\/file$/u.test(path)).length, 0);
  const original = desktop.waitForResponse((response) => response.url().endsWith('/documents/main/file'));
  await openPreview.click();
  const originalResponse = await original;
  assert.equal(originalResponse.status(), 200);
  assert.match(originalResponse.headers()['cache-control'], /private, no-store/u);
  await image(2).waitFor();
  await mark().waitFor();
  assert.match(await pane.innerText(), /PDF 物理页 2 \/ 5 · 印刷页标签 12/u);
  assert.equal(await highlight().count(), 2);
  const before = await image(2).boundingBox();
  const firstRect = await highlight().first().boundingBox();
  assert(before && firstRect && firstRect.width > 10 && firstRect.x - before.x > 20 && firstRect.y - before.y < 70);
  await workers(1);
  await desktop.screenshot({ path: join(output, 'pdf-side-panel.png') });

  await pane.getByRole('button', { name: '放大', exact: true }).click();
  await image(2).waitFor();
  const zoomed = await image(2).boundingBox();
  assert(zoomed && zoomed.width > before.width * 1.2);
  await pane.getByRole('button', { name: '下一页', exact: true }).click();
  await image(3).waitFor();
  assert.equal(await highlight().count(), 0);
  const jump = pane.getByRole('spinbutton', { name: '跳转到 PDF 物理页' });
  await jump.fill('4');
  await jump.press('Enter');
  await image(4).waitFor();
  assert(await jump.evaluate((input) => document.activeElement === input));
  const nextPage = pane.getByRole('button', { name: '下一页', exact: true });
  await nextPage.focus();
  await nextPage.press('Enter');
  await image(5).waitFor();
  assert(await nextPage.isDisabled());
  assert(await nextPage.evaluate((button) => document.activeElement === button));
  await nextPage.press('Enter');
  assert.equal(await jump.inputValue(), '5');
  await jump.fill('1');
  await jump.press('Enter');
  await image(1).waitFor();
  assert.match(await pane.innerText(), /印刷页标签 i/u);
  assert(await pane.getByRole('button', { name: '上一页', exact: true }).isDisabled());

  await pane.getByRole('button', { name: '全屏阅读' }).click();
  const full = desktop.getByRole('dialog', { name: '证据阅读器' });
  await image(1, full).waitFor();
  const fullSize = await full.boundingBox();
  assert(fullSize && fullSize.width >= 1_000);
  assert.equal(await full.getByLabel('PDF 缩放比例').textContent(), '125%');
  await full.getByRole('button', { name: '下一页', exact: true }).click();
  await mark(full).waitFor();
  assert.equal(await highlight(full).count(), 2);
  await desktop.screenshot({ path: join(output, 'pdf-fullscreen.png') });
  await full.getByRole('button', { name: '返回侧栏' }).click();
  await mark().waitFor();
  await workers(1);

  await pane.getByRole('button', { name: '下一条', exact: true }).click();
  await pane.getByText(/多处相同摘录/u).waitFor();
  assert.equal(await highlight().count(), 0);
  await show('columns', /left evidence Right evidence/u, 3, /当前页无法可靠定位摘录/u);
  assert.equal(await highlight().count(), 0);
  await show('right', /Right evidence/u, 3, /已在本页定位摘录/u);
  assert.equal(await highlight().count(), 1);
  const rightPage = await image(3).boundingBox();
  const rightMark = await highlight().boundingBox();
  assert(rightPage && rightMark && rightMark.x > rightPage.x + rightPage.width / 2);
  await show('scan', /Scanned excerpt/u, 4, /没有可用文字层/u);
  const visibleInk = await image(4).evaluate((canvas) => {
    const { data } = canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 5, 1, 1);
    return data[0] < 250;
  });
  assert(visibleInk);
  await desktop.screenshot({ path: join(output, 'pdf-scan-fallback.png') });
  await show('ocr', /Invisible OCR/u, 5, /不可见文字层/u);
  assert.equal(await highlight().count(), 0);
  await show('hidden-layer', /Default hidden selection/u, 1, /隐藏或无法核对的可选内容/u);
  assert.equal(await highlight().count(), 0);
  assert(await image(1).evaluate((canvas) =>
    canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.every((channel) => channel === 255)));
  await show('visible-layer', /Default visible selection/u, 2, /已在本页定位摘录/u);
  assert.equal(await highlight().count(), 1);
  await show('chinese', /中文原文/u, 1, /已在本页定位摘录/u);
  assert.equal(await highlight().count(), 2);
  await show('wrong', /unique elasticity/u, 1, /当前页无法可靠定位摘录/u);
  assert.equal(await highlight().count(), 0);
  await show('outside', /unique elasticity/u, 1, /超出当前原件页数/u);
  assert.equal(await highlight().count(), 0);
  await show('unpaged', /Page one cover/u, 1, /缺少 PDF 物理页码/u);
  assert.equal(await highlight().count(), 0);

  await source('archive').click();
  await pane.getByText(/索引 v2 的历史原文/u).waitFor();
  await pane.getByText(/无法核对当前 PDF 的页码/u).waitFor();
  assert.equal(await openPreview.count(), 0);
  assert.equal(await pane.getByRole('link', { name: '下载当前原件' }).getAttribute('href'), '/api/v1/documents/main/file');
  await workers(0);
  await source('changed').click();
  await pane.getByText(/来源版本已变化/u).waitFor();
  assert.equal(await openPreview.count(), 0);
  await source('text').click();
  await pane.locator('mark').filter({ hasText: 'Plain text excerpt' }).waitFor();
  assert.equal(await openPreview.count(), 0);

  for (const [id, quote, status, message] of [
    ['missing', 'Missing bytes', 404, /PDF 原件不可读取/u],
    ['invalid', 'Invalid bytes', 200, /PDF 预览加载失败/u],
    ['large', 'Oversize preview', 200, /PDF 超过 64 MiB/u],
  ]) {
    await pane.getByRole('button', { name: '关闭阅读器' }).click();
    await openCase(id, quote);
    const response = desktop.waitForResponse((result) => result.url().endsWith(`/documents/${id}/file`));
    await openPreview.click();
    assert.equal((await response).status(), status);
    await pane.getByText(message).waitFor();
    assert.equal(await pane.getByRole('img').count(), 0);
    await workers(0);
  }

  await show('other', /Second document/u, 1, /已在本页定位摘录/u);
  await workers(1);
  await pane.getByRole('button', { name: '关闭 PDF 预览' }).click();
  await workers(0);
  await source('search').click();
  await openPreview.click();
  await mark().waitFor();
  assert.equal(await highlight().count(), 1);
  await desktop.keyboard.press('Escape');
  await workers(0);
  assert.equal(await pane.count(), 0);
  assert(await source('search').evaluate((button) => document.activeElement === button));

  await source('search-clipped').click();
  await openPreview.click();
  await mark().waitFor();
  assert.equal(await highlight().count(), 1);
  assert.equal(await pane.locator('mark').count(), 0);
  for (const id of ['search-repeated', 'ask-clipped']) {
    await source(id).click();
    await image(1).waitFor();
    await pane.getByText(/当前摘录无法校验/u).waitFor();
    assert.equal(await highlight().count(), 0);
    assert.equal(await pane.locator('mark').count(), 0);
  }

  // The search helper's no-query/no-contiguous-match branch clips the prefix without a display ellipsis.
  const prefix = pane.locator('mark').filter({ hasText: /^Second document with independent te$/u });
  await source('search-prefix').click();
  await prefix.waitFor();
  await mark().waitFor();
  assert.equal(await highlight().count(), 1);
  await source('ask-prefix').click();
  await prefix.waitFor();
  await pane.getByText(/当前页无法可靠定位摘录/u).waitFor();
  assert.equal(await highlight().count(), 0);

  await pane.getByRole('button', { name: '关闭阅读器' }).click();
  await openCase('wrap', /unique elasticity/u);
  const arrival = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delayed = async (route) => {
    arrival.resolve();
    await release.promise;
    await route.continue().catch(() => {});
  };
  await desktop.route('**/api/v1/documents/main/file', delayed);
  try {
    await openPreview.click();
    await arrival.promise;
    await openCase('other', /Second document/u);
    await desktop.waitForFunction(() => window.pdfFixture.files.findLast(({ url }) =>
      url.endsWith('/documents/main/file'))?.signal.aborted === true);
  } finally {
    release.resolve();
    await desktop.unroute('**/api/v1/documents/main/file', delayed);
  }
  await mark().waitFor();
  assert.match(await pane.innerText(), /合成原件 other/u);
  await workers(1);

  await pane.getByRole('button', { name: '关闭阅读器' }).click();
  await openCase('wrap', /unique elasticity/u);
  await desktop.context().clearCookies();
  const denied = desktop.waitForResponse((response) => response.url().endsWith('/documents/main/file'));
  await openPreview.click();
  assert.equal((await denied).status(), 401);
  await pane.getByText(/PDF 原件不可读取/u).waitFor();
  assert.equal(await pane.getByRole('img').count(), 0);
  await workers(0);
  await source('other').click();
  await pane.getByText(/此证据不可读取/u).waitFor();
  assert.equal(await openPreview.count(), 0);

  const activity = await desktop.evaluate(() => ({
    count: window.pdfFixture.started,
    workerUrls: window.pdfFixture.workerUrls,
    safeFetch: window.pdfFixture.files.every(({ cache, credentials, mode, redirect }) =>
      cache === 'no-store' && credentials === 'same-origin' && mode === 'same-origin' && redirect === 'error'),
  }));
  assert(activity.count >= 10 && activity.safeFetch);
  assert(activity.workerUrls.every((url) => new URL(url, origin).origin === origin && /pdf[.]worker[.]min-/u.test(url)));
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 3, hasTouch: true });
  await mobile.request.post(origin + '/api/v1/auth/login', { data: credentials });
  await mobile.goto(origin + fixture);
  await mobile.getByRole('button', { name: '引用 wrap', exact: true }).click();
  const drawer = mobile.getByRole('dialog', { name: '证据阅读器' });
  await drawer.getByRole('button', { name: '打开 PDF 预览' }).click();
  const phonePage = image(2, drawer);
  await phonePage.waitFor();
  await mark(drawer).waitFor();
  assert(await phonePage.evaluate((canvas) => canvas.width * canvas.height <= 8_000_000 &&
    canvas.width <= 2 * canvas.getBoundingClientRect().width + 1));
  assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await mobile.screenshot({ path: join(output, 'pdf-mobile.png') });

  console.log(`PASS browser production build + Hono/SQLite, protected GET 200/401/404, ${activity.count} real workers started and released`);
  console.log('PASS physical and printed page labels, jumps, zoom, fullscreen, cross-line highlighter and layout fallbacks');
  console.log('PASS raster, invisible OCR and hidden-layer fallbacks, stale indexes, non-PDF, cancellation and mobile');
  console.log('PASS search excerpts with and without a clipping mark, strict answer quotes, visible layers and CJK line wrapping');
} catch (error) {
  if (desktop) await desktop.screenshot({ path: join(output, 'pdf-failure.png') }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await vite?.close();
  await new Promise((done) => api.close(done));
  db.close();
}
