import { AnnotationMode, getDocument, GlobalWorkerOptions, OPS, PasswordResponses, TextLayer, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { matchPdfText } from './pdf-text-match.ts';

const maxPreviewBytes = 64 * 1024 * 1024;

class PdfPreviewError extends Error {}

async function fetchPdf(fileUrl: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(fileUrl, {
    signal,
    cache: 'no-store',
    credentials: 'same-origin',
    mode: 'same-origin',
    redirect: 'error',
  });
  if (!response.ok || response.body === null) {
    throw new PdfPreviewError('PDF 原件不可读取，可能已失效或当前账号无权查看。');
  }
  const tooLarge = () => new PdfPreviewError('PDF 超过 64 MiB，已保留片段预览，可下载原件阅读。');
  if (Number(response.headers.get('Content-Length')) > maxPreviewBytes) {
    void response.body.cancel().catch(() => {});
    throw tooLarge();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxPreviewBytes) {
        void reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function openPdf(fileUrl: string, signal: AbortSignal) {
  let task: PDFDocumentLoadingTask | undefined;
  function dispose() {
    const active = task;
    task = undefined;
    if (active !== undefined) void active.destroy().catch(() => {});
  }
  signal.addEventListener('abort', dispose, { once: true });
  try {
    const data = await fetchPdf(fileUrl, signal);
    signal.throwIfAborted();
    GlobalWorkerOptions.workerSrc = workerUrl;
    const active = getDocument({
      data,
      isEvalSupported: false,
      enableXfa: false,
      canvasMaxAreaInBytes: maxPreviewBytes,
    });
    task = active;
    const document = await new Promise<Awaited<typeof active.promise>>((resolve, reject) => {
      active.onPassword = (_update: (password: string) => void, reason: number) => reject(new PdfPreviewError(
        reason === PasswordResponses.NEED_PASSWORD ? 'PDF 需要密码，可下载原件后阅读。' : 'PDF 无法解锁，可下载原件后阅读。',
      ));
      void active.promise.then(resolve, reject);
    });
    signal.throwIfAborted();
    return document;
  } catch (error) {
    dispose();
    throw error;
  }
}

export function pdfPreviewErrorMessage(error: unknown): string {
  return error instanceof PdfPreviewError ? error.message : 'PDF 预览加载失败，已保留授权原文片段与下载入口。';
}

export function citationPage(page: number | null, pageCount: number): number | null {
  return page !== null && Number.isSafeInteger(page) && page >= 1 && page <= pageCount ? page : null;
}

type HighlightRect = { left: number; top: number; width: number; height: number };
type PageResult = { rects: HighlightRect[]; message?: string };
type DisplayContentConfig = ReturnType<PDFDocumentProxy['getOptionalContentConfig']>;
const uncertain = '当前页无法可靠定位摘录。请核对原文片段；表格、公式或索引偏差可能影响匹配。';

async function locateOnPage(
  page: PDFPageProxy, viewport: ReturnType<PDFPageProxy['getViewport']>, stage: HTMLDivElement,
  quote: string, contentConfig: DisplayContentConfig, signal: AbortSignal,
): Promise<PageResult> {
  const content = await page.getTextContent({ disableNormalization: true });
  const items = content.items.filter((item) => 'str' in item);
  const match = matchPdfText(items, quote);
  switch (match.kind) {
    case 'no-text': return { rects: [], message: '此页没有可用文字层，扫描件或 OCR 摘录可在下方核对。' };
    case 'ambiguous': return { rects: [], message: '此页有多处相同摘录，已保留原文片段供核对。' };
    case 'unmatched': return { rects: [], message: uncertain };
  }
  const matchedItems = match.ranges.map(({ item }) => items[item]!);
  if (viewport.rotation !== 0 || matchedItems.some((item) => {
    const style = content.styles[item.fontName];
    return style === undefined || style.vertical === true;
  })) {
    return { rects: [], message: uncertain };
  }

  const operators = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
  const display = await contentConfig;
  const uncertainLayer = operators.fnArray.some((operator, index) => {
    if (operator !== OPS.beginMarkedContentProps && operator !== OPS.beginMarkedContent) return false;
    const [tag, group] = (operators.argsArray[index] ?? []) as [unknown?, unknown?];
    if (tag !== 'OC') return false;
    // The text stream also contains hidden layers. Unknown groups or compound policies lack a verified mapping.
    return typeof group !== 'object' || group === null || !('type' in group) || group.type !== 'OCG'
      || !('id' in group) || typeof group.id !== 'string'
      || display.getGroup(group.id) == null || display.isVisible(group) !== true;
  });
  if (uncertainLayer) return { rects: [], message: '此页含隐藏或无法核对的可选内容，已保留原文片段供核对。' };
  const invisibleText = operators.fnArray.some((operator, index) => {
    const args = operators.argsArray[index];
    // PDF text modes 3 and 7 draw no visible glyphs, including many searchable scans.
    return (operator === OPS.setTextRenderingMode && (args?.[0] === 3 || args?.[0] === 7))
      || (operator === OPS.setGState && args?.[0]?.some(([key, value]: [string, number]) =>
        (key === 'ca' || key === 'CA') && value === 0));
  });
  if (invisibleText) return { rects: [], message: '此页含不可见文字层，可能来自 OCR，请核对原文片段。' };
  signal.throwIfAborted();

  const container = document.createElement('div');
  container.className = 'pdf-text-measurement';
  container.setAttribute('aria-hidden', 'true');
  container.style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit));
  stage.append(container);
  const layer = new TextLayer({ textContentSource: { ...content, items: matchedItems }, container, viewport });
  const cancel = () => layer.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await layer.render();
    signal.throwIfAborted();
    const bounds = stage.getBoundingClientRect();
    const rects: HighlightRect[] = [];
    for (const [i, { start, end }] of match.ranges.entries()) {
      const text = layer.textDivs[i]?.firstChild;
      if (text == null) return { rects: [], message: uncertain };
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, end);
      const rect = range.getBoundingClientRect();
      const left = Math.max(0, rect.left - bounds.left);
      const top = Math.max(0, rect.top - bounds.top);
      const width = Math.min(bounds.width - left, rect.right - bounds.left - left);
      const height = Math.min(bounds.height - top, rect.bottom - bounds.top - top);
      if (width <= 0 || height <= 0 || ![left, top, width, height].every(Number.isFinite)) {
        return { rects: [], message: uncertain };
      }
      rects.push({ left, top, width, height });
    }
    return { rects, message: '已在本页定位摘录。' };
  } finally {
    signal.removeEventListener('abort', cancel);
    container.remove();
    TextLayer.cleanup();
  }
}

export async function renderPdfPage({ pdf, page: number, width, zoom, quote, canvas, stage, signal }: {
  pdf: PDFDocumentProxy;
  page: number;
  width: number;
  zoom: number;
  quote: string | null;
  canvas: HTMLCanvasElement;
  stage: HTMLDivElement;
  signal: AbortSignal;
}): Promise<PageResult> {
  const page = await pdf.getPage(number);
  try {
    signal.throwIfAborted();
    const natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / natural.width * zoom / 100 });
    const maxSide = 8_192;
    const maxArea = 8_000_000;
    const ratio = Math.min(devicePixelRatio || 1, 2, maxSide / viewport.width, maxSide / viewport.height,
      Math.sqrt(maxArea / viewport.width / viewport.height));
    if (!Number.isFinite(ratio) || ratio <= 0 || viewport.width < 1 || viewport.height < 1
      || viewport.width > maxSide || viewport.height > maxSide) throw new Error('Unsupported PDF viewport');

    canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const transform = [canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0];
    const contentConfig = pdf.getOptionalContentConfig({ intent: 'display' });
    const drawing = page.render({
      canvas, viewport, transform, annotationMode: AnnotationMode.DISABLE, optionalContentConfigPromise: contentConfig,
    });
    const cancel = () => drawing.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await drawing.promise;
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    if (quote === null) return { rects: [] };
    try {
      return await locateOnPage(page, viewport, stage, quote, contentConfig, signal);
    } catch {
      return { rects: [], message: uncertain };
    }
  } finally {
    page.cleanup();
  }
}
