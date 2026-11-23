/**
 * 子目标覆盖统计（V3 / S5）。
 *
 * 【它统计的是"有没有为这个子目标取到候选证据"，不是"证据是否支持结论"】
 *   覆盖是计划层的信号：某子目标连一条候选都没取到，就值得做一次定向改写；
 *   取到了不等于回答正确 —— 后者由 V1 的 Claim 校验与最终引用校验负责。
 *   把两件事混成一个分数，会让"覆盖率高"被误读成"答案可信"。
 *
 * 【为什么用"证据归到哪个子目标"而不是语义相似度】
 *   证据的身份（chunkId/recordId）和检索查询是可观测的；用查询词与子目标的
 *   词面匹配把证据归组，规则可复现，也不会因为某条长证据"看起来相关"就虚增覆盖。
 */
import { claimTerms } from './claim-verifier.ts';
import { planKeyTerms, type InvestigationPlan } from './planner.ts';

/**
 * 一条候选证据是否"有可能"在为这个子目标取证。
 *
 * 覆盖不是"检索返回了任何东西"就算数：一次无关查询也会返回 top-N。
 * 用子目标短语与证据原文的词面重合做一个很低的门槛，只过滤明显无关的块；
 * 语义改写/同义表述可能被漏掉，但那只会让改写多触发一次，不会把无关证据
 * 算成已覆盖（后者会让报告和最终 answer 自相矛盾）。
 */
const MIN_COVERAGE_OVERLAP = 0.3;

export function subgoalEvidenceRelevant(focus: string, text: string): boolean {
  // 先看有没有"成段的主题词"直接出现（"实验室的仪器""频域增强方法"）。
  // 只靠 bigram 重合度时，"实验室/流程"这类泛词会把无关制度算成相关。
  const key = planKeyTerms(focus);
  if (key.some((term) => term.length >= 2 && text.includes(term))) return true;

  const focusTerms = new Set(claimTerms(focus));
  if (focusTerms.size === 0) return false;
  const textTerms = new Set(claimTerms(text));
  let hit = 0;
  for (const term of focusTerms) if (textTerms.has(term)) hit += 1;
  return hit / focusTerms.size >= MIN_COVERAGE_OVERLAP;
}

export type CoverageState =
  | 'sufficient'
  | 'partial'
  | 'irrelevant'
  | 'conflicting'
  | 'not_found'
  | 'blocked';

export interface CoverageResult {
  state: CoverageState;
  coveredSubgoalIds: readonly string[];
  missingSubgoalIds: readonly string[];
  /** 每个子目标名下的候选证据条数 */
  evidenceCounts: Readonly<Record<string, number>>;
  /** 已覆盖的必需子目标 / 必需子目标总数（0 子目标时为 1） */
  ratio: number;
}

export function evaluateCoverage(
  plan: InvestigationPlan,
  evidenceBySubgoal: ReadonlyMap<string, ReadonlySet<string>>,
  opts: { blocked?: boolean } = {},
): CoverageResult {
  const required = plan.subgoals.filter((s) => s.required);
  const covered: string[] = [];
  const missing: string[] = [];
  const counts: Record<string, number> = {};

  for (const subgoal of required) {
    const n = evidenceBySubgoal.get(subgoal.id)?.size ?? 0;
    counts[subgoal.id] = n;
    (n > 0 ? covered : missing).push(subgoal.id);
  }

  const ratio = required.length === 0 ? 1 : covered.length / required.length;
  let state: CoverageState;
  if (opts.blocked === true) state = 'blocked';
  else if (required.length === 0 || covered.length === required.length) state = 'sufficient';
  else if (covered.length === 0) state = 'not_found';
  else state = 'partial';

  return {
    state,
    coveredSubgoalIds: covered,
    missingSubgoalIds: missing,
    evidenceCounts: counts,
    ratio,
  };
}

export function coverageLabel(state: CoverageState): string {
  switch (state) {
    case 'sufficient':
      return '子目标已覆盖';
    case 'partial':
      return '部分子目标缺证据';
    case 'not_found':
      return '没有找到候选证据';
    case 'blocked':
      return '预算/权限阻塞';
    case 'irrelevant':
      return '候选与问题无关';
    case 'conflicting':
      return '来源相互矛盾';
  }
}
