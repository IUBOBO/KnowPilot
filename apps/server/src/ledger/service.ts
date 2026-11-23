/**
 * Excel 导入批次与逐行草稿（迁移 v27）。
 *
 * 草稿只属于上传者；管理员可看全部。导入目标按 person → 其它 的顺序，
 * 这样专利/大论文能在同一批次里找到刚建好的人员记录。
 */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '@knowpilot/shared';
import type {
  LedgerImportBatch,
  LedgerImportRow,
  LedgerImportTarget,
  LedgerRowStatus,
} from '@knowpilot/shared';
import type { Db } from '../db/index.ts';
import { parseLedgerWorkbook } from './parse.ts';
import { createSubmission } from '../submissions/repo.ts';
import { findOrCreateJournal, updateJournal } from '../submissions/repo.ts';
import { createPatent } from '../patents/repo.ts';
import { insertThesis } from '../theses/repo.ts';
import { insertPerson, findPersonByStudentNo } from '../people/repo.ts';

export interface ImportViewer {
  userId: string;
  canManageAll: boolean;
  canManageTheses?: boolean;
}

interface BatchRow {
  id: string;
  file_name: string;
  file_hash: string;
  stored_path: string;
  uploaded_by: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface RowRow {
  id: string;
  batch_id: string;
  sheet_name: string;
  row_no: number;
  target: string;
  raw_json: string;
  normalized_json: string;
  issues_json: string;
  status: string;
  target_id: string | null;
  result_message: string | null;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRow(row: RowRow): LedgerImportRow {
  return {
    id: row.id,
    batchId: row.batch_id,
    sheetName: row.sheet_name,
    rowNo: row.row_no,
    target: row.target as LedgerImportTarget,
    raw: parseJson<Record<string, string | null>>(row.raw_json, {}),
    normalized: parseJson<Record<string, string | null>>(row.normalized_json, {}),
    issues: parseJson<string[]>(row.issues_json, []),
    status: row.status as LedgerRowStatus,
    targetId: row.target_id,
    resultMessage: row.result_message,
  };
}

const BATCH_COLUMNS = 'id, file_name, file_hash, stored_path, uploaded_by, status, created_at, updated_at';
const ROW_COLUMNS = `id, batch_id, sheet_name, row_no, target, raw_json, normalized_json,
  issues_json, status, target_id, result_message`;

function batchCounts(db: Db, batchId: string): Record<string, number> {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM ledger_import_rows WHERE batch_id = ? GROUP BY status')
    .all(batchId) as unknown as { status: string; n: number }[];
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

function toBatch(db: Db, row: BatchRow): LedgerImportBatch {
  const counts = batchCounts(db, row.id);
  return {
    id: row.id,
    fileName: row.file_name,
    status: row.status as 'draft' | 'imported' | 'discarded',
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireBatch(db: Db, id: string, viewer: ImportViewer): BatchRow {
  const row = db.prepare(`SELECT ${BATCH_COLUMNS} FROM ledger_import_batches WHERE id = ?`).get(id) as
    | BatchRow
    | undefined;
  if (row === undefined) throw new AppError('not_found', '没有这个导入批次。');
  if (!viewer.canManageAll && row.uploaded_by !== viewer.userId) {
    throw new AppError('not_found', '没有这个导入批次。');
  }
  return row;
}

function getRow(db: Db, batchId: string, rowId: string): RowRow {
  const row = db
    .prepare(`SELECT ${ROW_COLUMNS} FROM ledger_import_rows WHERE id = ? AND batch_id = ?`)
    .get(rowId, batchId) as unknown as RowRow | undefined;
  if (row === undefined) throw new AppError('not_found', '没有这条导入草稿。');
  return row;
}

function setRow(
  db: Db,
  rowId: string,
  status: LedgerRowStatus,
  issues: string[],
  targetId: string | null,
  message: string | null,
  now: string,
): void {
  db.prepare(
    `UPDATE ledger_import_rows
        SET status = ?, issues_json = ?, target_id = ?, result_message = ?, updated_at = ?
      WHERE id = ?`,
  ).run(status, JSON.stringify(issues), targetId, message, now, rowId);
}

export function listBatches(db: Db, viewer: ImportViewer, limit: number): LedgerImportBatch[] {
  const rows = viewer.canManageAll
    ? (db.prepare(`SELECT ${BATCH_COLUMNS} FROM ledger_import_batches ORDER BY created_at DESC LIMIT ?`)
        .all(limit) as unknown as BatchRow[])
    : (db
        .prepare(`SELECT ${BATCH_COLUMNS} FROM ledger_import_batches WHERE uploaded_by = ? ORDER BY created_at DESC LIMIT ?`)
        .all(viewer.userId, limit) as unknown as BatchRow[]);
  return rows.map((r) => toBatch(db, r));
}

export function getBatch(
  db: Db,
  id: string,
  viewer: ImportViewer,
): { batch: LedgerImportBatch; rows: LedgerImportRow[] } {
  const batch = requireBatch(db, id, viewer);
  const rows = db
    .prepare(`SELECT ${ROW_COLUMNS} FROM ledger_import_rows WHERE batch_id = ? ORDER BY sheet_name, row_no`)
    .all(id) as unknown as RowRow[];
  return { batch: toBatch(db, batch), rows: rows.map(toRow) };
}

/**
 * 上传并识别：写入私有原文件 + 批次 + 逐行草稿。**不写业务表**。
 * 识别不出来任何行时拒绝，避免留下一个空批次。
 */
export async function createBatch(
  db: Db,
  storageDir: string,
  file: { buffer: Buffer; fileName: string },
  userId: string,
  now: string,
): Promise<{ batch: LedgerImportBatch; rows: LedgerImportRow[] }> {
  const hash = createHash('sha256').update(file.buffer).digest('hex');
  const parsed = await parseLedgerWorkbook(file.buffer);
  if (parsed.length === 0) {
    throw new AppError(
      'invalid_argument',
      '没有从工作簿里识别出「论文 / 专利 / 个人信息 / 大论文题目」四类记录。请检查表头。',
    );
  }

  const batchId = randomUUID();
  const storedRel = `${batchId}.xlsx`;
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(join(storageDir, storedRel), file.buffer);

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO ledger_import_batches
         (id, file_name, file_hash, stored_path, uploaded_by, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
    ).run(batchId, file.fileName, hash, storedRel, userId, now, now);

    const insert = db.prepare(
      `INSERT INTO ledger_import_rows
         (id, batch_id, sheet_name, row_no, target, raw_json, normalized_json,
          issues_json, status, target_id, result_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    );
    for (const row of parsed) {
      const issues = [...row.issues];
      let status = row.status;
      // 与现有库比对重复候选（只提示，不自动合并）。
      if (row.target === 'person' && row.normalized['studentNo'] !== null) {
        if (findPersonByStudentNo(db, row.normalized['studentNo'] ?? '') !== null) {
          status = 'duplicate';
          issues.push('学号在人员主档里已存在');
        }
      }
      if (row.target === 'patent' && row.normalized['patentNo'] !== null) {
        const hit = db
          .prepare('SELECT id FROM patents WHERE deleted_at IS NULL AND patent_no = ? LIMIT 1')
          .get(row.normalized['patentNo'] ?? '');
        if (hit !== undefined) {
          status = 'duplicate';
          issues.push('专利号在专利台账里已存在');
        }
      }
      if (row.target === 'submission' && row.normalized['title'] !== null) {
        const hit = db
          .prepare(
            `SELECT s.id FROM submissions s LEFT JOIN journals j ON j.id = s.journal_id
              WHERE s.deleted_at IS NULL AND s.title = ? LIMIT 1`,
          )
          .get(row.normalized['title'] ?? '');
        if (hit !== undefined) {
          status = 'duplicate';
          issues.push('同名论文稿在投稿台账里已存在');
        }
      }
      if (row.target === 'thesis' && row.normalized['title'] !== null) {
        const hit = db
          .prepare('SELECT id FROM theses WHERE deleted_at IS NULL AND title = ? LIMIT 1')
          .get(row.normalized['title'] ?? '');
        if (hit !== undefined) {
          status = 'duplicate';
          issues.push('同名大论文已存在');
        }
      }
      insert.run(
        randomUUID(),
        batchId,
        row.sheetName,
        row.rowNo,
        row.target,
        JSON.stringify(row.raw),
        JSON.stringify(row.normalized),
        JSON.stringify(issues),
        status,
        now,
        now,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    if (existsSync(join(storageDir, storedRel))) rmSync(join(storageDir, storedRel));
    throw err;
  }

  const batch = db.prepare(`SELECT ${BATCH_COLUMNS} FROM ledger_import_batches WHERE id = ?`).get(batchId) as unknown as BatchRow;
  const rows = db
    .prepare(`SELECT ${ROW_COLUMNS} FROM ledger_import_rows WHERE batch_id = ? ORDER BY sheet_name, row_no`)
    .all(batchId) as unknown as RowRow[];
  return { batch: toBatch(db, batch), rows: rows.map(toRow) };
}

function validDate(value: string | null): boolean {
  if (value === null) return true;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (m === null) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return (
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() === Number(m[2]) - 1 &&
    d.getUTCDate() === Number(m[3])
  );
}

function validateNormalized(target: LedgerImportTarget, n: Record<string, string | null>): string[] {
  const issues: string[] = [];
  const required = target === 'person' ? ['name'] : target === 'submission' ? ['title', 'status'] : target === 'patent' ? ['name'] : ['authorName'];
  for (const f of required) {
    if (n[f] === null || n[f] === '') issues.push(`缺少必填字段：${f}`);
  }
  for (const f of ['submittedOn', 'statusSince', 'firstSubmittedOn', 'substantiveExamOn', 'publishedOn', 'grantedOn']) {
    if (!validDate(n[f] ?? null)) issues.push(`${f} 不是合法的 YYYY-MM-DD`);
  }
  if (target === 'submission' && n['status'] !== null && n['status'] !== undefined) {
    const allowed = ['preparing','pending_initial','under_review','revision_resubmitted','accepted_pending','published','rejected','withdrawn'];
    if (!allowed.includes(n['status'])) issues.push('状态不是系统受控词表中的值');
    if (n['status'] !== 'preparing' && (n['submittedOn'] === null || n['submittedOn'] === undefined)) {
      issues.push('缺少首次投稿日期');
    }
  }
  const grant = n['grantedOn'];
  if (target === 'patent' && grant && [n['firstSubmittedOn'], n['publishedOn']].some((date) => date && grant < date)) {
    issues.push('授权日期早于申请或公开日期，需复核');
  }
  return issues;
}

export function updateRow(
  db: Db,
  batchId: string,
  rowId: string,
  patch: { normalized?: Record<string, string | null>; skip?: boolean },
  viewer: ImportViewer,
  now: string,
): { row: LedgerImportRow; batch: LedgerImportBatch } {
  const batch = requireBatch(db, batchId, viewer);
  const row = getRow(db, batchId, rowId);
  if (row.status === 'imported') {
    throw new AppError('invalid_argument', '已导入的草稿行不能再改。');
  }
  if (patch.skip === true) {
    setRow(db, rowId, 'skipped', parseJson<string[]>(row.issues_json, []), null, '已跳过', now);
  } else {
    const normalized = patch.normalized ?? parseJson<Record<string, string | null>>(row.normalized_json, {});
    const issues = validateNormalized(row.target as LedgerImportTarget, normalized);
    const status: LedgerRowStatus = issues.length > 0 ? 'needs_review' : 'ready';
    db.prepare(
      `UPDATE ledger_import_rows SET normalized_json = ?, issues_json = ?, status = ?, updated_at = ?
        WHERE id = ?`,
    ).run(JSON.stringify(normalized), JSON.stringify(issues), status, now, rowId);
  }
  db.prepare('UPDATE ledger_import_batches SET updated_at = ? WHERE id = ?').run(now, batchId);
  return { row: toRow(getRow(db, batchId, rowId)), batch: toBatch(db, batch) };
}

function resolvePersonId(db: Db, name: string | null): { id: string | null; issue: string | null } {
  if (name === null || name === '') return { id: null, issue: '未填写人员姓名' };
  const rows = db.prepare('SELECT id FROM people WHERE name = ? LIMIT 3').all(name) as unknown as { id: string }[];
  if (rows.length === 1) return { id: rows[0]?.id ?? null, issue: null };
  if (rows.length > 1) return { id: null, issue: '人员主档里有重名，需人工选择' };
  return { id: null, issue: '人员主档里没有匹配的姓名' };
}

function importOne(db: Db, row: LedgerImportRow, viewer: ImportViewer, now: string): { status: LedgerRowStatus; message: string; targetId: string | null } {
  const { userId } = viewer;
  const n = row.normalized;
  if (row.status !== 'ready') {
    return { status: row.status, message: '不在可导入状态', targetId: null };
  }
  try {
    if (row.target === 'person') {
      const id = insertPerson(
        db,
        {
          name: n['name'] ?? '',
          studentNo: n['studentNo'] ?? null,
          groupId: null,
          status: 'active',
          userId: null,
          note: 'Excel 导入',
          createdBy: userId,
        },
        now,
      );
      return { status: 'imported', message: '已创建人员记录', targetId: id };
    }
    if (row.target === 'submission') {
      const journalName = n['journalName'] ?? undefined;
      if (journalName !== undefined && n['journalAbbr'] !== null && n['journalAbbr'] !== undefined) {
        const j = findOrCreateJournal(db, journalName, undefined, now);
        updateJournal(db, j.id, { abbr: n['journalAbbr'] });
      }
      const { id } = createSubmission(
        db,
        {
          title: n['title'] ?? '',
          algorithmAbbr: n['algorithmAbbr'] ?? null,
          submitterName: n['submitterName'] ?? null,
          journalName,
          journalField: undefined,
          status: (n['status'] ?? 'pending_initial') as never,
          submittedAt: null,
          submittedOn: n['submittedOn'] ?? null,
          submitterPersonId: n['submitterPersonId'] ?? null,
          statusSince: n['statusSince'] ?? null,
          submissionNumber: n['submissionNumber'] ?? null,
          notes: 'Excel 导入',
          userId,
        },
        now,
      );
      return { status: 'imported', message: '已创建论文投稿记录', targetId: id };
    }
    if (row.target === 'patent') {
      const explicitPersonId = n['personId'] ?? null;
      const person =
        explicitPersonId !== null && db.prepare('SELECT id FROM people WHERE id = ?').get(explicitPersonId) !== undefined
          ? { id: explicitPersonId, issue: null }
          : resolvePersonId(db, n['applicantName'] ?? null);
      const id = createPatent(
        db,
        {
          name: n['name'] ?? '',
          patentNo: n['patentNo'] ?? null,
          applicantName: n['applicantName'] ?? null,
          applicantPersonId: person.id,
          firstSubmittedOn: n['firstSubmittedOn'] ?? null,
          substantiveExamOn: n['substantiveExamOn'] ?? null,
          publishedOn: n['publishedOn'] ?? null,
          grantedOn: n['grantedOn'] ?? null,
          notes: 'Excel 导入',
          ownerUserId: userId,
          createdBy: userId,
        },
        now,
      );
      return {
        status: 'imported',
        message: person.issue === null ? '已创建专利记录' : `已创建专利记录（${person.issue}）`,
        targetId: id,
      };
    }
    if (row.target === 'thesis') {
      const explicitPersonId = n['personId'] ?? null;
      const person =
        explicitPersonId !== null && db.prepare('SELECT id FROM people WHERE id = ?').get(explicitPersonId) !== undefined
          ? { id: explicitPersonId, issue: null }
          : resolvePersonId(db, n['authorName'] ?? null);
      if (person.id === null) {
        return { status: 'needs_review', message: person.issue ?? '未匹配人员主档', targetId: null };
      }
      const grade = n['grade'] ?? null;
      if (grade && !viewer.canManageTheses && !viewer.canManageAll &&
          db.prepare('SELECT 1 FROM people WHERE id = ? AND user_id = ?').get(person.id, userId) === undefined) {
        return { status: 'needs_review', message: '请清空成绩后再确认，或由作者本人、导师或管理员导入', targetId: null };
      }
      const id = insertThesis(
        db,
        {
          personId: person.id,
          authorName: n['authorName'] ?? '',
          direction: n['direction'] ?? null,
          title: n['title'] ?? null,
          grade: grade || null,
          notes: 'Excel 导入',
          createdBy: userId,
        },
        now,
      );
      return { status: 'imported', message: '已创建大论文记录', targetId: id };
    }
    return { status: 'invalid', message: '未知导入类型', targetId: null };
  } catch (err) {
    return {
      status: 'invalid',
      message: err instanceof Error ? err.message : String(err),
      targetId: null,
    };
  }
}

export function importRow(
  db: Db,
  batchId: string,
  rowId: string,
  viewer: ImportViewer,
  now: string,
): { row: LedgerImportRow; batch: LedgerImportBatch } {
  requireBatch(db, batchId, viewer);
  const row = toRow(getRow(db, batchId, rowId));
  if (row.status !== 'ready') {
    // 不再重写这一行：已导入行带着 targetId，重复点导入不能把它抹掉；
    // 待核实/重复/无效行也不该因为一次误点被改成别的状态。
    return { row, batch: toBatch(db, requireBatch(db, batchId, viewer)) };
  }
  const result = importOne(db, row, viewer, now);
  setRow(db, rowId, result.status, row.issues as string[], result.targetId, result.message, now);
  db.prepare('UPDATE ledger_import_batches SET updated_at = ? WHERE id = ?').run(now, batchId);
  return { row: toRow(getRow(db, batchId, rowId)), batch: toBatch(db, requireBatch(db, batchId, viewer)) };
}

export function importReady(
  db: Db,
  batchId: string,
  viewer: ImportViewer,
  now: string,
): { results: { rowId: string; status: LedgerRowStatus; message: string; targetId: string | null }[]; batch: LedgerImportBatch } {
  requireBatch(db, batchId, viewer);
  const rows = db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM ledger_import_rows
        WHERE batch_id = ? AND status = 'ready'
        ORDER BY CASE target WHEN 'person' THEN 0 ELSE 1 END, row_no`,
    )
    .all(batchId) as unknown as RowRow[];
  const results: { rowId: string; status: LedgerRowStatus; message: string; targetId: string | null }[] = [];
  for (const raw of rows) {
    const row = toRow(raw);
    const result = importOne(db, row, viewer, now);
    setRow(db, row.id, result.status, row.issues as string[], result.targetId, result.message, now);
    results.push({ rowId: row.id, ...result });
  }
  db.prepare('UPDATE ledger_import_batches SET updated_at = ? WHERE id = ?').run(now, batchId);
  return { results, batch: toBatch(db, requireBatch(db, batchId, viewer)) };
}
