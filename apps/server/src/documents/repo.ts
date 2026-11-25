/**
 * documents 表的读写。数据库列名是 snake_case，对外契约是 camelCase，
 * 转换只在这一个文件里发生 —— 散落各处的话，改一列名就要满仓库找。
 */
import type {
  ChunkContextResponse,
  ChunkView,
  DocumentStatus,
  DocumentSummary,
  Material,
} from '@knowpilot/shared';
import type { Db } from '../db/index.ts';

export interface DocRow {
  id: string;
  material: string;
  title: string;
  file_name: string | null;
  byte_size: number | null;
  content_hash: string;
  status: string;
  created_at: string;
  ingest_note: string | null;
  chunk_count: number;
  embedded_chunk_count: number;
  first_chunk_id: string | null;
  index_version: number;
  /** 上传者显示名；`uploaded_by` 为 NULL（阶段 1–3 历史数据）时是 null */
  uploaded_by_name: string | null;
  /** 由知识沉淀确认生成的文档所对应的知识条目 id；用户直接上传的材料为 null */
  knowledge_entry_id: string | null;
  /** 原件相对仓库根的路径。只在服务端内部使用，不进 DocumentSummary。 */
  source_path: string | null;
}

/**
 * 选择列。chunk_count 与 embedded_chunk_count 都用相关子查询现算，不落成
 * documents 的列：落列就要在"插入块 / 删除块 / 重跑索引 / 建向量"四处同步维护，
 * 漏一处就长期不一致；而单实验室的库只有几百份文档、几千个块，现算的开销可忽略。
 *
 * ⚠️ 注意：这里有一个占位符 `?`（向量模型标识），它在 SELECT 列表里，
 * 位置排在 WHERE、ORDER BY、LIMIT 的参数【之前】。调用方拼参数数组时
 * 必须把 model 放第一个，否则参数会整体错位 —— 这类错位不会报错，
 * 只会返回看似正常但完全不对的数据。
 */
const COLUMNS = `d.id, d.material, d.title, d.file_name, d.byte_size, d.content_hash,
  d.status, d.created_at, d.ingest_note, d.source_path, d.index_version,
  (SELECT COUNT(*) FROM doc_chunks c WHERE c.doc_id = d.id) AS chunk_count,
  (SELECT COUNT(*) FROM doc_chunks c2 JOIN chunk_embeddings e ON e.chunk_id = c2.id
    WHERE c2.doc_id = d.id AND e.model = ?) AS embedded_chunk_count,
  (SELECT c3.id FROM doc_chunks c3 WHERE c3.doc_id = d.id ORDER BY c3.ordinal LIMIT 1) AS first_chunk_id,
  (SELECT u.display_name FROM users u WHERE u.id = d.uploaded_by) AS uploaded_by_name,
  (SELECT ke.id FROM knowledge_entries ke WHERE ke.document_id = d.id LIMIT 1) AS knowledge_entry_id`;

export function toSummary(row: DocRow): DocumentSummary {
  return {
    id: row.id,
    material: row.material as Material,
    title: row.title,
    fileName: row.file_name,
    byteSize: row.byte_size,
    contentHash: row.content_hash,
    status: row.status as DocumentStatus,
    chunkCount: row.chunk_count,
    embeddedChunkCount: row.embedded_chunk_count,
    ingestNote: row.ingest_note,
    createdAt: row.created_at,
    firstChunkId: row.first_chunk_id,
    indexVersion: row.index_version,
    uploadedByName: row.uploaded_by_name,
    knowledgeEntryId: row.knowledge_entry_id,
  };
}

export function getDocumentSummary(db: Db, id: string, model: string): DocumentSummary | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM documents d WHERE d.id = ?`)
    .get(model, id) as unknown as DocRow | undefined;
  return row === undefined ? null : toSummary(row);
}

export function listDocuments(
  db: Db,
  limit: number,
  model: string,
  material?: Material,
): DocumentSummary[] {
  // 材料过滤放在 SQL 里而不是取回来再筛：筛在前端就意味着"先取最近 limit 条再过滤"，
  // 当某个类型的文档恰好都不在最近 limit 条里时，那个页面会显示成空的 ——
  // 明明有数据却看不到，且没有任何迹象提示是被截断了。
  const where = material !== undefined ? 'WHERE d.material = ?' : '';
  // 参数顺序 = SQL 里占位符出现的顺序：SELECT 里的 model → WHERE 的 material → LIMIT
  const params: (string | number)[] =
    material !== undefined ? [model, material, limit] : [model, limit];
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM documents d ${where} ORDER BY d.created_at DESC LIMIT ?`)
    .all(...params) as unknown as DocRow[];
  return rows.map(toSummary);
}

/**
 * 按标题 / 原文件名给命令面板找文档（O10）。
 *
 * 【为什么是独立的一条轻量查询，而不是 `listDocuments` 后再筛】
 *   面板每敲几个字就要问一次。`listDocuments` 的 SELECT 里带着两个
 *   `COUNT(*)` 相关子查询（块数、向量数），把全库算一遍只为取前 5 行标题
 *   是不必要的；这里只取面板要显示的几列。
 *
 * 【为什么标题与外文件名都匹配】用户记住的可能是解析后的标题，也可能是
 *   上传时那个 `xxx-终稿.pdf`。只匹配一处会漏掉另一半人的记忆。
 */
export interface DocumentTitleHit {
  id: string;
  material: Material;
  title: string;
  firstChunkId: string | null;
}

export function searchDocumentTitles(
  db: Db,
  keyword: string,
  limit: number,
): DocumentTitleHit[] {
  // 转义规则与 submissions/repo.ts 同源：`%` / `_` / `\` 不转义就会把
  // "100%_实验" 变成通配符。
  const like = `%${keyword.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const rows = db
    .prepare(
      `SELECT d.id, d.material, d.title,
        (SELECT c.id FROM doc_chunks c WHERE c.doc_id = d.id ORDER BY c.ordinal LIMIT 1) AS first_chunk_id
        FROM documents d
        WHERE d.title LIKE ? ESCAPE '\\' OR d.file_name LIKE ? ESCAPE '\\'
        ORDER BY d.created_at DESC LIMIT ?`,
    )
    .all(like, like, limit) as unknown as {
    id: string;
    material: string;
    title: string;
    first_chunk_id: string | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    material: row.material as Material,
    title: row.title,
    firstChunkId: row.first_chunk_id,
  }));
}

/**
 * 某个人上传的资料（首页「我的动态」用）。
 *
 * 【为什么不用 scopePredicate】文档的**读**是共享的：`listDocuments` 刻意不按归属
 *   过滤，因为大家都要找得到同一批资料。这里问的是另一个问题 ——
 *   "我做过什么"，所以是严格的 `uploaded_by = 我`，不含公共历史数据（那些是 NULL）。
 *   两个问题不能共用一个谓词，否则首页会把"大家的历史资料"算成"我的动态"。
 */
export function listDocumentsByUploader(
  db: Db,
  userId: string,
  limit: number,
  model: string,
): DocumentSummary[] {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM documents d
        WHERE d.uploaded_by = ? ORDER BY d.created_at DESC LIMIT ?`,
    )
    .all(model, userId, limit) as unknown as DocRow[];
  return rows.map(toSummary);
}

export function findByContentHash(db: Db, hash: string, model: string): DocRow | undefined {
  return db
    .prepare(`SELECT ${COLUMNS} FROM documents d WHERE d.content_hash = ? LIMIT 1`)
    .get(model, hash) as unknown as DocRow | undefined;
}

export function findById(db: Db, id: string, model: string): DocRow | undefined {
  return db
    .prepare(`SELECT ${COLUMNS} FROM documents d WHERE d.id = ?`)
    .get(model, id) as unknown as DocRow | undefined;
}

/** 恢复检查点时要用的块+文档元数据（不包含任何回答正文）。 */
export interface ChunkEvidenceRow {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  material: Material;
  page: number | null;
  sectionPath: string[];
  text: string;
  indexVersion: number;
}

/**
 * 按块 id 读回"重建证据所需的全部元数据"。
 * 检查点只存 chunkId+版本；恢复时用这个函数从库里重读原文与标题/页码/章节。
 */
export function loadChunkEvidenceRows(db: Db, ids: readonly string[]): Map<string, ChunkEvidenceRow> {
  if (ids.length === 0) return new Map();
  const unique = [...new Set(ids)];
  const placeholders = unique.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT c.id AS chunk_id, c.doc_id, c.text, c.page, c.section_path,
              d.title, d.material, d.index_version
         FROM doc_chunks c JOIN documents d ON d.id = c.doc_id
        WHERE c.id IN (${placeholders})`,
    )
    .all(...unique) as unknown as {
    chunk_id: string;
    doc_id: string;
    text: string;
    page: number | null;
    section_path: string | null;
    title: string;
    material: string;
    index_version: number;
  }[];
  const out = new Map<string, ChunkEvidenceRow>();
  for (const row of rows) {
    out.set(row.chunk_id, {
      chunkId: row.chunk_id,
      documentId: row.doc_id,
      documentTitle: row.title,
      material: row.material as Material,
      page: row.page,
      sectionPath: parseSectionPath(row.section_path),
      text: row.text,
      indexVersion: row.index_version,
    });
  }
  return out;
}

/**
 * 解析 `section_path` 列（JSON 数组字符串）。
 *
 * 放在这里而不是各调用处各写一份：它是**列的表示法**，和 snake_case → camelCase
 * 的转换属于同一类事，都该止步于本文件。
 *
 * 坏数据返回空数组而不是抛错：章节路径只是锦上添花，历史数据或人工改库
 * 可能留下坏 JSON，不值得为它让整个请求失败。
 */
export function parseSectionPath(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

interface ChunkContextRow {
  id: string;
  doc_id: string;
  ordinal: number;
  text: string;
  page: number | null;
  section_path: string | null;
  title: string;
  material: string;
  file_name: string | null;
  index_version: number;
}

interface SiblingRow {
  id: string;
  ordinal: number;
  text: string;
  page: number | null;
  section_path: string | null;
}

/**
 * 取一个块 + 它所在文档 + 同页的邻居块。问答的「查看原文」用它。
 *
 * 为什么必须带同页邻居：只给被引的那一块，用户看到的是一个孤立片段，
 * 没法确认"它的上下文是不是这个意思"——而核对上下文正是点进原文的全部目的。
 * 无页码或历史片段只返回该块。历史表仅保留被替换的块，索引版本也不能标识一次文档修订。
 */
export function getChunkContext(db: Db, chunkId: string): ChunkContextResponse | null {
  const current = db
    .prepare(
      `SELECT c.id, c.doc_id, c.ordinal, c.text, c.page, c.section_path,
              d.title, d.material, d.file_name, d.index_version
       FROM doc_chunks c JOIN documents d ON d.id = c.doc_id
       WHERE c.id = ?`,
    )
    .get(chunkId) as unknown as ChunkContextRow | undefined;
  const archive = current === undefined
    ? db.prepare(
        `SELECT id, doc_id, ordinal, text, page, section_path,
                doc_title AS title, material, file_name, index_version
           FROM archived_doc_chunks WHERE id = ?`,
      ).get(chunkId) as ChunkContextRow | undefined
    : undefined;
  const row = current ?? archive;
  if (row === undefined) return null;

  const toView = (r: SiblingRow | ChunkContextRow): ChunkView => ({
    id: r.id,
    ordinal: r.ordinal,
    text: r.text,
    page: r.page,
    sectionPath: parseSectionPath(r.section_path),
  });

  // 无页码时不查邻居：`page IS NULL` 会把整份 Word 文档的所有块都当成"同页"，
  // 那不是用户要的上下文，而是一个几百段的墙。
  const siblings: SiblingRow[] =
    row.page === null || archive !== undefined
      ? [row]
      : (db.prepare(
          `SELECT id, ordinal, text, page, section_path FROM doc_chunks
           WHERE doc_id = ? AND page = ? ORDER BY ordinal`,
        ).all(row.doc_id, row.page) as unknown as SiblingRow[]);

  return {
    sourceVersion: String(row.index_version),
    ...(archive !== undefined ? { archivedIndexVersion: archive.index_version } : {}),
    document: {
      id: row.doc_id,
      title: row.title,
      material: row.material as Material,
      fileName: row.file_name,
    },
    chunk: toView(row),
    siblings: siblings.map(toView),
  };
}

/** 下载原件需要的字段。`sourcePath` 只在服务端内部使用，不进 HTTP 响应体。 */
export interface DocumentFileRow {
  id: string;
  title: string;
  fileName: string | null;
  material: string;
  sourcePath: string | null;
}

export function getDocumentFile(db: Db, id: string): DocumentFileRow | null {
  const row = db
    .prepare('SELECT id, title, file_name, material, source_path FROM documents WHERE id = ?')
    .get(id) as unknown as
    | { id: string; title: string; file_name: string | null; material: string; source_path: string | null }
    | undefined;
  if (row === undefined) return null;
  return {
    id: row.id,
    title: row.title,
    fileName: row.file_name,
    material: row.material,
    sourcePath: row.source_path,
  };
}
