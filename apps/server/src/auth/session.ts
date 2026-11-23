/**
 * 登录会话：创建、解析、续期、吊销、清理。
 *
 * 表结构见 migrations.ts 的 v14 注释（尤其是"为什么存 token 的哈希"
 * 与"为什么不用 JWT"两段）。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AuthUser, Role } from '@knowpilot/shared';
import type { Db } from '../db/index.ts';

/** 会话 cookie 的名字。前端不读它（httpOnly），只在服务端用。 */
export const SESSION_COOKIE = 'kp_session';

/** token 的字节数。32 字节 = 256 bit，远超穷举可行范围。 */
const TOKEN_BYTES = 32;

/**
 * 把 token 转成入库的形态。
 *
 * 用 sha256 而不是 scrypt：token 是高熵随机值，不是人选的口令 ——
 * 慢哈希只对低熵输入有意义（见 password.ts 的说明），对 256 bit 随机值
 * 只是白白让每个请求多花 50ms。
 */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface CreatedSession {
  /** 明文 token，只在这一刻存在。之后库里只有它的哈希。 */
  token: string;
  /** 绝对过期时刻（ISO 8601） */
  expiresAt: string;
}

/**
 * 建一个新会话。
 *
 * 【为什么"绝对上限"要单独存一列，而不只看闲置时长】
 *   只看闲置的话，每天来一次的人永远不会被要求重新登录 ——
 *   一个一年前被偷走的 token 只要小偷偶尔用一下，就能一直活着。
 *   `expires_at` 是"不管你怎么用，到点就得重登"。
 */
export function createSession(
  db: Db,
  input: {
    userId: string;
    now: Date;
    idleDays: number;
    maxDays: number;
    ip: string | null;
    userAgent: string | null;
  },
): CreatedSession {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const nowIso = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + input.maxDays * 86_400_000).toISOString();

  db.prepare(
    `INSERT INTO auth_sessions
       (token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashToken(token),
    input.userId,
    nowIso,
    nowIso,
    expiresAt,
    input.ip,
    input.userAgent,
  );

  return { token, expiresAt };
}

interface SessionUserRow {
  token_hash: string;
  user_id: string;
  last_seen_at: string;
  expires_at: string;
  username: string;
  display_name: string;
  role: string;
  group_id: string | null;
  status: string;
}

export interface ResolvedSession {
  user: AuthUser;
  tokenHash: string;
  /** 会话的绝对过期时刻，登录响应里要回给前端 */
  expiresAt: string;
  /** 上次活动时刻。调用方据此决定要不要写库续期（见 touchSession）。 */
  lastSeenAt: string;
}

/**
 * 用 token 解析出当前用户。任何一条不满足都返回 null，调用方一律当"未登录"。
 *
 * 【为什么用 LEFT 之外的普通 JOIN，且查不到就 null】
 *   会话存在但用户被删了（ON DELETE CASCADE 会连会话一起删，但若库被手工
 *   改过则不会），此时 JOIN 不出行 —— 结果就是 null，正是想要的。
 */
export function resolveSession(
  db: Db,
  rawToken: string,
  now: Date,
  idleDays: number,
): ResolvedSession | null {
  const tokenHash = hashToken(rawToken);
  const row = db
    .prepare(
      `SELECT s.token_hash, s.user_id, s.last_seen_at, s.expires_at,
              u.username, u.display_name, u.role, u.group_id, u.status
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(tokenHash) as unknown as SessionUserRow | undefined;

  if (row === undefined) return null;

  const nowMs = now.getTime();

  // 绝对上限
  if (new Date(row.expires_at).getTime() <= nowMs) {
    deleteSessionByHash(db, tokenHash);
    return null;
  }

  // 闲置上限：太久没动过就算过期。与绝对上限是两个独立条件。
  const lastSeenMs = new Date(row.last_seen_at).getTime();
  if (lastSeenMs + idleDays * 86_400_000 <= nowMs) {
    deleteSessionByHash(db, tokenHash);
    return null;
  }

  // 账号被禁用 → 当场吊销这个会话。
  // 【为什么不只是"当作未登录"】禁用是管理员明确的动作，目的是立刻切断访问。
  //   只当未登录的话，会话行还留在库里：一旦账号又被启用，那个旧 cookie
  //   会**自动恢复有效** —— 而管理员当时的意图是"踢掉他"。
  if (row.status !== 'active') {
    deleteUserSessions(db, row.user_id);
    return null;
  }

  return {
    user: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      role: row.role as Role,
      groupId: row.group_id,
    },
    tokenHash,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * 续期。**不是每个请求都写库** —— 只在距上次活动超过 `everyMs` 时才写。
 *
 * 不这么做的代价：一次页面加载会打十几个接口，每个都 UPDATE 一行；
 * SQLite 是单写入者，这些写会互相排队，而且绝大多数是"把 last_seen_at
 * 从 3 秒前改成现在"这种毫无信息量的更新。
 */
export const TOUCH_INTERVAL_MS = 5 * 60_000;

export function touchSession(db: Db, tokenHash: string, now: Date): void {
  db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?').run(
    now.toISOString(),
    tokenHash,
  );
}

function deleteSessionByHash(db: Db, tokenHash: string): void {
  db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
}

/** 登出：删掉这一个会话。返回是否真的删到了（没带有效会话时是 false）。 */
export function deleteSession(db: Db, rawToken: string): boolean {
  const result = db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(rawToken));
  return Number(result.changes) > 0;
}

/**
 * 踢掉某个人的全部会话。改密码、禁用账号、删除用户时调用。
 *
 * 【为什么改密码必须踢掉旧会话】否则"我刚改了密码，怎么别人还能进"——
 *   而那条会话可能正是攻击者手里的那条，改密码这个动作等于没做。
 */
export function deleteUserSessions(db: Db, userId: string): number {
  const result = db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
  return Number(result.changes);
}

/**
 * 清理过期会话。启动时跑一次（仿 uploads 的 sweepStaleSessions）。
 *
 * 【为什么在启动时而不是定时器里】单机服务，会话最多几十条，
 *   真正需要清的量随重启频率自然消化。为一个"清垃圾"的动作常驻一个
 *   定时器，会让进程多一个需要解释的状态（它什么时候跑？跑的时候
 *   会不会和请求抢锁？）。启动时是唯一的、且没有并发请求的时刻。
 */
export function sweepExpiredSessions(db: Db, now: Date): number {
  const result = db
    .prepare('DELETE FROM auth_sessions WHERE expires_at <= ?')
    .run(now.toISOString());
  return Number(result.changes);
}
