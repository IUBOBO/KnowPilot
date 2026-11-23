/**
 * 巡检的命令行入口：`npm run patrol -w @knowpilot/server`
 *
 * 【为什么给它一个命令行入口】定时巡检要等一个周期，而"我刚把某条稿子的
 *   updated_at 改旧了，想确认它到底会不会被判超期"是排查时最常见的动作。
 *   这里跑的是与定时巡检**完全相同**的 `reconcile`，所以它给出的结论与
 *   服务里那份必然一致 —— 不存在"命令行说超期、界面上没有"这种事。
 *
 * 【为什么只读 + 跑巡检，不改库结构】与 usage-cli 同一条约定：迁移是
 *   `npm run migrate` 的事。一个排查命令顺手改库结构，是那种
 *   "跑完才发现库被动了"的意外。
 */
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { countUserQuotas, listRules, listTasks } from './repo.ts';
import { reconcile } from './scan.ts';

function main(): void {
  const cfg = loadConfig();
  const { db } = openDb(cfg.dbPath);

  try {
    console.log('巡检（阶段 6）');
    console.log(`数据库：${cfg.dbPath}`);
    console.log('─'.repeat(78));

    console.log('规则（● 启用 / ○ 停用）：');
    for (const r of listRules(db)) {
      console.log(
        `  ${r.enabled ? '●' : '○'} ${pad(r.status, 22)} ${String(r.thresholdDays).padStart(4)} 天`,
      );
    }

    const summary = reconcile(db, new Date());
    console.log('');
    console.log(
      `本次巡检：新建 ${summary.created} 条，消解 ${summary.resolved} 条，仍待处理 ${summary.stillOpen} 条。`,
    );

    // 运维入口：在库文件所在机器上直接开库的人，本来就能用 sqlite3 把整张表读出来。
    // 与 auth/scope.ts 的 OPERATOR_SCOPE 同一个前提，所以这里直接看全部待办。
    const tasks = listTasks(db, 200, { userId: '', canManageAll: true });
    if (tasks.length > 0) {
      console.log('');
      console.log('待办：');
      for (const t of tasks) {
        console.log(
          `  [${pad(t.status, 10)}] ${pad(t.submissionTitle ?? '（投稿已不存在）', 40)}` +
            `超期 ${String(t.overdueDays).padStart(4)} 天   归属：${t.ownerName ?? '未记录'}`,
        );
      }
    }

    console.log('');
    console.log(
      `配额：${countUserQuotas(db) > 0 ? '已配置' : '未设（本阶段只记录、不阻断）'}`,
    );
  } finally {
    db.close();
  }
}

function pad(s: string, width: number): string {
  return s.length >= width ? `${s} ` : s + ' '.repeat(width - s.length);
}

main();
