import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROLE_PERMISSIONS, type RecordRetrievalHit, type ResearchNote, type Role } from '@knowpilot/shared';
import { rankingFields, rankingRecordId } from '../agent/journal-tool.ts';
import { createLabModels } from '../agent/models.ts';
import { insertAskRecord } from '../agent/records.ts';
import { createApp } from '../app.ts';
import { SESSION_COOKIE, createSession } from '../auth/session.ts';
import { insertUser } from '../auth/users.ts';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { recordContentFingerprint, submissionFields } from '../retrieval/records.ts';
import { getSubmission, insertManualRanking, insertSubmission, upsertJournal } from '../submissions/repo.ts';

const root = mkdtempSync(join(tmpdir(), 'knowpilot-notes-http-'));
const path = join(root, 'fixture.sqlite');
const config = {
  ...loadConfig(), repoRoot: root, dbPath: path, uploadDir: join(root, 'uploads'),
  dataRoot: join(root, 'data'), codeRoots: [], hfHome: join(root, 'hf'), embedModelDir: join(root, 'missing-model'),
  deepseekApiKey: undefined, modelBaseUrl: undefined, rerankEnabled: false, rewriteEnabled: false, cookieSecure: false,
};
const models = createLabModels();
models.completeSimple = () => { throw new Error('Research note fixture must not request a model'); };
models.streamSimple = () => { throw new Error('Research note fixture must not request a model'); };
let { db, migration } = openDb(path);
let app = createApp({ db, config, schemaVersion: migration.toVersion, startedAt: Date.now(), models });
const now = new Date();
async function account(username: string, role: Role) {
  const id = await insertUser(db, username, { role, password: 'fixture-credential-only', displayName: username }, now);
  const session = createSession(db, { userId: id, now, idleDays: 1, maxDays: 1, ip: null, userAgent: null });
  return { id, cookie: SESSION_COOKIE + '=' + session.token };
}
const owner = await account('fixture-member', 'member');
const other = await account('fixture-other', 'member');
const admin = await account('fixture-admin', 'admin');
const url = '/api/v1/research-notes';
const body = 'notefixtureprivate 选段\n行距保持';
const valid = { title: '合成研究', body, tags: ['校准'] };
const seedAsk = (runId: string, userId: string | null) => insertAskRecord(db, {
  runId, userId, question: '合成问题', askedAt: now.toISOString(), consentConfirmed: true,
  outcome: 'ok', citationCount: 0, gapCount: 0, rounds: 0, durationMs: 0, warnings: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
});
seedAsk('fixture-own-1', owner.id);
seedAsk('fixture-own-2', owner.id);
seedAsk('fixture-other-run', other.id);
seedAsk('fixture-old-unowned', null);
const post = (path: string, input?: unknown, actor?: { cookie: string }, method = 'POST') => app.request(path, {
  method,
  headers: { ...(actor === undefined ? {} : { cookie: actor.cookie }), ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(input === undefined ? {} : { body: JSON.stringify(input) }),
});
const get = (path: string, actor?: { cookie: string }) => post(path, undefined, actor, 'GET');

assert.equal((await get(url)).status, 401);
assert.equal((await post(url, valid)).status, 401);
assert.equal((await post(url, { ...valid, runs: [{ runId: 'fixture-other-run', mode: 'answer' }] }, owner)).status, 404);
assert.equal((await post(url, { ...valid, runs: [{ runId: 'fixture-old-unowned', mode: 'answer' }] }, owner)).status, 404);
assert.equal((await post(url, { ...valid, ownerId: other.id }, admin)).status, 400);
assert.equal(db.prepare('SELECT count(*) AS n FROM research_notes').get()?.n, 0);
const res = await post(url, { ...valid, runs: [{ runId: 'fixture-own-1', mode: 'selection' }] }, owner);
assert.equal(res.status, 201);
assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
const note = await res.json() as ResearchNote;
assert.equal(note.body, body);
assert.equal(note.revision, 1);
assert.deepEqual(note.runs.map((r) => [r.runId, r.mode]), [['fixture-own-1', 'selection']]);
const item = url + '/' + note.id;
for (const actor of [other, admin]) {
  const listing = await get(url + '?q=notefixtureprivate', actor);
  assert.deepEqual((await listing.json() as { items: unknown[] }).items, []);
  assert.equal((await get(item, actor)).status, 404);
  assert.equal((await post(item, { ...valid, revision: 1 }, actor, 'PATCH')).status, 404);
  assert.equal((await post(item + '?revision=1', undefined, actor, 'DELETE')).status, 404);
}
const invalidAppend = await post(item, { ...valid, title: '不应部分保存', revision: 1,
  appendRuns: [{ runId: 'fixture-own-2', mode: 'reference' }, { runId: 'fixture-other-run', mode: 'reference' }] }, owner, 'PATCH');
assert.equal(invalidAppend.status, 404);
assert.deepEqual(await (await get(item, owner)).json(), note);

const update = await post(item, { ...valid, title: '编辑后的研究', tags: ['归档'], body: body + '\n第二轮',
  revision: 1, appendRuns: [{ runId: 'fixture-own-1', mode: 'answer' }, { runId: 'fixture-own-2', mode: 'answer' }] }, owner, 'PATCH');
assert.equal(update.status, 200);
const updated = await update.json() as ResearchNote;
assert.equal(updated.revision, 2);
assert.deepEqual(updated.runs.map((r) => r.runId), ['fixture-own-1','fixture-own-2']);
assert.deepEqual(updated.tags, ['归档']);
assert.equal((await post(item, { ...valid, revision: 1 }, owner, 'PATCH')).status, 409);
assert.equal((await post(item + '?revision=1', undefined, owner, 'DELETE')).status, 409);
const found = await get(url + '?q=' + encodeURIComponent('归档'), owner);
assert.equal((await found.json() as { items: unknown[] }).items.length, 1);
for (const path of ['/api/v1/search?contractVersion=1&q=notefixtureprivate','/api/v1/quick-search?q=notefixtureprivate']) {
  const result = await get(path, owner);
  assert.equal(result.status, 200);
  const payload = await result.json() as { hits?: unknown[]; items?: unknown[] };
  assert.deepEqual(payload.hits ?? payload.items, []);
}
assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get()?.n, 0);
assert.equal(db.prepare('SELECT count(*) AS n FROM doc_chunks').get()?.n, 0);

db.close();
({ db, migration } = openDb(path));
app = createApp({ db, config, schemaVersion: migration.toVersion, startedAt: Date.now(), models });
assert.deepEqual(await (await get(item, owner)).json(), updated);

const sourceTime = now.toISOString();
const documentTitle = '合成受保护文档';
const sourceText = '合成文档私有测试内容';
const recordTitle = '合成受保护专利';
const fileContent = 'synthetic file contents';
const uploadedFile = join(config.uploadDir, 'fixture.txt');
mkdirSync(config.uploadDir, { recursive: true });
writeFileSync(uploadedFile, fileContent);
db.prepare('INSERT INTO documents(id, material, title, status, content_hash, created_at, index_version, file_name, source_path) VALUES(?,?,?,?,?,?,?,?,?)')
  .run('source-doc', 'sop', documentTitle, 'ready', 'fixture-hash', sourceTime, 2, 'fixture.txt', uploadedFile);
db.prepare('INSERT INTO doc_chunks(id, doc_id, ordinal, text, text_seg, token_count) VALUES(?,?,?,?,?,?)')
  .run('source-chunk', 'source-doc', 0, sourceText, sourceText, 1);
db.prepare('INSERT INTO patents(id,name,owner_user_id,created_at,updated_at) VALUES(?,?,?,?,?)')
  .run('source-record', recordTitle, owner.id, sourceTime, sourceTime);
db.prepare('INSERT INTO people(id,name,created_at,updated_at) VALUES(?,?,?,?)').run('source-person', '合成作者', sourceTime, sourceTime);
db.prepare('UPDATE patents SET applicant_person_id=? WHERE id=?').run('source-person', 'source-record');
const patentPath = '/api/v1/search?contractVersion=1&recordType=M-PATENT&recordId=source-record';
const patent = (await (await get(patentPath, owner)).json() as { hits: RecordRetrievalHit[] }).hits[0];
assert(patent !== undefined);
const journalTitle = '合成来源期刊';
const { id: journalId } = upsertJournal(db, { name: journalTitle }, sourceTime);
const rankInput = { journalId, year: 2000, system: 'JCR', category: 'fixture:dimension',
  rank: 'Q1', top: false, note: null, sourceUrl: null };
const ranking = insertManualRanking(db, rankInput, sourceTime);
for (let year = 2001; year <= 2201; year++) insertManualRanking(db, { ...rankInput, year }, sourceTime);
const submissionTitle = '合成投稿来源';
const latestRank = { ...rankInput, year: 2201 };
const submissionId = insertSubmission(db, { journalId, title: submissionTitle, status: 'preparing',
  submittedAt: null, userId: owner.id, notes: null }, sourceTime);
const submission = getSubmission(db, submissionId);
assert(submission !== null);
db.prepare(`
  INSERT INTO ask_run_traces (
    run_id,user_id,asked_at,outcome,stop_reason,delivery_status,last_stage,model,prompt_hash,route,
    duration_ms,turn,evidence_count,context_chars,budget_json,tool_trace_json,retrieval_hits_json,
    record_evidence_json,citation_map_json,claim_checks_json,plan_json,rewrite_rounds,rewrite_events_json,
    warnings_json,errors_json,recorded_at
  ) VALUES (?,?,?,'ok','completed','verified','assembly','fixture','fixture','simple',
    1,1,2,20,'{}','[]','[]','[]',?,'[]','{}',0,'[]','[]','[]',?)
`).run('fixture-own-2', owner.id, sourceTime, JSON.stringify([
  { id: 'E1', documentId: 'source-doc', chunkId: 'source-chunk', sourceVersion: '2' },
  { id: 'E2', recordType: 'M-PATENT', recordId: 'source-record', sourceVersion: sourceTime,
    recordFingerprint: recordContentFingerprint(patent.recordTitle, patent.fields) },
  { id: 'E3', chunkId: 'source-chunk' },
  { id: 'E4', recordType: 'M-JOURNAL', recordId: rankingRecordId(journalId, ranking), sourceVersion: '2000 JCR fixture:dimension',
    recordFingerprint: recordContentFingerprint(journalTitle, rankingFields(ranking, journalTitle)) },
  { id: 'E5', recordType: 'M-SUBMIT', recordId: submissionId, sourceVersion: sourceTime,
    recordFingerprint: recordContentFingerprint(submissionTitle, submissionFields(submission)) },
]), sourceTime);
const sourceResponse = await post(url, { ...valid, runs: [{ runId: 'fixture-own-2', mode: 'answer' }] }, owner);
assert.equal(sourceResponse.status, 201);
const sourceNote = await sourceResponse.json() as ResearchNote;
const sourceNoteUrl = url + '/' + sourceNote.id;
const readerUrl = sourceNoteUrl + '/runs/fixture-own-2/sources/E1';
assert.deepEqual(sourceNote.runs[0]?.sources.map(({ status }) => status), ['available', 'available', 'unavailable', 'available', 'available']);
assert(!JSON.stringify(sourceNote).includes(sourceText));
assert.equal((await get(readerUrl)).status, 401);
assert.equal((await get(readerUrl, other)).status, 404);
assert.equal((await get(readerUrl, admin)).status, 404);
assert.equal((await get(readerUrl.replace('/E1', '/E0'), owner)).status, 404);
const readable = await get(readerUrl, owner);
assert.equal(readable.status, 200);
assert.equal(readable.headers.get('Cache-Control'), 'private, no-store');
assert.equal((await readable.json() as { chunk: { text:string } }).chunk.text, sourceText);
assert.equal(await (await get(readerUrl + '/file', owner)).text(), fileContent);
assert.equal((await get(readerUrl + '/file', other)).status, 404);
const journalReader = readerUrl.replace('/E1', '/E4/record');
const submissionReader = readerUrl.replace('/E1', '/E5/record');
assert.equal((await get(journalReader, owner)).status, 200);
assert.equal((await get(submissionReader, owner)).status, 200);
assert.equal((await get(submissionReader, admin)).status, 404);

db.prepare('UPDATE documents SET index_version = 3 WHERE id = ?').run('source-doc');
db.prepare('UPDATE people SET name = ? WHERE id = ?').run('已编辑合成作者', 'source-person');
// Preserve both underlying version labels while changing visible linked fields.
insertManualRanking(db, { ...rankInput, rank: 'Q3' }, sourceTime);
insertManualRanking(db, { ...latestRank, rank: 'Q4' }, sourceTime);
let metadata = await (await get(sourceNoteUrl, owner)).json() as ResearchNote;
assert.deepEqual(metadata.runs[0]?.sources.map(({ status }) => status), ['changed', 'changed', 'unavailable', 'changed', 'changed']);
assert.equal((await get(readerUrl + '/file', owner)).status, 404);
assert.equal((await get(journalReader, owner)).status, 404);
assert.equal((await get(submissionReader, owner)).status, 404);
assert.equal((await get(readerUrl, owner)).status, 404);
assert(!JSON.stringify(metadata).includes(documentTitle));
assert(!JSON.stringify(metadata).includes(recordTitle));

// An archived chunk preserves the exact cited version while its document remains available.
db.prepare('DELETE FROM doc_chunks WHERE id = ?').run('source-chunk');
db.prepare(`
  INSERT INTO archived_doc_chunks(id,doc_id,ordinal,text,page,section_path,doc_title,material,file_name,index_version,archived_at)
  VALUES(?, ?, 0, ?, NULL, '[]', ?, 'sop', NULL, 2, ?)
`).run('source-chunk', 'source-doc', sourceText, documentTitle, sourceTime);
const archived = await get(readerUrl, owner);
assert.equal(archived.status, 200);
assert.equal((await get(readerUrl + '/file', owner)).status, 404);
assert.equal((await archived.json() as { archivedIndexVersion: number }).archivedIndexVersion, 2);

db.prepare('DELETE FROM documents WHERE id = ?').run('source-doc');
db.prepare('UPDATE people SET name = ? WHERE id = ?').run('合成作者', 'source-person');
// Simulate a policy change only within this fixture. Production roles retain their shared read permissions.
const memberPermissions = ROLE_PERMISSIONS.member;
try {
  ROLE_PERMISSIONS.member = memberPermissions.filter((permission) => !permission.startsWith('patent.read.'));
  metadata = await (await get(sourceNoteUrl, owner)).json() as ResearchNote;
    assert.deepEqual(metadata.runs[0]?.sources.map(({ status }) => status), ['unavailable', 'unavailable', 'unavailable', 'changed', 'changed']);
  assert(!JSON.stringify(metadata).includes('source-record'));
  assert(!JSON.stringify(metadata).includes('source-chunk'));
  assert(!JSON.stringify(await (await get(readerUrl, owner)).json()).includes(sourceText));
  const recordRead = await get(patentPath, owner);
  assert.deepEqual((await recordRead.json() as { hits: unknown[] }).hits, []);
} finally {
  ROLE_PERMISSIONS.member = memberPermissions;
}
assert.equal((await post(sourceNoteUrl + '?revision=1', undefined, owner, 'DELETE')).status, 200);
assert.equal(db.prepare('SELECT count(*) AS n FROM research_note_sources').get()?.n, 0);

assert.equal((await post(item + '?revision=2', undefined, owner, 'DELETE')).status, 200);
assert.equal((await get(item, owner)).status, 404);
assert.equal(db.prepare('SELECT count(*) AS n FROM research_note_runs').get()?.n, 0);
assert.equal(db.prepare('SELECT count(*) AS n FROM ask_records').get()?.n, 4);
db.close();
console.log('PASS private owner-only CRUD/restart, multiple owned runs, edit conflict, atomic rollback, scoped search, no public index, and source version/withdrawal');
