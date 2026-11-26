import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NOTE_BODY_LIMIT, NOTE_TITLE_LIMIT, type AskResponse, type NoteRunInput, type ResearchNote } from '@knowpilot/shared';
import { isAnswerBlocks } from '@knowpilot/shared/answer-blocks';
import { apiPost, toApiError } from '../../api.ts';
import { useAuth } from '../../auth.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { qualifyNoteCitations, selectedNoteText } from '../notes/note-citations.ts';

export interface NoteDraft {
  ownerId: string;
  body: string;
  run: NoteRunInput;
  citationIds: readonly string[];
}

function answerForNote({ answer }: AskResponse) {
  if (!isAnswerBlocks(answer.blocks)) return answer.answer;
  const citations = new Set(answer.citations.map(({ id }) => id));
  const blocks = answer.blocks.items.flatMap((block) => {
    if (block.kind === 'fallback') return [];
    if ('points' in block) {
      if (block.points.some((point) => !citations.has(point.evidenceId))) return [];
      return [[`${block.metric} · ${block.dataset} · ${block.setting} · ${block.protocol}`,
        ...block.points.map((point) => `[${point.evidenceId}] ${point.value} ${block.unit}`)].join('\n')];
    }
    if (block.evidenceIds.some((id) => !citations.has(id))) return [];
    const sources = block.evidenceIds.map((id) => '[' + id + ']').join(' ');
    return ['text' in block ? [block.text, sources].filter(Boolean).join('\n') : '关联证据 ' + sources];
  });
  return [answer.answer, ...blocks].join('\n\n');
}

export function AskNoteActions({ result }: { result: AskResponse }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const toolbar = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const update = () => {
      const body = toolbar.current?.closest('article')?.querySelector('.ask-note-content');
      const range = window.getSelection();
      const inside = range?.rangeCount === 1 && range.anchorNode !== null && range.focusNode !== null &&
        body?.contains(range.anchorNode) && body.contains(range.focusNode);
      setSelection(inside ? selectedNoteText(range) : '');
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, []);

  function draft(mode: 'answer' | 'selection'): NoteDraft | undefined {
    if (user === null) return undefined;
    const body = mode === 'selection' ? selection : answerForNote(result);
    if (body.trim() === '' || body.length > NOTE_BODY_LIMIT) {
      setNotice('请选择一段正文保存，或缩短选段。');
      return undefined;
    }
    setNotice('');
    return { ownerId: user.id, body, run: { runId: result.runId, mode },
      citationIds: result.answer.citations.map(({ id }) => id) };
  }

  async function save(mode: 'answer' | 'selection') {
    const copy = draft(mode);
    if (copy === undefined || busy) return;
    const body = qualifyNoteCitations(copy.body, 1, copy.citationIds, copy.run.mode);
    if (body.length > NOTE_BODY_LIMIT) {
      setNotice('加上来源标记后超过笔记长度上限，请缩短选段。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const note = await apiPost<ResearchNote>('/api/v1/research-notes', {
        title: result.question.trim().slice(0, NOTE_TITLE_LIMIT) || '研究笔记',
        body, tags: [], runs: [copy.run],
      });
      void navigate('/knowledge/notes?note=' + encodeURIComponent(note.id));
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  function append() {
    const copy = draft(selection === '' ? 'answer' : 'selection');
    if (copy !== undefined) void navigate('/knowledge/notes', { state: { noteDraft: copy } });
  }

  return (
    <div ref={toolbar} className="ask-note-actions">
      <div className="note-buttons" role="group" aria-label="研究笔记操作">
        <button type="button" disabled={busy} onClick={() => void save('answer')}>转为研究笔记</button>
        <button type="button" disabled={busy || selection === ''} onClick={() => void save('selection')}
          onPointerDown={(event) => { if (event.pointerType === 'mouse') event.preventDefault(); }}>保存选段</button>
        <button type="button" disabled={busy} onClick={append}
          onPointerDown={(event) => { if (event.pointerType === 'mouse') event.preventDefault(); }}>追加到已有笔记</button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error !== null && <ErrorNotice error={error} />}
    </div>
  );
}
