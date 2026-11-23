/**
 * 检索失败归因（V3 / S5）。
 *
 * 【为什么归因必须是服务端硬规则】
 *   模型很容易把"没找到"解释成"换个词再试"，而真正的停止条件应该是：
 *   预算到顶、只缺记录类来源、或者已经用掉唯一一次改写。归因由服务端决定，
 *   模型只负责在拿到补充证据后作答；否则"再查一次"会变成无界循环。
 *
 * 【本轮的归因能力是启发式的】只区分 term_mismatch / missing_subgoal /
 *   missing_source / budget_exceeded / unknown；不调用模型 Judge。
 */
import type { CoverageResult, CoverageState } from './coverage.ts';
import type { InvestigationPlan } from './planner.ts';

export type GapReason =
  | 'term_mismatch'
  | 'too_broad'
  | 'missing_source'
  | 'missing_subgoal'
  | 'conflicting_sources'
  | 'permission_denied'
  | 'budget_exceeded'
  | 'unknown';

export interface RetrievalReflection {
  gapReason: GapReason;
  /** 服务端复核后的结论；false 时 ask-run 不允许改写 */
  shouldRewrite: boolean;
  missingSubgoalIds: readonly string[];
  rationale: string;
}

/** 一次改写轮次的可审计记录（进 Trace）。 */
export interface RewriteEvent {
  round: number;
  gapReason: GapReason;
  missingSubgoalIds: readonly string[];
  queries: readonly { text: string; subgoalId: string }[];
  evidenceIdsAdded: readonly string[];
  coverageBefore: CoverageState;
  coverageAfter: CoverageState;
  stoppedReason: 'completed' | 'budget' | 'empty_queries' | 'no_evidence' | 'blocked' | 'error';
}

export function reflectRetrievalGap(input: {
  coverage: CoverageResult;
  plan: InvestigationPlan;
  attempts: number;
  budgetExhausted: boolean;
  permissionDenied?: boolean;
}): RetrievalReflection {
  const { coverage, plan, attempts, budgetExhausted } = input;
  const missing = coverage.missingSubgoalIds;

  if (coverage.state === 'sufficient') {
    return { gapReason: 'unknown', shouldRewrite: false, missingSubgoalIds: missing, rationale: '子目标已覆盖。' };
  }
  if (input.permissionDenied === true) {
    return {
      gapReason: 'permission_denied',
      shouldRewrite: false,
      missingSubgoalIds: missing,
      rationale: '权限拒绝不允许通过换关键词绕过。',
    };
  }
  if (budgetExhausted) {
    return {
      gapReason: 'budget_exceeded',
      shouldRewrite: false,
      missingSubgoalIds: missing,
      rationale: '四维预算已到顶，停止改写。',
    };
  }

  // 实时状态/台账类缺口：文档改写帮不上忙，必须让台账工具回答或如实说缺失。
  const missingSubgoals = plan.subgoals.filter((s) => missing.includes(s.id));
  const onlyRecord = missingSubgoals.length > 0 && missingSubgoals.every((s) => s.kind === 'record');
  if (plan.route === 'state_lookup' || onlyRecord) {
    return {
      gapReason: 'missing_source',
      shouldRewrite: false,
      missingSubgoalIds: missing,
      rationale: '缺口属于台账/记录类来源，不能用文档检索改写补齐。',
    };
  }

  if (plan.route !== 'multi_source') {
    return {
      gapReason: 'unknown',
      shouldRewrite: false,
      missingSubgoalIds: missing,
      rationale: '简单问题保持原隐式 Tool Loop，不强制规划改写。',
    };
  }

  if (attempts >= plan.maxRewriteRounds) {
    return {
      gapReason: coverage.ratio > 0 ? 'missing_subgoal' : 'term_mismatch',
      shouldRewrite: false,
      missingSubgoalIds: missing,
      rationale: '改写轮次已用完，保留 evidence_gaps。',
    };
  }

  return {
    gapReason:
      coverage.state === 'partial' && coverage.coveredSubgoalIds.length > 0
        ? 'missing_subgoal'
        : 'term_mismatch',
    shouldRewrite: true,
    missingSubgoalIds: missing,
    rationale:
      coverage.state === 'partial'
        ? '部分子目标缺候选证据，允许一次定向补检索。'
        : '首轮候选未覆盖子目标，可能是术语不匹配，允许一次改写。',
  };
}
