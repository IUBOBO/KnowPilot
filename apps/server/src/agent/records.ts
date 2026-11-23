/**
 * 问答记录的读写。
 *
 * 【这张表存的是"证据"，不是"内容"】
 *   它要证明的只有一件事：某人在某个时刻问了某个问题，并且勾选了
 *   "我知道内容会发往云端"。问答历史可保存一条简短结论，仅提问者可读。
 *   回答正文与引用摘录刻意不存 ——
 *   那些是从知识库里摘出来的原文，存下来等于把未发表内容复制到一个新地方，
 *   而证明"他勾过确认"根本不需要它们。详见迁移 v6 的注释。
 *
 * 【与日志的分工】
 *   `ask-run.ts` 里那条结构化 console.log 记的是"这次运行技术上发生了什么"
 *   （工具调用、证据、引用映射），用于排查；本表记的是"这次问答发生过"，
 *   用于追溯。两者都要，因为日志会被轮转掉，而勾选确认要能长期查。
 */
import type { AskOutcome, AskRecord, RunUsage } from '@knowpilot/shared';
import type { RowScope } from '../auth/scope.ts';
import { scopePredicate } from '../auth/scope.ts';
import type { Db } from '../db/index.ts';

interface AskRecordRow {
  run_id: string;
  question: string;
  asked_at: string;
  consent_confirmed: number;
  outcome: string;
  delivery_status: string | null;
  citation_count: number;
  gap_count: number;
  rounds: number;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  warnings: string;
}

/** 落库时提供的字段。`askedAt` 由调用方给，便于与日志里的时间对齐。 */
export interface NewAskRecord {
  runId: string;
  question: string;
  askedAt: string;
  consentConfirmed: boolean;
  outcome: AskOutcome;
  deliveryStatus?: AskRecord['deliveryStatus'];
  citationCount: number;
  gapCount: number;
  rounds: number;
  durationMs: number;
  usage: RunUsage;
  warnings: readonly string[];
  answerPreview?: string | null;
  /**
   * 提问者。**未登录时为 null** —— 那时它是"公共历史数据"（阶段 1–3 的记录）。
   *
   * 调用方（ask-run.ts）拿到的一定是当前登录用户；允许 null 只是为了
   * 让"这台机器上没开启登录"的旧数据与运维脚本也能走同一条 INSERT，
   * 而不是另开一条路径。
   */
  userId: string | null;
}

export function insertAskRecord(db: Db, record: NewAskRecord): void {
  db.prepare(
    `INSERT INTO ask_records (
       run_id, question, asked_at, consent_confirmed, outcome, delivery_status,
       citation_count, gap_count, rounds, duration_ms,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd, warnings, user_id, answer_preview
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.runId,
    record.question,
    record.askedAt,
    record.consentConfirmed ? 1 : 0,
    record.outcome,
    record.deliveryStatus ?? null,
    record.citationCount,
    record.gapCount,
    record.rounds,
    record.durationMs,
    record.usage.inputTokens,
    record.usage.outputTokens,
    record.usage.cacheReadTokens,
    record.usage.cacheWriteTokens,
    record.usage.costUsd,
    JSON.stringify(record.warnings),
    record.userId,
    record.answerPreview ?? null,
  );
}

/**
 * 选择列。抽成常量是为了让"可见范围过滤"与"只看我自己"两个查询
 * 共用同一份列清单 —— 两处各抄一遍的话，加一列时必然漏一处，
 * 而漏掉的那处会静默少一个字段。
 */
const ASK_RECORD_SELECT = `SELECT run_id, question, asked_at, consent_confirmed, outcome, delivery_status,
              citation_count, gap_count, rounds, duration_ms,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              cost_usd, warnings
       FROM ask_records`;

/**
 * 按时间倒序列出问答记录，**并按可见范围在 SQL 里过滤**。
 *
 * 【为什么只做"列表"、不做"详情"接口】记录里除了 `warnings` 之外全是标量，
 * 一次列表就把追溯需要的全部信息带回来了，再多一个详情接口只会多一处要维护的
 * 权限收口点。4B 真按「我的提问历史」设计时若需要详情，**必须把新路由
 * 登记进 auth/routes.ts** —— 否则启动自检会拒绝启动（那是故意的）。
 *
 * 【为什么过滤条件写在这里而不是调用方】调用方（app.ts 的 handler）
 * 只负责把 scope 算出来。让每个读路径自己拼 WHERE，就等于有 N 处
 * 可能漏掉它的地方；而这个函数是**唯一**读这张表的入口。
 */
export function listAskRecords(db: Db, limit: number, scope: RowScope, offset = 0, keyword = ''): AskRecord[] {
  const { sql: visible, params } = scopePredicate('user_id', scope);
  const search = keyword === '' ? '' : ' AND instr(lower(question), lower(?)) > 0';
  const queryParams = keyword === '' ? params : [...params, keyword];
  const rows = db
    .prepare(
      `${ASK_RECORD_SELECT} WHERE (${visible})${search} ORDER BY asked_at DESC, run_id DESC LIMIT ? OFFSET ?`,
    )
    .all(...queryParams, limit, offset) as unknown as AskRecordRow[];
  return rows.map(toRecord);
}

/**
 * 某个人提过的问题（首页「我的动态」用）。严格的 `user_id = 我`。
 *
 * 与 `listAskRecords` 的区别同 `listSubmissionsByUser`：后者答"我能看到谁的"，
 * 这里答"我问过什么"。首页要的是后者。
 */
export function listAskRecordsByUser(db: Db, userId: string, limit: number): AskRecord[] {
  const rows = db
    .prepare(`${ASK_RECORD_SELECT} WHERE user_id = ? ORDER BY asked_at DESC LIMIT ?`)
    .all(userId, limit) as unknown as AskRecordRow[];
  return rows.map(toRecord);
}

function toRecord(row: AskRecordRow): AskRecord {
  return {
    runId: row.run_id,
    question: row.question,
    askedAt: row.asked_at,
    consentConfirmed: row.consent_confirmed === 1,
    outcome: row.outcome as AskOutcome,
    deliveryStatus: (row.delivery_status ?? null) as AskRecord['deliveryStatus'],
    citationCount: row.citation_count,
    gapCount: row.gap_count,
    rounds: row.rounds,
    durationMs: row.duration_ms,
    usage: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      costUsd: row.cost_usd,
    },
    warnings: parseWarnings(row.warnings),
  };
}

/**
 * 解析 warnings 列。
 *
 * 解析失败不抛错、退回空数组：这一列是我们自己写进去的，
 * 真读不出来只可能是有人手工改过库 —— 那种情况下让整条记录读不出来
 * 比丢一个警告字段糟糕得多（记录本身还在，追溯仍然成立）。
 */
function parseWarnings(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}
