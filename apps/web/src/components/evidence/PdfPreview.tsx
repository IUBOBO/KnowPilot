import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import './pdf-preview.css';

export interface PdfView {
  page: number | null;
  zoom: number;
}

type PdfModule = typeof import('./pdf-document.ts');
type Ready = { pdf: PDFDocumentProxy; labels: string[] | null; module: PdfModule };
type PageResult = Awaited<ReturnType<PdfModule['renderPdfPage']>>;

function PdfPage({ ready, page, width, zoom, quote }: {
  ready: Ready;
  page: number;
  width: number;
  zoom: number;
  quote: string | null;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [result, setResult] = useState<PageResult | 'error' | null>(null);
  useEffect(() => {
    const surface = canvas.current;
    const container = stage.current;
    if (surface === null || container === null) return;
    const controller = new AbortController();
    void ready.module.renderPdfPage({
      pdf: ready.pdf, page, width, zoom, quote, canvas: surface, stage: container, signal: controller.signal,
    }).then((value) => {
      if (!controller.signal.aborted) setResult(value);
    }, () => {
      if (!controller.signal.aborted) setResult('error');
    });
    return () => {
      controller.abort();
      surface.width = 0;
      surface.height = 0;
    };
  }, [ready, page, width, zoom, quote]);

  return <>
    {result === null && <p role="status">正在绘制 PDF 第 {page} 页…</p>}
    {result === 'error' && <p role="status">无法绘制此页，可核对原文片段或下载原件。</p>}
    {result !== 'error' && result?.message && <p role="status" className="pdf-preview-label dim">{result.message}</p>}
    <div ref={stage} className="pdf-preview-page" aria-hidden={result === null || result === 'error'} hidden={result === 'error'} style={result === null ? { visibility: 'hidden' } : undefined}>
      <canvas ref={canvas} role="img" aria-label={`PDF 第 ${page} 页`} />
      {result !== 'error' && result?.rects.map((rect, index) => <span key={index}
        aria-hidden="true" data-pdf-highlight="" style={rect} />)}
    </div>
  </>;
}

export function PdfPreview({ fileUrl, citedPage, quote, view, onViewChange }: {
  fileUrl: string;
  citedPage: number | null;
  quote: string | null;
  view: PdfView;
  onViewChange: (view: PdfView) => void;
}) {
  const [loaded, setLoaded] = useState<Ready | string | null>(null);
  const [width, setWidth] = useState(0);
  const [editedPage, setEditedPage] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void import('./pdf-document.ts').then(async (module) => {
      if (signal.aborted) return;
      try {
        const pdf = await module.openPdf(fileUrl, signal);
        const labels = await pdf.getPageLabels().catch(() => null);
        if (!signal.aborted) setLoaded({ module, pdf, labels });
      } catch (error) {
        if (!signal.aborted) setLoaded(module.pdfPreviewErrorMessage(error));
      }
    }, () => {
      if (!signal.aborted) setLoaded('PDF 阅读器未能加载，可核对原文片段或下载原件。');
    });
    return () => controller.abort();
  }, [fileUrl]);
  useEffect(() => {
    const element = scroll.current;
    if (element === null || loaded === null || typeof loaded === 'string') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [loaded]);

  if (loaded === null) return <p role="status">正在读取 PDF 原件…</p>;
  if (typeof loaded === 'string') return <p role="status" className="evidence-reader-note">{loaded}</p>;

  const { pdf, module, labels } = loaded;
  const target = module.citationPage(citedPage, pdf.numPages);
  const page = module.citationPage(view.page, pdf.numPages) ?? target ?? 1;
  const label = labels?.[page - 1];
  const selectPage = (selected: number) => {
    setEditedPage(null);
    onViewChange({ ...view, page: selected });
    scroll.current?.scrollTo(0, 0);
  };
  return <section aria-label="PDF 原件预览">
    <div className="pdf-preview-controls">
      <button className="link-btn" type="button" aria-disabled={page <= 1} onClick={() => {
        if (page > 1) selectPage(page - 1);
      }}>上一页</button>
      <button className="link-btn" type="button" aria-disabled={page >= pdf.numPages} onClick={() => {
        if (page < pdf.numPages) selectPage(page + 1);
      }}>下一页</button>
      <form onSubmit={(event) => {
        event.preventDefault();
        const value = Number(new FormData(event.currentTarget).get('page'));
        if (module.citationPage(value, pdf.numPages) !== null) selectPage(value);
      }}>
        <input name="page" type="number" required aria-label="跳转到 PDF 物理页"
          value={editedPage ?? page} min={1} max={pdf.numPages} onChange={(event) => setEditedPage(event.currentTarget.value)} />
        <button type="submit" className="link-btn">跳转</button>
      </form>
      <div className="pdf-preview-zoom">
        <button type="button" className="link-btn" aria-disabled={view.zoom <= 50} onClick={() => {
          if (view.zoom > 50) onViewChange({ ...view, zoom: view.zoom - 25 });
        }}>缩小</button>
        <span aria-label="PDF 缩放比例">{view.zoom}%</span>
        <button type="button" className="link-btn" aria-disabled={view.zoom >= 300} onClick={() => {
          if (view.zoom < 300) onViewChange({ ...view, zoom: view.zoom + 25 });
        }}>放大</button>
      </div>
    </div>
    <p className="pdf-preview-label dim" role="status">
      PDF 物理页 {page} / {pdf.numPages}
      {label && label !== String(page) && ` · 印刷页标签 ${label.slice(0, 80)}`}
    </p>
    {target === null && <p className="evidence-reader-note" role="status">
      {citedPage === null ? '此引用缺少 PDF 物理页码，可手动翻页并核对原文片段。'
        : `引用的 PDF 物理页 ${citedPage} 超出当前原件页数，已保留原文片段。`}
    </p>}
    {target !== null && page === target && quote === null &&
      <p className="pdf-preview-label dim" role="status">当前摘录无法校验，已定位到引用页并保留原文片段。</p>}
    <div className="pdf-preview-scroll" ref={scroll} tabIndex={0} aria-label="PDF 页面滚动区">
      {width > 0 && <PdfPage key={`${page}:${width}:${view.zoom}`} ready={loaded} page={page} width={width}
        zoom={view.zoom} quote={page === target ? quote : null} />}
    </div>
  </section>;
}
