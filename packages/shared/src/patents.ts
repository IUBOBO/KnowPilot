/**
 * 专利台账（投稿台账信息优化 · 第三步）。
 *
 * 【为什么不复用投稿状态】专利的“实审”“公开”是流程事件，不是论文投稿的
 * 8 档状态；硬塞进同一套词表会让巡检、筛选和问答都开始说假话。
 *
 * 一件申请一条记录；日期都是日历日期，未知保持 null，不用当前时间冒充。
 */

export const PATENT_EVENT_KINDS = [
  'submitted',
  'substantive_exam',
  'published',
  'granted',
  'patent_no',
  'renamed',
] as const;
export type PatentEventKind = (typeof PATENT_EVENT_KINDS)[number];

export const PATENT_EVENT_LABELS: Record<PatentEventKind, string> = {
  submitted: '提交专利申请',
  substantive_exam: '进入实质审查',
  published: '申请公开',
  granted: '授权登记',
  patent_no: '登记专利号',
  renamed: '更正专利名称',
};

/** 列表筛选档；服务端按完整结果集筛选并返回各档计数。 */
export const PATENT_FILTERS = ['all', 'missing_number', 'under_review', 'published', 'granted', 'date_pending'] as const;
export type PatentFilter = (typeof PATENT_FILTERS)[number];

export const PATENT_FILTER_LABELS: Record<PatentFilter, string> = {
  all: '全部',
  missing_number: '未补专利号',
  under_review: '实质审查中',
  published: '已公开',
  granted: '已授权',
  date_pending: '日期待核实',
};

export interface PatentEvent {
  id: string;
  kind: PatentEventKind;
  /** 事件实际发生的日期；补录专利号/改名这类事件为 null。 */
  occurredOn: string | null;
  note: string | null;
  /** 录入时刻。与 occurredOn 分开：事实日期 ≠ 系统写入时刻。 */
  recordedAt: string;
  recordedByName: string | null;
}

export interface Patent {
  id: string;
  name: string;
  patentNo: string | null;
  /** 原表申请人姓名快照。 */
  applicantName: string | null;
  /** 关联的人员主档；可空。 */
  applicantPersonId: string | null;
  /** 关联人员的当前姓名（便于展示；人员改名不会回写快照）。 */
  applicantPersonName: string | null;
  firstSubmittedOn: string | null;
  substantiveExamOn: string | null;
  publishedOn: string | null;
  grantedOn: string | null;
  /** 旧负责人字段，保留用于历史范围查询。 */
  ownerUserId: string | null;
  ownerName: string | null;
  createdById: string | null;
  createdByName: string | null;
  notes: string | null;
  events: readonly PatentEvent[];
  revision: number;
  edits: readonly import('./record-edits.ts').RecordEdit[];
  createdAt: string;
  updatedAt: string;
}

export interface ListPatentsResponse {
  items: readonly Patent[];
  total: number;
  matched: number;
  counts: Readonly<Record<PatentFilter, number>>;
}

export interface CreatePatentRequest {
  name: string;
  patentNo?: string;
  applicantName?: string;
  applicantPersonId?: string;
  firstSubmittedOn?: string;
  substantiveExamOn?: string;
  publishedOn?: string;
  grantedOn?: string;
  notes?: string;
}

export interface CreatePatentResponse {
  patent: Patent;
}

/** 不出现的字段不动；日期、专利号、申请人、人员关联给 null 表示清空。 */
export interface UpdatePatentRequest {
  expectedRevision: number;
  name?: string;
  patentNo?: string | null;
  applicantName?: string | null;
  applicantPersonId?: string | null;
  firstSubmittedOn?: string | null;
  substantiveExamOn?: string | null;
  publishedOn?: string | null;
  grantedOn?: string | null;
  notes?: string | null;
}

export interface UpdatePatentResponse {
  patent: Patent;
}
