import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { evidenceMarker, formatSectionPath, MATERIAL_LABELS, RECORD_TYPE_LABELS,
  type Citation, type DocumentCitation, type RecordCitation } from '@knowpilot/shared';
import { fmtDateTime, fmtQueryTime } from '../../format.ts';

const EXCERPT_PREVIEW = 240;
const CITE_POP_PREVIEW = 140;

export function AnswerSources({ citations }: { citations: readonly Citation[] }) {
  return (
    <>
      <p className="dim drawer-lead">点击文中的编号，可以直接查看对应的原文或记录。</p>
      {citations.map((citation) => <CitationCard key={citation.id} citation={citation} />)}
    </>
  );
}

function sourceHref(citation: Citation): string | undefined {
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

export function renderAnswerCitations(text: string, byId: ReadonlyMap<string, Citation>): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(evidenceMarker())) {
    const at = match.index ?? 0;
    if (at > last) nodes.push(<span key={key++}>{text.slice(last, at)}</span>);
    const cite = byId.get(`E${match[1] ?? ''}`);
    const href = cite === undefined ? undefined : sourceHref(cite);
    if (cite !== undefined && href !== undefined) {
      const title = cite.sourceType === 'document' ? cite.documentTitle : cite.recordTitle;
      nodes.push(
        <span className="cite-wrap" key={key++}>
          <Link className="cite-mark" to={href}
            aria-label={`来源 ${match[1]}：${title}`}>
            {match[1]}
          </Link>
          <CitationPopover citation={cite} />
        </span>,
      );
    } else if (cite === undefined) {
      nodes.push(<span key={key++}>{match[0]}</span>);
    }
    last = at + match[0].length;
  }
  if (last < text.length) nodes.push(<span key={key++}>{text.slice(last)}</span>);
  return nodes;
}

/**
 * 正文引用编号的悬浮卡（O9）。
 *
 * 【为什么文档引用和记录引用长得不一样】文档有"位置"（页码 + 章节）和可点开的
 * 原文页；记录引用指向的是库里此刻的一行，没有页码也没有原文页。硬套同一张卡
 * 会让记录引用出现"第 null 页"和死链 —— 与引用卡片那里分叉的理由相同。
 */
function CitationPopover({ citation }: { citation: Citation }) {
  if (citation.sourceType === 'record') {
    return (
      <span className="cite-pop" role="tooltip">
        <span className="cite-pop-title">{citation.recordTitle}</span>
        <span className="cite-pop-meta">
          {RECORD_TYPE_LABELS[citation.recordType]} · 查询于 {fmtQueryTime(citation.queryTime)}
        </span>
        <span className="cite-pop-text">
          {citation.fields.slice(0, 3).map((f) => `${f.label}：${f.value}`).join('；')}
        </span>
        <span className="cite-pop-foot">台账记录没有原文页，完整字段见「来源」。</span>
      </span>
    );
  }

  // 优先显示模型逐字摘录、且服务端核对过的那一段（O2）；没有才回落到整块摘录。
  const source = citation.quote ?? citation.excerpt;
  const truncated = source.length > CITE_POP_PREVIEW;
  const where = [
    citation.page === null ? '无页码' : `第 ${citation.page} 页`,
    citation.sectionPath.length > 0 ? formatSectionPath(citation.sectionPath) : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');

  return (
    <span className="cite-pop" role="tooltip">
      <span className="cite-pop-title">{citation.documentTitle}</span>
      <span className="cite-pop-meta">{where}</span>
      <span className="cite-pop-text">
        {truncated ? `${source.slice(0, CITE_POP_PREVIEW)}…` : source}
      </span>
      <span className="cite-pop-foot">点击编号查看原文</span>
    </span>
  );
}

function CitationCard({ citation }: { citation: Citation }) {
  if (citation.sourceType === 'record') return <RecordCitationCard citation={citation} />;
  return <DocumentCitationCard citation={citation} />;
}

function DocumentCitationCard({ citation }: { citation: DocumentCitation }) {
  const excerpt = citation.quote ?? citation.excerpt;
  const truncated = excerpt.length > EXCERPT_PREVIEW;
  return (
    <div className="card hit">
      <p className="hit-head">
        <span className="pill">{citation.id.slice(1)}</span>
        <span className="hit-title">{citation.documentTitle}</span>
        <span className="pill">{MATERIAL_LABELS[citation.material]}</span>
        {citation.page !== null && <span className="pill">第 {citation.page} 页</span>}
        <Link
          className="side-link"
          to={sourceHref(citation) ?? '/ask'}
        >
          查看原文
        </Link>
      </p>

      {citation.sectionPath.length > 0 && (
        <p className="hit-path">{formatSectionPath(citation.sectionPath)}</p>
      )}

      <p className="hit-snippet">
        {truncated ? `${excerpt.slice(0, EXCERPT_PREVIEW)}…` : excerpt}
      </p>
    </div>
  );
}

/**
 * 台账 / 数据集的引用卡片。
 *
 * 逐行列出服务端从库里取的结论字段（状态、路径、核对结果…）。
 * 底部**必须**标出查询时点：这张卡片说的是"查的那一刻"的事，
 * 不写时点，用户无法判断它有多新 —— 而"新不新"正是这类引用的全部价值。
 */
function RecordCitationCard({ citation }: { citation: RecordCitation }) {
  const href = sourceHref(citation);
  return (
    <div className="card hit">
      <p className="hit-head">
        <span className="pill">{citation.id.slice(1)}</span>
        <span className="hit-title">{citation.recordTitle}</span>
        <span className="pill">{RECORD_TYPE_LABELS[citation.recordType]}</span>

        {href !== undefined && (
          <Link
            className="side-link"
            to={href}
          >
            查看记录
          </Link>
        )}
      </p>

      {citation.fields.map((f) => (
        <p className="hit-path" key={f.label}>
          <span className="dim">{f.label}：</span>
          {f.value}
        </p>
      ))}

      {/* 「这是查询那一刻台账里的内容，不是文档摘录」那句删掉了（「界面整理-new」§三）：
          卡片上方已经写着「台账」这个来源类型与查询时点，再补一句是在替用户做阅读理解。 */}
      <p className="dim" style={{ fontSize: '0.71875rem', margin: '6px 0 0' }}>
        查询时点 {fmtQueryTime(citation.queryTime)}
        {citation.recordUpdatedAt !== null && ` · 该记录最近更新 ${fmtDateTime(citation.recordUpdatedAt)}`}
      </p>
    </div>
  );
}
