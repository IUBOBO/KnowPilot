/**
 * 全文检索的契约。前后端共用。
 */
import type { CitationField, RecordType } from './answer.ts';
import type { Material, MatchSource, SearchMode } from './documents.ts';
import type { TextSegment } from './text.ts';
import type { PatentFilter } from './patents.ts';
import type { PersonStatus } from './people.ts';
import type { SubmissionStatus } from './submissions.ts';

/** 一条检索命中。 */
export interface SearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  material: Material;
  /** PDF 页码；Word / 纯文本为 null */
  page: number | null;
  /**
   * 所属章节路径，如 ["3 Methods", "3.1 Encoder-Decoder"]。
   * 空数组表示这块不在任何已识别出的章节里。
   */
  sectionPath: readonly string[];
  /**
   * 摘要的高亮分段。为什么不是一段 HTML 字符串：
   * 拼 HTML 意味着要把文档内容塞进标签里，那是 XSS 的经典入口。
   * 分段交给 React 渲染 <mark>，转义由框架负责。
   */
  segments: readonly TextSegment[];
  /**
   * 排序分，越大越相关。
   * 注意：不同模式的量纲不同 —— 关键词是 bm25 取反，语义是余弦（-1~1），
   * 关键词/语义/混合候选还会按正文信息量与问题类型调整；重排开启时为模型重排分。
   * 跨模式比较这个数字没有意义，界面上只用来在同一次结果内排序。
   */
  score: number;
  /**
   * 这一条是被哪些路召回的（仅混合模式填）。
   * 它是"为什么这条排在这里"的唯一解释来源：只被语义召回的结果往往
   * 字面上完全不含查询词，不给这个标记，用户会以为检索出错了。
   */
  matchedBy?: readonly MatchSource[];
}

/**
 * 本次排序实际走的路径（V3 / R2）。
 *
 * 【为什么要把"回退原因"放进响应，而不是只写日志】
 *   开了重排却没重排，与"根本没开重排"在结果上看起来一模一样。评测要比较
 *   RRF 与 RRF+Rerank，必须能从响应里分清这一轮实际用了哪一档；否则一次
 *   模型加载失败会被算成"重排没有收益"，得出反方向的结论。
 */
export interface RankingInfo {
  /** rrf = 只用融合分；rerank = Cross-Encoder 重排成功 */
  mode: 'rrf' | 'rerank';
  /** 进入重排的候选数；未启用或没有候选时为 0 */
  candidates: number;
  /** 仅 mode=rrf 且曾尝试重排时出现 */
  fallbackReason?: string;
  /** 重排耗时（毫秒）；未重排时不出现 */
  ms?: number;
}

export interface SearchResponse {
  /** 服务端实际使用的查询词（已去空白） */
  query: string;
  /** 服务端实际采用的模式。请求 semantic 但模型未就绪时会退化成 keyword。 */
  mode: SearchMode;
  /** 本次返回的命中条数 */
  returned: number;
  hits: readonly SearchHit[];
  /** 本次排序的实际路径；未启用重排的旧调用方可以忽略。 */
  ranking?: RankingInfo;
  /**
   * 降级或其它需要让用户知道的说明。
   *
   * 为什么必须返回而不是只写日志：请求的是语义检索、拿回的是关键词检索结果，
   * 两者看起来都"有结果"，用户无从察觉差别 —— 只有明确告知才算没有静默降质。
   */
  notice?: string;
}

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;

/** 摘要窗口：命中词前后各取这么多字符。 */
export const SNIPPET_RADIUS = 120;

/**
 * 章节路径的展示形式。
 * 放共享包而不是各端各写一份：前端显示、日志、后面的 Agent 引用都用它，
 * 一致才不会出现"界面写 3.1 节、回答里写 3.1"这种对不上的情况。
 */
export function formatSectionPath(path: readonly string[]): string {
  return path.join(' > ');
}

/** 限定资料范围或指定一种台账；文档排序和结构化排序分别报告。 */
export const RETRIEVAL_RECORD_TYPES = ['M-SUBMIT', 'M-PATENT', 'M-THESIS', 'M-PERSON'] as const;
export type RetrievalRecordType = (typeof RETRIEVAL_RECORD_TYPES)[number];

export interface DocumentRetrievalScope {
  kind: 'document';
  material?: Material;
  documentId?: string;
}

export type RecordRetrievalScope = {
  kind: 'record';
  recordId?: string;
  groupId?: string;
} & (
  | { recordType: 'M-SUBMIT'; personId?: string; year?: number; status?: SubmissionStatus }
  | { recordType: 'M-PATENT'; personId?: string; year?: number; milestone?: PatentFilter }
  | { recordType: 'M-THESIS'; personId?: string }
  | { recordType: 'M-PERSON'; status?: PersonStatus }
);

interface RetrievalPage {
  limit: number;
  offset: number;
}

export interface DocumentRetrievalRequest extends RetrievalPage {
  version: 1;
  query: string;
  scope: DocumentRetrievalScope;
  strategy: SearchMode;
  candidateLimit: number;
}

export interface RecordRetrievalRequest extends RetrievalPage {
  version: 1;
  query: string;
  scope: RecordRetrievalScope;
  strategy: 'structured';
}

export type RetrievalRequestV1 = DocumentRetrievalRequest | RecordRetrievalRequest;

export type RetrievalDiagnostic =
  | 'low_relevance' | 'index_stale' | 'index_unavailable'
  | 'vector_missing' | 'vector_partial' | 'vector_model_unavailable' | 'vector_query_failed'
  | 'rerank_fallback';

export interface DocumentEvidenceLocator {
  kind: 'document';
  documentId: string;
  chunkId: string;
  /** 与文档引用一致，使用实际块来源的索引版本。 */
  sourceVersion: string;
}

export interface RecordEvidenceLocator {
  kind: 'record';
  recordType: RecordType;
  recordId: string;
  sourceVersion: string;
}

export type EvidenceLocator = DocumentEvidenceLocator | RecordEvidenceLocator;

export interface DocumentRetrievalHit extends SearchHit, DocumentEvidenceLocator {
  excerpt: string;
  matchedBy: readonly MatchSource[];
}

export interface RecordRetrievalHit extends RecordEvidenceLocator {
  recordTitle: string;
  recordUpdatedAt: string | null;
  queryTime: string;
  excerpt: string;
  fields: readonly CitationField[];
  matchedBy: readonly ['structured'];
}

export interface RetrievalResponseV1 {
  version: 1;
  query: string;
  scope: DocumentRetrievalScope | RecordRetrievalScope;
  requestedStrategy: SearchMode | 'structured';
  strategy: SearchMode | 'structured';
  state: 'ok' | 'empty';
  diagnostics: readonly RetrievalDiagnostic[];
  offset: number;
  nextOffset: number | null;
  hits: readonly (DocumentRetrievalHit | RecordRetrievalHit)[];
  ranking?: RankingInfo;
  notice?: string;
}
