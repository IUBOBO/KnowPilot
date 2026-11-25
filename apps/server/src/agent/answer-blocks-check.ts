import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream, type Api, type AssistantMessageEventStream,
  type JsonObject, type Model, type ToolCall,
} from '@earendil-works/pi-ai';
import { segmentForIndex, type AskStreamEvent, type Citation, type DocumentCitation, type RecordCitation } from '@knowpilot/shared';
import { isAnswerBlocks } from '@knowpilot/shared/answer-blocks';
import { createApp } from '../app.ts';
import { createSession, SESSION_COOKIE } from '../auth/session.ts';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { composeAnswerBlocks } from './answer-blocks.ts';
import { createLabModels } from './models.ts';

const now = '2026-01-01T00:00:00.000Z';
const metricText = (value: string, dataset = '合成数据集') =>
  `实测结果：准确率：${value}%；数据集：${dataset}；实验设置：固定划分；统计口径：宏平均`;
const sourceTable = '| 核对项 | 来源 |\n| --- | --- |\n| 阅读摘要 | 论文乙 |';
const sourceTableWithMark = sourceTable.replace('论文乙', '论文乙 [E2]');
const summaryLine = '资料摘录可核对';
const doc = (id: string, value: string, dataset?: string): DocumentCitation => {
  const supplemental = id === 'E1' ? [summaryLine, '阅读合成来源'] : id === 'E2' ? [sourceTable] : [];
  const excerpt = [metricText(value, dataset), ...supplemental].join('\n');
  return {
    id, sourceType: 'document', documentId: `doc-${id}`, documentTitle: `合成论文 ${id}`,
    material: 'paper', page: 2, sectionPath: ['合成结果'], chunkId: `chunk-${id}`, score: 1,
    sourceVersion: '5', excerpt, originalChars: excerpt.length, quote: excerpt,
  };
};
const record: RecordCitation = {
  id: 'E4', sourceType: 'record', recordType: 'M-SUBMIT', recordId: 'fixture-submission',
  sourceVersion: now, queryTime: now, recordUpdatedAt: now, recordTitle: '合成投稿',
  fields: [{ label: '状态', value: '外审中' }], excerpt: '状态：外审中', originalChars: 6,
};
const point = (evidence_id: string, value: string, dataset = '合成数据集') => ({
  metric: '准确率', unit: '%', dataset, setting: '固定划分', protocol: '宏平均', evidence_id, value,
  quote: metricText(value, dataset),
});
const cites: Citation[] = [doc('E1', '95'), doc('E2', '91'), doc('E3', '87', '其他合成数据集'), record];

assert.equal(composeAnswerBlocks(undefined, cites), undefined);
assert.equal(composeAnswerBlocks([], cites), undefined);
const set = composeAnswerBlocks([
  { kind: 'documents', evidence_ids: ['E1'] },
  { kind: 'papers', evidence_ids: ['E1', 'E2'] },
  { kind: 'comparison', points: [point('E1', '95'), point('E2', '91')] },
  { kind: 'chart', points: [point('E1', '95'), point('E2', '91')] },
  { kind: 'timeline', evidence_ids: ['E4'] },
  { kind: 'summary', text: summaryLine + ' [E1]', evidence_ids: ['E1'] },
  { kind: 'evidence', evidence_ids: ['E1', 'E4'] },
  { kind: 'steps', evidence_ids: ['E1'] },
], cites);
assert(isAnswerBlocks(set));
assert.equal(set.version, 1);
assert.deepEqual(set.items.map(({ kind }) => kind), [
  'documents', 'papers', 'comparison', 'chart', 'timeline', 'summary', 'evidence', 'steps',
]);
assert.deepEqual(set.items[3], {
  kind: 'chart', metric: '准确率', dataset: '合成数据集', unit: '%', setting: '固定划分', protocol: '宏平均',
  points: [{ evidenceId: 'E1', value: '95' }, { evidenceId: 'E2', value: '91' }],
});

assert.equal(composeAnswerBlocks([
  { kind: 'markdown', text: sourceTableWithMark, evidence_ids: ['E2'] },
], cites)?.items[0]?.kind, 'markdown');

const cases = [
  { kind: 'documents', evidence_ids: ['E999'] },
  { kind: 'documents', evidence_ids: ['E1'], documentTitle: '客户端不得接纳的伪造标题' },
  { kind: 'summary', text: '额外标记 [E2]', evidence_ids: ['E1'] },
  { kind: 'markdown', text: '<b>伪造组件</b>', evidence_ids: ['E1'] },
  { kind: 'unknown', evidence_ids: ['E1'] },
  { kind: 'chart', points: [point('E1', '5'), point('E2', '91')] },
  { kind: 'chart', points: [{ ...point('E1', '5'), quote: metricText('95') }, point('E2', '91')] },
  { kind: 'chart', points: [point('E1', '95'), point('E3', '87', '其他合成数据集')] },
];
assert.deepEqual(composeAnswerBlocks(cases, cites)?.items, [
  ...Array.from({ length: 7 }, () => ({ kind: 'fallback', reason: 'unverified' })),
  { kind: 'fallback', reason: 'incomparable' },
]);
assert.deepEqual(composeAnswerBlocks([
  { kind: 'markdown', text: '虚构报告显示准确率99%。[E1]', evidence_ids: ['E1'] },
  { kind: 'summary', text: '| 指标 | 值 |\n| -- | -- |\n| 准确率 | 99% | [E1]', evidence_ids: ['E1'] },
  { kind: 'summary', text: '准确率达九十九点五个百分点。[E1]', evidence_ids: ['E1'] },
  { kind: 'summary', text: '准确率提高九个百分点。[E1]', evidence_ids: ['E1'] },
  { kind: 'markdown', text: '准确率达到九%。[E1]', evidence_ids: ['E1'] },
  { kind: 'summary', text: '准确率达到玖％。[E1]', evidence_ids: ['E1'] },
  { kind: 'markdown', text: metricText('95') + '[E1]', evidence_ids: ['E1'] },
  { kind: 'markdown', text: '1. 阅读合成来源 [E1]', evidence_ids: ['E1'] },
], cites)?.items.map((item) => item.kind), [
  'fallback', 'fallback', 'fallback', 'fallback', 'fallback', 'fallback', 'markdown', 'markdown',
]);
assert.deepEqual(composeAnswerBlocks([
  { kind: 'summary', text: 'Fifty percent of the samples passed. [E1]', evidence_ids: ['E1'] },
  { kind: 'markdown', text: '半数受试样本通过校验。[E1]', evidence_ids: ['E1'] },
  { kind: 'summary', text: summaryLine + '\n材料结论无需核验。 [E1]', evidence_ids: ['E1'] },
  { kind: 'markdown', text: sourceTableWithMark.replace('来源', '已证实的依据'), evidence_ids: ['E2'] },
], cites)?.items.map(({ kind }) => kind), ['fallback', 'fallback', 'fallback', 'fallback']);
for (const line of ['Fifty percent of the samples passed.', '半数受试样本通过校验。']) {
  assert.equal(composeAnswerBlocks([
    { kind: 'summary', text: line + ' [E1]', evidence_ids: ['E1'] },
  ], [{ ...doc('E1', '95'), excerpt: line }])?.items[0]?.kind, 'fallback');
  const measured = '实测结果：' + line;
  assert.equal(composeAnswerBlocks([
    { kind: 'summary', text: measured + ' [E1]', evidence_ids: ['E1'] },
  ], [{ ...doc('E1', '95'), excerpt: measured }])?.items[0]?.kind, 'summary');
}
assert.deepEqual(composeAnswerBlocks({ arbitrary: true }, cites)?.items, [{ kind: 'fallback', reason: 'unverified' }]);
assert.equal(composeAnswerBlocks([
  { kind: 'markdown', text: '95% 的样本通过校验。[E1]', evidence_ids: ['E1'] },
], [{ ...doc('E1', '95'), excerpt: '195% 的样本通过校验。' }])?.items[0]?.kind, 'fallback');
assert.equal(composeAnswerBlocks([
  { kind: 'chart', points: [point('E1', '95'), point('E2', '91')] },
], [{ ...doc('E1', '95'), excerpt: '未达到的目标' + metricText('95') }, doc('E2', '91')])?.items[0]?.kind, 'fallback');
for (const excerpt of [
  '本节仅为尚未实测的目标。\n' + metricText('95'),
  metricText('95') + '\nThis is a projected target.',
]) {
  assert.equal(composeAnswerBlocks([
    { kind: 'chart', points: [point('E1', '95'), point('E2', '91')] },
  ], [{ ...doc('E1', '95'), excerpt }, doc('E2', '91')])?.items[0]?.kind, 'fallback');
}
assert.equal(composeAnswerBlocks([
  { kind: 'summary', text: '准确率：95%。[E1]', evidence_ids: ['E1'] },
], [{ ...doc('E1', '95'), excerpt: '仅为预期情况，尚未测量。\n准确率：95%。' }])?.items[0]?.kind, 'fallback');
const threshold = metricText('95').replace('实测结果：', '');
const thresholdCitation = { ...doc('E1', '95'), excerpt: '下列数值仅用于验收门槛，最终结果尚未公布：\n' + threshold };
assert.deepEqual(composeAnswerBlocks([
  { kind: 'chart', points: [{ ...point('E1', '95'), quote: threshold }, point('E2', '91')] },
  { kind: 'summary', text: threshold + '[E1]', evidence_ids: ['E1'] },
], [thresholdCitation, doc('E2', '91')])?.items.map(({ kind }) => kind), ['fallback', 'fallback']);
const neutralCitation = { ...doc('E1', '95'), excerpt: threshold };
assert.deepEqual(composeAnswerBlocks([
  { kind: 'chart', points: [{ ...point('E1', '95'), quote: threshold }, point('E2', '91')] },
  { kind: 'summary', text: threshold + '[E1]', evidence_ids: ['E1'] },
], [neutralCitation, doc('E2', '91')])?.items.map(({ kind }) => kind), ['fallback', 'fallback']);
assert.equal(isAnswerBlocks({ ...set, version: 99 }), false);
assert.equal(isAnswerBlocks({ version: 1, items: [{ kind: 'documents', evidenceIds: ['E1'], url: '/arbitrary' }] }), false);
console.log('PASS: shared schemas, verified source types/IDs, extractive prose and tables, literal numeric binding, comparison context, safe fallback');

const root = mkdtempSync(join(tmpdir(), 'knowpilot-v2-blocks-'));
const cfg = {
  ...loadConfig(), repoRoot: root, dbPath: ':memory:', port: 0,
  uploadDir: join(root, 'uploads'), dataRoot: join(root, 'datasets'), codeRoots: [],
  hfHome: join(root, 'hf'), embedModelDir: join(root, 'models'), ocrEnabled: false,
  deepseekApiKey: 'offline-model-stub', modelBaseUrl: undefined, rerankEnabled: false, rewriteEnabled: false,
};
const { db, migration } = openDb(':memory:');
const models = createLabModels();
const fakeModel = models as unknown as { streamSimple: (model: Model<Api>) => AssistantMessageEventStream };
const fixtureExcerpt = 'answerblockfixture 合成手册片段可供复验。';
const backedSummary = fixtureExcerpt + ' [E1]';
const ownBody = '定位到合成手册记录。[E1]';

try {
  db.prepare("INSERT INTO users (id,username,display_name,password_hash,role,created_at,updated_at) VALUES ('fixture','fixture','合成人员','unused','member',?,?)").run(now, now);
  db.prepare("INSERT INTO documents (id,material,title,status,content_hash,created_at,index_version) VALUES ('fixture-doc','paper','合成手册','ready','fixture',?,5)").run(now);
  db.prepare("INSERT INTO doc_chunks (id,doc_id,ordinal,text,text_seg,page,section_path,token_count) VALUES ('fixture-chunk','fixture-doc',0,?,?,2,'[]',?)")
    .run(fixtureExcerpt, segmentForIndex(fixtureExcerpt), fixtureExcerpt.length);
  const session = createSession(db, { userId: 'fixture', now: new Date(), idleDays: 1, maxDays: 1, ip: null, userAgent: null });
  const app = createApp({ db, config: cfg, schemaVersion: migration.toVersion, startedAt: Date.now(), models });

  async function ask(blocks?: JsonObject[]): Promise<AskStreamEvent[]> {
    let calls = 0;
    fakeModel.streamSimple = (model) => {
      const stream = createAssistantMessageEventStream();
      calls += 1;
      assert(calls <= 2, 'Unexpected tool rejection or extra generation');
      const tool: ToolCall = calls === 1
        ? { type: 'toolCall', id: 'tool-1', name: 'retrieve', arguments: { query: 'answerblockfixture', mode: 'keyword' } }
        : { type: 'toolCall', id: 'tool-2', name: 'submit_answer', arguments: {
          answer: ownBody, quotes: [{ evidence_id: 'E1', quote: fixtureExcerpt }],
          evidence_gaps: [], limits: [], confidence_notes: [], conflicts: [],
          ...(blocks === undefined ? {} : { blocks }),
        } };
      queueMicrotask(() => stream.push({
        type: 'done', reason: 'toolUse',
        message: {
          role: 'assistant', content: [tool], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse', timestamp: Date.now(),
        },
      }));
      return stream;
    };
    const res = await app.request('/api/v1/ask/stream', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: SESSION_COOKIE + '=' + session.token },
      body: JSON.stringify({ question: '合成测试', consentConfirmed: true }),
    });
    assert.equal(res.status, 200);
    return (await res.text()).split(/\r?\n/u).filter((line) => line.startsWith('data: ')).map(
      (line) => JSON.parse(line.slice(6)) as AskStreamEvent,
    );
  }

  function result(events: AskStreamEvent[]) {
    const terminal = events.filter((event) => event.type === 'verified_final' || event.type === 'partial');
    assert.equal(terminal.length, 1);
    assert(events.some((event) => event.type === 'evidence'));
    return terminal[0]!.response.answer;
  }
  const legacy = result(await ask());
  const modern = result(await ask([
    { kind: 'papers', evidence_ids: ['E1'] },
    { kind: 'summary', text: backedSummary, evidence_ids: ['E1'] },
    { kind: 'markdown', text: 'Fifty percent of the samples passed. [E1]', evidence_ids: ['E1'] },
    { kind: 'unsupported', evidence_ids: ['E1'] },
  ]));
  assert.equal(legacy.answer, ownBody);
  assert.equal(legacy.blocks, undefined);
  assert.equal(modern.answer, legacy.answer);
  assert.deepEqual(modern.citations, legacy.citations);
  assert.equal(modern.citations[0]?.sourceVersion, '5');
  assert.deepEqual(modern.blocks, {
    version: 1, items: [
      { kind: 'papers', evidenceIds: ['E1'] },
      { kind: 'summary', text: backedSummary, evidenceIds: ['E1'] },
      { kind: 'fallback', reason: 'unverified' },
      { kind: 'fallback', reason: 'unverified' },
    ],
  });
  console.log('PASS: authenticated real Hono SSE and submit_answer path with fixture model, old response and citation parity');
} finally {
  db.close();
}
