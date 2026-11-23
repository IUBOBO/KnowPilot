/**
 * 材料（文档）相关的契约。前后端共用。
 *
 * 材料类型为什么是一份受控词表，而不是自由字符串：
 *   它决定这份文档落到哪条检索路径、界面上归到哪个入口。
 *   前端要拿它渲染下拉框，后端要拿它校验入库 —— 双方必须看到同一份清单，
 *   否则会出现"前端能选、后端不认"的静默不一致。
 */

/** 阶段 1 接入的材料类型。投稿台账 / 代码数据集是结构化数据，各有自己的表（阶段 3）。 */
export const MATERIALS = ['paper', 'knowledge', 'experience', 'sop', 'rule'] as const;

export type Material = (typeof MATERIALS)[number];

/** 界面上显示的中文名。 */
export const MATERIAL_LABELS: Record<Material, string> = {
  paper: '论文',
  knowledge: '知识点',
  experience: '经验与解题',
  sop: '流程与技术',
  rule: '实验室制度',
};

/**
 * 文档的处理状态。
 *
 * 上传与解析是两步：上传完只是"原件在手"，还要解析出文本、切块、建索引，
 * 才算能被检索到。中间态必须显式表达出来，否则界面上会出现
 * "文件明明传上去了，却搜不到"且无法解释的情况。
 */
export const DOCUMENT_STATUSES = ['uploaded', 'ready', 'failed'] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * 当前解析/切块流水线的版本号。
 *
 * 【什么时候必须 +1】改动下面任何一处，都要把它 +1：
 *   · `apps/server/src/documents/extract.ts` —— 解析规则（页眉页脚剔除、标题识别）
 *   · `apps/server/src/documents/chunk.ts`   —— 切块策略（块大小、是否跨页、章节路径）
 * 因为这两处一变，**已经入库的块就是按老规则切的**，检索质量与新规则不一致，
 * 而这件事从界面上完全看不出来（搜索照样有结果，只是结果不同）。
 *
 * 【为什么这个常量定义在 shared 而不是服务端】
 *   前端要拿它和每份文档的 `indexVersion` 比大小，才知道该不该显示「需重建」。
 *   放在服务端、让前端通过接口取的话，前端就得先等一次请求才知道"什么算过时"，
 *   而这是个编译期就确定的事实，没有理由走运行时的往返。
 *   前后端同一个仓库同一次构建，不存在两边版本号漂移的可能。
 *
 * 【为什么不做成"自动算出来的哈希"】
 *   试过用源文件内容哈希，但那要求构建期读源码文件，属于把一个构建期的细节
 *   塞进运行时契约；而且哈希值不可读，日志里看到"文档 v8731a2"毫无意义。
 *   人工 +1 需要纪律，但代价是改这两处的人就在同一个 PR 里，忘不掉。
 *
 * ⚠️ 注意：`db/migrations.ts` 里 v7 那条迁移硬编码了 `DEFAULT 1`，
 * 那是"迁移执行时，表里所有行都由当时那版管线建的"这一历史事实的记录，
 * 属于已发布迁移的一部分，**改这里时不要回头改那条迁移**。
 *
 * 【v1 → v2（2026-09-30，接入 OCR）为什么必须 +1，而且是全量标脏】
 *   接 OCR 之前，没有文字层的页在解析阶段是**空的** —— 那些页的内容从来没进过索引。
 *   接入后同一份文件会多出这些页的正文，块、章节路径、向量全都不同。
 *   已经入库的这类文档因此**真的过时了**：不是"切法风格不同"，是**少了内容**，
 *   而界面上完全看不出来（照样有结果，只是查不到扫描的那几页）。
 *
 *   纯文字层的文档这次其实产出完全一样（第一遍取字、段落重排、标题识别都没动，
 *   新增的 null 分支对它们永不触发）。但 INDEX_VERSION 只有一个数字，
 *   没法只标脏一部分 —— 而且"哪些文档含扫描页"这件事，在重建之前无从判断
 *   （要重建就得先解析）。所以这里选**宁可多标**：
 *   多标一次的代价是点了「重建」白跑一趟（几秒），
 *   少标一次的代价是那几页永远搜不到、且没有任何提示。
 */
/** v4：章节边界、句子优先切分、标题层级修正及带语境向量。旧块需重建。 */
export const INDEX_VERSION = 4;

export interface DocumentSummary {
  id: string;
  material: Material;
  /** 文档标题。上传时默认取原始文件名，单元 2 解析后可能被更准确的标题覆盖。 */
  title: string;
  /** 上传时的原始文件名，可能是 null（历史数据） */
  fileName: string | null;
  /** 字节数，可能是 null（历史数据） */
  byteSize: number | null;
  /** 内容的 sha256，同时是去重键 */
  contentHash: string;
  status: DocumentStatus;
  /**
   * 已建索引的块数。界面上要显示它 ——
   * 「状态 ready 但块数是 0」是"传上去了却搜不到"的典型形态，必须让人一眼看见。
   */
  chunkCount: number;
  /**
   * 已建向量的块数（语义检索能覆盖的部分）。
   *
   * 单独列出来而不是与 chunkCount 合并：两个数字不等就是"这份文档关键词搜得到、
   * 语义搜不到"，属于必须让人看见的中间状态，界面上把两者并排显示。
   */
  embeddedChunkCount: number;
  /**
   * 解析/索引的非致命说明，失败时是失败原因。
   * 为什么落库而不是只在响应里返回：上传后用户可能过很久才想起来搜，
   * 那时响应早没了，而"为什么这份文档搜不到"必须仍然答得上来。
   */
  ingestNote: string | null;
  /** ISO 8601 */
  createdAt: string;
  /**
   * 这份文档的第一个检索块 id，没有块时为 null。
   *
   * 存在的唯一理由是给"最近入库"这类列表一个可点的地方 ——
   * 现在没有文档详情页，点进去能看的就是块。跳第一个块等于"打开这份文档的开头"，
   * 而 `/chunk/:chunkId` 页底部带「下载原件」，用户想看全份也从那儿走。
   * 单独列出而不是让前端再请求一次：列表接口本来就要过一遍 documents，
   * 顺带取一个 id 不增加往返。
   */
  firstChunkId: string | null;
  /**
   * 这份文档当前的块是由哪一版流水线切出来的（见 INDEX_VERSION）。
   * 小于 `INDEX_VERSION` 就是「需重建」：块还在、还搜得到，但切法已经过时。
   *
   * 为什么必须在界面上显式写出来：重建可能改变块边界与证据版本。
   * 未变的块沿用 id；变动块进入历史片段，只能用于核对旧引用，
   * 不能再被当前检索或新回答引用。
   */
  indexVersion: number;
  /**
   * 上传者显示名；阶段 1–3 的历史数据（`uploaded_by` 为 NULL）为 null。
   *
   * 【为什么用显示名而不是 id】列表（含右栏「最近入库」）要直接把它渲染出来，
   *   给 id 前端还得再查一次通讯录 —— 而本轮没有任何"按 id 取用户"的接口。
   * 【null 的含义是"没有记录上传者"，不是"匿名上传"】—— 界面上要如实写成
   *   "上传者未记录"，不要显示成"匿名"，那是两个意思。
   */
  uploadedByName: string | null;
  /**
   * 这份文档若不是人直接上传的，而是由**知识沉淀确认后生成**的，这里是那条
   * 知识条目的 id；用户自己上传的材料为 null。
   *
   * 【为什么要这个字段】知识确认入库时会物化成一份 `material='knowledge'` 的
   *   文档，于是它和用户**自己上传**的知识点文档在列表里长得一模一样 ——
   *   同一批数据两种来源，界面上必须能分开（一个能撤回、一个不能；一个的"原件"
   *   是模型整理的正文、一个的"原件"是上传的文件）。
   * 【为什么是必填而不是可选】构造点只有 `documents/repo.ts` 的 `toSummary` 一处，
   *   做成必填让 typecheck 兜住每一处遗漏；历史数据该给 null 就显式给 null。
   */
  knowledgeEntryId: string | null;
}

/** 一次解析 + 切块 + 建索引的结果。 */
export interface IngestReport {
  /** 解析出的文本块数（含标题） */
  blockCount: number;
  /** 识别出的标题数 —— 为 0 说明文档没有可用的章节结构 */
  headingCount: number;
  /** 建索引的块数 */
  chunkCount: number;
  /** 建成向量的块数。小于 chunkCount 时语义检索覆盖不全，界面要说明。 */
  embeddedChunkCount: number;
  /** 被判为页眉页脚而剔除的重复行数 */
  droppedBoilerplate: number;
  /**
   * 本次真正跑了 OCR 的页数（没有扫描页时为 0）。
   *
   * 【为什么要单独报出来】它和 blockCount 一起看才有意义：
   *   全是 0 而块数很少 → 可能是漏了扫描页；
   *   不为 0 → 这份文档的正文有一部分是机器认出来的，出现错字是可预期的。
   * 只报 warnings 不够 —— warnings 会被"剔除的页眉页脚"之类淹没，
   * 而这个数字是「这份文档可信到什么程度」的一个直接指标。
   */
  ocrPageCount: number;
  /** 解析器的非致命提示（如"这份文件没有文字层"） */
  warnings: readonly string[];
}

/** POST /api/v1/documents 的响应体 */
export interface UploadDocumentResponse {
  document: DocumentSummary;
  /**
   * true = 内容与已有文档完全相同，复用了已有记录。
   * 上传是幂等的：同一份文件传两次不会产生两条记录。
   */
  duplicated: boolean;
  /** 本次的解析与索引结果；复用已有且已就绪的文档时为 null */
  ingest: IngestReport | null;
}

/** GET /api/v1/documents 的响应体 */
export interface ListDocumentsResponse {
  items: readonly DocumentSummary[];
}

/**
 * POST /api/v1/documents/:id/reindex 的响应体。
 *
 * 与 UploadDocumentResponse 分开而不是复用它：上传回答的是"这份文件进没进库"
 * （所以有 `duplicated`），重建回答的是"这份已有的文档重切之后变成了什么样"。
 * 硬塞进同一个类型，就会出现一个字段在一半情形下恒为 false 的契约。
 */
export interface ReindexDocumentResponse {
  document: DocumentSummary;
  /** 这一次重建的解析与切块结果，字段与上传时同一套。 */
  ingest: IngestReport;
}

/**
 * 检索模式。
 *
 * · keyword  —— 逐字匹配（FTS5）。专有名词、编号、术语精确命中，不懂同义改写。
 * · semantic —— 向量近邻（BGE-M3）。懂"意思接近"，但对罕见词和编号不敏感。
 * · hybrid   —— 两路都查，用 RRF 融合。默认为它：两条路各自漏掉的东西，
 *               恰好是对方擅长的，融合后明显比任何单一路径稳。
 */
export const SEARCH_MODES = ['keyword', 'semantic', 'hybrid'] as const;

export type SearchMode = (typeof SEARCH_MODES)[number];

export const SEARCH_MODE_LABELS: Record<SearchMode, string> = {
  keyword: '关键词',
  semantic: '语义',
  hybrid: '混合',
};

/** 某个检索块是被哪几路召回的。混合模式下用来解释"为什么它排在这里"。 */
export type MatchSource = 'keyword' | 'semantic';

/** 一个块的原文。问答的引用点进来看到的就是它。 */
export interface ChunkView {
  id: string;
  /** 在本文档内的顺序号，从 0 开始 */
  ordinal: number;
  text: string;
  /** PDF 页码；Word / 纯文本为 null */
  page: number | null;
  sectionPath: readonly string[];
}

/** GET /api/v1/chunks/:chunkId 的响应体 */
export interface ChunkContextResponse {
  /** 仅旧引用回看时出现；历史片段不参与当前检索。 */
  archivedIndexVersion?: number;
  document: {
    id: string;
    title: string;
    material: Material;
    fileName: string | null;
  };
  /** 被引用的那一块 */
  chunk: ChunkView;
  /**
   * 同文档**同页**的块，按 ordinal 升序，含被引块自己。
   *
   * 为什么要带上邻居：只显示被引的那一块时，用户看到的是一个孤立片段，
   * 无法确认"它的上下文是不是这个意思"——而核对上下文恰恰是点进原文的全部目的。
   *
   * 无页码的材料（Word / 纯文本）没有"同页"这个概念，此时只含被引块自己，
   * 界面要靠 `chunk.page === null` 判断并说明这一点。
   */
  siblings: readonly ChunkView[];
}
