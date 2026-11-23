/**
 * 人员主档的读写（迁移 v24）。
 *
 * 在返回前按查看权限处理学号：当前三个登录角色均可见；若调用方没有
 * `people.read.sensitive`，则将他人的 `studentNo` 置 null、
 * `studentNoVisible` 置 false。权限判断留在服务端，供列表、详情和导出复用。
 */
import { randomUUID } from 'node:crypto';
import type { Person, PersonStatus } from '@knowpilot/shared';
import type { Db } from '../db/index.ts';

export interface PersonViewer {
  userId: string | null;
  canReadSensitive: boolean;
  canManage: boolean;
}

interface PersonRow {
  id: string;
  name: string;
  student_no: string | null;
  grade: string | null;
  group_id: string | null;
  status: string;
  user_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  linked_username: string | null;
}

const COLUMNS = `p.id, p.name, p.student_no,
  CASE WHEN p.student_no GLOB '[0-9][0-9][0-9][0-9]*'
       THEN SUBSTR(p.student_no, 3, 2) ELSE NULL END AS grade,
  p.group_id, p.status, p.user_id,
  p.note, p.created_at, p.updated_at, u.username AS linked_username`;

const FROM = `FROM people p LEFT JOIN users u ON u.id = p.user_id`;

function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function toPerson(row: PersonRow, viewer: PersonViewer): Person {
  const isSelf = row.user_id !== null && row.user_id === viewer.userId;
  const showSensitive = viewer.canReadSensitive || isSelf;
  return {
    id: row.id,
    name: row.name,
    studentNo: showSensitive ? row.student_no : null,
    studentNoVisible: showSensitive,
    grade: row.grade,
    groupId: row.group_id,
    status: row.status as PersonStatus,
    isSelf,
    linkedUserId: viewer.canManage ? row.user_id : null,
    linkedUsername: viewer.canManage ? row.linked_username : null,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function filterFor(keyword: string | undefined, viewer: PersonViewer): {
  clause: string;
  params: string[];
} {
  if (keyword === undefined || keyword.trim() === '') return { clause: '', params: [] };
  const like = `%${escapeLike(keyword.trim())}%`;
  // 没有敏感权限的人不能拿学号搜索 —— 能命中就等于泄露了"这个学号存在"。
  return viewer.canReadSensitive
    ? { clause: `WHERE (p.name LIKE ? ESCAPE '\\' OR p.student_no LIKE ? ESCAPE '\\')`, params: [like, like] }
    : { clause: `WHERE p.name LIKE ? ESCAPE '\\'`, params: [like] };
}

export function listPeople(
  db: Db,
  query: { keyword: string | undefined; limit: number; offset?: number; groupId?: string; status?: PersonStatus },
  viewer: PersonViewer,
): { items: Person[]; total: number; matched: number } {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM people').get() as unknown as { n: number }).n;
  const filter = filterFor(query.keyword, viewer);
  const filters = filter.clause === '' ? [] : [filter.clause.slice('WHERE '.length)];
  const params = [...filter.params];
  if (query.groupId !== undefined) { filters.push('p.group_id = ?'); params.push(query.groupId); }
  if (query.status !== undefined) { filters.push('p.status = ?'); params.push(query.status); }
  const clause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const matched = (
    db.prepare(`SELECT COUNT(*) AS n FROM people p ${clause}`).get(...params) as unknown as { n: number }
  ).n;
  const rows = db
    .prepare(`SELECT ${COLUMNS} ${FROM} ${clause}
      ORDER BY grade IS NULL, grade ASC, p.name COLLATE NOCASE, p.id LIMIT ? OFFSET ?`)
    .all(...params, query.limit, query.offset ?? 0) as unknown as PersonRow[];
  return { items: rows.map((r) => toPerson(r, viewer)), total, matched };
}

export function getPerson(db: Db, id: string, viewer: PersonViewer): Person | null {
  const row = db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE p.id = ?`).get(id) as unknown as
    | PersonRow
    | undefined;
  return row === undefined ? null : toPerson(row, viewer);
}

export interface CreatePersonInput {
  name: string;
  studentNo: string | null;
  groupId: string | null;
  status: PersonStatus;
  userId: string | null;
  note: string | null;
  createdBy: string | null;
}

export function insertPerson(db: Db, input: CreatePersonInput, now: string): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO people
       (id, name, student_no, group_id, status, user_id, note, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.studentNo,
    input.groupId,
    input.status,
    input.userId,
    input.note,
    now,
    now,
    input.createdBy,
  );
  return id;
}

export interface UpdatePersonInput {
  name?: string;
  studentNo?: string | null;
  groupId?: string | null;
  status?: PersonStatus;
  userId?: string | null;
  note?: string | null;
}

export function updatePerson(
  db: Db,
  id: string,
  input: UpdatePersonInput,
  now: string,
): boolean {
  const sets: string[] = [];
  const args: (string | null)[] = [];
  if (input.name !== undefined) {
    sets.push('name = ?');
    args.push(input.name);
  }
  if (input.studentNo !== undefined) {
    sets.push('student_no = ?');
    args.push(input.studentNo);
  }
  if (input.groupId !== undefined) {
    sets.push('group_id = ?');
    args.push(input.groupId);
  }
  if (input.status !== undefined) {
    sets.push('status = ?');
    args.push(input.status);
  }
  if (input.userId !== undefined) {
    sets.push('user_id = ?');
    args.push(input.userId);
  }
  if (input.note !== undefined) {
    sets.push('note = ?');
    args.push(input.note);
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  args.push(now);
  args.push(id);
  const result = db.prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return Number(result.changes) > 0;
}

/** 学号 / 账号绑定是否已被别人占用。路由用它给 409 的人话报错。 */
export function findPersonByStudentNo(db: Db, studentNo: string): { id: string } | null {
  const row = db
    .prepare('SELECT id FROM people WHERE student_no = ? LIMIT 1')
    .get(studentNo) as unknown as { id: string } | undefined;
  return row ?? null;
}

export function findPersonByUserId(db: Db, userId: string): { id: string } | null {
  const row = db
    .prepare('SELECT id FROM people WHERE user_id = ? LIMIT 1')
    .get(userId) as unknown as { id: string } | undefined;
  return row ?? null;
}

export function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /UNIQUE constraint failed: (people\.student_no|people\.user_id)/u.test(err.message)
  );
}
