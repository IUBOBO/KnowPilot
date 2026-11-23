/**
 * ModelScope 模型文件下载（embedding 与 reranker 共用）。
 *
 * 【为什么不用 transformers.js 自带的自动下载】见 `fetch-model.ts` 头注释：
 *   本机连不上 huggingface.co，ModelScope 有镜像且实测速度可用。
 *
 * 三个刻意的设计保持原样：
 *   1. 文件大小从仓库 API 现查，不硬编码 —— 上游更新权重时不会静默下到旧文件。
 *   2. 支持断点续传（HTTP Range）。
 *   3. 下完校验字节数，对不上就保留 `.part` 等下次续传。
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MODELSCOPE = 'https://modelscope.cn/api/v1/models';
const REVISION = 'master';

export function human(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function repoFileUrl(repo: string, path: string): string {
  return `${MODELSCOPE}/${repo}/repo?Revision=${REVISION}&FilePath=${encodeURIComponent(path)}`;
}

function apiUrl(repo: string): string {
  return `${MODELSCOPE}/${repo}/repo/files?Revision=${REVISION}&Recursive=true`;
}

/** 从仓库 API 取「文件路径 → 字节数」，用来校验下载结果。 */
export async function fetchRepoFileSizes(repo: string): Promise<Map<string, number>> {
  const res = await fetch(apiUrl(repo));
  if (!res.ok) {
    throw new Error(`取模型文件清单失败：HTTP ${res.status}。请检查网络能否访问 modelscope.cn。`);
  }
  const body = (await res.json()) as {
    Data?: { Files?: { Path: string; Size: number; Type: string }[] };
  };
  const files = body.Data?.Files ?? [];
  return new Map(files.filter((f) => f.Type === 'blob').map((f) => [f.Path, f.Size]));
}

/**
 * 下载单个文件，支持断点续传。
 *
 * 先下到 `.part` 再改名：中途被打断时留下的是一个明确标着"没下完"的文件，
 * 而不是一个看起来正常、实则截断的 .onnx。
 */
export async function downloadRepoFile(
  repo: string,
  path: string,
  dest: string,
  expected: number,
): Promise<void> {
  const tmp = `${dest}.part`;
  let start = 0;

  if (existsSync(tmp)) {
    start = statSync(tmp).size;
    if (start === expected) {
      renameSync(tmp, dest);
      console.log(`  ${path} — 已存在，跳过`);
      return;
    }
    if (start > expected) {
      // 残留下载比目标还大，只可能是上次的文件已经换了。重下。
      unlinkSync(tmp);
      start = 0;
    }
  } else if (existsSync(dest) && statSync(dest).size === expected) {
    console.log(`  ${path} — 已存在，跳过`);
    return;
  }

  const headers: Record<string, string> = {};
  if (start > 0) headers['Range'] = `bytes=${start}-`;

  const res = await fetch(repoFileUrl(repo, path), { headers });
  if (!res.ok && res.status !== 206) {
    throw new Error(`下载失败：HTTP ${res.status}（${path}）`);
  }

  // 服务端若忽略了 Range 而返回 200，说明它给的是整份文件，必须从头写。
  // 不判断这一点会得到"前一半 + 后一半"这种能过大小校验、却完全损坏的文件。
  const appending = start > 0 && res.status === 206;
  if (!appending) start = 0;
  if (res.body === null) throw new Error('响应没有内容体。');

  const name = path.split('/').pop() ?? path;
  let written = start;
  let lastReport = 0;
  mkdirSync(dirname(dest), { recursive: true });

  const sink = createWriteStream(tmp, appending ? { flags: 'a' } : { flags: 'w' });

  // 大文件要能看到进度，否则用户以为卡死了。每 2 秒最多报一次，避免刷屏。
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      written += chunk.length;
      const now = Date.now();
      if (now - lastReport > 2000 || written === expected) {
        lastReport = now;
        const pct = expected > 0 ? ((written / expected) * 100).toFixed(0) : '?';
        process.stdout.write(`\r  ${name}  ${pct}%  ${human(written)} / ${human(expected)}   `);
      }
      done(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(res.body as never), counter, sink);
  process.stdout.write('\n');

  const actual = statSync(tmp).size;
  if (actual !== expected) {
    throw new Error(
      `${name} 下载后大小不符：期望 ${expected} 字节，实际 ${actual} 字节。` +
        `文件已保留为 ${tmp}，重跑本命令会续传。`,
    );
  }
  renameSync(tmp, dest);
}
