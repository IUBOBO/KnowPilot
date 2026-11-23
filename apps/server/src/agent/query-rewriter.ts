/**
 * 受限 Query Rewriting（V3 / S5）。
 *
 * 【输入是"缺哪个子目标"，不是"再编几个查询"】只针对覆盖检查判出的缺失子目标
 *   生成查询，每轮最多 3 条；不在整个问题上自由发散。
 *
 * 【去重与历史】同一批内按规范化文本去重，并与已经出现过的查询历史比对 ——
 *   改写最危险的失败形态不是"没找到"，而是"换了个标点又搜一遍"，白烧预算。
 *
 * 【不做同义词词典之外的发散】只用一张很小的**领域同义词表**（收益/代价/查重率/
 *   状态/分区等）做变体；没有模型生成，也没有文档 ID 可以被"发明"。
 */
import { planKeyTerms, type InvestigationPlan } from './planner.ts';

export interface RewriteQuery {
  text: string;
  subgoalId: string;
  mode: 'hybrid';
}

const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  收益: ['效果', '提升', '性能'],
  代价: ['开销', '延迟', '成本'],
  查重率: ['重复率', '查重'],
  状态: ['进度', '进展'],
  分区: ['几区', '中科院', 'JCR'],
  数据集: ['数据路径', '位置'],
  方法: ['做法', '技术路线'],
  区别: ['差异', '不同'],
  限制: ['约束', '条件'],
};

/** 规范化查询：小写、去标点/多余空白。用于历史去重，不用于展示。 */
export function normalizeQuery(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s　]+/gu, ' ')
    .replace(/[，,。.！!？?；;：:「」『』"'“”‘’]/gu, '')
    .trim();
}

function keyTerms(text: string): string[] {
  return planKeyTerms(text);
}

function candidateVariants(subgoalFocus: string, subgoalQuestion: string, base: string): string[] {
  const out: string[] = [];
  const focus = subgoalFocus.trim();
  if (focus !== '') out.push(focus);
  if (base !== '' && !focus.includes(base)) out.push(`${base} ${subgoalQuestion}`.trim());
  for (const [key, variants] of Object.entries(SYNONYMS)) {
    if (!focus.includes(key)) continue;
    out.push(`${base} ${variants.join(' ')}`.trim());
  }
  return out;
}

/**
 * 为缺失子目标生成至多 `maxQueries` 条去重查询。
 * 返回顺序按子目标轮转，保证多个缺口都能被照顾到，而不是把额度全给第一个。
 */
export function rewriteQueries(input: {
  plan: InvestigationPlan;
  missingSubgoalIds: readonly string[];
  history: ReadonlySet<string>;
  maxQueries?: number;
}): RewriteQuery[] {
  const max = Math.max(0, Math.trunc(input.maxQueries ?? input.plan.maxQueriesPerRewrite));
  if (max === 0) return [];

  const base = keyTerms(input.plan.question).join(' ');
  const missing = input.plan.subgoals.filter(
    (s) => input.missingSubgoalIds.includes(s.id) && s.kind !== 'record',
  );

  const perSubgoal = missing.map((s) => ({
    subgoalId: s.id,
    variants: candidateVariants(s.focus, s.question, base),
  }));

  const selected: RewriteQuery[] = [];
  const seen = new Set(input.history);
  for (let depth = 0; depth < 3 && selected.length < max; depth += 1) {
    for (const group of perSubgoal) {
      if (selected.length >= max) break;
      const text = group.variants[depth];
      if (text === undefined) continue;
      const trimmed = text.trim();
      if (trimmed.length < 2 || trimmed.length > 120) continue;
      const key = normalizeQuery(trimmed);
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      selected.push({ text: trimmed, subgoalId: group.subgoalId, mode: 'hybrid' });
    }
  }
  return selected;
}
