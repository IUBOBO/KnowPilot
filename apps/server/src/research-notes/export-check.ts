import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Role } from '@knowpilot/shared';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createLabModels } from '../agent/models.ts';
import { insertAskRecord } from '../agent/records.ts';
import { createApp } from '../app.ts';
import { SESSION_COOKIE, createSession } from '../auth/session.ts';
import { insertUser } from '../auth/users.ts';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { createResearchNote } from './repo.ts';

const root = mkdtempSync(join(tmpdir(), 'knowpilot-note-export-'));
const path = join(root, 'fixture.sqlite');
const { db, migration } = openDb(path);
const now = new Date('2026-11-27T00:00:00.000Z');
const stamp = now.toISOString();
const config = {
  ...loadConfig(), repoRoot: root, dbPath: path, uploadDir: join(root, 'uploads'),
  dataRoot: join(root, 'data'), codeRoots: [], hfHome: join(root, 'hf'), embedModelDir: join(root, 'missing-model'),
  deepseekApiKey: undefined, modelBaseUrl: undefined, rerankEnabled: false, rewriteEnabled: false, cookieSecure: false,
};
const models = createLabModels();
models.completeSimple = () => { throw new Error('Export must not request a model'); };
models.streamSimple = () => { throw new Error('Export must not request a model'); };
const app = createApp({ db, config, schemaVersion: migration.toVersion, startedAt: Date.now(), models });

async function account(username: string, role: Role) {
  const id = await insertUser(db, username, { role, password: 'fixture-credential-only', displayName: username }, now);
  const session = createSession(db, { userId: id, now: new Date(), idleDays: 1, maxDays: 1, ip: null, userAgent: null });
  return { id, cookie: SESSION_COOKIE + '=' + session.token };
}

function seedRun(runId: string, userId: string) {
  insertAskRecord(db, {
    runId, userId, question: '合成问题', askedAt: stamp, consentConfirmed: true,
    outcome: 'ok', citationCount: 0, gapCount: 0, rounds: 0, durationMs: 0, warnings: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  });
}

function get(id: string, format: string, actor?: { cookie: string }) {
  return app.request('/api/v1/research-notes/' + id + '/export/' + format,
    { headers: actor === undefined ? {} : { cookie: actor.cookie } });
}

function filename(response: Response) {
  const header = response.headers.get('Content-Disposition');
  assert(header !== null && header.startsWith('attachment;') && !/[\r\n]/u.test(header));
  const name = /filename\*=UTF-8''([^;]+)/u.exec(header);
  assert(name !== null);
  return decodeURIComponent(name[1]!);
}

async function readPdf(data: Uint8Array, xByText?: Map<string, number>) {
  assert.equal(Buffer.from(data.subarray(0, 5)).toString('ascii'), '%PDF-');
  const pdf = await getDocument({ data: new Uint8Array(data), useSystemFonts: false, isEvalSupported: false }).promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const page = await pdf.getPage(n);
      const { items } = await page.getTextContent();
      for (const item of items) if ('str' in item) xByText?.set(item.str, item.transform[4]!);
      pages.push(items.map((item) => 'str' in item ? item.str : '').join(''));
    }
    return pages;
  } finally {
    await pdf.destroy();
  }
}

try {
  const owner = await account('export-owner', 'member');
  const other = await account('export-peer', 'member');
  const admin = await account('export-admin', 'admin');
  const sourceTitle = '合成试验指南';
  const sourceText = '原件正文不进入导出';
  db.prepare('INSERT INTO documents(id,material,title,status,content_hash,created_at,index_version,source_path) VALUES(?,?,?,?,?,?,?,?)')
    .run('fixture-doc', 'paper', sourceTitle, 'ready', 'fixture-hash', stamp, 2, 'private-source-path');
  db.prepare('INSERT INTO doc_chunks(id,doc_id,ordinal,text,text_seg,token_count,page,section_path) VALUES(?,?,?,?,?,?,?,?)')
    .run('fixture-chunk', 'fixture-doc', 0, sourceText, sourceText, 1, 5, '["方法","校准"]');
  const runId = 'fixture-export-run';
  seedRun(runId, owner.id);
  db.prepare("UPDATE ask_records SET citation_count = 1 WHERE run_id = ?").run(runId);
  db.prepare(
    "INSERT INTO ask_run_traces (run_id,user_id,asked_at,outcome,stop_reason,delivery_status,last_stage,model,prompt_hash,route," +
    "duration_ms,turn,evidence_count,context_chars,budget_json,tool_trace_json,retrieval_hits_json,record_evidence_json," +
    "citation_map_json,claim_checks_json,plan_json,rewrite_rounds,rewrite_events_json,warnings_json,errors_json,recorded_at)" +
    " VALUES (?,?,?,'ok','completed','verified','assembly','fixture','fixture','simple'," +
    "1,1,1,20,'{}','[]','[]','[]',?,'[]','{}',0,'[]','[]','[]',?)"
  ).run(runId, owner.id, stamp, JSON.stringify([
    { id: 'E1', documentId: 'fixture-doc', chunkId: 'fixture-chunk', sourceVersion: '2' },
  ]), stamp);
  const noCitation = 'fixture-empty-run';
  seedRun(noCitation, owner.id);
  const body = [
    '## 实验记录',
    '合成摘录须在撤回后消失[第 1 轮 · E1]',
    '### 结果与公式',
    '- 计算式 $E = mc^2$，校准结果。',
    '  - 嵌套条目',
    '- 同层条目',
    '内联比较 $x<y$，内联函数 $f[x](y)$。',
    '内联代码 `logger([C](z));`。',
    '```js',
    'logger([D](w));',
    '```',
    '$$',
    'F=[A](x)',
    '$$',
    '\\[',
    'G=[B](w)',
    '\\]',
    '![校准曲线说明](https://example.invalid/example.png)',
    '| 试验号 | 中文观测 |',
    '| --- | --- |',
    ...Array.from({ length: 62 }, (_, i) => '| 试验 ' + String(i + 1).padStart(2, '0') + ' | 设备校准与长期观测 |'),
    '| 跨页长单元格 | ' + '跨页内容必须完整。'.repeat(450) + ' 表格单元格结束 |',
    '## 表后结论',
    '| ' + '超长表头'.repeat(14) + ' | 保留此列 |',
    '| --- | --- |',
    '| 原表资料 | 保留此行 |',
    '',
    '无边框列甲 | 无边框列乙',
    '------ | :---:',
    '无边框值甲 | 无边框值乙',
    '',
    '| ' + '超高表头'.repeat(310) + ' 标签末端 | 续列 |',
    '| --- | --- |',
    '| 高表数据 | 保留续列 |',
  ].join('\n');
  const title = '合成校准记录';
  const tag = '合成私有标签';
  const note = createResearchNote(db, owner.id, { title, body, tags: [tag],
    runs: [{ runId, mode: 'answer' }, { runId: noCitation, mode: 'reference' }] });

  for (const ext of ['md', 'pdf']) {
    assert.equal((await get(note.id, ext)).status, 401);
    for (const actor of [other, admin]) {
      const response = await get(note.id, ext, actor);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('Content-Disposition'), null);
      assert(!(await response.text()).includes('合成校准记录'));
    }
  }
  assert.equal((await get(note.id, 'html', owner)).status, 400);
  const md = await get(note.id, 'md', owner);
  assert.equal(md.status, 200);
  assert.equal(md.headers.get('Content-Type'), 'text/markdown; charset=utf-8');
  assert.equal(md.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(md.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(md.headers.get('X-KnowPilot-Export-Restricted'), null);
  const safeName = filename(md);
  assert(!/[.]{2}|[\\/\r\n:]/u.test(safeName) && safeName.endsWith('.md'));
  const markdown = await md.text();
  const safeBody = body.replace('![校准曲线说明](https://example.invalid/example.png)', '（图表：校准曲线说明）');
  assert(markdown.includes(safeBody), 'Markdown retains saved text, formulas and tables with an inert chart label');
  assert(!markdown.includes('example.invalid'));
  assert(markdown.includes(tag) && markdown.includes(note.createdAt) && markdown.includes(note.updatedAt));
  assert(markdown.includes('第 1 轮 · E1：' + sourceTitle + '（第 5 页 · 章节 方法 / 校准 · 版本 2）'));
  assert(markdown.includes('第 2 轮：本轮未保留可核验来源'));
  assert(!markdown.includes(sourceText) && !markdown.includes('private-source-path'));

  const response = await get(note.id, 'pdf', owner);
  assert.equal(response.status, 200, await (response.status === 200 ? Promise.resolve('') : response.text()));
  assert.equal(response.headers.get('Content-Type'), 'application/pdf');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(filename(response), safeName.slice(0, -2) + 'pdf');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const artifacts = process.env['KP_EXPORT_TEST_ARTIFACTS'];
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, 'synthetic-research-note.md'), markdown, 'utf8');
    writeFileSync(join(artifacts, 'synthetic-research-note.pdf'), bytes);
  }
  const horizontal = new Map<string, number>();
  const pages = await readPdf(bytes, horizontal);
  const pdfText = pages.join('');
  assert(pages.length >= 4);
  assert(pages.filter((page) => page.replaceAll(/\s/gu, '').includes('中文观测')).length >= 3);
  for (const snippet of ['合成校准记录', '试验01', '试验62', '表格单元格结束', '表后结论', '$E=mc^2$',
    '图表：校准曲线说明', '第1轮·E1', '合成试验指南', '第5页', '保留此行',
    '$x<y$', '$f[x](y)$', 'F=[A](x)', 'G=[B](w)', 'logger([C](z));', 'logger([D](w));',
    '无边框列甲', '无边框值乙', '列1：超高表头', '标签末端', '高表数据', '保留续列']) {
    assert(pdfText.replaceAll(/\s/gu, '').includes(snippet), 'Missing from exported PDF: ' + snippet);
  }
  assert(!pdfText.includes('example.invalid') && !pdfText.includes('private-source-path'));
  assert(!pdfText.includes(' | 无边框列乙'), 'Borderless Markdown table is rendered in separate cells');
  function x(label: string) {
    const item = [...horizontal.entries()].find(([text]) => text.includes(label));
    assert(item, 'Missing PDF position: ' + label);
    return item[1];
  }
  assert(x('嵌套条目') > x('同层条目'));
  assert(x('无边框值乙') > x('无边框值甲'));
  const unsafe = createResearchNote(db, owner.id, { title: '../合成校准\r\nX-Fake: value', tags: [], body: '' });
  const normalizedName = filename(await get(unsafe.id, 'md', owner));
  assert(!/[.]{2}|[\\\\/\r\n:]/u.test(normalizedName) && normalizedName.endsWith('.md'));
  const safe = createResearchNote(db, owner.id, { title: 'CON.txt', tags: [], body: '' });
  assert.equal(filename(await get(safe.id, 'md', owner)), '研究笔记.md');

  // A zero-citation run was fully exportable above. A positive count with the same
  // missing trace must suppress free text in both downloadable formats.
  const changeCitationCount = db.prepare('UPDATE ask_records SET citation_count = ? WHERE run_id = ?');
  changeCitationCount.run(1, noCitation);
  const incomplete = await get(note.id, 'md', owner);
  const incompletePdf = await get(note.id, 'pdf', owner);
  assert.equal(incomplete.headers.get('X-KnowPilot-Export-Restricted'), 'true');
  assert.equal(incompletePdf.headers.get('X-KnowPilot-Export-Restricted'), 'true');
  for (const output of [await incomplete.text(), (await readPdf(new Uint8Array(await incompletePdf.arrayBuffer()))).join('')]) {
    assert(output.includes('部分引用记录缺失，无法核验'));
    assert(!output.includes(title) && !output.includes(tag) && !output.includes('合成摘录须在撤回后消失'));
  }
  changeCitationCount.run(0, noCitation);
  assert.equal((await get(note.id, 'md', owner)).headers.get('X-KnowPilot-Export-Restricted'), null);

  // A changed version and a revoked document each require a fresh decision.
  db.prepare('UPDATE documents SET index_version = 3 WHERE id = ?').run('fixture-doc');
  const guardedMedia = createResearchNote(db, owner.id, {
    title: '媒体描述', tags: [], body: [
      '```invalid`info',
      '<img src="https://example.invalid/html.png">',
      '![缩略图][media]',
      '[media]: https://example.invalid/raw.png',
      '$x<y$ 与 $f<x>y$',
      '$$',
      '<img',
      'src="https://example.invalid/math.png">',
      '$$',
    ].join('\n'),
  });
  const guardedText = await (await get(guardedMedia.id, 'md', owner)).text();
  assert(guardedText.includes('&lt;img') && guardedText.includes('（图表：缩略图）'));
  assert(guardedText.includes('$x<y$') && guardedText.includes('$f&lt;x>y$'));
  assert(guardedText.includes('&lt;img\nsrc="https://example.invalid/math.png">'));
  assert(!guardedText.includes('<img') && !guardedText.includes('![缩略图]'));
  const dedented = createResearchNote(db, owner.id, {
    title: '列表代码与独立图片', tags: [], body: [
      '- 准备检查',
      '  ```markdown',
      '  内部示例代码',
      '',
      '<img src="https://example.invalid/after-dedent.png">',
      '![独立图片说明](https://example.invalid/after-dedent-2.png)',
    ].join('\n'),
  });
  const dedentedText = await (await get(dedented.id, 'md', owner)).text();
  assert(dedentedText.includes('内部示例代码') && dedentedText.includes('&lt;img'));
  assert(dedentedText.includes('（图表：独立图片说明）'));
  assert(!dedentedText.includes('<img') && !dedentedText.includes('![独立图片说明]'));


  const changed = await get(note.id, 'md', owner);
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.get('X-KnowPilot-Export-Restricted'), 'true');
  assert((await changed.text()).includes('引用版本已变更'));
  db.prepare('UPDATE documents SET status = ? WHERE id = ?').run('deleted', 'fixture-doc');
  const revoked = await get(note.id, 'md', owner);
  assert.equal(revoked.headers.get('X-KnowPilot-Export-Restricted'), 'true');
  const revokedText = await revoked.text();
  const revokedPdf = await get(note.id, 'pdf', owner);
  assert.equal(revokedPdf.headers.get('X-KnowPilot-Export-Restricted'), 'true');
  const revokedPdfText = (await readPdf(new Uint8Array(await revokedPdf.arrayBuffer()))).join('');
  for (const output of [revokedText, revokedPdfText]) {
    assert(output.includes('来源不可用或无权访问'));
    for (const secret of ['合成校准记录', '合成摘录须在撤回后消失', sourceTitle, sourceText, tag]) {
      assert(!output.includes(secret), 'Restricted export included free text');
    }
  }
  assert(!filename(revokedPdf).includes('合成校准记录'));

  db.prepare('DELETE FROM ask_records WHERE run_id = ?').run(runId);
  const missing = await get(note.id, 'md', owner);
  assert.equal(missing.headers.get('X-KnowPilot-Export-Restricted'), 'true');
  assert((await missing.text()).includes('问答记录已失效或无权访问'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM knowledge_entries').get()?.n, 0);

  console.log('PASS: owner-only authenticated export, revision fidelity, no-store, UTF-8 fallback filename, version/permission recheck, and restricted Markdown/PDF.');
  console.log('PASS: ' + String(pages.length) + ' PDF pages with extractable Chinese, repeated table headers, long cell continuation, formulas, chart alt and qualified citations.');
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
