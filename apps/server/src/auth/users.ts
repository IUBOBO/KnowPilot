/**
 * 用户表的读写。
 *
 * 表结构在迁移 v1 就已存在（当时特意留好了 password_hash / role /
 * group_id / status 四列），阶段 1–3 一直空着 —— 这里才开始往里写。
 */
import { randomUUID } from 'node:crypto';
import type { AuthUser, ManagedUser, Role, UpdateUserRequest, UserStatus } from '@knowpilot/shared';
import type { Db } from '../db/index.ts';
import { hashPassword } from './password.ts';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  group_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const COLUMNS = 'id, username, display_name, password_hash, role, group_id, status, created_at, updated_at';

/**
 * 用户名一律转成小写再存再查。
 *
 * 【为什么不让大小写各自成为不同账号】用户名是"从记忆里敲出来"的标识，
 *   不是人名的正字法。允许 Admin 与 admin 并存，换来的是：
 *   用户明明知道自己叫什么却登不进去（他打错了大小写），
 *   以及"这个人的账号到底哪一个是"这种没法回答的问题。
 *
 *   users.username 上的唯一索引是 v1 建的、区分大小写的（SQLite 默认），
 *   所以"唯一性"这件事由这里的归一化来保证 —— 存进去之前先转小写，
 *   两条记录就不可能只差大小写。
 *
 *   display_name 保持原样，那才是给人看的名字。
 */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    groupId: row.group_id,
  };
}

export function findByUsername(db: Db, username: string): UserRow | undefined {
  return db
    .prepare(`SELECT ${COLUMNS} FROM users WHERE username = ?`)
    .get(normalizeUsername(username)) as unknown as UserRow | undefined;
}

export function findUserById(db: Db, id: string): UserRow | undefined {
  return db
    .prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`)
    .get(id) as unknown as UserRow | undefined;
}

/**
 * 转成管理端视图。**与 toAuthUser 是两个出口，不是两个实现** ——
 * 前者给"我自己"，后者给"别人"，字段集不同（见 shared/users.ts 的说明）。
 */
export function toManagedUser(row: UserRow): ManagedUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    groupId: row.group_id,
    status: row.status as UserStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 全部账号，按建号时间排序。
 *
 * 【为什么不分页】单实验室 10 余人，一屏能列完。分页要额外定义"按什么排、
 *   第几页从哪算"，而现在没有一页装不下的可能 —— 等真的装不下再加，
 *   那时才知道该按什么排。
 */
export function listUsers(db: Db): ManagedUser[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM users ORDER BY created_at`)
    .all() as unknown as UserRow[];
  return rows.map(toManagedUser);
}

/**
 * 改一个账号。返回改完之后的它；id 不存在返回 undefined。
 *
 * 【为什么只拼出现过的字段】不出现的字段一律不动（与 UpdateCodeAssetRequest
 *   同一口径）。整行覆盖的话，两个管理员同时改同一个人时，后提交的会把
 *   对方刚改的那一项悄悄抹回旧值 —— 而他改的是"状态"，不该顺带把
 *   "显示名"改回五分钟前。
 */
export function updateUser(
  db: Db,
  id: string,
  patch: UpdateUserRequest,
  now: Date,
): ManagedUser | undefined {
  const sets: string[] = [];
  const args: (string | null)[] = [];

  if (patch.username !== undefined) {
    // 与建号同一条归一化：存小写、查小写，唯一性才不会被大小写绕过。
    sets.push('username = ?');
    args.push(normalizeUsername(patch.username));
  }
  if (patch.displayName !== undefined) {
    sets.push('display_name = ?');
    args.push(patch.displayName);
  }
  if (patch.role !== undefined) {
    sets.push('role = ?');
    args.push(patch.role);
  }
  if (patch.groupId !== undefined) {
    sets.push('group_id = ?');
    args.push(patch.groupId);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    args.push(patch.status);
  }

  // 一个字段都没给：不写库、也不当错误 —— 如实返回当前状态。
  // 报 400 的话，前端"每次都回传全部字段"的写法会因为某次全都相同而报错。
  if (sets.length === 0) {
    const row = findUserById(db, id);
    return row === undefined ? undefined : toManagedUser(row);
  }

  sets.push('updated_at = ?');
  args.push(now.toISOString());
  args.push(id);

  const result = db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  if (Number(result.changes) === 0) return undefined;

  const row = findUserById(db, id);
  return row === undefined ? undefined : toManagedUser(row);
}

/**
 * 重设口令。同样只在哈希这一层见过明文。
 *
 * 【为什么在这里也要 update_password 的时间戳】`updated_at` 是"这条记录最后
 *   被动过"的唯一痕迹，改口令是最该留下痕迹的一种改动。
 */
export async function setPassword(db: Db, id: string, password: string, now: Date): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  const result = db
    .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(passwordHash, now.toISOString(), id);
  return Number(result.changes) > 0;
}

export interface NewUser {
  /** 明文口令，只在这一层出现过，落库前一定被哈希 */
  password: string;
  role: Role;
  displayName?: string | undefined;
  groupId?: string | null | undefined;
}

/**
 * 建一个用户。返回新用户的 id。
 *
 * 用户名重复时会撞上唯一索引并抛 SQLite 的错 —— 调用方应该先用
 * `findByUsername` 判一次并给出人话的报错（唯一索引是最后一道保险，
 * 它的报错信息不适合直接给用户看）。
 */
export async function insertUser(db: Db, username: string, input: NewUser, now: Date): Promise<string> {
  const id = randomUUID();
  const nowIso = now.toISOString();
  const normalized = normalizeUsername(username);
  const displayName = input.displayName?.trim();
  const passwordHash = await hashPassword(input.password);

  db.prepare(
    `INSERT INTO users
       (id, username, display_name, password_hash, role, group_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    id,
    normalized,
    displayName !== undefined && displayName !== '' ? displayName : normalized,
    passwordHash,
    input.role,
    input.groupId ?? null,
    nowIso,
    nowIso,
  );

  return id;
}

export function countUsers(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as unknown as { n: number };
  return row.n;
}

export interface EnsureAdminResult {
  username: string;
}

/**
 * 按 `.env` 建第一个管理员。**只在 users 表为空时**。
 *
 * 【为什么用 .env 引导，而不是"第一个注册的人就是管理员"】
 *   注册式引导意味着服务一旦对网络上任何人可见，先到的人就能拿到管理员。
 *   单机部署里这不算大问题，但"管理员是谁"变成了一件取决于时序的事，
 *   而它本来应该是一件取决于配置的事。
 *
 * 【为什么 users 非空时什么都不做，而不是"缺管理员就补一个"】
 *   那会让 .env 里的旧口令在某个时刻**重新生效** —— 比如管理员被误删之后，
 *   服务重启就凭空多出一个用旧口令能登的账号。只在"全新的库"上生效，
 *   这条路径就只有一次机会。
 *
 * 两个变量任一为空 → 不建、不报错。返回 null，由调用方决定要不要提示。
 */
export async function ensureInitialAdmin(
  db: Db,
  cfg: { adminUsername: string | undefined; adminPassword: string | undefined },
  now: Date,
): Promise<EnsureAdminResult | null> {
  if (cfg.adminUsername === undefined || cfg.adminPassword === undefined) return null;
  if (countUsers(db) > 0) return null;

  const username = normalizeUsername(cfg.adminUsername);
  await insertUser(
    db,
    username,
    { password: cfg.adminPassword, role: 'admin', displayName: '管理员' },
    now,
  );
  return { username };
}
