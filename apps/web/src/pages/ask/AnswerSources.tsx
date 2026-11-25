import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { citationEvidenceRequest, evidenceMarker, formatSectionPath, MATERIAL_LABELS, RECORD_TYPE_LABELS,
  type Citation, type OpenEvidence } from '@knowpilot/shared';
import { openEvidenceLink } from '../../components/evidence/EvidenceViewer.tsx';
import { answerEvidenceSources, loadEvidence, supportsEvidence, type LoadedEvidence } from '../../components/evidence/evidence-reader.ts';
import { fmtDateTime } from '../../format.ts';

export function AnswerSources({ citations, citationOpen }: {
  citations: readonly Citation[];
  citationOpen?: CitationOpenContext;
}) {
  return (
    <>
      <p className="dim drawer-lead">点击文中的编号，可以直接查看对应的原文或记录。</p>
      {citations.map((citation) => <CitationCard key={citation.id} citation={citation} citationOpen={citationOpen} />)}
    </>
  );
}

export function sourceHref(citation: Citation): string | undefined {
  if (citation.sourceType === 'document') return `/chunk/${encodeURIComponent(citation.chunkId)}`;
  const id = encodeURIComponent(citation.recordId);
  const title = encodeURIComponent(citation.recordTitle);
  switch (citation.recordType) {
    case 'M-PATENT': return `/patents?q=${title}&focus=${id}`;
    case 'M-SUBMIT': return `/submissions?focus=${id}`;
    case 'M-CODE': return `/datasets?focus=${id}`;
    case 'M-JOURNAL': return `/journals?q=${title}`;
    case 'M-THESIS': return `/theses?focus=${id}`;
    case 'M-PERSON': return `/people?q=${title}&focus=${id}`;
  }
}

export interface CitationOpenContext {
  runId: string;
  onOpenEvidence: OpenEvidence;
}

function openCitation(event: MouseEvent<HTMLAnchorElement>, citation: Citation, context: CitationOpenContext) {
  openEvidenceLink(event, () => {
    const request = citationEvidenceRequest(context.runId, citation);
    return request !== null && context.onOpenEvidence(request);
  });
}

export function renderAnswerCitations(
  text: string, byId: ReadonlyMap<string, Citation>, context?: CitationOpenContext,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(evidenceMarker())) {
    const at = match.index ?? 0;
    if (at > last) nodes.push(<span key={key++}>{text.slice(last, at)}</span>);
    const cite = byId.get('E' + (match[1] ?? ''));
    const href = cite === undefined ? undefined : sourceHref(cite);
    if (cite !== undefined && href !== undefined) {
      nodes.push(<CitationMark key={[context?.runId, cite.id, key++].join(':')} cite={cite} href={href} context={context} />);
    } else if (cite === undefined) {
      nodes.push(<span key={key++}>{match[0]}</span>);
    }
    last = at + match[0].length;
  }
  if (last < text.length) nodes.push(<span key={key++}>{text.slice(last)}</span>);
  return nodes;
}

function CitationMark({ cite, href, context }: { cite: Citation; href: string; context: CitationOpenContext | undefined }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const label = cite.id.slice(1);
  const title = cite.sourceType === 'document' ? cite.documentTitle : cite.recordTitle;
  return <span className="cite-wrap" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
    <Link className="cite-mark" to={href} aria-label={'来源 ' + label + '：' + title}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onClick={(event) => {
        if (context !== undefined) openCitation(event, cite, context);
        if (event.defaultPrevented) {
          setHovered(false);
          setFocused(false);
        }
      }}>
      {label}
    </Link>
    {(hovered || focused) && <span className="cite-pop" role="tooltip">
      <CitationPreview citation={cite} runId={context?.runId} compact />
    </span>}
  </span>;
}

/** Short previews use the same authorized reader response as the full evidence pane. */
function CitationPreview({ citation, runId, compact }: {
  citation: Citation;
  runId: string | undefined;
  compact: boolean;
}) {
  const source = useMemo(() => runId === undefined ? undefined : answerEvidenceSources(runId, [citation])[0], [citation, runId]);
  const [loaded, setLoaded] = useState<{ source: (typeof source); evidence: LoadedEvidence } | null>(null);
  const canLoad = source !== undefined && supportsEvidence(source.request);
  useEffect(() => {
    if (!canLoad || source === undefined) return;
    const controller = new AbortController();
    void loadEvidence(source, controller.signal).then((evidence) => {
      if (!controller.signal.aborted) setLoaded({ source, evidence });
    });
    return () => controller.abort();
  }, [canLoad, source]);

  if (!canLoad) return <span className="cite-pop-text">请通过原入口查看此引用。</span>;
  if (loaded === null || loaded.source !== source) return <span className="cite-pop-text">正在核对来源…</span>;
  const { evidence } = loaded;
  if (evidence.kind === 'unavailable') return <span className="cite-pop-text">此证据不可读取。</span>;

  const size = compact ? 140 : 240;
  if (evidence.kind === 'record') {
    const { hit, version } = evidence;
    return <>
      <span className="cite-pop-title">{hit.recordTitle}</span>
      <span className="cite-pop-meta">{RECORD_TYPE_LABELS[hit.recordType]} · 最近读取 {fmtDateTime(hit.queryTime)}</span>
      <span className="cite-pop-text">
        {(compact ? hit.fields.slice(0, 3) : hit.fields).map((field) => field.label + '：' + field.value).join('；')}
      </span>
      {hit.recordType === 'M-JOURNAL'
        ? <span className="cite-pop-foot">该期现有记录，旧字段修订未保留。</span>
        : version !== 'matched' && <span className="cite-pop-foot">当前登记与引用版本未能匹配。</span>}
    </>;
  }

  const { chunk, document } = evidence.context;
  const text = evidence.highlight === null ? chunk.text : chunk.text.slice(...evidence.highlight);
  const page = chunk.page === null ? '无页码' : '第 ' + chunk.page + ' 页';
  return <>
    <span className="cite-pop-title">{document.title}</span>
    <span className="cite-pop-meta">{MATERIAL_LABELS[document.material]} · {page}
      {chunk.sectionPath.length > 0 && ' · ' + formatSectionPath(chunk.sectionPath)}</span>
    <span className="cite-pop-text">{text.length > size ? text.slice(0, size) + '…' : text}</span>
    {evidence.highlight === null && <span className="cite-pop-foot">当前授权片段，未能精确定位摘录。</span>}
  </>;
}

function CitationCard({ citation, citationOpen }: { citation: Citation; citationOpen: CitationOpenContext | undefined }) {
  const href = sourceHref(citation);
  return <div className="card hit">
    <p className="hit-head">
      <span className="pill">{citation.id.slice(1)}</span>
      {href !== undefined && <Link className="side-link" to={href} onClick={(event) => {
        if (citationOpen !== undefined) openCitation(event, citation, citationOpen);
      }}>{citation.sourceType === 'document' ? '查看原文' : '查看记录'}</Link>}
    </p>
    <div className="cite-preview">
      <CitationPreview citation={citation} runId={citationOpen?.runId} compact={false} />
    </div>
  </div>;
}
