/**
 * 下载 Embedding 模型权重到本地缓存目录。
 *
 * 用法：npm run fetch-model -w @knowpilot/server
 *
 * 为什么不用 transformers.js 自带的自动下载：
 *   它的自动下载走 HuggingFace（或由 HF_ENDPOINT 指定的镜像），而实测这台机器
 *   hf-mirror.com 与 huggingface.co **都连不上**（DNS 能解析、TCP 被拦），
 *   自动下载会卡到超时，报错还只说"连不上"。此处改用 ModelScope ——
 *   同一份 Xenova/bge-m3 仓库在那边有镜像，实测 13 MB/s。
 *   下载与推理分开之后，模型只需拉一次，之后完全离线可用。
 *
 * 下载细节（断点续传、大小校验）在 `model-fetch.ts`，与 reranker 下载共用。
 */
import { join } from 'node:path';
import { EMBED_ONNX_FILE, loadConfig } from './config.ts';
import { downloadRepoFile, fetchRepoFileSizes } from './model-fetch.ts';

/** ModelScope 上的模型仓库。与 HuggingFace 的 Xenova/bge-m3 是同一份内容。 */
const REPO = 'Xenova/bge-m3';

/** 无论什么精度都要的文件：模型结构 + 分词器。少一个都加载不起来。 */
const COMMON_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
];

async function main(): Promise<void> {
  const cfg = loadConfig();
  const target = join(cfg.embedModelDir, cfg.embedModelId);

  console.log(`模型仓库：${REPO}（ModelScope 镜像）`);
  console.log(`精度档位：${cfg.embedDtype}`);
  console.log(`落地目录：${target}\n`);

  const sizes = await fetchRepoFileSizes(REPO);

  const wanted = [
    ...COMMON_FILES,
    `onnx/${EMBED_ONNX_FILE[cfg.embedDtype]}.onnx`,
    // fp32 档的权重被拆成了「结构 + 外部数据」两个文件，缺一不可。
    ...(cfg.embedDtype === 'fp32' ? ['onnx/model.onnx_data'] : []),
  ];

  for (const path of wanted) {
    const expected = sizes.get(path);
    if (expected === undefined) {
      throw new Error(
        `仓库里找不到 ${path}（精度档位 ${cfg.embedDtype}）。` +
          `可以改 .env 里的 EMBED_DTYPE 试试 q8 / fp16 / fp32。`,
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
