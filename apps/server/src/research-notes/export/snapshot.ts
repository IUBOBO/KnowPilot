import type { AuthUser } from '@knowpilot/shared';
import type { Db } from '../../db/index.ts';
import { getChunkContext } from '../../documents/repo.ts';
import { readResearchNote } from '../repo.ts';
import { presentResearchNote } from '../service.ts';
import { sanitizeNoteMarkdown } from './markdown.ts';

export function collectNoteExport(db: Db, owner: AuthUser, noteId: string) {
  db.exec('BEGIN');
  try {
    const note = presentResearchNote(db, owner, readResearchNote(db, owner.id, noteId));
    // Editable note text has no stable source spans. If a source was revoked or
    // changed, withholding all free text is safer than trying to redact quotes.
    const readCitationCount = db.prepare('SELECT citation_count FROM ask_records WHERE run_id = ? AND user_id = ?');
    const runs = note.runs.map((run) => {
      const record = readCitationCount.get(run.runId, owner.id) as { citation_count: number } | undefined;
      return { run, expected: record?.citation_count };
    });
    const restricted = runs.some(({ run, expected }) => expected === undefined || expected > run.sources.length ||
      run.sources.some((source) => source.status !== 'available'));
    const sources = runs.flatMap(({ run, expected }, index) => {
      const round = '第 ' + String(index + 1) + ' 轮';
      if (expected === undefined) return [round + '：问答记录已失效或无权访问'];
      const missing = expected > run.sources.length ? [round + '：部分引用记录缺失，无法核验'] : [];
      if (run.sources.length === 0) return missing.length > 0 ? missing : [round + '：本轮未保留可核验来源'];
      return [...missing, ...run.sources.map((source) => {
        const label = round + ' · ' + source.citationId + '：';
        if (source.status !== 'available') {
          return label + (source.status === 'changed' ? '引用版本已变更' : '来源不可用或无权访问');
        }
        // A restricted export is status-only even when some other links still work.
        if (restricted) return label + '来源仍可在原笔记核对';
        const { locator } = source;
        const context = locator.kind === 'document' ? getChunkContext(db, locator.chunkId) : null;
        const chapter = context?.chunk.sectionPath?.join(' / ');
        const page = context?.chunk.page;
        const position = [
          page == null ? '' : '第 ' + String(page) + ' 页',
          chapter ? '章节 ' + chapter : '',
          '版本 ' + locator.sourceVersion,
        ].filter(Boolean).join(' · ');
        return label + source.title + '（' + position + '）';
      })];
    });
    db.exec('COMMIT');
    return {
      title: restricted ? '研究笔记来源核对' : note.title,
      body: restricted ? '' : note.body,
      tags: restricted ? [] : note.tags,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      revision: note.revision,
      sources,
      restricted,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export type NoteExport = ReturnType<typeof collectNoteExport>;

export const RESTRICTED_EXPORT_NOTICE = '部分来源已失效、变更、缺失或无权访问。此文件仅记录来源状态。';
export const SOURCE_ACCESS_NOTICE = '引用编号对应原笔记中的问答轮次。原资料需在 KnowPilot 中登录并通过当前权限校验。';

export function noteMetadata(note: NoteExport) {
  return [
    '创建：' + note.createdAt,
    '更新：' + note.updatedAt,
    '修订：' + String(note.revision),
    ...(note.tags.length === 0 ? [] : ['标签：' + note.tags.join('、')]),
  ];
}

function markdownText(value: string) {
  return value.replace(/[\r\n\u2028\u2029]+/gu, ' ').replace(/[\\#*_\x60~|<>\[\]!]/gu, '\\$&');
}

export function renderNoteMarkdown(note: NoteExport): string {
  return [
    '# ' + markdownText(note.title),
    ...(note.restricted ? [RESTRICTED_EXPORT_NOTICE] : noteMetadata(note).map(markdownText)),
    '## 来源与访问条件',
    SOURCE_ACCESS_NOTICE,
    note.sources.length === 0 ? '本笔记未关联可核验的来源。' :
      note.sources.map((source) => '- ' + markdownText(source)).join('\n'),
    ...(note.restricted ? [] : ['## 笔记正文', sanitizeNoteMarkdown(note.body, markdownText)]),
  ].join('\n\n') + '\n';
}
