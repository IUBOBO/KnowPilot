import { randomUUID } from 'node:crypto';
import {
  AppError, NOTE_RUN_LIMIT, RECORD_TYPES,
  type CreateResearchNote, type EvidenceLocator, type NoteRunInput, type NoteRunMode,
  type ResearchNoteSummary, type TraceCitationRef, type TraceRecordEvidence, type UpdateResearchNote,
} from '@knowpilot/shared';
import type { Db } from '../db/index.ts';
import { findAskRecordOwner } from '../feedback/repo.ts';

interface NoteRow {
  id: string;
  title: string;
  body: string;
  tags_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface StoredNoteSource {
  citationId: string;
  locator: EvidenceLocator | null;
  recordFingerprint?: string;
}

export interface StoredNote extends ResearchNoteSummary {
  body: string;
  runs: readonly (NoteRunInput & { sources: readonly StoredNoteSource[] })[];
}

function summary(row: Omit<NoteRow, 'body'>): ResearchNoteSummary {
  return { id: row.id, title: row.title, tags: JSON.parse(row.tags_json) as string[],
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function listResearchNotes(db: Db, owner: string, query: string, limit: number, offset: number) {
  const rows = db.prepare(`
    SELECT id,title,tags_json,revision,created_at,updated_at FROM research_notes
     WHERE owner_id = ? AND (
      ? = '' OR instr(lower(title), lower(?)) > 0 OR instr(lower(body), lower(?)) > 0 OR
      EXISTS (SELECT 1 FROM json_each(tags_json) WHERE instr(lower(value), lower(?)) > 0)
     ) ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`)
    .all(owner, query, query, query, query, limit + 1, offset) as Omit<NoteRow, 'body'>[];
  return { items: rows.slice(0, limit).map(summary), nextOffset: rows.length > limit ? offset + limit : null };
}

function requireOwned(db: Db, owner: string, id: string): NoteRow {
  const row = db.prepare('SELECT * FROM research_notes WHERE id=? AND owner_id=?').get(id, owner) as NoteRow | undefined;
  if (row === undefined) throw new AppError('not_found', '没有这条笔记。');
  return row;
}

export function readResearchNote(db: Db, owner: string, id: string): StoredNote {
  const row = requireOwned(db, owner, id);
  const runs = db.prepare('SELECT run_id,mode FROM research_note_runs WHERE note_id=? ORDER BY rowid')
    .all(id) as { run_id: string; mode: NoteRunMode }[];
  const sources = db.prepare('SELECT run_id,citation_id,locator_json FROM research_note_sources WHERE note_id=? ORDER BY rowid')
    .all(id) as { run_id: string; citation_id: string; locator_json: string | null }[];
  return { ...summary(row), body: row.body,
    runs: runs.map((run) => ({ runId: run.run_id, mode: run.mode, sources: sources
      .filter((source) => source.run_id === run.run_id)
      .map((source) => {
        if (source.locator_json === null) return { citationId: source.citation_id, locator: null };
        const { recordFingerprint, ...locator } = JSON.parse(source.locator_json) as EvidenceLocator & { recordFingerprint?: string };
        return { citationId: source.citation_id, locator,
          ...(recordFingerprint === undefined ? {} : { recordFingerprint }) };
      }) })) };
}

function transaction<T>(db: Db, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function locatorFor(citation: TraceCitationRef, records: readonly TraceRecordEvidence[]): EvidenceLocator | null {
  const version = citation.sourceVersion;
  if (typeof version !== 'string' || version === '') return null;
  if (citation.chunkId && citation.documentId) {
    return { kind: 'document', chunkId: citation.chunkId, documentId: citation.documentId, sourceVersion: version };
  }
  if (!citation.recordId) return null;
  const matching = new Set(records.filter((record) => record.recordId === citation.recordId).map((record) => record.recordType));
  const type = citation.recordType ?? (matching.size === 1 ? [...matching][0] : undefined);
  const recordType = RECORD_TYPES.find((item) => item === type);
  return recordType === undefined ? null : { kind: 'record', recordId: citation.recordId, recordType, sourceVersion: version };
}

function appendRuns(db: Db, owner: string, noteId: string, runs: readonly NoteRunInput[]) {
  if (runs.length === 0) return;
  const stored = db.prepare('SELECT run_id FROM research_note_runs WHERE note_id=?').all(noteId);
  const existing = new Set(stored.map((row) => row.run_id));
  const requested = runs.filter((run) => !existing.has(run.runId));
  if (existing.size + requested.length > NOTE_RUN_LIMIT) throw new AppError('invalid_argument', '此笔记关联的问答轮次已达上限。');
  const trace = db.prepare('SELECT citation_map_json,record_evidence_json FROM ask_run_traces WHERE run_id=? AND user_id=?');
  const addRun = db.prepare('INSERT INTO research_note_runs(note_id,run_id,mode) VALUES(?,?,?)');
  const addSource = db.prepare('INSERT INTO research_note_sources(note_id,run_id,citation_id,locator_json) VALUES(?,?,?,?)');
  for (const run of requested) {
    if (findAskRecordOwner(db, run.runId) !== owner) throw new AppError('not_found', '无法关联这次问答。');
    addRun.run(noteId, run.runId, run.mode);
    const row = trace.get(run.runId, owner) as { citation_map_json: string; record_evidence_json: string } | undefined;
    if (row === undefined) continue;
    const citations = JSON.parse(row.citation_map_json) as TraceCitationRef[];
    const records = JSON.parse(row.record_evidence_json) as TraceRecordEvidence[];
    for (const c of citations) {
      const locator = locatorFor(c, records);
      addSource.run(noteId, run.runId, c.id, locator === null ? null : JSON.stringify({
        ...locator, recordFingerprint: c.recordFingerprint,
      }));
    }
  }
}

function assertRevision(row: NoteRow, revision: number) {
  if (row.revision !== revision) throw new AppError('invalid_argument', '笔记已有更新。请重新打开后再保存或删除。', { httpStatus: 409 });
}

export function createResearchNote(db: Db, owner: string, input: CreateResearchNote) {
  const id = randomUUID();
  const now = new Date().toISOString();
  transaction(db, () => {
    db.prepare('INSERT INTO research_notes(id,owner_id,title,body,tags_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, owner, input.title, input.body, JSON.stringify(input.tags), now, now);
    appendRuns(db, owner, id, input.runs ?? []);
  });
  return readResearchNote(db, owner, id);
}

export function updateResearchNote(db: Db, owner: string, id: string, input: UpdateResearchNote) {
  transaction(db, () => {
    assertRevision(requireOwned(db, owner, id), input.revision);
    db.prepare('UPDATE research_notes SET title=?,body=?,tags_json=?,updated_at=?,revision=revision+1 WHERE id=? AND owner_id=?')
      .run(input.title, input.body, JSON.stringify(input.tags), new Date().toISOString(), id, owner);
    appendRuns(db, owner, id, input.appendRuns ?? []);
  });
  return readResearchNote(db, owner, id);
}

export function deleteResearchNote(db: Db, owner: string, id: string, revision: number) {
  transaction(db, () => {
    assertRevision(requireOwned(db, owner, id), revision);
    db.prepare('DELETE FROM research_notes WHERE id=? AND owner_id=?').run(id, owner);
  });
}
