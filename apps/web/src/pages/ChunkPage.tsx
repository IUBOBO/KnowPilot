import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  MATERIAL_LABELS,
  formatSectionPath,
  type ChunkContextResponse,
} from '@knowpilot/shared';
import { apiGet, isAbort, toApiError, type ApiError } from '../api.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { DraftSourceAction } from './knowledge/DraftSourceAction.tsx';
import { FileTypeIcon } from '../components/FileTypeIcon.tsx';

/**
 * 单一检索块的原文视图。问答里点「查看原文」就是打开它。
 *
 * 【为什么要显示同页的其他块】
 *   只显示被引的那一块，用户看到的是一个孤立的几百字片段，
 *   没法确认"它的上下文是不是这个意思" —— 而这正是点进来的全部目的。
 *   带上同页邻居，用户才能验证引用没有断章取义。
 */
export function ChunkPage() {
  const { chunkId = '' } = useParams();
  const [context, setContext] = useState<ChunkContextResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    apiGet<ChunkContextResponse>(`/api/v1/chunks/${encodeURIComponent(chunkId)}`, ac.signal, { cache: 'no-store' })
      .then((res) => {
        if (ac.signal.aborted) return;
        setContext(res);
        setError(null);
      })
      .catch((err: unknown) => {
        if (isAbort(err)) return;
        setError(toApiError(err));
      })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [chunkId]);

  const back = <Link className="chunk-back" to="/ask">← 返回知识问答</Link>;
  if (loading) return <>{back}<p className="dim" role="status">正在读取原文…</p></>;
  if (error !== null) return <>{back}<ErrorNotice error={error} /></>;
  if (context === null || context.chunk.id !== chunkId) return null;

  const { document: doc, chunk, siblings } = context;

  return (
    <>
      {back}

      <div className="chunk-document-head">
        <FileTypeIcon fileName={doc.fileName} title={doc.title} />
        <div>
          <h1>{doc.title}</h1>
          <p className="dim">原文片段 · {MATERIAL_LABELS[doc.material]} · 第 {chunk.ordinal + 1} 段</p>
        </div>
        <a className="btn-outline chunk-download" href={`/api/v1/documents/${doc.id}/file`}>
          {context.archivedIndexVersion === undefined ? '下载原件' : '下载当前原件'}
        </a>
      </div>

      {context.archivedIndexVersion === undefined && context.sourceVersion !== undefined &&
        <DraftSourceAction source={{ kind: 'document', id: doc.id, chunkId: chunk.id, version: context.sourceVersion }} />}

      <div className="chunk-location">
        <span className="pill">{MATERIAL_LABELS[doc.material]}</span>
        {chunk.page !== null && <span className="pill">第 {chunk.page} 页</span>}
        {chunk.page === null && <span className="pill">无页码</span>}
        {chunk.sectionPath.length > 0 && (
          <span className="hit-path" style={{ margin: 0 }}>
            {formatSectionPath(chunk.sectionPath)}
          </span>
        )}
      </div>

      {context.archivedIndexVersion !== undefined && (
        <div className="notice" role="status">
          <p className="notice-body" style={{ margin: 0 }}>
            这是索引 v{context.archivedIndexVersion} 的历史原文片段，用于核对旧回答的引用。
            历史记录只包含保留的引用片段。下载入口指向当前原件。
          </p>
        </div>
      )}

      {chunk.page === null && (
        <div className="notice">
          <p className="notice-body" style={{ margin: 0 }}>
            这份材料没有页码（Word / 纯文本按段落切块，没有"页"的概念），
            下面显示的是被引用的那一段本身。
          </p>
        </div>
      )}

      <section className="card chunk-reader" aria-label="原文内容">
        <div className="chunk-reader-head">
          <h2>原文片段（引用段落）</h2>
          <button type="button" className="link-btn" onClick={() => {
            void navigator.clipboard.writeText(chunk.text).then(() => setCopied(true)).catch(() => setCopied(false));
          }}>{copied ? '已复制' : '复制片段'}</button>
        </div>
        <div className="chunk-target"><p className="answer-body">{chunk.text}</p></div>
        {context.archivedIndexVersion === undefined && siblings.length > 1 && (
          <div className="chunk-context">
            <h2>上下文内容</h2>
            {siblings.map((sib) => (
              <div key={sib.id} className={sib.id === chunk.id ? 'chunk-context-row current' : 'chunk-context-row'}>
                <span className="chunk-context-label">{sib.id === chunk.id ? '当前片段' : sib.ordinal < chunk.ordinal ? '上一段' : '下一段'}</span>
                <p className="answer-body">{sib.text}</p>
              </div>
            ))}
            <p className="dim chunk-context-note">同页 {siblings.length} 段，按原文顺序排列。</p>
          </div>
        )}
      </section>
    </>
  );
}
