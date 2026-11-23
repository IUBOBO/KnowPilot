/**
 * 用量流水的查账入口：`npm run usage -w @knowpilot/server [-- --limit 20]`
 *
 * 【为什么这个入口第一件事是"对账"，而不是"报表"】
 *   统计数字只有在能被独立复算时才有意义。`usage_events` 与 `ask_records` 记的是
 *   同一批事实的两个粒度（每次调用 / 每次问答），所以"按 run 汇总之后两者必须相等"
 *   是一条**代码之外**的判据 —— 它不依赖任何一方自己说对不对。
 *   少了这一步，一个漏记的插入点只会表现为"成本比预想的低"，没人看得出来。
 *
 * 这是 02 号 §2.1 所说的 T4（纯查询，无 Agent）：一次 GROUP BY，不需要模型，
 * 也不该为它建一个 Agent 循环。管理端的用量看板（阶段 6）读的是同一批查询。
 */
import type { AskRecord, RunUsage } from '@knowpilot/shared';
import { listAskRecords } from '../agent/records.ts';
import { OPERATOR_SCOPE } from '../auth/scope.ts';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { listUsageByRun, sumUsageTotal, type UsageRunTotals } from './repo.ts';

const DEFAULT_LIMIT = 10;

function main(): void {
  const limit = parseLimit(process.argv.slice(2));
  const cfg = loadConfig();
  // 只读入口，不跑迁移：迁移是 npm run migrate 的事，
  // 一个查账命令顺手改库结构，是那种"跑完才发现库被动了"的意外。
  const { db } = openDb(cfg.dbPath);

  try {
    console.log('用量流水（C-USAGE）');
    console.log(`数据库：${cfg.dbPath}`);

    const total = sumUsageTotal(db);
    console.log('─'.repeat(78));
    console.log(
      `累计：${total.calls} 次模型调用，输入 ${num(total.inputTokens)} / 输出 ${num(total.outputTokens)}` +
        ` / 缓存读 ${num(total.cacheRead)} / 缓存写 ${num(total.cacheCreation)} tokens` +
        `，费用 $${total.costUsd.toFixed(6)}`,
    );
    if (total.calls === 0) {
      console.log('（还没有任何模型调用被记账。跑一次 npm run ask 就会有了。）');
      return;
    }

    // ask_records 一次性取够：对账只针对"最近这几次运行"，
    // 没必要为了对齐一次而把整张表读进来。
    //
    // 用 OPERATOR_SCOPE 而不是某个用户的范围：这是一个在库文件所在机器上
    // 直接开库的运维入口，对账的对象是**全部**流水，与"谁问的"无关。
    const records = new Map(listAskRecords(db, 200, OPERATOR_SCOPE).map((r) => [r.runId, r]));

    console.log('');
    console.log(`最近 ${limit} 次运行的用量对账：`);
    console.log(
      '  run_id      时间              调用  输入      输出     缓存读    费用         与问答记录',
    );
    for (const run of listUsageByRun(db, limit)) {
      printRun(run, records);
    }
  } finally {
    db.close();
  }
}

function printRun(run: UsageRunTotals, records: Map<string, AskRecord>): void {
  const id = run.runId ?? '(不属于任何问答)';
  const rec = run.runId === null ? undefined : records.get(run.runId);

  let verdict: string;
  if (run.runId === null) {
    // 裸模型调用（smoke 之类）：本来就没有对应的问答记录，不是不一致。
    verdict = '—（裸调用）';
  } else if (rec === undefined) {
    // 有调用流水、却没有问答记录：说明那次问答在写记录之前就没了。
    // 这正是要暴露的情形，不能显示成"一致"。
    verdict = '⚠ 无对应记录';
  } else {
    verdict = sameTotals(run, rec.usage) ? '一致 ✅' : '✗ 不一致';
  }

  console.log(
    `  ${pad(id, 12)}${pad(localTime(run.lastAt), 18)}` +
      `${pad(String(run.calls), 6)}${pad(num(run.inputTokens), 10)}${pad(num(run.outputTokens), 9)}` +
      `${pad(num(run.cacheRead), 10)}${pad(`$${run.costUsd.toFixed(6)}`, 13)}${verdict}`,
  );
}

/**
 * 两边记的是同一批数字，判据就应当是精确相等。
 *
 * 唯一的例外是费用：`usage_events` 是在 SQLite 里按行 SUM 出来的，
 * `ask_records` 是在 JS 里逐次累加的，浮点加法不满足结合律，
 * 末位可能差一个 ULP。用一个极小的容差挡住这个差异，
 * 但**不放大到能掩盖真实问题的程度** —— 漏记一次调用的差值远大于它。
 */
function sameTotals(run: UsageRunTotals, stored: RunUsage): boolean {
  return (
    run.inputTokens === stored.inputTokens &&
    run.outputTokens === stored.outputTokens &&
    run.cacheRead === stored.cacheReadTokens &&
    run.cacheCreation === stored.cacheWriteTokens &&
    Math.abs(run.costUsd - stored.costUsd) < 1e-9
  );
}

function parseLimit(argv: readonly string[]): number {
  const i = argv.indexOf('--limit');
  const raw = i === -1 ? undefined : argv[i + 1];
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
}

/** 落库的是 UTC ISO 串，打起人来按本机时间看更直观。 */
function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 千分位。用量数字动辄上万，不加分隔符没法一眼读出量级。 */
function num(n: number): string {
  return n.toLocaleString('en-US');
}

function pad(s: string, width: number): string {
  // 中文字符在等宽终端里占两列，但这里的字段全是 ASCII，直接按长度补即可。
  return s.length >= width ? `${s} ` : s + ' '.repeat(width - s.length);
}

main();
