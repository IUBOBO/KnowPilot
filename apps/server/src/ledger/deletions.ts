import { randomUUID } from 'node:crypto';
import { AppError, hasPermission, type AuthUser, type LedgerDeletion, type LedgerRecordKind, type ListLedgerDeletionsResponse } from '@knowpilot/shared';
import type { Db } from '../db/index.ts';

// Identifiers come only from this map, never from request input.
const RECORDS = {
  submission: { table: 'submissions', title: 'title', recorder: 'user_id' },
  patent: { table: 'patents', title: 'name', recorder: 'created_by' },
  thesis: { table: 'theses', title: "COALESCE(title, author_name || '的大论文')", recorder: 'created_by' },
} as const;

export function deleteLedgerRecord(db: Db, kind: LedgerRecordKind, id: string, actor: AuthUser, now: string) {
  const { table, title, recorder } = RECORDS[kind];
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare(`SELECT ${title} AS title, ${recorder} AS recorder FROM ${table}
      WHERE id = ? AND deleted_at IS NULL`).get(id) as { title: string; recorder: string | null } | undefined;
    if (row === undefined) throw new AppError('not_found', '没有这条台账记录。');
    if (row.recorder !== actor.id && !hasPermission(actor.role, 'ledger.delete.all')) {
      throw new AppError('permission_denied', '只能删除自己录入的记录。');
    }
    db.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`).run(now, id);
    db.prepare(`INSERT INTO ledger_deletions
      (id, kind, record_id, title, deleted_at, deleted_by, deleted_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), kind, id, row.title, now, actor.id, actor.displayName);
    db.exec('COMMIT');
    return { id, title: row.title };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function listLedgerDeletions(db: Db, limit: number, before: number | null): ListLedgerDeletionsResponse {
  const rows = db.prepare(`SELECT rowid AS cursor, id, kind, title, deleted_at AS deletedAt,
    deleted_by_name AS deletedByName, restored_at AS restoredAt FROM ledger_deletions
    WHERE (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?`)
    .all(before, before, limit + 1) as unknown as (LedgerDeletion & { cursor: number })[];
  return {
    items: rows.slice(0, limit).map(({ cursor: _cursor, ...item }) => item),
    nextCursor: rows.length > limit ? rows[limit - 1]!.cursor : null,
  };
}

export function restoreLedgerRecord(db: Db, deletionId: string, actorId: string, now: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT kind, record_id FROM ledger_deletions WHERE id = ? AND restored_at IS NULL')
      .get(deletionId) as { kind: LedgerRecordKind; record_id: string } | undefined;
    if (row === undefined || db.prepare(`UPDATE ${RECORDS[row.kind].table} SET deleted_at = NULL
      WHERE id = ? AND deleted_at IS NOT NULL`).run(row.record_id).changes !== 1) {
      throw new AppError('not_found', '这条删除记录已恢复或不存在。');
    }
    db.prepare('UPDATE ledger_deletions SET restored_at = ?, restored_by = ? WHERE id = ?').run(now, actorId, deletionId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
