import { useEffect, useId, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode, type RefObject } from 'react';
import {
  MATERIAL_LABELS, RECORD_TYPE_LABELS, formatSectionPath,
  type EvidenceOpenRequest, type OpenEvidence,
} from '@knowpilot/shared';
import { Link } from 'react-router-dom';
import { fmtDateTime } from '../../format.ts';
import { Modal } from '../Modal.tsx';
import { loadEvidence, resolveEvidenceSource, supportsEvidence, type EvidenceReaderSources, type LoadedEvidence } from './evidence-reader.ts';
import './evidence-viewer.css';

const dockWidth = '(min-width: 1080px)';
const readerTitle = '证据阅读器';
function subscribeWidth(change: () => void) {
  const media = window.matchMedia(dockWidth);
  media.addEventListener('change', change);
  return () => media.removeEventListener('change', change);
}
function dockAvailable() {
  return window.matchMedia(dockWidth).matches;
}

export function openEvidenceLink(event: MouseEvent<HTMLAnchorElement>, open: () => boolean) {
  if (event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
      !event.defaultPrevented && open()) event.preventDefault();
}

interface Selection {
  request: EvidenceOpenRequest;
  scope: string;
  serial: number;
}

/** The caller changes scope when a different answer or search result set becomes active. */
export function useEvidenceViewer(sources: EvidenceReaderSources, scope: string) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const serial = useRef(0);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => setSelection(null), [scope]);
  const active = selection?.scope === scope ? resolveEvidenceSource(sources, selection.request) : undefined;
  function openFrom(request: EvidenceOpenRequest, sourceControl = document.activeElement) {
    const source = resolveEvidenceSource(sources, request);
    if (source === undefined) return false;
    trigger.current = sourceControl instanceof HTMLElement ? sourceControl : null;
    setSelection({ request: source.request, scope, serial: ++serial.current });
    return true;
  }
  const onOpenEvidence: OpenEvidence = (request) => openFrom(request);
  return {
    onOpenEvidence,
    openFrom,
    reader: active === undefined || selection === null ? null : {
      key: selection.serial,
      source: active,
      sources,
      trigger,
      onSelect: (index: number) => {
        const next = sources[index];
        if (next !== undefined && resolveEvidenceSource(sources, next.request) !== undefined) {
          setSelection({ request: next.request, scope, serial: ++serial.current });
        }
      },
      onClose: () => {
        setSelection(null);
        trigger.current?.focus({ preventScroll: true });
      },
    },
  };
}

type Reader = NonNullable<ReturnType<typeof useEvidenceViewer>['reader']>;

function VersionNote({ version }: { version: 'matched' | 'changed' | 'unknown' }) {
  if (version === 'matched') return null;
  return <p className="evidence-reader-note" role="status">
    {version === 'changed' ? '来源版本已变化，以下为当前可读取内容。' : '无法核对来源版本，以下为当前可读取内容。'}
  </p>;
}

function EvidenceContent({ evidence, recordHref }: { evidence: LoadedEvidence; recordHref: string | undefined }) {
  if (evidence.kind === 'unavailable') return <p role="status">此证据不可读取，可能已失效或当前账号无权查看。</p>;
  if (evidence.kind === 'record') {
    const { hit, version } = evidence;
    return <>
      <h3>{hit.recordTitle}</h3>
      <p className="dim">{RECORD_TYPE_LABELS[hit.recordType]} · 最近读取 {fmtDateTime(hit.queryTime)}</p>
      {hit.recordType === 'M-JOURNAL'
        ? <p className="evidence-reader-note" role="status">显示该期现有分区记录。所引期间可核对，旧字段修订未保留。</p>
        : <VersionNote version={version} />}
      {hit.recordType === 'M-CODE' && <p className="dim">显示数据集登记信息。文件核对结果以数据集页面为准。</p>}
      <dl className="evidence-reader-fields">
        {hit.fields.map((field, i) => <div key={i}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
      </dl>
      {recordHref !== undefined && <Link className="link-btn" to={recordHref}>查看完整记录</Link>}
    </>;
  }
  const { context, highlight, version } = evidence;
  const { document: source, chunk, siblings } = context;
  const excerpt = highlight === null ? chunk.text : <>
    {chunk.text.slice(0, highlight[0])}<mark>{chunk.text.slice(...highlight)}</mark>{chunk.text.slice(highlight[1])}
  </>;
  return <>
    <h3>{source.title}</h3>
    <p className="dim">{MATERIAL_LABELS[source.material]} · {chunk.page === null ? '无页码' : `第 ${chunk.page} 页`}
      {chunk.sectionPath.length > 0 && ` · ${formatSectionPath(chunk.sectionPath)}`}</p>
    {context.archivedIndexVersion !== undefined &&
      <p className="evidence-reader-note" role="status">索引 v{context.archivedIndexVersion} 的历史原文。仅显示当时保留的引用片段。</p>}
    <VersionNote version={version} />
    {highlight === null && <p className="dim">未能精确定位摘录，已显示授权原文片段。</p>}
    <p className="evidence-reader-excerpt">{excerpt}</p>
    {context.archivedIndexVersion === undefined && siblings.length > 1 && <details>
      <summary>同页上下文</summary>
      {siblings.map((item) => <p className="evidence-reader-excerpt" key={item.id}>{item.text}</p>)}
    </details>}
    <a href={`/api/v1/documents/${encodeURIComponent(source.id)}/file`} className="link-btn">
      {context.archivedIndexVersion === undefined ? '下载原件' : '下载当前原件'}
    </a>
  </>;
}

type RenderDocument = (evidence: Extract<LoadedEvidence, { kind: 'document' }>) => ReactNode;

function EvidencePane({ source, renderDocument }: { source: Reader['source']; renderDocument?: RenderDocument }) {
  const [loaded, setLoaded] = useState<{ source: Reader['source']; evidence: LoadedEvidence } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void loadEvidence(source, controller.signal).then((result) => {
      if (!controller.signal.aborted) setLoaded({ source, evidence: result });
    });
    return () => controller.abort();
  }, [source]);
  return loaded?.source === source
    ? ((loaded.evidence.kind === 'document' ? renderDocument?.(loaded.evidence) : null) ??
      <EvidenceContent evidence={loaded.evidence} recordHref={source.recordHref} />)
    : <p role="status">正在读取证据…</p>;
}

function DesktopReader({
  titleId, close, onClose, children,
}: {
  titleId: string;
  close: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => { close.current?.focus({ preventScroll: true }); }, [close]);
  return <aside className="evidence-reader-dock card" aria-labelledby={titleId} onKeyDown={(event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      onClose();
    }
  }}>
    <header className="evidence-reader-header">
      <h2 id={titleId}>{readerTitle}</h2>
      <button type="button" className="link-btn" ref={close} onClick={onClose}>关闭阅读器</button>
    </header>
    {children}
  </aside>;
}

export function EvidenceViewer({ reader, children, renderDocument }: {
  reader: Reader | null;
  children: ReactNode;
  renderDocument?: RenderDocument;
}) {
  const docked = useSyncExternalStore(subscribeWidth, dockAvailable);
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const dialog = reader !== null && (!docked || expanded);

  function close() {
    setExpanded(false);
    reader?.onClose();
  }

  const related = reader?.sources.map((source, index) => ({ source, index }))
    .filter(({ source }) => supportsEvidence(source.request)) ?? [];
  const active = related.findIndex(({ source }) => source === reader?.source);
  const previous = related[active - 1];
  const next = related[active + 1];

  const content = reader === null ? null : <div className={expanded && docked ? 'evidence-reader-body evidence-reader-expanded' : 'evidence-reader-body'}>
    <nav className="evidence-reader-controls" aria-label="证据切换">
      <button type="button" className="link-btn" aria-disabled={previous === undefined} onClick={() => {
        if (previous !== undefined) reader.onSelect(previous.index);
      }}>上一条</button>
      <span aria-live="polite">{active + 1} / {related.length}</span>
      <button type="button" className="link-btn" aria-disabled={next === undefined} onClick={() => {
        if (next !== undefined) reader.onSelect(next.index);
      }}>下一条</button>
      {docked && <button type="button" className="link-btn" onClick={() => setExpanded(!expanded)}>
        {expanded ? '返回侧栏' : '全屏阅读'}
      </button>}
    </nav>
    {related.length > 1 && <label className="evidence-reader-selector">来源列表
      <select value={active} onChange={(event) => {
        const option = related[Number(event.currentTarget.value)];
        if (option !== undefined) reader.onSelect(option.index);
      }}>
        {related.map(({ index }, position) => <option key={index} value={position}>第 {position + 1} 条</option>)}
      </select>
    </label>}
    <EvidencePane key={reader.key} source={reader.source} {...(renderDocument === undefined ? {} : { renderDocument })} />
  </div>;

  return <div className={reader !== null && docked ? 'evidence-reader-workspace has-evidence-reader' : 'evidence-reader-workspace'}>
    <div className="evidence-reader-host">{children}</div>
    {reader !== null && docked && !dialog && <DesktopReader titleId={titleId} close={closeButton} onClose={close}>
      {content}
    </DesktopReader>}
    {reader !== null && dialog && <Modal open title={readerTitle} variant={docked ? 'dialog' : 'drawer'}
      returnFocusTo={reader.trigger} initialFocusTo={closeButton} onClose={close}
      footer={<button type="button" ref={closeButton} onClick={close}>关闭阅读器</button>}>
      {content}
    </Modal>}
  </div>;
}
