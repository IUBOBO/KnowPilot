/**
 * 时间与数字的显示格式。
 *
 * 【为什么抽成一个模块】这几个函数原本在投稿台账、右栏、问答记录三处各有一份
 *   （或即将有）。它们是**显示约定**，不是各页面的业务逻辑：哪天决定日期改
 *   显示成"2026/10/11"，三份拷贝意味着要记得改三处，而漏掉的那一处不会有
 *   任何报错 —— 只会让同一个时间在两个页面上长得不一样。
 *
 * ⚠️ 右栏的「N 天前」**不在这里**：它有一套自己的规则（超过 30 天改显示日期，
 *   因为"37 天前"要心算），与台账的"更新于几天前"不是同一个判断，
 *   合并只会把它们中的一个改错。同名的东西不一定同义。
 */

/** ISO → 本地「2026-10-07 13:30」。解析不出来时原样返回，不吞掉坏数据。 */
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const queryTimeFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function fmtQueryTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : queryTimeFormat.format(date);
}

export function formatAnswerQueryTimes(text: string): string {
  return text.replace(
    /((?:查询时点|查询时间|查询时刻|查询于|截至)[ \t　（(：:*`]*)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))(?!\d)/gu,
    (_match, prefix: string, iso: string) => prefix + fmtQueryTime(iso),
  );
}

/** ISO → 本地「2026-10-07」。空值返回空串，由调用方决定怎么显示。 */
export function fmtDate(iso: string | null): string {
  if (iso === null) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 两个时刻相差几个**本地日历日**（今天 = 0、昨天 = 1）。
 *
 * 【为什么不是 (now - t) / 86400000】那是"满 24 小时"，不是"隔了几个日子"。
 * 东八区 10-18 00:30 看 10-17 23:30 的记录，只过了 1 小时 —— 满 24 小时算出来
 * 是 0（今天），可用户眼里的昨天就是昨天。按本地零点归一后再相减，
 * 跨 DST 的 23/25 小时也由 `round` 吸收。
 *
 * 解析不出来返回 null（由调用方决定说"时间未知"还是干脆不显示）。
 * 未来的时间返回负数（只看时间戳，不推断原因）。
 */
export function localDaysSince(iso: string, now: Date = new Date()): number | null {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** 「今天 / 昨天 / N 天前」；用于"最后核对"这类不带动作的时间戳。 */
export function fmtDaysAgo(iso: string): string {
  const days = localDaysSince(iso);
  if (days === null) return '时间未知';
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}

/** 「今天更新 / 昨天更新 / 更新于 N 天前」；台账与首页共用。 */
export function fmtUpdatedAgo(iso: string): string {
  const days = localDaysSince(iso);
  if (days === null) return '更新时间未知';
  if (days <= 0) return '今天更新';
  if (days === 1) return '昨天更新';
  return `更新于 ${days} 天前`;
}

/** 毫秒 → 「820ms」/「3.4s」/「2分15秒」。用于展示一次问答的墙钟耗时。 */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}分${Math.round(s - m * 60)}秒`;
}
