/**
 * 数据集上传（阶段 3，大文件进入数据集目录）。
 *
 * 【为什么不能像文档那样一次 POST 完】
 *   文档上限 50 MB（`documents/upload.ts` 的 MAX_BYTES），一次传完无所谓。
 *   数据集是 GB 级：一次 POST 要么网关超时、要么把整个文件读进内存、
 *   要么传了二十分钟断在 90% 只能从零再来。所以拆成分片，一片片传，
 *   断了接着传。
 *
 * 【断点续传真正难的不是分片，是"补上来的是不是原来那份文件"】
 *   只记"哪些分片收到了"的话，用户换了一份压缩包上来、分片号照样对得上，
 *   两个文件就会被拼成一份 —— 而拼出来的文件**大小完全正常**，看不出来。
 *   所以会话 id 由**文件自身的特征**派生（目标目录 + 文件名 + 总字节 +
 *   最后修改时间）：同一个文件重新上传算出同一个 id，天然幂等、天然可续传；
 *   换一份文件 id 就变了，不会错接。
 *
 * 【已知限制，如实记录】
 *   派生键里没有内容哈希。要挡住"同名、同大小、同修改时间但内容不同"
 *   这种情形，得让客户端读一遍整个文件算 SHA-256，而 10 GB 的文件光算哈希
 *   就要好几分钟，用户会以为卡死了。浏览器里 `crypto.subtle.digest`
 *   只支持一次性喂入整块数据，大文件根本用不了。权衡后接受这个残留风险：
 *   它要求两份文件字节数完全一致且修改时间也一致，实际发生概率极低，
 *   而且`complete` 会把整份文件的 sha256 回给调用方，需要时可以对一次账。
 */

import type { CodeAsset } from './code-assets.ts';

/** 会话状态。与其它词表同一口径：**不加 CHECK 约束**，改词表只改代码。 */
export const UPLOAD_STATUSES = ['pending', 'completed', 'aborted'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

/** 一次上传会话。`received` 不是库里的列，是查磁盘算出来的，见 GET /api/v1/uploads/:id。 */
export interface UploadSession {
  id: string;
  /** 目标目录，相对 DATA_ROOT 的 POSIX 相对路径，如 `medical/amos22` */
  targetDir: string;
  fileName: string;
  totalBytes: number;
  /**
   * 分片大小，**由服务端决定并在这里回给客户端**。
   * 客户端不许自己挑：两边算出不同的分片数，最后一片的边界就对不上，
   * 而症状是"永远传不完"——没有一条错误信息会指向真正的原因。
   */
  chunkSize: number;
  /** 分片总数，等于 ceil(totalBytes / chunkSize) */
  chunkCount: number;
  /** 已收到的分片序号，升序。**以磁盘为准**，不是库里的一列 */
  received: readonly number[];
  receivedBytes: number;
  status: UploadStatus;
  /** completed 后才有：最终文件相对 DATA_ROOT 的 POSIX 路径 */
  storedPath: string | null;
  /** completed 后才有：整份文件的 sha256，供调用方自行核对 */
  sha256: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUploadRequest {
  /** 相对 DATA_ROOT 的 POSIX 相对路径，如 `medical/amos22`。不许绝对、不许 `..` */
  targetDir: string;
  /** 纯文件名，不许含路径分隔符 */
  fileName: string;
  totalBytes: number;
  /** 客户端侧的文件最后修改时间（毫秒）。用来把"同名的另一份文件"区分开 */
  lastModifiedMs: number;
}

export interface CreateUploadResponse {
  session: UploadSession;
  /**
   * true = 接上一次没传完的接着传（**不是错误**），false = 新建。
   * 单列一个字段而不是让调用方去比 received 的长度：那是拿数据猜意图。
   */
  resumed: boolean;
}

export interface GetUploadResponse {
  session: UploadSession;
}

/**
 * 还没传完的会话列表（`GET /api/v1/uploads`）。
 *
 * 【为什么要有这个接口，而不是让界面自己去记】
 *   刷新页面之后，浏览器手里什么都没有了 —— `File` 对象活不过一次刷新，
 *   localStorage 也只在同一台机器的同一个浏览器里有效。而**分片就躺在服务器
 *   磁盘上**，那才是"这个文件传到一半了"的唯一事实来源。让界面来读这份事实，
 *   「接着传」才不是一句只在没刷新过的页面上成立的话。
 *
 * 【为什么把 dataRoot / maxBytes 混在列表里】
 *   它们都是"这一屏要用到的服务端事实"：目标目录的绝对前缀（让用户看见文件
 *   究竟落到哪台机器的哪个目录，而不是一个 `medical/amos22` 的相对串），以及
 *   单文件上限（界面在点上传之前就能拦住过大的文件，不用先建一个注定失败的会话）。
 *   单开一个 /uploads/config 只会多一次往返，且两处状态必然会在某次刷新时不同步。
 */
export interface ListUploadsResponse {
  items: readonly UploadSession[];
  /** 数据集根目录的绝对路径，界面上显示"将落到哪里" */
  dataRoot: string;
  /** 单个文件上限（字节），来自 .env 的 UPLOAD_MAX_BYTES */
  maxBytes: number;
}

export interface PutChunkResponse {
  received: readonly number[];
  receivedBytes: number;
}

export interface CompleteUploadRequest {
  /**
   * 落位后要不要登记一条数据集记录（code_assets）。
   *
   * 默认 true：传完就登记，这个数据集才进得了「路径巡检」的射程，Agent
   * 也才查得到它；否则就是一堆"传上去了、此后没人知道它在哪"的文件。
   * 目录已有同名记录时**不新建**，而是返回那一条（见下）。
   */
  register?: boolean;
}

export interface CompleteUploadResponse {
  session: UploadSession;
  /** 落位后的绝对路径，给人看、可复制 */
  storedPath: string;
  byteSize: number;
  sha256: string;
  /** 顺带登记的数据集记录（`register: false` 时为 null） */
  asset: CodeAsset | null;
  /** 登记时那次核对带回的理由；`asset` 为 null 时也为 null */
  reason: string | null;
  /**
   * 是不是**新建**的记录。false = 这个目录本来就登记过，返回了原来那条。
   * 需要这个字段是因为"传了第二个文件进同一个数据集目录"是常规操作，
   * 而每次都新建一条记录会让列表里堆出一串看不出区别的重复项。
   */
  assetCreated: boolean;
}

export interface AbortUploadResponse {
  aborted: { id: string; fileName: string; discardedChunks: number };
}
