/**
 * 独立迁移命令：npm run migrate
 *
 * 与启动时自动迁移并存，用途不同：
 *   · 部署时先单独跑迁移，确认成功再启动服务 —— 迁移失败不会导致
 *     服务处于"半启动"状态。
 *   · 也方便在 CI 里对迁移脚本做验证。
 */
import { loadConfig } from './config.ts';
import { openDb } from './db/index.ts';

const cfg = loadConfig();
const { db, migration } = openDb(cfg.dbPath);

console.log(`数据库：${cfg.dbPath}`);
console.log(`结构版本：v${migration.fromVersion} -> v${migration.toVersion}`);
if (migration.applied.length === 0) {
  console.log('没有待应用的迁移，数据库已是最新。');
} else {
  for (const m of migration.applied) console.log(`  + ${m}`);
}
db.close();
