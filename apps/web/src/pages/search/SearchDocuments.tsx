import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MATERIAL_LABELS, SEARCH_MAX_LIMIT, formatSectionPath,
  type DocumentRetrievalHit, type EvidenceOpenRequest, type OpenEvidence,
} from '@knowpilot/shared';
import { openEvidenceLink } from '../../components/evidence/EvidenceViewer.tsx';
import { groupPassagesByDocument, pageSearchSample } from './search-results.ts';

export function passageRequest({ documentId, chunkId, sourceVersion }: DocumentRetrievalHit): EvidenceOpenRequest {
  return { version: 1, locator: { kind: 'document', documentId, chunkId, sourceVersion } };
}

function PassageLink({ hit, onOpen, children }: {
  hit: DocumentRetrievalHit;
  onOpen: OpenEvidence;
  children: string;
}) {
  return <Link className="hit-title" to={`/chunk/${encodeURIComponent(hit.chunkId)}`}
    onClick={(event) => openEvidenceLink(event, () => onOpen(passageRequest(hit)))}>{children}</Link>;
}

function PassageExcerpt({ hit }: { hit: DocumentRetrievalHit }) {
  const section = formatSectionPath(hit.sectionPath);
  const location = [hit.page === null ? '' : `第 ${hit.page} 页`, section].filter(Boolean).join(' · ');
  return <>
    {location && <p className="search-passage-location">{location}</p>}
    <p className="search-excerpt">{hit.segments.map((segment, index) => segment.hit
      ? <mark key={index}>{segment.text}</mark> : segment.text)}</p>
  </>;
}

export function DocumentCheckbox({ id, title, selected, onToggle }: {
  id: string;
  title: string;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  return <input type="checkbox" className="search-select-document" aria-label={`选择 ${title}`}
    checked={selected.has(id)} onChange={() => onToggle(id)} />;
}

export function SearchDocuments({ passages, selected, onToggle, onOpen, scopedSearch }: {
  passages: readonly DocumentRetrievalHit[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onOpen: OpenEvidence;
  scopedSearch: ((documentId: string) => string) | undefined;
}) {
  const [view, setView] = useState<'documents' | 'passages'>('documents');
  const [page, setPage] = useState(0);
  const documents = groupPassagesByDocument(passages);
  const groups = view === 'documents' ? documents : passages.map((hit) => [hit]);
  const { pageIndex, pageCount, rows } = pageSearchSample(groups, page);
  function switchView(next: typeof view) {
    if (next === view) return;
    setView(next);
    setPage(0);
  }

  return <section className="card search-documents" aria-labelledby="search-document-results">
    <div className="search-results-head">
      <div>
        <h2 id="search-document-results">文档正文</h2>
        <p className="search-counts">{documents.length} 份资料，{passages.length} 个片段</p>
      </div>
      {passages.length > 0 && <div className="search-view" role="group" aria-label="结果视图">
        <button type="button" aria-pressed={view === 'documents'} onClick={() => switchView('documents')}>按文档</button>
        <button type="button" aria-pressed={view === 'passages'} onClick={() => switchView('passages')}>按片段</button>
      </div>}
    </div>
    <p className="dim search-count-note">按相关性排序。每次最多返回 {SEARCH_MAX_LIMIT} 个片段，统计限于本次返回的结果。</p>
    {passages.length === 0 ? <p role="status" className="search-empty">未找到匹配的文档片段。</p> : <>
      <ul className="search-result-list">
        {rows.map(([hit, ...remaining]) => hit === undefined ? null : <li
          key={view === 'documents' ? hit.documentId : hit.chunkId} className="search-result-row">
          <DocumentCheckbox id={hit.documentId} title={hit.documentTitle} selected={selected} onToggle={onToggle} />
          <div className="search-result-body">
            <div className="search-result-title">
              <h3><PassageLink hit={hit} onOpen={onOpen}>{hit.documentTitle}</PassageLink></h3>
              <span className="search-material-label">{MATERIAL_LABELS[hit.material]}</span>
            </div>
            <PassageExcerpt hit={hit} />
            <div className="search-result-actions">
              <PassageLink hit={hit} onOpen={onOpen}>预览命中原文</PassageLink>
              {scopedSearch !== undefined && <Link to={scopedSearch(hit.documentId)}>仅检索此资料</Link>}
            </div>
            {remaining.length > 0 && <details className="search-more-passages">
              <summary>展开其余 {remaining.length} 个命中片段</summary>
              <ol>
                {remaining.map((passage, index) => <li key={passage.chunkId}>
                  <PassageExcerpt hit={passage} />
                  <PassageLink hit={passage} onOpen={onOpen}>{`预览命中片段 ${index + 2}`}</PassageLink>
                </li>)}
              </ol>
            </details>}
          </div>
        </li>)}
      </ul>
      {pageCount > 1 && <nav className="search-pagination" aria-label="文档正文分页">
        <button type="button" aria-disabled={pageIndex === 0} onClick={() => {
          if (pageIndex > 0) setPage(pageIndex - 1);
        }}>上一页</button>
        <span role="status">第 {pageIndex + 1} / {pageCount} 页</span>
        <button type="button" aria-disabled={pageIndex + 1 === pageCount} onClick={() => {
          if (pageIndex + 1 < pageCount) setPage(pageIndex + 1);
        }}>下一页</button>
      </nav>}
    </>}
  </section>;
}
