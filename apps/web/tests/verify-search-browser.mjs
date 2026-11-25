import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { INDEX_VERSION, SEARCH_MAX_LIMIT, segmentForIndex } from '@knowpilot/shared';
import { preview } from 'vite';
import { createLabModels } from '../../server/src/agent/models.ts';
import { createApp } from '../../server/src/app.ts';
import { createSession, deleteSession, SESSION_COOKIE } from '../../server/src/auth/session.ts';
import { insertUser } from '../../server/src/auth/users.ts';
import { loadConfig } from '../../server/src/config.ts';
import { openDb } from '../../server/src/db/index.ts';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const runner = process.env.KP_UI_PLAYWRIGHT;
assert(runner, 'Set KP_UI_PLAYWRIGHT to an isolated playwright/index.mjs');
const { chromium } = await import(pathToFileURL(resolve(runner)).href);
const output = resolve(process.env.KP_UI_ARTIFACTS ?? resolve(webRoot, '../../tmp/v2-07/screenshots'));
const webPort = Number(process.env.KP_UI_WEB_PORT ?? 4420);
const apiPort = Number(process.env.KP_UI_MOCK_PORT ?? 4421);
const origin = `http://127.0.0.1:${webPort}`;
const temp = await mkdtemp(join(tmpdir(), 'knowpilot-v2-07-search-'));
await mkdir(output, { recursive: true });

const config = {
  ...loadConfig(), repoRoot: temp, dbPath: ':memory:', uploadDir: join(temp, 'uploads'),
  dataRoot: join(temp, 'data'), codeRoots: [join(temp, 'data')], hfHome: join(temp, 'hf'),
  embedModelDir: join(temp, 'no-model'), deepseekApiKey: undefined, modelBaseUrl: undefined,
  ocrEnabled: false, rerankEnabled: false, rewriteEnabled: false, cookieSecure: false,
};
const { db, migration } = openDb(':memory:');
const now = new Date();
const username = 'search-ui-member';
const marker = 'calibrationprobe';
const titleOnly = '合成标题专用标记';
const insertDocument = db.prepare(
  'INSERT INTO documents(id, material, title, status, content_hash, created_at, index_version) VALUES(?,?,?,?,?,?,?)',
);
const insertChunk = db.prepare(
  'INSERT INTO doc_chunks(id, doc_id, ordinal, text, text_seg, page, section_path, token_count) VALUES(?,?,?,?,?,?,?,?)',
);
for (let index = 1; index <= 14; index += 1) {
  const id = `search-doc-${index}`;
  const material = index % 2 === 0 ? 'paper' : 'sop';
  const title = `合成光学仪器规程 ${String(index).padStart(2, '0')}`;
  insertDocument.run(id, material, title, 'ready', id, now.toISOString(), INDEX_VERSION);
  for (let page = 1; page <= 4; page += 1) {
    const text = `Check ${marker} optical drift. 合成原始读数 ${index}-${page}，校准台记录；此段属于第 ${page} 页。`;
    insertChunk.run(`${id}-chunk-${page}`, id, page - 1, text, segmentForIndex(text), page,
      JSON.stringify(['仪器检查', `步骤 ${page}`]), text.length);
  }
}
insertDocument.run('title-only', 'sop', titleOnly, 'uploaded', 'title-only',
  new Date(now.getTime() - 60_000).toISOString(), INDEX_VERSION);
db.prepare('INSERT INTO people(id, name, created_at, updated_at) VALUES(?,?,?,?)')
  .run('matching-person', titleOnly, now.toISOString(), now.toISOString());
const userId = await insertUser(db, username, {
  displayName: '检索合成账号', role: 'member', password: 'fixture-only-not-a-real-password',
}, now);
const session = () => createSession(db, { userId, now, idleDays: 1, maxDays: 1, ip: null, userAgent: null });
const api = createApp({ db, config, schemaVersion: migration.toVersion, startedAt: Date.now(), models: createLabModels() });
const server = serve({ fetch: api.fetch, hostname: '127.0.0.1', port: apiPort });

const calls = [];
const requestPath = (request) => new URL(request.url()).pathname;
const isBodySearch = (response) => requestPath(response) === '/api/v1/search' && response.ok();
const queryUrl = (q, extra = {}) => `${origin}/search?${new URLSearchParams({ q, ...extra })}`;
const quickUrl = (extra = {}) => `${origin}/api/v1/quick-search?${new URLSearchParams({ q: titleOnly, limit: '100', ...extra })}`;
const bodyPanel = (page) => page.getByRole('region', { name: '文档正文' });
const readerName = '证据阅读器';
const assertNoHorizontalOverflow = async (page) =>
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
async function assertSearchFormFits(page) {
  const search = page.getByRole('button', { name: '搜索', exact: true });
  assert(await search.evaluate((button) => {
    const form = button.form;
    const box = form.getBoundingClientRect();
    const controls = [...form.querySelectorAll('input, select, button')].map((control) => control.getBoundingClientRect());
    return controls.every((control, index) =>
      control.left >= box.left - 1 && control.right <= box.right + 1 &&
      controls.slice(index + 1).every((next) => control.right <= next.left + 1 || control.bottom <= next.top + 1)
    );
  }), 'Search controls must fit and must not overlap');
}
async function makePage(browser, viewport, token) {
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
  page.setDefaultTimeout(9_000);
  if (token !== undefined) await page.context().addCookies([
    { name: SESSION_COOKIE, value: token, url: origin, httpOnly: true },
  ]);
  page.on('request', (request) => calls.push({ method: request.method(), pathname: requestPath(request) }));
  return page;
}
async function runSearch(page, query, extra) {
  const response = page.waitForResponse(isBodySearch);
  await page.goto(queryUrl(query, extra));
  return (await response).json();
}

let vite;
let browser;
try {
  await once(server, 'listening');
  process.env.KP_API_PROXY_TARGET = `http://127.0.0.1:${apiPort}`;
  vite = await preview({ root: webRoot, preview: { host: '127.0.0.1', port: webPort, strictPort: true } });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.KP_UI_BROWSER === undefined ? {} : { executablePath: process.env.KP_UI_BROWSER }),
  });
  const member = session();
  const desktop = await makePage(browser, { width: 1450, height: 940 }, member.token);
  const pageErrors = [];
  desktop.on('pageerror', (error) => pageErrors.push(error));
  const sample = await runSearch(desktop, marker);
  assert.equal(sample.strategy, 'keyword');
  assert.equal(sample.hits.length, SEARCH_MAX_LIMIT);
  assert.equal(sample.nextOffset, null);
  const documents = [...new Map(sample.hits.map((hit) => [hit.documentId, hit.documentTitle])).entries()];
  const panel = bodyPanel(desktop);
  await panel.getByText(`${documents.length} 份资料，${sample.hits.length} 个片段`, { exact: true }).waitFor();
  await panel.getByText(/每次最多返回 50 个片段/).waitFor();
  assert.deepEqual(await panel.getByRole('heading', { level: 3 }).allTextContents(), documents.slice(0, 8).map((pair) => pair[1]));

  const [firstId, firstTitle] = documents[0];
  const firstHits = sample.hits.filter((hit) => hit.documentId === firstId);
  assert(firstHits.length > 1);
  const firstResult = panel.getByRole('listitem').filter({ has: desktop.getByRole('heading', { name: firstTitle, exact: true }) });
  const firstCheck = firstResult.getByRole('checkbox', { name: `选择 ${firstTitle}` });
  await firstCheck.check();
  await firstResult.getByText(`展开其余 ${firstHits.length - 1} 个命中片段`).click();
  const expandedHit = firstResult.getByRole('link', { name: '预览命中片段 2', exact: true });
  assert.equal(await expandedHit.getAttribute('href'), `/chunk/${firstHits[1].chunkId}`);
  await expandedHit.click();
  const reader = desktop.getByRole('complementary', { name: readerName });
  await reader.getByRole('heading', { name: firstTitle }).waitFor();
  await reader.getByText(new RegExp(`第 ${firstHits[1].page} 页 · 仪器检查`)).waitFor();
  assert.equal(await reader.locator('mark').textContent(), firstHits[1].excerpt);
  await assertNoHorizontalOverflow(desktop);
  await assertSearchFormFits(desktop);
  await desktop.screenshot({ path: join(output, 'desktop-preview.png') });
  await desktop.keyboard.press('Escape');
  await reader.waitFor({ state: 'hidden' });
  assert.equal(await expandedHit.evaluate((link) => link === document.activeElement), true);

  const nextPage = panel.getByRole('button', { name: '下一页' });
  const previousPage = panel.getByRole('button', { name: '上一页' });
  await nextPage.focus();
  await desktop.keyboard.press('Enter');
  await panel.getByText('第 2 / 2 页').waitFor();
  assert.equal(await nextPage.getAttribute('aria-disabled'), 'true');
  assert(await nextPage.evaluate((button) => button === document.activeElement));
  await desktop.keyboard.press('Enter');
  await panel.getByText('第 2 / 2 页').waitFor();
  await previousPage.focus();
  await desktop.keyboard.press('Enter');
  await panel.getByText('第 1 / 2 页').waitFor();
  assert.equal(await previousPage.getAttribute('aria-disabled'), 'true');
  assert(await previousPage.evaluate((button) => button === document.activeElement));
  await desktop.keyboard.press('Enter');
  await panel.getByText('第 1 / 2 页').waitFor();
  await nextPage.click();
  await panel.getByText('第 2 / 2 页').waitFor();
  assert.deepEqual(await panel.getByRole('heading', { level: 3 }).allTextContents(), documents.slice(8).map((pair) => pair[1]));
  const [lastId, lastTitle] = documents.at(-1);
  await panel.getByRole('checkbox', { name: `选择 ${lastTitle}`, exact: true }).check();
  await desktop.getByText('已选 2 份资料', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '按片段' }).click();
  assert.deepEqual(await panel.getByRole('heading', { level: 3 }).allTextContents(), sample.hits.slice(0, 8).map((hit) => hit.documentTitle));
  await panel.getByText('第 1 / 7 页').waitFor();
  for (let pageIndex = 1; pageIndex < 7; pageIndex += 1) {
    await panel.getByRole('button', { name: '下一页' }).click();
    await panel.getByText(`第 ${pageIndex + 1} / 7 页`).waitFor();
  }
  assert.deepEqual(await panel.getByRole('heading', { level: 3 }).allTextContents(), sample.hits.slice(48).map((hit) => hit.documentTitle));
  assert.equal(calls.filter((call) => call.pathname === '/api/v1/search').length, 1);
  await desktop.getByRole('link', { name: '基于此资料问答', exact: true }).click();
  await desktop.waitForURL('**/ask');
  assert.deepEqual(await desktop.evaluate(() => history.state.usr.searchHandoff), {
    version: 1, query: marker, documentIds: [firstId, lastId], material: undefined, documentId: undefined,
  });
  assert.equal(calls.some((call) => call.method === 'POST' && call.pathname.startsWith('/api/v1/ask')), false);
  console.log('PASS aggregation, separate result counts, ranked pagination, selection, exact preview, navigation handoff');

  const natural = 'How do I check calibrationprobe optical drift?';
  const scoped = await runSearch(desktop, natural, { material: 'sop', kind: 'document' });
  assert.equal(scoped.hits.length, 28);
  assert(scoped.hits.every((hit) => hit.material === 'sop'));
  await panel.getByText('7 份资料，28 个片段').waitFor();
  assert.equal(await desktop.getByLabel('资料类型').inputValue(), 'sop');
  assert.equal(await desktop.getByText('已选 2 份资料', { exact: true }).count(), 0);
  const narrowResponse = desktop.waitForResponse(isBodySearch);
  await panel.getByRole('link', { name: '仅检索此资料' }).first().click();
  const narrowed = await (await narrowResponse).json();
  assert.equal(narrowed.scope.documentId, scoped.hits[0].documentId);
  assert.equal(narrowed.hits.length, 4);
  await panel.getByText('1 份资料，4 个片段').waitFor();
  await panel.getByRole('checkbox', { name: '选择 ' + narrowed.hits[0].documentTitle, exact: true }).check();
  await desktop.getByRole('link', { name: '基于此资料问答', exact: true }).click();
  await desktop.waitForURL('**/ask');
  assert.deepEqual(await desktop.evaluate(() => history.state.usr.searchHandoff), {
    version: 1, query: natural, documentIds: [narrowed.scope.documentId], material: 'sop',
    documentId: narrowed.scope.documentId,
  });
  await desktop.goBack();
  await panel.getByText('1 份资料，4 个片段').waitFor();
  await desktop.getByRole('link', { name: '清除资料范围' }).click();
  await panel.getByText('7 份资料，28 个片段').waitFor();
  await desktop.getByLabel('资料类型').selectOption('knowledge');
  await desktop.getByRole('button', { name: '搜索', exact: true }).click();
  await panel.getByText('未找到匹配的文档片段。').waitFor();
  assert.equal(new URL(desktop.url()).searchParams.get('material'), 'knowledge');
  await runSearch(desktop, titleOnly, { kind: 'document' });
  const quickLink = desktop.getByRole('link', { name: titleOnly, exact: true });
  await quickLink.waitFor();
  assert.equal(await quickLink.getAttribute('href'), '/docs?material=sop&focus=title-only');
  console.log('PASS natural question without a model, material and document scope, empty state, legacy title-link fallback');

  const mobileSession = session();
  const mobile = await makePage(browser, { width: 390, height: 844 }, mobileSession.token);
  await runSearch(mobile, marker, { material: 'sop' });
  const mobilePanel = bodyPanel(mobile);
  await mobilePanel.getByText('7 份资料，28 个片段').waitFor();
  await assertNoHorizontalOverflow(mobile);
  await assertSearchFormFits(mobile);
  await mobile.screenshot({ path: join(output, 'narrow-search.png') });
  const mobileHit = mobilePanel.getByRole('link', { name: '预览命中原文', exact: true }).first();
  await mobileHit.click();
  const dialog = mobile.getByRole('dialog', { name: readerName });
  await dialog.locator('mark').waitFor();
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: join(output, 'narrow-preview.png') });
  await mobile.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await mobileHit.evaluate((link) => link === document.activeElement), true);

  // The selected source was authorized at search time, then its session was revoked server-side.
  deleteSession(db, mobileSession.token);
  await mobileHit.click();
  await dialog.getByText(/此证据不可读取/).waitFor();
  assert.equal(await dialog.locator('mark').count(), 0);
  assert.equal((await mobile.request.get(`${origin}/api/v1/search?contractVersion=1&q=${marker}`)).status(), 401);
  assert.equal((await mobile.request.get(`${origin}${(await mobileHit.getAttribute('href')).replace('/chunk/', '/api/v1/chunks/')}`)).status(), 401);

  let failBody = true;
  const releaseFailure = Promise.withResolvers();
  await desktop.route('**/api/v1/search?**', async (route) => {
    if (!failBody) return route.continue();
    await releaseFailure.promise;
    return route.fulfill({ status: 503, json: {
      error: { code: 'upstream_unavailable', title: '合成故障', message: '合成检索暂不可用。', retryable: true, requestId: 'fixture' },
    } });
  });
  await desktop.goto(queryUrl(marker));
  try {
    await desktop.getByText('正在检索…', { exact: true }).waitFor();
  } finally {
    releaseFailure.resolve();
  }
  await desktop.getByText('合成检索暂不可用。', { exact: true }).waitFor();
  assert.equal(await panel.count(), 0);
  failBody = false;
  await desktop.getByRole('button', { name: '重试检索' }).click();
  await panel.getByText(/份资料，50 个片段/u).waitFor();

  const signedOut = await makePage(browser, { width: 980, height: 760 });
  await signedOut.goto(queryUrl(marker));
  await signedOut.waitForURL('**/login?**');
  assert.equal(await bodyPanel(signedOut).count(), 0);

  // Newer title matches saturate the old sample. The older SOP has no matching full-text chunks.
  for (let index = 0; index < 101; index += 1) {
    const id = `title-overflow-paper-${index}`;
    insertDocument.run(id, 'paper', titleOnly, 'uploaded', id, now.toISOString(), INDEX_VERSION);
  }
  const legacyQuick = await desktop.request.get(quickUrl({ kind: 'document' }));
  assert.equal(legacyQuick.status(), 200);
  const { items: legacyTitles } = await legacyQuick.json();
  assert.equal(legacyTitles.length, 100);
  assert(legacyTitles.every((hit) => hit.id.startsWith('title-overflow-paper-')));

  const filteredQuick = await desktop.request.get(quickUrl({ material: 'sop' }));
  assert.equal(filteredQuick.status(), 200);
  const { items: filteredHits } = await filteredQuick.json();
  assert.deepEqual(filteredHits.map(({ id, kind }) => [kind, id]), [
    ['person', 'matching-person'], ['document', 'title-only'],
  ]);
  const intersectingQuick = await desktop.request.get(quickUrl({
    kind: 'document', material: 'paper', documentId: 'title-only',
  }));
  assert.equal(intersectingQuick.status(), 200);
  assert.deepEqual(await intersectingQuick.json(), { items: [] });
  for (const extra of [{ material: 'invalid-fixture-type' }, { documentId: ' ' }]) {
    assert.equal((await desktop.request.get(quickUrl({ kind: 'document', ...extra }))).status(), 400);
  }
  const ledgerQuick = await desktop.request.get(quickUrl({
    kind: 'person', material: 'invalid-fixture-type', documentId: ' ',
  }));
  assert.equal(ledgerQuick.status(), 200);
  assert.deepEqual((await ledgerQuick.json()).items.map((hit) => hit.id), ['matching-person']);
  assert.equal((await signedOut.request.get(quickUrl({ kind: 'document', material: 'sop' }))).status(), 401);

  for (const scope of [{ material: 'sop' }, { documentId: 'title-only' }]) {
    const search = await runSearch(desktop, titleOnly, { kind: 'document', ...scope });
    assert.equal(search.hits.length, 0);
    await quickLink.waitFor();
    assert.equal(await quickLink.getAttribute('href'), '/docs?material=sop&focus=title-only');
    assert.equal(await desktop.getByText(/已取快搜前 100 条/).count(), 0);
  }
  console.log('PASS title filters before the quick-search limit, ID intersection, legacy and permission behavior');

  // All existing roles have knowledge.read. Exercise the UI's withheld-permission branch with a modified /me response.
  const withheld = await makePage(browser, { width: 980, height: 760 }, session().token);
  await withheld.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch();
    const me = await response.json();
    return route.fulfill({ response, json: {
      ...me, permissions: me.permissions.filter((permission) => permission !== 'knowledge.read'),
    } });
  });
  await withheld.goto(queryUrl(titleOnly, { kind: 'document' }));
  await withheld.getByText('当前账号没有文档检索权限。', { exact: true }).waitFor();
  assert.equal(await withheld.getByRole('combobox', { name: '资料类型' }).count(), 0);
  assert.equal(await withheld.getByRole('link', { name: titleOnly, exact: true }).count(), 0);
  assert.equal(await bodyPanel(withheld).count(), 0);
  assert.deepEqual(pageErrors, []);
  console.log('PASS narrow dialog and keyboard focus, live authorization on preview, signed-out route, recoverable error');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (vite !== undefined) {
    const closed = once(vite.httpServer, 'close');
    vite.httpServer.close();
    await closed;
  }
  if (server.listening) {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections?.();
    await closed;
  }
  db.close();
}
