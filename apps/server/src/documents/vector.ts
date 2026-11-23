/**
 * 向量的落库、加载与相似度检索。
 *
 * 【为什么用内存里暴力算，而不是引 sqlite-vec 之类的向量索引】
 *   单实验室的规模是几百份文档、几千个块。1024 维的 float32 向量，
 *   一万个块也只有 40 MB，全部装进内存后一次全量点积只要几毫秒 ——
 *   比任何"索引"都快，而且没有任何额外依赖。
 *   向量索引解决的是"百万级、装不进内存"的问题，我们离那个量级还差两个数量级。
 *
 *   什么时候该换：块数稳定超过 5 万、或单次查询耗时超过 200 ms 时。
 *   届时换 sqlite-vec（已实测本机 node:sqlite 可以用 allowExtension 加载扩展），
 *   只需替换本文件的 rankChunks，检索与融合的上层逻辑都不用动。
 *
 * 【缓存一致性】
 *   缓存在进程内存里，而向量可能被另一个进程改动（比如补向量的命令行）。
 *   所以每次使用前先用一条极轻的指纹查询比对，不一致就整表重载 ——
 *   否则会出现"命令行补完了向量，服务端却一直搜不到"这种极难排查的状态。
 */
import type { AppConfig } from '../config.ts';
import { embeddingModelKey } from '../config.ts';
import type { Db } from '../db/index.ts';
import { blobToVec, embedTexts, vecToBlob } from './embed.ts';

interface VectorIndex {
  model: string;
  dim: number;
  /** 数据指纹。与当前库不一致即作废重载。 */
  fingerprint: string;
  ids: string[];
  /** ids.length × dim 个 float32，按行紧密排列 */
  matrix: Float32Array;
}

let cache: VectorIndex | null = null;

interface EmbeddingRow {
  chunk_id: string;
  dim: number;
  vec: Uint8Array;
}

/** 数据指纹：条数 + 最新写入时间。两者任一变化都会重载。 */
function fingerprintOf(db: Db, model: string): string {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n, COALESCE(MAX(created_at), \'\') AS t FROM chunk_embeddings WHERE model = ?',
    )
    .get(model) as unknown as { n: number; t: string };
  return `${row.n}:${row.t}`;
}

function loadIndex(db: Db, model: string): VectorIndex {
  const fingerprint = fingerprintOf(db, model);
  if (cache !== null && cache.model === model && cache.fingerprint === fingerprint) {
    return cache;
  }

  const rows = db
    .prepare('SELECT chunk_id, dim, vec FROM chunk_embeddings WHERE model = ?')
    .all(model) as unknown as EmbeddingRow[];

  const dim = rows[0]?.dim ?? 0;
  const ids: string[] = [];
  const matrix = new Float32Array(rows.length * dim);

  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    if (row === undefined) continue;
    if (row.dim !== dim) {
      // 同一模型标识下出现两种维度，只可能是写入侧出了 bug 或有人手工改过库。
      // 放任不管会让矩阵错位，相似度变成毫无意义的数字且不报错。
      throw new Error(
        `向量维度不一致：块 ${row.chunk_id} 是 ${row.dim} 维，同模型其它块是 ${dim} 维。` +
          `请重跑 npm run embed -w @knowpilot/server 重建。`,
      );
    }
    const vec = blobToVec(row.vec, row.dim);
    matrix.set(vec, r * dim);
    ids.push(row.chunk_id);
  }

  cache = { model, dim, fingerprint, ids, matrix };
  return cache;
}

/** 本进程写入向量后调用，避免刚写完还读旧缓存。 */
export function invalidateVectorCache(): void {
  cache = null;
}

export interface RankedChunk {
  chunkId: string;
  score: number;
}

/**
 * 语义检索：把查询词向量化，与库中所有向量做余弦相似度，取前 topN。
 *
 * 向量在写入时已做 L2 归一化，所以余弦相似度就是点积，不必再算模长。
 *
 * 【`scope` 必须参与"取前 topN"而不是事后过滤】这是 R1 修掉的一类静默召回失败：
 *   先在全库取前 N 条、再按材料过滤，如果另一个材料下恰好有 N 条更相近的干扰块，
 *   目标块就连候选都进不了，过滤后直接 0 命中 —— 而界面上只会显示"没找到"，
 *   没有任何报错。所以这里在**打分阶段就跳过范围外的块**，topN 是范围**内**的 topN。
 */
export async function rankChunks(
  db: Db,
  cfg: AppConfig,
  query: string,
  topN: number,
  scope?: ReadonlySet<string>,
): Promise<RankedChunk[]> {
  const trimmed = query.trim();
  if (trimmed === '' || topN <= 0) return [];

  // 先看有没有向量再加载模型：库是空的时候没必要为一次注定返回空的结果
  // 去加载 500 MB 权重（与改造前同一条判断）。
  const model = embeddingModelKey(cfg);
  if (loadIndex(db, model).ids.length === 0) return [];

  const [queryVec] = await embedTexts(cfg, [trimmed]);
  if (queryVec === undefined) throw new Error('查询词向量化失败。');

  return rankChunksWithVector(db, model, queryVec, topN, scope);
}

/**
 * 用**已算好的查询向量**做候选排序。
 *
 * 单独导出有两个理由：
 *   1. `rankChunks` 只负责"把查询词变成向量"，排序这一段不需要模型，便于零模型验证
 *      （`verify-retrieval` 用合成向量直接测范围过滤）；
 *   2. 调用方若已有查询向量（将来做多路查询时），不必重复算一次。
 *
 * 参数 `scope` 为 undefined 表示全库；空集合表示"范围内一条候选都没有"（返回空）。
 */
export function rankChunksWithVector(
  db: Db,
  model: string,
  queryVec: Float32Array | readonly number[],
  topN: number,
  scope?: ReadonlySet<string>,
): RankedChunk[] {
  if (topN <= 0) return [];

  const index = loadIndex(db, model);
  if (index.ids.length === 0) return [];

  const { dim, matrix, ids } = index;
  if (queryVec.length !== dim) {
    throw new Error(
      `查询向量维度 ${queryVec.length} 与库中 ${dim} 不符。` +
        `多半是换了模型或精度档位却没重建向量，请跑 npm run embed -w @knowpilot/server。`,
    );
  }

  // 先全部算出来再排序。一万条以内是几毫秒，比"维护一个只装 topN 的堆"更简单，
  // 而且不会因为比较函数的边界处理写错而悄悄漏掉正确答案。
  // 范围外的块在**打分前**就跳过：先算后滤会把 topN 的名额白白占掉。
  const candidates: RankedChunk[] = [];
  for (let r = 0; r < ids.length; r += 1) {
    const id = ids[r] ?? '';
    if (scope !== undefined && !scope.has(id)) continue;
    let dot = 0;
    const base = r * dim;
    for (let i = 0; i < dim; i += 1) dot += (matrix[base + i] ?? 0) * (queryVec[i] ?? 0);
    candidates.push({ chunkId: id, score: dot });
  }

  // V8 的 Array#sort 是稳定排序：同分时保持向量表的插入顺序，
  // 与改造前 `Array.from(ids.keys()).sort(...)` 的平局行为一致。
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, topN);
}

export interface EmbeddingEntry {
  chunkId: string;
  vec: Float32Array;
}

/**
 * 写入向量（覆盖同块旧值）。
 *
 * 这里【不开事务】：调用方通常已经在一个事务里（重跑索引时删旧插新要和向量
 * 保持一致，必须同一个事务）。由调用方决定事务边界，避免事务套事务。
 */
export function saveEmbeddings(
  db: Db,
  model: string,
  entries: readonly EmbeddingEntry[],
  dim: number,
  now: string,
): void {
  const stmt = db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model, dim, vec, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chunk_id) DO UPDATE SET
       model = excluded.model, dim = excluded.dim, vec = excluded.vec, created_at = excluded.created_at`,
  );
  for (const e of entries) {
    stmt.run(e.chunkId, model, dim, vecToBlob(e.vec), now);
  }
}

/**
 * 某个模型下已建向量的块数。用于"文档列表显示向量状态"和一致性自检。
 *
 * `material` 可选：带材料过滤的检索必须按**同一范围**数，否则"已建向量数"
 * 是全局的、而"总块数"是材料内的，覆盖率提示会算错（R1 顺带修掉）。
 */
export function countEmbeddings(db: Db, model: string, material?: string): number {
  const row = (
    material === undefined
      ? db.prepare('SELECT COUNT(*) AS n FROM chunk_embeddings WHERE model = ?').get(model)
      : db
          .prepare(
            `SELECT COUNT(*) AS n
               FROM chunk_embeddings e
               JOIN doc_chunks c ON c.id = e.chunk_id
               JOIN documents d ON d.id = c.doc_id
              WHERE e.model = ? AND d.material = ?`,
          )
          .get(model, material)
  ) as unknown as { n: number };
  return row.n;
}

/** 某个文档下已建向量的块数。 */
export function countEmbeddingsOfDoc(db: Db, model: string, docId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM chunk_embeddings e
         JOIN doc_chunks c ON c.id = e.chunk_id
        WHERE e.model = ? AND c.doc_id = ?`,
    )
    .get(model, docId) as unknown as { n: number };
  return row.n;
}
