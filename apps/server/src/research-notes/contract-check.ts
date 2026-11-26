import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate, openDb } from '../db/index.ts';
import { MIGRATIONS } from '../db/migrations.ts';
import { noteRevision, parseCreateNote, parseUpdateNote } from './input.ts';

const body = '  合成摘录\n原样保留  ';
const valid = { title: '  合成笔记  ', body, tags: [' 校准 ', '校准'] };
assert.deepEqual(parseCreateNote(valid), { title: '合成笔记', body, tags: ['校准'], runs: [] });
assert.deepEqual(parseUpdateNote({ ...valid, revision: 1, appendRuns: [{ runId: 'test-run', mode: 'selection' }] }).appendRuns,
  [{ runId: 'test-run', mode: 'selection' }]);
assert.throws(() => parseCreateNote({ ...valid, ownerId: 'another-user' }));
assert.throws(() => parseCreateNote({ ...valid, runs: [{ runId: 'a', mode: 'answer', locator: {} }] }));
assert.throws(() => parseCreateNote({ ...valid, runs: [{ runId: 'a', mode: 'answer' }, { runId: 'a', mode: 'reference' }] }));
assert.throws(() => parseUpdateNote({ ...valid, revision: -1 }));
assert.throws(() => parseCreateNote({ ...valid, body: 'x'.repeat(32_001) }));
assert.throws(() => parseCreateNote({ ...valid, tags: ['一，二'] }));
assert.equal(noteRevision('13'), 13);
assert.throws(() => noteRevision('13.0'));

const root = mkdtempSync(join(tmpdir(), 'knowpilot-note-v36-'));
const path = join(root, 'fixture.sqlite');
const before = new DatabaseSync(path, { enableForeignKeyConstraints: true });
before.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
const now = '2026-01-01T00:00:00.000Z';
const stamp = before.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?)');
for (const m of MIGRATIONS.filter((item) => item.version <= 36)) {
  before.exec(m.sql);
  stamp.run(m.version, m.name, createHash('sha256').update(m.sql.replace(/\s+/g, ' ').trim()).digest('hex'), now);
}
before.prepare('INSERT INTO users(id,username,display_name,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
  .run('owner','fixture-owner','合成用户','fixture-hash','member',now,now);
before.prepare('INSERT INTO documents(id,material,title,status,content_hash,created_at) VALUES(?,?,?,?,?,?)')
  .run('old-doc','paper','已有合成资料','ready','fixture',now);
const snapshots = before.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
const originalUser = before.prepare('SELECT * FROM users WHERE id=?').get('owner');
const originalDoc = before.prepare('SELECT * FROM documents WHERE id=?').get('old-doc');
// Force failure after v37 starts creating tables, then recover without touching prior rows.
before.exec('CREATE INDEX idx_research_notes_owner ON users(role)');
assert.throws(() => migrate(before), /v37.*已回滚/u);
assert.deepEqual(before.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), snapshots);
assert.deepEqual(before.prepare('SELECT * FROM documents WHERE id=?').get('old-doc'), originalDoc);
assert.deepEqual(before.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'research_note%'").all(), []);
before.exec('DROP INDEX idx_research_notes_owner');
before.close();

const after = openDb(path);
assert.equal(after.migration.fromVersion, 36);
assert.equal(after.migration.toVersion, 37);
assert.deepEqual(after.db.prepare('SELECT * FROM schema_migrations WHERE version <= 36 ORDER BY version').all(), snapshots);
assert.deepEqual(after.db.prepare('SELECT * FROM users WHERE id=?').get('owner'), originalUser);
assert.deepEqual(after.db.prepare('SELECT * FROM documents WHERE id=?').get('old-doc'), originalDoc);
const added = after.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'research_note%' ORDER BY name").all();
assert.deepEqual(added.map((r) => r.name), ['research_note_runs','research_note_sources','research_notes']);
assert.equal(after.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type IN ('trigger','table') AND sql LIKE '%doc_chunks_fts%' AND name LIKE 'research_note%'").get()?.n, 0);
assert.equal(after.db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
assert.deepEqual(after.db.prepare('PRAGMA foreign_key_check').all(), []);
after.db.close();
const reopen = openDb(path);
assert.equal(reopen.migration.fromVersion, 37);
assert.deepEqual(reopen.migration.applied, []);
reopen.db.close();
console.log('PASS v36→v37 upgrade, prior rows/checksums, failure rollback/retry, migration idempotence, integrity, private tables and input contract');
