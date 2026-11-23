/**
 * O0 的检索指标：召回@8、MRR@8、无关块占比。
 *
 * 【为什么是纯函数、单独一个文件】它们要参与"两次改动前后数字能不能比"的判断，
 *   而这类代码最怕边界悄悄变（去不去重、金标不在前 8 时 MRR 记 0 还是不算、
 *   空金标怎么处理）。写成纯函数，`eval-check.ts` 就能把每种边界钉死；
 *   跑批端只负责把观测量喂进来。
 *
 * 【"前 8 条"在这里的确切含义 —— 必须写清】`retrievalHits` 是**证据池**的顺序，
 *   不是某一次检索的原始分数排名：一次问答里模型可能查多轮，池子按首次进入去重。
 *   所以这里的"@8"= 证据池前 8 个**不重复**的块。单轮检索时它与 top-8 一致；
 *   多轮时它是一个略宽的近似（前几轮的高分结果仍然排在前面）。
 *   报告里按这个口径写，不把它说成"检索器 top-8"。
 */

/** 一条用例的检索指标。`null` = 这条用例没有金标（预期拒答题），不参与统计。 */
export interface RetrievalMetrics {
  /** 参与计算的前 8 个不重复候选数（语料太少时可能小于 8）。 */
  hits8: number;
  /** 金标块总数。 */
  goldCount: number;
  /** 前 8 条里命中的金标数。 */
  goldHitCount: number;
  /** 召回@8 = 命中的金标数 / 金标总数。 */
  recallAt8: number;
  /** 第一条金标命中的倒数排名；前 8 里没有金标时记 0（不是"不统计"）。 */
  mrr: number;
  /**
   * 无关块占比 = 前 8 条里非金标的条数 / 前 8 条总数。
   *
   * 【它的已知上界】语料里真正相关的块可能不止金标标出的那些（例如同一份文档的
   *   相邻块），它们会被算成"无关"。所以这个数字是**上界**，只看趋势，不看绝对值。
   */
  unrelatedRatio: number;
}

/**
 * 算一条用例的检索指标。
 *
 * @param hits 证据池里的块 id，按首次进入顺序。
 * @param gold 金标块 id。空数组 = 这条用例没有金标 → 返回 null（"不统计"，不是 0 分）。
 */
export function retrievalMetrics(
  hits: readonly string[],
  gold: readonly string[],
): RetrievalMetrics | null {
  if (gold.length === 0) return null;
  const top8 = [...new Set(hits)].slice(0, 8);
  const goldSet = new Set(gold);
  const goldHitCount = top8.filter((id) => goldSet.has(id)).length;
  const firstHit = top8.findIndex((id) => goldSet.has(id));
  return {
    hits8: top8.length,
    goldCount: gold.length,
    goldHitCount,
    recallAt8: goldHitCount / gold.length,
    mrr: firstHit === -1 ? 0 : 1 / (firstHit + 1),
    unrelatedRatio: top8.length === 0 ? 0 : (top8.length - goldHitCount) / top8.length,
  };
}

/** 多条（多回合 / 多用例）的汇总。 */
export interface RetrievalAggregate {
  /** 参与统计的样本数（回合数，不是用例数 —— k=3 时同一条会算 3 次）。 */
  samples: number;
  /** 召回@8 的宏平均（每条样本先算召回，再平均）。 */
  recallAt8: number;
  /** 召回@8 的微平均（所有命中的金标 / 所有金标），用于看"金标多的题是否被拉低"。 */
  microRecallAt8: number;
  mrr: number;
  unrelatedRatio: number;
  goldHitTotal: number;
  goldTotal: number;
}

/** 汇总多条指标。空数组 → null（"这一轮没有可统计的标注样本"）。 */
export function aggregateRetrieval(
  items: readonly RetrievalMetrics[],
): RetrievalAggregate | null {
  if (items.length === 0) return null;
  const goldHitTotal = items.reduce((n, i) => n + i.goldHitCount, 0);
  const goldTotal = items.reduce((n, i) => n + i.goldCount, 0);
  const hitsTotal = items.reduce((n, i) => n + i.hits8, 0);
  const unrelatedTotal = items.reduce((n, i) => n + (i.hits8 - i.goldHitCount), 0);
  return {
    samples: items.length,
    recallAt8: items.reduce((n, i) => n + i.recallAt8, 0) / items.length,
    microRecallAt8: goldTotal === 0 ? 0 : goldHitTotal / goldTotal,
    mrr: items.reduce((n, i) => n + i.mrr, 0) / items.length,
    unrelatedRatio: hitsTotal === 0 ? 0 : unrelatedTotal / hitsTotal,
    goldHitTotal,
    goldTotal,
  };
}

/** 百分比（保留一位小数），报告里统一用它，免得各处小数位不一致。 */
export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
