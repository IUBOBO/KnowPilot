/**
 * 轻量调查计划（V3 / S5）。
 *
 * 【它不做什么】不新建 Agent、不做 DAG、不持久化计划。它只把**一个复杂问句**
 * 拆成 2–4 个可核对的子目标，供覆盖检查和一次受限改写使用；简单问题仍然只走
 * 原来的隐式 Tool Loop。
 *
 * 【为什么用启发式拆句而不是模型规划】
 *   计划是控制流：它决定"还缺哪个子问题、要不要再检索一次"。用模型生成计划
 *   会多一次不受预算约束的调用，而且难以解释"为什么拆成这样"。先按问号/并列词
 *   拆出子目标，失败模式是"拆得不够细"——那最多让改写少触发一次，不会造成越权。
 *
 * 【子目标里的 `focus` 与 `question` 分开】
 *   `question` 给人看（例如"收益"），`focus` 给检索/匹配用（会补上主问题里的
 *   关键术语，例如"频域增强 收益"）。短子句单独拿去检索几乎必然召回一堆无关内容。
 */
import { claimTerms } from './claim-verifier.ts';
import type { TaskRoute } from './task-router.ts';

export type SubgoalKind = 'document' | 'record' | 'either';

export interface Subgoal {
  id: string;
  /** 给人看的子问题 */
  question: string;
  /** 给检索/匹配用的短语（含主问题术语） */
  focus: string;
  kind: SubgoalKind;
  required: boolean;
}

export interface InvestigationPlan {
  route: TaskRoute;
  question: string;
  subgoals: readonly Subgoal[];
  /** 默认最多一次改写轮次（09 号 A3） */
  maxRewriteRounds: number;
  /** 每轮最多 3 条去重子查询 */
  maxQueriesPerRewrite: number;
}

const RECORD_HINT =
  /(状态|台账|投稿|稿子|稿件|分区|几区|期刊|数据集的?路径|数据集在|在哪|位置|代码仓库|学生名单|人员档案|在组学生|已授权|专利登记|大论文题目|登记的数据集)/u;
const GENERIC_TERMS = new Set([
  '什么', '怎么', '如何', '哪些', '是否', '可以', '需要', '这套', '这个', '那个',
  '分别', '现在', '目前', '当前', '我们', '它们', '以及', '同时', '另外', '还有',
  '是什么', '分别是什么', '怎么样',
]);

/**
 * 从问题里取可用于检索的短语。
 *
 * 【为什么不用 claimTerms 的 bigram】bigram 适合判断"两句是否重合"，拿去当检索
 *   查询会得到"套频 频域 域增"这种碎片，语义检索和关键词检索都不认。这里按
 *   中文连续片段取，再截到 6 个汉字，得到"频域增强方法""收益"这类可读的查询词。
 */
export function planKeyTerms(text: string): string[] {
  const out: string[] = [];
  const runs = text.match(/[㐀-鿿豈-﫿]{2,}/gu) ?? [];
  for (const run of runs) {
    for (const rawPiece of run.split(/和|与|及|分别/u)) {
      const piece = rawPiece.replace(/^(这套|这个|那个|我们|现在|目前|当前)/u, '').trim();
      if (piece.length < 2 || GENERIC_TERMS.has(piece)) continue;
      if (/^(是什么|什么|如何|怎么|哪些|为什么|多少)$/u.test(piece)) continue;
      const trimmed = piece.slice(0, 6);
      if (trimmed.length >= 2 && !out.includes(trimmed)) out.push(trimmed);
      if (out.length >= 4) return out;
    }
  }
  for (const word of text.matchAll(/[a-z][a-z0-9_-]{1,}/giu)) {
    if (out.length >= 4) break;
    const value = word[0].toLowerCase();
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function keyTerms(text: string): string[] {
  return planKeyTerms(text);
}

function normalizeClause(text: string): string {
  return text
    .replace(/[？?；;。！!]+/gu, ' ')
    .replace(/^[，,、\s]+/u, '')
    .replace(/^(另外|还有|同时|以及|那么|所以)\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function splitClauses(question: string): string[] {
  const marked = question.replace(/[？?]/gu, '\n').replace(/[；;]/gu, '\n');
  const parts = marked.split(
    /\n|(?:，|,)?\s*(?:分别|各自|以及|同时|另外|还有|和|与|、)\s*/u,
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const clause = normalizeClause(part);
    if (clause === '') continue;
    // "和" 拆出来的"是什么"不是子目标；它只是问句的尾巴。
    if (/^(是什么|什么|多少|怎样|如何|为什么|哪些)$/u.test(clause)) continue;
    const key = clause.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clause);
  }
  return out;
}

/**
 * 构建计划。`maxSubgoals` 限制 1–6（05 号阶段 4：2–6 个明确子问题）。
 */
export function buildInvestigationPlan(
  question: string,
  route: TaskRoute,
  maxSubgoals = 4,
): InvestigationPlan {
  const limit = Math.min(6, Math.max(1, Math.trunc(maxSubgoals)));
  const top = keyTerms(question);

  const make = (id: string, clause: string, kind: SubgoalKind, required = true): Subgoal => {
    // 短子句补上主问题里的术语；已经在子句里出现过的词不要重复拼进去
    // （否则会得到"频域增强 收益 代价 收益"这种自我重复的查询）。
    const mainTopic = top[0] ?? '';
    const focus =
      clause.length >= 4 || mainTopic === '' || clause.includes(mainTopic)
        ? clause
        : `${mainTopic} ${clause}`;
    return { id, question: clause, focus, kind, required };
  };

  if (route === 'state_lookup') {
    return {
      route,
      question,
      subgoals: [make('G1', question, 'record')],
      maxRewriteRounds: 1,
      maxQueriesPerRewrite: 3,
    };
  }

  if (route === 'simple') {
    return {
      route,
      question,
      subgoals: [make('G1', question, 'either')],
      maxRewriteRounds: 1,
      maxQueriesPerRewrite: 3,
    };
  }

  const clauses = splitClauses(question).slice(0, limit);
  const subgoals = (clauses.length > 0 ? clauses : [question]).map((clause, index) =>
    make(
      `G${index + 1}`,
      clause,
      RECORD_HINT.test(clause) ? 'record' : 'document',
    ),
  );

  return {
    route,
    question,
    subgoals,
    maxRewriteRounds: 1,
    maxQueriesPerRewrite: 3,
  };
}

/** 工具名是否属于"记录类"（台账/数据集/分区），用于子目标匹配偏好。 */
export function isRecordTool(toolName: string): boolean {
  return ['query_submissions', 'probe_dataset', 'query_journal', 'query_patents', 'query_theses', 'query_people'].includes(toolName);
}

/**
 * 把一次检索的查询词映射到最相关的子目标。
 *
 * 匹配只用于**覆盖统计**，不是"这条证据支持该子目标"的断言；后者由 V1 的
 * Claim 校验负责。匹配不上时返回 undefined —— 不要把一次无关检索硬塞给某个子目标。
 */
export function matchSubgoalForQuery(
  query: string,
  plan: InvestigationPlan,
  toolName: string,
): string | undefined {
  const q = normalizeClause(query);
  if (q === '') {
    return plan.route === 'state_lookup' ? plan.subgoals[0]?.id : undefined;
  }
  const queryTerms = new Set(claimTerms(q));
  const recordTool = isRecordTool(toolName);

  let best: { id: string; score: number; kind: SubgoalKind } | undefined;
  for (const subgoal of plan.subgoals) {
    // 记录类子目标只由记录工具取证，文档类子目标只由文档工具取证。
    // 否则一次文档检索返回的合规文件会把"台账状态"子目标误标成已覆盖。
    if (recordTool && subgoal.kind === 'document') continue;
    if (!recordTool && subgoal.kind === 'record') continue;
    const terms = new Set(claimTerms(subgoal.focus));
    let hits = 0;
    for (const term of queryTerms) if (terms.has(term)) hits += 1;
    // 记录工具优先匹配 record 子目标；文档工具优先 document/either。
    const kindBonus =
      (recordTool && subgoal.kind === 'record') || (!recordTool && subgoal.kind !== 'record')
        ? 0.5
        : 0;
    const score = hits + kindBonus;
    if (best === undefined || score > best.score) {
      best = { id: subgoal.id, score, kind: subgoal.kind };
    }
  }

  if (best !== undefined && best.score > 0.5) return best.id;
  // 状态类问题只有一个子目标：**记录工具**无论用什么关键词，都算在为它取证；
  // 文档检索不算（状态必须来自台账）。
  if (plan.route === 'state_lookup' && recordTool) return plan.subgoals[0]?.id;
  return undefined;
}

/** 计划摘要：不带子问题原文，适合放进日志/报告。 */
export function subgoalIds(plan: InvestigationPlan): string[] {
  return plan.subgoals.map((s) => s.id);
}
