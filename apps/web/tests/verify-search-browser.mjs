import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { INDEX_VERSION, SEARCH_MAX_LIMIT, segmentForIndex } from '@knowpilot/shared';
import { preview } from 'vite';
import { createLabModels } from '../../server/src/agent/models.ts';
import { createApp } from '../../server/src/app.ts';
import { createSession, deleteSession, SESSION_COOKIE } from '../../server/src/auth/session.ts';
import { insertUser } from '../../server/src/auth/users.ts';
import { insertCodeAsset } from '../../server/src/code/repo.ts';
import { loadConfig } from '../../server/src/config.ts';
import { ingestDocument } from '../../server/src/documents/ingest.ts';
import { uploadDocument } from '../../server/src/documents/upload.ts';
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
  embedModelDir: join(temp, 'no-model'), deepseekApiKey: 'fixture-only-no-network', modelBaseUrl: undefined,
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
// Both model entry points are replaced. All search, scope, auth, and ask routes are real.
const models = createLabModels();
const modelCalls = [];
const exactQuote = `Check ${marker} optical drift.`;
let toolSequence = 0;
let onGenerate;
let holdAnswer;
let forcePartial = false;
let includeNoteCode = false;
function assistant(model, content, stopReason) {
  return { role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
}
models.completeSimple = async (model, context) => {
  modelCalls.push({ kind: 'rewrite', context });
  return assistant(model, [{ type: 'text', text: marker }], 'stop');
};
models.streamSimple = (model, context) => {
  modelCalls.push({ kind: 'generate', context });
  const contextText = context.messages.flatMap(({ content }) =>
    typeof content === 'string' ? [content] : content.filter((part) => part.type === 'text').map((part) => part.text),
  ).join('\n');
  const id = contextText.match(/\[(E\d+)\] [^\n]*\n来源版本/u)?.[1];
  const hasRetrieved = context.messages.some((message) => message.role === 'toolResult');
  const draftText = contextText.match(/<<<用户输入开始>>>\n([\s\S]*?)\n<<<用户输入结束>>>/u)?.[1];
  const options = draftText !== undefined ? { name: 'submit_entries', arguments: { entries: [
    { kind: 'fact', content: draftText, evidence: draftText,
      claim: /当前素材入口：document/u.test(context.systemPrompt) ? 'literature' : 'experience' },
  ] } } : id === undefined && !hasRetrieved
    ? { name: 'retrieve', arguments: { query: marker, mode: 'keyword' } }
    : { name: 'submit_answer', arguments: {
      answer: id === undefined ? '未找到合成依据。' : `${exactQuote} [${id}]` +
        (includeNoteCode ? '\n\n`literal[ E1 ] = "[E1]"`\n\n```text\nliteral [E1]\n```' : ''),
      quotes: id === undefined ? [] : [{ evidence_id: id, quote: exactQuote }],
      evidence_gaps: id === undefined || forcePartial ? ['没有找到完整依据'] : includeNoteCode ? ['合成测量缺少第二批结果'] : [],
      limits: includeNoteCode ? ['仅适用于本次合成测量'] : [],
      confidence_notes: includeNoteCode ? ['需要合成复核'] : [],
      conflicts: includeNoteCode ? ['两份合成记录结论不同'] : [],
      ...(id === undefined ? {} : { blocks: [{ kind: 'documents', evidence_ids: [id] }] }),
    } };
  if (options.name === 'submit_answer') onGenerate?.();
  const msg = assistant(model, [{ type: 'toolCall', id: `scope-${++toolSequence}`, ...options }], 'toolUse');
  const stream = createAssistantMessageEventStream();
  const gate = options.name === 'submit_answer' ? holdAnswer : undefined;
  queueMicrotask(async () => {
    await gate;
    stream.push({ type: 'done', reason: 'toolUse', message: msg });
  });
  return stream;
};
const api = createApp({ db, config, schemaVersion: migration.toVersion, startedAt: Date.now(), models });
const server = serve({ fetch: api.fetch, hostname: '127.0.0.1', port: apiPort });

const readabilityKeyword = '热台漂移';
const readabilityTitles = ['恒温台光学测量手册', '热台复测与记录规程'];
const readabilityBody = [
  '着手测量前，先让恒温台和探测器充分平衡。完成外观检查后记录温度、湿度和设备编号。数据由两人分别复核，再与空白对照和标准件的读数比较。',
  '热台漂移待稳定后再记录，不要用单次读数替代趋势。采集基线和复测读数后，核对储存时间、探头位置与参考光源。发现热台漂移持续扩大时，保存原始数据和完整日志，按规程重新校准。',
  '校准完成后再次检查位置偏移与光强，记录仪器状态及观察值。采用相同条件完成三轮对照，记下未测项目及原因，保留与本次记录关联的原始结果。图表应标明标准件的批次、测量范围和环境条件。',
].join('');
for (const [index, title] of readabilityTitles.entries()) {
  const id = `readability-doc-${index}`;
  insertDocument.run(id, index === 0 ? 'sop' : 'paper', title, 'ready', id, now.toISOString(), INDEX_VERSION);
  for (const page of index === 0 ? [1, 2] : [1]) {
    const text = `步骤 ${page}。 ${readabilityBody}`;
    insertChunk.run(`${id}-${page}`, id, page - 1, text, segmentForIndex(text), page,
      JSON.stringify(['质量控制', '光学校准']), text.length);
  }
}
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
  page.on('request', (request) => calls.push({ method: request.method(), pathname: requestPath(request), body: request.postData() }));
  return page;
}
async function runSearch(page, query, extra) {
  const response = page.waitForResponse(isBodySearch);
  await page.goto(queryUrl(query, extra));
  return (await response).json();
}

async function verifyReadability(browser) {
  const apiCalls = () => calls.filter(({ pathname }) => pathname.startsWith('/api/')).length;
  const region = (page) => bodyPanel(page);
  const card = (page, title) => region(page).getByRole('listitem').filter({
    has: page.getByRole('heading', { name: title, exact: true, level: 3 }),
  });
  const toggle = (result, expanded = false) => result.getByRole('button', {
    name: expanded ? '收起' : '展开全文', exact: true, expanded,
  });
  const controlledExcerpt = async (button) => {
    const id = await button.getAttribute('aria-controls');
    assert(id, 'Excerpt button identifies the text it controls');
    return button.page().locator(`[id=${JSON.stringify(id)}]`);
  };

  for (const { theme, width, height } of [
    { theme: 'light', width: 1450, height: 940 },
    { theme: 'dark', width: 1450, height: 940 },
    { theme: 'light', width: 360, height: 820 },
  ]) {
    const page = await makePage(browser, { width, height }, session().token);
    await page.addInitScript((value) => localStorage.setItem('knowpilot.theme.v1', value), theme);
    const result = await runSearch(page, readabilityKeyword);
    const [primaryTitle, secondaryTitle] = readabilityTitles;
    const [first, second] = readabilityTitles.map((title) => card(page, title));
    const firstHit = result.hits.find((hit) => hit.documentTitle === primaryTitle);
    assert(firstHit, 'The real search endpoint returned the long synthetic excerpt');
    await first.getByText(`第 ${firstHit.page} 页 · 质量控制 > 光学校准`, { exact: true }).waitFor();
    await second.getByRole('heading', { name: secondaryTitle, exact: true }).waitFor();
    assert.equal(await first.locator('h3').count(), 1);
    const expandFirst = toggle(first);
    const excerpt = await controlledExcerpt(expandFirst);
    const collapsed = await excerpt.textContent();
    assert(firstHit.excerpt.startsWith(collapsed.slice(0, -1)));
    assert.equal(collapsed.at(-1), '…');
    assert(collapsed.length < firstHit.excerpt.length);
    const marked = await excerpt.locator('mark').allTextContents();
    assert(marked.length > 0 && marked.every((hit) => hit === readabilityKeyword));
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    const contrast = await first.evaluate((element) => {
      const linear = (value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      const luminance = (color) => color.match(/\d+/g).slice(0, 3)
        .map((value) => linear(Number(value) / 255))
        .reduce((sum, value, index) => sum + [0.2126, 0.7152, 0.0722][index] * value, 0);
      return ['h3 a', '.search-material-label', '.search-passage-location', '.search-excerpt',
        '.search-excerpt mark', '.search-excerpt-toggle', '.search-result-actions a'].map((selector) => {
        const item = element.querySelector(selector);
        const ink = luminance(getComputedStyle(item).color);
        let surface = item;
        while (getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
        const paper = luminance(getComputedStyle(surface).backgroundColor);
        return { selector, ratio: (Math.max(ink, paper) + 0.05) / (Math.min(ink, paper) + 0.05) };
      });
    });
    assert(contrast.every(({ ratio }) => ratio >= 4.5), JSON.stringify(contrast));
    console.log(`UX-02 ${theme} ${width}px minimum contrast: ${Math.min(...contrast.map(({ ratio }) => ratio)).toFixed(2)}:1`);
    assert.equal(await excerpt.evaluate((element) => getComputedStyle(element).fontWeight), '400');
    assert.equal(await excerpt.locator('mark').first().evaluate((element) => getComputedStyle(element).fontWeight), '600');
    await assertNoHorizontalOverflow(page);
    const label = width < 500 ? 'narrow' : theme;
    if (label === 'narrow') await first.evaluate((result) => result.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: join(output, `ux02-${label}.png`) });

    const requestsBefore = apiCalls();
    await expandFirst.focus();
    await page.keyboard.press('Space');
    const collapseFirst = toggle(first, true);
    assert(await collapseFirst.evaluate((button) => button === document.activeElement && button.matches(':focus-visible')));
    assert.equal(await excerpt.textContent(), firstHit.excerpt);
    assert.deepEqual(await excerpt.locator('mark').allTextContents(),
      firstHit.segments.filter(({ hit }) => hit).map(({ text }) => text));
    assert(await toggle(second).isVisible());
    await toggle(second).click();
    assert(await toggle(first, true).isVisible());
    await collapseFirst.click();
    assert.equal(await excerpt.textContent(), collapsed);
    assert(await toggle(first).evaluate((button) => button === document.activeElement));
    assert(await toggle(second, true).isVisible());
    assert.equal(apiCalls(), requestsBefore, 'Expanding or collapsing a snippet does not request more data');
    await assertNoHorizontalOverflow(page);

    if (label === 'light') {
      await first.getByText('展开其余 1 个命中片段', { exact: true }).click();
      const remaining = first.getByRole('listitem').filter({
        has: page.getByRole('link', { name: '预览命中片段 2', exact: true }),
      });
      const other = await controlledExcerpt(toggle(remaining));
      await toggle(remaining).click();
      const nextHit = result.hits.filter(({ documentTitle }) => documentTitle === primaryTitle)[1];
      assert.equal(await other.textContent(), nextHit.excerpt);
      assert.equal(apiCalls(), requestsBefore);
      await remaining.getByRole('link', { name: '预览命中片段 2', exact: true }).click();
      const viewer = page.getByRole('complementary', { name: readerName });
      await viewer.getByRole('heading', { name: primaryTitle }).waitFor();
      await viewer.getByText(/质量控制.*光学校准/u).waitFor();
      await assertNoHorizontalOverflow(page);
      await page.screenshot({ path: join(output, 'ux02-reader.png') });
      await page.keyboard.press('Escape');
      await region(page).getByRole('button', { name: '按片段' }).click();
      assert.equal(await region(page).getByRole('button', { name: '收起', exact: true }).count(), 0);
    }
    await page.close();
  }
  console.log('PASS UX-02 readable light/dark/narrow cards, true highlights, independent keyboard toggles and source preview');
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
  await desktop.addInitScript(() => localStorage.setItem('knowpilot.ask.consent.v1', '1'));
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
  await reader.getByText(new RegExp(` · (?:第 ${firstHits[1].page} 页|PDF 物理页 ${firstHits[1].page}) · 仪器检查`)).waitFor();
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
  const selection = desktop.getByRole('region', { name: '问答资料范围' });
  const docNames = new Map(documents);
  await selection.getByText(docNames.get(firstId), { exact: true }).waitFor();
  await selection.getByText(docNames.get(lastId), { exact: true }).waitFor();
  assert.deepEqual(JSON.parse(calls.findLast((call) => call.pathname === '/api/v1/ask/document-scope').body), {
    version: 1, documentIds: [firstId, lastId],
  });
  assert.equal(calls.some((call) => call.pathname === '/api/v1/ask/stream'), false);
  const requestInScope = async (question, ids) => {
    const prompt = desktop.locator('.ask-form input');
    await prompt.fill(question);
    const awaited = desktop.waitForResponse((response) => requestPath(response) === '/api/v1/ask/stream');
    await desktop.locator('.ask-form button[type="submit"]').click();
    const received = await awaited;
    const data = received.request().postDataJSON();
    assert.deepEqual(data.documentScope?.documents.map((doc) => doc.id), ids);
    const stream = await received.text();
    const events = stream.split(/\r?\n/u).filter((line) => line.startsWith('data:'));
    return events.map((line) => JSON.parse(line.slice(5))).findLast((event) =>
      ['verified_final', 'partial', 'interrupted', 'failed'].includes(event.type));
  };
  await desktop.screenshot({ path: join(output, 'ask-selected-scope.png') });
  const initialStart = modelCalls.length;
  const firstAsk = await requestInScope(marker, [firstId, lastId]);
  assert(firstAsk?.response?.answer?.citations.length > 0, JSON.stringify(firstAsk));
  assert(firstAsk.response.answer.citations.every((cite) => [firstId, lastId].includes(cite.documentId)));
  assert.equal(firstAsk.response.answer.blocks?.items[0]?.kind, 'documents');
  // Read the actual tool transcripts, so a pass requires scoped candidate collection before accepting citations.
  const seen = modelCalls.slice(initialStart).flatMap(({ context }) =>
    [...JSON.stringify(context.messages).matchAll(/合成原始读数 (\d+)-\d+/gu)].map((m) => 'search-doc-' + m[1]));
  assert(seen.length > 0);
  assert(seen.every((id) => [firstId, lastId].includes(id)));
  const beforeDiscoveryPanel = modelCalls.length;
  const discoveryPage = await makePage(browser, { width: 1200, height: 950 }, session().token);
  await discoveryPage.goto(origin + '/knowledge');
  const discovery = discoveryPage.locator('.knowledge-discovery');
  const summary = discovery.locator(':scope > summary');
  await summary.getByText('知识建议（1）', { exact: true }).waitFor();
  assert.equal(await discovery.evaluate((element) => element.open), false);
  await summary.click();
  await discovery.getByText('新增 · 问答', { exact: true }).waitFor();
  await discovery.getByRole('button', { name: '提炼为知识草稿' }).click();
  const suggestionDialog = discoveryPage.getByRole('dialog', { name: '提炼为知识草稿' });
  const generateSuggestion = suggestionDialog.getByRole('button', { name: '生成待确认草稿' });
  assert.equal(await generateSuggestion.isDisabled(), true);
  assert.equal(modelCalls.length, beforeDiscoveryPanel);
  await suggestionDialog.getByRole('checkbox').check();
  const [extracted] = await Promise.all([
    discoveryPage.waitForResponse((response) => requestPath(response) === '/api/v1/knowledge/drafts'),
    generateSuggestion.click(),
  ]);
  assert.equal(extracted.status(), 201);
  const extractedEntry = (await extracted.json()).entries[0];
  assert.equal(extractedEntry.status, 'proposed');
  assert.equal(extractedEntry.documentId, null);
  await suggestionDialog.getByRole('link', { name: /预览和编辑/u }).waitFor();
  await suggestionDialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  assert.equal(modelCalls.length, beforeDiscoveryPanel + 1);
  await discovery.getByRole('button', { name: '忽略建议' }).click();
  await discovery.getByText('暂无待处理建议。', { exact: true }).waitFor();
  const discoveryToggle = discovery.getByRole('checkbox', { name: '启用主动建议' });
  const changeDiscovery = async (enabled) => {
    const [response] = await Promise.all([
      discoveryPage.waitForResponse((reply) => requestPath(reply) === '/api/v1/knowledge/discovery' &&
        reply.request().method() === 'PATCH'),
      discoveryToggle.click(),
    ]);
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).enabled, enabled);
  };
  await changeDiscovery(false);
  await discoveryPage.reload();
  await discovery.locator(':scope > summary').click();
  assert.equal(await discoveryToggle.isChecked(), false);
  await discoveryPage.screenshot({ path: join(output, 'discovery-opt-out.png') });
  await changeDiscovery(true);
  assert.equal(modelCalls.length, beforeDiscoveryPanel + 1);
  await discoveryPage.close();
  console.log('PASS quiet verified ask, explicit model consent, private draft, ignore and persistent opt-out');
  const initialPins = firstAsk.response.documentScope.documents;
  await selection.getByRole('button', { name: '移除' + docNames.get(lastId), exact: true }).click();
  await desktop.reload();
  await selection.getByText(docNames.get(firstId), { exact: true }).waitFor();
  assert.equal(await selection.getByText(docNames.get(lastId), { exact: true }).count(), 0);
  const followStart = modelCalls.length;
  const follow = await requestInScope('继续查找校准', [firstId]);
  assert(follow?.response?.answer?.citations.length > 0, JSON.stringify(follow));
  assert(follow.response.answer.citations.every((cite) => cite.documentId === firstId));
  assert.deepEqual(follow.response.documentScope.documents, initialPins.filter((doc) => doc.id === firstId));
  assert(modelCalls.slice(followStart).some((call) => call.kind === 'rewrite'));
  for (const call of modelCalls.slice(followStart).filter(({ kind }) => kind === 'rewrite')) {
    assert(!JSON.stringify(call.context).includes(exactQuote));
  }
  const fromAnswer = desktop.getByRole('link', { name: '在检索中查看', exact: true });
  await fromAnswer.waitFor();
  const href = new URL(await fromAnswer.getAttribute('href'), origin);
  assert.equal(href.searchParams.get('q'), marker);
  assert.equal(href.searchParams.get('documentId'), firstId);
  const beforeReturn = desktop.waitForResponse(isBodySearch);
  await fromAnswer.click();
  assert.equal((await (await beforeReturn).json()).scope.documentId, firstId);
  const returnedPassage = panel.getByRole('link', { name: '预览命中原文' }).first();
  await returnedPassage.click();
  await desktop.getByRole('complementary', { name: readerName }).getByRole('heading', { name: docNames.get(firstId) }).waitFor();
  const pin = initialPins.find((doc) => doc.id === firstId);
  const endpoint = (request, body) => desktop.request.post(origin + request, { data: body });
  const selectedRequest = (documents) => ({ question: marker, consentConfirmed: true, documentScope: { version: 1, documents } });
  const staleBody = selectedRequest([pin]);
  const callCount = modelCalls.length;
  assert.equal((await endpoint('/api/v1/ask', selectedRequest([{ id: 'missing', version: pin.version }]))).status(), 400);
  assert.equal((await endpoint('/api/v1/ask', selectedRequest([]))).status(), 400);
  assert.equal(modelCalls.length, callCount);
  const chunkBefore = firstId + '-chunk-4';
  db.prepare('UPDATE doc_chunks SET id = ? WHERE id = ?').run(chunkBefore + '-revision', chunkBefore);
  const stale = await endpoint('/api/v1/ask', staleBody);
  assert.equal(stale.status(), 400);
  assert(!(await stale.text()).includes(exactQuote));
  const playback = follow.response.delivery.taskId;
  const checkpoint = db.prepare('SELECT plan_json FROM agent_task_checkpoints WHERE task_id = ? ORDER BY version DESC LIMIT 1').get(playback);
  assert.deepEqual(JSON.parse(checkpoint.plan_json).documentScope, follow.response.documentScope);
  db.prepare("UPDATE agent_tasks SET status = 'interrupted' WHERE id = ?").run(playback);
  const resumeReply = await endpoint('/api/v1/agent-tasks/' + playback + '/resume', {});
  const resumeBody = await resumeReply.text();
  assert.equal(resumeReply.status(), 200);
  assert(resumeBody.includes('event: failed'));
  assert(!resumeBody.includes(exactQuote));
  assert.equal(modelCalls.length, callCount);
  await desktop.goBack();
  await desktop.reload();
  await selection.getByRole('alert').waitFor();
  await selection.getByRole('button', { name: '改为全库检索' }).click();
  await desktop.reload();
  await desktop.locator('.ask-form input').waitFor();
  assert.equal(await selection.count(), 0);
  db.prepare('UPDATE doc_chunks SET id = ? WHERE id = ?').run(chunkBefore, chunkBefore + '-revision');
  onGenerate = () => db.prepare("UPDATE documents SET status = 'failed' WHERE id = ?").run(firstId);
  const withdrawn = await endpoint('/api/v1/ask/stream', staleBody);
  const withdrawnBody = await withdrawn.text();
  assert(withdrawnBody.includes('event: failed'));
  assert(!withdrawnBody.includes('event: verified_final') && !withdrawnBody.includes(exactQuote));
  onGenerate = undefined;
  db.prepare("UPDATE documents SET status = 'ready' WHERE id = ?").run(firstId);
  forcePartial = true;
  const fullLibrary = await requestInScope(marker, undefined);
  forcePartial = false;
  assert(fullLibrary.response.delivery.resumeAvailable);
  await desktop.getByRole('button', { name: '继续查找依据' }).waitFor();
  await desktop.screenshot({ path: join(output, 'ask-library-scope.png') });
  console.log('PASS scoped ask, follow-up, reload, revocation/version response, explicit clear, history isolation and answer-to-search roundtrip');
  console.log('PASS aggregation, separate result counts, ranked pagination, selection, exact preview, navigation handoff');

  const natural = 'How do I check calibrationprobe optical drift?';
  const scoped = await runSearch(desktop, natural, { material: 'sop', kind: 'document' });
  assert.equal(scoped.hits.length, 28);
  assert(scoped.hits.every((hit) => hit.material === 'sop'));
  await panel.getByText('7 份资料，28 个片段').waitFor();
  assert.equal(await desktop.getByLabel('资料类型').inputValue(), 'sop');
  assert.equal(await desktop.getByText('已选 2 份资料', { exact: true }).count(), 0);
  await panel.getByRole('checkbox', { name: '选择 ' + scoped.hits[0].documentTitle, exact: true }).check();
  await desktop.getByRole('link', { name: '基于此资料问答', exact: true }).click();
  await selection.getByText(scoped.hits[0].documentTitle, { exact: true }).waitFor();
  await desktop.getByText(/原任务的检索范围与当前不同/u).waitFor();
  assert.equal(await desktop.getByRole('button', { name: '继续查找依据' }).count(), 0);
  const preserved = new URL(await selection.getByRole('link', { name: '返回检索选资料' }).getAttribute('href'), origin);
  assert.equal(preserved.searchParams.get('kind'), 'document');
  assert.equal(preserved.searchParams.get('material'), 'sop');
  assert.equal(preserved.searchParams.get('q'), natural);
  assert.equal(preserved.searchParams.has('documentId'), false);
  const returnSearch = desktop.waitForResponse(isBodySearch);
  await selection.getByRole('link', { name: '返回检索选资料' }).click();
  await returnSearch;
  await panel.getByText('7 份资料，28 个片段').waitFor();
  const narrowResponse = desktop.waitForResponse(isBodySearch);
  await panel.getByRole('link', { name: '仅检索此资料' }).first().click();
  const narrowed = await (await narrowResponse).json();
  assert.equal(narrowed.scope.documentId, scoped.hits[0].documentId);
  assert.equal(narrowed.hits.length, 4);
  await panel.getByText('1 份资料，4 个片段').waitFor();
  await panel.getByRole('checkbox', { name: '选择 ' + narrowed.hits[0].documentTitle, exact: true }).check();
  await desktop.getByRole('link', { name: '基于此资料问答', exact: true }).click();
  await desktop.waitForURL('**/ask');
  await selection.getByText(narrowed.hits[0].documentTitle, { exact: true }).waitFor();
  const back = new URL(await selection.getByRole('link', { name: '返回检索选资料' }).getAttribute('href'), origin);
  assert.equal(back.searchParams.get('q'), natural);
  assert.equal(back.searchParams.get('kind'), 'document');
  assert.equal(back.searchParams.get('material'), 'sop');
  assert.equal(back.searchParams.get('documentId'), narrowed.scope.documentId);
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

  for (const { invalid, retained, message, count } of [
    { invalid: { material: 'invalid-fixture-type' }, retained: { documentId: 'search-doc-1' },
      message: '资料类型无效', count: '1 份资料，4 个片段' },
    { invalid: { documentId: '' }, retained: { material: 'sop' },
      message: '资料 ID 无效', count: '7 份资料，28 个片段' },
  ]) {
    const query = new URLSearchParams({ q: marker, ...retained, ...invalid });
    assert.equal((await desktop.request.get(`${origin}/api/v1/search?contractVersion=1&${query}`)).status(), 400);
    assert.equal((await desktop.request.get(`${origin}/api/v1/quick-search?${query}`)).status(), 400);
    const start = calls.length;
    await desktop.goto(queryUrl(marker, { ...retained, ...invalid }));
    await desktop.getByRole('alert').filter({ hasText: message }).waitFor();
    assert.equal(await panel.count(), 0);
    assert(!calls.slice(start).some(({ pathname }) => ['/api/v1/search', '/api/v1/quick-search'].includes(pathname)));
    if ('material' in invalid) await desktop.screenshot({ path: join(output, 'invalid-scope.png') });

    const response = desktop.waitForResponse(isBodySearch);
    await desktop.getByRole('link', { name: '清除无效筛选', exact: true }).click();
    assert.equal((await (await response).json()).scope[Object.keys(retained)[0]], Object.values(retained)[0]);
    await panel.getByText(count, { exact: true }).waitFor();
    assert.deepEqual(Object.fromEntries(new URL(desktop.url()).searchParams), { q: marker, ...retained });
  }
  console.log('PASS invalid explicit URL scope blocks both searches until cleared and retains valid filters');

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
  assert.equal((await signedOut.request.post(origin + '/api/v1/ask/document-scope', { data: { version: 1, documentIds: [firstId] } })).status(), 401);

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

  // Research notes use the same real search, ask, permission and evidence services.
  const noteDocument = 'fixture-note-document';
  const noteChunk = noteDocument + '-chunk';
  const noteDocumentTitle = '研究笔记合成资料';
  insertDocument.run(noteDocument, 'sop', noteDocumentTitle, 'ready', noteDocument, now.toISOString(), INDEX_VERSION);
  const noteSourceText = exactQuote + ' 仅用于测试的研究笔记来源。';
  insertChunk.run(noteChunk, noteDocument, 0, noteSourceText, segmentForIndex(noteSourceText), 1,
    JSON.stringify(['合成章节']), noteSourceText.length);
  const notePage = await makePage(browser, { width: 1440, height: 980 }, session().token);
  notePage.on('pageerror', (error) => pageErrors.push(error));
  await notePage.addInitScript(() => localStorage.setItem('knowpilot.ask.consent.v1', '1'));
  includeNoteCode = true;
  await runSearch(notePage, marker, { documentId: noteDocument, kind: 'document' });
  await bodyPanel(notePage).getByRole('checkbox', { name: '选择 ' + noteDocumentTitle }).check();
  await notePage.getByRole('link', { name: '基于此资料问答' }).click();
  const noteScope = notePage.getByRole('region', { name: '问答资料范围' });
  await noteScope.getByText(noteDocumentTitle, { exact: true }).waitFor();

  const askAnswer = notePage.getByRole('article', { name: '回答', exact: true });
  const saveAsNote = askAnswer.getByRole('button', { name: '转为研究笔记', exact: true });
  async function answerForNote(question, expectedQuestions, afterSubmit) {
    await notePage.locator('.ask-form input').fill(question);
    const [received] = await Promise.all([
      notePage.waitForResponse((r) => requestPath(r) === '/api/v1/ask/stream'),
      notePage.locator('.ask-form button[type="submit"]').click(),
    ]);
    assert.deepEqual(received.request().postDataJSON().history?.map((entry) => entry.question), expectedQuestions);
    await afterSubmit?.();
    assert((await received.text()).includes(exactQuote));
    await saveAsNote.waitFor();
  }
  const noteEditor = notePage.getByRole('region', { name: '编辑笔记' });
  const noteBody = noteEditor.getByRole('textbox', { name: /^正文/u });
  await answerForNote(marker);
  const savedWithoutModel = modelCalls.length;
  await saveAsNote.click();
  await notePage.waitForURL('**/knowledge/notes?note=*');
  const fullNoteUrl = notePage.url();
  await noteBody.waitFor();
  assert((await noteBody.inputValue()).includes(exactQuote));
  assert.match(await noteBody.inputValue(), /关联证据 \[第 1 轮 · E1\]/u);
  assert((await noteBody.inputValue()).includes('`literal[ E1 ] = "[E1]"`'));
  assert((await noteBody.inputValue()).includes('```text\nliteral [E1]\n```'));
  const fullAnswer = await noteBody.inputValue();
  assert(fullAnswer.includes('### 还缺哪些信息\n- 合成测量缺少第二批结果'));
  assert(fullAnswer.includes('### 本次回答的边界\n- 仅适用于本次合成测量'));
  assert(fullAnswer.includes('### 需要注意的地方\n- 需要合成复核'));
  assert(fullAnswer.includes('### 资料之间互相矛盾之处\n- 两份合成记录结论不同'));
  includeNoteCode = false;
  const sources = noteEditor.getByRole('region', { name: '关联问答与来源' });
  const sourceControl = sources.getByRole('button', { name: new RegExp(noteDocumentTitle) });
  await sourceControl.waitFor();
  await sourceControl.click();
  const noteReader = notePage.getByRole('complementary', { name: readerName });
  await noteReader.getByText(noteSourceText, { exact: true }).waitFor();
  const noteFileUrl = await noteReader.getByRole('link', { name: '下载原件', exact: true }).getAttribute('href');
  assert.match(noteFileUrl, /^\/api\/v1\/research-notes\/.*\/sources\/E1\/file$/u);
  await notePage.screenshot({ path: join(output, 'research-notes-reader.png') });
  await notePage.keyboard.press('Escape');
  await noteReader.waitFor({ state: 'hidden' });
  assert.equal(await sourceControl.evaluate((button) => document.activeElement === button), true);
  await noteEditor.getByLabel('标题').fill('合成笔记编辑后的标题');
  await noteEditor.getByLabel('标签').fill('校准，回归');
  const stageMarker = 'knowpilotg3publicationprobe';
  const editedBody = '研究者编辑内容 ' + stageMarker + '\n\n' + await noteBody.inputValue();
  await noteBody.fill(editedBody);
  const saveNote = noteEditor.getByRole('button', { name: '保存笔记' });
  await saveNote.focus();
  await notePage.keyboard.press('Enter');
  await noteEditor.getByRole('heading', { name: '合成笔记编辑后的标题' }).waitFor();
  await noteEditor.getByText('笔记已保存。', { exact: true }).waitFor();
  assert(await saveNote.evaluate((button) => button === document.activeElement));

  async function downloadedExport(button, extension) {
    const [download] = await Promise.all([
      notePage.waitForEvent('download'), noteEditor.getByRole('button', { name: button, exact: true }).click(),
    ]);
    assert(download.suggestedFilename().endsWith(extension));
    return { filename: download.suggestedFilename(), bytes: await readFile(await download.path()) };
  }
  const exportedMarkdown = await downloadedExport('下载 Markdown', '.md');
  assert.equal(exportedMarkdown.filename, '合成笔记编辑后的标题.md');
  assert(exportedMarkdown.bytes.toString('utf8').includes(editedBody));
  const exportedPdf = await downloadedExport('下载 PDF', '.pdf');
  assert.equal(exportedPdf.filename, '合成笔记编辑后的标题.pdf');
  assert.equal(exportedPdf.bytes.subarray(0, 5).toString('ascii'), '%PDF-');
  await noteEditor.getByText('已下载当前保存的笔记。', { exact: true }).waitFor();
  await noteEditor.screenshot({ path: join(output, 'research-notes-export.png') });
  console.log('PASS note export downloads saved UTF-8 Markdown and local PDF from the authenticated editor');
  await notePage.reload();
  await noteBody.waitFor();
  assert.equal(await noteBody.inputValue(), editedBody);
  const list = notePage.getByRole('region', { name: '我的笔记' });
  await list.getByLabel('查找笔记').fill('回归');
  await list.getByRole('button', { name: '查找' }).click();
  await list.getByRole('link', { name: '合成笔记编辑后的标题' }).waitFor();

  const beforeContinue = calls.length;
  await noteEditor.getByRole('link', { name: /使用可用文档继续问答/ }).click();
  await notePage.waitForURL('**/ask');
  await noteScope.getByText(noteDocumentTitle, { exact: true }).waitFor();
  assert.equal(await notePage.locator('.ask-form input').inputValue(), '');
  assert(!calls.slice(beforeContinue).some(({ pathname }) => pathname === '/api/v1/ask/stream'));
  assert.equal(modelCalls.length, savedWithoutModel);

  // Use the same note that came from the real ask response and both downloads.
  const stageNoteId = new URL(fullNoteUrl).searchParams.get('note');
  assert(stageNoteId);
  const stagePage = await makePage(browser, { width: 1440, height: 980 }, session().token);
  const otherUser = await insertUser(db, 'g3-stage-observer', {
    displayName: 'G3 合成观察账号', role: 'member', password: 'fixture-only-not-a-real-password',
  }, now);
  const observerSession = createSession(db, { userId: otherUser, now, idleDays: 1, maxDays: 1, ip: null, userAgent: null });
  const observerPage = await makePage(browser, { width: 1440, height: 980 }, observerSession.token);
  stagePage.on('pageerror', (error) => pageErrors.push(error));
  observerPage.on('pageerror', (error) => pageErrors.push(error));
  const privateNotePath = '/api/v1/research-notes/' + stageNoteId;
  assert.equal((await observerPage.request.get(origin + privateNotePath)).status(), 404);
  assert.equal((await observerPage.request.get(origin + privateNotePath + '/export/md')).status(), 404);
  assert.equal((await observerPage.request.get(origin + privateNotePath + '/export/pdf')).status(), 404);
  await stagePage.goto(fullNoteUrl);
  const stageDraft = await submitDraftFromCurrentSource(stagePage, 'note');
  assert.equal(stageDraft.note.draftSource.id, stageNoteId);
  assert(stageDraft.note.draftSource.excerpt.includes(stageMarker));
  const stageSearch = () => runSearch(observerPage, stageMarker, { kind: 'document', material: 'knowledge' });
  assert.equal((await stageSearch()).hits.length, 0);
  await stagePage.goto(origin + '/knowledge');
  const draftRow = stagePage.locator('.kb-entry').filter({ hasText: stageMarker });
  await draftRow.getByRole('button', { name: '编辑草稿' }).click();
  await draftRow.getByRole('textbox', { name: '草稿正文' }).fill('已人工核对的合成知识 ' + stageMarker);
  await draftRow.getByRole('button', { name: '保存修改' }).click();
  const revised = '已人工核对的合成知识 ' + stageMarker;
  const revisedBody = draftRow.locator('.kb-entry-body').filter({ hasText: revised });
  await revisedBody.waitFor();
  assert.equal(await revisedBody.textContent(), revised);
  const activeGroup = stagePage.locator('.kb-group').filter({ has: draftRow });
  const confirmPublication = activeGroup.getByRole('button', { name: '确认整组（1 条）' });
  assert.equal(await confirmPublication.isDisabled(), true);
  await stagePage.getByRole('checkbox', { name: '我已阅读并理解' }).check();
  const [confirmation] = await Promise.all([
    stagePage.waitForResponse((response) => requestPath(response) === '/api/v1/knowledge/groups/' + stageDraft.groupId + '/confirm'),
    confirmPublication.click(),
  ]);
  assert.equal(confirmation.status(), 200);
  const confirmationBody = await confirmation.json();
  const confirmed = confirmationBody.results.find((result) => result.entryId === stageDraft.id);
  assert.equal(confirmed?.outcome, 'active', JSON.stringify(confirmationBody));
  await draftRow.getByText('已生效', { exact: true }).waitFor();
  const published = db.prepare('SELECT status, document_id FROM knowledge_entries WHERE id=?').get(stageDraft.id);
  assert.equal(published?.status, 'active');
  assert(published.document_id);
  const found = (await stageSearch()).hits.find((hit) => hit.documentId === published.document_id);
  assert(found, 'Another member should retrieve the exact approved document');
  await bodyPanel(observerPage).getByText(new RegExp(stageMarker)).first().waitFor();
  await observerPage.screenshot({ path: join(output, 'g3-note-to-public-search.png') });
  assert.equal((await observerPage.request.get(origin + privateNotePath)).status(), 404);
  await stagePage.close();
  await observerPage.close();
  console.log('PASS G3 same note: answer, edit, Markdown and PDF, draft, private search exclusion, human confirmation and public retrieval');

  const completion = Promise.withResolvers();
  holdAnswer = completion.promise;
  const noteRunCount = calls.filter(({ pathname }) => pathname === '/api/v1/ask/stream').length;
  try {
    await answerForNote('继续核实合成校准', undefined, async () => {
      const searchNav = notePage.getByRole('link', { name: '统一检索', exact: true });
      await searchNav.click();
      await notePage.getByRole('link', { name: '问答：查询中', exact: true }).click();
      await noteScope.getByText(noteDocumentTitle, { exact: true }).waitFor();
      await notePage.getByRole('button', { name: '停止', exact: true }).waitFor();

      await searchNav.click();
      await notePage.getByRole('link', { name: '问答：查询中', exact: true }).waitFor();
      completion.resolve();
      await notePage.getByRole('link', { name: '问答：有新回答', exact: true }).click();
      await noteScope.getByText(noteDocumentTitle, { exact: true }).waitFor();
    });
  } finally {
    holdAnswer = undefined;
    completion.resolve();
  }
  assert.equal(calls.filter(({ pathname }) => pathname === '/api/v1/ask/stream').length, noteRunCount + 1);
  console.log('PASS note research status link returns to the in-flight or finished ask without changing scope');
  const secondRunModelCalls = modelCalls.length;
  await askAnswer.locator('.ask-note-content').evaluate((element, quote) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const index = node.textContent.indexOf(quote);
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEndAfter(element.querySelector('.cite-mark'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error('Could not select the synthetic answer excerpt');
  }, exactQuote);
  const saveExcerpt = askAnswer.getByRole('button', { name: '保存选段', exact: true });
  await saveExcerpt.click();
  await notePage.waitForURL('**/knowledge/notes?note=*');
  await noteBody.waitFor();
  assert.match(await noteBody.inputValue(), /Check calibrationprobe optical drift\.\s*\[第 1 轮 · E1\]/u);
  await sources.getByText(/答复选段/).waitFor();
  await notePage.goBack();
  await notePage.waitForURL('**/ask');
  await askAnswer.getByRole('button', { name: '追加到已有笔记', exact: true }).click();
  await list.getByRole('link', { name: '合成笔记编辑后的标题' }).click();
  assert.equal(notePage.url(), fullNoteUrl);
  await noteEditor.getByRole('button', { name: '追加到这条笔记' }).click();
  await noteEditor.getByRole('button', { name: '保存笔记' }).click();
  await sources.getByText(/继续核实合成校准/).waitFor();
  assert.equal(await sources.getByText(/运行编号/).count(), 2);
  assert((await noteBody.inputValue()).includes('研究者编辑内容'));
  assert((await noteBody.inputValue()).includes(exactQuote));
  assert.match(await noteBody.inputValue(), /\[第 1 轮 · E1\][\s\S]+\[第 2 轮 · E1\]/u);
  const paths = [];
  for (const round of [1, 2]) {
    const pending = notePage.waitForResponse((reply) => requestPath(reply).endsWith('/sources/E1') && reply.ok());
    await sources.getByRole('button', { name: new RegExp('第 ' + round + ' 轮 · E1') }).click();
    paths.push(requestPath(await pending));
    await noteReader.getByText(noteSourceText, { exact: true }).waitFor();
    await notePage.keyboard.press('Escape');
    await noteReader.waitFor({ state: 'hidden' });
  }
  assert.equal(new Set(paths).size, 2);
  assert.equal(modelCalls.length, secondRunModelCalls);

  // Follow the same research history entry back from the appended note.
  await notePage.goBack();
  await notePage.goBack();
  await notePage.waitForURL('**/ask');
  await noteScope.getByText(noteDocumentTitle, { exact: true }).waitFor();
  const returnToSearch = calls.length;
  await noteScope.getByRole('link', { name: '返回检索选资料' }).click();
  await notePage.getByText(/输入关键词或自然语言问题/u).waitFor();
  assert.equal(new URL(notePage.url()).searchParams.has('q'), false);
  assert.equal(await notePage.getByRole('searchbox', { name: '关键词' }).inputValue(), '合成笔记编辑后的标题');
  assert(!calls.slice(returnToSearch).some(({ pathname }) => ['/api/v1/search', '/api/v1/quick-search'].includes(pathname)));

  const [explicitSearch] = await Promise.all([
    notePage.waitForResponse(isBodySearch),
    notePage.getByRole('button', { name: '搜索', exact: true }).click(),
  ]);
  assert.equal(new URL(explicitSearch.url()).searchParams.get('q'), '合成笔记编辑后的标题');
  assert.equal(new URL(notePage.url()).searchParams.has('q'), false);
  await notePage.getByRole('searchbox', { name: '关键词' }).fill(marker);
  await notePage.getByRole('button', { name: '搜索', exact: true }).click();
  await bodyPanel(notePage).getByRole('checkbox', { name: '选择 ' + noteDocumentTitle, exact: true }).check();
  await notePage.getByRole('link', { name: '基于此资料问答' }).click();
  await noteScope.getByText(noteDocumentTitle, { exact: true }).waitFor();
  await answerForNote('重选资料后续研', ['继续核实合成校准']);
  const answerSearchLink = askAnswer.getByRole('link', { name: '在检索中查看', exact: true });
  assert.equal(new URL(await answerSearchLink.getAttribute('href'), origin).searchParams.has('q'), false);
  const secondReturn = calls.length;
  await answerSearchLink.click();
  await notePage.getByText(/输入关键词或自然语言问题/u).waitFor();
  assert.equal(await notePage.getByRole('searchbox', { name: '关键词' }).inputValue(), '合成笔记编辑后的标题');
  assert(!calls.slice(secondReturn).some(({ pathname }) => ['/api/v1/search', '/api/v1/quick-search'].includes(pathname)));
  await notePage.goBack();
  await notePage.waitForURL('**/ask');
  await noteScope.getByRole('button', { name: '移除' + noteDocumentTitle }).click();
  await notePage.reload();
  await noteScope.getByRole('alert').waitFor();
  await noteScope.getByRole('button', { name: '改为全库检索' }).click();
  await notePage.reload();
  await notePage.locator('.ask-form input').waitFor();
  assert.equal(await noteScope.count(), 0);
  await answerForNote('切换全库后续研', ['继续核实合成校准', '重选资料后续研']);

  // An ordinary sidebar navigation must not overwrite a prior note history entry.
  await notePage.getByRole('link', { name: '统一检索', exact: true }).click();
  await notePage.waitForURL('**/search');
  await notePage.getByRole('link', { name: '知识问答', exact: true }).click();
  await notePage.getByRole('heading', { name: marker, exact: true }).waitFor();
  assert.equal(await notePage.getByRole('heading', { name: '切换全库后续研', exact: true }).count(), 0);
  await answerForNote('普通问答入口中的提问', [marker]);
  await notePage.goBack();
  await notePage.goBack();
  await notePage.waitForURL('**/ask');
  await notePage.getByRole('heading', { name: '切换全库后续研', exact: true }).waitFor();
  assert.equal(await notePage.getByRole('heading', { name: '普通问答入口中的提问', exact: true }).count(), 0);
  await notePage.reload();
  await notePage.getByRole('heading', { name: '切换全库后续研', exact: true }).waitFor();
  await answerForNote('后退恢复续研', ['继续核实合成校准', '重选资料后续研', '切换全库后续研']);

  // Ordinary search handoff restores the ordinary conversation only.
  await runSearch(notePage, marker, { documentId: noteDocument, kind: 'document' });
  await bodyPanel(notePage).getByRole('checkbox', { name: '选择 ' + noteDocumentTitle, exact: true }).check();
  await notePage.getByRole('link', { name: '基于此资料问答' }).click();
  await noteScope.getByText(noteDocumentTitle, { exact: true }).waitFor();
  await answerForNote('普通检索中的提问', [marker, '普通问答入口中的提问']);
  await notePage.goto(fullNoteUrl);
  await sourceControl.first().waitFor();

  // Withdrawing the source after the note loads must still block a reader click.
  db.prepare("UPDATE documents SET status = 'uploaded' WHERE id = ?").run(noteDocument);
  const deniedFile = await notePage.request.get(origin + noteFileUrl);
  assert.equal(deniedFile.status(), 404);
  assert(!(await deniedFile.text()).includes(noteSourceText));
  const restrictedExport = await downloadedExport('下载 Markdown', '.md');
  const restrictedContent = restrictedExport.bytes.toString('utf8');
  assert(!restrictedContent.includes(noteDocumentTitle) && !restrictedContent.includes(editedBody));
  await noteEditor.getByText(/文件仅包含来源状态/u).waitFor();
  console.log('PASS loaded editor rechecks a withdrawn source when exporting');
  await sourceControl.first().click();
  await noteReader.getByText(/此证据不可读取/).waitFor();
  assert.equal(await noteReader.getByText(noteSourceText, { exact: true }).count(), 0);
  await notePage.reload();
  await sources.getByText(/来源不可读取，可能已失效或无访问权限/).first().waitFor();
  assert.equal(await sourceControl.count(), 0);
  await noteEditor.getByRole('link', { name: '打开检索选取研究资料' }).waitFor();
  await notePage.setViewportSize({ width: 390, height: 844 });
  // Chromium can report the new viewport before applying the compact sidebar styles.
  await notePage.waitForFunction(() =>
    (document.querySelector('.sidebar')?.getBoundingClientRect().width ?? Infinity) <= 64);
  await assertNoHorizontalOverflow(notePage);
  await notePage.screenshot({ path: join(output, 'research-notes-narrow-unavailable.png') });
  const beforeSearch = calls.length;
  await noteEditor.getByRole('link', { name: '打开检索选取研究资料' }).click();
  await notePage.waitForURL('**/search');
  assert.equal(await notePage.getByRole('searchbox', { name: '关键词' }).inputValue(), '合成笔记编辑后的标题');
  assert(!calls.slice(beforeSearch).some(({ pathname }) => ['/api/v1/ask/stream', '/api/v1/search', '/api/v1/quick-search'].includes(pathname)));
  await notePage.setViewportSize({ width: 1440, height: 980 });
  const replacementId = 'fixture-note-replacement';
  const replacementTitle = '研究笔记替代资料';
  const replacementTerm = 'replacementprobe';
  const replacementText = exactQuote + ' ' + replacementTerm;
  insertDocument.run(replacementId, 'sop', replacementTitle, 'ready', replacementId, now.toISOString(), INDEX_VERSION);
  insertChunk.run(replacementId + '-chunk', replacementId, 0, replacementText, segmentForIndex(replacementText), 1,
    '[]', replacementText.length);
  await notePage.getByRole('searchbox', { name: '关键词' }).fill(replacementTerm);
  await notePage.getByRole('button', { name: '搜索', exact: true }).click();
  await bodyPanel(notePage).getByRole('link', { name: '仅检索此资料', exact: true }).click();
  await notePage.getByRole('link', { name: '清除资料范围' }).click();
  await bodyPanel(notePage).getByRole('checkbox', { name: '选择 ' + replacementTitle, exact: true }).check();
  await notePage.getByRole('link', { name: '基于此资料问答', exact: true }).click();
  await noteScope.getByText(replacementTitle, { exact: true }).waitFor();
  await answerForNote('核对重新选择的合成资料');

  async function submitDraftFromCurrentSource(page, expectedKind, snippet) {
    const before = modelCalls.length;
    await page.getByRole('button', { name: '提炼为知识草稿', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '提炼为知识草稿' });
    const submit = dialog.getByRole('button', { name: '生成待确认草稿' });
    assert.equal(await submit.isDisabled(), true);
    assert.equal(modelCalls.length, before);
    if (snippet !== undefined) {
      const savedBody = dialog.getByRole('textbox',{ name:'从已保存笔记中选择要提炼的片段' });
      const exactSelection = await savedBody.evaluate((input,length) => {
        input.focus();
        input.setSelectionRange(0,length);
        return input.value.slice(input.selectionStart,input.selectionEnd);
      },snippet.length);
      assert.equal(exactSelection,snippet);
      await savedBody.dispatchEvent('mouseup');
      await dialog.getByText(`已选 ${snippet.length} / 4000 字`, { exact:true }).waitFor();
    }
    await dialog.getByRole('checkbox').check();
    const [response] = await Promise.all([
      page.waitForResponse((reply) => requestPath(reply) === '/api/v1/knowledge/drafts'),
      submit.click(),
    ]);
    assert.equal(response.status(), 201, await response.text());
    const { entries } = await response.json();
    assert.equal(entries[0].note.draftSource.kind, expectedKind);
    assert.equal(entries[0].status, 'proposed');
    assert.equal(entries[0].documentId, null);
    await dialog.getByRole('link', { name: /预览和编辑/u }).waitFor();
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
    return entries[0];
  }
  await askAnswer.locator('.ask-note-content p').filter({ hasText: exactQuote }).first().evaluate((paragraph) => {
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text !== null && !text.textContent.includes('Check calibrationprobe optical drift.')) text = walker.nextNode();
    if (text === null) throw new Error('Cannot select ask excerpt');
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  const askDraft = await submitDraftFromCurrentSource(notePage, 'ask');
  assert.equal(askDraft.note.draftDetails.claim, 'inference');

  const noteId = new URL(fullNoteUrl).searchParams.get('note');
  const linkedRun = db.prepare('SELECT run_id FROM research_note_runs WHERE note_id=? ORDER BY rowid').get(noteId);
  assert(linkedRun !== undefined);
  const datasetTitle = '研究笔记合成数据集';
  const version = now.toISOString();
  const datasetId = insertCodeAsset(db, {
    name: datasetTitle, location: 'fixture-dataset', project: null, host: null,
    accessNote: null, notes: null, lastCheckResult: 'unchecked', createdBy: userId, profile: { version: 'v1' },
  }, version);
  db.prepare('INSERT INTO research_note_sources(note_id,run_id,citation_id,locator_json) VALUES(?,?,?,?)')
    .run(noteId, linkedRun.run_id, 'E9', JSON.stringify({ kind: 'record', recordId: datasetId, recordType: 'M-CODE', sourceVersion: version }));
  const datasetPath = '/api/v1/research-notes/' + noteId + '/runs/' + linkedRun.run_id + '/sources/E9/record';
  await notePage.goto(fullNoteUrl);
  const datasetSource = sources.getByRole('button', { name: /研究笔记合成数据集.*第 1 轮 · E9/u });
  const datasetStart = calls.length;
  const readableDataset = notePage.waitForResponse((reply) => requestPath(reply) === datasetPath && reply.ok());
  await datasetSource.click();
  assert.equal((await (await readableDataset).json()).recordTitle, datasetTitle);
  await noteReader.getByRole('heading', { name: datasetTitle }).waitFor();
  await notePage.keyboard.press('Escape');
  await noteReader.waitFor({ state: 'hidden' });
  db.prepare('UPDATE ask_records SET user_id = NULL WHERE run_id=?').run(linkedRun.run_id);
  const withdrawnDataset = notePage.waitForResponse((reply) => requestPath(reply) === datasetPath && reply.status() === 404);
  await datasetSource.click();
  await withdrawnDataset;
  await noteReader.getByText(/此证据不可读取/).waitFor();
  assert.equal(await noteReader.getByRole('heading', { name: datasetTitle }).count(), 0);
  assert(!calls.slice(datasetStart).some(({ pathname }) => pathname === '/api/v1/code-assets/' + datasetId + '/evidence'));
  const noteFixture = await notePage.request.post(origin + '/api/v1/research-notes', { data: {
    title: '便签合成草稿', body: '人工保存的合成笔记正文用于离线草稿验证。', tags: [],
  } });
  assert.equal(noteFixture.status(), 201);
  const saved = await noteFixture.json();
  await notePage.goto(origin + '/knowledge/notes?note=' + saved.id);
  await noteEditor.getByRole('heading', { name: '便签合成草稿' }).waitFor();
  await noteEditor.getByLabel('标题').fill('未保存的临时标题');
  assert.equal(await noteEditor.getByRole('button', { name: '提炼为知识草稿' }).count(), 0);
  await noteEditor.getByLabel('标题').fill(saved.title);
  await submitDraftFromCurrentSource(notePage, 'note');
  const noteExcerpt = '合成长笔记第一段选段校验正文。';
  const longNoteFixture = await notePage.request.post(origin + '/api/v1/research-notes', { data: {
    title:'可选择片段的合成长笔记', body:noteExcerpt+'\n'+'填'.repeat(5000),tags:[],
  } });
  assert.equal(longNoteFixture.status(),201);
  const longSaved = await longNoteFixture.json();
  await notePage.goto(origin + '/knowledge/notes?note=' + longSaved.id);
  await noteEditor.getByRole('heading',{name:'可选择片段的合成长笔记'}).waitFor();
  const selectedNoteDraft = await submitDraftFromCurrentSource(notePage,'note',noteExcerpt);
  assert.equal(selectedNoteDraft.note.draftSource.excerpt,noteExcerpt);
  assert.deepEqual(selectedNoteDraft.note.draftSource.selection,{start:0,end:noteExcerpt.length});

  const { documentId: draftDoc } = await uploadDocument(db, config, {
    file: new File(['实验片段合成草稿正文，用于离线浏览器回归。'], 'draft-source.txt'),
    material: 'paper', uploadedBy: userId, consentConfirmedBy: userId,
  });
  await ingestDocument(db, config, draftDoc);
  const draftChunk = db.prepare('SELECT id FROM doc_chunks WHERE doc_id=?').get(draftDoc).id;
  await notePage.goto(origin + '/chunk/' + draftChunk);
  await submitDraftFromCurrentSource(notePage, 'document');

  await notePage.goto(origin + '/knowledge');
  const manualConsent = notePage.getByRole('checkbox', { name: '我已阅读并理解' });
  await manualConsent.check();
  await notePage.getByLabel('要沉淀的内容').fill('手动浏览器路径的合成可确认正文。');
  const [manualResponse] = await Promise.all([
    notePage.waitForResponse((reply) => requestPath(reply) === '/api/v1/knowledge/drafts'),
    notePage.getByRole('button', { name: '生成草案', exact: true }).click(),
  ]);
  assert.equal(manualResponse.status(), 201);
  const manualDraft = (await manualResponse.json()).entries[0];
  assert.equal(manualDraft.note.draftSource.kind, 'manual');
  const manualRow = notePage.locator('.kb-entry').filter({ hasText: manualDraft.content });
  await manualRow.getByRole('button', { name: '编辑草稿' }).click();
  await manualRow.getByRole('textbox', { name: '草稿正文' }).fill('手动浏览器路径人工改写的合成确认正文。');
  await manualRow.getByRole('button', { name: '保存修改' }).click();
  const edited = notePage.locator('.kb-entry').filter({ hasText: '手动浏览器路径人工改写的合成确认正文。' });
  const editedGroup = notePage.locator('.kb-group').filter({ has: edited });
  await editedGroup.getByRole('button', { name: '确认整组（1 条）' }).click();
  await edited.getByText('已生效', { exact: true }).waitFor();
  await notePage.screenshot({ path: join(output, 'knowledge-draft-review.png') });
  assert.deepEqual(pageErrors, []);
  console.log('PASS four browser draft entries, per-action source consent, editor, provenance and manual confirmation');

  const authorSource = [
    '主题：浏览器合成审核', '项目：模拟项目', '版本：v1', '时间：模拟日期', '条件：模拟常温',
    '结论：允许标定', '已发布的旧指标 webg4oldprobe。',
    '校对记录甲。','校对记录乙。','重复核对项。','重复核对项。','重复核对项。',
  ].join('\n');
  async function queueLifecycle(content, source) {
    const generated = await notePage.request.post(origin + '/api/v1/knowledge/drafts', {
      data: { ...(source === undefined ? { text: content } : { source }), consentConfirmed: true },
    });
    assert.equal(generated.status(), 201);
    const { groupId, entries } = await generated.json();
    if (source !== undefined) {
      const draft = entries[0];
      const edit = await notePage.request.patch(origin + '/api/v1/knowledge/' + draft.id + '/draft', {
        data: { revision: draft.note.revision, kind: draft.kind, content },
      });
      assert.equal(edit.status(), 200, await edit.text());
    }
    const decision = await notePage.request.post(origin + '/api/v1/knowledge/groups/' + groupId + '/confirm', {
      data: { consentConfirmed: true },
    });
    assert.equal(decision.status(), 200);
    const { results } = await decision.json();
    return { item: entries[0], outcome: results[0].outcome };
  }
  const lifecycleOld = await queueLifecycle(authorSource);
  assert.equal(lifecycleOld.outcome, 'active');
  const revisedSteps = authorSource.replace('校对记录甲。\n校对记录乙。','校对记录乙。\n校对记录甲。')
    .replace('重复核对项。\n重复核对项。\n重复核对项。','重复核对项。');
  const lifecycleNew = await queueLifecycle(revisedSteps + '\n补充一个合成步骤 webg4pendingprobe。');
  assert.equal(lifecycleNew.outcome, 'conflicted');
  assert.equal(db.prepare("SELECT count(*) AS n FROM doc_chunks_fts WHERE doc_chunks_fts MATCH 'webg4pendingprobe'").get().n, 0);
  const reviewerId = await insertUser(db, 'g4-browser-reviewer', {
    displayName: '合成知识审核员', role: 'mentor', password: 'fixture-only-not-a-real-password',
  }, now);
  const reviewerSession = createSession(db, { userId: reviewerId, now, idleDays: 1, maxDays: 1, ip: null, userAgent: null });
  const reviewPage = await makePage(browser, { width: 1440, height: 980 }, reviewerSession.token);
  reviewPage.on('pageerror', (error) => pageErrors.push(error));
  await reviewPage.goto(origin + '/admin/review');
  const review = reviewPage.locator('.review-detail');
  await review.getByText('补充待审核', { exact: true }).waitFor();
  await review.getByText('来源、版本和正文差异', { exact: true }).click();
  await review.getByText('新来源 手动文本 · 旧来源 手动文本', { exact: true }).waitFor();
  const diffAdded = review.getByText('新提交新增（2 行）', { exact: true }).locator('..');
  const diffRemoved = review.getByText('仅旧条目保留（3 行）', { exact: true }).locator('..');
  await diffAdded.getByText('补充一个合成步骤 webg4pendingprobe。', { exact: true }).waitFor();
  assert.equal(await diffAdded.locator('li').filter({ hasText: '校对记录甲。' }).count(), 1);
  assert.equal(await diffRemoved.locator('li').filter({ hasText: '校对记录甲。' }).count(), 1);
  assert.equal(await diffRemoved.locator('li').filter({ hasText: '重复核对项。' }).count(), 2);
  await reviewPage.screenshot({ path: join(output, 'knowledge-lifecycle-review.png') });
  await review.getByRole('button', { name: '合并发布' }).click();
  const approval = reviewPage.getByRole('dialog', { name: '合并发布？' });
  assert.equal(await approval.getByRole('button', { name: '合并发布' }).isDisabled(), true);
  const reviewedBody = authorSource.replace('已发布的旧指标 webg4oldprobe。', '审核者核对并合并了这两个合成步骤 webg4mergedprobe。');
  await approval.getByRole('textbox', { name: '已核对的合并正文' }).fill(reviewedBody);
  const [accepted] = await Promise.all([
    reviewPage.waitForResponse((response) => requestPath(response) === '/api/v1/knowledge/' + lifecycleNew.item.id + '/resolve'),
    approval.getByRole('button', { name: '合并发布' }).click(),
  ]);
  assert.equal(accepted.status(), 200, await accepted.text());
  const acceptedEntry = (await accepted.json()).entry;
  assert.equal(acceptedEntry.note.lifecycle.mode, 'merge');
  assert.equal(acceptedEntry.content, reviewedBody);
  assert.equal(db.prepare('SELECT status FROM knowledge_entries WHERE id=?').get(lifecycleOld.item.id).status, 'superseded');
  assert((await runSearch(notePage, 'webg4mergedprobe', { material: 'knowledge' })).hits.some((hit) => hit.documentId === acceptedEntry.documentId));
  assert.equal((await runSearch(notePage, 'webg4oldprobe', { material: 'knowledge' })).hits.length, 0);

  const sourceBody = reviewedBody + '\n核验原资料的合成版本 webg4sourceproof。';
  const uploadSource = await notePage.request.post(origin + '/api/v1/documents', { multipart: {
    file: { name: 'browser-review-source.txt', mimeType: 'text/plain',
      buffer: Buffer.from(sourceBody, 'utf8') },
    material: 'paper', consentConfirmed: 'true',
  } });
  assert.equal(uploadSource.status(), 201, await uploadSource.text());
  const sourceDocument = (await uploadSource.json()).document;
  const sourceQueued = await queueLifecycle(sourceBody, { kind: 'document', id: sourceDocument.id,
    chunkId: sourceDocument.firstChunkId, version: String(sourceDocument.indexVersion) });
  assert.equal(sourceQueued.outcome, 'conflicted');
  await reviewPage.reload();
  await review.getByText('来源、版本和正文差异', { exact: true }).click();
  await review.getByRole('button', { name: /^核对原资料/ }).click();
  const reading = reviewPage.getByRole('complementary', { name: readerName });
  await reading.getByText(/核验原资料的合成版本 webg4sourceproof/u).waitFor();
  const downloadHref = await reading.getByRole('link', { name: '下载原件' }).getAttribute('href');
  assert.equal(downloadHref, '/api/v1/knowledge/review/' + sourceQueued.item.id + '/source/file');
  const originalBytes = await reviewPage.request.get(origin + downloadHref);
  assert.equal(originalBytes.status(), 200);
  assert.equal(await originalBytes.text(), sourceBody);
  await reading.getByRole('button', { name: '关闭阅读器' }).click();
  db.prepare('UPDATE documents SET index_version=index_version+1 WHERE id=?').run(sourceDocument.id);
  await review.getByRole('button', { name: /^核对原资料/ }).click();
  await reading.getByText(/此证据不可读取/u).waitFor();
  assert.equal((await reviewPage.request.get(origin + downloadHref)).status(), 404);
  await reviewPage.close();
  console.log('PASS original review document is version-pinned and fails closed on access after reindex');
  await verifyReadability(browser);
  assert.deepEqual(pageErrors, []);
  console.log('PASS lifecycle reviewer compares provenance and changes, explicitly merges, and publishes the reviewed index');
  console.log('PASS research-note save/edit/selection, run-qualified citations, private search prefill and scoped history, dataset reauthorization, withdrawal and no automatic model call');
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
