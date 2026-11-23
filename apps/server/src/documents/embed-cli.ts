/**
 * 给已有文档补建语义向量。
 *
 * 用法：
 *   npm run embed -w @knowpilot/server              # 补齐所有缺向量的块
 *   npm run embed -w @knowpilot/server -- <文档id>  # 只补某一份
 *   npm run embed -w @knowpilot/server -- --force   # 全部重算（换模型/换精度后用）
 *
 * 为什么必须有这个入口：
 *   向量是随模型和精度档位变化的。换模型、换 q8/fp16、或者修好一次推理报错之后，
 *   库里已有的向量就和当前模型对不上了。没有补齐入口的话，唯一的办法是
 *   把文档全部删掉重传 —— 对一个已经有几百份文档的库来说不可接受。
 *
 * --force 为什么存在：缺向量的块能自动找到，但"向量是旧模型算的"找不出来，
 *   那是语义问题不是结构问题。换模型时只能靠人明确说一句"全部重算"。
 */
import { embeddingModelKey, loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { EMBED_DIM, embedTexts, isModelReady } from './embed.ts';
import { findById } from './repo.ts';
import { countEmbeddings, invalidateVectorCache, saveEmbeddings } from './vector.ts';

interface PendingChunk {
  id: string;
  doc_id: string;
  text: string;
}

function main(): void {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const docId = args.find((a) => !a.startsWith('--'));

  const cfg = loadConfig();
  const { db } = openDb(cfg.dbPath);
  const model = embeddingModelKey(cfg);

  if (!isModelReady(cfg)) {
    console.error(
      `本地模型不存在：${cfg.embedModelDir}\\${cfg.embedModelId}\n` +
        `先运行：npm run fetch-model -w @knowpilot/server`,
    );
    process.exit(1);
  }

  if (docId !== undefined && findById(db, docId, model) === undefined) {
    console.error(`找不到文档：${docId}`);
    process.exit(1);
  }

  // 缺向量的块 = 左连接后右表为空的行。用 SQL 找而不是把两边都捞回内存比对，
  // 是为了让"已建好"的块根本不进入传输 —— 重跑一次不该把几千条向量再读一遍。
  const sql = force
    ? `SELECT c.id, c.doc_id, c.text FROM doc_chunks c
        ${docId !== undefined ? 'WHERE c.doc_id = ?' : ''}
        ORDER BY c.doc_id, c.ordinal`
    : `SELECT c.id, c.doc_id, c.text FROM doc_chunks c
        LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.model = ?
        WHERE e.chunk_id IS NULL
        ${docId !== undefined ? 'AND c.doc_id = ?' : ''}
        ORDER BY c.doc_id, c.ordinal`;

  const params: string[] = force
    ? docId !== undefined
      ? [docId]
      : []
    : docId !== undefined
      ? [model, docId]
      : [model];

  const pending = db.prepare(sql).all(...params) as unknown as PendingChunk[];

  if (pending.length === 0) {
    console.log(`没有需要处理的块（模型 ${model}）。`);
    db.close();
    return;
  }

  console.log(`模型：${model}`);
  console.log(`待处理：${pending.length} 个块${force ? '（--force 全量重算）' : ''}\n`);

  let done = 0;
  const started = Date.now();

  void (async () => {
    // 分批：一次全喂给模型会让进度长时间不动，且峰值内存高得多。
    const BATCH = 32;
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      const vectors = await embedTexts(cfg, batch.map((c) => c.text));

      db.exec('BEGIN');
      try {
        saveEmbeddings(
          db,
          model,
          batch.map((c, k) => ({ chunkId: c.id, vec: vectors[k] ?? new Float32Array(EMBED_DIM) })),
          EMBED_DIM,
          new Date().toISOString(),
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      done += batch.length;
      const pct = ((done / pending.length) * 100).toFixed(0);
      const secs = (Date.now() - started) / 1000;
      process.stdout.write(`\r  ${pct}%  ${done}/${pending.length} 块  已用 ${secs.toFixed(1)}s   `);
    }
    process.stdout.write('\n');

    invalidateVectorCache();
    console.log(`\n完成。当前模型下共有 ${countEmbeddings(db, model)} 个块有向量。`);
    console.log('服务端无需重启：它会自动发现向量已更新。');
    db.close();
  })().catch((err: unknown) => {
    console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

main();
