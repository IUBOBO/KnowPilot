/**
 * 知识沉淀（阶段 5，需求 9）。前后端共用。
 *
 * 【这个模块要解决的核心矛盾】用户写的是一句白话，进索引的必须是一条能检索的
 *   **结构化**知识。中间那一步（白话 → 草案）由模型完成，但模型会出错、会编 ——
 *   所以草案**绝不直接进索引**，而是先落成 `proposed` 草案，由人确认后才物化成
 *   一份真正的 `documents`。这条"人确认"的闸门是本模块存在的全部理由，
 *   也是安全用例 GC-12（未确认的知识检索不到）的落点。
 *
 * 【两个正交的"状态"，不要混】
 *   · `KnowledgeStatus`（本文件）：这条**知识**在人机流程里的位置
 *     （待确认 / 已生效 / 冲突待裁决 / 已被取代 / 已驳回）。
 *   · `DocumentStatus`（documents.ts）：那份**文件**的解析流水线位置
 *     （已上传 / 已就绪 / 解析失败）。
 *   确认一条知识之后，它在 documents 里是 `ready`、在 knowledge_entries 里是
 *   `active` —— 同一件事的两个视角。硬凑成一个词表会出现"这份文档的状态是
 *   proposed"这种没有意义的取值，所以刻意不复用 DOCUMENT_STATUSES。
 */

/**
 * 知识条目的类型。**按 04 号 §数据模型的四类，不自行增删**。
 *
 * 四类覆盖的是研究组日常真正会沉淀下来的东西：
 *   fact      —— 事实（"本组服务器 8 卡 A100"）
 *   decision  —— 决定（"投稿一律走盲审模板"）
 *   lesson    —— 教训（"上次引用没核对卷号被退稿"）
 *   open_loop —— 未决事项（"这个数据集的分割比例还没定"）
 */
export const KNOWLEDGE_KINDS = ['fact', 'decision', 'lesson', 'open_loop'] as const;

export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KNOWLEDGE_KIND_LABELS: Record<KnowledgeKind, string> = {
  fact: '事实',
  decision: '决定',
  lesson: '教训',
  open_loop: '未决事项',
};

/**
 * 知识条目的状态机。
 *
 *   proposed   —— 刚由模型拟出，尚未确认。**检索不到**（GC-12）。
 *   active     —— 已确认并进了索引，检索得到。
 *   conflicted —— 确认时被判为与已有生效知识冲突，挂起等人工裁决。
 *   superseded —— 曾被取代（裁决选了"取代已有"时，旧的这条落此态）。
 *   withdrawn  —— 已生效的条目被作者（或审核者）主动撤回，内容已从索引撤下。
 *   deleted    —— 被驳回。**终态，但保留行**：驳回留痕是唯一记录
 *                 "这条被谁驳回过"的地方，物理删行会抹掉它。
 *
 * 【为什么 withdrawn 必须自己占一档，不复用 superseded / deleted】
 *   撤回既没有"接替它的新条"（叫不了"已被取代"），也不是谁把它驳回了
 *   （叫不了"已驳回"）。复用任何一个，界面上都会写一句与事实不符的状态 ——
 *   而这两个状态正是用户拿来判断"这东西还能不能回来"的依据。
 *   （规格 04 原本只写了五态，这一档是阶段 5 欠账收口时经用户确认后补的。）
 */
export const KNOWLEDGE_STATUSES = [
  'proposed',
  'active',
  'conflicted',
  'superseded',
  'withdrawn',
  'deleted',
] as const;

export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const KNOWLEDGE_STATUS_LABELS: Record<KnowledgeStatus, string> = {
  proposed: '待确认',
  active: '已生效',
  conflicted: '冲突待裁决',
  superseded: '已被取代',
  withdrawn: '已撤回',
  deleted: '已驳回',
};

/**
 * 终态：流程到此为止，不会再变。
 *
 * 【withdrawn / superseded / deleted 三者的共同点】都已从索引里撤下，
 *   都不再参与冲突检测（`activeKnowledgeVectors` 只取 `status='active'`）。
 *   区别只在"怎么走到这里的"，见上面状态机的说明。
 */
export const KNOWLEDGE_TERMINAL_STATUSES = ['superseded', 'withdrawn', 'deleted'] as const;

export function isKnowledgeTerminal(status: KnowledgeStatus): boolean {
  return (KNOWLEDGE_TERMINAL_STATUSES as readonly KnowledgeStatus[]).includes(status);
}

/**
 * 可"重新提交"的状态：**已驳回**（`deleted`）与**已撤回**（`withdrawn`）。
 *
 * 【为什么只有这两种】它们是"这条知识没能留下，且不是被别人取代的"的两种死法。
 *   用户把白话打磨一遍再提一次，是最自然的补救动作 —— 没有这条路径，他只能
 *   把原文重打一遍（原行按 GC-12 的取舍还留着，但界面上没法接着用）。
 *   `superseded` 不给重提：它已经**有**接替者了，再提一条是重复。
 */
export const KNOWLEDGE_RESUBMITTABLE_STATUSES = ['deleted', 'withdrawn'] as const;

export function isKnowledgeResubmittable(status: KnowledgeStatus): boolean {
  return (KNOWLEDGE_RESUBMITTABLE_STATUSES as readonly KnowledgeStatus[]).includes(status);
}

/**
 * 知识条目的持久化来源大类。旧白话草稿仍可能为 conversation。
 * 新条目的具体来源、快照版本及核验情况见 draftSource。
 */
export const KNOWLEDGE_SOURCE_TYPES = ['conversation', 'upload', 'manual', 'note'] as const;

export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

/** 冲突检测的结论。落进 `note.conflict`，也直接投影成界面上的 `neighbor`。 */
export interface KnowledgeConflict {
  /** 与最近邻的余弦相似度（0–1，越大越像）。 */
  score: number;
  /** 判定阈值。一并带上，界面才能说清"为什么这条被拦住了"。 */
  threshold: number;
  /** 算出这个向量的模型标识（如 bge-m3-q8）。跨模型不可比，必须记。 */
  model: string;
  /** 被撞上的那条已生效知识。裁决时的操作对象就是它。 */
  neighborEntryId: string;
  /** 对方 doc id；对方若已被撤索引则为 null（历史遗留）。 */
  neighborDocumentId: string | null;
  /** 对方正文的短摘录（~120 字），供人快速判断"是不是真撞了"。 */
  neighborExcerpt: string;
}

/** 裁决结果。落进 `note.resolution`。 */
export interface KnowledgeResolutionRecord {
  kind: KnowledgeResolution;
  /** 裁决人 id。 */
  by: string;
  /** ISO 8601。 */
  at: string;
  /** `supersede` 时被取代的那条知识 id。 */
  supersededEntryId?: string;
}

/**
 * 撤回结果。落进 `note.withdrawn`。
 *
 * 【为什么不复用 `KnowledgeResolutionRecord`】后者的 `kind` 取自
 *   `KNOWLEDGE_RESOLUTIONS`（admit / supersede / reject），那是 **resolve 接口
 *   的请求词表** —— 把 `withdrawn` 塞进去，等于对外宣布"撤回是一种可提交的
 *   裁决动作"，而它根本不是（撤回由条目作者自己发起，不需要裁决任何人）。
 *   是一条独立的留痕，就给一个独立的形状。
 */
export interface KnowledgeWithdrawRecord {
  /** 撤回人 id。 */
  by: string;
  /** ISO 8601。 */
  at: string;
  /** 可选，用户自填的撤回原因。 */
  reason?: string;
}

/**
 * 一行知识条目的落库说明（落进 `note` 列，JSON）。
 *
 * 字段都可能缺：正常确认通过的条目 note 为 null；发生冲突记 `conflict`；
 * 裁决过记 `resolution`；驳回、撤回或"本次没能做冲突检测"记 `reason`；
 * 撤回记 `withdrawn`；重新提交记 `resubmittedFrom`。
 */
/** UTF-16 offsets in the saved note body with line breaks normalized to LF. */
export interface KnowledgeNoteSelection {
  start: number;
  end: number;
}

export type KnowledgeDraftSource =
  | { kind: 'manual'; text: string }
  | { kind: 'ask'; id: string; excerpt: string }
  | { kind: 'note'; id: string; revision: number; selection?: KnowledgeNoteSelection }
  | { kind: 'document'; id: string; version: string; chunkId: string };

export type KnowledgeDraftOrigin = {
  schemaVersion: 1;
  id: string;
  version: string;
  excerpt: string;
  excerptVerification: 'matched' | 'submitted';
  by: string;
  at: string;
} & ({ kind: 'manual' | 'ask' } |
  { kind: 'note'; selection?: KnowledgeNoteSelection } | { kind: 'document'; chunkId: string });

export const KNOWLEDGE_CLAIM_LABELS = {
  experience: '用户经验',
  literature: '资料陈述',
  inference: '问答推断',
  unclassified: '待补充来源依据',
  edited: '作者编辑',
  reviewed_merge: '审核者合并',
} as const;

export interface KnowledgeDraftDetails {
  claim: keyof typeof KNOWLEDGE_CLAIM_LABELS;
  evidence?: string;
  question?: string;
  conclusion?: string;
  conditions?: string;
  tags?: readonly string[];
}

export interface KnowledgeNote {
  lifecycleVersion?: 1;
  lifecycle?: import('./knowledge-discovery.ts').KnowledgeLifecycleReview;
  replacement?: { kind: 'merge' | 'supersede'; entryId: string; by: string; at: string };
  /** Original author revision, retained on a merge and never included in the public index. */
  reviewSubmission?: { revision: number; content: string; details?: KnowledgeDraftDetails };
  draftSource?: KnowledgeDraftOrigin;
  draftDetails?: KnowledgeDraftDetails;
  draftSubmitted?: boolean;
  revision?: number;
  conflict?: KnowledgeConflict;
  resolution?: KnowledgeResolutionRecord;
  withdrawn?: KnowledgeWithdrawRecord;
  /** 本条是"重新提交"出来的：原条目（`deleted` 或 `withdrawn`）的 id。 */
  resubmittedFrom?: string;
  /** 驳回原因 / 撤回原因；或"本次未能做冲突检测"的原因（模型未就绪）。 */
  reason?: string;
}

/**
 * 对外的一条知识条目。
 *
 * 【为什么有 `title` 这个派生字段】条目的展示需要一个短标题，而"标题"若落成
 *   一列，正文改了标题却不跟着变 —— 又多一处会长期不一致的地方。所以标题由
 *   `knowledgeTitle()` 从正文现算：服务端拿它当 `documents.title`，前端拿它当
 *   列表标题，**一处定义、两处一致**。
 */
export interface KnowledgeEntry {
  id: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  /** 结构化后的正文。 */
  content: string;
  /** 由正文派生的短标题（见 `knowledgeTitle`）。 */
  title: string;

  sourceType: KnowledgeSourceType;
  sourceId: string | null;
  sessionId: string | null;
  /** ISO 8601，知识被观察到（草案生成）的时刻。 */
  observedAt: string;
  /** 草案批次号。同一次输入的多条共享它，见迁移 v17 的说明。 */
  groupId: string;

  /** 提交人；历史/脚本造的行可能为 null。 */
  createdById: string | null;
  createdByName: string | null;
  /** 确认人显示名；未确认为 null。 */
  confirmedByName: string | null;
  confirmedAt: string | null;

  /** active 时指向索引里那份文档；否则 null。 */
  documentId: string | null;
  /** 那份文档的第一个块 id，供"查看入库的原文 →"跳转。 */
  firstChunkId: string | null;

  note: KnowledgeNote | null;
  /** `conflicted` 时的最近邻投影（从 `note.conflict` 解出）；其余状态为 null。 */
  neighbor: { entryId: string; excerpt: string; score: number } | null;
}

/** POST /api/v1/knowledge/drafts 的请求体。 */
export type CreateKnowledgeDraftsRequest =
  ({ text: string; source?: never } | { source: KnowledgeDraftSource; text?: never }) & {
    /** 每次生成时均显式授权将所选内容发往模型。 */
    consentConfirmed: boolean;
  };

export interface CreateKnowledgeDraftsResponse {
  /** 本批次号，确认整组时回传它。 */
  groupId: string;
  entries: readonly KnowledgeEntry[];
}

export interface ListKnowledgeEntriesResponse {
  items: readonly KnowledgeEntry[];
}

export interface KnowledgeReviewSource {
  kind: KnowledgeDraftOrigin['kind'];
  verification: 'matched' | 'submitted' | 'unavailable';
  version?: string;
  capturedAt?: string;
  document?: { title: string; locator: import('./search.ts').DocumentEvidenceLocator };
}

/** GET /api/v1/knowledge/review 的响应体。 */
export interface KnowledgeReviewQueueResponse {
  items: readonly KnowledgeEntry[];
  neighbors?: readonly KnowledgeEntry[];
  sources?: Readonly<Record<string, KnowledgeReviewSource>>;
  /** 当前生效的冲突阈值，界面要把它写出来（≥它就会挂起等待裁决）。 */
  threshold: number;
}

/** 确认整组。逐条处理，逐条如实汇报结局。 */
export interface ConfirmKnowledgeGroupRequest {
  /** 二次确认。同上传/提问：接口层自己拦，不靠界面禁用按钮。 */
  consentConfirmed: boolean;
}

export interface ConfirmKnowledgeGroupResponse {
  results: readonly {
    entryId: string;
    /** active=已入库；conflicted=撞上已有知识被挂起；skipped=状态/权限不符，没动。 */
    outcome: 'active' | 'conflicted' | 'skipped';
    /** 一句中文说明，可能是跳过原因或"未做冲突检测"。 */
    message: string;
  }[];
}

/** 驳回单条草案。 */
export interface RejectKnowledgeRequest {
  reason?: string;
}

export interface RejectKnowledgeResponse {
  entry: KnowledgeEntry;
}

/** 撤回一条已生效（`active`）的知识。 */
export interface WithdrawKnowledgeRequest {
  /** 可选，用户自填的撤回原因（落在 `note.withdrawn.reason`）。 */
  reason?: string;
}

export interface WithdrawKnowledgeResponse {
  entry: KnowledgeEntry;
  /**
   * 索引里那份文档是否真的被撤下了。
   *
   * 【为什么这个布尔值必须回传】两份**逐字节相同**的知识会因 `content_hash`
   *   去重而共用同一份 `documents` 行。撤回其中一条时，若另一条还指着它，就
   *   **不能删** —— 否则另一条会跟着"内容凭空搜不到"。界面要据此如实告知：
   *   false 时说明"这条已撤回，但相同内容还被另一条已生效的知识引用"。
   */
  documentRemoved: boolean;
}

/** 重新提交一条已驳回 / 已撤回的知识（产出一条新条目，原行不动）。 */
export interface ResubmitKnowledgeResponse {
  entry: KnowledgeEntry;
}

/**
 * 对 `conflicted` 条目的三种裁决。
 *
 *   admit     —— 允许并存：忽略冲突，直接入库。
 *   supersede —— 取代已有：新条入库，并把撞上的旧条撤下（旧条变 superseded、
 *                旧文档行被删、旧内容从此检索不到）。
 *   reject    —— 驳回本条：新条落 deleted，旧条不动。
 */
export const KNOWLEDGE_RESOLUTIONS = ['admit', 'supersede', 'merge', 'reject'] as const;

export type KnowledgeResolution = (typeof KNOWLEDGE_RESOLUTIONS)[number];

export const KNOWLEDGE_RESOLUTION_LABELS: Record<KnowledgeResolution, string> = {
  admit: '允许并存',
  supersede: '取代已有',
  merge: '合并发布',
  reject: '驳回本条',
};

export interface ResolveKnowledgeRequest {
  resolution: KnowledgeResolution;
  mergedContent?: string;
}

export interface ResolveKnowledgeResponse {
  entry: KnowledgeEntry;
  /** `supersede` 时被取代的旧条 id；其余为 null。 */
  supersededEntryId: string | null;
}

/**
 * 一轮"白话 → 草案"的墙钟上限。比问答/整理都短：它只有**一次**模型调用，
 * 没有任何多轮探查 —— 到点还没出结果，说明上游出了问题，没必要再等。
 */
export const KNOWLEDGE_MAX_WALL_MS = 90 * 1000;

/**
 * 单次输入的白话长度下限（按去空白后的字符数算）。
 *
 * 【为什么要设下限】输入太短（"记一下"、"嗯"）时，模型没有足够信息可整理，
 *   它的选择只有两个：要么什么都不产出（用户白等一次调用），要么**凭空编**一条
 *   看起来像知识的东西。后者更糟 —— 一条编出来的知识可能被确认、进索引，
 *   从此污染检索。所以宁可在入口就挡回去，让它多说一句。
 */
export const KNOWLEDGE_MIN_INPUT_CHARS = 6;

/**
 * 单次输入的白话长度上限。
 *
 * 【为什么要有上限】输入是要整段进模型上下文的。用户如果把一份几十页的文档
 *   粘进来，要么超出上下文直接报错，要么悄悄被截断 —— 而截断后的输入会产出
 *   "只看了一半"的草案，用户却以为它读全了。所以宁可在入口挡回去，让他分批写，
 *   或者干脆走"上传文件"那条路（那才是长文档该走的地方）。
 *   4000 字：一段口述能讲清楚的量级。
 */
export const KNOWLEDGE_MAX_INPUT_CHARS = 4000;


/**
 * 从正文派生一个短标题。
 *
 * 【为什么是纯函数、定义在 shared】服务端要拿它当 `documents.title`、前端要拿它
 *   当列表标题 —— 两处必须完全一致，否则用户会看到"列表里的名字"和"入库文档的
 *   名字"不一样，且没有任何理由。定义一次、两边 import，就把这种漂移消灭在
 *   编译期。
 *
 * 取正文首句（按中英文句读切），规范化空白后截断到 40 字；正文为空时回退到
 * kind 的中文名。截断加省略号，不做"智能摘要"—— 摘要要么准要么添乱，这里只是
 * 给列表一个能认出来的标签。
 */
export function knowledgeTitle(content: string, kind: KnowledgeKind): string {
  const flat = content.replace(/\s+/gu, ' ').trim();
  if (flat === '') return KNOWLEDGE_KIND_LABELS[kind];
  const firstSentence = flat.split(/[。！？!?.;；]/u)[0]?.trim() ?? '';
  const base = firstSentence === '' ? flat : firstSentence;
  return base.length > 40 ? `${base.slice(0, 40)}…` : base;
}
