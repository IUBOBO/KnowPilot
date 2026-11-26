import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ASK_DOCUMENT_SCOPE_LIMIT, NOTE_BODY_LIMIT, NOTE_RUN_MODES, NOTE_TAG_CHARS, NOTE_TAG_LIMIT, NOTE_TITLE_LIMIT, evidenceMarker,
  type EvidenceOpenRequest, type NoteRunMode, type ResearchNote, type ResearchNoteSummary, type SearchAskHandoffV1,
} from '@knowpilot/shared';
import { apiDelete, apiGet, apiPatch, apiPost, isAbort, toApiError, type ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { EvidenceViewer, useEvidenceViewer } from '../components/evidence/EvidenceViewer.tsx';
import { PageTitle } from '../components/PageTitle.tsx';
import { fmtDateTime } from '../format.ts';
import { DraftSourceAction } from './knowledge/DraftSourceAction.tsx';
import type { NoteDraft } from './ask/AskNoteActions.tsx';
import { noteCitationLabel, qualifyNoteCitations } from './notes/note-citations.ts';
import './notes/notes.css';

interface NotesPage {
  items: readonly ResearchNoteSummary[];
  nextOffset: number | null;
}

function noteDraftOf(state: unknown, ownerId: string): NoteDraft | undefined {
  if (typeof state !== 'object' || state === null || !('noteDraft' in state)) return undefined;
  const draft = state.noteDraft as NoteDraft | null;
  if (draft?.ownerId !== ownerId || typeof draft.body !== 'string' || draft.body.length > NOTE_BODY_LIMIT ||
    typeof draft.run?.runId !== 'string' || !NOTE_RUN_MODES.includes(draft.run.mode) ||
    !Array.isArray(draft.citationIds) || !draft.citationIds.every((id) => typeof id === 'string')) return undefined;
  return draft;
}

function noteHref(id: string) {
  return '/knowledge/notes?note=' + encodeURIComponent(id);
}

export function ResearchNotesPage() {
  const { user } = useAuth();
  return user === null ? null : <OwnedNotesPage key={user.id} ownerId={user.id} />;
}

function OwnedNotesPage({ ownerId }: { ownerId: string }) {
  const [params] = useSearchParams();
  const noteId = params.get('note');
  const location = useLocation();
  const navigate = useNavigate();
  const noteDraft = noteDraftOf(location.state, ownerId);
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState<NotesPage | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    setList(null);
    const qs = new URLSearchParams({ q: query, offset: String(offset) });
    apiGet<NotesPage>('/api/v1/research-notes?' + qs, ac.signal, { cache: 'no-store' })
      .then((data) => { if (!ac.signal.aborted) setList(data); })
      .catch((err: unknown) => { if (!isAbort(err) && !ac.signal.aborted) setError(toApiError(err)); });
    return () => ac.abort();
  }, [query, offset, refresh]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOffset(0);
    setQuery(searchText.trim());
    setRefresh((n) => n + 1);
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const note = await apiPost<ResearchNote>('/api/v1/research-notes', { title: '未命名笔记', body: '', tags: [] });
      setOffset(0);
      setSearchText('');
      setQuery('');
      setRefresh((n) => n + 1);
      void navigate(noteHref(note.id), { state: location.state });
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <PageTitle icon="capture">研究笔记</PageTitle>
        <Link to="/knowledge">知识沉淀</Link>
      </div>
      {noteDraft !== undefined && <p role="status">打开一条笔记，即可将本次答复或选段追加到正文。</p>}
      <div className="notes-layout">
        <section className="card notes-list" aria-label="我的笔记">
          <h2>我的笔记</h2>
          <button type="button" disabled={busy} onClick={() => void create()}>新建笔记</button>
          <form onSubmit={search} className="notes-search">
            <label className="field">
              <span>查找笔记</span>
              <input type="search" value={searchText} maxLength={160} onChange={(e) => setSearchText(e.target.value)} />
            </label>
            <button type="submit">查找</button>
          </form>
          {error !== null && <ErrorNotice error={error} onRetry={() => setRefresh((n) => n + 1)} />}
          {list === null && error === null && <p role="status">正在读取笔记…</p>}
          {list?.items.length === 0 && <p className="dim">没有找到笔记。</p>}
          {(list?.items.length ?? 0) > 0 && <ul>
            {list?.items.map((note) => (
              <li key={note.id}>
                <Link to={noteHref(note.id)} state={location.state}
                  {...(note.id === noteId ? { 'aria-current': 'page' } : {})}>{note.title}</Link>
                <div className="dim">{fmtDateTime(note.updatedAt)}</div>
                {note.tags.length > 0 && <small>{note.tags.join(' · ')}</small>}
              </li>
            ))}
          </ul>}
          {(offset > 0 || (list?.nextOffset != null)) && <div className="note-buttons">
            <button type="button" disabled={offset === 0} onClick={() => setOffset((n) => Math.max(0, n - 40))}>上一页</button>
            <button type="button" disabled={list?.nextOffset == null}
              onClick={() => { if (list?.nextOffset != null) setOffset(list.nextOffset); }}>下一页</button>
          </div>}
        </section>
        {noteId === null ? <p className="dim">选择或创建一条笔记。</p>
          : <NoteEditor key={noteId} id={noteId} draft={noteDraft}
              refreshList={() => setRefresh((n) => n + 1)}
              clearDraft={() => void navigate(noteHref(noteId), { replace: true })}
              onDeleted={() => { setOffset(0); setRefresh((n) => n + 1); void navigate('/knowledge/notes', { replace: true }); }} />}
      </div>
    </div>
  );
}

function NoteEditor({ id, draft, refreshList, clearDraft, onDeleted }: {
  id: string;
  draft: NoteDraft | undefined;
  refreshList: () => void;
  clearDraft: () => void;
  onDeleted: () => void;
}) {
  const url = '/api/v1/research-notes/' + encodeURIComponent(id);
  const [note, setNote] = useState<ResearchNote | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    apiGet<ResearchNote>(url, ac.signal, { cache: 'no-store' })
      .then((item) => { if (!ac.signal.aborted) setNote(item); })
      .catch((err: unknown) => { if (!isAbort(err) && !ac.signal.aborted) setError(toApiError(err)); });
    return () => ac.abort();
  }, [url, attempt]);

  if (error !== null) return <ErrorNotice error={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (note === null) return <p role="status">正在打开笔记…</p>;
  return <NoteForm key={attempt} note={note} url={url} draft={draft}
    onSaved={(item, appended) => {
      setNote(item);
      refreshList();
      if (appended) clearDraft();
    }}
    onReload={() => setAttempt((n) => n + 1)} onDeleted={onDeleted} />;
}

function NoteForm({ note, url, draft, onSaved, onReload, onDeleted }: {
  note: ResearchNote;
  url: string;
  draft: NoteDraft | undefined;
  onSaved: (item: ResearchNote, appended: boolean) => void;
  onReload: () => void;
  onDeleted: () => void;
}) {
  const { user } = useAuth();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [tags, setTags] = useState(note.tags.join('，'));
  const [append, setAppend] = useState<NoteDraft>();
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const catalog = note.runs.flatMap((run) => run.sources.flatMap((source) => {
    if (source.status !== 'available') return [];
    const request: EvidenceOpenRequest = {
      version: 1, locator: source.locator, citation: { runId: run.runId, citationId: source.citationId },
    };
    const path = url + '/runs/' + encodeURIComponent(run.runId) + '/sources/' + encodeURIComponent(source.citationId);
    return [{ request, requireMatchingVersion: true, sourcePath: source.locator.kind === 'document' ? path : path + '/record' }];
  }));
  const evidence = useEvidenceViewer(catalog, note.id + ':' + note.revision);
  const documentIds = [...new Set(catalog.flatMap(({ request }) => request.locator.kind === 'document'
    ? [request.locator.documentId] : []))];
  const handoff: SearchAskHandoffV1 | undefined = documentIds.length > 0 && documentIds.length <= ASK_DOCUMENT_SCOPE_LIMIT
    ? { version: 1, query: '', kind: 'document', documentIds } : undefined;

  function applyDraft() {
    if (draft === undefined || append !== undefined) return;
    const oldIndex = note.runs.findIndex((run) => run.runId === draft.run.runId);
    const round = oldIndex < 0 ? note.runs.length + 1 : oldIndex + 1;
    const excerpt = qualifyNoteCitations(draft.body, round, draft.citationIds, draft.run.mode);
    const next = body === '' ? excerpt : body + '\n\n' + excerpt;
    if (next.length > NOTE_BODY_LIMIT) {
      setNotice('追加后超过正文长度上限，请先缩短正文。');
      return;
    }
    setBody(next);
    setAppend(draft);
    setNotice('已加入本次答复。保存后将关联对应问答。');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const labels = [...new Set(tags.split(/[,，]/u).map((tag) => tag.trim()).filter(Boolean))];
    if (labels.length > NOTE_TAG_LIMIT || labels.some((label) => label.length > NOTE_TAG_CHARS)) {
      setNotice('最多 12 个标签，每个标签最多 32 字。');
      return;
    }
    if (busy) return;
    setBusy(true);
    setNotice('');
    setError(null);
    try {
      const next = await apiPatch<ResearchNote>(url, { revision: note.revision, title, body, tags: labels,
        ...(append === undefined ? {} : { appendRuns: [append.run] }) });
      const appended = append !== undefined;
      setTitle(next.title);
      setBody(next.body);
      setTags(next.tags.join('，'));
      setAppend(undefined);
      setNotice('笔记已保存。');
      onSaved(next, appended);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await apiDelete(url + '?revision=' + note.revision);
      onDeleted();
    } catch (err) {
      setError(toApiError(err));
      setDeleting(false);
    } finally {
      setBusy(false);
    }
  }

  return <EvidenceViewer reader={evidence.reader}>
    <section className="card notes-editor" aria-label="编辑笔记">
    <h2>{note.title}</h2>
    <p className="dim">仅自己可见</p>
    {draft !== undefined && <button type="button" disabled={busy || append !== undefined} onClick={applyDraft}>追加到这条笔记</button>}
    <form onSubmit={(event) => void save(event)}>
      <label className="field"><span>标题</span>
        <input type="text" required readOnly={busy} value={title} maxLength={NOTE_TITLE_LIMIT} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field"><span>正文</span>
        <textarea rows={9} readOnly={busy} value={body} maxLength={NOTE_BODY_LIMIT} onChange={(e) => setBody(e.target.value)} />
      </label>
      <label className="field"><span>标签</span>
        <input type="text" readOnly={busy} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="用逗号分隔" />
      </label>
      <div className="note-buttons">
        <button type="submit" className="btn-primary" aria-disabled={busy} disabled={title.trim() === ''}>保存笔记</button>
        <button type="button" disabled={busy} onClick={() => setDeleting(true)}>删除笔记</button>
      </div>
    </form>
    {notice !== '' && <p role="status">{notice}</p>}
    {error !== null && <ErrorNotice error={error} onRetry={onReload} />}
    <section aria-label="继续研究">
      <h3>继续研究</h3>
      {handoff === undefined
        ? <Link to="/search" state={{ noteResearchTopic: note.title.slice(0, 100), ownerId: user?.id }}>打开检索选取研究资料</Link>
        : <Link to="/ask" state={{ searchHandoff: handoff, noteSearch: { ownerId: user?.id, noteResearchTopic: note.title.slice(0, 100) } }}>使用可用文档继续问答（{documentIds.length} 份）</Link>}
    </section>
    {!busy && title === note.title && body === note.body && tags === note.tags.join('，') && append === undefined &&
      <DraftSourceAction key={note.id + ':' + note.revision} noteBody={note.body}
        source={{ kind: 'note', id: note.id, revision: note.revision }} />}
    {note.runs.length > 0 && <section aria-label="关联问答与来源">
      <h3>关联问答与来源</h3>
      <p className="dim">正文由你编辑。原始证据在阅读器中重新读取。</p>
      {note.runs.length > 1 && evidenceMarker().test(body) && <p className="dim">未标轮次的旧引用请按以下问答核对。</p>}
      <ol>{note.runs.map((run, index) => <li key={run.runId}>
        <p>第 {index + 1} 轮 · {run.question ?? '这次问答的原记录不可读取'} · {runModeLabel[run.mode]}</p>
        <small className="dim">运行编号 {run.runId}</small>
        {run.sources.length === 0 ? <p className="dim">无可核实的引用记录。</p> :
          <ul>{run.sources.map((source) => <li key={source.citationId}>
            {source.status === 'available'
              ? <button type="button" onClick={(event) => evidence.openFrom({
                  version: 1, locator: source.locator, citation: { runId: run.runId, citationId: source.citationId },
                }, event.currentTarget)}>查看来源 {source.title} [{noteCitationLabel(index + 1, source.citationId)}]</button>
              : <span className="dim">[{noteCitationLabel(index + 1, source.citationId)}] {source.status === 'changed'
                ? '来源版本已变化，无法重读引用版本。' : '来源不可读取，可能已失效或无访问权限。'}</span>}
          </li>)}</ul>}
      </li>)}</ol>
    </section>}
    <ConfirmDialog open={deleting} title="删除笔记" confirmLabel="确认删除" busyLabel="正在删除"
      cancelLabel="取消" busy={busy} danger onConfirm={() => void remove()} onCancel={() => setDeleting(false)}>
      <p>删除后将移除这条笔记及其来源关联。</p>
    </ConfirmDialog>
    </section>
  </EvidenceViewer>;
}

const runModeLabel: Record<NoteRunMode, string> = { answer: '完整答复', selection: '答复选段', reference: '关联运行' };
