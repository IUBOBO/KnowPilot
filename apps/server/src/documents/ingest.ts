/**
 * 入库流水线：解析 → 切块 → 建索引 → 改状态。
 *
 * 为什么单独成一个模块，而不是塞进 upload.ts：
 *   上传解决的是"原件到手"，入库解决的是"内容可检索"，两者的失败原因完全不同
 *   （前者是格式/大小/重复，后者是损坏/加密/扫描件/解析库缺陷）。
 *   它们的日志、错误文案、重试策略都不一样，混在一个函数里以后没法单独改。
 *
 * 状态机（uploaded → ready / failed）为什么必须显式：
 *   uploadDocument 只把行插成 uploaded。解析与索引完成后才置 ready。
 *   少了这一步，界面上就会出现"文件明明传上去了，却搜不到"且无法解释 ——
 *   这正是阶段 1 反复强调要避免的那一类静默失败。
 *
 * 【这个函数同时是"重新索引"的全部实现】—— 见 POST /api/v1/documents/:id/reindex。
 *   它按 documentId 操作，不动 documents 行的 id / created_at / 人工填过的标题，
 *   先删旧块再写新块，所以对同一份文档反复调用是幂等的。重建不需要另一条代码路径。
 *
 *   两处必须知道的行为：
 *   · 向量化在事务【外】（见下方注释），这十几秒里旧块仍然在线、检索照常，
 *     事务提交时才一次性换掉。所以不存在"重建期间被人搜到半份索引"的窗口。
 *   · 文本、页码和章节完全相同的块沿用旧 id；变动块会换 id，因此旧引用
 *     仍可能失效。批量重建前必须备份，不把它当作无影响的后台动作。
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { AppError, INDEX_VERSION, segmentForIndex, type IngestReport } from '@knowpilot/shared';
import { embeddingModelKey, type AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { chunkDocument } from './chunk.ts';
import { EMBED_DIM, embedTexts, isModelReady } from './embed.ts';
import { extractDocument } from './extract.ts';
import { findByContentHash, findById } from './repo.ts';
import type { PreparedDocumentUpload, StagedDocumentOriginal } from './upload.ts';
import { rankingText } from './ranking-text.ts';
import { invalidateVectorCache, saveEmbeddings } from './vector.ts';

export async function ingestDocument(
  db: Db,
  cfg: AppConfig,
  documentId: string,
  publication?: { validate: () => void; finish: () => void; staged?: { upload: PreparedDocumentUpload; original: StagedDocumentOriginal } },
): Promise<IngestReport> {
  const model = embeddingModelKey(cfg);
  const staged = publication?.staged;
  const prepared = staged?.upload;
  const row = staged === undefined ? findById(db, documentId, model) : {
    source_path: staged.original.path, title: staged.upload.title, file_name: staged.upload.fileName,
    material: staged.upload.material, index_version: INDEX_VERSION,
  };
  if (row === undefined) {
    throw new AppError('not_found', `文档不存在：${documentId}`);
  }
  if (row.source_path === null || row.source_path === '') {
    throw new AppError('internal', `文档 ${documentId} 没有原件路径，无法解析。`);
  }

  // source_path 存的是相对仓库根的路径（见 upload.ts），这里还原成绝对路径。
  const absPath = isAbsolute(row.source_path)
    ? row.source_path
    : resolve(cfg.repoRoot, row.source_path);

  if (!existsSync(absPath)) {
    const note = `原件不在磁盘上：${row.source_path}。请重新上传这份文件。`;
    if (prepared === undefined) markFailed(db, documentId, note);
    throw new AppError('invalid_argument', note);
  }

  let parsed: Awaited<ReturnType<typeof extractDocument>>;
  try {
    // OCR 的策略（开关与页数上限）从配置来，解析这一层自己不认识 AppConfig。
    parsed = await extractDocument(absPath, {
      ocr: { enabled: cfg.ocrEnabled, maxPages: cfg.ocrMaxPages },
    });
  } catch (err) {
    // 解析失败的原因（损坏、加密、格式不符）对用户是可行动的，必须落库，
    // 这样他过半小时回来看到的是"这份文件损坏"，而不是一个空白的 failed。
    if (prepared === undefined) markFailed(db, documentId, err instanceof AppError ? err.message : '解析失败。');
    throw err;
  }

  const headingCount = parsed.blocks.filter((b) => b.kind === 'heading').length;
  const chunks = chunkDocument(parsed.blocks);
  const warnings = [...parsed.warnings];

  if (chunks.length === 0) {
    // 不抛错：文档确实传上来了，只是没有可检索的内容（典型是扫描件）。
    // 抛错会让用户以为"上传失败"，而他要做的是改用 OCR 或换一份文件。
    const note = warnings[0] ?? '这份文件没有提取到任何可检索的文字。';
    if (prepared === undefined) markFailed(db, documentId, note);
    return {
      blockCount: parsed.blocks.length,
      headingCount,
      chunkCount: 0,
      embeddedChunkCount: 0,
      droppedBoilerplate: parsed.droppedBoilerplate,
      ocrPageCount: parsed.ocrPageCount,
      warnings,
    };
  }

  // 标题：PDF 元数据里的标题通常比文件名准，但用户显式填过标题就不覆盖
  // （判断依据是"当前标题是否就是文件名"，是则说明用户没填过）。
  const title =
    parsed.title !== null && row.title === row.file_name ? parsed.title : row.title;

  // 未变的原文沿用块 id，让这些 /chunk/:id 和旧答案引用继续可达。
  // 变了的块仍必须换 id，不能把旧 id 指向内容不同的证据。
  const oldRows = db.prepare(
    'SELECT id, ordinal, text, page, section_path FROM doc_chunks WHERE doc_id = ? ORDER BY ordinal',
  ).all(documentId) as unknown as {
    id: string; ordinal: number; text: string; page: number | null; section_path: string | null;
  }[];
  const oldVectorCount = (db.prepare(
    `SELECT COUNT(*) AS n FROM chunk_embeddings e
       JOIN doc_chunks c ON c.id = e.chunk_id
      WHERE c.doc_id = ? AND e.model = ?`,
  ).get(documentId, model) as { n: number }).n;
  const oldIds = new Map<string, string[]>();
  for (const old of oldRows) {
    const key = JSON.stringify([old.text, old.page, old.section_path ?? '[]']);
    const bucket = oldIds.get(key) ?? [];
    bucket.push(old.id);
    oldIds.set(key, bucket);
  }
  const chunkIds = chunks.map((chunk) => {
    const key = JSON.stringify([chunk.text, chunk.page, JSON.stringify(chunk.sectionPath)]);
    return oldIds.get(key)?.shift() ?? randomUUID();
  });

  // ── 向量化。刻意放在事务【之外】──────────────────────────
  // 这是整条流水线最慢的一步（一次模型推理十几毫秒，几百个块就是十几秒），
  // 放进事务里会让整个数据库的写锁被占住十几秒，期间别处的写入全部排队。
  // 而且它算错了不会损坏数据 —— 失败就把向量整个跳过，块照常入库。
  const vectors = await embedChunks(
    cfg,
    chunks.map((c) => rankingText(title, c.sectionPath, c.text)),
    warnings,
  );
  if (oldVectorCount > 0 && vectors === null) {
    // 重建失败不能拿"可搜关键词但没有向量"的新块替换原本完整的旧索引。
    // 初次上传或原本就无向量的文档仍允许关键词降级。
    throw new AppError('internal', `向量化未完成，旧索引已保留。${warnings.at(-1) ?? '请检查本地模型。'}`);
  }

  // 块与状态必须一起生效：只写块不改状态，文档会永远停在 uploaded；
  // 只改状态不写块，就会"状态 ready 但搜不到"—— 两种半成品都极难排查。
  db.exec(publication === undefined ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try {
    publication?.validate();
    if (staged !== undefined) {
      if (findByContentHash(db, staged.upload.contentHash, model) !== undefined) {
        throw new AppError('invalid_argument', '相同内容已在另一个确认中处理。请重试。', { httpStatus: 409 });
      }
      staged.upload.insert(db, staged.original.finalSourcePath);
    }
    const kept = new Set(chunkIds);
    const archive = db.prepare(
      `INSERT OR IGNORE INTO archived_doc_chunks
         (id, doc_id, ordinal, text, page, section_path, index_version,
          doc_title, material, file_name, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const archivedAt = new Date().toISOString();
    for (const old of oldRows) {
      if (kept.has(old.id)) continue;
      archive.run(
        old.id, documentId, old.ordinal, old.text, old.page, old.section_path,
        row.index_version, row.title, row.material, row.file_name, archivedAt,
      );
    }
    // 重跑索引时先清旧块，保证幂等（块数不会翻倍）。
    // 向量由外键 ON DELETE CASCADE 跟着一起删，不会留下孤儿行。
    db.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').run(documentId);

    const insert = db.prepare(
      `INSERT INTO doc_chunks
         (id, doc_id, ordinal, text, text_seg, page, token_count, section_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const chunkId = chunkIds[i];
      if (chunk === undefined || chunkId === undefined) continue;
      insert.run(
        chunkId,
        documentId,
        chunk.ordinal,
        chunk.text,
        // 索引列必须存逐字切分后的形态，且必须与查询侧共用同一个函数
        // （shared/segmentForIndex）。两侧各写一份，搜索结果会静默变空。
        segmentForIndex(chunk.text),
        chunk.page,
        chunk.tokenCount,
        JSON.stringify(chunk.sectionPath),
      );
    }

    if (vectors !== null) {
      saveEmbeddings(
        db,
        model,
        chunkIds.map((chunkId, i) => ({ chunkId, vec: vectors[i] ?? new Float32Array(EMBED_DIM) })),
        EMBED_DIM,
        new Date().toISOString(),
      );
    }

    db.prepare(
      `UPDATE documents
          SET status = ?, ingest_note = ?, title = ?, index_version = ?
        WHERE id = ?`,
    ).run(
      'ready',
      warnings.length > 0 ? warnings.join('\n') : null,
      title,
      INDEX_VERSION,
      documentId,
    );
    publication?.finish();
    staged?.original.promote();
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } finally {
      staged?.original.rollbackPromotion();
    }
    throw err;
  }

  invalidateVectorCache();

  return {
    blockCount: parsed.blocks.length,
    headingCount,
    chunkCount: chunks.length,
    embeddedChunkCount: vectors === null ? 0 : chunks.length,
    droppedBoilerplate: parsed.droppedBoilerplate,
    ocrPageCount: parsed.ocrPageCount,
    warnings,
  };
}

/**
 * 向量化，失败不影响入库。
 *
 * 三种情形分开对待，因为用户能做的事完全不同：
 *   · 模型没下载 —— 全局性的缺失，检索页会统一说明，此处静默跳过即可，
 *     否则每传一份文档都在列表上挂一句重复的提醒，很快就会被无视。
 *   · 模型在但推理失败 —— 只影响这一份文档，必须写进 ingestNote，
 *     否则表现为"这份文档语义搜不到"而毫无线索。
 *   · 成功 —— 返回向量。
 */
async function embedChunks(
  cfg: AppConfig,
  texts: readonly string[],
  warnings: string[],
): Promise<Float32Array[] | null> {
  if (!isModelReady(cfg)) return null;
  try {
    return await embedTexts(cfg, texts);
  } catch (err) {
    warnings.push(
      `语义向量未建成：${err instanceof Error ? err.message : String(err)}。` +
        `关键词检索不受影响；这份文档暂时搜不到语义结果。`,
    );
    return null;
  }
}

function markFailed(db: Db, documentId: string, note: string): void {
  db.prepare('UPDATE documents SET status = ?, ingest_note = ? WHERE id = ?').run(
    'failed',
    note,
    documentId,
  );
}
