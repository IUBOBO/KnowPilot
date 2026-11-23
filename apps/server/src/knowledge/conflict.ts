/**
 * 冲突检测：一条准备生效的知识，与库里**已生效**的知识撞不撞。
 *
 * 【为什么在"确认时"做，而不是"生成草案时"做】
 *   ① 草案会被改、被驳。生成时算出的结论，到用户真正点确认时可能早就过期了。
 *   ② "与已有知识冲突"这个判断，只在**准备进索引**的那一刻才有意义 ——
 *      没进索引的草案之间互不冲突。
 *   ③ 生成那一步已经要花一次模型调用了。再加一次 embedding 会让"随手写一句"
 *      明显变慢，而绝大多数条目的答案都是"不冲突"。
 *
 * 【为什么是向量相似度而不是让模型判断】便宜、确定、可离线重算。让模型判
 *   "这两条是不是在说同一件事"要花钱、每次结果还不一样；而向量相似度是纯计算，
 *   阈值可以调、分布可以量、结果可以复现。代价是它只会说"像"，不会说"矛盾" ——
 *   所以它拦下来的条目要**交给人裁决**，而不是自动处理。这也是 `admit` 之外
 *   还需要 `supersede`/`reject` 两个人工选项的原因。
 */
import type { KnowledgeConflict, KnowledgeEntry } from '@knowpilot/shared';
import { embeddingModelKey, type AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { blobToVec, embedTexts, isModelReady } from '../documents/embed.ts';
import { renderKnowledgeMarkdown } from './markdown.ts';
import { activeKnowledgeVectors } from './repo.ts';

/** 一条"已生效知识"的向量，解码之后参与比对。 */
export interface ActiveCandidate {
  vec: Float32Array;
  text: string;
  docId: string;
  entryId: string;
}

export interface NearestActive {
  entryId: string;
  documentId: string;
  /** 邻居正文的短摘录，供人快速判断"是不是真撞了"。 */
  excerpt: string;
  /** 余弦相似度（-1–1，实践中落在 0–1）。 */
  score: number;
}

/** 摘录长度。够看出"在说哪件事"，又不至于把整条正文搬进审核队列。 */
const EXCERPT_CHARS = 120;

/**
 * 找最像的一条。**纯函数**：不碰数据库、不碰模型，所以能拿合成向量直接验。
 *
 * 【为什么自己算模长，而不是直接点积】`embed.ts` 出来的向量确实是 L2 归一化的，
 *   点积就等于余弦。但这条函数同时要给验证脚本喂**合成向量**用 —— 一旦有人
 *   传进来没归一化的向量，直接点积会给出一个 >1 的"余弦"，而它不会报错，
 *   只会让阈值比较**静默地永远为真**（于是每条知识都被判成冲突）。
 *   多算两个模长是极便宜的保险，换掉一类最难发现的错误。
 *
 * 【维度不一致的行直接跳过】不同模型/不同精度的向量空间不可比。混着算出来的
 *   数字看着正常，其实毫无意义 —— 归零不如不算。
 */
export function nearestActive(
  candidate: Float32Array,
  rows: readonly ActiveCandidate[],
): NearestActive | null {
  let best: NearestActive | null = null;
  const candNorm = Math.sqrt(dot(candidate, candidate));
  if (candNorm === 0) return null;

  for (const row of rows) {
    if (row.vec.length !== candidate.length) continue;
    const rowNorm = Math.sqrt(dot(row.vec, row.vec));
    if (rowNorm === 0) continue;
    const score = dot(candidate, row.vec) / (candNorm * rowNorm);
    if (best === null || score > best.score) {
      best = {
        entryId: row.entryId,
        documentId: row.docId,
        excerpt: excerpt(row.text),
        score,
      };
    }
  }
  return best;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
}

/**
 * 检测的三种结局。
 *
 * 【为什么"跳过"要单独成一档，而不是当成"没冲突"】两者在界面上必须说得不一样：
 *   一个是"查过了，不冲突"，另一个是"**这次根本没查**"。混成一种，用户会以为
 *   系统替他把过关了 —— 而实际上那条可能正是和已有知识打架的那一条。
 *   所以 skipped 会带着一句理由一路传到界面（见 ConfirmKnowledgeGroupResponse.message）。
 */
export type ConflictCheck =
  | { kind: 'clear' }
  | { kind: 'conflict'; conflict: KnowledgeConflict }
  | { kind: 'skipped'; reason: string };

/** 库里没有任何"已生效的知识向量"时也走这里：没得比，就是没冲突。 */
export async function detectConflict(
  db: Db,
  cfg: AppConfig,
  entry: Pick<KnowledgeEntry, 'kind' | 'content'>,
): Promise<ConflictCheck> {
  const model = embeddingModelKey(cfg);

  if (!isModelReady(cfg)) {
    return {
      kind: 'skipped',
      reason:
        `本地向量模型（${model}）未就绪或未下载，本次未做冲突检测 —— ` +
        '这条知识是否与已有知识重复，没有被检查过。',
    };
  }

  const rows = activeKnowledgeVectors(db, model);
  if (rows.length === 0) return { kind: 'clear' };

  // 【为什么 embed 的是渲染后的 markdown，而不是 entry.content】
  //   邻居侧来自 `chunk_embeddings`，那是**入库文档切出来的块文本**，里面带着
  //   `# 标题` 与 `> 来源：…` 两行脚手架。候选侧若只喂正文，就是拿"正文"去比
  //   "正文+脚手架"—— 完全相同的两条知识因此算不出 1.0（实测约 0.93），
  //   阈值实际卡在哪儿取决于那段脚手架有多长。两侧同形之后，这条偏差在构造上
  //   就不存在了。见 markdown.ts 的说明。
  const candidate = renderKnowledgeMarkdown(entry);

  let vec: Float32Array | undefined;
  try {
    [vec] = await embedTexts(cfg, [candidate]);
  } catch (err) {
    // 模型加载/推理失败不该让"确认"这件事失败 —— 它只是一道加分检查。
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'skipped',
      reason: `本地向量模型推理失败（${message}），本次未做冲突检测。`,
    };
  }
  if (vec === undefined) {
    return { kind: 'skipped', reason: '本地向量模型没有返回结果，本次未做冲突检测。' };
  }

  const candidates: ActiveCandidate[] = [];
  for (const row of rows) {
    try {
      candidates.push({
        vec: blobToVec(row.vec, row.dim),
        text: row.text,
        docId: row.docId,
        entryId: row.entryId,
      });
    } catch {
      // 维度对不上的行（换过模型/精度）跳过。让它们把整次检测拖垮是没有道理的。
    }
  }

  const nearest = nearestActive(vec, candidates);
  const threshold = cfg.knowledgeConflictThreshold;
  if (nearest === null || nearest.score < threshold) return { kind: 'clear' };

  return {
    kind: 'conflict',
    conflict: {
      score: nearest.score,
      threshold,
      model,
      neighborEntryId: nearest.entryId,
      neighborDocumentId: nearest.documentId,
      neighborExcerpt: nearest.excerpt,
    },
  };
}
