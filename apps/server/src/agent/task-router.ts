/**
 * 任务路由（V3 / S5，P1-R 的最小启发式基线）。
 *
 * 【为什么先做启发式而不是让模型分类】
 *   路由结果决定"要不要拆计划、要不要允许一次改写"，它是**控制流**，不是回答内容。
 *   让模型决定控制流意味着多一次调用、多一份不可复现的判断；而这里要区分的三类
 *   （简单问答 / 多源综合 / 实时状态）都有很强的词汇特征，先用可审计的规则跑基线。
 *
 * 【三类的边界】
 *   · state_lookup —— "现在/目前/状态/进度" + "投稿/稿子/台账"：必须走台账工具；
 *   · multi_source —— 有多个问句，或带"分别/对比/收益和代价"等并列结构；
 *   · simple       —— 其余；不强行拆计划，保持原来的轻量路径。
 */

export type TaskRoute = 'simple' | 'multi_source' | 'state_lookup';

const STATE_WORDS = /(现在|目前|当前|最新|状态|到哪一步|进展|进度|外审|审稿)/u;
const LEDGER_WORDS = /(投稿|稿子|稿件|台账)/u;
const MULTI_MARKERS =
  /(分别|各自|各是|以及|同时|另外|还有|比较|对比|差别|区别|异同|优缺点|一方面|另一方面|收益.*代价|代价.*收益)/u;

/** 问句里出现了几个独立的问号（中文/英文都算）。 */
function questionMarks(text: string): number {
  return (text.match(/[？?]/gu) ?? []).length;
}

export function routeTask(question: string): TaskRoute {
  const q = question.trim();
  if (q === '') return 'simple';

  // 实时状态优先于多源：一个问题即使包含多个问号，只要在问"现在什么状态"，
  // 也不能把它拆成文档检索；台账工具才是权威来源。
  if (STATE_WORDS.test(q) && LEDGER_WORDS.test(q)) return 'state_lookup';

  if (questionMarks(q) >= 2) return 'multi_source';
  if (MULTI_MARKERS.test(q)) return 'multi_source';
  // "A 和 B" 这种没有显式并列词的结构：只在问题足够长时当作多源，
  // 避免把"论文和专利的区别"之外的大量短问题误拆。
  if (/(和|与)/u.test(q) && q.length >= 24) return 'multi_source';

  return 'simple';
}
