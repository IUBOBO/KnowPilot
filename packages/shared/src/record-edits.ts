/** 共享台账字段的修改留痕；只记录实际变化的字段。 */
export interface RecordEdit {
  id: string;
  changes: Readonly<Record<string, { before: string | null; after: string | null }>>;
  changedByName: string | null;
  changedAt: string;
}

export const LEDGER_RECORD_LABELS = {
  submission: '投稿',
  patent: '专利',
  thesis: '大论文',
} as const;

export type LedgerRecordKind = keyof typeof LEDGER_RECORD_LABELS;

export interface LedgerDeletion {
  id: string;
  kind: LedgerRecordKind;
  title: string;
  deletedAt: string;
  deletedByName: string;
  restoredAt: string | null;
}

export interface ListLedgerDeletionsResponse {
  items: LedgerDeletion[];
  nextCursor: number | null;
}
