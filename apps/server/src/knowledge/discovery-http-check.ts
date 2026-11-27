import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import type { AuthUser, KnowledgeDiscoveryResponse, ResearchNote, Role } from '@knowpilot/shared';
import { createLabModels } from '../agent/models.ts';
import { createApp } from '../app.ts';
import { createSession, SESSION_COOKIE } from '../auth/session.ts';
import { loadConfig } from '../config.ts';
import { migrate, openDb } from '../db/index.ts';
import { MIGRATIONS } from '../db/migrations.ts';
import { createResearchNote } from '../research-notes/repo.ts';
import { insertAskRecord } from '../agent/records.ts';
import { discoverMatch, recordAskDiscovery, recordDiscovery } from './discovery.ts';

const root = mkdtempSync(join(tmpdir(), 'knowpilot-discovery-'));
const dbPath = join(root, 'fixture.sqlite');
const backupPath = join(root, 'before-v38.sqlite');
const now = new Date();
const stamp = now.toISOString();
function insertUser(db: DatabaseSync, id: string, role: Role) {
  db.prepare(`INSERT INTO users (id,username,display_name,password_hash,role,created_at,updated_at)
    VALUES (?,?,?,'fixture-hash',?,?,?)`).run(id, id, id, role, stamp, stamp);
  return { id, username: id, displayName: id, role, groupId: null } satisfies AuthUser;
}

const seed = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
seed.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
const statement = seed.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?)');
for (const migration of MIGRATIONS.filter(({ version }) => version <= 37)) {
  seed.exec(migration.sql);
  statement.run(migration.version, migration.name,
    createHash('sha256').update(migration.sql.replace(/\s+/gu, ' ').trim()).digest('hex'), stamp);
}
const owner = insertUser(seed, 'g4-owner', 'member');
const outsider = insertUser(seed, 'g4-admin', 'admin');
const rateOwner = insertUser(seed, 'g4-rate', 'member');
const current = createResearchNote(seed, owner.id, { title: '旧库测试', body: '旧版笔记来自合成测试环境。', tags: [], runs: [] });
await backup(seed, backupPath);
const beforeRows = seed.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
seed.exec('CREATE INDEX idx_knowledge_discoveries_owner_time ON users(role)');
assert.throws(() => migrate(seed), /v38.*已回滚/u);
assert.deepEqual(seed.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), beforeRows);
assert.deepEqual(seed.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'knowledge_discover%'").all(), []);
seed.exec('DROP INDEX idx_knowledge_discoveries_owner_time');
seed.close();

const restored = new DatabaseSync(backupPath, { enableForeignKeyConstraints: true, readOnly: true });
assert.deepEqual(restored.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), beforeRows);
assert.equal(restored.prepare('SELECT title FROM research_notes WHERE id=?').get(current.id)?.title, '旧库测试');
assert.equal(restored.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
restored.close();

const { db, migration } = openDb(dbPath);
assert.equal(migration.fromVersion, 37);
assert.equal(migration.toVersion, 38);
assert.deepEqual(migration.applied, ['v38:private-knowledge-discovery']);
assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=37 ORDER BY version').all(), beforeRows);
assert.equal(db.prepare('SELECT title FROM research_notes WHERE id=?').get(current.id)?.title, '旧库测试');
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
console.log('PASS v37 SQLite backup restore, v38 transactional rollback and upgrade preserve prior rows');

const config = { ...loadConfig(), repoRoot: root, dbPath, uploadDir: join(root, 'uploads'), dataRoot: join(root, 'datasets'),
  deepseekApiKey: undefined, modelBaseUrl: undefined, embedModelDir: join(root, 'offline'), ocrEnabled: false, codeRoots: [] };
const models = createLabModels();
let modelCalls = 0;
models.streamSimple = () => { modelCalls++; throw new Error('Unexpected model call in discovery'); };
models.completeSimple = async () => { modelCalls++; throw new Error('Unexpected model call in discovery'); };
const app = createApp({ db, config, models, schemaVersion: migration.toVersion, startedAt: Date.now() });
const endpoint = '/api/v1/knowledge/discovery';
function cookie(user: AuthUser) {
  const { token } = createSession(db, { userId: user.id, now, idleDays: 1, maxDays: 1, ip: null, userAgent: null });
  return SESSION_COOKIE + '=' + token;
}
const ownerCookie = cookie(owner);
const outsiderCookie = cookie(outsider);
function request(path: string, who: string | null, method = 'GET', body?: object) {
  const headers = new Headers(who === null ? undefined : { cookie: who });
  if (body === undefined) return app.request(path, { method, headers });
  headers.set('content-type', 'application/json');
  return app.request(path, { method, headers, body: JSON.stringify(body) });
}
async function list(who: string) {
  const response = await request(endpoint, who);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  return await response.json() as KnowledgeDiscoveryResponse;
}
async function note(who: string, body: string) {
  const response = await request('/api/v1/research-notes', who, 'POST', { title: '合成建议测试', body, tags: [] });
  assert.equal(response.status, 201);
  return await response.json() as ResearchNote;
}

assert.equal((await request(endpoint, null)).status, 401);
const recorded = await note(ownerCookie, '访问受控的合成笔记正文，检索标记 g4privateprobe。');
const item = (await list(ownerCookie)).items[0]!;
const renamed = await request('/api/v1/research-notes/' + recorded.id, ownerCookie, 'PATCH',
  { title: '只修改标题', body: recorded.body, tags: ['新标签'], revision: recorded.revision });
assert.equal(renamed.status, 200);
const renamedNote = await renamed.json() as ResearchNote;
const refreshedItem = (await list(ownerCookie)).items[0]!;
assert.equal(refreshedItem.id, item.id);
assert.deepEqual(refreshedItem.source, { kind:'note', id:recorded.id, revision:renamedNote.revision });
assert.equal(item.source.kind, 'note');
assert.equal(item.kind, 'new');
assert.equal((await list(outsiderCookie)).items.length, 0);
assert.equal((await request(endpoint + '/' + item.id + '/ignore', outsiderCookie, 'POST')).status, 404);
assert.equal((await request(endpoint + '/' + item.id + '/ignore', ownerCookie, 'POST')).status, 200);
assert.equal((await request(endpoint + '/' + item.id + '/ignore', ownerCookie, 'POST')).status, 200);
const repeatAt = new Date(now.getTime() + 30 * 60_000);
assert.equal(recordDiscovery(db, owner, { kind:'note', id:recorded.id, revision:renamedNote.revision }, repeatAt), false);
assert.equal((await list(ownerCookie)).items.length, 0);
assert.equal((await request(endpoint, ownerCookie, 'PATCH', { enabled:'false' })).status, 400);
assert.equal((await request(endpoint, ownerCookie, 'PATCH', { enabled:false })).status, 200);
const disabled = await note(ownerCookie, '关闭建议后保存的另外一份合成笔记。');
assert.equal(recordDiscovery(db, owner, { kind:'note',id:disabled.id,revision:disabled.revision }, repeatAt), false);
assert.equal((await list(ownerCookie)).enabled, false);
assert.equal((await request(endpoint, ownerCookie, 'PATCH', { enabled:true })).status, 200);
assert.equal(recordDiscovery(db, owner, { kind:'note',id:disabled.id,revision:disabled.revision }, repeatAt), true);
db.prepare('UPDATE research_notes SET revision=revision+1 WHERE id=?').run(disabled.id);
assert.equal((await list(ownerCookie)).items.length, 0);
assert.equal(db.prepare("SELECT count(*) AS n FROM doc_chunks_fts WHERE doc_chunks_fts MATCH 'g4privateprobe'").get()?.n, 0);
assert.equal(db.prepare("SELECT count(*) AS n FROM knowledge_entries").get()?.n, 0);
console.log('PASS actual note events, metadata refresh without duplicates, private owner read/mutate, opt-out, ignore, retries, revocation and zero automatic indexing');

const boundaries = Array.from({length:8},(_,i)=>createResearchNote(db,rateOwner.id,
  {title:'合成阈值',body:'第 '+i+' 个合成发现输入用于覆盖日限频。',tags:[],runs:[]}));
const start = now.getTime() - 2 * 60 * 60_000;
const record = (i: number, offset: number) => recordDiscovery(db,rateOwner,
  {kind:'note',id:boundaries[i]!.id,revision:1},new Date(start+offset));
assert.equal(record(0,0),true);
assert.equal(record(1,600_000-1),false);
for (let i=1;i<6;i++) assert.equal(record(i,i*600_000),true);
assert.equal(record(6,6*600_000),false);
assert.equal(record(7,24*60*60_000),true);
assert.equal((await list(cookie(rateOwner))).items.length, 6);
console.log('PASS inclusive cooldown boundary, rolling budget and bounded suggestion list');

function upload(who: string) {
  const form = new FormData();
  form.set('file', new File(['上传的合成资料会触发低频知识建议。'], 'discovery-fixture.txt', { type:'text/plain' }));
  form.set('material','paper');
  form.set('consentConfirmed','true');
  return app.request('/api/v1/documents',{method:'POST',headers:{cookie:who},body:form});
}
const uploadUser = insertUser(db, 'g4-upload', 'member');
const uploader = cookie(uploadUser);
assert.equal((await upload(uploader)).status, 201);
const uploadSuggestion = (await list(uploader)).items[0]!;
assert.equal(uploadSuggestion.source.kind, 'document');
const malformedPreview = '合成的无效问答摘要正文含控制字符用于回归测试。\u0000无效标记';
insertAskRecord(db, {
  runId:'g4-invalid-preview', question:'合成问题', askedAt:stamp, consentConfirmed:true, outcome:'ok', deliveryStatus:'verified',
  citationCount:1, gapCount:0, rounds:1, durationMs:1, warnings:[], userId:outsider.id, answerPreview:malformedPreview,
  usage:{inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,costUsd:0},
});
assert.equal(recordAskDiscovery(db,outsider,'g4-invalid-preview'),false);
assert.equal((await list(outsiderCookie)).items.length,0);
const insertMalformed = db.prepare(`INSERT INTO knowledge_discoveries
  (id,owner_id,source_json,source_version,fingerprint,status,created_at) VALUES(?,?,?,'fixture','fixture-'||?,'pending',?)`);
insertMalformed.run('invalid-descriptor',uploadUser.id,JSON.stringify({kind:'ask',id:'g4-invalid-preview',excerpt:malformedPreview}),
  'invalid-descriptor',new Date(now.getTime()+60_000).toISOString());
insertMalformed.run('invalid-json',uploadUser.id,'{','invalid-json',new Date(now.getTime()+60_000).toISOString());
assert.deepEqual((await list(uploader)).items.map(({id}) => id),[uploadSuggestion.id]);
assert.equal((await request(endpoint,uploader,'PATCH',{enabled:true})).status,200);
console.log('PASS malformed Ask previews are rejected and invalid stored descriptors do not block valid suggestions');
assert.equal((await upload(outsiderCookie)).status, 200);
assert.equal((await list(outsiderCookie)).items.length, 0);

const waiting = '私有待提交的合成草稿搜索标记 neverformalprobe。';
db.prepare(`INSERT INTO knowledge_entries
  (id,kind,status,content,source_type,observed_at,created_by,group_id) VALUES('pending','fact','proposed',?,'manual',?,?,'pending-group')`)
  .run(waiting,stamp,owner.id);
assert.equal(discoverMatch(db, outsider, waiting).kind, 'new');
assert.equal(modelCalls, 0);
console.log('PASS real completed upload, foreign duplicate silence, and no unpublished candidate or cloud request');
db.close();
