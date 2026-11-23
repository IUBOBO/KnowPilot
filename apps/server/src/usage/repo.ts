/**
 * 用量流水（C-USAGE，需求 7）的读写。
 *
 * 【这张表解决什么】
 *   `ask_records` 已经记了"这次问答一共花了多少"，但它答不了"钱花在哪一次调用上"：
 *   一次问答有 3~5 次模型调用，谁贵谁便宜、哪一轮把上下文撑大了，从一次问答的
 *   汇总数字里看不出来。所以这里按**模型调用**记流水，与 `ask_records` 是 1:N。
 *
 * 【为什么不在模型那一层做全局拦截器】
 *   看着更省事（一次装好，所有调用自动记账），但那会让"这次调用算谁的"变成一个
 *   隐式问题：进程级拦截器拿不到 run 上下文，只能记成孤儿行。改成由调用方显式传入，
 *   `run_id` 才有意义 —— 而这个字段正是整张表能对账的前提。
 */
import type { Db } from '../db/index.ts';

/**
 * 这次模型调用是为什么发生的。
 *
 * 现在只会出现 `generate`：检索走的是本地 BGE-M3（进程内 ONNX），不经模型 API。
 * 其余三个是 04 号 §4 定的词表，阶段 5（沉淀 reflow）与阶段 7（评测 verify）
 * 会用到 —— 现在就把词表立起来，是为了让写入方从一开始就选一个值，
 * 而不是等第二个用途出现时再回头改所有插入点。
 */
export const USAGE_PURPOSES = ['generate', 'retrieve', 'verify', 'reflow'] as const;
export type UsagePurpose = (typeof USAGE_PURPOSES)[number];

/**
 * 一次模型调用的用量。
 *
 * 六个数值字段**全部可空**。这不是偷懒：01 号 §5 对 C-USAGE 的失败反馈写的是
 * "字段缺失时记 `null`，**不估算冒充实际值**"。某家 provider 不报 cacheRead 时，
 * 记 0 会和"确实没命中缓存"塌成同一个值 —— 而这两种情况对成本分析的结论完全相反。
 */
export interface NewUsageEvent {
  eventId: string;
  runId: string | null;
  userId: string | null;
  model: string;
  purpose: UsagePurpose;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
  costUsd: number | null;
  durationMs: number | null;
  createdAt: string;
}

export function insertUsageEvent(db: Db, event: NewUsageEvent): void {
  db.prepare(
    `INSERT INTO usage_events (
       event_id, run_id, user_id, model, purpose,
       input_tokens, output_tokens, cache_read, cache_creation,
       cost_usd, duration_ms, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.eventId,
    event.runId,
    event.userId,
    event.model,
    event.purpose,
    event.inputTokens,
    event.outputTokens,
    event.cacheRead,
    event.cacheCreation,
    event.costUsd,
    event.durationMs,
    event.createdAt,
  );
}

/**
 * 一组用量的合计。
 *
 * 与 `NewUsageEvent` 的可空字段是**两回事**，不要合并理解：
 *   单条流水的 `null` = "这次调用没拿到这个数"；
 *   合计里的 `0` = "这些调用加起来是 0"。
 *   前者不能填 0，后者不能留 null。所以这里的 SUM 用 COALESCE 兜底
 *   （零行时 SQLite 的 SUM 返回 NULL，而"没有调用 ⇒ 合计 0"是对的）。
 */
export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd: number;
}

interface TotalsRow {
  calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read: number | null;
  cache_creation: number | null;
  cost_usd: number | null;
}

const TOTALS_SELECT = `
  SELECT COUNT(*)                        AS calls,
         COALESCE(SUM(input_tokens), 0)  AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read), 0)    AS cache_read,
         COALESCE(SUM(cache_creation), 0) AS cache_creation,
         COALESCE(SUM(cost_usd), 0)      AS cost_usd
  FROM usage_events`;

function toTotals(row: TotalsRow): UsageTotals {
  return {
    calls: row.calls,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheRead: row.cache_read ?? 0,
    cacheCreation: row.cache_creation ?? 0,
    costUsd: row.cost_usd ?? 0,
  };
}

/** 某一次运行（run）的用量合计。对账用：它应当与 ask_records 里那一行完全相等。 */
export function sumUsageForRun(db: Db, runId: string): UsageTotals {
  const row = db
    .prepare(`${TOTALS_SELECT} WHERE run_id = ?`)
    .get(runId) as unknown as TotalsRow;
  return toTotals(row);
}

/** 全库合计。`since`（ISO 时间串）可限定起始时间。 */
export function sumUsageTotal(db: Db, since?: string): UsageTotals {
  const row =
    since === undefined
      ? (db.prepare(TOTALS_SELECT).get() as unknown as TotalsRow)
      : (db.prepare(`${TOTALS_SELECT} WHERE created_at >= ?`).get(since) as unknown as TotalsRow);
  return toTotals(row);
}

/**
 * 某个人的用量合计（「我的用量」页用）。
 *
 * 【注意 `user_id IS NULL` 的行不计入任何人】阶段 1–3 的调用没有归属
 *   （`usage_events.user_id` 为 NULL），所以"我的合计"会**小于**全库合计。
 *   这是对的：那些调用不是这个人做的，把它们算进来就是替他记账。
 */
export function sumUsageForUser(db: Db, userId: string, since?: string): UsageTotals {
  const row =
    since === undefined
      ? (db.prepare(`${TOTALS_SELECT} WHERE user_id = ?`).get(userId) as unknown as TotalsRow)
      : (db
          .prepare(`${TOTALS_SELECT} WHERE user_id = ? AND created_at >= ?`)
          .get(userId, since) as unknown as TotalsRow);
  return toTotals(row);
}

/** 按 run 汇总的一行。CLI 拿它和 ask_records 逐行比对。 */
export interface UsageRunTotals extends UsageTotals {
  /** 属于某次问答的运行；裸模型调用（不属于任何 run）汇总成 null 那一行 */
  runId: string | null;
  firstAt: string;
  lastAt: string;
}

interface RunTotalsRow extends TotalsRow {
  run_id: string | null;
  first_at: string;
  last_at: string;
}

/**
 * 按 run 汇总，最近的在前面。
 *
 * 排序按 `last_at` 而不是 `first_at`：一次问答的调用跨几分钟，
 * 按开始时间排会让"刚开始的长问答"永远压在最上面。
 */
export function listUsageByRun(db: Db, limit: number): UsageRunTotals[] {
  const rows = db
    .prepare(
      `SELECT run_id,
              MIN(created_at) AS first_at,
              MAX(created_at) AS last_at,
              COUNT(*)                        AS calls,
              COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_read), 0)    AS cache_read,
              COALESCE(SUM(cache_creation), 0) AS cache_creation,
              COALESCE(SUM(cost_usd), 0)      AS cost_usd
       FROM usage_events
       GROUP BY run_id
       ORDER BY last_at DESC
       LIMIT ?`,
    )
    .all(limit) as unknown as RunTotalsRow[];
  return rows.map((row) => ({
    ...toTotals(row),
    runId: row.run_id,
    firstAt: row.first_at,
    lastAt: row.last_at,
  }));
}

// ── 阶段 6：用量治理（按人 / 按本地日）──────────────────────────

/** 按人分组的一行。`userId` 为 null = 阶段 1–3 的无归属调用，自成一桶。 */
export interface UsageByUser {
  userId: string | null;
  /** 显示名；查不到（无归属、或用户行不在）时为 null，由契约层给兜底文案。 */
  displayName: string | null;
  totals: UsageTotals;
}

/**
 * 按人汇总，花得多的在前。
 *
 * 【为什么 `user_id IS NULL` 要自成一桶，而不是 JOIN 掉】
 *   阶段 1–3 的调用没有归属（登录还没做），它们的 token 是**真的花掉了**。
 *   丢掉这一桶，报表的总数就与 `sumUsageTotal` 对不上 —— 而"两个数字对不上"
 *   是这类报表最要命的失败：看的人会开始怀疑每一个数，包括对的那个。
 *   所以单独列出，界面上写明"未记录归属（阶段 1–3）"。（同 sumUsageForUser 的口径：
 *   这些调用不计入任何人的"我的用量"。）
 *
 * 【排序为什么用表达式而不是列别名】`cost_usd` 既是目标列又是 SUM 的别名，
 *   写 `ORDER BY cost_usd` 依赖 SQLite"别名优先"的取值顺序 —— 换成表达式就
 *   没有歧义，读的人也不用去查这条规则。
 */
export function sumUsageByUser(db: Db, since?: string): UsageByUser[] {
  const where = since === undefined ? '' : 'WHERE e.created_at >= ?';
  const rows = db
    .prepare(
      `SELECT e.user_id                     AS user_id,
              u.display_name                AS display_name,
              COUNT(*)                      AS calls,
              COALESCE(SUM(e.input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(e.output_tokens), 0) AS output_tokens,
              COALESCE(SUM(e.cache_read), 0)    AS cache_read,
              COALESCE(SUM(e.cache_creation), 0) AS cache_creation,
              COALESCE(SUM(e.cost_usd), 0)      AS cost_usd
         FROM usage_events e
         LEFT JOIN users u ON u.id = e.user_id
         ${where}
        GROUP BY e.user_id
        ORDER BY COALESCE(SUM(e.cost_usd), 0) DESC,
                 COUNT(*) DESC,
                 e.user_id ASC`,
    )
    .all(...(since === undefined ? [] : [since])) as unknown as (TotalsRow & {
    user_id: string | null;
    display_name: string | null;
  })[];
  return rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    totals: toTotals(row),
  }));
}

/**
 * 把一个 ISO 时间串归到**本地**的那一天（`YYYY-MM-DD`）。
 *
 * 【为什么不用 `substr(created_at, 1, 10)`】那取的是字符串前 10 个字符，
 *   也就是 **UTC 的日**。机器在东八区时，本地 00:00–08:00 的调用其 UTC 时刻
 *   还在前一天 —— 于是"今天花的钱"会把凌晨那几笔记到昨天。同一个坑在
 *   RecentRail 的归月上已经踩过一次（`iso.slice(0,7)` 是 UTC 的月）。
 *   这里统一走 `new Date(iso)` 的**本地**取值法，与那边保持一致。
 */
function dayOf(iso: string): string {
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** 按本地日分组的一行。 */
export interface UsageByDay {
  /** 本地日 `YYYY-MM-DD`。 */
  day: string;
  totals: UsageTotals;
}

/**
 * 按**本地日**汇总，最近的一天在前。
 *
 * 【为什么在 JS 里归桶，不在 SQL 里 GROUP BY】SQLite 无时区概念，
 *   `GROUP BY date(created_at)` 归的是 UTC 日（见 `dayOf` 的说明）。
 *   单实验室的用量流水是几百到几千行，全取出来在 JS 里累加是瞬时的 ——
 *   换来的是"归日"这件事只有一个真相。
 */
export function listUsageByLocalDay(db: Db, since?: string): UsageByDay[] {
  const where = since === undefined ? '' : 'WHERE created_at >= ?';
  const rows = db
    .prepare(
      `SELECT created_at, input_tokens, output_tokens, cache_read, cache_creation, cost_usd
         FROM usage_events ${where}`,
    )
    .all(...(since === undefined ? [] : [since])) as unknown as {
    created_at: string;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read: number | null;
    cache_creation: number | null;
    cost_usd: number | null;
  }[];

  const buckets = new Map<string, UsageTotals>();
  for (const row of rows) {
    const day = dayOf(row.created_at);
    const acc = buckets.get(day) ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheCreation: 0,
      costUsd: 0,
    };
    // 逐行 `?? 0` 与 SQL 的 `COALESCE(SUM(...), 0)` 等价：SUM 本就跳过 NULL，
    // 合计里的 0 表示"这些调用加起来是 0"，与单条流水的 NULL 是两回事。
    acc.calls += 1;
    acc.inputTokens += row.input_tokens ?? 0;
    acc.outputTokens += row.output_tokens ?? 0;
    acc.cacheRead += row.cache_read ?? 0;
    acc.cacheCreation += row.cache_creation ?? 0;
    acc.costUsd += row.cost_usd ?? 0;
    buckets.set(day, acc);
  }

  return [...buckets.entries()]
    .map(([day, totals]) => ({ day, totals }))
    .sort((a, b) => b.day.localeCompare(a.day));
}
