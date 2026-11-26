/**
 * 检索。三条路径：
 *   keyword  —— FTS5 逐字匹配（查询侧的分词必须与索引用同一个函数，见 shared/text.ts）
 *   semantic —— BGE-M3 向量近邻
 *   hybrid   —— 两路各查一遍，用 RRF 融合
 *
 * 【为什么默认混合】
 *   两条路的失手方式正好互补，而且都是"静默失手"：
 *   关键词搜「怎么申请学位」搜不到「学位授予实施细则」（字面对不上）；
 *   语义搜「DeepLabv3」（生僻专有名词）会被泛化成"图像分割相关"，
 *   把真正讲 DeepLabv3 的段落排到后面。任何单一路径都会有几类查询明显更差，
 *   而用户无法预知自己这次的查询属于哪一类。融合通常能互补，
 *   但并不保证每个问题都优于单路检索，需用固定语料逐项对照。
 */
import {
  buildMatchQuery,
  buildRelaxedMatchQuery,
  highlightMatches,
  searchTerms,
  SEARCH_MAX_LIMIT,
  SNIPPET_RADIUS,
  type Material,
  type MatchSource,
  type RankingInfo,
  type RetrievalDiagnostic,
  type SearchHit,
  type SearchMode,
  type SearchResponse,
} from '@knowpilot/shared';
import { embeddingModelKey, type AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { isModelReady } from './embed.ts';
import { scorePassagesQueued } from './rerank.ts';
import { parseSectionPath } from './repo.ts';
import { rankingText } from './ranking-text.ts';
import { countEmbeddings, countEmbeddingsOfDoc, rankChunks } from './vector.ts';
import { createRetrievalPolicy, isTitleOnly } from './retrieval-policy.ts';

/**
 * RRF 的平滑常数，取自原论文的 60。
 *
 * RRF 的公式是 每条结果累加 1/(K + 名次)。
 * K 的作用是压低"第 1 名"的统治力：K 越小，第 1 名越吃香；K 越大，名次差异越平缓。
 * 取 60 是通用默认值，含义是"能进前 60 名就算有价值"，两路排名靠前的结果
 * 都能参与竞争，不会因为某一路只有一条好结果就直接定死排序。
 */
const RRF_K = 60;

/** 每路召回的深度。融合要用到名次，只取 limit 条的话两路几乎没有重叠可言。 */
const RRF_DEPTH = 100;

/**
 * 语义相似度低于此值时，给一句"这次证据比较弱"的提示。
 *
 * ⚠️ 这个数字【只是提示，不是过滤条件】，而且它非常不可靠 —— 实测结论：
 *   在本库上跑 7 条相关查询与 7 条不相关查询（每条取前 10 名）：
 *     相关   最高分 0.5231~0.7268
 *     不相关 最高分 0.3996~0.5361
 *   两组**重叠**：相关查询里最低的 0.5231 低于不相关里最高的 0.5361。
 *   也就是说任何阈值都必然出错，只能选择错在哪一边。
 *
 *   也试过用"第一名与第二名的分差"来判，结论是更差：库里存在大量
 *   内容重叠的相邻块，正确答案常常与邻居几乎同分（「DeepLabv3 用了什么卷积」
 *   分差只有 0.0002），而部分不相关查询反而分差更大（0.0290）。不可用。
 *
 *   因为提示只是提示，两种错误里更该避免的是"误报"：把用户从就在第一条的
 *   正确答案上劝走，比不提更糟。所以阈值取在实测不相关上界附近并略高一点，
 *   宁可漏报（沉默无害，分数本来就在界面上摆着）。
 *   按上面这组数据，7 条相关查询里有 2 条会触发提示、7 条不相关里 0 条触发 ——
 *   换句话说**误报不为零，措辞绝不能写成"库里没有"**。
 *
 *   换语料后必须重新实测，不要直接沿用这个数字。
 */
const SEMANTIC_LOW_SCORE = 0.55;

interface ChunkRow {
  chunk_id: string;
  doc_id: string;
  doc_title: string;
  material: string;
  page: number | null;
  section_path: string | null;
  text: string;
}

export interface SearchInput {
  query: string;
  mode: SearchMode;
  limit: number;
  material?: Material;
  documentId?: string;
  documentIds?: readonly string[];
}

/**
 * 命中块的相邻上下文（O1）。
 *
 * 【为什么它不是 SearchHit】
 *   它没有证据号、没有分数，也不该被检索接口当成"结果"返回给界面。
 *   这是给 `retrieve` 工具附加的**阅读上下文**：切块后单块常常缺主语，
 *   模型只看命中块容易把"适用于硕士生"读成"适用于所有人"。
 *   它必须与证据严格分开，否则会进入引用候选，用户点开引用却看到一段
 *   模型根本没引用的相邻内容。
 */
export interface NeighborContext {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  page: number | null;
  sectionPath: readonly string[];
  text: string;
  relation: 'previous' | 'next';
}

interface NeighborRow {
  id: string;
  doc_id: string;
  doc_title: string;
  ordinal: number;
  text: string;
  page: number | null;
  section_path: string | null;
}

/**
 * 取每条命中前后的相邻块，优先按章节筛选；无章节信息时才用同页兜底（O1）。
 *
 * 规则刻意不放松：只看向前/向后**紧邻**的那一块，且要求同页或章节路径完全一致。
 * 跳过中间块去更远处找"同章节"的块会制造一种假连续 —— 模型会以为两段之间
 * 没有别的内容，而实际上中间隔着一整节。没有同页/同章节的邻居就返回空，
 * 不用"同文档"兜底：同一份文档的不同章节讲的可能是两件事。
 *
 * 返回值按命中块分组；同一块被多个命中共享时只保留一次（由调用方按顺序渲染）。
 */
export function loadNeighborChunks(
  db: Db,
  hits: readonly Pick<SearchHit, 'chunkId' | 'documentId'>[],
): Map<string, NeighborContext[]> {
  const out = new Map<string, NeighborContext[]>();
  if (hits.length === 0) return out;

  const docIds = [...new Set(hits.map((h) => h.documentId))];
  const placeholders = docIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT c.id, c.doc_id, d.title AS doc_title, c.ordinal, c.text, c.page, c.section_path
         FROM doc_chunks c
         JOIN documents d ON d.id = c.doc_id
        WHERE c.doc_id IN (${placeholders})
        ORDER BY c.doc_id, c.ordinal`,
    )
    .all(...docIds) as unknown as NeighborRow[];

  const byDoc = new Map<string, NeighborRow[]>();
  for (const row of rows) {
    const list = byDoc.get(row.doc_id) ?? [];
    list.push(row);
    byDoc.set(row.doc_id, list);
  }
  const indexByChunk = new Map<string, number>();
  for (const list of byDoc.values()) {
    for (let i = 0; i < list.length; i += 1) {
      const row = list[i];
      if (row !== undefined) indexByChunk.set(row.id, i);
    }
  }

  const hitIds = new Set(hits.map((h) => h.chunkId));
  const seenContexts = new Set<string>();
  for (const hit of hits) {
    const list = byDoc.get(hit.documentId);
    const at = indexByChunk.get(hit.chunkId);
    if (list === undefined || at === undefined) continue;
    const current = list[at];
    if (current === undefined) continue;

    const picked: NeighborContext[] = [];
    for (const [offset, relation] of [
      [-1, 'previous'],
      [1, 'next'],
    ] as const) {
      const neighbor = list[at + offset];
      if (neighbor === undefined) continue;
      if (hitIds.has(neighbor.id) || seenContexts.has(neighbor.id)) continue;
      if (!compatibleContext(current, neighbor)) continue;
      seenContexts.add(neighbor.id);
      picked.push({
        chunkId: neighbor.id,
        documentId: neighbor.doc_id,
        documentTitle: neighbor.doc_title,
        page: neighbor.page,
        sectionPath: parseSectionPath(neighbor.section_path),
        text: neighbor.text,
        relation,
      });
    }
    out.set(hit.chunkId, picked);
  }
  return out;
}

/** Expand relevant adjacent passages as separately citable evidence, with original ids and pages. */
export function expandSectionEvidence(
  db: Db,
  hits: readonly SearchHit[],
  query: string,
  maxExtra: number = 4,
): SearchHit[] {
  if (hits.length === 0 || maxExtra <= 0 || !/[?？]|什么|怎么|如何|多少|要求|多久|权重|流程|方法|查重/u.test(query)) return [...hits];
  const docIds = [...new Set(hits.map((h) => h.documentId))];
  const rows = db.prepare(`SELECT c.id,c.doc_id,c.ordinal,c.text,c.page,c.section_path,
       d.title AS doc_title,d.material FROM doc_chunks c JOIN documents d ON d.id=c.doc_id
       WHERE c.doc_id IN (${docIds.map(() => '?').join(',')}) ORDER BY c.doc_id,c.ordinal`)
    .all(...docIds) as unknown as (NeighborRow & { material: string })[];
  const byId = new Map(rows.map((row,i) => [row.id,i]));
  const seen = new Set(hits.map((h) => h.chunkId));
  const terms = searchTerms(query).filter((term) => !['论文','主要','最终','选择','要求'].includes(term));
  const supplements = new Map<string, SearchHit[]>();
  let remaining = Math.min(4,Math.max(0,Math.trunc(maxExtra)));
  let chars = 0;
  for (const hit of hits) {
    if (remaining === 0) break;
    const at = byId.get(hit.chunkId); if (at === undefined) continue;
    const current = rows[at]; if (!current) continue;
    const picked: SearchHit[] = [];
    for (const offset of [1,2,-1,-2]) {
      if (remaining === 0 || picked.length >= 2) break;
      const neighbor = rows[at+offset];
      if (!neighbor || neighbor.doc_id !== current.doc_id || seen.has(neighbor.id)
          || Math.abs(neighbor.ordinal-current.ordinal)!==Math.abs(offset)) continue;
      // Every intervening passage must share the section. Never jump across a heading/page boundary.
      const step = Math.sign(offset);
      let continuous = true;
      for (let n=step; Math.abs(n)<=Math.abs(offset); n+=step) {
        const between=rows[at+n];
        if (!between || between.doc_id!==current.doc_id || !compatibleContext(current,between)) { continuous=false; break; }
      }
      if (!continuous || isTitleOnly({title:neighbor.doc_title,section_path:neighbor.section_path,text:neighbor.text})) continue;
      if (/硕士/u.test(query) && !/博士/u.test(query) && /博士/u.test(neighbor.text) && !/硕士/u.test(neighbor.text)) continue;
      if (/博士/u.test(query) && !/硕士/u.test(query) && /硕士/u.test(neighbor.text) && !/博士/u.test(neighbor.text)) continue;
      const matches=terms.filter((term) => neighbor.text.toLowerCase().includes(term.toLowerCase())).length;
      const table=/^\|.+\|\s*$/mu.test(neighbor.text);
      const quantitative=/多少|权重|比例|率|数量|字数|多久|至少/u.test(query);
      const numericConclusion=quantitative && /\d/u.test(neighbor.text) && /分别为|权重|不少于|不超过|[<≤≥>=]/u.test(neighbor.text);
      if (!(matches>=2 || (table && quantitative) || (numericConclusion && matches>=1))) continue;
      if (neighbor.text.length>1800 || chars+neighbor.text.length>2200) continue;
      picked.push(toHit({chunk_id:neighbor.id,doc_id:neighbor.doc_id,doc_title:neighbor.doc_title,
        material:neighbor.material,page:neighbor.page,section_path:neighbor.section_path,text:neighbor.text},hit.score,query));
      seen.add(neighbor.id); remaining-=1; chars+=neighbor.text.length;
    }
    supplements.set(hit.chunkId,picked);
  }
  return hits.flatMap((hit) => [hit,...(supplements.get(hit.chunkId) ?? [])]);
}

function samePage(a: NeighborRow, b: NeighborRow): boolean {
  return a.page !== null && b.page !== null && a.page === b.page;
}

function sameSection(a: NeighborRow, b: NeighborRow): boolean {
  const left = parseSectionPath(a.section_path);
  const right = parseSectionPath(b.section_path);
  if (left.length === 0 || right.length === 0) return false;
  return left.length === right.length && left.every((part, i) => part === right[i]);
}

function compatibleContext(a: NeighborRow, b: NeighborRow): boolean {
  const left = parseSectionPath(a.section_path);
  const right = parseSectionPath(b.section_path);
  if (left.length > 0 || right.length > 0) return sameSection(a, b);
  return samePage(a, b);
}

/**
 * 重排打分器的注入点。
 *
 * 生产代码走默认的 `scorePassagesQueued`；断言脚本注入一个假打分器，
 * 就能在**没有 300MB 模型**的环境里覆盖"重排成功/回退/截断"三条路径。
 * 不留这个口子，这些分支就只能靠真模型碰运气触发，等于没测。
 */
export interface SearchDeps {
  scorePassages?: typeof scorePassagesQueued;
  rankChunks?: typeof rankChunks;
}

/** 保持旧调用的响应形状。 */
export async function searchDocuments(
  db: Db,
  cfg: AppConfig,
  input: SearchInput,
  deps: SearchDeps = {},
): Promise<SearchResponse> {
  return (await searchDocumentCandidates(db, cfg, input, deps)).result;
}

interface SearchExecution {
  result: SearchResponse;
  diagnostics: readonly RetrievalDiagnostic[];
}

export async function searchDocumentCandidates(
  db: Db,
  cfg: AppConfig,
  input: SearchInput,
  deps: SearchDeps = {},
): Promise<SearchExecution> {
  const query = input.query.trim();
  const limit = Math.min(Math.max(1, Math.trunc(input.limit)), SEARCH_MAX_LIMIT);

  const diagnostics: RetrievalDiagnostic[] = [];
  if (query === '') {
    return { result: respond(query, input.mode, [], []), diagnostics };
  }

  const model = embeddingModelKey(cfg);
  const policy = createRetrievalPolicy(db, query, input.material, input.documentId, input.documentIds);
  const keywordCandidates = (): SearchHit[] => {
    const main = keywordHits(db, query, RRF_DEPTH, input.material, policy.scope);
    if (main.length === 0 && policy.preferredDocuments.length > 0 && policy.bodyQuery.replace(/[\s\p{P}\p{S}]/gu,'') === '') {
      return [...policy.scope].map((id) => policy.rows.get(id)).filter((row) => row !== undefined)
        .slice(0,RRF_DEPTH).map((row) => toHit({chunk_id:row.id,doc_id:row.doc_id,doc_title:row.title,
          material:row.material,page:row.page,section_path:row.section_path,text:row.text},1/(1+row.ordinal),query));
    }
    if (policy.preferredDocuments.length === 0 || !/方法|模型|结构|架构|增加|改进|method|architecture/iu.test(policy.bodyQuery)) return main;
    // A bounded lexical expansion inside an unambiguous paper: methods can be headed "Model".
    const extra = keywordHits(db,'方法 模型 架构 method model architecture',RRF_DEPTH,input.material,policy.scope,1);
    const seen = new Set(main.map((h) => h.chunkId));
    return [...main,...extra.filter((h) => !seen.has(h.chunkId))];
  };
  const orderKeyword = (): SearchHit[] => keywordCandidates()
    .map((hit) => ({ ...hit, score: hit.score * policy.weight(hit.chunkId) }))
    .sort((a,b) => b.score - a.score).slice(0,limit);

  // 模型文件不在，语义这条路根本走不通。退化成关键词检索，
  // 但必须把"退化了"这件事说出来 —— 否则用户以为自己在用语义检索。
  if (input.mode === 'keyword') {
    return { result: respond(query, 'keyword', orderKeyword(), []), diagnostics };
  }

  const fallback = (reason: 'vector_model_unavailable' | 'vector_query_failed', notice: string): SearchExecution => {
    return { result: respond(query, 'keyword', orderKeyword(), [notice]), diagnostics: [reason] };
  };
  if (!isModelReady(cfg)) {
    return fallback('vector_model_unavailable',
      '语义检索不可用：本地模型尚未下载，已自动改用关键词检索。' +
      '运行 npm run fetch-model -w @knowpilot/server 下载模型后即可启用。');
  }

  const scope = policy.scope;
  const scopedDocument = input.documentId;
  const selectedDocuments = input.documentIds?.filter((id) => scopedDocument === undefined || scopedDocument === id)
    ?? (scopedDocument === undefined ? undefined : [scopedDocument]);
  const selected = selectedDocuments === undefined ? undefined : JSON.stringify(selectedDocuments);
  const totalChunks = selected === undefined ? countAllChunks(db, input.material)
    : (db.prepare(`SELECT COUNT(*) AS n FROM doc_chunks c JOIN documents d ON d.id = c.doc_id
                   WHERE c.doc_id IN (SELECT value FROM json_each(?)) AND (? IS NULL OR d.material = ?)`)
      .get(selected, input.material ?? null, input.material ?? null) as { n: number }).n;
  const embedded = selectedDocuments === undefined ? countEmbeddings(db, model, input.material)
    : totalChunks === 0 ? 0 : selectedDocuments.reduce((sum, id) => sum + countEmbeddingsOfDoc(db, model, id), 0);
  if (embedded === 0 && totalChunks > 0) diagnostics.push('vector_missing');
  if (embedded > 0 && embedded < totalChunks) diagnostics.push('vector_partial');

  let rawRanked: Awaited<ReturnType<typeof rankChunks>> = [];
  if (embedded > 0 && scope.size > 0) {
    try {
      const rank = deps.rankChunks ?? rankChunks;
      rawRanked = (await rank(db, cfg, query, RRF_DEPTH, scope)).filter((hit) => scope.has(hit.chunkId));
    } catch {
      return fallback('vector_query_failed', '语义检索不可用：查询向量化或排序失败，已自动改用关键词检索。');
    }
  }
  const coverageLabel = selected === undefined ? input.material : 'document';
  const topScore = rawRanked[0]?.score;
  const semanticWeakness = weakSemanticNotice(topScore ?? 0);
  const lowRelevance = topScore !== undefined && topScore < SEMANTIC_LOW_SCORE;

  if (input.mode === 'semantic') {
    if (embedded === 0) {
      return { result: respond(query, 'semantic', [], [missingVectorsNotice(totalChunks, coverageLabel)]), diagnostics };
    }
    const ranked = rawRanked
      .map((hit) => ({ ...hit, score: hit.score >= 0 ? hit.score * policy.weight(hit.chunkId) : hit.score - (1-policy.weight(hit.chunkId)) }))
      .sort((a,b) => b.score - a.score).slice(0,limit);
    const hits = hydrate(
      db,
      ranked.map((r) => r.chunkId),
      input.material,
      new Map(ranked.map((r) => [r.chunkId, r.score])),
    );
    if (hits.length > 0 && lowRelevance) diagnostics.push('low_relevance');
    return { result: respond(query, 'semantic', hits, [
      ...coverageNotices(embedded, totalChunks, coverageLabel), semanticWeakness,
    ]), diagnostics };
  }

  // ── 混合：两路各取 RRF_DEPTH 条，按名次融合 ──────────────────
  const keywordList = keywordCandidates();
  const semanticIds = hydratedIds(db, rawRanked.map((r) => r.chunkId), input.material);

  const fused = fuse(keywordList.map((h) => h.chunkId), semanticIds);
  for (const [id,entry] of fused) entry.score *= policy.weight(id);
  const ordered = [...fused.entries()].sort((a, b) => b[1].score - a[1].score);

  let topIds = ordered.slice(0, limit).map(([id]) => id);
  let scores = new Map(topIds.map((id) => [id, fused.get(id)?.score ?? 0]));
  let ranking: RankingInfo | undefined;

  // 关键词一条没中、语义的最高分又偏低 —— 这是"库里很可能没有这个内容"的
  // 强信号。混合模式下这种查询最容易被误读成"搜到了"，所以专门提示。
  const notices = [
    ...coverageNotices(embedded, totalChunks, coverageLabel),
    ...(keywordList.length === 0 ? [semanticWeakness] : []),
  ];

  // ── Cross-Encoder 重排（R2，默认关闭）──────────────────────────
  // 只动"已经召回的这一批"的顺序：候选池来自融合排序的前 N 名。
  // 重排不能把没召回的内容变出来，所以候选深度是收益上限的一部分，
  // 评测时必须一起报告，不能只报重排后的指标。
  if (keywordList.length === 0 && semanticIds.length > 0 && lowRelevance) diagnostics.push('low_relevance');
  if (cfg.rerankEnabled) {
    const depth = Math.max(cfg.rerankCandidateDepth, limit);
    const candidateIds = ordered.slice(0, depth).map(([id]) => id);
    const startedAt = Date.now();

    const texts = loadChunkTexts(db, candidateIds);
    const usable = candidateIds.filter((id) => texts.has(id));
    if (usable.length === 0) {
      ranking = { mode: 'rrf', candidates: 0 };
    } else {
      try {
        const scorer = deps.scorePassages ?? scorePassagesQueued;
        const values = await scorer(
          cfg,
          query,
          usable.map((id) => texts.get(id) ?? ''),
        );
        const rerankScore = new Map(usable.map((id, i) => [id, values[i] ?? -Infinity]));
        const rrfOrder = new Map(candidateIds.map((id, i) => [id, i]));
        const reranked = [...usable].sort((a, b) => {
          const diff = (rerankScore.get(b) ?? -Infinity) - (rerankScore.get(a) ?? -Infinity);
          if (diff !== 0) return diff;
          // 同分时保留 RRF 名次：否则同一查询两次可能给出不同顺序，
          // 评测里的"重排不稳定性"会混进排序噪声。
          return (rrfOrder.get(a) ?? 0) - (rrfOrder.get(b) ?? 0);
        });

        topIds = reranked.slice(0, limit);
        scores = new Map(topIds.map((id) => [id, rerankScore.get(id) ?? 0]));
        ranking = {
          mode: 'rerank',
          candidates: usable.length,
          ms: Date.now() - startedAt,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ranking = {
          mode: 'rrf',
          candidates: usable.length,
          fallbackReason: reason,
        };
        // 开了重排却没重排，结果看起来与没开时一模一样 —— 必须说出来。
        diagnostics.push('rerank_fallback');
        notices.push(`重排不可用，已按融合排序返回：${reason.slice(0, 200)}`);
      }
    }
  }

  const hits = hydrate(db, topIds, input.material, scores).map((hit) => {
    const sources = fused.get(hit.chunkId)?.sources ?? [];
    return { ...hit, matchedBy: [...sources] as MatchSource[] };
  });
  return { result: respond(query, 'hybrid', hits, notices, ranking), diagnostics };
}

/** 组装响应：说明文字统一在这里拼接，空字符串会被丢掉。 */
function respond(
  query: string,
  mode: SearchMode,
  hits: SearchHit[],
  notices: readonly string[],
  ranking?: RankingInfo,
): SearchResponse {
  const text = notices.filter((n) => n !== '').join('\n');
  return {
    query,
    mode,
    returned: hits.length,
    hits,
    ...(ranking !== undefined ? { ranking } : {}),
    ...(text !== '' ? { notice: text } : {}),
  };
}

/**
 * 相似度偏低时的提示。
 *
 * 措辞刻意只说"没有哪一段特别贴合"，不说"库里没有这方面的内容"：
 * 阈值已知会误报（见 SEMANTIC_LOW_SCORE 的说明），而"库里没有"是一个
 * 用户无法自行证伪的结论 —— 他会就此停止查找，哪怕答案就在下面第一条。
 * 说"这批结果不太贴合"则是他能一眼看着结果自己判断的，说错了也无害。
 */
function weakSemanticNotice(topScore: number): string {
  if (topScore <= 0) return '';
  if (topScore >= SEMANTIC_LOW_SCORE) return '';
  return (
    `本次语义结果里没有哪一段特别贴合（最高相似度 ${topScore.toFixed(3)}）。` +
    `这不代表库里一定没有 —— 换个说法再试，或切到关键词模式，往往更快。`
  );
}

/**
 * RRF 融合。输入是两路各自的"按相关度排好序的块 id 列表"，
 * 输出是 块 id → { 融合分, 被哪几路召回 }。
 *
 * 只用了名次、没有用两路各自的分数：关键词的分是 bm25、语义的分是余弦，
 * 两者量纲不同，直接相加必须先做归一化，而归一化本身又要选一个"参考分数"
 * —— 那一步很容易引入偏差。名次是无量纲的，天然可比。
 */
function fuse(
  keywordIds: readonly string[],
  semanticIds: readonly string[],
): Map<string, { score: number; sources: Set<MatchSource> }> {
  const out = new Map<string, { score: number; sources: Set<MatchSource> }>();

  const add = (ids: readonly string[], source: MatchSource): void => {
    for (let rank = 0; rank < ids.length; rank += 1) {
      const id = ids[rank];
      if (id === undefined) continue;
      const entry = out.get(id) ?? { score: 0, sources: new Set<MatchSource>() };
      entry.score += 1 / (RRF_K + rank + 1);
      entry.sources.add(source);
      out.set(id, entry);
    }
  };

  add(keywordIds, 'keyword');
  add(semanticIds, 'semantic');
  return out;
}

/** 关键词检索，返回已排好序的命中。 */
function keywordHits(
  db: Db,
  query: string,
  limit: number,
  material?: Material,
  scope?: ReadonlySet<string>,
  minimumTerms: number = 2,
): (SearchHit & { chunkId: string })[] {
  // 完整短语优先；长问题若未占满结果，再用实词 OR 补召回。
  // 查询仍由 shared/text.ts 转义，不能把用户输入直接拼进 MATCH。
  const match = buildMatchQuery(query);
  if (match === '') return [];
  if (scope?.size === 0) return [];
  const scopeIds = scope === undefined ? [] : [...scope];

  // 展示文本一律从 doc_chunks.text（原文列）取，不取 FTS 表的 text_seg ——
  // 后者是逐字切分后的形态，展示出来会变成「投 稿 记 录」。
  // FTS 只负责"哪一条命中、排第几"。
  const sql = `
    SELECT c.id AS chunk_id, c.doc_id, c.text, c.page, c.section_path,
           d.title AS doc_title, d.material,
           -bm25(doc_chunks_fts) AS score
      FROM doc_chunks_fts
      JOIN doc_chunks c ON c.rowid = doc_chunks_fts.rowid
      JOIN documents d ON d.id = c.doc_id
     WHERE doc_chunks_fts MATCH ?
       ${material !== undefined ? 'AND d.material = ?' : ''}
       ${scope !== undefined ? `AND c.id IN (${scopeIds.map(() => '?').join(',')})` : ''}
     ORDER BY bm25(doc_chunks_fts)
     LIMIT ?`;

  const run = (expression: string, depth: number): (ChunkRow & { score: number })[] => {
    const params: (string | number)[] =
      [expression, ...(material !== undefined ? [material] : []), ...scopeIds, depth];
    return db.prepare(sql).all(...params) as unknown as (ChunkRow & { score: number })[];
  };
  const exact = run(match, limit);
  if (exact.length >= limit) return exact.map((row) => toHit(row, row.score, query));

  const terms = searchTerms(query);
  // 裸关键词/编号/人造标记要保持精确：把「专用标记丁戊己」放宽成
  // 「专用 OR 标记」会把已撤回资料的其它段误报为仍能搜到。
  // 自然语言问句或显式分词输入才启用补召回；混合模式仍有语义路兜底。
  if (terms.length < minimumTerms || !allowRelaxedQuery(query)) {
    return exact.map((row) => toHit(row, row.score, query));
  }
  const relaxedMatch = buildRelaxedMatchQuery(terms);
  const seen = new Set(exact.map((row) => row.chunk_id));
  const relaxed = run(relaxedMatch, Math.min(300, Math.max(limit * 3, 60)))
    .filter((row) => !seen.has(row.chunk_id))
    .map((row) => {
      const lower = row.text.toLowerCase();
      const title = row.doc_title.toLowerCase();
      const matched = terms.filter((term) => {
        const key = term.toLowerCase();
        return lower.includes(key) || title.includes(key);
      }).length;
      const titleMatched = terms.filter((term) => title.includes(term.toLowerCase())).length;
      return { row, matched, titleMatched };
    })
    // 多词问题至少要有两个实词。只命中「方法」之类宽泛词会制造假相关。
    .filter((item) => item.matched >= minimumTerms)
    .sort((a, b) => b.matched - a.matched || b.titleMatched - a.titleMatched || b.row.score - a.row.score);

  return [
    ...exact.map((row) => toHit(row, row.score, query)),
    ...relaxed.slice(0, limit - exact.length).map(({ row }) => toHit(row, row.score, query)),
  ];
}

function allowRelaxedQuery(query: string): boolean {
  return /[?？]|如何|怎么|什么|哪些|哪个|是否|为何|为什么|怎样|多少|几种|几个/u.test(query)
    || /\S\s+\S/u.test(query);
}

/**
 * 按块 id 取回完整信息，并保持传入的 id 顺序（= 相关度顺序）。
 *
 * 为什么不在取向量时就 JOIN 出全部字段：向量检索只需要 id 和分数，
 * 让它顺带查文本是无谓的开销。真正的原文只在最后确定要展示谁时才取。
 */
function hydrate(
  db: Db,
  ids: readonly string[],
  material: Material | undefined,
  scores: Map<string, number>,
): SearchHit[] {
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(', ');
  const sql = `
    SELECT c.id AS chunk_id, c.doc_id, c.text, c.page, c.section_path,
           d.title AS doc_title, d.material
      FROM doc_chunks c
      JOIN documents d ON d.id = c.doc_id
     WHERE c.id IN (${placeholders})
       ${material !== undefined ? 'AND d.material = ?' : ''}`;

  const params: (string | number)[] =
    material !== undefined ? [...ids, material] : [...ids];
  const rows = db.prepare(sql).all(...params) as unknown as ChunkRow[];

  const byId = new Map(rows.map((r) => [r.chunk_id, r]));
  const out: SearchHit[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    // 块可能在算完向量之后被删掉了（另一个进程重跑了索引）。
    // 跳过即可，不值得让整次查询失败。
    if (row === undefined) continue;
    out.push(toHit(row, scores.get(id) ?? 0, ''));
  }
  return out;
}

/**
 * 取候选块的原文，供 Cross-Encoder 打分。
 *
 * 不复用 hydrate 的返回值：那里只给摘要分段，重排需要完整原文 ——
 * 摘要按命中词截过，拿它打分等于让模型评价一句被裁剪过的句子。
 */
function loadChunkTexts(db: Db, ids: readonly string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT c.id, c.text, c.section_path, d.title
                FROM doc_chunks c JOIN documents d ON d.id = c.doc_id
               WHERE c.id IN (${placeholders})`)
    .all(...ids) as unknown as { id: string; text: string; section_path: string | null; title: string }[];
  return new Map(rows.map((r) => [r.id, rankingText(r.title, parseSectionPath(r.section_path), r.text)]));
}

/** 语义候选过一遍材料过滤与存在性检查，返回仍有效的 id（保持顺序）。 */
function hydratedIds(db: Db, ids: readonly string[], material: Material | undefined): string[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const sql = `
    SELECT c.id AS chunk_id
      FROM doc_chunks c
      JOIN documents d ON d.id = c.doc_id
     WHERE c.id IN (${placeholders})
       ${material !== undefined ? 'AND d.material = ?' : ''}`;
  const params: (string | number)[] = material !== undefined ? [...ids, material] : [...ids];
  const rows = db.prepare(sql).all(...params) as unknown as { chunk_id: string }[];
  const alive = new Set(rows.map((r) => r.chunk_id));
  return ids.filter((id) => alive.has(id));
}

function toHit(row: ChunkRow, score: number, query: string): SearchHit {
  const snippet = makeSnippet(row.text, query);
  return {
    chunkId: row.chunk_id,
    documentId: row.doc_id,
    documentTitle: row.doc_title,
    material: row.material as Material,
    page: row.page,
    sectionPath: parseSectionPath(row.section_path),
    segments: highlightMatches(snippet, snippetTerm(snippet, query)),
    score,
  };
}

function countAllChunks(db: Db, material?: Material): number {
  const sql =
    material !== undefined
      ? 'SELECT COUNT(*) AS n FROM doc_chunks c JOIN documents d ON d.id = c.doc_id WHERE d.material = ?'
      : 'SELECT COUNT(*) AS n FROM doc_chunks';
  const params: (string | number)[] = material !== undefined ? [material] : [];
  const row = db.prepare(sql).get(...params) as unknown as { n: number };
  return row.n;
}

function missingVectorsNotice(totalChunks: number, material?: Material | 'document'): string {
  // 带材料过滤时，"库里"与"这个材料下"是两件事：库里可能有很多内容，
  // 只是这个材料下没有 —— 说成"库里还没有"会让用户去传一份不需要传的文档。
  const where = material === undefined ? '库里' : material === 'document' ? '当前文档中' : '当前材料下';
  if (totalChunks === 0) return `${where}还没有可检索的内容${material === undefined ? '，先上传文档。' : '。'}`;
  return (
    `${where} ${totalChunks} 个检索块都还没有向量，语义检索无法工作。` +
    `运行 npm run embed -w @knowpilot/server 补齐后即可使用。`
  );
}

/**
 * 部分块缺向量时的说明。
 *
 * 为什么必须提示：语义只能覆盖"已建向量"的那部分块，用户会看到
 * "明明库里有这份文档，语义却搜不到"。不说明的话，这属于静默降质。
 */
function coverageNotices(embedded: number, totalChunks: number, material?: Material | 'document'): string[] {
  if (totalChunks === 0 || embedded >= totalChunks) return [];
  const scope = material === undefined ? '' : material === 'document' ? '当前文档中 ' : '当前材料下 ';
  return [
    `注意：${scope}${totalChunks} 个检索块中只有 ${embedded} 个建了向量，` +
      `语义检索只覆盖这一部分。运行 npm run embed -w @knowpilot/server 可补齐。`,
  ];
}

/**
 * 取命中词周围的一段文字作为摘要。
 *
 * 为什么不整体返回：一个块有几百字，直接铺满界面会让人找不到命中在哪。
 * 先把换行压平再截 —— 块内用 \n\n 分隔段落，保留原样会让摘要里挂着大段空白。
 *
 * 语义检索的命中往往字面上完全不含查询词（这正是它存在的意义），
 * 此时 indexOf 找不到、自然退化成"取块首一段"，行为正好合理。
 */
function makeSnippet(text: string, query: string, radius: number = SNIPPET_RADIUS): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (query === '') return flat.slice(0, radius * 2);

  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return flat.slice(0, radius * 2);

  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + query.length + radius);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * 摘要里实际用来定位的词。
 *
 * 多词查询（"semantic segmentation"）在原文里可能因为换行或连字符而找不到整串，
 * 这时退回用第一个词定位。不这么做的话，摘要会停在块首，命中的那句话根本不出现 ——
 * 用户看到的就是"搜出来了但摘要里没有这个词"。
 */
function snippetTerm(snippet: string, query: string): string {
  if (query === '') return '';
  if (snippet.toLowerCase().includes(query.toLowerCase())) return query;
  const first = query.split(/\s+/u)[0] ?? query;
  return first === '' ? query : first;
}
