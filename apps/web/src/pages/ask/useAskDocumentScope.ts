import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  parseAskDocumentIds, parseAskDocumentScope, parseSearchAskHandoff,
  type AskDocumentScopeV1, type AskScopeDocument,
} from '@knowpilot/shared';
import { apiPost } from '../../api.ts';
import { ASK_SCOPE_SESSION_KEY, type SearchContext } from '../../ask-session.ts';
type Selection = { kind: 'all' } | { kind: 'invalid' } | {
  kind: 'selected'; ids: readonly string[]; origin: SearchContext; pinned?: AskDocumentScopeV1;
};

function readSelection(account: string): Selection {
  try {
    const saved = JSON.parse(sessionStorage.getItem(ASK_SCOPE_SESSION_KEY) ?? 'null');
    if (saved?.account !== account) return { kind: 'all' };
    if (saved.selection?.kind === 'invalid') return { kind: 'invalid' };
    if (saved.selection?.kind !== 'selected') return { kind: 'all' };
    const ids = parseAskDocumentIds(saved.selection.ids);
    const origin = parseSearchAskHandoff({ ...saved.selection.origin, version: 1, documentIds: ids });
    const pinned = parseAskDocumentScope(saved.selection.pinned);
    if (ids === undefined || origin === undefined || (saved.selection.pinned !== undefined &&
      (pinned === undefined || pinned.documents.some((ref) => !ids.includes(ref.id))))) return { kind: 'invalid' };
    const researchThread: unknown = saved.selection.origin?.researchThread;
    return { kind: 'selected', ids, origin: { ...origin,
      ...(typeof researchThread === 'string' && researchThread.length <= 80 ? { researchThread } : {}),
    }, ...(pinned === undefined ? {} : { pinned }) };
  } catch {
    return { kind: 'invalid' };
  }
}

export function searchContextHref(context: SearchContext, documentId = context.documentId) {
  const params = new URLSearchParams({ q: context.query.trim().slice(0, 100) });
  if (documentId !== undefined || context.kind === 'document') params.set('kind', 'document');
  if (documentId !== undefined) params.set('documentId', documentId);
  if (context.material !== undefined) params.set('material', context.material);
  return '/search?' + params;
}

export function useAskDocumentScope(active: boolean, account: string, onQuery: (value: string) => void) {
  const location = useLocation();
  const navigate = useNavigate();
  const handled = useRef<string | undefined>(undefined);
  const [selection, setSelection] = useState(() => readSelection(account));
  const [lookup, setLookup] = useState<{ ids: readonly string[]; items: readonly AskScopeDocument[] | null }>();
  const ids = selection.kind === 'selected' ? selection.ids : undefined;
  const state = location.state as { searchHandoff?: unknown; noteResearch?: unknown } | null;
  const handoff = state?.searchHandoff;
  const incoming = active && handoff !== undefined && handled.current !== location.key;
  useEffect(() => {
    if (!incoming) return;
    handled.current = location.key;
    const { searchHandoff: _handoff, noteResearch, ...remaining } = state ?? {};
    void navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state: remaining });
    const parsed = parseSearchAskHandoff(handoff);
    if (parsed === undefined) {
      setSelection({ kind: 'invalid' });
      return;
    }
    const { documentIds, version: _version, ...origin } = parsed;
    setSelection({ kind: 'selected', ids: documentIds, origin: { ...origin,
      ...(noteResearch === true ? { researchThread: location.key } : {}),
    } });
    onQuery(origin.query);
  }, [handoff, incoming, location.key, location.pathname, location.search, location.hash, navigate, onQuery, state]);

  useEffect(() => {
    if (!active || ids === undefined || ids.length === 0) return;
    const abort = new AbortController();
    apiPost<{ items: AskScopeDocument[] }>('/api/v1/ask/document-scope', { version: 1, documentIds: ids }, abort.signal)
      .then(({ items }) => {
        if (abort.signal.aborted) return;
        setLookup({ ids, items });
        setSelection((current) => {
          if (current.kind !== 'selected' || current.ids !== ids || current.pinned !== undefined) return current;
          const refs = items.map(({ id, version }) => ({ id, version }));
          return { ...current, ...(refs.length === 0 ? {} : { pinned: { version: 1, documents: refs } }) };
        });
      })
      .catch(() => {
        if (!abort.signal.aborted) setLookup({ ids, items: null });
      });
    return () => abort.abort();
  }, [active, ids]);

  useEffect(() => {
    if (incoming) return;
    try {
      sessionStorage.setItem(ASK_SCOPE_SESSION_KEY, JSON.stringify({ account, selection }));
    } catch {
      // The in-memory selection still applies in the current tab.
    }
  }, [account, incoming, selection]);

  const resolved = lookup?.ids === ids ? lookup?.items : undefined;
  const items = new Map(resolved?.map((item) => [item.id, item]));
  const pins = selection.kind === 'selected' ? selection.pinned : undefined;
  const documentScope = pins && ids?.length === pins.documents.length &&
    pins.documents.every((ref) => items.get(ref.id)?.version === ref.version) ? pins : undefined;
  const origin = selection.kind === 'selected' ? selection.origin : undefined;
  function remove(id: string) {
    if (selection.kind !== 'selected') return;
    const remaining = selection.ids.filter((item) => item !== id);
    const documents = selection.pinned?.documents.filter((ref) => ref.id !== id) ?? [];
    const { pinned: _pinned, ...rest } = selection;
    setSelection({ ...rest, ids: remaining, ...(documents.length === 0 ? {} : { pinned: { version: 1, documents } }) });
  }
  return {
    kind: selection.kind, documentScope, origin, selectedIds: ids ?? [],
    ready: !incoming && (selection.kind === 'all' || documentScope !== undefined),
    pending: incoming || (ids !== undefined && ids.length !== 0 && resolved === undefined),
    items, remove, clear: () => setSelection({ kind: 'all' }),
  };
}
