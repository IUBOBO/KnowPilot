/**
 * 给 Agent 的两个工具。
 *
 * 【为什么 schema 用 TypeBox 而不是 Zod】
 *   设计文档 02 §3 写的是"用 Zod 定义一次，同时派生 TS 类型与 JSON Schema"，
 *   但 pi-agent 的实现是 TypeBox：`pi-ai` 直接从 `typebox` 转出 `Type` 与 `Static`，
 *   `AgentTool<TParameters extends TSchema>` 约束的就是 TypeBox 的 schema。
 *   文档与代码不一致时以代码为准 —— 照文档写 Zod 会在类型上直接对不上，
 *   而且还要自己写一层 Zod→JSON Schema 的转换，纯属多此一举。
 *   TypeBox 的 schema 本身就是 JSON Schema，且能反推 TS 类型，正好满足"单一事实源"。
 */
import { StringEnum, Type, type Static } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  MATERIALS,
  SEARCH_MODES,
  SEARCH_MAX_LIMIT,
  type Material,
  type SearchHit,
  type SearchMode,
} from '@knowpilot/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { loadChunkTexts, loadDocumentVersions, parseSectionPath } from '../documents/repo.ts';
import { expandSectionEvidence, loadNeighborChunks, searchDocuments, type NeighborContext } from '../documents/search.ts';
import {
  MAX_RETRIEVAL_CONTEXT_CHARS,
  selectContextWindows,
  type EvidenceContextBudget,
} from './context-budget.ts';
import {
  EvidencePool,
  renderContextForModel,
  renderEvidenceForModel,
  renderRetrievalNotice,
  type QueryDetails,
} from './evidence.ts';

export const RETRIEVE_TOOL = 'retrieve';
export const READ_PAPER_TOOL = 'read_paper';
export const SUBMIT_ANSWER_TOOL = 'submit_answer';
export const REPAIR_QUOTES_TOOL = 'repair_quotes';

/** 单次检索默认返回多少块。给模型的不宜太多：上下文是有限资源，而它多半只看前几条。 */
const DEFAULT_LIMIT = 8;

/**
 * 邻近上下文（O1）的显示预算。
 *
 * 它从单次检索的 8000 字总预算里**借**，不是额外加：证据窗口本来就可能占满
 * 8000；若上下文另算，单次工具结果会无界增长，而模型的上下文窗口是有限资源。
 * 一条上下文最多显示 800 字（切块本身通常只有 600 字左右），一次最多 2000 字。
 */
const MAX_NEIGHBOR_CONTEXT_CHARS = 2000;
const MAX_NEIGHBOR_CHARS = 800;
/** 剩余预算低于这个数就不放上下文了：几十个字读不出上下句，只是噪声。 */
const MIN_CONTEXT_CHARS = 80;

const RetrieveParams = Type.Object({
  query: Type.String({
    description:
      '检索词。用问题里的关键术语原样查一次；没结果再换同义词或更短的词。不要一次写一长串句子。',
  }),
  within_evidence_id: Type.Optional(Type.String({
    description: '只补查某份已定位的文档时，填该文档任一已见证据编号；跨来源问题留空。',
  })),
  // 【为什么用 StringEnum 而不是 Type.Union(Type.Literal(...))】
  // TypeBox 的 `Union` 签名是 `anyOf: [...Types]`（元组位置），而 `SEARCH_MODES.map(...)`
  // 推出来的是普通数组 `TLiteral[]`，元组推断失败 → `Static` 退化成 `never`。
  // `never` 恰好能赋给任何参数，所以它不报错，只是悄悄把类型检查关掉了。
  // StringEnum 收的就是 `readonly string[]`，`T[number]` 直接还原成字面量联合。
  // 顺带的好处：它生成的是字符串 enum 而不是 anyOf/const，对不认 anyOf 的厂商更兼容。
  mode: Type.Optional(
    StringEnum(SEARCH_MODES, {
      description:
        '检索模式。keyword=字面匹配（术语、编号、专有名词准），semantic=语义近邻（换个说法也能找到），' +
        'hybrid=两者融合（默认，通常最稳）。',
    }),
  ),
  material: Type.Optional(
    StringEnum(MATERIALS, {
      description: '限定材料类型。只在问题明确属于某一类时使用，否则不要设。',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: SEARCH_MAX_LIMIT,
      description: `返回条数，默认 ${DEFAULT_LIMIT}。`,
    }),
  ),
});

const SubmitAnswerParams = Type.Object({
  answer: Type.String({
    description:
      '给用户看的中文正文。事实性结论后面必须跟 [E1] 这样的证据号，编号只能来自检索工具返回的内容。',
  }),
  quotes: Type.Array(
    Type.Object({
      evidence_id: Type.String({
        description: '证据号，如 "E1"。必须与正文里出现的编号一致。',
      }),
      quote: Type.String({
        description:
          '从该证据原文里逐字复制的支撑片段（至少 8 个字，不含空白；允许空白差异，不允许改字或拼接）。' +
          '只对文档证据需要；台账、数据集、分区记录由服务端填内容，不必提供。',
      }),
    }),
    {
      description:
        '逐条引用摘录。正文里每引用一条**文档**证据，这里就要有一条对应的 evidence_id + quote；' +
        '没有对应摘录的文档引用会被服务端剔除。确实没有引用时传空数组。',
    },
  ),
  evidence_gaps: Type.Array(
    Type.String(),
    {
      description:
        '明确列出"哪些问题没能找到依据"，一条一项。确实全都找到了才传空数组，不允许用空数组假装完整。',
    },
  ),
  limits: Type.Array(Type.String(), {
    description: '本次回答的边界：只覆盖了哪部分资料、依据的是哪一份文件、有哪些没验证的。',
  }),
  confidence_notes: Type.Array(Type.String(), {
    description:
      '需要用户保持谨慎的地方。经验类等未经同行评审的材料必须在这里说明。没有就传空数组。',
  }),
  conflicts: Type.Array(Type.String(), {
    description: '不同材料对同一件事说法矛盾时，逐条列出各自的说法与出处。没有就传空数组。',
  }),
});

export type RetrieveArgs = Static<typeof RetrieveParams>;
export type SubmitAnswerArgs = Static<typeof SubmitAnswerParams>;

export function submittedAnswerFromArgs(params: SubmitAnswerArgs): SubmittedAnswer {
  return {
    answer: params.answer,
    quotes: params.quotes.map((q) => ({ evidenceId: q.evidence_id, quote: q.quote })),
    evidenceGaps: params.evidence_gaps,
    limits: params.limits,
    confidenceNotes: params.confidence_notes,
    conflicts: params.conflicts,
  };
}

const RepairQuotesParams = Type.Object({ quotes: Type.Array(SubmitAnswerParams.properties.quotes.items, {
  description: '只提交需要补正的证据编号和逐字摘录。已正确的摘录保留在服务端，无需重复；无法核对的条目不提交。',
}) });

/** Repair only the evidence excerpts. The answer and its limits stay on the server. */
export function createRepairQuotesTool(sink: (quotes: readonly SubmittedQuote[]) => void)
  : AgentTool<typeof RepairQuotesParams, { quoteCount: number }> {
  return {
    name: REPAIR_QUOTES_TOOL,
    label: '补全引用摘录',
    description: '仅在服务端要求补正引用时调用。只提交对应证据的逐字摘录，不重写回答正文；无法核对的引用不提交，服务端会移除并标记未核实。',
    parameters: RepairQuotesParams,
    execute: async (_id, params) => {
      sink(params.quotes.map((q) => ({ evidenceId: q.evidence_id, quote: q.quote })));
      return { content: [{ type: 'text', text: '引用摘录已收到，将继续校验。' }], details: { quoteCount: params.quotes.length }, terminate: true };
    },
  };
}

/** 模型提交的一条引用摘录。字段名用 snake_case 与工具 JSON 保持一致。 */
export interface SubmittedQuote {
  evidenceId: string;
  quote: string;
}

/**
 * 模型提交的结构化答案。
 *
 * 注意这里**没有任何出处字段** —— 文档名、页码、摘录都不在 schema 里。
 * 模型只能给证据号，出处由服务端回填。理由见 packages/shared/src/answer.ts 顶部。
 */
export interface SubmittedAnswer {
  answer: string;
  /**
   * 模型提供的逐条摘录（O2）。
   *
   * 【为什么它没有并进 `answer` 的文本里】摘录是**校验材料**，不是给用户看的正文。
   *   把它写进正文会让用户看到两遍；而只留在正文里，服务端又无法知道哪一段
   *   是模型声称"支撑这句话"的原文。单独用一个结构化字段，才能逐条做子串比对。
   */
  quotes: readonly SubmittedQuote[];
  evidenceGaps: readonly string[];
  limits: readonly string[];
  confidenceNotes: readonly string[];
  conflicts: readonly string[];
}

export interface RetrieveDetails extends QueryDetails {
  query: string;
  mode: SearchMode;
  /** 库里有几条命中（未去重前） */
  hitCount: number;
  /** 本次真正渲染给模型的字符数（C1/X2a 上下文预算） */
  renderedChars?: number;
  /** 因上下文预算/预算耗尽未展示的候选条数 */
  droppedCount?: number;
  /** 展示的窗口中有多少条是"未读完"的 */
  truncatedCount?: number;
  /** 本次作为上下文附带的相邻块。不进证据池、没有 E 号、不可引用。 */
  contextChunkIds?: readonly string[];
  /** Relevant same-section continuations actually shown with separate evidence ids. */
  sectionEvidenceChunkIds?: readonly string[];
  /** 检索本身的说明（降级提示等），没有则不出现 */
  notice?: string;
}

export interface RetrieveToolDeps {
  db: Db;
  config: AppConfig;
  pool: EvidencePool;
  documentId?: string;
  /**
   * 本次运行共享的可见证据预算。省略时按单次上限独立计算（便于验证脚本直接调工具）。
   * 预算耗尽后不再把新证据渲染给模型 —— 已有证据仍可引用，不把整次问答判失败。
   */
  contextBudget?: EvidenceContextBudget;
}

/**
 * 检索工具。
 *
 * 【为什么返回整块原文而不是检索结果里的 segments】
 *   检索接口返回的 `segments` 是"命中词前后各 120 字"的摘要窗口，
 *   那是为**人快速扫一眼**设计的。模型要判断一段话是否真的支撑某个结论，
 *   必须看到完整的上下文 —— 只有半句话时它极易把"适用于硕士生"读成"适用于所有人"。
 *   代价是上下文变大，由轮次上限和单块截断共同兜住。
 */
export function createRetrieveTool(deps: RetrieveToolDeps): AgentTool<typeof RetrieveParams, RetrieveDetails> {
  return {
    name: RETRIEVE_TOOL,
    label: '检索实验室资料',
    description:
      '在实验室资料库里检索。返回带证据号（[E1]、[E2]…）的原文片段。' +
      '回答里的每个事实性结论都必须引用这里返回的证据号。',
    parameters: RetrieveParams,
    execute: async (_toolCallId, params): Promise<AgentToolResult<RetrieveDetails>> => {
      const mode: SearchMode = params.mode ?? 'hybrid';
      const limit = params.limit ?? DEFAULT_LIMIT;
      const material: Material | undefined = params.material;
      let documentId = deps.documentId;
      if (documentId === undefined && params.within_evidence_id !== undefined) {
        const anchor = deps.pool.get(params.within_evidence_id);
        if (anchor?.kind !== 'document') throw new Error('补查范围必须是已经检索到的文档证据。');
        documentId = anchor.documentId;
      }

      // 整次运行的可见证据预算已经用完：不再搜、也不再往上下文里加东西。
      // 这不是失败 —— 模型还有前面几轮拿到的证据可以作答。
      if (deps.contextBudget !== undefined && deps.contextBudget.remaining <= 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                '本次运行的证据展示预算已用完，没有返回新的证据。' +
                '请基于前面已经返回的证据作答；如果关键依据仍缺失，把它写进 evidence_gaps。',
            },
          ],
          details: {
            query: params.query,
            mode,
            hitCount: 0,
            newEvidenceIds: [],
            evidenceIds: [],
            notice: '证据展示预算已用完（V3 C1），未执行新的检索渲染。',
          },
        };
      }

      const result = await searchDocuments(deps.db, deps.config, {
        query: params.query,
        mode,
        limit,
        ...(material !== undefined ? { material } : {}),
        ...(documentId !== undefined ? { documentId } : {}),
      });

      const originalIds = new Set(result.hits.map((h) => h.chunkId));
      const evidenceHits = expandSectionEvidence(deps.db,result.hits,params.query);

      const texts = loadChunkTexts(
        deps.db,
        evidenceHits.map((h: SearchHit) => h.chunkId),
      );
      const versions = loadDocumentVersions(
        deps.db,
        evidenceHits.map((h: SearchHit) => h.documentId),
      );

      // 先做候选表（原文 + 来源），再让预算器决定这次展示哪几段。
      // 没被选中的**不加入证据池**：否则 Trace 的 retrievalHits 会把
      // "检索到但模型没看到"也算成召回，评测会出现假阳性。
      const candidates: {
        hit: SearchHit;
        text: string;
        sourceVersion: string;
        sourceKey: string;
      }[] = [];
      for (const hit of evidenceHits) {
        // 取不到原文就跳过这一条：宁可少给一条证据，也不能给一条没有正文的空壳，
        // 那会让模型以为"这里什么都没有"而放弃一个本来有效的出处。
        const text = texts.get(hit.chunkId);
        if (text === undefined || text.trim() === '') continue;
        candidates.push({
          hit,
          text,
          sourceVersion: String(versions.get(hit.documentId) ?? 'unknown'),
          sourceKey: `doc:${hit.documentId}`,
        });
      }

      const callBudget = Math.min(
        MAX_RETRIEVAL_CONTEXT_CHARS,
        deps.contextBudget?.remaining ?? MAX_RETRIEVAL_CONTEXT_CHARS,
      );
      const selectWithBudget = (budget: number) =>
        selectContextWindows(
          candidates.map((c) => ({ sourceKey: c.sourceKey, text: c.text })),
          params.query,
          budget,
        );

      let selected = selectWithBudget(callBudget);
      const neighbors = loadNeighborChunks(deps.db, evidenceHits);
      const contextsFor = (hit: SearchHit): readonly NeighborContext[] =>
        neighbors.get(hit.chunkId) ?? [];

      // 证据窗口先按完整预算选。只有在"选中证据确实带上下文、剩余预算又不够"时
      // 才重选一次，从证据预算里让出一块 —— 没有邻居的文档不该平白少给证据。
      const contextNeed = selected.reduce((sum, choice) => {
        const candidate = candidates[choice.index];
        if (candidate === undefined) return sum;
        return (
          sum +
          contextsFor(candidate.hit).reduce(
            (n, ctx) => n + Math.min(ctx.text.length, MAX_NEIGHBOR_CHARS),
            0,
          )
        );
      }, 0);
      if (contextNeed > 0) {
        const evidenceUsed = selected.reduce((n, choice) => n + choice.window.text.length, 0);
        const reserve = Math.min(MAX_NEIGHBOR_CONTEXT_CHARS, contextNeed);
        if (callBudget - evidenceUsed < reserve) {
          selected = selectWithBudget(Math.max(0, callBudget - reserve));
        }
      }

      const newEvidenceIds: string[] = [];
      const evidenceIds: string[] = [];
      const contextChunkIds: string[] = [];
      const rendered: string[] = [];
      let usedChars = 0;
      let contextChars = 0;
      let truncatedCount = 0;

      for (const choice of selected) {
        const candidate = candidates[choice.index];
        if (candidate === undefined) continue;
        const { evidence, isNew } = deps.pool.addDoc(
          candidate.hit,
          candidate.text,
          candidate.sourceVersion,
        );
        if (isNew) newEvidenceIds.push(evidence.id);
        evidenceIds.push(evidence.id);
        rendered.push(renderEvidenceForModel(evidence, choice.window));
        usedChars += choice.window.text.length;
        if (choice.window.isTruncated) truncatedCount += 1;

        for (const context of contextsFor(candidate.hit)) {
          const allowance = Math.min(
            MAX_NEIGHBOR_CONTEXT_CHARS - contextChars,
            callBudget - usedChars - contextChars,
          );
          if (allowance < MIN_CONTEXT_CHARS) break;
          const block = renderNeighborContext(context, evidence.id, allowance);
          if (block === null) break;
          rendered.push(block.text);
          contextChars += block.chars;
          contextChunkIds.push(context.chunkId);
        }
      }
      deps.contextBudget?.take(usedChars + contextChars);

      const hitCount = result.hits.length;
      // 上下文块也进了 rendered，但它是"附带的上下文"，不是命中条数的一部分。
      const shown = evidenceIds.length;
      const dropped = Math.max(0, evidenceHits.length - shown);
      const sectionEvidenceChunkIds = selected.map((choice) => candidates[choice.index]?.hit.chunkId)
        .filter((id): id is string => id !== undefined && !originalIds.has(id));
      const head =
        hitCount === 0
          ? `检索「${params.query}」（${mode}）没有找到任何内容。`
          : evidenceHits.length > hitCount
            ? `检索「${params.query}」（${mode}）命中 ${hitCount} 条，另补充同章节原文；本次共展示 ${shown} 条独立证据：`
          : shown === hitCount
            ? `检索「${params.query}」（${mode}）命中 ${hitCount} 条：`
            : `检索「${params.query}」（${mode}）命中 ${hitCount} 条，本次展示 ${shown} 条：`;
      const budgetLine =
        dropped > 0
          ? `（另有 ${dropped} 条候选因上下文预算未展示；需要时换更精确的词再查。）`
          : '';

      const text = [
        renderRetrievalNotice(result.notice),
        head,
        ...(budgetLine !== '' ? [budgetLine] : []),
        ...(rendered.length > 0 ? ['', ...rendered] : []),
        '',
        rendered.length === 0
          ? '不要用你自己的知识补充。可以换一个关键词或换 mode 再试一次；两次都没有就如实告诉用户没有找到依据。'
          : '以上是资料原文（每条都标了原文总长度与本次可见范围）。引用时用上面的编号，例如 [E1]；' +
            '若某条写着「未读完」，不得声称读过它的全文。' +
            (contextChunkIds.length > 0
              ? '其中 <context> 标签是命中块的相邻上下文，只用于理解上下句；' +
                '它没有证据号，**不是证据，不能写成 [En]**。'
              : ''),
      ].join('\n');

      return {
        content: [{ type: 'text', text }],
        details: {
          query: params.query,
          mode: result.mode,
          hitCount,
          newEvidenceIds,
          evidenceIds,
          renderedChars: usedChars + contextChars,
          droppedCount: dropped,
          truncatedCount,
          ...(contextChunkIds.length > 0 ? { contextChunkIds } : {}),
          ...(sectionEvidenceChunkIds.length > 0 ? { sectionEvidenceChunkIds } : {}),
          ...(result.notice !== undefined ? { notice: result.notice } : {}),
        },
      };
    },
  };
}

/**
 * 渲染一条邻近上下文，返回文本与计入预算的字符数。
 *
 * 上下文超出预算时，保留**靠近命中块的那一端**：前一块保留末尾、后一块保留开头。
 * 反过来保留离命中块最远的一截，读到的恰好是与当前问题最无关的内容。
 * 返回 null 表示剩余预算连一句上下文都放不下，调用方停止渲染。
 */
function renderNeighborContext(
  context: NeighborContext,
  evidenceId: string,
  allowance: number,
): { text: string; chars: number } | null {
  // 标签、来源行与截断标记本身也要占字符；从 allowance 里先扣掉一个保守的固定开销。
  const bodyBudget = Math.min(MAX_NEIGHBOR_CHARS, allowance - 180);
  if (bodyBudget < MIN_CONTEXT_CHARS) return null;

  let body = context.text;
  let truncated = false;
  if (body.length > bodyBudget) {
    truncated = true;
    const marker = context.relation === 'previous' ? '…（前文截断）' : '（后文截断）…';
    const keep = Math.max(0, bodyBudget - marker.length);
    body =
      context.relation === 'previous'
        ? marker + body.slice(body.length - keep)
        : body.slice(0, keep) + marker;
  }

  const text = renderContextForModel({
    evidenceId,
    relation: context.relation,
    documentTitle: context.documentTitle,
    page: context.page,
    sectionPath: context.sectionPath,
    text: body,
    truncated,
  });
  return { text, chars: text.length };
}

export interface SubmitDetails {
  answerChars: number;
  evidenceGapCount: number;
}

/**
 * 提交答案工具。
 *
 * 【为什么要做成工具而不是让模型直接写在回复里】
 *   两个理由，第二个是决定性的：
 *   1. 设计文档 02 §3 要求"输出为受控 JSON/结构化而非自由文本"，§2.3 的结构里
 *      evidence_gaps / limits / confidence_notes / conflicts 四个数组，
 *      靠解析自由文本里的固定小标题拿，等于把契约建在正则上。
 *   2. `terminate: true` 让循环在这一步干净地结束 —— 不需要事后猜测
 *      "模型写完了没有"，也不会出现模型提交完答案又接着检索一轮的情况。
 */
export function createSubmitAnswerTool(
  sink: (submitted: SubmittedAnswer) => void,
): AgentTool<typeof SubmitAnswerParams, SubmitDetails> {
  return {
    name: SUBMIT_ANSWER_TOOL,
    label: '提交最终答案',
    description:
      '查完资料后调用它提交最终答案。正文写在 answer 里，含 [En] 引用标记。' +
      '调用它就代表本次任务结束，不要再用回复正文作答。',
    parameters: SubmitAnswerParams,
    execute: async (_toolCallId, params): Promise<AgentToolResult<SubmitDetails>> => {
      sink(submittedAnswerFromArgs(params));
      return {
        content: [{ type: 'text', text: '已收到答案。' }],
        details: { answerChars: params.answer.length, evidenceGapCount: params.evidence_gaps.length },
        // 提交即结束：这一批工具执行完后循环不再继续。
        terminate: true,
      };
    },
  };
}

const ReadPaperParams = Type.Object({
  evidence_id: Type.String({ description: '已检索到的目标论文证据号，例如 E1。' }),
  scope: StringEnum(['section', 'full'] as const, {
    description: 'section 按问题找章节、公式、图表说明或附录。只有明确要求全文时用 full。',
  }),
  query: Type.Optional(Type.String({ description: 'section 模式下，从论文题目以外选取要查的术语或章节名。' })),
  from: Type.Optional(Type.Integer({ minimum: 0, description: 'full 首批从 0 开始，后续使用工具返回的下一批位置。' })),
});

export function createReadPaperTool(deps: RetrieveToolDeps): AgentTool<typeof ReadPaperParams, QueryDetails> {
  return {
    name: READ_PAPER_TOOL,
    label: '阅读论文原文',
    description: '用于用户要求查阅具体章节、公式、图表说明、附录或全文的深读任务，材料限于知识库中的解析文本。',
    parameters: ReadPaperParams,
    execute: async (toolCallId, params, signal) => {
      const anchor = deps.pool.get(params.evidence_id);
      if (anchor?.kind !== 'document') throw new Error('请先检索目标论文，提供它的证据号。');
      if (params.scope === 'section') {
        const query = params.query?.trim();
        if (!query) throw new Error('请提供要查的章节或关键术语。');
        return createRetrieveTool({ ...deps, documentId: anchor.documentId }).execute(toolCallId, { query }, signal);
      }

      const from = params.from ?? 0;
      const rows = deps.db.prepare(
        `SELECT c.id, c.ordinal, c.text, c.page, c.section_path, d.index_version
           FROM doc_chunks c JOIN documents d ON d.id = c.doc_id
          WHERE c.doc_id = ? AND c.ordinal >= ? ORDER BY c.ordinal LIMIT 13`,
      ).all(anchor.documentId, from) as unknown as {
        id: string; ordinal: number; text: string; page: number | null; section_path: string | null; index_version: number;
      }[];
      if (rows.length === 0 || String(rows[0]!.index_version) !== anchor.sourceVersion) {
        throw new Error('该文档没有更多可读文本，或版本已更新。请重新定位来源。');
      }

      const evidenceIds: string[] = [];
      const newEvidenceIds: string[] = [];
      const rendered: string[] = [];
      let remaining = Math.min(MAX_RETRIEVAL_CONTEXT_CHARS, deps.contextBudget?.remaining ?? MAX_RETRIEVAL_CONTEXT_CHARS);
      let next = rows[0]!.ordinal;
      let truncated = false;
      for (const row of rows.slice(0, 12)) {
        if (remaining === 0 || (rendered.length > 0 && row.text.length > remaining)) break;
        const text = row.text.slice(0, remaining);
        const { evidence, isNew } = deps.pool.addDoc({
          chunkId: row.id, documentId: anchor.documentId, documentTitle: anchor.documentTitle,
          material: anchor.material, page: row.page, sectionPath: parseSectionPath(row.section_path),
          segments: [], score: 0,
        }, row.text, anchor.sourceVersion);
        evidenceIds.push(evidence.id);
        if (isNew) newEvidenceIds.push(evidence.id);
        const isTruncated = text.length !== row.text.length;
        rendered.push(renderEvidenceForModel(evidence, { start: 0, end: text.length, text, originalChars: row.text.length, isTruncated }));
        deps.contextBudget?.take(text.length);
        remaining -= text.length;
        next = row.ordinal + 1;
        truncated ||= isTruncated;
      }
      const hasMore = rows.some((row) => row.ordinal >= next);
      return {
        content: [{ type: 'text', text: [
          `《${anchor.documentTitle}》已解析文本，本批展示 ${rendered.length} 块。`,
          ...(hasMore ? [`还有未读文本。继续读时设置 from=${next}。`] : ['已到达解析文本末尾。']),
          ...(truncated ? ['本批部分块因预算截断，须说明实际阅读范围。'] : []),
          '解析文本可能缺少图像、公式符号或未入库的附录；判断时只用实际显示的数据。',
          ...rendered,
        ].join('\n') }],
        details: { evidenceIds, newEvidenceIds },
      };
    },
  };
}
