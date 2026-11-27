import { useEffect, useState } from 'react';
import { KNOWLEDGE_DISCOVERY_LABELS, type KnowledgeDiscoveryResponse } from '@knowpilot/shared';
import { apiGet, apiPatch, apiPost, isAbort, toApiError, type ApiError } from '../../api.ts';
import { useAuth } from '../../auth.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { DraftSourceAction } from './DraftSourceAction.tsx';

const endpoint = '/api/v1/knowledge/discovery';
const sourceNames = { ask: '问答', note: '笔记', document: '资料' } as const;

export function DiscoveryPanel() {
  const { user, can } = useAuth();
  return user !== null && can('knowledge.submit') ? <OwnedDiscoveryPanel key={user.id} /> : null;
}

function OwnedDiscoveryPanel() {
  const [response, setResponse] = useState<KnowledgeDiscoveryResponse>();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const guard = new AbortController();
    apiGet<KnowledgeDiscoveryResponse>(endpoint, guard.signal, { cache: 'no-store' })
      .then((data) => { if (!guard.signal.aborted) setResponse(data); })
      .catch((failure: unknown) => { if (!guard.signal.aborted && !isAbort(failure)) setError(toApiError(failure)); });
    return () => guard.abort();
  }, [attempt]);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      setResponse(await apiPatch<KnowledgeDiscoveryResponse>(endpoint, { enabled }));
    } catch (failure) {
      setError(toApiError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function ignore(id: string) {
    setBusy(true);
    setError(null);
    try {
      await apiPost(endpoint + '/' + encodeURIComponent(id) + '/ignore', {});
      setResponse((value) => value === undefined ? undefined : { ...value, items: value.items.filter((item) => item.id !== id) });
    } catch (failure) {
      setError(toApiError(failure));
    } finally {
      setBusy(false);
    }
  }

  return <details className="card knowledge-discovery">
    <summary>知识建议{response && response.items.length > 0 ? '（' + response.items.length + '）' : ''}</summary>
    {error !== null && <ErrorNotice error={error} onRetry={() => { setError(null); setAttempt((n) => n + 1); }} />}
    {response === undefined && error === null && <p role="status">正在读取知识建议…</p>}
    {response !== undefined && <>
      <label>
        <input type="checkbox" checked={response.enabled} disabled={busy}
          onChange={(event) => void toggle(event.target.checked)} /> 启用主动建议
      </label>
      {response.enabled && response.items.length === 0 && <p role="status">暂无待处理建议。</p>}
      {response.enabled && response.items.length > 0 && <ul>
        {response.items.map((item) => <li key={item.id}>
          <strong>{KNOWLEDGE_DISCOVERY_LABELS[item.kind]} · {sourceNames[item.source.kind]}</strong>
          <p>{item.excerpt}</p>
          <p>{item.reason}</p>
          {item.neighbor !== null && <details><summary>对照已发布条目</summary><p>{item.neighbor.excerpt}</p></details>}
          <div className="note-buttons">
            {item.kind !== 'duplicate' && item.kind !== 'insufficient' &&
              <DraftSourceAction source={item.source} disabled={busy} />}
            <button type="button" disabled={busy} onClick={() => void ignore(item.id)}>忽略建议</button>
          </div>
        </li>)}
      </ul>}
    </>}
  </details>;
}
