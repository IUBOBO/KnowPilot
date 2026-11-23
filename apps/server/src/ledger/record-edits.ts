import { randomUUID } from 'node:crypto';
import type { RecordEdit } from '@knowpilot/shared';
import type { Db } from '../db/index.ts';

type Values = Record<string, string | null>;
type RecordKind = 'submission' | 'patent' | 'thesis';

export function recordEdit(
  db: Db,
  kind: RecordKind,
  recordId: string,
  before: Values,
  after: Values,
  actorId: string | null,
  now: string,
): void {
  const changes: Record<string, { before: string | null; after: string | null }> = {};
  for (const [field, oldValue] of Object.entries(before)) {
    const newValue = after[field] ?? null;
    if (oldValue !== newValue) changes[field] = { before: oldValue, after: newValue };
  }
  if (Object.keys(changes).length === 0) return;
  db.prepare(`INSERT INTO record_edit_audits
    (id, record_type, record_id, changes_json, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), kind, recordId, JSON.stringify(changes), actorId, now);
}

export function listRecordEdits(db: Db, kind: RecordKind, recordId: string): RecordEdit[] {
  const rows = db.prepare(`SELECT a.id, a.changes_json, u.display_name AS changed_by_name,
    a.changed_at FROM record_edit_audits a LEFT JOIN users u ON u.id = a.changed_by
    WHERE a.record_type = ? AND a.record_id = ? ORDER BY a.changed_at DESC, a.id DESC`)
    .all(kind, recordId) as unknown as {
      id: string; changes_json: string; changed_by_name: string | null; changed_at: string;
    }[];
  return rows.map((row) => ({
    id: row.id,
    changes: JSON.parse(row.changes_json) as RecordEdit['changes'],
    changedByName: row.changed_by_name,
    changedAt: row.changed_at,
  }));
}
