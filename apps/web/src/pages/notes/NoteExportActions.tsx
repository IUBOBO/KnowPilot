import { useEffect, useRef, useState } from 'react';
import { ApiError, isApiErrorBody, toApiError } from '../../api.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';

type ExportFormat = 'md' | 'pdf';

function filenameFrom(response: Response, format: ExportFormat): string {
  const match = /(?:^|;\s*)filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('Content-Disposition') ?? '');
  try {
    return match === null ? '研究笔记.' + format : decodeURIComponent(match[1]!);
  } catch {
    return '研究笔记.' + format;
  }
}

export function NoteExportActions({ noteId, disabled }: { noteId: string; disabled: boolean }) {
  const active = useRef<AbortController | null>(null);
  const [format, setFormat] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => () => active.current?.abort(), []);

  async function download(kind: ExportFormat) {
    if (active.current !== null) return;
    const request = new AbortController();
    active.current = request;
    setFormat(kind);
    setError(null);
    setNotice('');
    try {
      const response = await fetch('/api/v1/research-notes/' + encodeURIComponent(noteId) + '/export/' + kind, {
        credentials: 'include', cache: 'no-store', signal: request.signal,
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        if (isApiErrorBody(payload)) throw new ApiError(payload);
        throw new Error('笔记导出失败，请稍后再试。');
      }
      const expected = kind === 'md' ? 'text/markdown' : 'application/pdf';
      if (response.headers.get('Content-Type')?.split(';')[0] !== expected) {
        throw new Error('服务返回的文件格式不匹配，请重试。');
      }
      const blob = await response.blob();
      if (request.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filenameFrom(response, kind);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setNotice(response.headers.get('X-KnowPilot-Export-Restricted') === 'true'
        ? '部分来源已失效、变更、缺失或无权访问，文件仅包含来源状态。'
        : '已下载当前保存的笔记。');
    } catch (err) {
      if (!request.signal.aborted) setError(toApiError(err));
    } finally {
      active.current = null;
      if (!request.signal.aborted) setFormat(null);
    }
  }

  return <>
    <div className="note-buttons" role="group" aria-label="导出已保存的笔记">
      <button type="button" disabled={disabled || format !== null} onClick={() => void download('md')}>下载 Markdown</button>
      <button type="button" disabled={disabled || format !== null} onClick={() => void download('pdf')}>下载 PDF</button>
    </div>
    {format !== null && <p role="status">正在生成导出文件…</p>}
    {notice !== '' && <p role="status">{notice}</p>}
    {error !== null && <ErrorNotice error={error} />}
  </>;
}
