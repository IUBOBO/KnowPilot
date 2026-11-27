import { createHash } from 'node:crypto';
import {
  AppError, KNOWLEDGE_MAX_INPUT_CHARS, KNOWLEDGE_MIN_INPUT_CHARS, hasPermission,
  type AuthUser, type KnowledgeDraftOrigin, type KnowledgeDraftSource, type KnowledgeNoteSelection,
} from '@knowpilot/shared';
import { findUserById, toAuthUser } from '../auth/users.ts';
import type { Db } from '../db/index.ts';
import { readAskNoteSources, readResearchNote } from '../research-notes/repo.ts';
import { presentNoteSource, presentResearchNote } from '../research-notes/service.ts';

export function draftFingerprint(...parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function readDraftText(raw: unknown): string {
  if (typeof raw !== 'string' || raw.includes('\u0000')) throw new AppError('invalid_argument', '请提交文本内容。');
  const text = raw.trim();
  if (text.length < KNOWLEDGE_MIN_INPUT_CHARS) {
    throw new AppError('invalid_argument', `内容太短，至少需要 ${KNOWLEDGE_MIN_INPUT_CHARS} 个字。`);
  }
  if (text.length > KNOWLEDGE_MAX_INPUT_CHARS) {
    throw new AppError('invalid_argument', `内容太长，上限 ${KNOWLEDGE_MAX_INPUT_CHARS} 字，请缩小选段。`);
  }
  return text;
}

function invalidSource(): never {
  throw new AppError('invalid_argument', '没有可用的草稿来源。');
}

function unavailable(): never {
  throw new AppError('not_found', '找不到可用来源，或当前账号无权访问。');
}

function changed(): never {
  throw new AppError('invalid_argument', '来源已有变化。请重新读取后再生成草稿。', { httpStatus: 409 });
}

function sourceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w.-]{1,160}$/u.test(value)) return invalidSource();
  return value;
}

function parseSelection(raw: unknown): KnowledgeNoteSelection | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return invalidSource();
  const { start, end } = raw as Record<string, unknown>;
  if (typeof start !== 'number' || typeof end !== 'number' ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    return invalidSource();
  }
  return { start, end };
}

export function parseDraftSource(raw: unknown, legacyText: unknown): KnowledgeDraftSource {
  if (raw === undefined) return { kind: 'manual', text: readDraftText(legacyText) };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return invalidSource();
  const source = raw as Record<string, unknown>;
  switch (source.kind) {
    case 'manual':
      return { kind: 'manual', text: readDraftText(source.text) };
    case 'ask':
      return { kind: 'ask', id: sourceId(source.id), excerpt: readDraftText(source.excerpt) };
    case 'note': {
      if (typeof source.revision !== 'number' || !Number.isSafeInteger(source.revision) || source.revision < 1) {
        return invalidSource();
      }
      const selection = parseSelection(source.selection);
      return { kind: 'note', id: sourceId(source.id), revision: source.revision,
        ...(selection === undefined ? {} : { selection }) };
    }
    case 'document':
      return { kind: 'document', id: sourceId(source.id), chunkId: sourceId(source.chunkId),
        version: sourceId(source.version) };
    default:
      return invalidSource();
  }
}

function readAsk(db: Db, user: AuthUser, id: string, excerpt: string) {
  const record = db.prepare(
    'SELECT asked_at, answer_preview, citation_count FROM ask_records WHERE run_id=? AND user_id=? AND consent_confirmed=1',
  ).get(id, user.id) as { asked_at: string; answer_preview: string | null; citation_count: number } | undefined;
  if (record === undefined || !hasPermission(user.role, 'chat.use')) return unavailable();
  const sources = readAskNoteSources(db, user.id, id);
  if (sources.length < record.citation_count ||
      sources.some((source) => presentNoteSource(db, user, source).status !== 'available')) return unavailable();
  // Historical runs retain a short preview, so the remaining selection is attributed to its submitter.
  const excerptVerification = record.answer_preview?.includes(excerpt) === true ? 'matched' : 'submitted';
  return { version: record.asked_at, excerptVerification } as const;
}

function readNote(db: Db, user: AuthUser, id: string, revision: number, selection?: KnowledgeNoteSelection) {
  const note = readResearchNote(db, user.id, id);
  if (note.revision !== revision) return changed();
  const runs = presentResearchNote(db, user, note).runs;
  const citationCount = db.prepare('SELECT citation_count FROM ask_records WHERE run_id=? AND user_id=?');
  for (const run of runs) {
    const record = citationCount.get(run.runId, user.id) as { citation_count: number } | undefined;
    if (record === undefined || run.question === undefined || record.citation_count > run.sources.length ||
        run.sources.some((source) => source.status !== 'available')) return unavailable();
  }
  const body = note.body.replace(/\r\n?/gu, '\n');
  if (selection === undefined) return { version: String(note.revision), excerpt: readDraftText(body) };
  const { start, end } = selection;
  // A boundary before a low surrogate would split a complete UTF-16 character.
  const splitsCharacter = (index: number) => /^[\uDC00-\uDFFF]$/u.test(body.charAt(index));
  if (end > body.length || splitsCharacter(start) || splitsCharacter(end)) return invalidSource();
  return { version: String(note.revision), excerpt: readDraftText(body.slice(start, end)) };
}

function readDocument(db: Db, user: AuthUser, id: string, chunkId: string) {
  if (!hasPermission(user.role, 'knowledge.read')) return unavailable();
  const row = db.prepare(
    `SELECT d.content_hash, d.index_version, c.text
       FROM documents d JOIN doc_chunks c ON c.doc_id=d.id
      WHERE d.id=? AND c.id=? AND d.status='ready' AND d.source_path IS NOT NULL AND d.consent_confirmed_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM knowledge_entries e WHERE e.document_id=d.id)`,
  ).get(id, chunkId) as { content_hash: string; index_version: number; text: string } | undefined;
  if (row === undefined) return unavailable();
  return {
    indexVersion: String(row.index_version), excerpt: readDraftText(row.text),
    version: draftFingerprint(row.content_hash, String(row.index_version), row.text),
  };
}

export function resolveDraftSource(db: Db, user: AuthUser, source: KnowledgeDraftSource): KnowledgeDraftOrigin {
  const meta = { schemaVersion: 1, by: user.id, at: new Date().toISOString() } as const;
  switch (source.kind) {
    case 'manual': {
      const version = draftFingerprint(source.text);
      return { ...meta, kind: 'manual', id: version, version, excerpt: source.text, excerptVerification: 'submitted' };
    }
    case 'ask':
      return { ...meta, kind: 'ask', id: source.id, excerpt: source.excerpt, ...readAsk(db, user, source.id, source.excerpt) };
    case 'note':
      return { ...meta, kind: 'note', id: source.id, excerptVerification: 'matched',
        ...readNote(db, user, source.id, source.revision, source.selection),
        ...(source.selection === undefined ? {} : { selection: source.selection }) };
    case 'document': {
      const document = readDocument(db, user, source.id, source.chunkId);
      if (document.indexVersion !== source.version) return changed();
      return { ...meta, kind: 'document', id: source.id, chunkId: source.chunkId, version: document.version,
        excerpt: document.excerpt, excerptVerification: 'matched' };
    }
  }
}

export function revalidateDraftOrigin(db: Db, origin: KnowledgeDraftOrigin): void {
  const owner = findUserById(db, origin.by);
  if (owner === undefined || owner.status !== 'active' || !hasPermission(owner.role, 'knowledge.submit')) return unavailable();
  const user = toAuthUser(owner);
  let version: string;
  switch (origin.kind) {
    case 'manual':
      return;
    case 'ask': {
      const current = readAsk(db, user, origin.id, origin.excerpt);
      if (origin.excerptVerification === 'matched' && current.excerptVerification !== 'matched') return changed();
      version = current.version;
      break;
    }
    case 'note': {
      const note = readNote(db, user, origin.id, Number(origin.version), origin.selection);
      if (note.excerpt !== origin.excerpt) return changed();
      version = note.version;
      break;
    }
    case 'document':
      version = readDocument(db, user, origin.id, origin.chunkId).version;
      break;
  }
  if (version !== origin.version) return changed();
}
