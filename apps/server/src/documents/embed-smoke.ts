/**
 * 向量化冒烟测试：确认模型能加载、能出 1024 维向量、语义相似度方向正确。
 *
 * 用法：npm run embed-smoke -w @knowpilot/server
 *
 * 为什么值得单独有一个：模型加载失败、维度过不了自检、相似度算反了，
 * 这三种问题的表现都是"能跑但结果是错的"。跑一遍真实的句子对，
 * 比在检索界面里猜要快得多。
 */
import { loadConfig } from '../config.ts';
import { EMBED_DIM, embedTexts, isModelReady } from './embed.ts';

/** 余弦相似度。向量已归一化，点积即余弦。 */
function cos(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`模型目录：${cfg.embedModelDir}/${cfg.embedModelId}`);
  console.log(`模型已就位：${isModelReady(cfg)}\n`);

  const t0 = Date.now();
  const query = '研究生的学位是怎么授予的？';
  const candidates = [
    '学位授予实施细则：符合条件者由学位评定分委员会审议通过后授予硕士学位。',
    '本文提出了 DeepLabv3，使用空洞卷积提取多尺度上下文信息。',
    '实验室耗材采购需先填写申请单，经导师签字后交管理员。',
  ];

  const vectors = await embedTexts(cfg, [query, ...candidates], (done, total) =>
    process.stdout.write(`\r  向量化进度 ${done}/${total}   `),
  );
  console.log(`\n首次加载模型 + 向量化共耗时 ${Date.now() - t0} ms（含模型加载）`);

  const [qv, ...cv] = vectors;
  if (qv === undefined) throw new Error('查询向量为空');
  console.log(`向量维度：${qv.length}（期望 ${EMBED_DIM}）`);
  if (qv.length !== EMBED_DIM) throw new Error('维度不符，模型或配置有问题。');

  console.log('\n相似度（越高越相关）：');
  const scored = candidates.map((text, i) => ({
    text: text.slice(0, 28),
    score: cos(qv, cv[i] ?? new Float32Array()),
  }));
  for (const s of scored.sort((a, b) => b.score - a.score)) {
    console.log(`  ${s.score.toFixed(4)}  ${s.text}…`);
  }

  const best = scored[0];
  if (best === undefined || !best.text.startsWith('学位授予')) {
    throw new Error('最相似的不是学位制度那条，语义方向不对。');
  }
  console.log('\n✓ 三项自检通过：模型可加载、维度正确、语义排序正确。');

  // 第二次调用应明显更快（模型已在内存里），用来确认实例缓存生效。
  const t1 = Date.now();
  await embedTexts(cfg, ['再来一次']);
  console.log(`二次调用耗时 ${Date.now() - t1} ms（应远小于首次，说明模型被复用）`);
}

main().catch((err: unknown) => {
  console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
