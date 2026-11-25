import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preview } from 'vite';

const here = fileURLToPath(new URL('../', import.meta.url));
const runner = process.env.KP_UI_PLAYWRIGHT;
assert(runner, 'Set KP_UI_PLAYWRIGHT to the installed Playwright index.mjs path');
const { chromium } = await import(pathToFileURL(resolve(runner)).href);
const outputs = resolve(process.env.KP_UI_ARTIFACTS ?? resolve(here, '../../tmp/v2-02/screenshots'));
const origin = 'http://127.0.0.1:4382';
const mockOrigin = 'http://127.0.0.1:4383';
const now = '2026-11-24T12:00:00.000Z';
const questions = {
  report: '请整理合成样例的仪器对照报告',
  follow: '给出下一步维护建议',
  canceled: '取消这次模拟问答',
  failed: '模拟请求失败',
};
const doc = { id: 'fixture-doc', title: '公开合成 · 仪器校准手册', material: 'sop', fileName: 'fixture.pdf' };
const chunk = { id: 'fixture-chunk', ordinal: 0, page: 2, sectionPath: ['校准', '对照'], text: '合成原文：先记录空载读数，再进行三轮对照。' };
const citation = {
  id: 'E1', sourceType: 'document', documentId: doc.id, documentTitle: doc.title, material: doc.material,
  page: 2, sectionPath: chunk.sectionPath, chunkId: chunk.id, score: 1, excerpt: chunk.text,
  quote: '先记录空载读数，再进行三轮对照。', originalChars: chunk.text.length, sourceVersion: '1',
};
const LONG = 'SampleColumn'.repeat(16);
const INERT_HTML = '<img src="/synthetic-unsafe-image" onerror="window.fixtureHtmlRan=true">';
const INERT_MATH = String.raw`\href{https://example.invalid/math}{链接测试}`;
const FENCE = '```';
const report = [
  '## 仪器读数与误差',
  '',
  '采用 **三轮对照** 核对读数，误差 $x^2 + y^2$ 用于示例。[E1]',
  '',
  String.raw`$$\frac{1}{2}+\sqrt{3}$$`,
  '',
  '1. 记录空载读数',
  '2. 记录校准后读数',
  '',
  '- 第一份样品',
  '- 第二份样品',
  '',
  '| 指标 | 合成观测值 | 数据来源 |',
  '| --- | ---: | --- |',
  '| 空载读数 | 0.02 | 校准手册 [E1] |',
  '| 长字段 | ' + LONG + ' | 合成样例 |',
  '',
  FENCE + 'typescript',
  'const sample = "' + LONG + '";',
  '## 详细说明',
  '/*' + INERT_HTML + ' [E1] */',
  FENCE,
  '',
  '原始 HTML 样例仅供安全回归 ' + INERT_HTML,
  '[不可信链接](javascript:void(0))',
  '$' + INERT_MATH + '$',
  '',
  '行内长公式 $' + 'x_1+x_2+'.repeat(16) + 'x_3$ 用于核对窄屏。',
  '',
  '## 详细说明',
  '',
  ...Array.from({ length: 16 }, (_, i) => '第 ' + (i + 1) + ' 节建议多次测量，保留对照条件和原始读数。'.repeat(5)),
].join('\n');
const verification = { status: 'verified', counts: { supported: 0, contradicted: 0, insufficient: 0, review_required: 0 }, claims: [] };

function answer(runId, question, body, delivery = {}) {
  return {
    runId, question,
    answer: {
      answer: body, citations: [citation], evidenceGaps: [], limits: [], confidenceNotes: [], conflicts: [],
      verification, warnings: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      rounds: 1, durationMs: 1200,
    },
    delivery: { status: 'verified', stopReason: 'completed', evidenceCount: 1, contextChars: 20,
      verifiedClaimIds: [], unverifiedClaimIds: [], ...delivery },
  };
}

function json(response, payload, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
}

const activity = new EventEmitter();
const calls = [];
const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, mockOrigin);
  const parts = [];
  for await (const part of request) parts.push(part);
  const posted = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : null;
  const call = { pathname, method: request.method, posted };
  calls.push(call);

  if (pathname === '/api/v1/auth/me') return json(response, {
    user: { id: 'fixture-user', username: 'fixture-user', displayName: '合成测试成员', role: 'member', groupId: null },
    permissions: ['knowledge.read', 'agent.ask', 'submission.read.all'],
  });
  if (pathname === '/api/v1/documents') return json(response, { items: [], hasMore: false });
  if (pathname === '/api/v1/submissions') return json(response, { items: [] });
  if (pathname === '/api/v1/chunks/fixture-chunk') return json(response, { document: doc, chunk, siblings: [chunk], archivedIndexVersion: 1 });
  if (pathname.endsWith('/review')) return json(response, {
    claims: [{ statement: '对照条件已核对', verdict: 'supported', reason: '模拟复核依据', evidence: [{ citationId: 'E1', quote: citation.quote }] }],
    costUsd: null, unavailableSourceCount: 0,
  });
  if (pathname.endsWith('/feedback')) return json(response, { feedback: {
    ...posted, runId: pathname.split('/').at(-2), userId: 'fixture-user', reasons: posted.reasons ?? [],
    note: posted.note ?? null, createdAt: now, updatedAt: now,
  } });
  if (pathname === '/api/v1/ask/stream' || pathname === '/api/v1/agent-tasks/fixture-resume/resume') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.flushHeaders();
    activity.emit('stream', {
      ...call,
      closed: once(response, 'close'),
      send(event) {
        response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
      },
      finish() { response.end(); },
    });
    return;
  }
  json(response, { error: {
    code: 'not_found', title: '合成测试响应', message: '该列表在本场景无需返回数据。', retryable: false, requestId: 'fixture',
  } }, 404);
});

async function visible(locator) {
  await locator.waitFor({ state: 'visible' });
}

function waitForStream() {
  return once(activity, 'stream', { signal: AbortSignal.timeout(8000) }).then(([run]) => run);
}

async function ask(page, question) {
  const received = waitForStream();
  await page.getByRole('textbox', { name: /你的问题|继续追问/ }).fill(question);
  await page.getByRole('button', { name: /^(提问|追问)$/ }).click();
  return received;
}

function terminal(run, type, response) {
  run.send({ type, response });
  run.finish();
}

async function noPageOverflow(page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
}

async function focusIs(locator) {
  await visible(locator);
  const winner = await locator.elementHandle();
  await locator.page().waitForFunction((node) => node === document.activeElement, winner);
}

async function openAsFixture(page) {
  await page.goto(origin + '/ask');
  await visible(page.getByRole('heading', { name: '知识问答' }));
  const consent = page.getByRole('checkbox', { name: '我已阅读并理解' });
  if (!await consent.isChecked()) {
    assert(await page.getByRole('button', { name: '请先勾选上方云端确认' }).isDisabled());
    await consent.check();
  }
}

let frontend;
let browser;
try {
  await mkdir(outputs, { recursive: true });
  server.listen(new URL(mockOrigin).port, '127.0.0.1');
  await once(server, 'listening');
  frontend = await preview({ configFile: false, root: here, preview: {
    host: '127.0.0.1', port: 4382, strictPort: true, proxy: { '/api': { target: mockOrigin } },
  } });
  const options = process.env.KP_UI_BROWSER ? { executablePath: process.env.KP_UI_BROWSER } : {};
  browser = await chromium.launch({ headless: true, ...options });
  const errors = [];
  const external = [];
  const makePage = async (viewport) => {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin === origin) await route.continue();
      else { external.push(route.request().url()); await route.abort(); }
    });
    await openAsFixture(page);
    return page;
  };

  const desktop = await makePage({ width: 1360, height: 900 });
  const first = await ask(desktop, questions.report);
  assert.deepEqual(first.posted, { question: questions.report, consentConfirmed: true });
  first.send({ type: 'status', phase: 'retrieval', message: '正在检索', stepId: 'r1', state: 'start', atMs: 1 });
  first.send({ type: 'status', phase: 'retrieval', message: '正在检索', stepId: 'r1', state: 'end', durationMs: 400 });
  first.send({ type: 'evidence', total: 1, added: 1 });
  first.send({ type: 'draft_delta', text: [
    '## 合成草稿标题',
    '',
    '- 旧草稿不可引用 [E1]',
    '',
    '| 项目 | 读数 |',
    '| --- | --- |',
    '| 草稿表格内容 | 暂定 [E1] |',
  ].join('\n') });
  const draft = desktop.getByRole('region', { name: '回答草稿' });
  await visible(draft.getByText('旧草稿不可引用'));
  assert(await draft.getByRole('heading', { name: '合成草稿标题' }).isVisible(), 'Draft heading is formatted before terminal event');
  assert(await draft.getByRole('listitem').getByText('旧草稿不可引用').isVisible());
  assert(await draft.getByRole('table').getByRole('cell', { name: '草稿表格内容' }).isVisible());
  assert.equal(await draft.getByRole('link').count(), 0);
  assert(!/\[E1\]/u.test(await draft.textContent()));
  first.send({ type: 'draft_reset' });
  await draft.waitFor({ state: 'hidden' });
  first.send({ type: 'draft_delta', text: '新草稿' });
  await visible(draft.getByText('新草稿'));
  terminal(first, 'verified_final', answer('fixture-report', questions.report, report));
  const article = desktop.getByRole('article', { name: '回答' });
  await visible(article.getByRole('heading', { name: '仪器读数与误差' }));
  assert.equal(await draft.count(), 0);
  await visible(article.getByRole('table'));
  const details = article.getByText('详细说明', { exact: true });
  await details.click();
  await visible(article.getByText(/第 16 节/u));
  await noPageOverflow(desktop);
  await details.click();
  await visible(article.getByText('记录空载读数', { exact: true }));
  await visible(article.getByText('第二份样品', { exact: true }));
  await visible(article.locator('math').first());
  await visible(article.getByRole('region', { name: '回答公式' }).locator('math'));
  assert.match(await article.getByRole('region', { name: '回答代码' }).textContent(), /## 详细说明/u);
  assert.match(await article.textContent(), /<img src=/u);
  assert.equal(await article.locator('img, script, a[href^="javascript:"], a[href*="example.invalid"]').count(), 0);
  assert.equal(await desktop.evaluate(() => window.fixtureHtmlRan), undefined);

  const source = article.getByRole('link', { name: '来源 1：' + doc.title }).first();
  await source.focus();
  await visible(article.getByRole('tooltip').getByText(citation.quote, { exact: true }));
  await source.hover();
  await visible(article.getByRole('tooltip').getByText(citation.quote, { exact: true }));
  assert.equal(await source.getAttribute('href'), '/chunk/fixture-chunk');

  const open = article.getByRole('button', { name: '来源（1）' });
  const wide = (await article.boundingBox()).width;
  await open.click();
  const aside = desktop.getByRole('complementary', { name: '来源（1）' });
  await visible(aside);
  await focusIs(aside.getByRole('button', { name: '关闭来源' }));
  assert((await article.boundingBox()).width < wide - 180);
  assert.equal(await open.getAttribute('aria-expanded'), 'true');
  await noPageOverflow(desktop);
  await desktop.evaluate(() => window.scrollTo(0, 0));
  await desktop.screenshot({ path: resolve(outputs, 'desktop.png'), animations: 'disabled' });
  await desktop.keyboard.press('Escape');
  await aside.waitFor({ state: 'hidden' });
  await focusIs(open);
  assert(Math.abs((await article.boundingBox()).width - wide) < 2);

  await source.click();
  await visible(desktop.getByRole('heading', { name: doc.title }));
  await visible(desktop.getByText(/历史原文片段/u));
  await desktop.getByRole('link', { name: /返回知识问答/u }).click();
  await visible(article.getByRole('heading', { name: '仪器读数与误差' }));
  await desktop.getByText('查询过程', { exact: true }).click();
  await visible(desktop.getByText(/找到 1 条/u));
  await article.getByRole('button', { name: '复核依据' }).click();
  await visible(article.getByRole('region', { name: '模型复核结果' }).getByText('原文支持'));
  assert(calls.some((call) => call.pathname.endsWith('/fixture-report/review') && call.posted.answer === report &&
    call.posted.consentConfirmed === true));
  await article.getByRole('button', { name: '有帮助', exact: true }).click();
  await visible(article.getByText('已记录 · 有帮助'));
  assert(calls.some((call) => call.pathname.endsWith('/fixture-report/feedback') && call.posted.rating === 'up'));

  const follow = await ask(desktop, questions.follow);
  assert.equal(follow.posted.history[0].question, questions.report);
  terminal(follow, 'partial', answer('fixture-partial', questions.follow, '暂时取得一份依据。', {
    status: 'partial', taskId: 'fixture-resume', resumeAvailable: true, stopReason: 'rounds',
  }));
  const resumeReceived = waitForStream();
  await desktop.getByRole('button', { name: '继续查找依据' }).click();
  const resumed = await resumeReceived;
  assert.equal(resumed.pathname, '/api/v1/agent-tasks/fixture-resume/resume');
  assert.deepEqual(resumed.posted, {});
  terminal(resumed, 'verified_final', answer('fixture-resumed', questions.follow, '合成续跑完成。', { taskId: 'fixture-resume' }));
  await visible(article.getByText('合成续跑完成。'));
  await desktop.getByText(/问答历史（2\/10 轮）/u).click();
  await article.getByRole('button', { name: '来源（1）' }).click();
  await visible(aside);
  await desktop.getByRole('button', { name: questions.report }).click();
  await aside.waitFor({ state: 'hidden' });
  await focusIs(desktop.getByRole('heading', { name: questions.report }));
  await visible(article.getByRole('heading', { name: '仪器读数与误差' }));
  await desktop.getByRole('button', { name: '返回最新问答' }).click();
  await visible(article.getByText('合成续跑完成。'));

  const canceled = await ask(desktop, questions.canceled);
  canceled.send({ type: 'draft_delta', text: '模拟取消前的草稿' });
  await visible(draft.getByText('模拟取消前的草稿'));
  await desktop.getByRole('button', { name: '停止', exact: true }).click();
  await visible(desktop.getByText('已停止本次查询。'));
  await Promise.race([canceled.closed, once(activity, 'never', { signal: AbortSignal.timeout(5000) })]);
  assert.equal(calls.filter((call) => call.posted?.question === questions.canceled).length, 1);
  assert.equal(await draft.count(), 0);
  await desktop.getByRole('button', { name: questions.follow }).click();
  await visible(article.getByText('合成续跑完成。'));

  const failing = await ask(desktop, questions.failed);
  failing.send({ type: 'failed', error: { error: {
    code: 'upstream_unavailable', title: '合成故障', message: '模拟上游暂时不可用。', retryable: true, requestId: 'fixture-error',
  } } });
  failing.finish();
  await visible(desktop.getByText('合成故障'));
  const retried = waitForStream();
  await desktop.getByRole('button', { name: '重试' }).click();
  const retry = await retried;
  assert.deepEqual(retry.posted, failing.posted);
  terminal(retry, 'interrupted', answer('fixture-interrupted', questions.failed, '合成中断。', { status: 'interrupted', stopReason: 'wall' }));
  await visible(article.getByText('查询中断。可以继续查找。'));
  assert.equal(await desktop.getByRole('button', { name: '继续查找依据' }).count(), 0);

  const mobile = await makePage({ width: 390, height: 844 });
  const narrow = await ask(mobile, questions.report);
  terminal(narrow, 'verified_final', answer('fixture-mobile', questions.report, report));
  const narrowArticle = mobile.getByRole('article', { name: '回答' });
  await visible(narrowArticle.getByRole('region', { name: '回答公式' }).locator('math'));
  const scrollCode = await narrowArticle.getByRole('region', { name: '回答代码' }).evaluate((el) => el.scrollWidth > el.clientWidth);
  assert(scrollCode);
  assert(await narrowArticle.getByRole('region', { name: '回答表格' }).evaluate((el) => el.scrollWidth > el.clientWidth));
  const scrollMath = narrowArticle.getByRole('region', { name: '回答行内公式' });
  await visible(scrollMath);
  assert(await scrollMath.evaluate((el) => el.scrollWidth > el.clientWidth));
  assert.equal(await scrollMath.getAttribute('tabindex'), '0');
  await scrollMath.focus();
  await mobile.keyboard.press('ArrowRight');
  await mobile.waitForFunction((el) => el.scrollLeft > 0, await scrollMath.elementHandle());
  await noPageOverflow(mobile);
  await mobile.evaluate(() => window.scrollTo(0, 0));
  await mobile.screenshot({ path: resolve(outputs, 'narrow.png'), animations: 'disabled' });
  const narrowTrigger = narrowArticle.getByRole('button', { name: '来源（1）' });
  await narrowTrigger.click();
  const modal = mobile.getByRole('dialog', { name: '来源（1）' });
  await visible(modal);
  const close = modal.getByRole('button', { name: '关闭来源' });
  const original = modal.getByRole('link', { name: '查看原文' });
  await focusIs(original);
  await mobile.keyboard.press('Shift+Tab');
  await focusIs(close);
  await mobile.keyboard.press('Tab');
  await focusIs(original);
  await mobile.screenshot({ path: resolve(outputs, 'narrow-reader.png'), animations: 'disabled' });
  await mobile.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  await focusIs(narrowTrigger);
  assert.equal(await narrowTrigger.getAttribute('aria-expanded'), 'false');
  await noPageOverflow(mobile);
  await mobile.getByRole('link', { name: '投稿台账' }).click();
  await visible(mobile.getByRole('heading', { name: '投稿台账' }));
  await mobile.getByRole('link', { name: '知识问答', exact: true }).click();
  await visible(narrowArticle.getByRole('heading', { name: '仪器读数与误差' }));
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert(!calls.some((call) => call.pathname === '/synthetic-unsafe-image'));
  console.log('PASS: responsive layout, safe Markdown/MathML, streamed draft/final/error/cancel, source navigation, review, feedback, history, resume, and keyboard focus');
  console.log('Screenshots: desktop.png, narrow.png, narrow-reader.png');
} finally {
  await browser?.close();
  await frontend?.close();
  server.closeAllConnections();
  if (server.listening) await new Promise((done) => server.close(done));
}
