import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preview } from 'vite';

const here = fileURLToPath(new URL('../', import.meta.url));
const runner = process.env.KP_UI_PLAYWRIGHT;
assert(runner, 'Set KP_UI_PLAYWRIGHT to the Playwright index.mjs');
const { chromium } = await import(pathToFileURL(resolve(runner)).href);
const origin = 'http://127.0.0.1:4396';
const api = 'http://127.0.0.1:4397';
const outputs = resolve(process.env.KP_UI_ARTIFACTS ?? 'tmp/v2-06/screenshots');
const fixture = new EventEmitter();
const routing = { version: 1, step: { order: 0, phase: 'intent', atMs: 0, state: 'done', durationMs: 2 }, counts: {} };
const lookup = { order: 1, phase: 'retrieval', source: 'documents', atMs: 2, state: 'done',
  durationMs: 110, candidates: 0, newEvidence: 0, actualMode: 'keyword',
  lookup: { requestedMode: 'hybrid', scope: 'document', material: 'paper', limit: 4 } };
const runningLookup = { order: lookup.order, phase: lookup.phase, source: lookup.source, atMs: lookup.atMs, state: 'running' };
const results = { candidates: 0, pooled: 0, documents: 0, modelVisible: 0, citations: 0 };
const closedProcess = { version: 1, steps: [routing.step, lookup], counts: results };
const terminal = (runId, question, process) => ({
  type: 'verified_final',
  response: {
    runId, question, ...(process === undefined ? {} : { process }),
    answer: { answer: '这次没有取得可引用资料。', citations: [], evidenceGaps: [], limits: [], confidenceNotes: [],
      conflicts: [], warnings: [], verification: { status: 'not_checked', claims: [], counts: {} },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, rounds: 1, durationMs: 800 },
    delivery: { status: 'verified', stopReason: 'completed', evidenceCount: 0, contextChars: 0,
      verifiedClaimIds: [], unverifiedClaimIds: [] },
  },
});

const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, api);
  const body = [];
  for await (const part of request) body.push(part);
  if (pathname === '/api/v1/ask/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.flushHeaders();
    fixture.emit('run', {
      question: JSON.parse(Buffer.concat(body)).question,
      send(event) { response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n'); },
      finish() { response.end(); },
    });
    return;
  }
  const payload = pathname === '/api/v1/auth/me'
    ? { user: { id: 'fixture-process-user', username: 'test-process', displayName: '合成测试', role: 'member', groupId: null },
        permissions: ['knowledge.read', 'agent.ask'] }
    : { items: [], hasMore: false };
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
});

async function ask(page, question) {
  const received = once(fixture, 'run', { signal: AbortSignal.timeout(8000) });
  await page.getByRole('textbox', { name: /你的问题|继续追问/ }).fill(question);
  await page.getByRole('button', { name: /^(提问|追问)$/u }).click();
  const [run] = await received;
  assert.equal(run.question, question);
  return run;
}

function status(run, observation) {
  run.send({ type: 'status', state: observation.step.state === 'running' ? 'start' : 'end',
    stepId: 'fixture-step-' + observation.step.order, message: 'fixture-only prompt text',
    atMs: observation.step.atMs, process: observation });
}

let frontend;
let browser;
const errors = [];
try {
  await mkdir(outputs, { recursive: true });
  server.listen(4397, '127.0.0.1');
  await once(server, 'listening');
  frontend = await preview({ configFile: false, root: here, preview: {
    host: '127.0.0.1', port: 4396, strictPort: true, proxy: { '/api': { target: api } },
  } });
  browser = await chromium.launch({ headless: true,
    ...(process.env.KP_UI_BROWSER ? { executablePath: process.env.KP_UI_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, reducedMotion: 'reduce' });
  page.on('pageerror', (failure) => errors.push(failure.message));
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === origin) await route.continue();
    else { errors.push('Unexpected external request'); await route.abort(); }
  });
  await page.goto(origin + '/ask');
  await page.getByRole('heading', { name: '知识问答' }).waitFor();
  await page.getByRole('checkbox', { name: '我已阅读并理解' }).check();
  const first = await ask(page, '合成查询没有找到候选');
  status(first, routing);
  status(first, { version: 1, step: runningLookup, counts: {} });
  const summary = page.locator('summary').filter({ hasText: '查询过程' });
  await summary.waitFor();
  await summary.click();
  await page.getByText(/候选（逐次合计）未观察到/u).waitFor();
  status(first, { version: 1, step: lookup, counts: { candidates: 0, pooled: 0, documents: 0 } });
  await page.getByText(/候选（逐次合计）0/u).waitFor();
  first.send(terminal('fixture-process-final', first.question, closedProcess));
  first.finish();
  await page.getByRole('article', { name: '回答' }).waitFor();
  await summary.waitFor();
  assert.equal(await summary.evaluate((element) => element.parentElement.open), false);
  await summary.click();
  await page.getByText(/模型上下文 0.*终稿引用 0/u).waitFor();
  await page.getByText(/子查询（词已脱敏）.*请求 混合.*单文档.*上限 4/u).waitFor();
  assert.equal(await page.getByText(/已重排|补查 ·|fixture-only prompt text/u).count(), 0);
  await page.screenshot({ path: resolve(outputs, 'process.png') });
  const old = await ask(page, '旧版本历史答复');
  old.send(terminal('fixture-old', old.question));
  old.finish();
  await page.getByText(/查询过程不可用/u).waitFor();
  await page.getByText(/问答历史（2\/10 轮）/u).click();
  await page.getByRole('button', { name: first.question }).click();
  await summary.waitFor();
  await summary.click();
  await page.getByText(/终稿引用 0/u).waitFor();
  const skipped = await ask(page, '合成证据额度用尽');
  status(skipped, { version: 1, step: { ...runningLookup, state: 'skipped' }, counts: {} });
  await summary.waitFor();
  await summary.click();
  await page.getByText('证据额度用尽 · 未检索', { exact: true }).waitFor();
  await page.getByText(/候选（逐次合计）检索未执行/u).waitFor();
  assert.equal(await page.getByText(/候选 0|新增证据|子查询（词已脱敏）/u).count(), 0);
  skipped.send(terminal('fixture-skipped', skipped.question));
  skipped.finish();
  await page.getByRole('article', { name: '回答' }).waitFor();
  const cancelled = await ask(page, '合成取消进行中');
  status(cancelled, { version: 1, step: runningLookup, counts: {} });
  await summary.waitFor();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByText('已停止本次查询。').waitFor();
  await summary.click();
  await page.getByText('中断', { exact: true }).waitFor();
  const failed = await ask(page, '合成请求意外失败');
  status(failed, { version: 1, step: runningLookup, counts: {} });
  await summary.waitFor();
  failed.send({ type: 'failed', error: { error: {
    code: 'upstream_unavailable', title: '合成故障', message: '模拟请求失败。', retryable: true, requestId: 'fixture-process',
  } } });
  failed.finish();
  await page.getByText('合成故障').waitFor();
  await summary.click();
  await page.getByText('失败', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: observed SSE, unavailable versus zero counts, collapsed final answer, legacy and saved history, cancellation and failure, no external requests');
} finally {
  await browser?.close();
  if (frontend !== undefined) await new Promise((done) => frontend.httpServer.close(done));
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
