/**
 * 投稿台账的契约。前后端共用。
 *
 * 【为什么它是结构化数据，而不是一份上传的文档】
 *   台账要回答的是「我投的 X **现在**什么状态」。上传的投稿记录答不了 ——
 *   它记的是上传那一刻的状态，用它回答等于给出一个过时结论，
 *   而用户看不出这个结论是旧的。所以走表单录入 + 实时查询，
 *   这也正是 01 号 §2 把它列为"必须查实时状态"那一类的原因。
 */

/**
 * 稿件状态。
 *
 * 【词表是怎么定的】前四档直接来自约束 3 的巡检阈值
 * （待初审 14 / 外审 60 / 修回后再审 30 / 待上线 90 天）——
 * 那四条是用户按实验室习惯拍的，状态词表若对不上，巡检就无从分档。
 * 另外三档是终态，外加一个「准备中」给还没投出去的稿子。
 *
 * 【为什么用受控词表而不是自由字符串】
 *   它决定巡检怎么分档、界面上怎么排序、时间线怎么画。自由字符串会让
 *   "外审" 和 "under review" 变成两档，而巡检只认其中一档 —— 静默漏检。
 *
 * ⚠️ 数据库里 submissions.status **没有 CHECK 约束**（见迁移 v9 的注释），
 * 所以增删一个档位只改这个文件 + `SUBMISSION_STATUS_LABELS`，不需要迁移。
 * 这也意味着加了新档位后要顺手回看 `isInProgress` 与阶段 6 的巡检分档。
 */
export const SUBMISSION_STATUSES = [
  /** 准备中：已录入但还没投出去，没有投稿时间 */
  'preparing',
  /** 待初审 —— 巡检阈值 14 天 */
  'pending_initial',
  /** 外审 —— 巡检阈值 60 天 */
  'under_review',
  /** 修回后再审 —— 巡检阈值 30 天 */
  'revision_resubmitted',
  /** 已录用、等待上线 —— 巡检阈值 90 天 */
  'accepted_pending',
  /** 已发表（终态） */
  'published',
  /** 已拒稿（终态） */
  'rejected',
  /** 已撤稿（终态） */
  'withdrawn',
] as const;

export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/** 界面上的中文名。 */
export const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  preparing: '准备中',
  pending_initial: '待初审',
  under_review: '外审',
  revision_resubmitted: '修回后再审',
  accepted_pending: '待上线',
  published: '已发表',
  rejected: '已拒稿',
  withdrawn: '已撤稿',
};

/**
 * 终态：稿件在这几档上就已经走完流程了，不会再变成别的状态。
 *
 * 它的用途是**不让巡检去盯它们** —— 一篇三年前发表的论文
 * 会被"距上次更新已 1095 天"永远标红，那种待办只会让人学会忽略待办。
 */
export const TERMINAL_SUBMISSION_STATUSES: readonly SubmissionStatus[] = [
  'published',
  'rejected',
  'withdrawn',
];

export function isTerminalStatus(status: SubmissionStatus): boolean {
  return TERMINAL_SUBMISSION_STATUSES.includes(status);
}

/**
 * 进行中：需要盯着、可能长期不动的那几档。
 *
 * 与 `!isTerminalStatus()` 刻意分开写，因为两者会分叉：
 * 「准备中」不是终态，但它没有投稿时间、也没有期限，
 * 巡检不该盯它。把这条判断留成一个有名字的函数，
 * 将来加档位时才会被看见，而不是散在某个 `if` 里。
 */
export function isInProgressStatus(status: SubmissionStatus): boolean {
  return (
    status === 'pending_initial' ||
    status === 'under_review' ||
    status === 'revision_resubmitted' ||
    status === 'accepted_pending'
  );
}

/**
 * 分区体系的受控词表。
 *
 * 【为什么必须是受控词表，不能自由填】唯一键是 `(journal_id, year, system)`。
 * 自由字符串会让 "中科院" 与 "中科院分区" 被当成两个体系，各存一条 ——
 * 表现为"同一本刊同一年出现了两个 1 区"，而且没有任何报错。
 * 与 `SUBMISSION_STATUSES` 同一条理由：静默分叉比报错难收拾得多。
 *
 * 数据库里 `journal_rankings.system` **没有 CHECK 约束**（见迁移 v9），
 * 所以加第三个体系只改这一个文件，不需要迁移。
 */
export const JOURNAL_SYSTEMS = ['中科院', 'JCR'] as const;

export type JournalSystem = (typeof JOURNAL_SYSTEMS)[number];

/**
 * 分区数据的来源。**它决定这条分区在界面上可不可信**，所以是三档而不是两档。
 *
 * 【为什么不能只看 `verified`】`verified` 记的是"有没有人逐条核对过"。
 *   官方分区表导进来的数据 `verified` 也是 0 —— 没人一条条核过 ——
 *   但它**本身就是权威数据源**，标成"未经核对"是错的，会让人以为它和
 *   网上搜来的一样不靠谱。所以可信度的判断依据是来源，不是核验标记：
 *     · official    权威分区表，照抄，可信
 *     · manual      人手工录入，比搜索可信（人知道自己填的是什么）
 *     · web_search  联网抓的，未核对，必须带免责说明
 */
export const RANKING_SOURCES = ['official', 'manual', 'web_search'] as const;

export type RankingSource = (typeof RANKING_SOURCES)[number];

/** 界面上「这条数据从哪来」的中文名。认不出的来源原样显示，不吞掉。 */
export const RANKING_SOURCE_LABELS: Record<string, string> = {
  official: '官方分区表',
  manual: '人工录入',
  web_search: '网络检索',
};

export function rankingSourceLabel(source: string): string {
  return RANKING_SOURCE_LABELS[source] ?? source;
}

/**
 * 只对联网来源显示的那句免责说明。
 *
 * 【为什么放 shared 而不是服务端的 prompt.ts】提示词里要它、界面上也要它。
 *   同一个判断（"联网数据未经核对"）在两处各写一份中文，早晚会只改一处 ——
 *   到时候模型说"未经核对"、界面却什么都不显示，用户就信了。
 *   前端不可能 import 服务端代码，所以它只能住在 shared。
 */
export const UNVERIFIED_WEB_LABEL = '该分区信息来自网络检索，未经权威数据源核对';

/** 这条来源是否需要在界面上打「未经核对」。 */
export function isUnverifiedSource(source: string): boolean {
  return source === 'web_search';
}

/** 一本期刊。领域与分区都挂在它上面。 */
export interface Journal {
  id: string;
  name: string;
  /** 经人工核对的期刊简称；全称与简称分别展示和搜索。 */
  abbr: string | null;
  issn: string | null;
  field: string | null;
  /** 投稿系统地址或期刊网页。与刊名分开保存，不把网址当刊名。 */
  website: string | null;
}

/**
 * 一条分区记录。
 *
 * `year` 与 `source` **必须跟着分区一起显示**，不能只显示 `rank`：
 *   · 少了年份 → 用户分不清这是今年的还是三年前的，而分区每年都变；
 *   · 少了来源 → 联网抓来、没人核对过的数据会被当成权威答案。
 * 这两条是 04 号 §4「分区表硬约束」和决策 2 在界面上的落点。
 */
export interface JournalRanking {
  /** 行 id。删改要用 —— 一本刊一年一体系一维度只该有一条，但那是四元组，界面按下标定位不稳。 */
  id: string;
  year: number;
  /** 分区体系，如 "中科院" / "JCR" */
  system: string;
  /**
   * 分区维度。中科院是学科名（大类如"计算机科学"，小类如"遥感"），
   * JCR 是 Category。同一本刊同一个体系下**可以有多个维度**，
   * 例如遥感刊的大类分区与小类分区并不相同 —— 所以它必须跟着档位一起显示，
   * 只说"3 区"而不说是哪个维度的 3 区，等于没说。
   */
  category: string;
  /** 档位，如 "1区" / "Q1" */
  rank: string;
  /** 中科院分区表的 Top 期刊标注。 */
  top: boolean;
  /** 档位之外的补充：排名（4/758）、影响因子（IF 20.4）。可空。 */
  note: string | null;
  /** official | manual | web_search */
  source: string;
  /** 有没有人逐条核对过。**不是**可信度的判据 —— 那是 source 的事，见上。 */
  verified: boolean;
  sourceUrl: string | null;
  fetchedAt: string;
}

/** 一本刊连同它**全部年份、全部维度**的分区。期刊分区库页用。 */
export interface JournalDetail extends Journal {
  rankings: readonly JournalRanking[];
}

/** GET /api/v1/journals?q=&limit= 的响应体 */
export interface ListJournalsResponse {
  items: readonly JournalDetail[];
  /** 库里一共收录了多少本刊（不受本次搜索词影响）。 */
  total: number;
  /**
   * **本次搜索词**命中多少本（空关键词时等于 `total`）。
   *
   * 【为什么必须单独给这个数，不能让界面拿 items.length 顶】`items` 被
   *   limit 截断过。界面若只看到"50 本"，它无法区分"库里就这 50 本"
   *   与"还有更多、只是没返回"——前者用户可以放心收工，后者还得加关键词。
   *   把命中的**真实**条数带出来，界面才能说"共命中 137 本，这里显示前 50"。
   */
  matched: number;
}

/** POST /api/v1/journals 的请求体：按刊名 find-or-create。 */
export interface CreateJournalRequest {
  name: string;
  abbr?: string;
  issn?: string;
  field?: string;
  website?: string;
}

export interface CreateJournalResponse {
  journal: Journal;
  /** true = 这次新建的；false = 复用了已有记录。 */
  created: boolean;
}

/**
 * PATCH /api/v1/journals/:id 的请求体：订正一本刊的 ISSN / 领域。
 *
 * 【为什么不复用 POST 那个 find-or-create】那个是"按刊名去重"，它的语义
 *   决定了已有记录只补空、不覆盖（见 `upsertJournal`）。订正恰恰要覆盖 ——
 *   用户是在说"之前那个填错了"。两个意图相反，各走各的接口。
 *
 * 字段缺省 = 不改动它；传空串 = 清空（界面上的"删掉这个值"）。
 * 刊名**不在可改之列**：它是这本书的唯一标识，改了等于换了一本刊，
 *   而分区是挂在 id 上的，改名的动静应该是一次显式的迁移，不是一个文本框。
 */
export interface UpdateJournalRequest {
  abbr?: string;
  issn?: string;
  field?: string;
  website?: string;
}

export interface UpdateJournalResponse {
  journal: Journal;
}

/**
 * PATCH /api/v1/journals/:id/rankings/:rankingId 的请求体：订正一条**人工录入**的分区。
 *
 * 形状与 `AddRankingRequest` 一致（整条替换，不是按字段打补丁）：
 * 分区就四个字段，界面手里本来就有整行，逐字段合并只会多出"传了 null
 * 到底是清空还是不改"这种要解释的输入。
 *
 * 导入与联网来源的分区**改不动**（同删除）：那份数据是权威表的副本，
 * 要订正就改种子重导 —— 让界面能改它，等于让"官方分区"变成可被随手篡改的。
 */
export interface UpdateRankingRequest {
  year: number;
  system: JournalSystem;
  rank: string;
  category?: string;
  top?: boolean;
  note?: string;
  sourceUrl?: string;
}

export interface UpdateRankingResponse {
  ranking: JournalRanking;
}

/**
 * POST /api/v1/journals/:id/rankings 的请求体：人工录入一条分区。
 *
 * 年份必填。分区每年都变，一条不带年份的分区过一年就是错的 ——
 * 而且错得看不出来（用户分不清这是哪年的答案）。
 */
export interface AddRankingRequest {
  year: number;
  system: JournalSystem;
  rank: string;
  /** 分区维度，可空（JCR 单维度时不必填）。 */
  category?: string;
  top?: boolean;
  note?: string;
  sourceUrl?: string;
}

export interface AddRankingResponse {
  ranking: JournalRanking;
}

/** DELETE /api/v1/journals/:id/rankings/:rankingId 的响应体。 */
export interface DeleteRankingResponse {
  deleted: true;
}

/** 一次状态变更。时间线的每一格。 */
export interface SubmissionHistoryEntry {
  id: string;
  /** null = 建档（没有"从哪个状态来"） */
  fromStatus: SubmissionStatus | null;
  toStatus: SubmissionStatus;
  changedAt: string;
  /** 阶段 1–3 无登录，恒为 null。阶段 4 起是当前用户。 */
  changedBy: string | null;
  note: string | null;
}

/** 一行投稿记录。 */
export interface Submission {
  id: string;
  title: string;
  /** 还没填刊名时为 null */
  journal: Journal | null;
  /**
   * 本地分区表里这本刊**最新年份**的一条分区；没收录则为 null。
   *
   * 选"最新年份"而不是"当前年份"：分区一年一更，跨年时最新的那条
   * 仍然是最接近事实的答案，而按"恰好等于今年"筛会在每年 1 月
   * 让所有期刊一起变成"未收录"。具体是哪一年由 `year` 如实带出去。
   *
   * 多个体系（中科院 / JCR）时取哪条：现在只取一条，由服务端定优先级。
   * 阶段 4 的管理端会需要"两个体系都看"，那时再改成数组。
   */
  ranking: JournalRanking | null;
  status: SubmissionStatus;
  /**
   * 旧字段：投稿时间戳（阶段 1–3 的老数据用它，新记录用 `submittedOn`）。
   * 保留是为了不重写历史记录；新界面优先显示 `submittedOn`。
   */
  submittedAt: string | null;
  /** 当前轮次首次提交的日历日期（YYYY-MM-DD）。历史行为 null。 */
  submittedOn: string | null;
  /** 稿件简称；允许为空，与题目一起搜索，但不是唯一标识。 */
  algorithmAbbr: string | null;
  /** 投稿人姓名（原表“负责人”）。人员主档建立前只存文本，不自动匹配账号。 */
  submitterName: string | null;
  submitterPersonId?: string | null;
  /** 进入当前状态的实际日期（YYYY-MM-DD）；未知为 null。 */
  statusSince: string | null;
  /** 当前是第几次投稿（1 起）。 */
  currentRoundNo: number;
  /** 当前轮次的期刊稿件编号；可空。 */
  submissionNumber: string | null;
  /** 全部投稿轮次（按轮次升序）。列表页不多，随单条一起返回。 */
  rounds: readonly SubmissionRound[];
  /** 共享编辑的版本；保存时原样回传，服务端据此检测并发修改。 */
  revision: number;
  updatedAt: string;
  createdAt: string;
  notes: string | null;
  /**
   * 录入者。阶段 1–3 的历史记录（`user_id` 为 NULL）为 null。
   *
   * 【为什么两个字段都给】`submittedById` 是**判据**（这一页要决定
   *   "改状态的那个表单该不该出现在这一行上"），`submittedByName` 是**给人看的**。
   *   只给名字的话前端会去比字符串 —— 而重名是可能的；只给 id 的话
   *   界面就得再查一次用户名。
   *
   * 【NULL 的含义】与 documents 的 `uploadedByName` 同一条口径：
   *   **NULL 是"未记录"，不是"无人"**。界面上要显示成「未记录」，
   *   而不是留白或写成某个人的名字（见服务端 canWriteThisRow：
   *   这些行除管理员外谁都不能改）。
   */
  submittedById: string | null;
  submittedByName: string | null;
  /** 状态时间线，按时间正序（最早的在前，像阅读顺序） */
  history: readonly SubmissionHistoryEntry[];
  edits: readonly import('./record-edits.ts').RecordEdit[];
}

/** GET /api/v1/submissions 的响应体 */
export interface ListSubmissionsResponse {
  items: readonly Submission[];
}

/**
 * POST /api/v1/submissions 的请求体。
 *
 * 期刊只给名字，不给 id —— 台账录入时用户心里想的是"投了 Nature"，
 * 不是"投了 journal_id=xxx"。服务端按刊名 find-or-create，
 * 用户不必先去别的页面把期刊建好再回来。
 */
export interface CreateSubmissionRequest {
  title: string;
  /** 稿件简称（可选）。 */
  algorithmAbbr?: string;
  /** 投稿人姓名（可选；不是系统录入者）。 */
  submitterName?: string;
  submitterPersonId?: string;
  /** 刊名。允许暂缺（先记下来，回头再补）。 */
  journalName?: string;
  /** 领域。只在**新建期刊**时写入；已有期刊不覆盖 —— 见 app.ts 的注释。 */
  journalField?: string;
  status: SubmissionStatus;
  /**
   * 本轮次首次正式提交的日历日期（YYYY-MM-DD）。
   * 与 `submittedAt` 二选一：新界面用日期，旧调用方仍可传 ISO 时间戳。
   */
  submittedOn?: string;
  /** 兼容旧调用方的 ISO 8601 时间戳。 */
  submittedAt?: string;
  /** 进入当前状态的实际日期（YYYY-MM-DD）；不填表示未知。 */
  statusSince?: string;
  /** 当前轮次的期刊稿件编号。 */
  submissionNumber?: string;
  notes?: string;
}

export interface CreateSubmissionResponse {
  submission: Submission;
  /** true = 这本刊是这次新建的；false = 复用了已有记录。界面据此提示。 */
  journalCreated: boolean;
}

/** PATCH /api/v1/submissions/:id：订正稿件与当前轮次资料；状态变更仍走独立接口。 */
export interface UpdateSubmissionRequest {
  expectedRevision: number;
  title?: string;
  algorithmAbbr?: string | null;
  submitterName?: string | null;
  submitterPersonId?: string | null;
  /** null 清空当前轮次期刊；缺省保持不变。 */
  journalName?: string | null;
  /** 只在新建期刊时使用，不覆盖分区库中已有期刊的领域。 */
  journalField?: string | null;
  submittedOn?: string | null;
  statusSince?: string | null;
  submissionNumber?: string | null;
  notes?: string | null;
}

export interface UpdateSubmissionResponse {
  submission: Submission;
  journalCreated: boolean;
}

/** POST /api/v1/submissions/:id/status 的请求体 */
export interface UpdateSubmissionStatusRequest {
  status: SubmissionStatus;
  /** 进入新状态的实际日期（YYYY-MM-DD）；不填表示未知，不自动拿当前时间冒充。 */
  statusSince?: string;
  /** 这次变更的说明（时间线上的一条备注）。 */
  note?: string;
}

export interface UpdateSubmissionStatusResponse {
  submission: Submission;
}

/** 一次投稿轮次：同一篇稿件投向一个期刊的一次行为。 */
export interface SubmissionRound {
  id: string;
  submissionId: string;
  /** 第几次投稿，1 起。 */
  roundNo: number;
  journal: Journal | null;
  submissionNumber: string | null;
  /** 本轮次首次提交日期（YYYY-MM-DD）；历史行可能为 null。 */
  submittedOn: string | null;
  status: SubmissionStatus;
  statusSince: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListSubmissionRoundsResponse {
  items: readonly SubmissionRound[];
}

/** 拒稿后转投另一刊：在**同一篇稿件**上新增一轮，不改历史轮次。 */
export interface CreateSubmissionRoundRequest {
  journalName?: string;
  journalField?: string;
  submittedOn?: string;
  status: SubmissionStatus;
  statusSince?: string;
  submissionNumber?: string;
  notes?: string;
}

export interface CreateSubmissionRoundResponse {
  round: SubmissionRound;
  /** 更新后的稿件视图（当前轮次已切到新建的这一轮）。 */
  submission: Submission;
  journalCreated: boolean;
}
