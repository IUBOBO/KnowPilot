/**
 * 「我的」相关契约（阶段 4B）。
 *
 * 【为什么单独一组 /me/* 接口，而不是让首页去拼三次已有列表】
 *   首页要的"我的投稿 / 我上传的资料 / 我提的问题"与各自的列表页**口径不同**：
 *   列表页给的是"我能看到什么"（含公共历史数据、导师含全组），
 *   而这里是"我做过什么"，必须严格按 `user_id = 我` 过滤。
 *   更要紧的是 `documents`：全库那份文档列表**不按归属过滤**（文档是共享资料），
 *   所以从现有接口根本拿不到"我上传的"。
 *   一个接口一次问清，免得首页自己拼三次、还把两套口径悄悄混成一套。
 */
import type { AskRecord } from './answer.ts';
import type { DocumentSummary } from './documents.ts';
import type { PatrolTask } from './patrol.ts';
import type { Submission } from './submissions.ts';

/**
 * 「今天要我处理什么」的三类计数（O14）。
 *
 * 【为什么是计数而不是列表】首页只回答"有没有事、有几件"，点进去才看是哪几件。
 *   把三份列表都塞进概览，会把首页变回"什么都摆一点"的旧样子；而每类各自的
 *   列表页（投稿台账 / 知识沉淀 / 数据集上传）本来就能按状态处理。
 *
 * 【为什么后两项可能是 null】它们各自跟着一个权限点（`knowledge.submit` /
 *   `material.upload`）。**没有权限时不查、返回 null**，界面如实说"无权查看"，
 *   而不是显示一个看起来像"0 件"的数字 —— "没有事"和"不许看"是两件事。
 */
export interface MePendingSummary {
  /** 挂在我投稿上、还没有被忽略或消解的超期待办数（`patrol_tasks` open）。 */
  overdueSubmissions: number;
  /** 我提交、还没确认的知识草案数；`null` = 当前角色没有 `knowledge.submit`。 */
  proposedKnowledge: number | null;
  /** 我发起、还没完成的上传会话数；`null` = 没有 `material.upload`。 */
  unfinishedUploads: number | null;
}

/** 知识库概况（全库共享的那一份，不是"我的"）。 */
export interface MeKnowledgeSummary {
  documents: number;
  chunks: number;
  /** 已按当前向量模型算出向量的块数（`chunk_embeddings` 去重）。 */
  embedded: number;
}

export interface MeOverviewResponse {
  /**
   * 我最近登记的投稿。**strictly 我自己的** —— 不含公共历史数据。
   * 想看"我能看到的全部"要去 `/submissions`（那里的行级范围不同）。
   */
  submissions: readonly Submission[];
  /** 我最近上传的资料。历史数据 uploaded_by 为 NULL，不会出现在这里。 */
  documents: readonly DocumentSummary[];
  /** 我最近提的问题（只含问题元数据，不含回答正文）。 */
  askRecords: readonly AskRecord[];
  /**
   * 挂在我的投稿上的巡检待办（阶段 6）。**严格 `owner_id = 我`**，
   * 含 `open` 与 `dismissed` 两种 —— 首页要能显示"这条我忽略过了"，
   * 否则用户会以为自己没点过。`resolved` 的不必显示（它已经不成立了）。
   *
   * 【为什么不做成单独的 /me/patrol-tasks 接口】首页本来就要一次问清
   *   "我的投稿 / 资料 / 提问"，待办是第 4 块；分开请求会让首页多一次往返，
   *   而且待办要按 submissionId 与投稿列表对上，同一个响应里出来更省事。
   */
  patrolTasks: readonly PatrolTask[];

  /** 今日工作台的「待我处理」计数（O14）。 */
  pending: MePendingSummary;
  /**
   * 知识库概况。`null` = 当前角色没有 `knowledge.read`，界面要说明原因；
   * 不能拿 0 冒充"知识库是空的"。
   */
  knowledge: MeKnowledgeSummary | null;
}

/**
 * 用量合计。
 *
 * 【为什么不直接复用服务端 `usage/repo.ts` 的 `UsageTotals`】
 *   前端**不能** import 服务端代码，所以跨进程传输的形状必须在 shared 定义。
 *   两者字段一一对应，改名时一起改。
 */
export interface MyUsageTotals {
  /** 模型调用次数（不是问答次数：一次问答可能调用多次） */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 美元。取不到时按 0 计（合计口径，与"某次调用取不到就存 NULL"是两回事） */
  costUsd: number;
}

export interface MeUsageResponse {
  totals: MyUsageTotals;
  /**
   * 合计的起始时刻（ISO 8601）；`null` 表示"全部历史"。
   * 界面上必须把这句写出来 —— 一个不写时间范围的合计数字，
   * 用户没法判断它说的是"这个月"还是"全部"。
   */
  since: string | null;
}
