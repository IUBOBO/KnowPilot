import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  KNOWLEDGE_MAX_INPUT_CHARS, KNOWLEDGE_MIN_INPUT_CHARS,
  type CreateKnowledgeDraftsResponse, type KnowledgeDraftSource, type KnowledgeNoteSelection,
} from '@knowpilot/shared';
import { apiPost, toApiError, type ApiError } from '../../api.ts';
import { useAuth } from '../../auth.tsx';
import { ConsentBar } from '../../components/ConsentBar.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Modal } from '../../components/Modal.tsx';

const SOURCE_LABELS = {
  manual: '手动输入',
  ask: '所选的问答片段',
  note: '当前已保存的笔记正文',
  document: '当前资料段落',
} satisfies Record<KnowledgeDraftSource['kind'], string>;

export function DraftSourceAction({ source, disabled = false, noteBody }: {
  source: KnowledgeDraftSource; disabled?: boolean; noteBody?: string;
}) {
  const { can, user } = useAuth();
  const [pending, setPending] = useState<{ source: KnowledgeDraftSource; owner: string; selectFrom?: string }>();
  const [selection, setSelection] = useState<KnowledgeNoteSelection>();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [draft, setDraft] = useState<CreateKnowledgeDraftsResponse>();
  if (user === null || !can('knowledge.submit')) return null;

  const current = pending?.owner === user.id ? pending : undefined;
  const selectedLength = selection === undefined ? 0 : (current?.selectFrom?.slice(selection.start, selection.end).trim().length ?? 0);
  const validSelection = current?.selectFrom === undefined ||
    (selectedLength >= KNOWLEDGE_MIN_INPUT_CHARS && selectedLength <= KNOWLEDGE_MAX_INPUT_CHARS);
  function open() {
    if (user === null) return;
    const saved = source.kind === 'note' ? noteBody?.replace(/\r\n?/gu, '\n') : undefined;
    const selectFrom = (saved?.trim().length ?? 0) > KNOWLEDGE_MAX_INPUT_CHARS ? saved : undefined;
    setPending({ source, owner: user.id, ...(selectFrom === undefined ? {} : { selectFrom }) });
    setSelection(undefined);
    setConsent(false);
    setError(null);
    setDraft(undefined);
  }

  async function submit() {
    if (current === undefined || !consent || !validSelection || busy) return;
    setBusy(true);
    setError(null);
    try {
      setDraft(await apiPost<CreateKnowledgeDraftsResponse>('/api/v1/knowledge/drafts', {
        source: current.source.kind === 'note' && selection !== undefined
          ? { ...current.source, selection } : current.source,
        consentConfirmed: true,
      }));
    } catch (failure) {
      setError(toApiError(failure));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button type="button" disabled={disabled} onClick={open}
      onPointerDown={(event) => { if (source.kind === 'ask' && event.pointerType === 'mouse') event.preventDefault(); }}>
      提炼为知识草稿
    </button>
    <Modal open={current !== undefined} title="提炼为知识草稿" onClose={() => { if (!busy) setPending(undefined); }}
      footer={<>
        <button type="button" disabled={busy} onClick={() => setPending(undefined)}>{draft === undefined ? '取消' : '关闭'}</button>
        {draft === undefined && <button type="button" className="btn-primary" disabled={!consent || !validSelection || busy}
          onClick={() => void submit()}>{busy ? '正在提炼…' : '生成待确认草稿'}</button>}
      </>}>
      {draft === undefined ? <>
        {current !== undefined && <p>本次素材为{SOURCE_LABELS[current.source.kind]}。</p>}
        {current?.selectFrom !== undefined && <>
          <label className="field">
            <span>从已保存笔记中选择要提炼的片段</span>
            <textarea value={current.selectFrom} rows={8} readOnly disabled={busy} onSelect={(event) => {
              const { selectionStart, selectionEnd } = event.currentTarget;
              setSelection({ start: selectionStart, end: selectionEnd });
              setConsent(false);
            }} />
          </label>
          <p className="dim">已选 {selectedLength} / {KNOWLEDGE_MAX_INPUT_CHARS} 字</p>
        </>}
        <ConsentBar checked={consent} onCheckedChange={setConsent} disabled={busy}
          pending="本次所选素材会发往云端模型" granted="已授权本次素材发往云端模型">
          <p>生成的草稿先由你预览、编辑。只有在知识沉淀页确认后才会提交入库。</p>
        </ConsentBar>
        {error !== null && <ErrorNotice error={error} />}
      </> : <p role="status">共 {draft.entries.length} 条草稿。 <Link to="/knowledge">去知识沉淀页预览和编辑</Link></p>}
    </Modal>
  </>;
}
