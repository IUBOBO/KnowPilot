/**
 * Cross-Encoder 重排（V3 / R2，实验，默认关闭）。
 *
 * 【它解决的是哪一段】RRF 用两路**名次**融合，不做"查询与这段原文是否真的相关"
 *   的判断。当正确候选已经被召回、但排在 RRF 的第 8 名之后时，重排能把它们提上来；
 *   正确候选**根本没被召回**时，重排无能为力 —— 召回与排序必须分开度量。
 *
 * 【三条必须守住的规矩，与 embedding 同构】
 *   · 只从本地目录加载（allowRemoteModels = false）：模型缺失去连 HuggingFace，
 *     在这台机器上的表现是"卡几分钟然后报一个看不懂的网络错"。
 *   · 加载/推理失败不能让检索失败：回退 RRF，并把 fallbackReason 写进响应。
 *   · 模型标识进 key：换档位后不能复用旧实例，否则标着新模型名、实际跑旧权重。
 *
 * 【为什么自己串行化】ONNX CPU 推理会吃满多核；两个请求同时跑不会更快，
 *   只会让两个请求都变慢、且峰值内存翻倍。用一条 promise 链把推理串起来，
 *   超时的请求放弃等待，但它的推理仍在后台跑完再轮到下一个。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env,
} from '@huggingface/transformers';
import { EMBED_ONNX_FILE, type AppConfig } from '../config.ts';

/** 一次前向的 pair 数。8 条在 CPU 上约几百毫秒，足够摊平固定开销。 */
const BATCH_SIZE = 8;

/** XLM-R 的位置上限是 514；留 2 位给特殊 token。 */
const MAX_LENGTH = 512;

export class RerankUnavailableError extends Error {}

interface TokenizerLike {
  (
    text: string[],
    options: {
      text_pair: string[];
      padding: true;
      truncation: true;
      max_length: number;
    },
  ): Promise<Record<string, unknown>>;
}

interface ModelLike {
  (inputs: Record<string, unknown>): Promise<{ logits: { tolist(): number[][] } }>;
}

interface Reranker {
  tokenizer: TokenizerLike;
  model: ModelLike;
}

let rerankerPromise: Promise<Reranker> | null = null;
let loadedKey: string | null = null;

/** 推理串行队列：尾部永远是一个已 settle 的 promise。 */
let queue: Promise<unknown> = Promise.resolve();

export function rerankModelKey(cfg: AppConfig): string {
  return `${cfg.rerankModelId}-${cfg.rerankDtype}`;
}

/** 权重文件绝对路径。用于"模型是否已下载"的判断。 */
export function rerankOnnxPath(cfg: AppConfig): string {
  return join(
    cfg.embedModelDir,
    cfg.rerankModelId,
    'onnx',
    `${EMBED_ONNX_FILE[cfg.rerankDtype]}.onnx`,
  );
}

export function isRerankModelReady(cfg: AppConfig): boolean {
  return existsSync(rerankOnnxPath(cfg));
}

/**
 * 取（或初始化）模型。首次调用加载权重，耗时数秒。
 *
 * 失败后清空 promise：一次 OOM 不应让后续所有请求永久失败。
 */
async function getReranker(cfg: AppConfig): Promise<Reranker> {
  const key = rerankModelKey(cfg);
  if (loadedKey !== null && loadedKey !== key) {
    rerankerPromise = null;
    loadedKey = null;
  }

  if (rerankerPromise === null) {
    if (!isRerankModelReady(cfg)) {
      throw new RerankUnavailableError(
        '重排模型尚未下载：运行 npm run fetch-reranker-model -w @knowpilot/server。',
      );
    }
    // 与 embed.ts 同一组设置：本地模型根目录、禁止远程、缓存也在 E 盘。
    env.localModelPath = cfg.embedModelDir;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.cacheDir = cfg.hfHome;

    loadedKey = key;
    rerankerPromise = (async () => {
      const tokenizer = (await AutoTokenizer.from_pretrained(
        cfg.rerankModelId,
      )) as unknown as TokenizerLike;
      const model = (await AutoModelForSequenceClassification.from_pretrained(
        cfg.rerankModelId,
        { dtype: cfg.rerankDtype },
      )) as unknown as ModelLike;
      return { tokenizer, model };
    })();
    rerankerPromise.catch(() => {
      rerankerPromise = null;
      loadedKey = null;
    });
  }
  return rerankerPromise;
}

/**
 * 给「查询, 候选原文」逐对打分。分数越大越相关（单标签 Cross-Encoder 的 logit）。
 *
 * @throws RerankUnavailableError 模型缺失、加载失败、推理报错或超时。
 */
export async function scorePassages(
  cfg: AppConfig,
  query: string,
  passages: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<number[]> {
  if (passages.length === 0) return [];

  const timeoutMs = options.timeoutMs ?? cfg.rerankTimeoutMs;
  const work = (async (): Promise<number[]> => {
    const { tokenizer, model } = await getReranker(cfg);
    const scores: number[] = [];

    for (let i = 0; i < passages.length; i += BATCH_SIZE) {
      const batch = passages.slice(i, i + BATCH_SIZE);
      // 顺序必须是 (query, passage)：BGE reranker 按这个方向训练。
      // 反过来也能跑、不报错，只是分数没有意义 —— 一个静默的排序错误。
      const queries = batch.map(() => query);
      const inputs = await tokenizer(queries, {
        text_pair: [...batch],
        padding: true,
        truncation: true,
        max_length: MAX_LENGTH,
      });
      const output = await model(inputs);
      const rows = output.logits.tolist();
      for (const row of rows) {
        // [batch, 1] 是常见形态；兼容 [batch]（部分导出版本会压掉维度）。
        const value = Array.isArray(row) ? row[0] : row;
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new RerankUnavailableError('重排模型返回了非数值分数。');
        }
        scores.push(value);
      }
    }
    if (scores.length !== passages.length) {
      throw new RerankUnavailableError(
        `重排分数条数与候选条数不一致：${scores.length} vs ${passages.length}。`,
      );
    }
    return scores;
  })();

  return withTimeout(work, timeoutMs);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RerankUnavailableError(`重排超时（${timeoutMs}ms），已回退 RRF。`));
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(
          err instanceof RerankUnavailableError
            ? err
            : new RerankUnavailableError(
                `重排失败：${err instanceof Error ? err.message : String(err)}`,
              ),
        );
      },
    );
  });
}

/**
 * 在串行队列里跑一次打分。超时只放弃等待，推理本身仍在后台跑完 ——
 * ONNX 推理没有取消接口；直接并发下一条会让两个前向互相抢 CPU。
 */
export function scorePassagesQueued(
  cfg: AppConfig,
  query: string,
  passages: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<number[]> {
  const run = queue.then(
    () => scorePassages(cfg, query, passages, options),
    () => scorePassages(cfg, query, passages, options),
  );
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
