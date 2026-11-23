/**
 * 巡检的契约（阶段 6，需求 8）。前后端共用。
 *
 * 【巡检到底是什么】投稿台账里"多久没动过"是**算出来的**，不是谁盯出来的。
 *   一个外审阶段的稿子放了两个月没人管，它不会自己报警 —— 巡检就是把这件事
 *   变成一条能被人看到的待办。判据是"当前时间 − 投稿的 updated_at > 该档阈值"，
 *   一个减法，确定性的（02 号 §2.1 的 T3）。
 *
 * 【为什么阈值按状态分档】待初审两周没人理是异常，外审六十天是常态。
 *   一个全局阈值要么把外审全标红，要么对初审形同虚设。
 */
import type { SubmissionStatus } from './submissions.ts';

/**
 * 待办的生命周期。
 *
 * - `open`      出现了、还没人处理
 * - `dismissed` 被某个人**显式忽略**了（"这条我知道，不用管"）
 * - `resolved`  不再成立了（投稿改动了 / 进了终态 / 规则关掉了），自动消解
 *
 * 【为什么要分开 dismissed 与 resolved】两者都是"不再是待办"，但含义完全不同：
 *   dismissed 是**有人做了决定**（留了忽略人与时间，可追责），
 *   resolved 是**系统按现状算的结果**（没有"谁"）。合成一个值，
 *   "这条是被人划掉的还是自己消掉的"就再也分不出来了。
 */
export type PatrolTaskStatus = 'open' | 'dismissed' | 'resolved';

export const PATROL_TASK_STATUS_LABELS: Record<PatrolTaskStatus, string> = {
  open: '待处理',
  dismissed: '已忽略',
  resolved: '已消解',
};

/**
 * 需要巡检盯着的四个档。
 *
 * ★ 这一组**必须与 `isInProgressStatus()`（submissions.ts）完全一致** ——
 *   巡检的分档与投稿模块"哪些算进行中"是同一件事，两处分叉会让某个档
 *   要么漏检、要么被一个不存在的规则档挡住。patrol-check.ts 里有一条断言
 *   把两者钉在一起，改了一边而忘了另一边会立刻报出来。
 */
export const PATROL_SUBJECT_STATUSES = [
  'pending_initial',
  'under_review',
  'revision_resubmitted',
  'accepted_pending',
] as const;

export type PatrolSubjectStatus = (typeof PATROL_SUBJECT_STATUSES)[number];

/**
 * 各档的默认阈值（天）。约束 3 里用户按实验室习惯拍的四个数字。
 *
 * 【与迁移 v18 里 INSERT 的那四个数同值、互相点名】
 *   迁移一旦发布一个字都不能改，所以真正生效的默认值是**迁移里那份**；
 *   这份常量只用于两件事：界面上的"恢复默认"、以及规则表缺行时的兜底。
 *   两处一旦漂移，patrol-check.ts 的断言会报出来。
 */
export const DEFAULT_PATROL_THRESHOLDS: Record<PatrolSubjectStatus, number> = {
  pending_initial: 14,
  under_review: 60,
  revision_resubmitted: 30,
  accepted_pending: 90,
};

/** 判定超期的分钟/小时都折算成"整天"，只保留这一个单位的换算。 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 界面上那句话。写成函数而不是在各处拼字符串：
 * "已超期 N 天" 出现在管理端待办列表、成员端台账、首页三处，
 * 各写一遍早晚会有一个写成"超时 N 天"。
 */
export function patrolOverdueLabel(overdueDays: number): string {
  return `已超期 ${overdueDays} 天`;
}

/** 一条巡检规则。管理端"巡检规则"卡渲染它。 */
export interface PatrolRule {
  status: PatrolSubjectStatus;
  /** 超过这么多天没更新就算超期 */
  thresholdDays: number;
  enabled: boolean;
  /** 预留的通知通道；单机恒为 'in_app'。 */
  notifyChannel: string;
  updatedAt: string;
  updatedBy: string | null;
  /** 改这条规则的人（给人看）。NULL = 还是迁移里的默认值，没人改过。 */
  updatedByName: string | null;
}

/**
 * 一条待办。
 *
 * 【为什么把投稿的快照（标题 / 状态）也带上】待办列表要能一眼看出"是哪个稿子"，
 *   否则只有一串 id。这里保存的是**查询时的快照**，不是历史值 ——
 *   历史值在 `observedUpdatedAt` 里（那才是"生成时它长什么样"的锚点）。
 */
export interface PatrolTask {
  id: string;
  /** 预留。现在恒为 'submission' */
  targetType: string;
  /** submissions.id */
  targetId: string;
  ownerId: string | null;
  /**
   * 归属人显示名。**NULL = 未记录**（阶段 1–3 的无主投稿），不是"匿名"。
   * 界面上要显示成「未记录」—— 这类待办只有管理员看得到、处理得了。
   */
  ownerName: string | null;
  status: PatrolTaskStatus;
  /** 生成时用的阈值（留痕：阈值后来改了也说得清当时按几天判的） */
  thresholdDays: number;
  /** 生成时超了几天 */
  overdueDays: number;
  /** 生成时投稿的 updated_at。同一条投稿的这个值没变 = 还是同一版待办 */
  observedUpdatedAt: string;
  createdAt: string;
  dismissedBy: string | null;
  dismissedAt: string | null;
  dismissReason: string | null;
  resolvedAt: string | null;
  /** 投稿当前标题（快照）。target 是可扩展的，理论上可能取不到，故可空。 */
  submissionTitle: string | null;
  /** 投稿当前状态。 */
  submissionStatus: SubmissionStatus | null;
  /** 投稿当前 updated_at（"更新于几天前"用）。 */
  submissionUpdatedAt: string | null;
}

/**
 * 一次巡检的结果。手工"立即巡检"与定时巡检都回它。
 *
 * 【为什么这三个数都要给】`created` 与 `resolved` 说"这次动了什么"，
 *   `stillOpen` 说"现在总共还挂着几条"。只给前两个的话，用户点完
 *   "立即巡检"看到 0 会以为没生效 —— 而"0 新建、7 条还挂着"是完全不同的一件事。
 */
export interface PatrolRunSummary {
  /** 本次新建的待办数 */
  created: number;
  /** 本次消解（不再超期）的待办数 */
  resolved: number;
  /** 本次跑完仍为 open 的待办总数 */
  stillOpen: number;
  at: string;
}

export interface PatrolRulesResponse {
  rules: readonly PatrolRule[];
}

/** PATCH /api/v1/patrol/rules 的单条改动。缺省字段 = 不改它。 */
export interface PatrolRuleUpdate {
  status: PatrolSubjectStatus;
  thresholdDays?: number;
  enabled?: boolean;
}

export interface UpdatePatrolRulesRequest {
  rules: readonly PatrolRuleUpdate[];
}

export interface PatrolTasksResponse {
  items: readonly PatrolTask[];
}

export interface DismissPatrolTaskRequest {
  /** 忽略的理由（可空）。留痕用。 */
  reason?: string;
}

export interface DismissPatrolTaskResponse {
  task: PatrolTask;
}
