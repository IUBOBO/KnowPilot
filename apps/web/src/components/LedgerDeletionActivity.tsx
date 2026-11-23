import { useEffect, useState } from 'react';
import { LEDGER_RECORD_LABELS, type ListLedgerDeletionsResponse } from '@knowpilot/shared';
import { apiGet, apiPost, isAbort, toApiError } from '../api.ts';
import { fmtDateTime } from '../format.ts';
import { LEDGER_DELETED_EVENT, LEDGER_RESTORED_EVENT } from '../ledger-events.ts';

const DELETIONS_PATH = '/api/v1/ledger-deletions';

export function LedgerDeletionActivity({ canRestore, refreshKey }: { canRestore: boolean; refreshKey: string }) {
  const [data, setData] = useState<ListLedgerDeletionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let request: AbortController | undefined;
    const refresh = () => {
      request?.abort();
      request = new AbortController();
      void apiGet<ListLedgerDeletionsResponse>(DELETIONS_PATH, request.signal)
        .then((result) => { setData(result); setError(null); })
        .catch((err) => {
          if (!isAbort(err)) setError(toApiError(err).body.error.message);
        });
    };
    refresh();
    window.addEventListener(LEDGER_DELETED_EVENT, refresh);
    return () => {
      request?.abort();
      window.removeEventListener(LEDGER_DELETED_EVENT, refresh);
    };
  }, [refreshKey]);

  async function loadMore() {
    if (data === null || data.nextCursor === null || busy !== null) return;
    setBusy('more');
    setError(null);
    try {
      const result = await apiGet<ListLedgerDeletionsResponse>(`${DELETIONS_PATH}?before=${data.nextCursor}`);
      setData((current) => current !== data ? current : { ...result, items: [...data.items, ...result.items] });
    } catch (err) {
      setError(toApiError(err).body.error.message);
    } finally {
      setBusy(null);
    }
  }

  async function restore(id: string) {
    if (busy !== null) return;
    setBusy(id);
    setError(null);
    try {
      const { restoredAt } = await apiPost<{ restoredAt: string }>(`${DELETIONS_PATH}/${encodeURIComponent(id)}/restore`, {});
      setData((current) => current === null ? current : {
        ...current, items: current.items.map((item) => item.id === id ? { ...item, restoredAt } : item),
      });
      window.dispatchEvent(new Event(LEDGER_RESTORED_EVENT));
    } catch (err) {
      setError(toApiError(err).body.error.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rail-deletions" aria-label="台账删除记录">
      <h3>台账删除记录</h3>
      {error !== null && <p className="dim" role="alert">{error}</p>}
      {data === null && error === null && <p className="dim" role="status">正在加载…</p>}
      {data?.items.length === 0 && <p className="dim">暂无删除记录</p>}
      {data !== null && data.items.length > 0 && (
        <ul className="rail-list">
          {data.items.map((item) => (
            <li key={item.id} className="rail-deletion">
              <span className="rail-deletion-title"><b>{LEDGER_RECORD_LABELS[item.kind]}</b> {item.title}</span>
              <span className="dim">{item.deletedByName} · <time dateTime={item.deletedAt}>{fmtDateTime(item.deletedAt)}</time></span>
              {item.restoredAt !== null
                ? <span className="dim" role="status">已恢复</span>
                : canRestore && <button type="button" className="link-btn" disabled={busy !== null}
                    onClick={() => void restore(item.id)} aria-label={`恢复「${item.title}」`}>
                    {busy === item.id ? '恢复中…' : '恢复'}
                  </button>}
            </li>
          ))}
        </ul>
      )}
      {data !== null && data.nextCursor !== null && <button type="button" className="link-btn" disabled={busy !== null} onClick={() => void loadMore()}>
        {busy === 'more' ? '加载中…' : '加载更早的记录'}
      </button>}
    </section>
  );
}
