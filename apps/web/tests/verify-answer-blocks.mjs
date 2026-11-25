import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const runner = process.env.KP_UI_PLAYWRIGHT;
assert(runner, 'Set KP_UI_PLAYWRIGHT to the installed Playwright index.mjs path');
const { chromium } = await import(pathToFileURL(resolve(runner)).href);
const output = resolve(process.env.KP_UI_ARTIFACTS ?? resolve(root, '../../tmp/v2-03-check/screenshots'));
await mkdir(output, { recursive: true });
const server = await createServer({
  root, configFile: false, server: { host: '127.0.0.1', port: 4390, strictPort: true },
});
let browser;
try {
  await server.listen();
  const executablePath = process.env.KP_UI_BROWSER;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1024, height: 860 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:4390/tests/answer-block-fixture.html');
  await page.getByRole('heading', { name: '相关文档' }).waitFor();
  const section = (name) => page.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await section('相关文档').getByRole('link', { name: '来源 1：合成论文甲' }).click();
  const received = page.getByLabel('模拟阅读器请求');
  assert.deepEqual(JSON.parse(await received.textContent()), {
    version: 1, citation: { runId: 'fixture-document', citationId: 'E1' },
    locator: { kind: 'document', documentId: 'document-E1', chunkId: 'chunk-E1', sourceVersion: '5' },
  });
  assert.equal(await page.getByLabel('当前路由').textContent(), '/');

  await page.getByRole('button', { name: '简单问答', exact: true }).click();
  await page.getByText('合成旧文本仍可读取。').waitFor();
  assert.equal(await page.getByRole('heading', { name: '相关文档' }).count(), 0);

  await page.getByRole('button', { name: '多论文比较', exact: true }).click();
  await section('论文资料').getByRole('strong').filter({ hasText: /^合成论文乙$/u }).waitFor();
  await page.getByRole('region', { name: '指标对比表' }).getByRole('cell', { name: '91', exact: true }).waitFor();

  await page.getByRole('button', { name: '指标分析', exact: true }).click();
  const meter = section('指标图表').getByRole('meter', { name: '合成论文甲 准确率' });
  await meter.waitFor();
  assert.equal(await meter.getAttribute('value'), '95');

  await page.getByRole('button', { name: '投稿进展', exact: true }).click();
  await section('记录时间线').getByText('外审中', { exact: true }).waitFor();
  await section('相关记录').getByRole('link', { name: '来源 3：合成投稿' }).click();
  assert.deepEqual(JSON.parse(await received.textContent()).locator, {
    kind: 'record', recordType: 'M-SUBMIT', recordId: 'fixture-record', sourceVersion: '2026-01-01T00:00:00Z',
  });

  await page.getByRole('button', { name: '综合报告', exact: true }).click();
  await page.getByRole('heading', { name: '摘要' }).waitFor();
  await page.getByRole('heading', { name: '指标图表' }).waitFor();
  await page.getByRole('heading', { name: '核对依据' }).waitFor();
  await page.getByRole('heading', { name: '参考步骤' }).waitFor();
  await page.getByText(/已省略比较/).waitFor();
  await section('摘要').getByRole('paragraph').getByRole('link', { name: '来源 1：合成论文甲' }).click();
  assert.equal(JSON.parse(await received.textContent()).citation.citationId, 'E1');
  await section('补充说明').getByRole('row', { name: /阅读摘要/u }).getByRole('link', { name: '来源 2：合成论文乙' }).click();
  assert.equal(JSON.parse(await received.textContent()).citation.citationId, 'E2');
  await section('指标图表').getByRole('link', { name: '来源 1：合成论文甲' }).press('Enter');
  assert.equal(JSON.parse(await received.textContent()).citation.citationId, 'E1');
  assert.equal(await page.getByLabel('当前路由').textContent(), '/');
  await page.getByRole('button', { name: '综合报告', exact: true }).click();
  await page.screenshot({ path: resolve(output, 'answer-blocks-desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole('checkbox', { name: '模拟阅读器接收' }).uncheck();
  await section('核对依据').getByRole('link', { name: '来源 2：合成论文乙' }).click();
  assert.equal(await page.getByLabel('当前路由').textContent(), '/chunk/chunk-E2');
  assert.deepEqual(errors, []);
  console.log('PASS: six synthetic answer scenarios, mock document/record reader request, legacy link and narrow layout');
} finally {
  try {
    await browser?.close();
  } finally {
    await server.close();
  }
}
