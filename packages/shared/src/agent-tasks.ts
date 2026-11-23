/**
 * 可续跑 Agent 任务的对外视图（V3 / S7 X1b）。
 *
 * 【为什么只暴露这些字段】任务表里还存着问题原文与检查点 JSON，但客户端不需要
 * 看到证据正文或计划细节；它只需要知道"这个任务现在是什么状态、还能不能继续"。
 * 问题原文只回给**任务所有者**，由路由层校验归属后再返回。
 */
export type AgentTaskStatus =
  | 'running'
  | 'interrupted'
  | 'partial'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused';

export interface AgentTaskView {
  taskId: string;
  /** 原始问题（仅所有者可见） */
  question: string;
  status: AgentTaskStatus;
  /** 最近一次 attempt 的停止原因（诊断口径） */
  stopReason: string | null;
  /** 只有 interrupted/partial 且有有效检查点时为 true */
  resumeAvailable: boolean;
  /** 检查点里可重建的文档证据条数（记录类证据不重建） */
  evidenceCount: number;
  /** 最近检查点的版本；从未写过检查点为 null */
  checkpointVersion: number | null;
  /** 最近检查点的计划覆盖状态/比例 */
  coverage: string;
  coverageRatio: number;
  rewriteRounds: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
