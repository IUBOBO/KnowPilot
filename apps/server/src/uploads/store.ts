/**
 * 分片在磁盘上的读写。
 *
 * 【为什么"收到了哪些片"不存数据库】见迁移 v11：分片是**磁盘上的事实**，
 * 数据库里的记录只是它的影子。两者一旦不同步（进程被杀、写盘报错、
 * 有人手删了目录），就会出现"库里说收齐了、磁盘上少一片"——拼出来的文件
 * 长度正常、内容是错的，而这是最难发现的一类损坏。所以这里的原则是：
 * **每次问磁盘**。目录扫描一次几毫秒，而一次静默的文件损坏赔不起。
 */
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { AppError } from '@knowpilot/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { chunkPath, dedupeName, incomingDir, resolveStoredFile, toPosixRelative } from './layout.ts';
import { listStalePending, markAborted, type SessionRow } from './repo.ts';

/** 分片暂存文件名 → 序号。认不出的名字（手写的、别人放的）一律忽略。 */
const PART_NAME = /^(\d{6})\.part$/u;

const TMP_SUFFIX = '.writing';

/**
 * 某一片应有的字节数。除了最后一片，每片都是完整的一块。
 *
 * 【为什么要算出来而不是"有多少算多少"】弱网下最典型的失败是"传了一半断了"，
 * 而连接断掉时 `Content-Length` 与实际收到的字节数**不一致但不会报错**——
 * 于是磁盘上留下一个半片。如果不去比这个数，它会被当成"已收到"，
 * 拼出来的文件长度恰好还可能是对的（少了的字节由后面的片补上），
 * 而内容是错位的。比对成本是一次整数运算。
 */
export function expectedChunkBytes(row: SessionRow, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= row.chunkCount) {
    throw new AppError(
      'invalid_argument',
      `分片序号 ${index} 超出范围（0 ~ ${row.chunkCount - 1}）。`,
    );
  }
  const last = chunkCountTail(row);
  return index === row.chunkCount - 1 ? last : row.chunkSize;
}

/** 最后一片的字节数（也是唯一可能不是整块的那一片）。 */
function chunkCountTail(row: SessionRow): number {
  const full = row.chunkSize * (row.chunkCount - 1);
  const tail = row.totalBytes - full;
  // 总字节恰好是 chunkSize 的整数倍时，chunkCount 会多算一片出来（见上层
  // 的 ceil），此时最后一片是满的。用 max 而不是相信 tail：一个 0 字节的
  // 尾片会让"收齐了"永远差一片。
  return tail > 0 ? tail : row.chunkSize;
}

/**
 * 扫暂存目录，回答"现在收到了哪些片、共多少字节"。
 *
 * 只认**长度正好**的分片：一个半片不是"收到了一部分"，是"没收到"。
 * 返回的 received 已排序，前端可直接据此决定从哪续。
 */
export function listReceived(
  cfg: AppConfig,
  row: SessionRow,
): { received: number[]; receivedBytes: number } {
  const dir = incomingDir(cfg, row.id);
  if (!existsSync(dir)) return { received: [], receivedBytes: 0 };

  const received: number[] = [];
  let receivedBytes = 0;
  for (const name of readdirSync(dir)) {
    const m = PART_NAME.exec(name);
    if (m === null) continue;
    const index = Number.parseInt(m[1] as string, 10);
    if (index >= row.chunkCount) continue; // 换过文件大小留下的旧片，不算数

    const full = join(dir, name);
    let size: number;
    try {
      size = statSync(full).size;
    } catch {
      continue; // 扫的过程中被删了（并发的 abort），跳过即可
    }
    if (size !== expectedChunkBytes(row, index)) continue;

    received.push(index);
    receivedBytes += size;
  }

  received.sort((a, b) => a - b);
  return { received, receivedBytes };
}

/**
 * 落一片。先写 `.writing` 再 rename 成正式名。
 *
 * 【为什么不能直接往最终名字里写】`writeFileSync` 到一半进程被杀，
 * 磁盘上留下的是一个**存在但内容不全**的文件，而下次扫描会把它当成
 * "已收到"（大小不对时才会被上面那道检查拦下，但大小恰好对不上才是常态，
 * 对得上才是巧合）。rename 在同一文件系统内是原子的：正式名一旦出现，
 * 内容必然完整。
 */
export function putChunk(cfg: AppConfig, row: SessionRow, index: number, body: Buffer): void {
  const expected = expectedChunkBytes(row, index);
  if (body.length !== expected) {
    throw new AppError(
      'invalid_argument',
      `第 ${index} 片大小不对：收到 ${body.length} 字节，按 ${row.totalBytes} 总长算应当是 ${expected} 字节。` +
        `整片重传这一片即可（不要只补传剩下的部分）。`,
    );
  }

  const dir = incomingDir(cfg, row.id);
  mkdirSync(dir, { recursive: true });

  const tmp = `${chunkPath(dir, index)}${TMP_SUFFIX}`;
  const final = chunkPath(dir, index);
  writeFileSync(tmp, body);
  renameSync(tmp, final);
}

export interface AssemblyResult {
  /** 相对 DATA_ROOT 的 POSIX 路径（存库用） */
  storedPath: string;
  /** 最终落盘的**真实**文件名，可能与请求里的不同（重名时加了序号） */
  fileName: string;
  byteSize: number;
  sha256: string;
}

/**
 * 按序拼装并落位。
 *
 * 全程只读已存在的分片、往新建的 `assembling.bin` 里写，最后**一个 rename** 落位。
 * 所以任何一步失败，目标目录里都不会出现半截文件 —— 顶多留下一个
 * `assembling.bin`，它在下一次清理时被一起删掉（它不以 `.part` 结尾，
 * 永远不会被当成有效分片）。
 *
 * 【为什么边拼边算 sha256 而不是拼完再读一遍】数据集是几十 GB，
 * 再读一遍就是再走一次磁盘 I/O，而这一遍**完全不影响结果**（sha 是流式的）。
 * 代价是逻辑上多一个状态量，收益是完成时间砍掉近一半。
 */
export async function assembleAndPlace(
  cfg: AppConfig,
  row: SessionRow,
  dir: string,
): Promise<AssemblyResult> {
  const incoming = incomingDir(cfg, row.id);
  const { received } = listReceived(cfg, row);
  if (received.length !== row.chunkCount) {
    const missing = missingChunks(received, row.chunkCount);
    throw new AppError(
      'invalid_argument',
      `还差 ${missing.length} 片才能拼装（差第 ${missing.slice(0, 10).join('、')} 片）。`,
    );
  }

  mkdirSync(dir, { recursive: true });
  const finalName = dedupeName(row.fileName, (name) => existsSync(join(dir, name)));
  const finalAbs = join(dir, finalName);
  const staging = join(incoming, 'assembling.bin');

  const hash = createHash('sha256');
  const out = createWriteStream(staging);
  let written = 0;
  try {
    for (let i = 0; i < row.chunkCount; i += 1) {
      const buf = readFileSync(chunkPath(incoming, i));
      hash.update(buf);
      written += buf.length;
      if (!out.write(buf)) await once(out, 'drain');
    }
  } catch (err) {
    out.destroy();
    throw err;
  }
  await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));

  if (written !== row.totalBytes) {
    // 走到这里说明上面的逐片长度检查漏了。宁可当场失败，也不要 rename 一个
    // 长度不对的文件 —— 它一旦落位，之后谁也说不清它是怎么来的。
    rmSync(staging, { force: true });
    throw new AppError(
      'invalid_argument',
      `拼装结果 ${written} 字节，与约定的 ${row.totalBytes} 字节不符，已丢弃。请重新上传。`,
    );
  }

  renameSync(staging, finalAbs);
  rmSync(incoming, { recursive: true, force: true });

  return {
    storedPath: toPosixRelative(cfg, finalAbs),
    fileName: finalName,
    byteSize: written,
    sha256: hash.digest('hex'),
  };
}

function missingChunks(received: readonly number[], chunkCount: number): number[] {
  const have = new Set(received);
  const missing: number[] = [];
  for (let i = 0; i < chunkCount; i += 1) if (!have.has(i)) missing.push(i);
  return missing;
}

/**
 * 丢掉一个会话在磁盘上的全部分片（**幂等**：目录不在也算成功）。
 *
 * 这也是"文件去哪儿了"这个问题的答案：放弃上传时字节就没了，
 * 不会在 `.incoming` 里越堆越多。
 */
export function discardChunks(cfg: AppConfig, id: string): number {
  const dir = incomingDir(cfg, id);
  if (!existsSync(dir)) return 0;
  let n = 0;
  try {
    for (const name of readdirSync(dir)) if (PART_NAME.test(name)) n += 1;
  } catch {
    // 数不出来不影响删除，下面照样删
  }
  rmSync(dir, { recursive: true, force: true });
  return n;
}

/**
 * 启动时清理久未活动的未完成会话。
 *
 * 【为什么放在启动时而不是定时器】这是一个只有单人运维的小服务，
 * 常驻定时器要为它引入生命周期管理（进程退出、热重载时重复注册），
 * 而清理本身不是急事 —— 迟一天清理只是多占一天磁盘。
 * 启动时跑一次，语义简单到不会出错。
 *
 * 用 `updated_at` 而不是 `created_at` 判"久未活动"：一个传了三天、
 * 但每小时都在续传的会话不该被清掉。
 */
export function sweepStaleSessions(cfg: AppConfig, db: Db, now: Date): number {
  const cutoffMs = now.getTime() - cfg.uploadSessionTtlDays * 24 * 60 * 60 * 1000;
  const stale = listStalePending(db, new Date(cutoffMs).toISOString());
  let cleaned = 0;
  for (const row of stale) {
    discardChunks(cfg, row.id);
    if (markAborted(db, row.id, now.toISOString())) cleaned += 1;
  }
  return cleaned;
}

/** 暂存目录本身的绝对路径，给"磁盘用量"一类的只读展示用。 */
export function incomingRoot(cfg: AppConfig): string {
  return join(cfg.dataRoot, '.incoming');
}

/** 落盘路径是否真的躺在磁盘上（complete 之后核对一次）。 */
export function storedFileExists(cfg: AppConfig, storedPath: string): boolean {
  return existsSync(resolveStoredFile(cfg, storedPath));
}
