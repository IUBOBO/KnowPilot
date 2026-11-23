/**
 * 大论文台账的读写（迁移 v26）。
 *
 * 登录角色可查看全部档案和成绩，成绩字段的服务端过滤由 viewer 控制。
 */
import { randomUUID } from 'node:crypto';
import { AppError, type Thesis, type ThesisTitleChange } from '@knowpilot/shared';
import type { Db } from '../db/index.ts';
import { listRecordEdits, recordEdit } from '../ledger/record-edits.ts';

export interface ThesisViewer {
  userId: string | null;
  canReadGrade: boolean;
}

interface ThesisRow {
  id: string;
  created_by: string | null;
  created_by_name: string | null;
  person_id: string | null;
  person_name: string | null;
  person_user_id: string | null;
  author_name: string;
  direction: string | null;
  title: string | null;
  grade: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

interface HistoryRow {
  id: string;
  old_title: string | null;
  new_title: string | null;
  changed_at: string;
  changed_by_name: string | null;
}

const COLUMNS = `t.id, t.created_by, u.display_name AS created_by_name, t.person_id, pe.name AS person_name, pe.user_id AS person_user_id,
  t.author_name, t.direction, t.title, t.grade, t.notes, t.created_at, t.updated_at, t.revision`;

const FROM = `FROM theses t LEFT JOIN people pe ON pe.id = t.person_id LEFT JOIN users u ON u.id = t.created_by`;

function titleHistory(db: Db, thesisId: string): ThesisTitleChange[] {
  const rows = db
    .prepare(
      `SELECT h.id, h.old_title, h.new_title, h.changed_at,
              u.display_name AS changed_by_name
         FROM thesis_title_history h LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.thesis_id = ? ORDER BY h.changed_at ASC, h.id ASC`,
    )
    .all(thesisId) as unknown as HistoryRow[];
  return rows.map((r) => ({
    id: r.id,
    oldTitle: r.old_title,
    newTitle: r.new_title,
    changedAt: r.changed_at,
    changedByName: r.changed_by_name,
  }));
}

function toThesis(db: Db, row: ThesisRow, viewer: ThesisViewer): Thesis {
  const isSelf = row.person_user_id !== null && row.person_user_id === viewer.userId;
  const gradeVisible = viewer.canReadGrade || isSelf;
  return {
    id: row.id,
    createdById: row.created_by,
    createdByName: row.created_by_name,
    personId: row.person_id,
    personName: row.person_name,
    authorName: row.author_name,
    direction: row.direction,
    title: row.title,
    grade: gradeVisible ? row.grade : null,
    gradeVisible,
    isSelf,
    notes: row.notes,
    titleHistory: titleHistory(db, row.id),
    revision: row.revision,
    edits: listRecordEdits(db, 'thesis', row.id).map((edit) => ({
      ...edit,
      changes: gradeVisible ? edit.changes : Object.fromEntries(
        Object.entries(edit.changes).filter(([field]) => field !== 'grade'),
      ),
    })).filter((edit) => Object.keys(edit.changes).length > 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function listTheses(
  db: Db,
  query: { keyword: string | undefined; limit: number; offset?: number; personId?: string; groupId?: string },
  viewer: ThesisViewer,
): { items: Thesis[]; total: number; matched: number } {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM theses WHERE deleted_at IS NULL').get() as { n: number }).n;
  const where = ['t.deleted_at IS NULL'];
  const params: string[] = [];
  if (query.personId !== undefined) { where.push('t.person_id = ?'); params.push(query.personId); }
  if (query.groupId !== undefined) { where.push('pe.group_id = ?'); params.push(query.groupId); }
  if (query.keyword !== undefined && query.keyword.trim() !== '') {
    const like = `%${escapeLike(query.keyword.trim())}%`;
    // 不搜成绩：成绩是受限字段，能搜到就等于泄露。
    where.push(
      `(t.author_name LIKE ? ESCAPE '\\' OR pe.name LIKE ? ESCAPE '\\'
        OR t.direction LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like, like);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  const matched = (
    db.prepare(`SELECT COUNT(*) AS n FROM theses t LEFT JOIN people pe ON pe.id = t.person_id ${clause}`)
      .get(...params) as unknown as { n: number }
  ).n;
  const rows = db
    .prepare(`SELECT ${COLUMNS} ${FROM} ${clause} ORDER BY t.updated_at DESC, t.id DESC LIMIT ? OFFSET ?`)
    .all(...params, query.limit, query.offset ?? 0) as unknown as ThesisRow[];
  return { items: rows.map((r) => toThesis(db, r, viewer)), total, matched };
}

export function getThesis(db: Db, id: string, viewer: ThesisViewer): Thesis | null {
  const row = db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE t.id = ? AND t.deleted_at IS NULL`).get(id) as unknown as
    | ThesisRow
    | undefined;
  return row === undefined ? null : toThesis(db, row, viewer);
}

export interface ThesisFields {
  personId: string | null;
  authorName: string;
  direction: string | null;
  title: string | null;
  grade: string | null;
  notes: string | null;
}

export function insertThesis(
  db: Db,
  input: ThesisFields & { createdBy: string | null },
  now: string,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO theses
       (id, person_id, author_name, direction, title, grade, notes, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.personId,
    input.authorName,
    input.direction,
    input.title,
    input.grade,
    input.notes,
    now,
    now,
    input.createdBy,
  );
  return id;
}

export interface ThesisPatch {
  personId?: string | null;
  authorName?: string;
  direction?: string | null;
  title?: string | null;
  grade?: string | null;
  notes?: string | null;
}

/** 改一条；题目变化时追加历史，旧值保留。 */
export function updateThesis(
  db: Db,
  id: string,
  patch: ThesisPatch,
  now: string,
  userId: string | null,
  expectedRevision?: number,
): Thesis | null {
  const before = getThesis(db, id, { userId: null, canReadGrade: true });
  if (before === null) return null;
  if (expectedRevision !== undefined && expectedRevision !== before.revision) {
    throw new AppError('invalid_argument', '这条大论文已被其他人更新，请刷新后重新编辑。', { httpStatus: 409 });
  }

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const add = (column: string, value: string | null): void => {
    sets.push(`${column} = ?`);
    args.push(value);
  };
  if (patch.personId !== undefined) add('person_id', patch.personId);
  if (patch.authorName !== undefined) add('author_name', patch.authorName);
  if (patch.direction !== undefined) add('direction', patch.direction);
  if (patch.title !== undefined) add('title', patch.title);
  if (patch.grade !== undefined) add('grade', patch.grade);
  if (patch.notes !== undefined) add('notes', patch.notes);
  if (sets.length === 0) return before;

  sets.push('updated_at = ?');
  args.push(now);
  args.push(id);

  db.exec('BEGIN');
  try {
    args.push(before.revision);
    const updated = db.prepare(`UPDATE theses SET ${sets.join(', ')} WHERE id = ? AND revision = ?`).run(...args);
    if (updated.changes !== 1) {
      throw new AppError('invalid_argument', '这条大论文已被其他人更新，请刷新后重新编辑。', { httpStatus: 409 });
    }
    if (patch.title !== undefined && patch.title !== before.title) {
      db.prepare(
        `INSERT INTO thesis_title_history
           (id, thesis_id, old_title, new_title, changed_at, changed_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), id, before.title, patch.title, now, userId);
    }
    recordEdit(db, 'thesis', id, {
      personId: before.personId, authorName: before.authorName,
      direction: before.direction, title: before.title,
      grade: before.grade, notes: before.notes,
    }, {
      personId: patch.personId === undefined ? before.personId : patch.personId,
      authorName: patch.authorName ?? before.authorName,
      direction: patch.direction === undefined ? before.direction : patch.direction,
      title: patch.title === undefined ? before.title : patch.title,
      grade: patch.grade === undefined ? before.grade : patch.grade,
      notes: patch.notes === undefined ? before.notes : patch.notes,
    }, userId, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getThesis(db, id, { userId: null, canReadGrade: true });
}
