/**
 * 回答反馈的契约（O5）。
 *
 * 【为什么原因用"键 + 文案表"，而不是直接存中文】文案会改（"答案不对"可能
 *   改成"结论不对"），存中文的话改一次文案就再也统计不了历史数据。键是稳定的，
 *   文案只在渲染时查表；前端与导出草稿共用同一张表，不会出现两边说法不同。
 *
 * 【为什么反馈不存回答正文】沿用问答记录的约定：回答与引用摘录来自未发表材料，
 *   不复制到新的留存载体。反馈只记运行 ID、评分与用户写的说明。
 */
import type { AskOutcome } from './answer.ts';

export const FEEDBACK_RATINGS = ['up', 'down'] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

/**
 * 踩的预设原因。允许一次选多个 —— 一条回答可能既"答非所问"又"没给依据"，
 * 强迫只选一个会让第二个问题在统计里消失。
 */
export const FEEDBACK_DOWN_REASONS = [
  { key: 'wrong', label: '答案不对' },
  { key: 'unsupported', label: '依据不足 / 引用对不上' },
  { key: 'off-topic', label: '答非所问' },
  { key: 'missing', label: '没找到，但库里应该有' },
  { key: 'slow', label: '太慢' },
  { key: 'other', label: '其他' },
] as const;

export type FeedbackDownReason = (typeof FEEDBACK_DOWN_REASONS)[number]['key'];

/** 键 → 中文文案。未知键（历史数据 / 将来删掉的原因）原样显示键名，不吞掉。 */
export const FEEDBACK_REASON_LABELS: Record<FeedbackDownReason, string> = Object.fromEntries(
  FEEDBACK_DOWN_REASONS.map((r) => [r.key, r.label]),
) as Record<FeedbackDownReason, string>;

/** 自由说明的长度上限。与迁移 v20 的注释、服务端入口校验同一口径。 */
export const FEEDBACK_NOTE_MAX_CHARS = 500;

export interface SubmitFeedbackInput {
  rating: FeedbackRating;
  /** 只有踩时有效；赞会忽略（服务端清空）。 */
  reasons?: readonly FeedbackDownReason[];
  /** 只有踩时有效；赞会忽略（服务端清空）。 */
  note?: string | null;
}

export interface AnswerFeedback {
  runId: string;
  userId: string;
  rating: FeedbackRating;
  /**
   * 读出来的原因是 `string[]` 而不是 `FeedbackDownReason[]`：写入口只接受预设键，
   * 但读路径不假设库里的数据一定来自当前这版词表 —— 将来删掉一个预设原因时，
   * 历史行仍然要原样显示出来，而不是被静默丢掉（界面按标签表兜底到键名）。
   */
  reasons: readonly string[];
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubmitFeedbackResponse {
  feedback: AnswerFeedback;
}

/** 管理端一行：反馈 + 它对应的那次运行（问题原文来自 ask_records）。 */
export interface AdminFeedbackItem {
  runId: string;
  /** `null` = ask_records 里已经找不到这次运行（本表不挂它的外键，见迁移 v20）。 */
  question: string | null;
  askedAt: string | null;
  outcome: AskOutcome | null;
  citationCount: number | null;
  gapCount: number | null;
  /** 提问人显示名；用户被删后可能为空。 */
  userName: string;
  rating: FeedbackRating;
  /** 同 `AnswerFeedback.reasons`：读路径不吞掉未知键。 */
  reasons: readonly string[];
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListAdminFeedbackResponse {
  items: readonly AdminFeedbackItem[];
  /**
   * 全量计数（不受 `rating` 筛选影响）。
   * 筛选按钮上要显示"踩 12 / 赞 5"，若只统计筛选后的那一档，
   * 切到"赞"时"踩"的数字会变成 0 —— 那不是计数，是当前列表长度。
   */
  counts: { all: number; up: number; down: number };
}

/**
 * 导出给管理员的评测用例草稿。
 *
 * 【这是草稿，不是可以直接并入基线的用例】`gold` / `checks` 必须由人补齐，
 * 跑批脚本**不会**自动读取它。理由：反馈只说"这条不好"，并没说"正确答案
 * 应该是什么"；把负面反馈自动变成金标，等于让被测者给自己出题。
 */
export interface FeedbackCaseDraft {
  kind: 'knowpilot-eval-case-draft';
  generatedAt: string;
  exportedBy: string;
  runId: string;
  question: string | null;
  run: {
    askedAt: string | null;
    outcome: AskOutcome | null;
    citationCount: number | null;
    gapCount: number | null;
  };
  feedback: {
    rating: FeedbackRating;
    reasons: readonly string[];
    note: string | null;
    updatedAt: string;
  };
  /** 可以直接粘进 cases.ts 再补齐的骨架；空数组就是"待人工填写"。 */
  caseDraft: {
    id: string;
    title: string;
    category: 'Outcome';
    kind: 'model';
    blocker: false;
    regression: false;
    scenario: string;
    question: string;
    gold: readonly string[];
    checks: readonly unknown[];
    note: string;
  };
  /** 必须读完再动手的提醒，导出界面会原样显示一次。 */
  notice: string;
}

export interface ExportFeedbackDraftResponse {
  draft: FeedbackCaseDraft;
  /** 建议的下载文件名（前端拿来生成 Blob 下载）。 */
  fileName: string;
}
