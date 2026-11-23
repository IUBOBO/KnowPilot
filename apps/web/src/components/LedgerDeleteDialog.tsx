import { useState } from 'react';
import { LEDGER_RECORD_LABELS, type LedgerRecordKind } from '@knowpilot/shared';
import { apiDelete, toApiError, type ApiError } from '../api.ts';
import { LEDGER_DELETED_EVENT } from '../ledger-events.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { ErrorNotice } from './ErrorNotice.tsx';

export function LedgerDeleteDialog({ kind, target, onCancel, onDeleted }: {
  kind: LedgerRecordKind;
  target: { id: string; title: string } | null;
  onCancel: () => void;
  onDeleted: (title: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const label = LEDGER_RECORD_LABELS[kind];

  async function confirm() {
    if (target === null || busy) return;
    setError(null);
    setBusy(true);
    try {
      const { deleted } = await apiDelete<{ deleted: { title: string } }>(
        `/api/v1/${kind === 'thesis' ? 'theses' : `${kind}s`}/${encodeURIComponent(target.id)}`,
      );
      window.dispatchEvent(new Event(LEDGER_DELETED_EVENT));
      onDeleted(deleted.title);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog open={target !== null} title={`删除这条${label}记录？`}
      confirmLabel="删除记录" busyLabel="删除中…" cancelLabel="取消" busy={busy} danger
      onConfirm={() => void confirm()} onCancel={() => {
        if (!busy) {
          setError(null);
          onCancel();
        }
      }}
    >
      {target !== null && <p>「{target.title}」将从台账移出。导师和管理员可查看删除消息，管理员可恢复记录。</p>}
      {error !== null && <ErrorNotice error={error} onRetry={() => void confirm()} />}
    </ConfirmDialog>
  );
}
