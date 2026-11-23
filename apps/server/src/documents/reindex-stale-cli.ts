/**
 * Offline maintenance: preview by default; pass --apply only after stopping the service
 * and backing up the database. Changed chunks legitimately receive new evidence IDs.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { INDEX_VERSION } from '@knowpilot/shared';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { isModelReady } from './embed.ts';
import { ingestDocument } from './ingest.ts';

const cfg = loadConfig();
const apply = process.argv.includes('--apply');
const read = new DatabaseSync(cfg.dbPath, { readOnly: true });
const stale = read.prepare(
  'SELECT id, source_path FROM documents WHERE status = ? AND index_version < ? ORDER BY created_at, id',
).all('ready', INDEX_VERSION) as { id: string; source_path: string | null }[];
const missing = stale.filter((row) => !row.source_path || !existsSync(
  isAbsolute(row.source_path) ? row.source_path : resolve(cfg.repoRoot, row.source_path),
));
read.close();

console.log(`待重建文档：${stale.length}；缺原件：${missing.length}；目标索引版本：${INDEX_VERSION}`);
if (!apply) {
  console.log('预览完成。停服、备份后传入 --apply 执行逐份重建。');
} else if (missing.length > 0) {
  throw new Error('有文档缺原件，未开始重建。');
} else if (!isModelReady(cfg)) {
  throw new Error('本地向量模型缺失，未开始重建，以免把现有语义索引降为关键词索引。');
} else {
  const { db } = openDb(cfg.dbPath);
  let succeeded = 0;
  let failed = 0;
  let keptIds = 0;
  let newIds = 0;
  try {
    for (const row of stale) {
      const before = new Set((db.prepare('SELECT id FROM doc_chunks WHERE doc_id = ?').all(row.id) as { id: string }[])
        .map((item) => item.id));
      try {
        const report = await ingestDocument(db, cfg, row.id);
        const after = (db.prepare('SELECT id FROM doc_chunks WHERE doc_id = ?').all(row.id) as { id: string }[])
          .map((item) => item.id);
        keptIds += after.filter((id) => before.has(id)).length;
        newIds += after.filter((id) => !before.has(id)).length;
        succeeded += 1;
        console.log(`${succeeded + failed}/${stale.length} 完成：${report.chunkCount} 块，${report.embeddedChunkCount} 向量`);
      } catch (error) {
        failed += 1;
        console.error(`${succeeded + failed}/${stale.length} 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    db.close();
  }
  console.log(`重建结束：成功 ${succeeded}，失败 ${failed}；沿用旧块 id ${keptIds}，新块 id ${newIds}。`);
  if (failed > 0) process.exitCode = 1;
}
