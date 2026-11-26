import { useState } from 'react';
import {
  KNOWLEDGE_CLAIM_LABELS, KNOWLEDGE_KINDS, KNOWLEDGE_KIND_LABELS, KNOWLEDGE_MAX_INPUT_CHARS,
  type KnowledgeEntry, type KnowledgeKind,
} from '@knowpilot/shared';
import { apiPatch, toApiError, type ApiError } from '../../api.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';

const SOURCE_LABELS = { manual: '手动输入', ask: '问答选段', note: '研究笔记', document: '上传文档' };

export function DraftProvenance({ entry }: { entry: KnowledgeEntry }) {
  const origin = entry.note?.draftSource;
  const details = entry.note?.draftDetails;
  if (origin === undefined && details === undefined) return null;
  return <details className="kb-note">
    <summary>{origin === undefined ? '来源摘要' : SOURCE_LABELS[origin.kind]}
      {details === undefined ? '' : ' · ' + KNOWLEDGE_CLAIM_LABELS[details.claim]}</summary>
    {origin !== undefined && <>
      {origin.kind === 'ask' && origin.excerptVerification === 'submitted' &&
        <p>摘录由作者提交，原答复未独立核验。</p>}
      <p>来源 {origin.kind === 'manual' ? origin.id.slice(0, 12) : origin.id}
        {origin.kind === 'document' ? ' · 段落 ' + origin.chunkId : ''}</p>
      <p>来源版本 {origin.version.length > 40 ? origin.version.slice(0, 12) : origin.version}</p>
      <blockquote>{origin.excerpt}</blockquote>
    </>}
    {details?.question !== undefined && <p>问题：{details.question}</p>}
    {details?.conclusion !== undefined && <p>结论：{details.conclusion}</p>}
    {details?.conditions !== undefined && <p>适用条件：{details.conditions}</p>}
    {details?.tags !== undefined && <p>标签：{details.tags.join('、')}</p>}
    {details?.claim === 'unclassified' && <p>支持依据不足。请先编辑并补充你能确认的内容，再提交入库。</p>}
  </details>;
}

export function DraftEditor({ entry, onSaved }: { entry: KnowledgeEntry; onSaved: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(entry.content);
  const [kind, setKind] = useState<KnowledgeKind>(entry.kind);
  const [revision, setRevision] = useState(entry.note?.revision ?? 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiPatch<{ entry: KnowledgeEntry }>(`/api/v1/knowledge/${encodeURIComponent(entry.id)}/draft`, {
        content, kind, revision,
      });
      setEditing(false);
      await onSaved();
    } catch (failure) {
      setError(toApiError(failure));
    } finally {
      setBusy(false);
    }
  }

  if (!editing) return <button type="button" className="link-btn" onClick={() => {
    setContent(entry.content);
    setKind(entry.kind);
    setRevision(entry.note?.revision ?? 1);
    setError(null);
    setEditing(true);
  }}>编辑草稿</button>;

  return <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label className="field">知识类型
      <select value={kind} onChange={(event) => {
        const value = KNOWLEDGE_KINDS.find((option) => option === event.target.value);
        if (value !== undefined) setKind(value);
      }}>
        {KNOWLEDGE_KINDS.map((option) => <option key={option} value={option}>{KNOWLEDGE_KIND_LABELS[option]}</option>)}
      </select>
    </label>
    <label className="field">草稿正文
      <textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={KNOWLEDGE_MAX_INPUT_CHARS}
        rows={4} required readOnly={busy} />
    </label>
    <div className="note-buttons">
      <button type="submit" disabled={busy}>{busy ? '保存中…' : '保存修改'}</button>
      <button type="button" disabled={busy} onClick={() => setEditing(false)}>取消</button>
    </div>
    {error !== null && <ErrorNotice error={error} />}
  </form>;
}
