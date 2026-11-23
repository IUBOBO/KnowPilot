/**
 * 回答反馈的读写（O5）。
 *
 * 【表里只有"态度"，没有"内容"】answer_feedback 不存回答正文，也不存引用摘录；
 * 问题原文来自 ask_records 的 JOIN。导出草稿要展示回答时**不从这里取** ——
 * 系统本来就没把回答存过（见迁移 v6 与 v20 的注释）。
 */
import type {
  AdminFeedbackItem,
  AnswerFeedback,
  FeedbackRating,
  AskOutcome,
} from '@knowpilot/shared';
import type { Db } from '../db/index.ts';

interface FeedbackRow {
  run_id: string;
  user_id: string;
  rating: string;
  reasons: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface AdminFeedbackRow extends FeedbackRow {
  question: string | null;
  asked_at: string | null;
  outcome: string | null;
  citation_count: number | null;
  gap_count: number | null;
  display_name: string | null;
}

export interface NewFeedback {
  runId: string;
  userId: string;
  rating: FeedbackRating;
  /** 已经是校验过、去过重的预设键；赞时为空数组。 */
  reasons: readonly string[];
  note: string | null;
}

/**
 * 一次运行是否属于这个人。
 *
 * 【为什么不是先查反馈表】写入口必须先回答"他能不能给这次运行打分"。
 * 直接返回 `ask_records` 的 user_id，让 handler 自己判空 —— 别人的运行与
 * 不存在的运行在响应上必须**不可区分**（都 404），否则 runId 就能被拿来探测
 * "某次问答是否存在"。
 */
export function findAskRecordOwner(db: Db, runId: string): string | null {
  const row = db
    .prepare('SELECT user_id FROM ask_records WHERE run_id = ?')
    .get(runId) as { user_id: string | null } | undefined;
  return row?.user_id ?? null;
}

/**
 * 写反馈（改投覆盖）。
 *
 * `created_at` 只在第一次写入时设置，改投只动 `updated_at`：
 * 管理端要能分辨"他一开始就打了踩"与"他先赞后改踩"。
 */
export function upsertFeedback(db: Db, input: NewFeedback, now: string): AnswerFeedback {
  db.prepare(
    `INSERT INTO answer_feedback (run_id, user_id, rating, reasons, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       rating     = excluded.rating,
       reasons    = excluded.reasons,
       note       = excluded.note,
       updated_at = excluded.updated_at`,
  ).run(
    input.runId,
    input.userId,
    input.rating,
    JSON.stringify(input.reasons),
    input.note,
    now,
    now,
  );

  const saved = getFeedback(db, input.runId);
  if (saved === null) {
    // 刚写进去却读不到：与投稿建档后的同一条判断，属于真正的内部错误。
    throw new Error(`反馈写入后读不到 run ${input.runId}`);
  }
  return saved;
}

const FEEDBACK_SELECT = `SELECT run_id, user_id, rating, reasons, note, created_at, updated_at
       FROM answer_feedback`;

export function getFeedback(db: Db, runId: string): AnswerFeedback | null {
  const row = db
    .prepare(`${FEEDBACK_SELECT} WHERE run_id = ?`)
    .get(runId) as unknown as FeedbackRow | undefined;
  return row === undefined ? null : toFeedback(row);
}

/** 管理端列表需要的额外列：问题与运行结果从 ask_records 来，显示名从 users 来。 */
const ADMIN_FEEDBACK_SELECT = `SELECT f.run_id, f.user_id, f.rating, f.reasons, f.note,
              f.created_at, f.updated_at,
              r.question, r.asked_at, r.outcome, r.citation_count, r.gap_count,
              u.display_name
       FROM answer_feedback f
       LEFT JOIN ask_records r ON r.run_id = f.run_id
       LEFT JOIN users u       ON u.id     = f.user_id`;

/**
 * 管理端列表。`rating === null` = 全部，否则只给那一档。
 *
 * 【为什么 ask_records 用 LEFT JOIN】本表刻意不挂它的外键（见迁移 v20），
 * 运行记录若因任何原因不在了，反馈仍然要出现在列表里 —— 它本来就是
 * "这次运行被打了分"的独立证据。问题列显示为缺失，而不是整行消失。
 */
export function listAdminFeedback(
  db: Db,
  rating: FeedbackRating | null,
  limit: number,
): AdminFeedbackItem[] {
  const where = rating === null ? '' : 'WHERE f.rating = ?';
  const rows = db
    .prepare(`${ADMIN_FEEDBACK_SELECT} ${where} ORDER BY f.updated_at DESC LIMIT ?`)
    .all(...(rating === null ? [limit] : [rating, limit])) as unknown as AdminFeedbackRow[];
  return rows.map(toAdminItem);
}

export function getAdminFeedback(db: Db, runId: string): AdminFeedbackItem | null {
  const row = db
    .prepare(`${ADMIN_FEEDBACK_SELECT} WHERE f.run_id = ?`)
    .get(runId) as unknown as AdminFeedbackRow | undefined;
  return row === undefined ? null : toAdminItem(row);
}

/**
 * 全量计数（不受筛选影响）。
 *
 * 筛选按钮上要写"踩 12"，如果这里跟着筛选走，切到"赞"时踩的数字会变成 0。
 */
export function feedbackCounts(db: Db): { all: number; up: number; down: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN rating = 'up'   THEN 1 ELSE 0 END), 0) AS up_count,
              COALESCE(SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END), 0) AS down_count
       FROM answer_feedback`,
    )
    .get() as { total: number; up_count: number; down_count: number };
  return { all: row.total, up: row.up_count, down: row.down_count };
}

/** 导出审计。每一次成功导出写一行；失败不写（没有东西被交出去）。 */
export function insertFeedbackExport(
  db: Db,
  input: { id: string; runId: string; rating: FeedbackRating; exportedBy: string; exportedAt: string },
): void {
  db.prepare(
    `INSERT INTO feedback_exports (id, run_id, rating, exported_by, exported_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.id, input.runId, input.rating, input.exportedBy, input.exportedAt);
}

function toFeedback(row: FeedbackRow): AnswerFeedback {
  return {
    runId: row.run_id,
    userId: row.user_id,
    rating: row.rating as FeedbackRating,
    reasons: parseReasons(row.reasons),
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAdminItem(row: AdminFeedbackRow): AdminFeedbackItem {
  return {
    ...toFeedback(row),
    question: row.question,
    askedAt: row.asked_at,
    outcome: row.outcome as AskOutcome | null,
    citationCount: row.citation_count,
    gapCount: row.gap_count,
    userName: row.display_name ?? '（已删除的用户）',
  };
}

/**
 * `reasons` 列是 JSON 数组。坏数据（被手工改坏、旧版本写的非数组）一律当作空：
 * 反馈的核心信息是评分本身，让一个坏字段把整行变成 500 不划算。
 */
function parseReasons(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}
