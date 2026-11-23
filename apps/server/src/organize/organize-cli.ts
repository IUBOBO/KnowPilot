/**
 * 整理 Agent 的人工验证入口：
 *   `npm run organize -w @knowpilot/server -- <assetId> "把 train 下的图片分出来"`
 *
 * 【这是 B1 里唯一要花模型钱的一步，所以必须人工跑】`verify-organize` 验证的是
 *   匹配、移动、边界这些**确定性**的东西，它不碰模型。而"Agent 会不会先看目录
 *   再拟计划、拟出来的规则和目录里的事实对不对得上"这件事，只有真跑一次才知道。
 *
 * 【为什么只打印计划、不执行】命令行不给"执行"这个动作 —— 移动真实数据这件事
 *   必须经由界面上的预览与二次确认（那是 B 的边界 ② 的落点）。这里把它拟出来的
 *   计划**就地展开成预览**打出来，人看着预览就能判断它拟得对不对。
 */
import { getCodeAsset } from '../code/repo.ts';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { createLabModels } from '../agent/models.ts';
import { expandRules } from './preview.ts';
import { runOrganize } from './run.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const assetId = args[0]?.trim() ?? '';
  const request = args.slice(1).join(' ').trim();

  if (assetId === '' || request === '') {
    console.error('用法：npm run organize -w @knowpilot/server -- <assetId> "把 train 下的图片分出来"');
    console.error('（assetId 是数据集管理页里那条记录，可用 npm run ask 之外的接口列表查）');
    process.exitCode = 1;
    return;
  }

  const cfg = loadConfig();
  const { db } = openDb(cfg.dbPath);
  const models = createLabModels();

  try {
    const asset = getCodeAsset(db, assetId);
    if (asset === null) {
      console.error(`没有 id 为 ${assetId} 的数据集记录。`);
      process.exitCode = 1;
      return;
    }
    if (asset.host !== null && asset.host.trim() !== '') {
      console.error(`这条记录声明它在 ${asset.host} 上，本机不碰它的目录。`);
      process.exitCode = 1;
      return;
    }

    console.log(`数据集：${asset.name}`);
    console.log(`目录：${asset.location}`);
    console.log(`要求：${request}`);
    console.log('─'.repeat(70));

    const started = Date.now();
    const out = await runOrganize(
      { db, config: cfg, models },
      {
        datasetDir: asset.location,
        datasetName: asset.name,
        // 命令行入口视同"使用者已知情"（同 ask-cli）：是开发者本人在自己机器上跑。
        messages: [{ role: 'user', content: request }],
      },
    );

    console.log('');
    console.log(out.reply);
    console.log('');

    if (out.plan === null) {
      console.log('（这轮没有提交计划 —— 它在等你补充信息。）');
      return;
    }

    // 就地展开成预览。执行端用的是同一个 expandRules，所以这里看到的数字
    // 就是界面上会看到的数字。
    const { preview } = expandRules(asset.location, out.plan);

    console.log('─'.repeat(70));
    console.log(`预览：将移动 ${preview.totalMoves} 个文件`);
    for (const r of preview.rules) {
      const flag = r.problem === undefined ? '' : `  ⚠️ ${r.problem}`;
      console.log(`  · ${r.match} → ${r.toDir}/  命中 ${r.matched} 个${flag}`);
      for (const s of r.sample) console.log(`      ${s}`);
    }
    if (preview.createdDirs.length > 0) {
      console.log(`会新建目录：${preview.createdDirs.join('、')}`);
    }
    console.log(`不动：${preview.untouched} 个文件`);
    for (const w of preview.warnings) console.log(`  ⚠️ ${w}`);

    console.log('─'.repeat(70));
    console.log(
      `runId=${out.runId} 规则数=${out.plan.rules.length} 耗时=${Date.now() - started}ms`,
    );
    console.log('（命令行只拟计划、不执行。要真的移动，请在「数据集整理」页里确认执行。）');
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error('\n失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
