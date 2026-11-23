/**
 * 上传会话的读写。
 *
 * 只碰数据库。分片本身躺着磁盘上，那部分在 store.ts —— 见 migrations v11
 * 顶部的说明：**磁盘是"收到了哪些片"的唯一事实来源**，这张表只存磁盘
 * 答不出来的东西（目标在哪、该多大、分几片、什么状态）。
 */
import type { UploadSession, UploadStatus } from '@knowpilot/shared';
import type { Db } from '../db/index.ts';
import { scopePredicate, type RowScope } from '../auth/scope.ts';

/** 库里的一行。**没有 received** —— 那个要问磁盘。 */
export interface SessionRow {
  id: string;
  targetDir: string;
  fileName: string;
  totalBytes: number;
  chunkSize: number;
  chunkCount: number;
  status: UploadStatus;
  storedPath: string | null;
  sha256: string | null;
  /** 发起这次上传的人。NULL = 阶段 3（还没有登录时）留下的公共历史行。 */
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawRow {
  id: string;
  target_dir: string;
  file_name: string;
  total_bytes: number;
  chunk_size: number;
  chunk_count: number;
  status: string;
  stored_path: string | null;
  sha256: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// snake_case 只在仓库层出现一次（同 documents/repo.ts 的约定）。
function toRow(raw: RawRow): SessionRow {
  return {
    id: raw.id,
    targetDir: raw.target_dir,
    fileName: raw.file_name,
    totalBytes: raw.total_bytes,
    chunkSize: raw.chunk_size,
    chunkCount: raw.chunk_count,
    // 列上没有 CHECK 约束，所以这里不做"枚举校验后抛错" ——
    // 一个认不出的状态该在读取侧被当成异常处理，而不是让整个列表炸掉。
    status: raw.status as UploadStatus,
    storedPath: raw.stored_path,
    sha256: raw.sha256,
    createdBy: raw.created_by,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

const COLUMNS = `id, target_dir, file_name, total_bytes, chunk_size, chunk_count,
                 status, stored_path, sha256, created_by, created_at, updated_at`;

export function getSession(db: Db, id: string): SessionRow | null {
  const raw = db.prepare(`SELECT ${COLUMNS} FROM upload_sessions WHERE id = ?`).get(id);
  return raw === undefined ? null : toRow(raw as unknown as RawRow);
}

/**
 * 新建一个会话。
 *
 * `createdBy` 是**必填**（可以是 null，但必须由调用方明确传）——
 * 让它有默认值的话，漏传一处就是一个"静默变成公共会话"的口子，
 * 而这正是这张表要收掉的那个问题（见 migrations v16）。
 */
export function insertSession(
  db: Db,
  row: Omit<SessionRow, 'status' | 'storedPath' | 'sha256'>,
): void {
  db.prepare(
    `INSERT INTO upload_sessions
       (id, target_dir, file_name, total_bytes, chunk_size, chunk_count,
        status, stored_path, sha256, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?)`,
  ).run(
    row.id,
    row.targetDir,
    row.fileName,
    row.totalBytes,
    row.chunkSize,
    row.chunkCount,
    row.createdBy,
    row.createdAt,
    row.updatedAt,
  );
}

/**
 * 标记完成。
 *
 * 条件里的 `status = 'pending'` 不是装饰：两个 complete 请求同时进来时，
 * 只有先到的那个能改成 completed，后到的 `changes` 为 0 —— 调用方据此
 * 判断"是别人先完成了我"还是"我完成了"。没有这个条件的话，两边都会去
 * 拼装同一个文件，最终写进去哪一份取决于时序。
 */
export function markCompleted(
  db: Db,
  id: string,
  storedPath: string,
  sha256: string,
  now: string,
): boolean {
  const r = db
    .prepare(
      `UPDATE upload_sessions
          SET status = 'completed', stored_path = ?, sha256 = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(storedPath, sha256, now, id);
  return Number(r.changes) > 0;
}

export function markAborted(db: Db, id: string, now: string): boolean {
  const r = db
    .prepare(
      `UPDATE upload_sessions SET status = 'aborted', updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(now, id);
  return Number(r.changes) > 0;
}

/**
 * 把一个已放弃的会话重新变成"可以继续传"。
 *
 * 【为什么复用同一行而不是插一条新的】会话 id 是文件特征派生出来的，
 * 一个文件在一张表里就该只有一行 —— 否则"这个文件现在到底什么状态"又要
 * 靠比较 updated_at 去猜。放弃后又重传，语义上就是同一次上传重来一遍。
 *
 * 一并清空 stored_path / sha256：它们描述的是上一次落位的结果，
 * 留在一个重新变成 pending 的行上就是一句不再成立的旧结论。
 */
export function reopenSession(db: Db, id: string, now: string): void {
  db.prepare(
    `UPDATE upload_sessions
        SET status = 'pending', stored_path = NULL, sha256 = NULL, updated_at = ?
      WHERE id = ? AND status = 'aborted'`,
  ).run(now, id);
}

/** 只挪 updated_at。用来让"这个会话还活着"这件事有据可查，见清理逻辑。 */
export function touchSession(db: Db, id: string, now: string): void {
  db.prepare('UPDATE upload_sessions SET updated_at = ? WHERE id = ?').run(now, id);
}

/**
 * 找出久未活动的未完成会话，供启动时清理。
 *
 * 只挑 `pending`：已完成的会话是**记录**（谁在什么时候传了什么），
 * 它们不占空间，也没有理由删除。清理的是垃圾，不是历史。
 */
export function listStalePending(db: Db, olderThan: string): readonly SessionRow[] {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM upload_sessions
        WHERE status = 'pending' AND updated_at < ?
        ORDER BY updated_at`,
    )
    .all(olderThan);
  return (rows as unknown as RawRow[]).map(toRow);
}

/**
 * 按状态列出会话，最近动过的排前面。
 *
 * `updated_at DESC` 而不是 `created_at`：用户要接着传的，是**最后一次动过**的那个，
 * 而一个三天前建、五分钟前还在传的会话，按创建时间会被埋到列表底部。
 *
 * 【为什么范围要下推到 WHERE】与其它列表同一条理由（见 auth/scope.ts 顶部）：
 *   先取 50 行再筛掉不属于你的，用户看到的是"服务器上什么都没有"，
 *   而磁盘上明明还躺着他自己那半截文件 —— 看起来像数据丢了。
 */
export function listSessions(
  db: Db,
  status: UploadStatus,
  limit: number,
  scope: RowScope,
): readonly SessionRow[] {
  const { sql: visible, params } = scopePredicate('created_by', scope);
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM upload_sessions
        WHERE status = ? AND (${visible})
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(status, ...params, limit);
  return (rows as unknown as RawRow[]).map(toRow);
}

/** 把库里的行和磁盘上"收到了哪些片"合成对外的契约形状。 */
export function toSession(
  row: SessionRow,
  received: readonly number[],
  receivedBytes: number,
): UploadSession {
  return {
    id: row.id,
    targetDir: row.targetDir,
    fileName: row.fileName,
    totalBytes: row.totalBytes,
    chunkSize: row.chunkSize,
    chunkCount: row.chunkCount,
    received,
    receivedBytes,
    status: row.status,
    storedPath: row.storedPath,
    sha256: row.sha256,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
