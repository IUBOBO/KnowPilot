/**
 * 问答（阶段 2）的契约。前后端共用。
 *
 * 【这个文件里最重要的一个决定：引用对象只由服务端组装】
 *
 * 模型看不到 `Citation` 这个结构，它只能写正文并在正文里放 `[E1]` 这样的编号。
 * 文档标题、页码、章节路径、摘录原文全部由服务端从证据池回填。
 *
 * 为什么不在 schema 里给模型出处字段：
 *   一旦模型能产出"出处对象"，它就有机会编一个看起来完全合理的出处
 *   （作者、年份、页码都像模像样），而这种编造**没有任何代码能确定性识别**。
 *   改成"模型只能给编号"之后，幻觉引用只剩一种形态 —— 给一个不存在的编号
 *   （比如 `[E9]` 而证据池里只有 E1~E4）—— 这是纯字符串比对就能拦住的。
 *
 *   代价是模型不能自己决定"这段引用摘录哪一句"，只能整块引用。
 *   这个代价是值得的：可核对性比摘录美观重要得多。
 */
import type { Material, MatchSource, SearchMode } from './documents.ts';
import type { ApiErrorBody } from './errors.ts';
import type { AskProcessEventV1, AskProcessV1 } from './ask-process.ts';
export type { AskProcessCounts, AskProcessEventV1, AskProcessLookup, AskProcessPhase, AskProcessSource, AskProcessStep, AskProcessV1 } from './ask-process.ts';

/**
 * 引用分两类：**文档**（检索命中的原文块）与**记录**（实时查出来的台账 / 数据集 / 分区行）。
 *
 * 【为什么必须分类，而不是给同一个 interface 加几个可选字段】
 *   两者的"能回到哪里"根本不同：文档引用能点开 `/chunk/:chunkId` 回到原文那一页，
 *   台账引用没有页码也没有块，它指向的是库里**此刻**的一行记录。
 *   如果只用可选字段表达，前端会写出 `citation.chunkId` 这样的访问而编译器不管
 *   —— 于是台账引用会渲染成一个指向 `/chunk/undefined` 的死链，而且看起来很正常。
 *   判别联合让"没有 chunkId 的引用"在类型上就不可能出现。
 *
 * 【曾经还有第三类「网页」】联网搜索（阶段 3 单元 ⑤）已于 2026-10-12 整体下线：
 *   没有可用的搜索 API，那套 provider 适配、外部引用与证据类型一并删除。
 *   相应地这里的判别联合少了一支 —— 模型能引用的出处只剩"库里的东西"。
 */
export type CitationSourceType = 'document' | 'record';

/**
 * 实时查询的来源标识（设计文档 02 号 §2.3 的 `record_type`）。
 *
 * 用能力代号而不是表名：将来台账换个存法（比如加一张归档表），
 * 引用上的标识不该跟着变 —— 它是给用户看"这条结论是从哪一类东西查出来的"。
 *
 * `M-JOURNAL` 是分区（单元 ⑤）。它是**版本化**的那一类 ——
 * 硬约束 3 要求分区引用必须带上"哪一年的哪个体系"，落在 `RecordCitation.version` 上。
 */
export const RECORD_TYPES = ['M-SUBMIT', 'M-CODE', 'M-JOURNAL', 'M-PATENT', 'M-THESIS', 'M-PERSON'] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

export const RECORD_TYPE_LABELS: Record<RecordType, string> = {
  'M-SUBMIT': '投稿台账',
  'M-CODE': '数据集',
  'M-JOURNAL': '期刊分区',
  'M-PATENT': '专利台账',
  'M-THESIS': '大论文',
  'M-PERSON': '人员档案',
};

/** 引用上带的一个结论字段（"状态：外审"、"存在性：存在"）。由服务端从库里取。 */
export interface CitationField {
  label: string;
  value: string;
}

interface CitationBase {
  /** 证据号，形如 "E1"。正文里的 `[E1]` 与它一一对应 */
  id: string;
  /** 服务端从库里取的支撑片段（不是模型写的） */
  excerpt: string;
  sourceType: CitationSourceType;
  /**
   * 证据原文的总字符数。
   *
   * 【为什么引用上要有这个数】模型看到的可能只是原文的一段；用户核对时
   * 也需要知道"这条引用背后到底有多长"。它和 `excerpt` 的长度不是一回事：
   * 文档引用给完整块，记录引用给字段渲染文本。
   */
  originalChars: number;
  /**
   * 来源版本：文档是 `documents.index_version`；记录是适用版本/更新时间/查询时点。
   * 长证据被截断时，用户至少要能知道"这是哪一版"。
   */
  sourceVersion: string;
}

/** 一条可核对的**文档**出处。除 `quote` 外全部字段由服务端从证据池填充，模型无法伪造。 */
export interface DocumentCitation extends CitationBase {
  sourceType: 'document';
  documentId: string;
  documentTitle: string;
  material: Material;
  /** PDF 页码；Word / 纯文本为 null */
  page: number | null;
  sectionPath: readonly string[];
  /**
   * 被引用的检索块 id。
   * 前端拿它去 /chunk/:chunkId 打开原文那一页 —— 这是"引用能回到原文"的落点。
   */
  chunkId: string;
  /** 该块在检索时的得分。量纲随模式变化，只用于同一次结果内排序 */
  score: number;
  matchedBy?: readonly MatchSource[];
  /**
   * 模型从该证据原文里**逐字摘录**、并由服务端核对为原文子串的那一段（O2）。
   *
   * 【为什么它可以由模型提供，而 `excerpt` 不行】`excerpt` 是展示给用户核对的
   *   完整块原文，模型如果能把一段自造的"摘录"放进去，用户核对时看到的就是模型
   *   编的话。这个字段在落到客户端之前会过 `citations.ts` 的逐字比对：不是原文
   *   子串的引用已经被整条剔除，所以能出现在这里的，一定是原文里真实存在的字。
   *   它只用于高亮/悬浮卡里的"支撑句"，不能替代完整原文。
   */
  quote?: string;
}

/**
 * 一条可核对的**实时记录**出处（投稿台账 / 数据集）。
 *
 * 【为什么 `queryTime` 是必填而不是可选】
 *   02 号 §2.3 的硬约束 4：实时查询必须带查询时点，否则用户无法判断新鲜度。
 *   「这条稿子在外审」这句话，是三天前查的还是刚才查的，含义完全不同 ——
 *   而台账记录本身也有一个 `updatedAt`（"这条记录多久没动过"），两个时间
 *   必须都在，缺一个就答不了"新不新"。所以两个字段都必填，
 *   `recordUpdatedAt` 允许为 null（有的记录没有这个概念），`queryTime` 不允许。
 */
export interface RecordCitation extends CitationBase {
  sourceType: 'record';
  recordType: RecordType;
  recordId: string;
  /** 展示用的标题（投稿标题 / 数据集名）。台账类来源没有"文档标题" */
  recordTitle: string;
  /** **查这条记录的时刻**（ISO）。实时查询必带 */
  queryTime: string;
  /** 这条记录自身的更新时间；null = 该记录没有"更新时间"这个概念 */
  recordUpdatedAt: string | null;
  /**
   * 适用版本（02 号 §2.3 硬约束 3：`M-RULE` / `M-JOURNAL` 引用必须带 version）。
   *
   * 台账 / 数据集两类来源没有版本概念，所以它是可选的；
   * `M-JOURNAL` **必然带**（形如「2025 中科院」）—— 分区每年都变，
   * 一条不带年份的分区过一年就是错的，而且错得看不出来：
   * 用户没法分辨"这是一年前的答案"还是"这是今年的答案"。
   */
  version?: string;
  /** 结论字段，逐条给人核对用 */
  fields: readonly CitationField[];
}

export type Citation = DocumentCitation | RecordCitation;

/**
 * Claim（可核查的最小事实单元）的判定结果。
 *
 * 【四个值分别是什么意思，别混用】
 *   · supported —— 规则层找到了**可回读的原文片段**，且关键数值/范围表述都能对上；
 *   · contradicted —— 找到了同指标的原文，但数值/方向与结论不一致（确定性冲突）；
 *   · insufficient —— 没引用、引用回读不到、或关键数值在原文里根本不存在；
 *   · review_required —— 语义上可能成立，但规则层无法确认（例如换了说法、含全称/否定表述）。
 *
 * `review_required` **不是通过**。把它显示成绿色或当成 supported，正是本系统要避免的
 * "编号合法但结论没被证实"。
 */
export const CLAIM_VERDICTS = ['supported', 'contradicted', 'insufficient', 'review_required'] as const;
export type ClaimVerdict = (typeof CLAIM_VERDICTS)[number];

export const CLAIM_VERDICT_LABELS: Record<ClaimVerdict, string> = {
  supported: '有原文支持',
  contradicted: '与原文矛盾',
  insufficient: '依据不足',
  review_required: '待核对',
};

/** 一条 Claim 在证据原文里的定位。start/end 是证据文本的字符偏移（end 不含）。 */
export interface ClaimEvidenceSpan {
  evidenceId: string;
  start: number;
  end: number;
  /** 命中的原文片段，供界面快速核对；完整原文由引用卡片给出 */
  quote: string;
}

/** 一条 Claim 的校验结果。 */
export interface ClaimCheck {
  claimId: string;
  /** 模型写的原句（含 `[En]` 标记）；界面用它告诉用户"是哪一句没过" */
  text: string;
  /** 这句话引用的证据号（只含**真实存在**的；假编号已由 verifyAnswer 剔除） */
  evidenceIds: readonly string[];
  /** 规则层在证据原文里找到的定位；为空 = 没找到相关原文 */
  spans: readonly ClaimEvidenceSpan[];
  verdict: ClaimVerdict;
  /**
   * 谁做的判定。本轮只有 `rule`：确定性规则层。
   * 模型 Judge 未启用（没有校准集，不能把未校准的模型判断当证据）。
   */
  reviewer: 'rule' | 'model' | 'human';
  reasons: readonly string[];
}

export type ClaimVerificationStatus = 'verified' | 'partial' | 'unverified' | 'not_checked';

/** 一次回答的 Claim 级校验总账。 */
export interface ClaimVerification {
  status: ClaimVerificationStatus;
  claims: readonly ClaimCheck[];
  counts: Record<ClaimVerdict, number>;
}

/** 一次回答的交付状态。`interrupted` = 超时/中止，不能冒充正常完成。 */
export type AskDeliveryStatus = 'verified' | 'partial' | 'interrupted';

export interface AskDelivery {
  status: AskDeliveryStatus;
  /**
   * 诊断口径的停止原因（`completed` / `rounds` / `tokens` / `wall` /
   * `client_aborted` …）。与 `Answer` 的业务结果分开，见 budget.ts。
   */
  stopReason: string;
  /** 停止时证据池里已有多少条 —— 中断时用户至少知道"查到了多少" */
  evidenceCount: number;
  /** 本次运行渲染给模型的证据字符数（C1/X2a 上下文预算） */
  contextChars: number;
  /** 可续跑任务 id（S7/X1b）。匿名/评测运行没有任务，为空。 */
  taskId?: string;
  /** 当前是否可显式续跑（只有 interrupted/partial 且有有效检查点为 true）。 */
  resumeAvailable?: boolean;
  verifiedClaimIds: readonly string[];
  unverifiedClaimIds: readonly string[];
}

/** 没有可校验内容时的空总账（超时 / 模型错误 / 中止路径用）。 */
export function emptyClaimVerification(
  status: ClaimVerificationStatus = 'not_checked',
): ClaimVerification {
  return {
    status,
    claims: [],
    counts: { supported: 0, contradicted: 0, insufficient: 0, review_required: 0 },
  };
}

/**
 * 引用片段校验的计数（O2）。
 *
 * 【为什么只记计数、不记模型原话】校验失败说明模型偏离了约定，需要让用户
 *   知道"这次回答里有一条引用因摘录不符被剔除"；但模型写的那句假摘录本身
 *   不是可信内容，落进响应或日志只会制造第二份需要判断真假的文本。
 *   `checked` 只统计**需要摘录的文档引用**；台账/数据集/分区记录只核对编号。
 */
export interface QuoteCheckSummary {
  checked: number;
  passed: number;
  failed: number;
}

/**
 * 一次问答的完整结果。
 *
 * 注意 `limits` / `confidenceNotes` / `evidenceGaps` 三个字段与设计文档 §2.3 对齐：
 * 它们不能塞进 `answer` 正文里当一句话 —— 正文字段是可以被模型自由发挥的，
 * 而这几个字段要参与确定性校验（比如"说了没找到依据就不能给结论性断言"）。
 */
export interface Answer {
  /** 正文，含 `[E1]` 引用标记。无效标记已被服务端剔除 */
  answer: string;
  citations: readonly Citation[];
  /** 明确列出"哪些问题没找到依据"。空数组 = 本次问题都有出处 */
  evidenceGaps: readonly string[];
  /** 本次回答的边界（例如"模型未按结构化格式输出"） */
  limits: readonly string[];
  /** 需要用户注意的不确定性说明 */
  confidenceNotes: readonly string[];
  /** 不同来源之间互相矛盾之处。无矛盾时为空 */
  conflicts: readonly string[];
  /**
   * Claim→Evidence 的逐句校验结果（V1/V2）。
   *
   * 【为什么放在 `Answer` 而不是只写日志】用户必须能看出"哪一句只是编号合法、
   *   但规则层没能确认它真被原文支持"。只记在服务端，界面就会把一段
   *   有 `[E1]` 的回答当成"每句都有出处"。
   */
  verification: ClaimVerification;
  /**
   * 服务端在校验中发现问题时的说明。
   * 为什么必须返回而不是只写日志：这些都是"模型的行为偏离了约定"，
   * 静默吞掉就等于把一次可能有问题的回答伪装成正常回答。
   */
  warnings: readonly string[];
  /**
   * 引用片段校验的计数（O2）。省略 = 本次走的是自由文本回落路径，
   * 没有模型提供的摘录可校验（不能把它当成"全部通过"）。
   */
  quoteChecks?: QuoteCheckSummary;
  usage: RunUsage;
  /**
   * 实际执行的**查询**次数：检索 + 查台账 + 查数据集 + 查分区
   * （不含提交答案这类不查库的动作）。
   */
  rounds: number;
  durationMs: number;
}

/**
 * 一次运行的用量。
 *
 * `cacheReadTokens` / `cacheWriteTokens` 必须分开记：缓存命中的 token
 * 单价只有正常输入的一小部分，合并进 inputTokens 会严重高估成本，
 * 进而让"要不要加检索轮次"这类决策建立在错误的数字上。
 */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/**
 * 会话内的一轮问答（O3）。
 *
 * 【为什么只有问题与结论，没有引用与原文】
 *   追问改写需要知道"它/那件事"指什么，但不需要原文 —— 结论里已经带着主语。
 *   把证据摘录一起带上去，等于把未发表原文复制到下一次请求里，而它并不帮助消解指代。
 *
 * 【为什么由客户端携带】
 *   多轮历史只放内存、刷新即清空（用户拍板）。服务端不建会话表，因此每一轮
 *   由客户端把最近几轮带上来；服务端只负责封顶与使用，不负责留存。
 */
export const ASK_HISTORY_LIMIT = 10;
export const ASK_HISTORY_QUESTION_CHARS = 300;
export const ASK_HISTORY_ANSWER_CHARS = 1200;

export interface AskHistoryTurn {
  question: string;
  answer: string;
}

/** 一次追问改写的结果（O3）。进入运行记录，便于复盘"它到底拿什么去检索"。 */
export interface FollowUpRewrite {
  /** 用户本轮实际问的话 */
  original: string;
  /** 结合历史改写出的独立问题 */
  rewritten: string;
  /** 改写结果与原文是否有实质差异（规范化后比较） */
  changed: boolean;
  /** 这次轻量模型调用的耗时 */
  ms: number;
}

export interface AskRequest {
  question: string;
  /**
   * 用户已勾选「我知道提问内容会发往云端模型」。
   *
   * 为什么这必须是**请求体里的必填字段**，而不是界面上禁用一个按钮就行：
   * 界面禁用只挡得住走界面的那条路。约束 4 要求的是"确认后才可提交"，
   * 那么接口层就必须自己拦一次 —— 否则脚本、curl、将来的第三方客户端
   * 都能绕过勾选把内容发出去，而这个勾选框的全部意义就是"发之前他知情"。
   */
  consentConfirmed: boolean;
  /** 限定材料类型；省略则全库检索 */
  material?: Material;
  /** 强制检索模式；省略则由模型自己决定（默认混合） */
  mode?: SearchMode;
  /**
   * 本会话最近几轮的问答（O3）。省略 = 首轮提问。
   *
   * 服务端只取最近的 ASK_HISTORY_LIMIT 轮，并限制单轮文本长度。
   */
  history?: readonly AskHistoryTurn[];
}

/**
 * 回答下方的「下一步」出口（O16）。
 *
 * 【为什么由服务端给、而不是模型生成】按钮上写什么、点去哪里必须是确定的：
 *   模型自由生成会把"去登记投稿"变成一句它可能理解错的建议，甚至给出站外链接。
 *   这里只允许四种 `kind`，`to` 只能是站内路径；服务端按**工具结果 + 引用**
 *   判定，前端只负责渲染。
 */
export type AskNextActionKind =
  | 'register-submission'
  | 'add-journal'
  | 'register-dataset'
  | 'check-patents'
  | 'check-theses'
  | 'retry-query'
  | 'upload-document';

export interface AskNextAction {
  kind: AskNextActionKind;
  /** 按钮文字。由服务端给常量，模型不能改写。 */
  label: string;
  /** 站内路径，必须以 `/` 开头。 */
  to: string;
  /** 为什么给这个出口（"台账里没有匹配的记录"），写在按钮下方。 */
  hint: string;
}

export interface AskResponse {
  /** Optional attempt-local process data. Older stored answers omit it. */
  process?: AskProcessV1;
  /** 本次运行的 id，与日志里的 run_id 一致，便于用户报障时定位 */
  runId: string;
  question: string;
  answer: Answer;
  /**
   * 这次回答的交付状态。
   *
   * 【它与 `outcome` 是两回事】`outcome` 说的是"运行有没有结束"，
   * 这里说的是"交付出去的结论可信到什么程度"：
   *   · verified   —— Claim 全部通过规则校验；
   *   · partial    —— 运行结束了，但有结论未通过/待核对；
   *   · interrupted —— 超时或中止，不能冒充正常完成。
   * SSE 的终态事件按这一位选择 `verified_final` / `partial` / `interrupted`。
   */
  delivery: AskDelivery;
  /**
   * 本次是追问时的改写结果（O3）。首轮提问不出现。
   *
   * 它不是"检索词"本身，而是**模型给出的独立问题表述**；用户可在回答旁看到
   * 系统究竟把"那它呢"理解成了什么，从而判断答非所问是不是从这一步开始的。
   */
  followUpRewrite?: FollowUpRewrite;
  /**
   * 确定性「下一步」（O16）。省略 = 没有可给的出口。
   *
   * 只在确定性信号成立时出现：某次记录查询返回 0 条，或整次回答没有任何引用
   * 且明确列出了依据缺口。不是"模型觉得应该建议什么"。
   */
  nextActions?: readonly AskNextAction[];
}

/**
 * 流式问答（单元 ③）推给前端的事件。`POST /api/v1/ask/stream` 的 SSE `event:` 名与这里的
 * `type` 一一对应。
 *
 * 【2026-10-17（V1/V2）起的核心区分：草稿不是终稿】
 *   `draft_delta` 是模型边写边吐出来的**草稿**。它可能包含稍后被服务端剔除的
 *   幻觉引用，也可能包含规则层判定为"依据不足/矛盾"的结论。所以：
 *     · 前端在草稿阶段只能显示为纯文本（`[E1]` 不得变成可点链接）；
 *     · **只有** `verified_final` 才能被当成"已校验的最终回答"；
 *     · 有未通过/待核对的结论时，终态是 `partial`，不是 `verified_final`；
 *     · 超时是 `interrupted`，不是正常完成。
 *
 * 【为什么终稿仍然带完整 `Answer`，而不是"delta 拼起来就是答案"】
 *   引用列表、依据缺口、limits、warnings、Claim 校验总账全是**服务端在模型
 *   输出之后**才算出来的 —— 正文流完了，校验还没跑。
 */
export interface AskStatusEvent {
  /** Additive observation carried on the existing status event. */
  process?: AskProcessEventV1;
  type: 'status';
  message: string;
  /** New servers send explicit step boundaries; older clients can ignore these fields. */
  stepId?: string;
  state?: 'start' | 'end';
  atMs?: number;
  durationMs?: number;
  phase?: 'retrieval' | 'generation' | 'quote_repair' | 'verification' | 'understanding';
}

export type AskStreamEvent =
  /** 阶段说明，例如「正在检索资料…」。用于让用户知道系统还活着 */
  | AskStatusEvent
  /** 证据池又多了几条。`total` 是累计条数，不是本次新增 */
  | { type: 'evidence'; added: number; total: number }
  /** 草稿正文增量。**只追加、不回头改**，且**不得**当最终答案渲染 */
  | { type: 'draft_delta'; text: string }
  /** 提交前校验要求模型重写时，丢弃已流出的上一版草稿。 */
  | { type: 'draft_reset' }
  /** 终稿：所有事实性 Claim 都通过了规则校验 */
  | { type: 'verified_final'; response: AskResponse }
  /** 终稿：运行结束了，但存在未通过校验/待核对的结论（不是"已验证"） */
  | { type: 'partial'; response: AskResponse }
  /** 中断：超时，未完成；`delivery.evidenceCount` 告诉你已经查到了多少 */
  | { type: 'interrupted'; response: AskResponse }
  /**
   * 失败收尾，带标准错误体。
   *
   * 为什么失败也要走一条 SSE 事件，而不是直接断掉连接：连接断了，前端只知道"没了"，
   * 分不清是模型报错、超时、还是网线被拔。**先把 `failed` 发出去再关连接**，
   * 前端才能把真正的原因显示给人看。
   */
  | { type: 'failed'; error: ApiErrorBody };

/**
 * 一次问答的结束方式。
 *
 * 为什么要区分这么细，而不是"成功/失败"两档：
 *   「问了但模型报错」和「问了但超时」在排查时是完全不同的两件事 ——
 *   前者多半是上游限流或上下文超长，后者多半是问题太宽泛导致轮次打满。
 *   只记一个"失败"，这两类就会被混成同一个数字，谁也解释不了。
 *
 * `aborted` 单独一档的理由相同：它是**用户自己关掉了页面或点了停止**，
 * 既不是模型出错、也不是我们的时限到了。把它混进 `timeout` 会让
 * "超时率"这个指标虚高，进而让人去优化一个并不存在的问题。
 */
export const ASK_OUTCOMES = ['ok', 'timeout', 'model_error', 'exception', 'aborted'] as const;
export type AskOutcome = (typeof ASK_OUTCOMES)[number];

/**
 * 入库存档的一次问答。
 *
 * 【只存元数据，不存回答正文，不存引用快照】
 * 这个取舍是被两条约束夹出来的：
 *   · 存它的理由：约束 4 要求"提问时告知并勾选确认"，设计文档 04 §7.3 要求
 *     这个确认可追溯。没有一行记录，勾选就只是前端动画，出事时无法证明他勾过。
 *   · 不存正文的理由：01 号文档 §6.2 要求未发表内容不进入长期留存载体。
 *     回答正文和引用摘录都是从文档里摘出来的原文，存下来等于把未发表内容
 *     复制到一个新地方；而"能不能证明他勾过确认"根本不需要正文。
 *
 * 等到阶段 4 有了登录，这张表会被重新当作「我的提问历史」来设计，
 * 那时再决定要不要存正文、以及按什么权限读 —— 现在不预先设计。
 */
export interface AskRecord {
  /** 与 AskResponse.runId 一致 */
  runId: string;
  /** 问题原文。**不脱敏**（用户明确选择：脱敏会连关键信息一起抹掉，失去追溯价值） */
  question: string;
  askedAt: string;
  consentConfirmed: boolean;
  outcome: AskOutcome;
  /** 运行结果之外的交付校验状态；旧记录没有此值。 */
  deliveryStatus: 'verified' | 'partial' | 'interrupted' | 'failed' | null;
  citationCount: number;
  gapCount: number;
  rounds: number;
  durationMs: number;
  usage: RunUsage;
  /** 服务端在本次问答中记录的警告。与 Answer.warnings 同源 */
  warnings: readonly string[];
}

export interface AskRecordSource {
  type: 'document' | RecordType;
  id: string;
  title: string;
}

export interface AskHistoryRecord extends AskRecord {
  /** 简短答案预览，仅提问者可读。旧记录可能没有。 */
  answerPreview: string | null;
  /** 回答实际引用的来源。null 表示该次运行没有来源追踪记录。 */
  sources: readonly AskRecordSource[] | null;
  otherSources: readonly AskRecordSource[];
}

export interface ListAskRecordsResponse {
  items: readonly AskHistoryRecord[];
  hasMore: boolean;
}

export type AskReviewVerdict = 'supported' | 'insufficient' | 'contradicted';

export interface AskEvidenceReview {
  claims: readonly {
    statement: string;
    verdict: AskReviewVerdict;
    reason: string;
    evidence: readonly { citationId: string; quote: string }[];
  }[];
  costUsd: number | null;
  unavailableSourceCount: number;
}

/**
 * 单次问答最多允许的**查询**次数（检索 + 查台账 + 查数据集 + 查分区
 * 四类合起来算）。
 *
 * 为什么必须有：Agent 循环的失控形态是"反复换关键词去查"，
 * 每一轮都是一次完整的模型调用 + 一次实际的取数，烧的是钱和时间。
 * 到上限后不是让整次问答失败，而是**封掉查询工具、逼模型用手上的证据作答**
 * —— 已经拿到的证据往往足够回答，直接失败等于把前面的钱白花了。
 *
 * 各类合并计数而不是各给一个上限：它们对系统是同一种压力，
 * 分开计数会让"检索 12 次 + 台账 12 次"绕过上限。
 */
export const ASK_MAX_TOOL_ROUNDS = 12;

/** 单次问答的墙钟上限。超过就中止并如实告知，不再无限等下去。 */
export const ASK_MAX_WALL_MS = 5 * 60 * 1000;

/**
 * 单次问答**所有工具调用尝试**的上限（含提交答案、含被拦下的那些）。
 *
 * 【它与 `ASK_MAX_TOOL_ROUNDS` 数的是两样东西】轮次数的是"成功查了几次库"，
 *   这一维数的是"模型一共伸了几次手"。正常问答里两者只差几次，它拦的是那种
 *   病态形态：模型反复调用被拦下的工具、或反复重试同一个调用 ——
 *   此时轮次计数**不再增长**（都在 `beforeToolCall` 里被拦掉了），
 *   只有这个总量还在涨，它是最后一道兜底。
 *
 * 取值 15 来自约束 5（"轮次 12 / 工具 15 / token 200k / 5 分钟"）。
 * **注意它不作为"拦下工具"的理由**：提交答案一旦被拦，整次问答就变成没有任何
 * 答案，而设计要的是"停止，交付已完成的部分"。所以它只在**循环收尾**时生效。
 */
export const ASK_MAX_TOOL_CALLS = 15;

/**
 * 单次问答累计 Token 上限（输入 + 输出 + 缓存读 + 缓存写）。
 *
 * 【为什么这一维曾经是缺的，而它恰恰最该有】轮次与时间都拦不住"每次调用都很贵"
 *   的情形：12 次调用、每次塞进去几万 token，5 分钟之内完全跑得完，但账单是
 *   正常问答的几十倍。约束 5 早写明 `token 200k` 是硬上限，但此前全仓**只记录、
 *   从不比较**—— 也就是说那条约束在代码里从未生效过。
 *
 * 200k 对本项目是安全的：`deepseek-flash` 的上下文窗口是 100 万 token，
 *   正常问答的累计用量远低于此，它不会误伤（见约束 5 的注）。
 */
export const ASK_MAX_TOKENS = 200_000;

/**
 * 正文里的证据标记，形如 `[E1]` / `[E12]`。
 *
 * 只认大写 E 加数字。小写 `[e1]` 不认，是因为"认宽一点更宽容"在这里恰恰是错的：
 * 宽容地接受一个模型随手写的括号编号，就等于放宽了引用校验这道闸门。
 *
 * 每次都新建正则而不是共享一个带 /g 的常量：带 /g 的正则在 `test`/`exec`
 * 之间会保留 lastIndex，共享它会造成"同一个函数第一次调用对、第二次调用错"
 * 这种极难复现的 bug。
 *
 * 对外导出：前端要把正文里的标记渲染成可点的链接，必须用**同一个**标记定义。
 * 前端自己再写一份正则，两边早晚会因为"有人放宽了这里、忘了那里"而对不上 ——
 * 而那正是引用校验这道闸门失守的方式。
 */
export function evidenceMarker(): RegExp {
  return /\[E(\d+)\]/gu;
}

/**
 * 该标记在正文里出现的所有证据号，去重且保持首次出现的顺序。
 * 顺序有意义：它决定引用卡片在界面上的排列顺序（按正文提到的先后）。
 */
export function extractEvidenceIds(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(evidenceMarker())) {
    const digits = match[1];
    if (digits === undefined) continue;
    const id = `E${digits}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 把正文里指向不存在证据的标记删掉，返回新正文与被删掉的编号。
 *
 * 为什么不把这种标记改成"引用可疑"之类的提示文字留在正文里：
 * 正文是给用户读的结论，里面混进服务端的批注会让人分不清哪句是模型的结论、
 * 哪句是系统的提醒。删掉标记、把说明放进 `warnings` 字段，两边都干净。
 */
export function removeEvidenceMarkers(
  text: string,
  drop: ReadonlySet<string>,
): { text: string; removed: string[] } {
  if (drop.size === 0) return { text, removed: [] };
  const removed: string[] = [];
  const next = text.replace(evidenceMarker(), (whole, digits: string) => {
    const id = `E${digits}`;
    if (!drop.has(id)) return whole;
    if (!removed.includes(id)) removed.push(id);
    return '';
  });
  return { text: next, removed };
}
