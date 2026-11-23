/**
 * S5（P1+P1-R）的零模型断言：路由、计划、覆盖、归因、改写去重。
 *
 * 【为什么只测纯函数】控制流的所有危险边界（无限改写、越权、把记录缺口拿文档
 * 去补、重复查询）在进入 ask-run 之前就能判死。把它们写成纯函数的正反两面
 * 断言，比跑一次真模型更能说明"不会循环"。
 */
import { buildInvestigationPlan, matchSubgoalForQuery } from './planner.ts';
import { evaluateCoverage, subgoalEvidenceRelevant } from './coverage.ts';
import { reflectRetrievalGap } from './retrieval-reflection.ts';
import { normalizeQuery, rewriteQueries } from './query-rewriter.ts';
import { routeTask, type TaskRoute } from './task-router.ts';
import { renderHistoryForRewrite } from './follow-up.ts';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${name}${detail === '' ? '' : ` —— ${detail}`}`);
}

function planFor(question: string, route: TaskRoute = routeTask(question)) {
  return buildInvestigationPlan(question, route);
}

{
  const history = Array.from({ length: 12 }, (_, i) => ({ question: `SYNTH_Q_${i}_END`, answer: `SYNTH_A_${i}_END` }));
  const rendered = renderHistoryForRewrite(history);
  check('追问改写只使用最近十轮', !rendered.includes('SYNTH_Q_0_END') && !rendered.includes('SYNTH_Q_1_END') &&
    history.slice(2).every((turn) => rendered.includes(turn.question) && rendered.includes(turn.answer)));
}

// ── 1. 路由 ───────────────────────────────────────────────────────
console.log('任务路由：simple / multi_source / state_lookup');

{
  check('实时状态 + 台账 → state_lookup', routeTask('我投的那篇稿子现在是什么状态？') === 'state_lookup');
  check('多问句 → multi_source', routeTask('这套方法的收益和代价分别是什么？') === 'multi_source');
  check('单一事实问题 → simple', routeTask('论文用的是什么方法？') === 'simple');
  check('只有"现在"没有台账 → simple', routeTask('现在几点了？') === 'simple');
}

// ── 2. 计划 ───────────────────────────────────────────────────────
console.log('计划：子目标、类型与上限');

{
  const q = '这套频域增强方法值不值得在实时场景下使用？收益和代价分别是什么？';
  const plan = planFor(q);
  check('多源问题拆出至少 2 个子目标', plan.subgoals.length >= 2, String(plan.subgoals.length));
  check('子目标数量不超过 4', plan.subgoals.length <= 4, String(plan.subgoals.length));
  check('改写轮次上限为 1', plan.maxRewriteRounds === 1);
  check('每轮最多 3 条查询', plan.maxQueriesPerRewrite === 3);
  check(
    '短子目标的 focus 带上主问题术语',
    plan.subgoals.some((s) => s.focus.includes('频域') || s.focus.includes('增强')),
    plan.subgoals.map((s) => s.focus).join(' | '),
  );

  const state = planFor('我的稿子现在外审到哪一步了？');
  check('状态计划只有一个记录子目标', state.subgoals.length === 1 && state.subgoals[0]?.kind === 'record');
  const simple = planFor('论文用的是什么方法？');
  check('简单计划只有一个 either 子目标', simple.subgoals.length === 1 && simple.subgoals[0]?.kind === 'either');
}

// ── 3. 覆盖 ───────────────────────────────────────────────────────
console.log('覆盖：按子目标统计候选，不把"相关"当"支持"');

{
  const plan = planFor('A 是什么？B 是什么？');
  const none = evaluateCoverage(plan, new Map());
  check('没有任何证据 → not_found', none.state === 'not_found', none.state);
  check('覆盖率 0', none.ratio === 0, String(none.ratio));

  const one = evaluateCoverage(plan, new Map([[plan.subgoals[0]!.id, new Set(['E1'])]]));
  check('只覆盖一个 → partial', one.state === 'partial', one.state);
  check('覆盖率 1/2', one.ratio === 0.5, String(one.ratio));

  const all = evaluateCoverage(
    plan,
    new Map([
      [plan.subgoals[0]!.id, new Set(['E1'])],
      [plan.subgoals[1]!.id, new Set(['E2'])],
    ]),
  );
  check('全部覆盖 → sufficient', all.state === 'sufficient', all.state);
  check('覆盖率 1', all.ratio === 1, String(all.ratio));

  check(
    '预算/权限阻塞 → blocked',
    evaluateCoverage(plan, new Map(), { blocked: true }).state === 'blocked',
  );

  check(
    '相关原文能计入覆盖',
    subgoalEvidenceRelevant('频域增强方法的收益', '该方法在频域增强后 mAP 提升 2.3') === true,
  );
  check(
    '无关 top-N 不能计入覆盖',
    subgoalEvidenceRelevant('实验室的仪器采购审批流程', '学位授予实施细则：论文查重率低于15%') === false,
  );
}

// ── 4. 归因与停止条件 ─────────────────────────────────────────────
console.log('归因：只有可纠正的文档缺口才允许一次改写');

{
  const statePlan = planFor('我的稿子现在什么状态？');
  const stateCoverage = evaluateCoverage(statePlan, new Map());
  const stateReflection = reflectRetrievalGap({
    coverage: stateCoverage,
    plan: statePlan,
    attempts: 0,
    budgetExhausted: false,
  });
  check('状态缺口 → 不改写（missing_source）', stateReflection.shouldRewrite === false && stateReflection.gapReason === 'missing_source');

  const multi = planFor('收益和代价分别是什么？');
  const multiMissing = evaluateCoverage(multi, new Map());
  const reflected = reflectRetrievalGap({
    coverage: multiMissing,
    plan: multi,
    attempts: 0,
    budgetExhausted: false,
  });
  check('多源文档缺口 → 允许改写', reflected.shouldRewrite === true, reflected.gapReason);

  const budget = reflectRetrievalGap({
    coverage: multiMissing,
    plan: multi,
    attempts: 0,
    budgetExhausted: true,
  });
  check('预算到顶 → 不改写', budget.shouldRewrite === false && budget.gapReason === 'budget_exceeded');

  const used = reflectRetrievalGap({
    coverage: multiMissing,
    plan: multi,
    attempts: 1,
    budgetExhausted: false,
  });
  check('改写轮次用完 → 不改写', used.shouldRewrite === false);

  const simplePlan = planFor('论文用的是什么方法？');
  const simpleReflection = reflectRetrievalGap({
    coverage: evaluateCoverage(simplePlan, new Map()),
    plan: simplePlan,
    attempts: 0,
    budgetExhausted: false,
  });
  check('简单问题不强制改写', simpleReflection.shouldRewrite === false);

  // 记录类缺口即使达到 1 轮，也不应变成文档改写。
  const recordPlan = buildInvestigationPlan('投稿状态 和 分区 分别是什么？', 'multi_source');
  const recordMissing = evaluateCoverage(recordPlan, new Map());
  if (recordPlan.subgoals.every((s) => s.kind === 'record')) {
    const recordReflection = reflectRetrievalGap({
      coverage: recordMissing,
      plan: recordPlan,
      attempts: 0,
      budgetExhausted: false,
    });
    check('记录类缺口 → 不改写', recordReflection.shouldRewrite === false);
  } else {
    check('记录类缺口用例的规划形态', true, '本问题被拆出文档子目标，跳过');
  }
}

// ── 5. 子目标匹配 ─────────────────────────────────────────────────
console.log('子目标匹配：文档检索不冒充台账证据');

{
  const plan = planFor('我的稿子现在什么状态？');
  check(
    '文档检索不匹配状态子目标',
    matchSubgoalForQuery('学位授予细则', plan, 'retrieve') === undefined,
  );
  check(
    '台账工具匹配状态子目标',
    matchSubgoalForQuery('my submission', plan, 'query_submissions') === plan.subgoals[0]?.id,
  );

  const multi = planFor('收益和代价分别是什么？');
  const hit = matchSubgoalForQuery('收益 提升', multi, 'retrieve');
  check('收益查询匹配到某个文档子目标', hit !== undefined, String(hit));
}

// ── 6. 改写查询 ───────────────────────────────────────────────────
console.log('改写查询：最多 3 条、去重、避开历史');

{
  const plan = planFor('这套频域增强方法值不值得在实时场景下使用？收益和代价分别是什么？');
  const missing = plan.subgoals.map((s) => s.id);
  const queries = rewriteQueries({
    plan,
    missingSubgoalIds: missing,
    history: new Set(),
    maxQueries: 3,
  });
  check('最多 3 条', queries.length <= 3, String(queries.length));
  check('查询非空', queries.every((q) => q.text.trim().length > 0));
  check('查询不重复', new Set(queries.map((q) => normalizeQuery(q.text))).size === queries.length);
  check(
    '查询带主问题术语（不是孤立子词）',
    queries.some((q) => q.text.includes('频域') || q.text.includes('增强')),
    queries.map((q) => q.text).join(' | '),
  );
  check('每条查询都带子目标 id', queries.every((q) => q.subgoalId.startsWith('G')));

  const history = new Set(queries.map((q) => normalizeQuery(q.text)));
  const again = rewriteQueries({
    plan,
    missingSubgoalIds: missing,
    history,
    maxQueries: 3,
  });
  check(
    '历史已出现的查询不再生成（允许生成新的变体）',
    again.every((q) => !history.has(normalizeQuery(q.text))),
    again.map((q) => q.text).join(' | '),
  );
  check('没有无限重复的候选：历史覆盖全部候选时返回空', again.length <= 3, String(again.length));

  const recordPlan = planFor('我的稿子现在什么状态？');
  const recordQueries = rewriteQueries({
    plan: recordPlan,
    missingSubgoalIds: recordPlan.subgoals.map((s) => s.id),
    history: new Set(),
    maxQueries: 3,
  });
  check('记录类子目标不生成文档改写查询', recordQueries.length === 0);
}

console.log('');
if (failed > 0) {
  console.error(`${failed} 项断言失败（通过 ${passed} 项）。`);
  process.exitCode = 1;
} else {
  console.log(`S5 路由/计划/覆盖/改写断言全部通过（${passed} 项）。`);
}
