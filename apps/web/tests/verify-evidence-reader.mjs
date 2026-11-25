import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const runner = process.env.KP_UI_PLAYWRIGHT;
if (!runner) throw new Error('Set KP_UI_PLAYWRIGHT to an isolated playwright/index.mjs.');
const { chromium } = await import(pathToFileURL(resolve(runner)).href);
const output = resolve(process.env.KP_UI_ARTIFACTS ?? 'tmp/v2-04/screenshots');
await mkdir(output, { recursive: true });
process.env.KP_API_PROXY_TARGET = 'http://127.0.0.1:4395';
const vite = await createServer({ root: appRoot, server: { host: '127.0.0.1', port: 4394, strictPort: true } });
await vite.listen();
const fixture = 'http://127.0.0.1:4394/tests/fixtures/evidence-reader.html';

const document = { id: 'fixture-doc', title: '合成仪器校准说明', material: 'sop', fileName: 'fixture.txt' };
const record = {
  kind: 'record', recordType: 'M-SUBMIT', recordId: 'fixture-record', recordTitle: '合成投稿台账',
  sourceVersion: '2026-02-01T00:00:00Z', recordUpdatedAt: '2026-02-01T00:00:00Z',
  queryTime: '2026-02-01T00:00:00Z', excerpt: '当前状态：外审', fields: [{ label: '状态', value: '外审' }],
  matchedBy: ['structured'],
};
const body = {
  fresh: { text: '右栏显示唯一摘录与安全文本 <img src="/unexpected" onerror="window.injected=true">。', sourceVersion: '2' },
  archive: { text: '旧版的历史摘录。', sourceVersion: '1', archivedIndexVersion: 1 },
  ambiguous: { text: '重复摘录与重复摘录都出现。', sourceVersion: '2', page: null },
  slow: { text: '慢响应内容', sourceVersion: '2' },
  'version-mismatch': { text: '跨版本仍含唯一摘录。', sourceVersion: '3' },
};

function fixtureServer(page, calls, pending) {
  return page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    calls.push(url.pathname + url.search);
    if (url.pathname === '/api/v1/search') {
      assert.equal(url.searchParams.get('contractVersion'), '1');
      assert.equal(url.searchParams.get('recordId'), 'fixture-record');
      assert.equal(url.searchParams.get('recordType'), 'M-SUBMIT');
      return route.fulfill({ json: { version: 1, hits: [record] } });
    }
    if (url.pathname === '/api/v1/journals/fixture-journal/rankings/evidence') {
      assert.equal(url.searchParams.get('year'), '2021');
      assert.equal(url.searchParams.get('system'), 'JCR');
      assert.equal(url.searchParams.get('category'), '合成:维度');
      return route.fulfill({ json: {
        ...record, recordType: 'M-JOURNAL', recordId: 'fixture-journal:2021:JCR:合成:维度',
        recordTitle: '合成期刊分区', sourceVersion: '2021 JCR 合成:维度',
        fields: [{ label: '分区', value: 'Q2' }],
      } });
    }
    const id = url.pathname.split('/').at(-1);
    const data = body[id];
    const denied = id === 'denied' || (id === 'fresh' && pending.denyFresh?.());
    if (!data || denied) return route.fulfill({
      status: id === 'signed-out' ? 401 : denied ? 403 : 404,
      json: { error: { code: 'not_found', title: '缓存标题不得显示', message: '缓存来源不得显示' } },
    });
    const pageNumber = data.page === null ? null : 2;
    const chunk = { id, ordinal: 2, text: data.text, page: pageNumber, sectionPath: ['测试章节'] };
    const siblings = pageNumber === null ? [chunk] : [
      { ...chunk, id: 'context-before', ordinal: 1, text: '同页上一段合成内容。' }, chunk,
    ];
    if (id === 'slow') {
      pending.started();
      await pending.release;
    }
    await route.fulfill({ json: {
      document, chunk, siblings, sourceVersion: data.sourceVersion,
      ...(data.archivedIndexVersion === undefined ? {} : { archivedIndexVersion: data.archivedIndexVersion }),
    } }).catch((err) => { if (id !== 'slow') throw err; });
  });
}

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.KP_UI_BROWSER === undefined ? {} : { executablePath: process.env.KP_UI_BROWSER }),
  });
  const desktop = await browser.newPage({ viewport: { width: 1450, height: 900 }, reducedMotion: 'reduce' });
  const pageErrors = [];
  desktop.on('pageerror', (err) => pageErrors.push(err));
  const calls = [];
  const delivered = Promise.withResolvers();
  const seen = Promise.withResolvers();
  let accessRevoked = false;
  await fixtureServer(desktop, calls, {
    started: seen.resolve, release: delivered.promise, denyFresh: () => accessRevoked,
  });
  await desktop.addInitScript(() => {
    window.evidenceFetchCacheModes = [];
    const originalFetch = window.fetch;
    window.fetch = (resource, options) => {
      if (typeof resource === 'string' && resource.startsWith('/api/v1/')) {
        window.evidenceFetchCacheModes.push(options?.cache);
      }
      return originalFetch(resource, options);
    };
  });
  await desktop.goto(fixture);
  const sourceButton = desktop.getByRole('button', { name: '打开当前片段' });
  const draft = desktop.getByRole('textbox', { name: '未发送的追问' });
  await draft.fill('合成追问不会丢失');
  const pane = desktop.getByRole('complementary', { name: '证据阅读器' });
  await desktop.getByRole('button', { name: '尝试其他会话的引用' }).click();
  await desktop.getByText('未接受该引用', { exact: true }).waitFor();
  assert.equal(calls.length, 0);
  await desktop.getByRole('button', { name: '打开旧期刊入口', exact: true }).click();
  await desktop.getByText('打开旧期刊入口保留原入口', { exact: true }).waitFor();
  assert.equal(calls.length, 0);
  assert.equal(await pane.count(), 0);
  await desktop.getByRole('button', { name: '打开期刊分区证据', exact: true }).click();
  await pane.getByRole('heading', { name: '合成期刊分区' }).waitFor();
  await pane.getByText('Q2', { exact: true }).waitFor();
  await pane.getByText(/旧字段修订未保留/u).waitFor();
  await desktop.getByRole('button', { name: '打开期间不符的证据' }).click();
  await pane.getByText(/此证据不可读取/u).waitFor();
  assert.doesNotMatch(await pane.innerText(), /合成期刊分区|Q2/u);
  await pane.getByRole('button', { name: '关闭阅读器' }).click();
  await sourceButton.click();
  await pane.locator('mark').waitFor();
  assert.equal(await pane.locator('mark').textContent(), '唯一摘录');
  assert.equal(await pane.getByRole('link', { name: '下载原件' }).getAttribute('href'), '/api/v1/documents/fixture-doc/file');
  assert.equal(await desktop.evaluate(() => window.injected), undefined);
  await pane.getByText('同页上下文', { exact: true }).click();
  await pane.getByText('同页上一段合成内容。', { exact: true }).waitFor();
  await desktop.screenshot({ path: resolve(output, 'desktop.png') });

  await pane.getByRole('button', { name: '全屏阅读' }).click();
  const full = desktop.getByRole('dialog', { name: '证据阅读器' });
  await full.locator('mark').waitFor();
  await full.getByRole('button', { name: '返回侧栏' }).click();
  await pane.locator('mark').waitFor();
  await pane.getByRole('button', { name: '下一条' }).click();
  await pane.getByText('索引 v1 的历史原文。仅显示当时保留的引用片段。').waitFor();
  assert.equal(await pane.locator('mark').textContent(), '历史摘录');
  assert.equal(await pane.getByText('同页上下文', { exact: true }).count(), 0);
  await pane.getByRole('link', { name: '下载当前原件' }).waitFor();
  await pane.getByRole('button', { name: '下一条' }).click();
  await pane.getByText(/未能精确定位摘录/).waitFor();
  assert.equal(await pane.locator('mark').count(), 0);
  assert.match(await pane.innerText(), /无页码/);

  await pane.getByRole('combobox', { name: '来源列表' }).selectOption('3');
  await pane.getByText(/此证据不可读取/).waitFor();
  assert.doesNotMatch(await pane.innerText(), /缓存/);
  await pane.getByRole('button', { name: '下一条' }).click();
  await pane.getByRole('heading', { name: '合成投稿台账' }).waitFor();
  assert.match(await pane.innerText(), /来源版本已变化/);
  assert.doesNotMatch(await pane.innerText(), /缓存/);
  await pane.getByRole('button', { name: '下一条' }).click();
  await pane.getByText(/此证据不可读取/).waitFor();
  await pane.getByRole('combobox', { name: '来源列表' }).selectOption('6');
  await seen.promise;
  await pane.getByRole('button', { name: '上一条' }).click();
  delivered.resolve();
  await pane.getByText(/此证据不可读取/).waitFor();
  assert.doesNotMatch(await pane.innerText(), /慢响应内容/);
  await pane.getByRole('combobox', { name: '来源列表' }).selectOption('7');
  await pane.getByText(/此证据不可读取/).waitFor();
  assert.notEqual(new URL(desktop.url()).pathname, '/login');
  await pane.getByRole('button', { name: '下一条' }).click();
  await pane.getByText(/来源版本已变化/).waitFor();
  assert.match(await pane.innerText(), /跨版本仍含唯一摘录/);
  assert.equal(await pane.locator('mark').count(), 0);

  const scrolled = await desktop.evaluate(() => { window.scrollTo(0, 50); return window.scrollY; });
  await desktop.keyboard.press('Escape');
  await pane.waitFor({ state: 'hidden' });
  assert(await sourceButton.evaluate((element) => element === window.document.activeElement));
  assert.equal(await desktop.evaluate(() => window.scrollY), scrolled);
  assert.equal(await draft.inputValue(), '合成追问不会丢失');
  const previousFreshReads = calls.filter((url) => url === '/api/v1/chunks/fresh').length;
  accessRevoked = true;
  await sourceButton.click();
  await pane.getByText(/此证据不可读取/).waitFor();
  assert.doesNotMatch(await pane.innerText(), /合成仪器校准说明|唯一摘录|缓存/);
  assert.equal(calls.filter((url) => url === '/api/v1/chunks/fresh').length, previousFreshReads + 1);
  assert((await desktop.evaluate(() => window.evidenceFetchCacheModes)).every((mode) => mode === 'no-store'));
  await pane.getByRole('button', { name: '关闭阅读器' }).click();
  accessRevoked = false;
  await sourceButton.click();
  await pane.locator('mark').waitFor();
  await desktop.getByRole('button', { name: '切换检索结果' }).click();
  await pane.waitFor({ state: 'hidden' });
  await desktop.getByRole('button', { name: '打开检索片段' }).click();
  await pane.getByRole('heading', { name: '合成仪器校准说明' }).waitFor();
  assert.equal(await pane.locator('mark').count(), 0);
  await desktop.getByRole('button', { name: '返回问答' }).click();
  await pane.waitFor({ state: 'hidden' });
  assert.equal(await draft.inputValue(), '合成追问不会丢失');

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  mobile.on('pageerror', (err) => pageErrors.push(err));
  await fixtureServer(mobile, [], { started() {}, release: Promise.resolve() });
  await mobile.goto(fixture);
  const opener = mobile.getByRole('button', { name: '打开当前片段' });
  await opener.click();
  const drawer = mobile.getByRole('dialog', { name: '证据阅读器' });
  await drawer.locator('mark').waitFor();
  const close = drawer.getByRole('button', { name: '关闭阅读器' });
  assert(await close.evaluate((node) => node === window.document.activeElement));
  await mobile.keyboard.press('Tab');
  assert(await drawer.evaluate((dialog) => dialog.contains(window.document.activeElement)));
  assert(await mobile.evaluate(() => window.document.documentElement.scrollWidth <= window.innerWidth));
  await mobile.screenshot({ path: resolve(output, 'mobile.png') });
  await mobile.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  assert(await opener.evaluate((node) => node === window.document.activeElement));
  assert.deepEqual(pageErrors, []);
  console.log('Evidence reader fixtures passed: authorization, lifecycle, exact highlight, archive, version, race, keyboard and narrow layout.');
} finally {
  await browser?.close();
  await vite.close();
}
