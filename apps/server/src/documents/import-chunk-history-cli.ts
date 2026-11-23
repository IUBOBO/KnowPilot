/** Import pre-upgrade chunk snapshots for old citation links. Never adds them to search. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';

const sourceArg = process.argv.find((arg) => arg.endsWith('.db'));
if (sourceArg === undefined) throw new Error('请提供备份数据库路径。');
const sourcePath = resolve(sourceArg);
const cfg = loadConfig();
if (!existsSync(sourcePath) || sourcePath === resolve(cfg.dbPath)) {
  throw new Error('来源必须是另一份存在的数据库备份。');
}
const source = new DatabaseSync(sourcePath, { readOnly: true });
const rows = source.prepare(
  `SELECT c.id, c.doc_id, c.ordinal, c.text, c.page, c.section_path,
          d.index_version, d.title, d.material, d.file_name
     FROM doc_chunks c JOIN documents d ON d.id = c.doc_id`,
).all() as {
  id: string; doc_id: string; ordinal: number; text: string; page: number | null;
  section_path: string | null; index_version: number; title: string;
  material: string; file_name: string | null;
}[];
source.close();
console.log(`备份中有 ${rows.length} 个历史块。`);

if (!process.argv.includes('--apply')) {
  console.log('仅预览。停服并备份当前库后，传入 --apply 导入未保留的旧块。');
} else {
  const { db } = openDb(cfg.dbPath);
  const current = new Set((db.prepare('SELECT id FROM doc_chunks').all() as { id: string }[]).map((r) => r.id));
  const liveDocuments = new Set((db.prepare('SELECT id FROM documents').all() as { id: string }[]).map((r) => r.id));
  const insert = db.prepare(
    `INSERT OR IGNORE INTO archived_doc_chunks
       (id, doc_id, ordinal, text, page, section_path, index_version,
        doc_title, material, file_name, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      if (current.has(row.id) || !liveDocuments.has(row.doc_id)) continue;
      const result = insert.run(
        row.id, row.doc_id, row.ordinal, row.text, row.page, row.section_path,
        row.index_version, row.title, row.material, row.file_name, new Date().toISOString(),
      );
      added += Number(result.changes);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
  console.log(`导入历史片段 ${added} 个；当前全文索引和向量未改变。`);
}
