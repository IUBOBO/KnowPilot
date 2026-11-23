/**
 * 导入本地期刊分区 JSON。默认保留已有的人工录入。
 * 用法：npm run seed-journals -w @knowpilot/server -- --file path/to/journals.json
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { importSeed, readSeedFile } from './seed/import.ts';

function main(): void {
  const { values } = parseArgs({
    options: { file: { type: 'string' }, force: { type: 'boolean', default: false } },
  });
  if (!values.file) {
    throw new Error('请用 --file 指定已获授权的期刊分区 JSON 文件。');
  }
  const force = values.force;
  const seed = readSeedFile(resolve(process.env['INIT_CWD'] ?? process.cwd(), values.file));

  const cfg = loadConfig();
  const { db, migration } = openDb(cfg.dbPath);

  const summary = importSeed(db, seed, new Date().toISOString(), { force });

  console.log(`数据来源：${seed.meta.dataset}（${seed.meta.sourceUrl}）`);
  console.log(`筛选口径：${seed.meta.filter}，生成于 ${seed.meta.generatedAt}`);
  if (seed.meta.jcrMissing !== undefined && seed.meta.jcrMissing > 0) {
    // 如实报出来：这些刊在 JCR 原始表里就查不到，不是导入漏了。
    console.log(`（其中 ${seed.meta.jcrMissing} 本刊在 JCR 原始表里没有，只导入了中科院分区。）`);
  }
  console.log(`库：${cfg.dbPath}（schema v${migration.toVersion}）${force ? '  [--force]' : ''}`);
  console.log('');
  console.log(
    `期刊：新建 ${summary.journalsCreated} 本，复用已有 ${summary.journalsReused} 本`,
  );
  console.log(
    `分区：共 ${summary.totalRankings} 条 —— 新增 ${summary.outcomes.created}、` +
      `更新 ${summary.outcomes.updated}、未变 ${summary.outcomes.unchanged}、` +
      `跳过 ${summary.outcomes.kept_local}（本地是人工录入或联网来的，未被覆盖）`,
  );

  db.close();
}

main();
