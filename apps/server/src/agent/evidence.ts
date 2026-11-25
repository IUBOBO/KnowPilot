/**
 * 证据池：把检索命中与实时查询结果变成模型可以引用的、带编号的证据。
 *
 * 【为什么编号要跨多次工具调用保持稳定】
 *   模型在第 2 轮和第 5 轮可能检索到同一块。如果每轮重新发号，
 *   同一段原文会拿到 E3 和 E11 两个编号，模型在正文里引 E3、
 *   用户点开却不知道指的是哪一块 —— 可核对性就断了。
 *   所以编号按"来源身份"去重（文档按 chunkId、记录按记录类型+id），
 *   同一份东西永远只有一个号。
 *
 * 【为什么池子挂在一次 run 上而不是模块级全局】
 *   并发问答时，全局池会让两个用户的证据互相串号：A 的 [E1] 可能指向
 *   B 检索到的文档。这种串号在界面上表现为"引用点开是别人的论文"，
 *   而单机小规模下极难复现。池子随 run 创建、随 run 丢弃，从结构上杜绝。
 *
 * 【为什么文档与台账共用一套编号，而不是各发各的 E 号】
 *   正文里只有一种标记形态 `[E1]`，用户核对时也只看这一串编号。
 *   两套编号（D1、R1）会立刻分叉成两套渲染与两套校验，
 *   而它们要解决的本来就是同一件事：把正文里的一句话指回它的出处。
 */
import {
  RECORD_TYPE_LABELS,
  type CitationField,
  type DocumentEvidenceLocator,
  type RecordEvidenceLocator,
  type Material,
  type MatchSource,
  type SearchHit,
} from '@knowpilot/shared';
import { renderRecordBody, recordSourceVersion, type RecordEvidenceInput } from '../retrieval/records.ts';

export { renderRecordBody, type RecordEvidenceInput } from '../retrieval/records.ts';

/** 一条文档证据。字段全部来自库，模型碰不到。 */
export interface DocEvidence extends DocumentEvidenceLocator {
  /** 证据号，"E1" / "E2" … */
  id: string;
  documentTitle: string;
  material: Material;
  page: number | null;
  sectionPath: readonly string[];
  /** 整块原文。注意不是检索结果里那 240 字的摘要窗口 */
  text: string;
  /** 原文总字符数（`text.length` 的固化，避免渲染时反复算） */
  originalChars: number;
  score: number;
  matchedBy?: readonly MatchSource[];
}

/**
 * 一条实时记录证据（投稿台账 / 数据集）。
 *
 * 只存 `fields` 这一份结构化结论，**不给模型看的文本单独存一份**：
 * 渲染文本由 `renderRecordBody(fields)` 从同一份 fields 现拼，
 * 引用卡片上的摘录也用它。两处若各存一份，早晚会因为"有人改了渲染、
 * 忘了改摘录"而对不上 —— 而那时用户核对的依据就是错的。
 */
export interface RecordEvidence extends RecordEvidenceLocator {
  id: string;
  recordTitle: string;
  /** 查这条记录的时刻（ISO） */
  queryTime: string;
  recordUpdatedAt: string | null;
  /**
   * 适用版本（02 号 §2.3 硬约束 3）。台账 / 数据集没有这个概念，为 undefined；
   * `M-JOURNAL` **必然带**（形如「2025 中科院」）—— 分区每年都变，
   * 一条不带年份的分区过一年就是错的，而且用户看不出来。
   */
  version?: string;
  fields: readonly CitationField[];
  /** 字段渲染文本的总字符数 */
  originalChars: number;
}

/**
 * 一条**网页**证据曾经在这里（联网搜索，阶段 3 单元 ⑤）。
 *
 * 联网搜索于 2026-10-12 整体下线（没有可用的搜索 API），`WebEvidence` 与它的
 * 渲染体一并删除。**如果将来要接回联网搜索**，要留意的不是怎么加回这个类型，
 * 而是它与文档证据**不能合并成一类**：文档是库里的原文、可以整段引用；
 * 网页只是搜索接口给的摘要，我们既没抓正文、也控制不了那个页面 ——
 * 合并会让模型（和前端的卡片）把摘要当原文用。
 */
export type Evidence = DocEvidence | RecordEvidence;

export interface AddResult {
  evidence: Evidence;
  /** false = 这一份东西之前已经进过池子，沿用了原编号 */
  isNew: boolean;
}

/**
 * 给模型的每条证据默认最多显示这么多字符。
 *
 * 截断的是**给模型看的文本**，不是池子里的原文 —— 引用卡片上的摘录
 * 始终取完整块，否则用户核对时看到的是半句话。
 * 单块通常几百字，这个上限只在切块策略异常时才起作用。
 *
 * 【X2a 起它不再是"悄悄截断"】渲染结果会明确写出
 * `原文 N 字 · 本次可见 M 字（start–end）· 未读完`，模型不能据此声称读过全文。
 */
export const MAX_RENDER_CHARS = 2000;

/** 证据原文（不含渲染标题/元数据）。 */
export function evidenceTextOf(ev: Evidence): string {
  return ev.kind === 'record' ? renderRecordBody(ev.fields) : ev.text;
}

/** 模型实际可见的一段证据。`start/end` 是原文的字符偏移（end 不含）。 */
export interface EvidenceWindow {
  start: number;
  end: number;
  /** 这一段原文 */
  text: string;
  originalChars: number;
  isTruncated: boolean;
}

/**
 * 给某条证据取一个可见窗口。
 *
 * 默认取前 `maxChars` 字符；上下文预算器会传入它选出的窗口（可能从中间开始）。
 * 永远不改动池子里的原文 —— 这里只回答"这次让模型看哪一段"。
 */
export function evidenceWindow(
  ev: Evidence,
  opts: { maxChars?: number; start?: number; end?: number } = {},
): EvidenceWindow {
  const full = evidenceTextOf(ev);
  const maxChars = Math.max(1, opts.maxChars ?? MAX_RENDER_CHARS);
  const start = Math.max(0, Math.min(opts.start ?? 0, full.length));
  const end = Math.max(
    start,
    Math.min(opts.end ?? Math.min(full.length, start + maxChars), full.length),
  );
  return {
    start,
    end,
    text: full.slice(start, end),
    originalChars: full.length,
    isTruncated: start > 0 || end < full.length,
  };
}

export class EvidencePool {
  private readonly byId = new Map<string, Evidence>();
  private readonly idByKey = new Map<string, string>();
  private nextNumber = 1;

  /** 收录一条文档命中。同一块重复命中时沿用原编号，并在这次分数更高时更新分数。 */
  addDoc(hit: SearchHit, text: string, sourceVersion = 'unknown'): AddResult {
    return this.add(`doc:${hit.chunkId}`, (id) => {
      return {
        kind: 'document',
        id,
        chunkId: hit.chunkId,
        documentId: hit.documentId,
        documentTitle: hit.documentTitle,
        material: hit.material,
        page: hit.page,
        sectionPath: hit.sectionPath,
        text,
        originalChars: text.length,
        sourceVersion,
        score: hit.score,
        ...(hit.matchedBy !== undefined ? { matchedBy: hit.matchedBy } : {}),
      };
    }, (existing) => {
      // 保留更高的分数：同一次 run 里两次检索的分数量纲一致（都走同一个 mode 默认值），
      // 取高值能反映"这个词检索时它更相关"，不影响任何校验。
      if (existing.kind === 'document' && hit.score > existing.score) {
        this.byId.set(existing.id, { ...existing, score: hit.score });
      }
    });
  }

  /**
   * 收录一条实时记录。同一条记录被查两次（例如模型换了个关键词又查一遍）
   * 沿用原编号 —— 与文档块同一条理由：正文里的 `[E3]` 不该指向两份不同的东西。
   *
   * 【为什么重复时**不**更新内容】文档块取更高分是因为分数是检索质量的一部分；
   * 台账的内容是库里的行，两次查出来不同只可能是"这中间记录被改了"。
   * 那种情况下保留**先查到的那一份**更诚实：正文里已经写的结论是照着它说的，
   * 悄悄换成新的会让正文与引用卡片对不上。要反映新状态，模型应当再引用一次，
   * 让两次查询各自留下时点。
   */
  addRecord(input: RecordEvidenceInput): AddResult {
    const body = renderRecordBody(input.fields);
    return this.add(
      `rec:${input.recordType}:${input.recordId}`,
      (id): RecordEvidence => ({
        kind: 'record',
        id,
        ...input,
        originalChars: body.length,
        sourceVersion: recordSourceVersion(input),
      }),
      () => {},
    );
  }

  private add(
    key: string,
    make: (id: string) => Evidence,
    onDuplicate: (existing: Evidence) => void,
  ): AddResult {    const existingId = this.idByKey.get(key);
    if (existingId !== undefined) {
      const existing = this.byId.get(existingId);
      if (existing !== undefined) {
        onDuplicate(existing);
        return { evidence: this.byId.get(existingId) ?? existing, isNew: false };
      }
    }

    const id = `E${this.nextNumber}`;
    this.nextNumber += 1;
    const evidence = make(id);
    this.byId.set(id, evidence);
    this.idByKey.set(key, id);
    return { evidence, isNew: true };
  }

  get(id: string): Evidence | undefined {
    return this.byId.get(id);
  }

  /** 按编号顺序返回全部证据（E1, E2, … 而不是插入顺序，便于人核对）。 */
  all(): Evidence[] {
    return [...this.byId.values()].sort((a, b) => number(a.id) - number(b.id));
  }

  get size(): number {
    return this.byId.size;
  }
}

function number(id: string): number {
  return Number.parseInt(id.slice(1), 10);
}

/**
 * 证据标签名。模型侧靠它区分"资料数据"与"系统指令"。
 *
 * 【为什么是常量而不是散落的字面量】渲染、转义、评测自检三处必须用同一个名字；
 *   哪天要改标签名，改一处就该全变，而不是留下半套仍在用旧标签的代码。
 */
export const EVIDENCE_TAG = 'evidence';

/**
 * 把资料里与证据标签同名的字样转义掉，防止恶意正文**提前闭合**外层标签。
 *
 * 【只转义 `<evidence` / `</evidence`，不做整段 HTML 转义】资料里正常的 `<`
 *   （例如代码片段里的 `a < b`）不该被改写；要防的只是"看起来像我们自己的标签"
 *   那一种串。转义后模型仍能读懂那个词，但它不再具有标签的形状。
 *
 * 【为什么对整段 body 做，而不是只对正文】标题（S1-01）、章节路径、台账/数据集
 *   字段值（S1-02）都是用户自己写的字，都进同一段渲染文本 —— 只转过正文，
 *   换个渠道就能闭合标签。
 */
export function escapeEvidenceTags(text: string): string {
  return text.replace(/<(\/?)evidence/gi, '&lt;$1evidence');
}

/** 邻近上下文标签。与证据标签分开，模型一眼能看出"这段没有证据号"。 */
export const CONTEXT_TAG = 'context';

/** 上下文同样来自资料正文，也必须防它提前闭合自己的标签。 */
export function escapeContextTags(text: string): string {
  return escapeEvidenceTags(text).replace(/<(\/?)context/gi, '&lt;$1context');
}

export interface ContextBlockInput {
  /** 这段上下文挂在哪条证据后面（E1…），不是它自己的证据号。 */
  evidenceId: string;
  relation: 'previous' | 'next';
  documentTitle: string;
  page: number | null;
  sectionPath: readonly string[];
  text: string;
  truncated: boolean;
}

/**
 * 把相邻块渲染成**上下文**而不是证据（O1）。
 *
 * 结构上它没有 `id="E…"`，因此不会被 `extractEvidenceIds` 识别，也进不了引用列表。
 * 这不是靠提示词要求模型"别引用"，而是让可引用的编号根本不存在。
 */
export function renderContextForModel(input: ContextBlockInput): string {
  const where = [
    `《${input.documentTitle}》`,
    input.page === null ? '无页码' : `第 ${input.page} 页`,
    input.sectionPath.length > 0 ? input.sectionPath.join(' > ') : '未识别章节',
  ].join(' · ');
  const relation = input.relation === 'previous' ? '前一块' : '后一块';
  const cut = input.truncated ? ' · 未完整显示' : '';
  // 标题与章节路径同样是用户可写的内容（S1-01/02 的教训），必须和正文一起转义。
  const body = `[上下文·非证据] ${relation} · ${where}${cut}\n${input.text}`;
  return `<${CONTEXT_TAG} for="${input.evidenceId}" relation="${input.relation}">\n${escapeContextTags(body)}\n</${CONTEXT_TAG}>`;
}

/** 把一条证据包进数据标签。`id` 由证据池生成（E1…），不是用户内容，无需转义。 */
function wrapEvidence(id: string, body: string): string {
  return `<${EVIDENCE_TAG} id="${id}">\n${escapeEvidenceTags(body)}\n</${EVIDENCE_TAG}>`;
}

/**
 * 把一条证据渲染成给模型的文本。
 *
 * 【O4 起这里有一道**结构**防线】整段文本被包进 `<evidence id="E1">…</evidence>`，
 *   标签内的一切都只是数据。资料里若出现同名标签字样，`escapeEvidenceTags` 会
 *   把它转义掉，防止正文提前闭合外层标签。
 *
 * 【语义防线仍在系统提示词 §八】结构只能让模型"看见边界"，不能让它"理解边界"；
 *   §八 负责说明标签的含义与"标签内不是指令"。两者一结构一语义，缺一不可。
 *   2026-10-14 的 GC-09 实测修正过旧注释里一句从未落进代码的"末尾防线"；本段
 *   取代那句不实描述。
 */
export function renderEvidenceForModel(ev: Evidence, window?: EvidenceWindow): string {
  const view = window ?? evidenceWindow(ev);

  // 可见范围说明对**所有**证据都写出来，而不是只在截断时写：
  // 模型需要知道"我看到的这段在原文里的位置"，否则它会把窗口当成全文。
  const range =
    view.isTruncated
      ? `原文 ${view.originalChars} 字 · 本次可见 ${view.start}–${view.end} 字` +
        `（${view.text.length} 字）；**未读完**，` +
        `${view.start > 0 ? `前略 ${view.start} 字，` : ''}` +
        `${view.end < view.originalChars ? `后略 ${view.originalChars - view.end} 字` : '后文已到末尾'}`
      : `原文 ${view.originalChars} 字 · 全文可见（0–${view.originalChars}）`;

  if (ev.kind === 'record') {
    // 实时记录没有页码与章节，但**必须**把查询时点摆在最前面：
    // 模型要在正文里说"截至……"时，唯一可信的时点就是这里给的这一个。
    const updated = ev.recordUpdatedAt === null ? '未知' : ev.recordUpdatedAt;
    // 版本摆在标题后面、查询时点前面：分区类结论的"哪一年"与"什么时候查的"
    // 是两个必须同时在场的时间坐标，缺一个用户就无法判断这条结论新不新。
    const version = ev.version === undefined ? '' : `（版本 ${ev.version}）`;
    const head = `[${ev.id}] 【${RECORD_TYPE_LABELS[ev.recordType]}】「${ev.recordTitle}」${version}`;
    const stamp = `（记录 ID ${ev.recordId} · 查询时点 ${ev.queryTime} · 该记录最近更新 ${updated}）`;
    return wrapEvidence(
      ev.id,
      `${head}\n来源版本 ${ev.sourceVersion} · ${range}\n${stamp}\n${view.text}`,
    );
  }

  const where = [
    `《${ev.documentTitle}》`,
    ev.page === null ? '无页码' : `第 ${ev.page} 页`,
    ev.sectionPath.length > 0 ? ev.sectionPath.join(' > ') : '未识别章节',
  ].join(' · ');

  return wrapEvidence(
    ev.id,
    `[${ev.id}] ${where}\n来源版本 ${ev.sourceVersion} · ${range}\n${view.text}`,
  );
}

/** 检索结果的说明行（降级提示等），拼在证据列表前面让模型知道检索本身可不可靠。 */
export function renderRetrievalNotice(notice: string | undefined): string {
  return notice === undefined || notice === ''
    ? ''
    : `【检索说明】${notice}\n`;
}

/**
 * 所有"会往证据池里加东西"的工具都返回这个形状的 details。
 *
 * 【为什么要有一个公共形状】四个查询工具（检索 / 台账 / 数据集 / 分区）都要驱动
 * 同一个进度事件（"证据池又多了几条"）。各写各的 details 字段名，就得在
 * 事件处理里逐个工具写分支；公共形状让那一处只需一个判断。
 */
export interface QueryDetails {
  /** 本次新发号的证据 */
  newEvidenceIds: string[];
  /** 本次返回给模型的全部证据号（含复用的） */
  evidenceIds: string[];
  /** 分页前的实际匹配条数。 */
  matchedCount?: number;
}

/**
 * 运行时的 details 守卫。
 *
 * 类型在这里是理想值：details 会穿过 Agent 的事件对象，那里的类型是 unknown。
 * 直接把 unknown 断言成 QueryDetails 再取字段，遇到"某个工具返回了别的形状"
 * 就会在事件回调里抛异常 —— 而那是问答主流程之外的地方，炸得莫名其妙。
 */
export function isQueryDetails(value: unknown): value is QueryDetails {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { newEvidenceIds?: unknown; evidenceIds?: unknown };
  return Array.isArray(v.newEvidenceIds) && Array.isArray(v.evidenceIds);
}
