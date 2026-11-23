/**
 * ⌘K 命令面板的搜索契约（O10）。
 *
 * 【为什么是"页面 + 三类实体"，而不是全文检索】命令面板回答的是
 *   「我要去哪个地方」——页面、数据集、投稿、文档都是**可跳转的目标**；
 *   而 `/api/v1/search` 回答的是「哪段原文提到了这个词」，它的结果是块，
 *   不是能一键到达的东西。两者用途不同，不能拿检索接口拼页面导航。
 *
 * 【为什么每类只回前几条】面板是一张"最近似"的短名单，不是列表页。
 *   每类最多 5 条，用户要么一眼看到目标，要么补几个字再筛 ——
 *   回 200 条只会让键盘选择变成翻页。
 */

import type { Material } from './documents.ts';

export const QUICK_SEARCH_KINDS = ['person', 'submission', 'patent', 'thesis', 'dataset', 'journal', 'document'] as const;

export type QuickSearchKind = (typeof QUICK_SEARCH_KINDS)[number];

export const QUICK_SEARCH_LABELS: Record<QuickSearchKind, string> = {
  person: '人员档案', submission: '投稿台账', patent: '专利', thesis: '大论文',
  dataset: '数据集', journal: '期刊', document: '文档',
};

/** 下拉里的一行。三类实体共用一个形状。 */
export interface QuickSearchHit {
  kind: QuickSearchKind;
  /** 实体的 id；页面跳转不用它，列表页用它把目标行滚进视野。 */
  id: string;
  title: string;
  /**
   * 一行补充说明，由服务端拼好（期刊 + 状态 / 项目 + 路径 / 材料类型）。
   * 放服务端拼是因为状态枚举、材料标签这些词表本来就在 shared 里，
   * 前端再拼一遍只会多一处要同步的中文。
   */
  detail: string;
  updatedAt?: string;
  /** Precise landing pages may need a visible business search term in addition to the ID. */
  lookup?: string;
  /**
   * 文档的块 id。文档没有独立的详情页，点开它最自然的落点是第一块原文；
   * 没有块（解析失败 / 空文档）时为 null，前端退回文档列表。
   *
   * 投稿与数据集没有原文可打开，恒为 null。
   */
  firstChunkId: string | null;
  /**
   * 文档的材料类型。`firstChunkId` 为空时要退回 `/docs` 的对应标签页，
   * 而默认标签页是「论文」—— 少了它，一篇解析失败的制度文件会被带到
   * 论文列表里，看起来像"搜索结果点进去就消失了"。
   *
   * 投稿与数据集为 null。
   */
  material: Material | null;
}

export interface QuickSearchResponse {
  items: readonly QuickSearchHit[];
}
