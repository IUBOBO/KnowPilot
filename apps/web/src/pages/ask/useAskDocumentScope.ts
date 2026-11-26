import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ASK_HISTORY_LIMIT, parseAskDocumentIds, parseAskDocumentScope, parseSearchAskHandoff,
  type AskDocumentScopeV1, type AskScopeDocument,
} from '@knowpilot/shared';
import { apiPost } from '../../api.ts';
import {
  ASK_SCOPE_SESSION_KEY, readNoteSearchState, type NoteSearchState, type SearchContext,
} from '../../ask-session.ts';
type Selection = { kind: 'all' | 'invalid'; origin?: SearchContext } | {
  kind: 'selected'; ids: readonly string[]; origin: SearchContext; pinned?: AskDocumentScopeV1;
};

type SavedSelections = {
  account: string;
  selection?: Selection;
  research?: [string, Selection][];
};

function readSelections(account: string): SavedSelections {
  const saved = JSON.parse(sessionStorage.getItem(ASK_SCOPE_SESSION_KEY) ?? 'null') as SavedSelections | null;
  return saved?.account === account ? saved : { account };
}

function readSelection(account: string, entry: NoteSearchState | undefined): Selection {
  const researchThread = entry?.researchThread;
  const note = entry?.researchThread === undefined ? undefined : { researchThread: entry.researchThread, noteResearchTopic: entry.noteResearchTopic };
  const fallback: Selection = note === undefined ? { kind: 'all' } : { kind: 'invalid', origin: { query: '', ...note } };
  try {
    const saved = readSelections(account);
    const cached = Array.isArray(saved.research) ? saved.research.find((row) => Array.isArray(row) && row[0] === researchThread)?.[1] : undefined;
    const selection = cached ?? saved.selection;
    if (selection === undefined || selection.origin?.researchThread !== researchThread) return fallback;
    if (selection.kind !== 'selected') return { ...fallback, kind: selection.kind === 'all' ? 'all' : 'invalid' };
    const ids = parseAskDocumentIds(selection.ids);
    const origin = parseSearchAskHandoff({ ...selection.origin, version: 1, documentIds: ids });
    const pinned = parseAskDocumentScope(selection.pinned);
    if (ids === undefined || origin === undefined || (selection.pinned !== undefined &&
      (pinned === undefined || pinned.documents.some((ref) => !ids.includes(ref.id))))) return { ...fallback, kind: 'invalid' };
    return { kind: 'selected', ids, origin: { ...origin, ...note },
      ...(pinned === undefined ? {} : { pinned }) };
  } catch {
    return { ...fallback, kind: 'invalid' };
  }
}

function saveSelection(account: string, selection: Selection) {
  const saved = readSelections(account);
  const researchThread = selection.origin?.researchThread;
  if (researchThread === undefined) saved.selection = selection;
  else {
    const previous = Array.isArray(saved.research) ? saved.research : [];
    const next: [string, Selection] = [researchThread, selection];
    saved.research = [...previous.filter(([key]) => key !== researchThread), next].slice(-ASK_HISTORY_LIMIT);
  }
  sessionStorage.setItem(ASK_SCOPE_SESSION_KEY, JSON.stringify(saved));
}

export function searchContextLink(
  context: SearchContext, ownerId: string | undefined, documentId = context.documentId,
): { to: string; state?: NoteSearchState } {
  const query = context.query.trim().slice(0, 100);
  const params = new URLSearchParams();
  if (context.researchThread === undefined && query !== '') params.set('q', query);
  if (documentId !== undefined || context.kind === 'document') params.set('kind', 'document');
  if (documentId !== undefined) params.set('documentId', documentId);
  if (context.material !== undefined) params.set('material', context.material);
  const to = params.size === 0 ? '/search' : '/search?' + params;
  return context.researchThread === undefined || ownerId === undefined ? { to }
    : { to, state: { ownerId, noteResearchTopic: context.noteResearchTopic ?? query, researchThread: context.researchThread } };
}

export function useAskDocumentScope(active: boolean, account: string, ownerId: string | undefined, onQuery: (value: string) => void) {
  const location = useLocation();
  const navigate = useNavigate();
  const handled = useRef<string | undefined>(undefined);
  const state = location.state as { searchHandoff?: unknown; noteSearch?: unknown; noteEntry?: unknown } | null;
  const entry = readNoteSearchState(state?.noteEntry, ownerId);
  const [selection, setSelection] = useState(() => readSelection(account, entry));
  const [lookup, setLookup] = useState<{ ids: readonly string[]; items: readonly AskScopeDocument[] | null }>();
  const ids = selection.kind === 'selected' ? selection.ids : undefined;
  const handoff = state?.searchHandoff;
  const incoming = active && handoff !== undefined && handled.current !== location.key;
  const restoring = active && handoff === undefined && entry?.researchThread !== selection.origin?.researchThread;
  useEffect(() => {
    if (restoring) {
      setSelection(readSelection(account, entry));
      onQuery('');
    }
  }, [restoring, account, entry, onQuery]);

  useEffect(() => {
    if (!incoming) return;
    handled.current = location.key;
    const { searchHandoff: _handoff, noteSearch, noteEntry: _entry, ...remaining } = state ?? {};
    const parsed = parseSearchAskHandoff(handoff);
    const note = readNoteSearchState(noteSearch, ownerId);
    const researchThread = note === undefined ? undefined : note.researchThread ?? location.key;
    const noteOrigin = note === undefined || researchThread === undefined ? undefined
      : { researchThread, noteResearchTopic: note.noteResearchTopic };
    void navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, {
      replace: true, state: noteOrigin === undefined ? remaining : {
        ...remaining, noteEntry: { ownerId: note?.ownerId, ...noteOrigin },
      },
    });
    if (parsed === undefined || (noteSearch !== undefined && note === undefined)) {
      setSelection({ kind: 'invalid', ...(noteOrigin === undefined ? {}
        : { origin: { query: '', ...noteOrigin } }) });
      return;
    }
    const { documentIds, version: _version, ...origin } = parsed;
    setSelection({ kind: 'selected', ids: documentIds, origin: { ...origin, ...noteOrigin } });
    onQuery(note === undefined ? origin.query : '');
  }, [handoff, incoming, location.key, location.pathname, location.search, location.hash, navigate, onQuery, ownerId, state]);

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
    if (incoming || restoring) return;
    try {
      saveSelection(account, selection);
    } catch {
      // The in-memory selection still applies in the current tab.
    }
  }, [account, incoming, restoring, selection]);

  const resolved = lookup?.ids === ids ? lookup?.items : undefined;
  const items = new Map(resolved?.map((item) => [item.id, item]));
  const pins = selection.kind === 'selected' ? selection.pinned : undefined;
  const documentScope = pins && ids?.length === pins.documents.length &&
    pins.documents.every((ref) => items.get(ref.id)?.version === ref.version) ? pins : undefined;
  const origin = selection.origin;
  function remove(id: string) {
    if (selection.kind !== 'selected') return;
    const remaining = selection.ids.filter((item) => item !== id);
    const documents = selection.pinned?.documents.filter((ref) => ref.id !== id) ?? [];
    const { pinned: _pinned, ...rest } = selection;
    setSelection({ ...rest, ids: remaining, ...(documents.length === 0 ? {} : { pinned: { version: 1, documents } }) });
  }
  return {
    kind: selection.kind, documentScope, origin, selectedIds: ids ?? [],
    ready: !incoming && !restoring && (selection.kind === 'all' || documentScope !== undefined),
    pending: incoming || restoring || (ids !== undefined && ids.length !== 0 && resolved === undefined),
    items, remove, clear: () => setSelection(origin?.researchThread === undefined ? { kind: 'all' }
      : { kind: 'all', origin: { query: origin.query, researchThread: origin.researchThread,
        ...(origin.noteResearchTopic === undefined ? {} : { noteResearchTopic: origin.noteResearchTopic }) } }),
  };
}
