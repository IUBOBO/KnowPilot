/**
 * 专利台账的读写（迁移 v25）。
 *
 * 登录用户可查看全部专利，录入人、导师和管理员可编辑。
 * 专利号、申请人、日期都允许为空。
 */
import { randomUUID } from 'node:crypto';
import { AppError, PATENT_FILTERS, type Patent, type PatentEvent, type PatentEventKind, type PatentFilter } from '@knowpilot/shared';
import type { Db } from '../db/index.ts';
import { listRecordEdits, recordEdit } from '../ledger/record-edits.ts';

interface PatentRow {
  id: string;
  name: string;
  patent_no: string | null;
  applicant_name: string | null;
  applicant_person_id: string | null;
  applicant_person_name: string | null;
  first_submitted_on: string | null;
  substantive_exam_on: string | null;
  published_on: string | null;
  granted_on: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

interface EventRow {
  id: string;
  kind: string;
  occurred_on: string | null;
  note: string | null;
  recorded_at: string;
  recorded_by_name: string | null;
}

const COLUMNS = `p.id, p.name, p.patent_no, p.applicant_name, p.applicant_person_id,
  pe.name AS applicant_person_name, p.first_submitted_on, p.substantive_exam_on,
  p.published_on, p.granted_on, p.owner_user_id, u.display_name AS owner_name, p.created_by,
  creator.display_name AS created_by_name, p.notes,
  p.created_at, p.updated_at, p.revision`;

const FROM = `FROM patents p
  LEFT JOIN people pe ON pe.id = p.applicant_person_id
  LEFT JOIN users u ON u.id = p.owner_user_id
  LEFT JOIN users creator ON creator.id = p.created_by`;

function toEvent(row: EventRow): PatentEvent {
  return {
    id: row.id,
    kind: row.kind as PatentEventKind,
    occurredOn: row.occurred_on,
    note: row.note,
    recordedAt: row.recorded_at,
    recordedByName: row.recorded_by_name,
  };
}

function listEvents(db: Db, patentId: string): PatentEvent[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.kind, e.occurred_on, e.note, e.recorded_at,
              u.display_name AS recorded_by_name
         FROM patent_events e LEFT JOIN users u ON u.id = e.recorded_by
        WHERE e.patent_id = ? ORDER BY e.recorded_at ASC, e.id ASC`,
    )
    .all(patentId) as unknown as EventRow[];
  return rows.map(toEvent);
}

function toPatent(db: Db, row: PatentRow): Patent {
  return {
    id: row.id,
    name: row.name,
    patentNo: row.patent_no,
    applicantName: row.applicant_name,
    applicantPersonId: row.applicant_person_id,
    applicantPersonName: row.applicant_person_name,
    firstSubmittedOn: row.first_submitted_on,
    substantiveExamOn: row.substantive_exam_on,
    publishedOn: row.published_on,
    grantedOn: row.granted_on,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    createdById: row.created_by,
    createdByName: row.created_by_name,
    notes: row.notes,
    events: listEvents(db, row.id),
    revision: row.revision,
    edits: listRecordEdits(db, 'patent', row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface PatentScope {
  userId: string | null;
  canReadAll: boolean;
}

function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function listPatents(
  db: Db,
  query: { keyword: string | undefined; limit: number },
  scope: PatentScope,
): Patent[] {
  return listPatentPage(db, { ...query, offset: 0, filter: 'all' }, scope).items;
}

interface PatentQuery {
  keyword: string | undefined; filter: PatentFilter; registrant?: string;
  personId?: string; groupId?: string; year?: number;
}

function patentWhere(
  query: PatentQuery,
  scope: PatentScope,
): { clause: string; params: (string | null)[] } {
  const where = ['p.deleted_at IS NULL'];
  const params: (string | null)[] = [];
  if (!scope.canReadAll) {
    where.push('p.owner_user_id = ?');
    params.push(scope.userId);
  }
  if (query.keyword !== undefined && query.keyword.trim() !== '') {
    const like = `%${escapeLike(query.keyword.trim())}%`;
    where.push(
      `(p.name LIKE ? ESCAPE '\\' OR p.patent_no LIKE ? ESCAPE '\\'
        OR p.applicant_name LIKE ? ESCAPE '\\' OR pe.name LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like, like);
  }
  if (query.registrant !== undefined && query.registrant.trim() !== '') {
    where.push(`creator.display_name LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(query.registrant.trim())}%`);
  }
  if (query.filter === 'missing_number') where.push("(p.patent_no IS NULL OR p.patent_no = '')");
  if (query.personId !== undefined) { where.push('p.applicant_person_id = ?'); params.push(query.personId); }
  if (query.groupId !== undefined) { where.push('pe.group_id = ?'); params.push(query.groupId); }
  if (query.filter === 'under_review') where.push('p.substantive_exam_on IS NOT NULL AND p.published_on IS NULL AND p.granted_on IS NULL');
  if (query.filter === 'published') where.push('p.published_on IS NOT NULL');
  if (query.filter === 'granted') where.push('p.granted_on IS NOT NULL');
  if (query.year !== undefined) {
    const date = query.filter === 'granted' ? 'p.granted_on' : query.filter === 'published' ? 'p.published_on'
      : query.filter === 'under_review' ? 'p.substantive_exam_on' : 'p.first_submitted_on';
    where.push(`substr(${date}, 1, 4) = ?`);
    params.push(String(query.year));
  }
  if (query.filter === 'date_pending') where.push('(p.first_submitted_on IS NULL OR p.substantive_exam_on IS NULL)');
  return { clause: `WHERE ${where.join(' AND ')}`, params };
}

export function listPatentPage(
  db: Db,
  query: PatentQuery & { limit: number; offset: number },
  scope: PatentScope,
): { items: Patent[]; total: number; matched: number; counts: Record<PatentFilter, number> } {
  const count = (keyword: string | undefined, filter: PatentFilter): number => {
    const { clause, params } = patentWhere({ ...query, keyword, filter }, scope);
    return (db.prepare(`SELECT COUNT(*) AS n ${FROM} ${clause}`).get(...params) as { n: number }).n;
  };
  const { clause, params } = patentWhere(query, scope);
  const rows = db
    .prepare(`SELECT ${COLUMNS} ${FROM} ${clause} ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?`)
    .all(...params, query.limit, query.offset) as unknown as PatentRow[];
  const counts = Object.fromEntries(PATENT_FILTERS.map((filter) => [filter, count(query.keyword, filter)])) as Record<PatentFilter, number>;
  return { items: rows.map((row) => toPatent(db, row)), total: count(undefined, 'all'), matched: counts[query.filter], counts };
}

export function getPatent(db: Db, id: string): Patent | null {
  return getPatentFor(db, id, { canReadAll: true, userId: null });
}

export function getPatentFor(db: Db, id: string, scope: PatentScope): Patent | null {
  const row = db.prepare(`SELECT ${COLUMNS} ${FROM}
    WHERE p.id = ? AND p.deleted_at IS NULL AND (? = 1 OR p.owner_user_id IS ?)`)
    .get(id, Number(scope.canReadAll), scope.userId) as unknown as PatentRow | undefined;
  return row === undefined ? null : toPatent(db, row);
}

export interface PatentFields {
  name: string;
  patentNo: string | null;
  applicantName: string | null;
  applicantPersonId: string | null;
  firstSubmittedOn: string | null;
  substantiveExamOn: string | null;
  publishedOn: string | null;
  grantedOn?: string | null;
  notes: string | null;
}

function insertEvent(
  db: Db,
  patentId: string,
  kind: PatentEventKind,
  occurredOn: string | null,
  note: string | null,
  now: string,
  userId: string | null,
): void {
  db.prepare(
    `INSERT INTO patent_events (id, patent_id, kind, occurred_on, note, recorded_at, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), patentId, kind, occurredOn, note, now, userId);
}

/** 建档：写主表，并按已填的事件日期各留一条事件。 */
export function createPatent(
  db: Db,
  input: PatentFields & { ownerUserId: string | null; createdBy: string | null },
  now: string,
): string {
  validateGrantDate(input.grantedOn ?? null, input.firstSubmittedOn, input.publishedOn);
  const id = randomUUID();
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO patents
         (id, name, patent_no, applicant_name, applicant_person_id,
          first_submitted_on, substantive_exam_on, published_on, granted_on,
          owner_user_id, notes, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.patentNo,
      input.applicantName,
      input.applicantPersonId,
      input.firstSubmittedOn,
      input.substantiveExamOn,
      input.publishedOn,
      input.grantedOn ?? null,
      input.ownerUserId,
      input.notes,
      now,
      now,
      input.createdBy,
    );
    if (input.firstSubmittedOn !== null) {
      insertEvent(db, id, 'submitted', input.firstSubmittedOn, null, now, input.createdBy);
    }
    if (input.substantiveExamOn !== null) {
      insertEvent(db, id, 'substantive_exam', input.substantiveExamOn, null, now, input.createdBy);
    }
    if (input.publishedOn !== null) {
      insertEvent(db, id, 'published', input.publishedOn, null, now, input.createdBy);
    }
    if (input.grantedOn) insertEvent(db, id, 'granted', input.grantedOn, null, now, input.createdBy);
    if (input.patentNo !== null) {
      insertEvent(db, id, 'patent_no', null, `专利号 ${input.patentNo}`, now, input.createdBy);
    }
    db.exec('COMMIT');
    return id;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface PatentPatch {
  name?: string;
  patentNo?: string | null;
  applicantName?: string | null;
  applicantPersonId?: string | null;
  firstSubmittedOn?: string | null;
  substantiveExamOn?: string | null;
  publishedOn?: string | null;
  grantedOn?: string | null;
  notes?: string | null;
}

/** 改一条：字段不出现不动；日期/专利号/名称变化时追加事件，不覆盖历史。 */
export function updatePatent(
  db: Db,
  id: string,
  patch: PatentPatch,
  now: string,
  userId: string | null,
  expectedRevision?: number,
): Patent | null {
  const before = getPatent(db, id);
  if (before === null) return null;
  validateGrantDate(
    patch.grantedOn === undefined ? before.grantedOn : patch.grantedOn,
    patch.firstSubmittedOn === undefined ? before.firstSubmittedOn : patch.firstSubmittedOn,
    patch.publishedOn === undefined ? before.publishedOn : patch.publishedOn,
  );
  if (expectedRevision !== undefined && expectedRevision !== before.revision) {
    throw new AppError('invalid_argument', '这条专利已被其他人更新，请刷新后重新编辑。', { httpStatus: 409 });
  }

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const add = (column: string, value: string | null): void => {
    sets.push(`${column} = ?`);
    args.push(value);
  };
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.patentNo !== undefined) add('patent_no', patch.patentNo);
  if (patch.applicantName !== undefined) add('applicant_name', patch.applicantName);
  if (patch.applicantPersonId !== undefined) add('applicant_person_id', patch.applicantPersonId);
  if (patch.firstSubmittedOn !== undefined) add('first_submitted_on', patch.firstSubmittedOn);
  if (patch.substantiveExamOn !== undefined) add('substantive_exam_on', patch.substantiveExamOn);
  if (patch.publishedOn !== undefined) add('published_on', patch.publishedOn);
  if (patch.grantedOn !== undefined) add('granted_on', patch.grantedOn);
  if (patch.notes !== undefined) add('notes', patch.notes);
  if (sets.length === 0) return before;

  sets.push('updated_at = ?');
  args.push(now);
  args.push(id);

  db.exec('BEGIN');
  try {
    args.push(before.revision);
    const updated = db.prepare(`UPDATE patents SET ${sets.join(', ')} WHERE id = ? AND revision = ?`).run(...args);
    if (updated.changes !== 1) {
      throw new AppError('invalid_argument', '这条专利已被其他人更新，请刷新后重新编辑。', { httpStatus: 409 });
    }
    if (patch.firstSubmittedOn !== undefined && patch.firstSubmittedOn !== before.firstSubmittedOn) {
      insertEvent(db, id, 'submitted', patch.firstSubmittedOn, null, now, userId);
    }
    if (
      patch.substantiveExamOn !== undefined &&
      patch.substantiveExamOn !== before.substantiveExamOn
    ) {
      insertEvent(db, id, 'substantive_exam', patch.substantiveExamOn, null, now, userId);
    }
    if (patch.publishedOn !== undefined && patch.publishedOn !== before.publishedOn) {
      insertEvent(db, id, 'published', patch.publishedOn, null, now, userId);
    }
    if (patch.grantedOn !== undefined && patch.grantedOn !== before.grantedOn) {
      insertEvent(db, id, 'granted', patch.grantedOn, null, now, userId);
    }
    if (patch.patentNo !== undefined && patch.patentNo !== before.patentNo) {
      insertEvent(
        db,
        id,
        'patent_no',
        null,
        patch.patentNo === null ? '清空专利号' : `专利号 ${patch.patentNo}`,
        now,
        userId,
      );
    }
    if (patch.name !== undefined && patch.name !== before.name) {
      insertEvent(db, id, 'renamed', null, `${before.name} → ${patch.name}`, now, userId);
    }
    recordEdit(db, 'patent', id, {
      name: before.name, patentNo: before.patentNo,
      applicantName: before.applicantName, applicantPersonId: before.applicantPersonId,
      firstSubmittedOn: before.firstSubmittedOn, substantiveExamOn: before.substantiveExamOn,
      publishedOn: before.publishedOn, grantedOn: before.grantedOn, notes: before.notes,
    }, {
      name: patch.name ?? before.name,
      patentNo: patch.patentNo === undefined ? before.patentNo : patch.patentNo,
      applicantName: patch.applicantName === undefined ? before.applicantName : patch.applicantName,
      applicantPersonId: patch.applicantPersonId === undefined ? before.applicantPersonId : patch.applicantPersonId,
      firstSubmittedOn: patch.firstSubmittedOn === undefined ? before.firstSubmittedOn : patch.firstSubmittedOn,
      substantiveExamOn: patch.substantiveExamOn === undefined ? before.substantiveExamOn : patch.substantiveExamOn,
      publishedOn: patch.publishedOn === undefined ? before.publishedOn : patch.publishedOn,
      grantedOn: patch.grantedOn === undefined ? before.grantedOn : patch.grantedOn,
      notes: patch.notes === undefined ? before.notes : patch.notes,
    }, userId, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getPatent(db, id);
}

function validateGrantDate(granted: string | null, submitted: string | null, published: string | null): void {
  if (granted && ((submitted && granted < submitted) || (published && granted < published))) {
    throw new AppError('invalid_argument', '授权日期不能早于已登记的申请或公开日期。');
  }
}

export function canWritePatent(
  patent: Patent,
  actor: { userId: string; canWriteAll: boolean },
): boolean {
  return actor.canWriteAll || patent.createdById === actor.userId;
}
