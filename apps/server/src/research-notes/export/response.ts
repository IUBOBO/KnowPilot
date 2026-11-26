import { AppError, type AuthUser } from '@knowpilot/shared';
import type { Db } from '../../db/index.ts';
import { renderNotePdf } from './pdf.ts';
import { collectNoteExport, renderNoteMarkdown } from './snapshot.ts';

function noteFilename(title: string, extension: 'md' | 'pdf') {
  const name = Buffer.from(title).toString('utf8').normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\\/:"*?<>|]/gu, '_')
    .trim().replace(/^[.\s]+|[.\s]+$/gu, '');
  const shortened = Array.from(name).slice(0, 60).join('').replace(/[.\s]+$/u, '');
  const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
  return (!shortened || reserved.test(shortened) ? '研究笔记' : shortened) + '.' + extension;
}

export function researchNoteExportResponse(
  db: Db,
  owner: AuthUser,
  noteId: string,
  format: string,
  contentDisposition: (filename: string) => string,
): Response {
  if (format !== 'md' && format !== 'pdf') throw new AppError('invalid_argument', '请选择 Markdown 或 PDF 格式。');
  const note = collectNoteExport(db, owner, noteId);
  const body = format === 'md' ? renderNoteMarkdown(note) : new Uint8Array(renderNotePdf(note));
  return new Response(body, { headers: {
    'Content-Type': format === 'md' ? 'text/markdown; charset=utf-8' : 'application/pdf',
    'Content-Disposition': contentDisposition(noteFilename(note.title, format)),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(note.restricted ? { 'X-KnowPilot-Export-Restricted': 'true' } : {}),
  } });
}
