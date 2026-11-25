import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  INDEX_VERSION, segmentForIndex, type DocumentRetrievalRequest, type RecordRetrievalHit, type RetrievalResponseV1, type SearchResponse,
} from '@knowpilot/shared';
import { createApp } from '../app.ts';
import { EvidencePool } from '../agent/evidence.ts';
import { createLabModels } from '../agent/models.ts';
import { createPeopleTool, createSubmissionsTool } from '../agent/live-tools.ts';
import { createRetrieveTool } from '../agent/tools.ts';
import { SESSION_COOKIE, createSession, deleteSession } from '../auth/session.ts';
import { submissionScope } from '../auth/scope.ts';
import { embeddingModelKey, loadConfig, onnxPath } from '../config.ts';
import { openDb } from '../db/index.ts';
import { searchDocuments } from '../documents/search.ts';
import { saveEmbeddings } from '../documents/vector.ts';
import { seedCorpus } from '../eval/corpus.ts';
import { getPatentFor } from '../patents/repo.ts';
import { queryLedger } from './records.ts';
import { retrieveDocumentsV1 } from './service.ts';

const root = mkdtempSync(join(tmpdir(), 'knowpilot-v2-retrieval-'));
const cfg = {
  ...loadConfig(), repoRoot: root, dbPath: ':memory:', port: 0,
  uploadDir: join(root, 'uploads'), dataRoot: join(root, 'datasets'),
  codeRoots: [join(root, 'datasets')], hfHome: join(root, 'hf'),
  embedModelDir: join(root, 'unavailable-model'), embedModelId: 'adversarial-fixture-only',
  deepseekApiKey: undefined, modelBaseUrl: undefined, ocrEnabled: false, rerankEnabled: false, rewriteEnabled: false,
};
const { db, migration } = openDb(':memory:');
const now = '2026-01-01T00:00:00Z';
const marker = 'scopeFixtureMark';
const personSecret = '0000000000001';

const corpus = await seedCorpus(db, cfg);
for (const [id, material, status, version] of [
  ['scoped', 'rule', 'ready', INDEX_VERSION - 1],
  ['outside', 'paper', 'ready', INDEX_VERSION],
  ['pending', 'rule', 'uploaded', INDEX_VERSION],
  ['failed', 'experience', 'failed', INDEX_VERSION],
  ['no-chunks', 'sop', 'ready', INDEX_VERSION],
] as const) {
  db.prepare('INSERT INTO documents(id,material,title,status,content_hash,created_at,index_version) VALUES(?,?,?,?,?,?,?)')
    .run(id, material, id, status, id, now, version);
}
for (const [id, docId, ordinal] of [
  ['block-1', 'scoped', 0], ['block-2', 'scoped', 1], ['block-3', 'scoped', 2], ['outside-1', 'outside', 0],
] as const) {
  const text = marker + ' ' + id;
  db.prepare('INSERT INTO doc_chunks(id,doc_id,ordinal,text,text_seg,page,section_path,token_count) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, docId, ordinal, text, segmentForIndex(text), ordinal + 2, JSON.stringify(['测试章节']), text.length);
}
db.prepare('INSERT INTO people(id,name,student_no,note,created_at,updated_at) VALUES(?,?,?,?,?,?)')
  .run('person-protected', '合成人员', personSecret, '受保护备注', now, now);

db.prepare('INSERT INTO patents(id,name,owner_user_id,created_at,updated_at) VALUES(?,?,?,?,?)')
  .run('owned-patent', '合成专利', corpus.userA.id, now, now);

const app = createApp({ db, config: cfg, schemaVersion: migration.toVersion, startedAt: Date.now(), models: createLabModels() });
const session = createSession(db, {
  userId: corpus.userA.id, now: new Date(), idleDays: 1, maxDays: 1, ip: null, userAgent: null,
});
const cookie = SESSION_COOKIE + '=' + session.token;
const request = async (params: Record<string, string>, authenticated = true) => {
  const path = '/api/v1/search?' + new URLSearchParams(params);
  return app.request(path, authenticated ? { headers: { cookie } } : {});
};
const v1 = async (params: Record<string, string>): Promise<RetrievalResponseV1> => {
  const res = await request({ contractVersion: '1', ...params });
  assert.equal(res.status, 200);
  return await res.json() as RetrievalResponseV1;
};

try {
  const legacy = await request({ q: marker, mode: 'keyword', material: 'rule', limit: '3' });
  assert.equal(legacy.status, 200);
  assert.deepEqual(await legacy.json() as SearchResponse, await searchDocuments(db, cfg, {
    query: marker, mode: 'keyword', material: 'rule', limit: 3,
  }));
  const criteria = { q: marker, mode: 'keyword', documentId: 'scoped', candidateLimit: '3' };
  const first = await v1({ ...criteria, limit: '1' });
  const second = await v1({ ...criteria, limit: '2', offset: '1' });
  const all = [...first.hits, ...second.hits];
  assert.equal(first.version, 1);
  assert.equal(first.nextOffset, 1);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set(all.map((hit) => hit.kind === 'document' ? hit.chunkId : null)).size, 3);
  for (const hit of all) {
    assert.equal(hit.kind, 'document');
    assert.equal(hit.documentId, 'scoped');
    assert.equal(hit.sourceVersion, String(INDEX_VERSION - 1));
    assert.ok(hit.excerpt.includes(marker));
    assert.deepEqual(hit.sectionPath, ['测试章节']);
    assert.deepEqual(hit.matchedBy, ['keyword']);
    assert.ok((hit.page ?? 0) >= 2);
  }
  assert.deepEqual(first.diagnostics, ['index_stale']);
  const pool = new EvidencePool();
  const tool = createRetrieveTool({ db, config: cfg, pool, documentId: 'scoped' });
  const toolResult = await tool.execute('test', { query: marker, mode: 'keyword', limit: 3 });
  assert.equal(toolResult.details?.hitCount, all.length);
  assert.deepEqual(pool.all().map((ev) => ev.kind === 'document' ? [ev.chunkId, ev.sourceVersion] : null),
    all.map((hit) => hit.kind === 'document' ? [hit.chunkId, hit.sourceVersion] : null));
  assert.equal((await v1({ ...criteria, material: 'paper' })).state, 'empty');
  assert.equal((await v1({ ...criteria, q: 'unseenText' })).state, 'empty');
  const pending = await v1({ ...criteria, documentId: 'pending' });
  assert.equal(pending.state, 'empty');
  assert.deepEqual(pending.diagnostics, ['index_unavailable']);
  const scopedNoMatch = await v1({ q: 'unseenText', mode: 'keyword', material: 'rule' });
  assert.equal(scopedNoMatch.state, 'empty');
  assert.deepEqual(new Set(scopedNoMatch.diagnostics), new Set(['index_unavailable', 'index_stale']));
  const mixed = await v1({ q: marker, mode: 'keyword', material: 'rule' });
  assert.equal(mixed.state, 'ok');
  assert.ok(mixed.diagnostics.includes('index_unavailable'));
  for (const material of ['experience', 'sop']) {
    const incomplete = await v1({ q: 'unseenText', mode: 'keyword', material });
    assert.equal(incomplete.state, 'empty');
    assert.deepEqual(incomplete.diagnostics, ['index_unavailable']);
  }
  const cleanNoMatch = await v1({ q: 'unseenText', mode: 'keyword', material: 'paper' });
  assert.equal(cleanNoMatch.state, 'empty');
  assert.deepEqual(cleanNoMatch.diagnostics, []);
  const outOfScope = await v1({ ...criteria, material: 'paper', documentId: 'pending' });
  assert.deepEqual(outOfScope.diagnostics, []);
  const { db: emptyDb } = openDb(':memory:');
  try {
    const noDocuments = await retrieveDocumentsV1(emptyDb, cfg, {
      version: 1, query: marker, strategy: 'keyword', limit: 5, offset: 0, candidateLimit: 5,
      scope: { kind: 'document', material: 'rule' },
    });
    assert.equal(noDocuments.state, 'empty');
    assert.deepEqual(noDocuments.diagnostics, []);
  } finally {
    emptyDb.close();
  }
  const fallback = await v1({ ...criteria, mode: 'hybrid' });
  assert.equal(fallback.strategy, 'keyword');
  assert.ok(fallback.diagnostics.includes('vector_model_unavailable'));
  console.log('✓ Material scope reports stale and unavailable indexes without conflating no-match or no-documents');
  console.log('✓ Legacy JSON, V1 paging, Agent parity, source location and lexical fallback');

  const fakeModel = { ...cfg, rerankEnabled: true, embedModelDir: join(root, 'fake-model') };
  mkdirSync(dirname(onnxPath(fakeModel)), { recursive: true });
  writeFileSync(onnxPath(fakeModel), '');
  const docRequest: DocumentRetrievalRequest = {
    version: 1, query: marker, offset: 0, limit: 3, candidateLimit: 3,
    scope: { kind: 'document', documentId: 'scoped' }, strategy: 'hybrid',
  };
  const missing = await retrieveDocumentsV1(db, fakeModel, { ...docRequest, strategy: 'semantic' });
  assert.equal(missing.state, 'empty');
  assert.ok(missing.diagnostics.includes('vector_missing'));
  saveEmbeddings(db, embeddingModelKey(fakeModel), [{ chunkId: 'block-1', vec: new Float32Array([1, 0]) }], 2, now);
  const timedOut = await retrieveDocumentsV1(db, fakeModel, docRequest, {
    rankChunks: async (_db, _cfg, _query, _depth, scope) => {
      assert.ok(scope?.has('block-1'));
      assert.ok(!scope?.has('outside-1'));
      return [{ chunkId: 'block-1', score: 0.2 }];
    },
    scorePassages: async () => { throw new Error('fixture rerank timeout'); },
  });
  assert.equal(timedOut.ranking?.mode, 'rrf');
  assert.ok(timedOut.diagnostics.includes('rerank_fallback'));
  assert.ok(timedOut.diagnostics.includes('vector_partial'));
  assert.ok(!timedOut.notice?.includes('fixture rerank timeout'));
  const semanticRequest = { ...docRequest, strategy: 'semantic' } as const;
  for (const score of [0.2, 0, -1]) {
    const weak = await retrieveDocumentsV1(db, fakeModel, semanticRequest, {
      rankChunks: async () => [{ chunkId: 'block-1', score }],
    });
    assert.equal(weak.state, 'ok');
    assert.ok(weak.diagnostics.includes('low_relevance'));
    if (score <= 0) assert.ok(!weak.notice?.includes('特别贴合'));
  }
  const noSemanticHits = await retrieveDocumentsV1(db, fakeModel, semanticRequest, {
    rankChunks: async () => [],
  });
  assert.equal(noSemanticHits.state, 'empty');
  assert.ok(!noSemanticHits.diagnostics.includes('low_relevance'));
  const weakHybrid = await retrieveDocumentsV1(db, { ...fakeModel, rerankEnabled: false }, {
    ...docRequest, query: 'unseenText',
  }, { rankChunks: async () => [{ chunkId: 'block-1', score: -1 }] });
  assert.equal(weakHybrid.state, 'ok');
  assert.ok(weakHybrid.diagnostics.includes('low_relevance'));
  const failed = await retrieveDocumentsV1(db, fakeModel, docRequest, {
    rankChunks: async () => { throw new Error('fixture embed error'); },
  });
  assert.equal(failed.strategy, 'keyword');
  assert.ok(failed.diagnostics.includes('vector_query_failed'));
  console.log('✓ Synthetic vector scope, vector coverage, low relevance and rerank timeout fallback');

  assert.equal(getPatentFor(db, 'owned-patent', { userId: 'different-owner', canReadAll: false }), null);
  assert.equal(getPatentFor(db, 'owned-patent', { userId: corpus.userA.id, canReadAll: false })?.id, 'owned-patent');
  assert.equal(getPatentFor(db, 'owned-patent', { userId: 'different-owner', canReadAll: true })?.id, 'owned-patent');

  const records = await v1({ recordType: 'M-SUBMIT', recordId: corpus.targetSubmissionId, q: 'query-ignored-on-id' });
  const record = records.hits[0];
  assert.equal(records.strategy, 'structured');
  assert.equal(records.nextOffset, null);
  assert.equal(record?.kind, 'record');
  assert.equal(record?.recordId, corpus.targetSubmissionId);
  assert.equal(record?.sourceVersion, record?.recordUpdatedAt);
  assert.ok(record?.excerpt.includes('状态'));
  const recordPool = new EvidencePool();
  const submission = createSubmissionsTool({ db, config: cfg, pool: recordPool, scope: submissionScope(corpus.userA) });
  await submission.execute('test-record', { record_id: corpus.targetSubmissionId, offset: 1 });
  assert.equal(recordPool.all()[0]?.sourceVersion, record?.sourceVersion);
  const filtered = await v1({ recordType: 'M-SUBMIT', status: 'accepted_pending' });
  assert.equal(filtered.state, 'empty');
  const page1 = await v1({ recordType: 'M-SUBMIT', limit: '1' });
  assert.equal(page1.nextOffset, 1);
  const page2 = await v1({ recordType: 'M-SUBMIT', limit: '1', offset: '1' });
  const recordIds = [page1, page2].map((page) => page.hits[0]?.kind === 'record' ? page.hits[0].recordId : null);
  assert.equal(new Set(recordIds).size, 2);

  const known = await v1({ recordType: 'M-PERSON', q: '合成人员' });
  assert.equal(known.hits.length, 1);
  const privateQuery = await v1({ recordType: 'M-PERSON', q: personSecret });
  assert.equal(privateQuery.state, 'empty');
  assert.ok(!JSON.stringify(known).includes(personSecret));
  const people = createPeopleTool(db, recordPool, corpus.userA);
  await people.execute('hidden-field', { keyword: personSecret });
  assert.ok(!recordPool.all().some((entry) => entry.kind === 'record' && entry.recordType === 'M-PERSON'));
  // CLI/Agent without a session keeps the pre-existing public-only submission scope.
  const hidden = queryLedger(db, {
    type: 'M-SUBMIT', status: undefined, keyword: undefined, recordId: corpus.targetSubmissionId, offset: 0, limit: 1,
  }, {}, now);
  assert.equal(hidden.matched, 0);
  assert.equal((await request({ contractVersion: '1', recordType: 'M-SUBMIT', recordId: corpus.targetSubmissionId }, false)).status, 401);
  console.log('✓ Shared submission read, exact-ID scope, structured paging and private person fields');

  for (const params of [
    { contractVersion: '2' }, { contractVersion: '1', offset: '-1' },
    { contractVersion: '1', recordId: 'no-type' },
    { contractVersion: '1', recordType: 'M-SUBMIT', recordId: corpus.targetSubmissionId, offset: '1' },
    { contractVersion: '1', recordType: 'M-SUBMIT', recordId: corpus.targetSubmissionId, status: 'accepted_pending' },
    { contractVersion: '1', recordType: 'M-SUBMIT', material: 'rule' },
    { contractVersion: '1', recordType: 'M-SUBMIT', mode: 'semantic' },
    { contractVersion: '1', candidateLimit: '999' },
    { contractVersion: '1', recordType: 'M-SUBMIT', status: 'not-a-status' },
    { contractVersion: '1', recordType: 'M-PERSON', year: '2026' },
  ]) {
    const query = Object.fromEntries(Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined));
    assert.equal((await request(query)).status, 400);
  }
  console.log('✓ Reject unsupported version, invalid paging, source, strategy and scope');

  const assetPath = '/api/v1/code-assets/fixture-asset/evidence';
  const journalId = 'fixture-journal';
  const rankingPath = '/api/v1/journals/' + journalId + '/rankings/evidence?';
  const period = (year: string, category: string) => rankingPath + new URLSearchParams({ year, system: 'JCR', category });
  const fetchEvidence = (path: string, authenticated = true) =>
    app.request(path, authenticated ? { headers: { cookie } } : {});
  db.prepare('INSERT INTO code_assets(id, name, location, host, access_note, notes, profile, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('fixture-asset', '合成数据登记', 'FIXTURE_PATH', 'FIXTURE_HOST', 'FIXTURE_ACCESS', 'FIXTURE_NOTES',
      JSON.stringify({ version: 'fixture-version', format: 'CSV', source: 'FIXTURE_SOURCE' }), now, now);
  db.prepare('INSERT INTO journals(id, name, created_at) VALUES(?,?,?)').run(journalId, '合成期刊', now);
  const insertRank = db.prepare(
    `INSERT INTO journal_rankings(id, journal_id, year, system, category, rank, source, fetched_at, created_at)
     VALUES (?,?,?,'JCR',?,?,'manual',?,?)`,
  );
  for (let i = 0; i < 52; i++) insertRank.run('current-' + i, journalId, 2026, '维度' + i, 'Q1', now, now);
  insertRank.run('old-period', journalId, 2021, '合成:特殊维度', 'Q3', now, now);
  insertRank.run('blank-dimension', journalId, 2021, '', 'Q4', now, now);

  async function exact(path: string): Promise<RecordRetrievalHit> {
    const response = await fetchEvidence(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return await response.json() as RecordRetrievalHit;
  }
  const asset = await exact(assetPath);
  assert.equal(asset.recordId, 'fixture-asset');
  assert.equal(asset.sourceVersion, now);
  assert.ok(asset.fields.some((field) => field.value === 'fixture-version'));
  assert.doesNotMatch(JSON.stringify(asset), /FIXTURE_PATH|FIXTURE_HOST|FIXTURE_ACCESS|FIXTURE_NOTES|FIXTURE_SOURCE/u);
  assert.equal((await fetchEvidence('/api/v1/code-assets/missing/evidence')).status, 404);

  const oldPeriod = period('2021', '合成:特殊维度');
  const old = await exact(oldPeriod);
  assert.equal(old.recordId, 'fixture-journal:2021:JCR:合成:特殊维度');
  assert.equal(old.sourceVersion, '2021 JCR 合成:特殊维度');
  assert.ok(old.fields.some((field) => field.label === '分区' && field.value === 'Q3'));
  db.prepare("UPDATE journal_rankings SET rank = 'Q2' WHERE id = 'old-period'").run();
  const revised = await exact(oldPeriod);
  assert.equal(revised.sourceVersion, old.sourceVersion);
  assert.ok(revised.fields.some((field) => field.label === '分区' && field.value === 'Q2'));
  assert.equal((await exact(period('2021', ''))).recordId, 'fixture-journal:2021:JCR:');
  assert.equal((await fetchEvidence(period('2021', '合成'))).status, 404);
  assert.equal((await fetchEvidence(period('2021x', '合成:特殊维度'))).status, 400);
  assert.equal((await fetchEvidence(rankingPath + 'year=2021&system=JCR')).status, 400);

  for (const path of [assetPath, oldPeriod]) assert.equal((await fetchEvidence(path, false)).status, 401);
  assert.equal(deleteSession(db, session.token), true);
  for (const path of [assetPath, oldPeriod]) {
    const denied = await fetchEvidence(path);
    assert.equal(denied.status, 401);
    assert.doesNotMatch(await denied.text(), /合成数据登记|合成期刊|特殊维度|FIXTURE_PATH/u);
  }
  console.log('✓ Authorized exact dataset and ranking evidence, old year and dimensions, current revision, and revoked session');
} finally {
  db.close();
}
