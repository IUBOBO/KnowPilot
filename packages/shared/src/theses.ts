/**
 * 大论文（学位论文）台账（投稿台账信息优化 · 第三步）。
 *
 * 【与期刊投稿分开】大论文是“一位人员的学位论文信息”，不是“投了哪本刊”。
 * 题目可以暂时为空、后续定稿；变更留历史。
 *
 * 所有登录角色可以查看成绩。成绩由已关联的作者本人或导师、管理员维护。
 * 字段仍保留 `gradeVisible`，以兼容未来的角色调整。成绩不参与普通搜索。
 */

export interface ThesisTitleChange {
  id: string;
  oldTitle: string | null;
  newTitle: string | null;
  changedAt: string;
  changedByName: string | null;
}

export interface Thesis {
  id: string;
  createdById: string | null;
  createdByName: string | null;
  /** 关联人员主档；历史数据可能为空。 */
  personId: string | null;
  /** 人员主档当前姓名（若已关联）。 */
  personName: string | null;
  /** 原表/登记时的作者姓名快照。 */
  authorName: string;
  direction: string | null;
  title: string | null;
  /** 未授权时为 null；看 `gradeVisible` 区分“没有成绩”和“无权查看”。 */
  grade: string | null;
  gradeVisible: boolean;
  /** 这条记录是否属于当前登录账号（通过人员主档绑定判断）。 */
  isSelf: boolean;
  notes: string | null;
  titleHistory: readonly ThesisTitleChange[];
  revision: number;
  edits: readonly import('./record-edits.ts').RecordEdit[];
  createdAt: string;
  updatedAt: string;
}

export interface ListThesesResponse {
  items: readonly Thesis[];
  total: number;
  matched: number;
}

export interface CreateThesisRequest {
  /** 关联人员主档；与 authorName 至少给一个。 */
  personId?: string;
  authorName?: string;
  direction?: string;
  title?: string;
  /** 成绩按学校口径原样保存，允许暂缺。 */
  grade?: string;
  notes?: string;
}

export interface CreateThesisResponse {
  thesis: Thesis;
}

/** 不出现的字段不动；personId/direction/title/grade/notes 给 null 表示清空。 */
export interface UpdateThesisRequest {
  expectedRevision: number;
  personId?: string | null;
  authorName?: string;
  direction?: string | null;
  title?: string | null;
  grade?: string | null;
  notes?: string | null;
}

export interface UpdateThesisResponse {
  thesis: Thesis;
}
