/**
 * 下载 Cross-Encoder 重排模型（V3 / R2 实验，默认关闭）。
 *
 * 用法：npm run fetch-reranker-model -w @knowpilot/server
 *
 * 与 `fetch-model.ts` 走同一条 ModelScope 镜像链路、同一套断点续传与大小校验。
 * 模型默认是 `Xenova/bge-reranker-base` 的 q8 档（约 279 MB）；换档位用
 * `RERANK_DTYPE=q8|fp16|fp32`。下载只做一次，之后完全离线。
 */
import { join } from 'node:path';
import { EMBED_ONNX_FILE, loadConfig } from './config.ts';
import { downloadRepoFile, fetchRepoFileSizes } from './model-fetch.ts';

const REPO = 'Xenova/bge-reranker-base';

const COMMON_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
];

async function main(): Promise<void> {
  const cfg = loadConfig();
  const target = join(cfg.embedModelDir, cfg.rerankModelId);

  console.log(`模型仓库：${REPO}（ModelScope 镜像）`);
  console.log(`精度档位：${cfg.rerankDtype}`);
  console.log(`落地目录：${target}\n`);

  const sizes = await fetchRepoFileSizes(REPO);

  const wanted = [
    ...COMMON_FILES,
    // 与 embedding 共用同一张「精度档 → 文件名」表（transformers.js 的内部约定）。
    `onnx/${EMBED_ONNX_FILE[cfg.rerankDtype]}.onnx`,
  ];

  for (const path of wanted) {
    const expected = sizes.get(path);
    if (expected === undefined) {
      throw new Error(
        `仓库里找不到 ${path}（精度档位 ${cfg.rerankDtype}）。` +
          `可以改 RERANK_DTYPE 试试 q8 / fp16 / fp32。`,
      );
    }
    await downloadRepoFile(REPO, path, join(target, ...path.split('/')), expected);
  }

  console.log(`\n完成。模型已就位：${target}`);
  console.log('模型只需下载这一次，之后推理完全离线，不上传任何数据。');
}

main().catch((err: unknown) => {
  console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
