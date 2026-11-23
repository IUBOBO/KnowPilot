/**
 * 文本向量化（Embedding）—— 把一段文字变成 1024 个数字。
 *
 * 用本地 BGE-M3 的 ONNX 权重推理（决策 8），不调云端 API：
 *   1. 知识库内容不出网。决策 4 虽然允许上云，但"能本地算的就在本地算"，
 *      少一份数据外发就少一份风险，也不占云端额度。
 *   2. 不依赖网络，断网也能检索。
 *   3. 不产生按量计费。
 *
 * 三条必须守住的规矩：
 *   · 模型【只能】从本地目录加载（allowRemoteModels = false）。开着远程加载的话，
 *     模型文件一旦缺失，它会去连 HuggingFace —— 而这台机器连不上（实测），
 *     表现是"卡住几分钟然后报一个看不懂的网络错"，远不如直接说"模型没下载"。
 *   · 加载失败【不能】让服务起不来。关键词检索是能用的，语义检索是可选的增强项，
 *     缺模型就退化成关键词检索并明确告知，而不是整个项目打不开。
 *   · 向量必须带模型标识落库。不同模型的向量空间不可比，混在一起算相似度
 *     不会报错，只会让排序变成噪音。
 */
import { existsSync } from 'node:fs';
import { env, pipeline } from '@huggingface/transformers';
import { embeddingModelKey, onnxPath, type AppConfig } from '../config.ts';

/** BGE-M3 的稠密向量维度。与 config.json 的 hidden_size 一致。 */
export const EMBED_DIM = 1024;

/**
 * 每次送入模型的文本条数。
 * 取 16 而不是一次全给：一份 246 页的文档有几百个块，一次性喂进去会让
 * 进度长时间不动（看起来像卡死），且峰值内存高得多。16 条大约几秒一批，
 * 进度可见，失败时也只损失一批。
 */
const BATCH_SIZE = 16;

type Extractor = (
  texts: string[],
  options: { pooling: 'cls'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/** 进程内唯一实例。加载一次要几秒 + 数百 MB 内存，绝不能每次调用都重建。 */
let extractorPromise: Promise<Extractor> | null = null;
let loadedKey: string | null = null;

/** 模型是否已下载到本地。没下载时语义检索整体不可用（关键词检索不受影响）。 */
export function isModelReady(cfg: AppConfig): boolean {
  return existsSync(onnxPath(cfg));
}

/**
 * 取（或初始化）模型。首次调用会加载权重，耗时数秒。
 *
 * 失败后会把 promise 清空：否则一次失败（比如加载时内存不足）
 * 会被永久缓存，之后即使条件恢复也永远起不来，必须重启进程才行。
 */
async function getExtractor(cfg: AppConfig): Promise<Extractor> {
  const key = embeddingModelKey(cfg);
  if (loadedKey !== null && loadedKey !== key) {
    // 模型配置变了（比如从 q8 换成 fp16）。旧实例不能复用，
    // 否则算出来的向量标着新模型名、实际是旧模型的结果。
    extractorPromise = null;
    loadedKey = null;
  }

  if (extractorPromise === null) {
    env.localModelPath = cfg.embedModelDir;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.cacheDir = cfg.hfHome;

    loadedKey = key;
    // 注意 pooling / normalize 是【调用时】的参数，不能写在这里（见下面的 embedTexts）。
    // 写在这里不会报错，但会被静默忽略 —— 于是拿到的是未池化的 [1, 序列长, 1024]，
    // 维度对不上任何东西，而唯一的征兆只是"相似度看着不太对"。
    extractorPromise = pipeline('feature-extraction', cfg.embedModelId, {
      dtype: cfg.embedDtype,
    }).then((p) => p as unknown as Extractor);
    extractorPromise.catch(() => {
      extractorPromise = null;
      loadedKey = null;
    });
  }
  return extractorPromise;
}

/**
 * 把一批文本转成向量。
 *
 * onProgress 每批回调一次，用于给上传界面/命令行报进度 ——
 * 几万个块跑起来要几分钟，没有进度用户会以为卡死。
 */
export async function embedTexts(
  cfg: AppConfig,
  texts: readonly string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor(cfg);

  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    // pooling: 'cls' —— 取首 token 的向量。BGE-M3 的稠密检索就是这么定义的，
    //   用 mean（平均）会得到明显更差的结果，而且不会报错。
    // normalize: true —— 输出做 L2 归一化。归一化之后余弦相似度就等于点积，
    //   检索时省掉每次算模长的开销。
    const result = await extractor(batch, { pooling: 'cls', normalize: true });
    for (const row of result.tolist()) out.push(Float32Array.from(row));
    onProgress?.(Math.min(i + BATCH_SIZE, texts.length), texts.length);
  }

  if (out.length !== texts.length) {
    throw new Error(`向量条数与文本条数不一致：${out.length} vs ${texts.length}`);
  }
  return out;
}

/** 预热：启动时后台调用，把首次加载的几秒开销挪到用户点搜索之前。 */
export function warmUp(cfg: AppConfig): void {
  if (!isModelReady(cfg)) return;
  void getExtractor(cfg);
}

/**
 * 向量 → 字节串。
 *
 * 显式按【小端】写：直接用 Float32Array 的内存视图虽然更快，但那依赖
 * 运行机器的字节序，一旦在大小端不同的机器间传数据就会解出一堆乱码数字，
 * 且不报错。写死小端让这个格式在任何平台都一致。
 */
export function vecToBlob(vec: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i += 1) buf.writeFloatLE(vec[i] ?? 0, i * 4);
  return buf;
}

/** 字节串 → 向量。长度不符时直接抛错，不让乱码数字悄悄流进排序环节。 */
export function blobToVec(blob: Uint8Array, dim: number): Float32Array {
  if (blob.byteLength !== dim * 4) {
    throw new Error(`向量字节数 ${blob.byteLength} 与维度 ${dim} 不符（应为 ${dim * 4}）。`);
  }
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i += 1) out[i] = buf.readFloatLE(i * 4);
  return out;
}
