import {
  AppError, RETRIEVAL_RECORD_TYPES, hasPermission,
  type AuthUser, type DocumentEvidenceLocator, type NoteSource, type RecordEvidenceLocator, type RecordRetrievalHit, type ResearchNote,
} from '@knowpilot/shared';
import { rankingFields, rankingRecordId } from '../agent/journal-tool.ts';
import { getCodeAssetEvidence } from '../code/repo.ts';
import type { Db } from '../db/index.ts';
import { getChunkContext } from '../documents/repo.ts';
import { recordContentFingerprint, recordDependsOnLinkedFields } from '../retrieval/records.ts';
import { retrieveRecordsV1 } from '../retrieval/service.ts';
import { getJournalById, getRankingByPeriod } from '../submissions/repo.ts';
import { readOwnedAskQuestion, readResearchNote, type StoredNote, type StoredNoteSource } from './repo.ts';

function readDocumentSource(db: Db, user: AuthUser, locator: DocumentEvidenceLocator) {
  if (!hasPermission(user.role, 'knowledge.read')) return null;
  const document = db.prepare("SELECT id FROM documents WHERE id = ? AND status = 'ready'").get(locator.documentId);
  if (document === undefined) return null;
  const context = getChunkContext(db, locator.chunkId);
  return context?.document.id === locator.documentId ? context : null;
}

export function presentNoteSource(db: Db, user: AuthUser, source: StoredNoteSource): NoteSource {
  const { citationId, locator } = source;
  const unavailable = { citationId, status: 'unavailable' } as const;
  const changed = { citationId, status: 'changed' } as const;
  if (locator === null) return unavailable;

  const available = (title: string): NoteSource => ({ citationId, status: 'available', title, locator });
  if (locator.kind === 'document') {
    const context = readDocumentSource(db, user, locator);
    if (context === null) return unavailable;
    return context.sourceVersion === locator.sourceVersion ? available(context.document.title) : changed;
  }
  const record = readExactRecordSource(db, user, locator);
  if (record === null || (recordDependsOnLinkedFields(locator.recordType) && source.recordFingerprint === undefined)) return unavailable;
  return matchingRecord(source, locator, record) ? available(record.recordTitle) : changed;
}

function matchingRecord(source: StoredNoteSource, locator: RecordEvidenceLocator, record: RecordRetrievalHit) {
  return record.sourceVersion === locator.sourceVersion && (source.recordFingerprint === undefined ||
    recordContentFingerprint(record.recordTitle, record.fields) === source.recordFingerprint);
}

function readExactRecordSource(db: Db, user: AuthUser, locator: RecordEvidenceLocator): RecordRetrievalHit | null {
  if (locator.recordType === 'M-CODE') {
    return hasPermission(user.role, 'code.read') ? getCodeAssetEvidence(db, locator.recordId) : null;
  }
  if (locator.recordType === 'M-JOURNAL') {
    if (!hasPermission(user.role, 'journal.read')) return null;
    const [journalId, year, system, ...dimension] = locator.recordId.split(':');
    if (!journalId || !year || !/^[1-9]\d{3}$/u.test(year) || !system || dimension.length === 0) return null;
    const category = dimension.join(':');
    const ranking = getRankingByPeriod(db, journalId, Number(year), system, category);
    const journal = getJournalById(db, journalId);
    if (ranking === null || journal === null || rankingRecordId(journalId, ranking) !== locator.recordId) return null;
    return {
      kind: 'record', recordType: 'M-JOURNAL', recordId: locator.recordId,
      sourceVersion: [year, system, category].filter(Boolean).join(' '),
      recordTitle: journal.name, recordUpdatedAt: null, queryTime: new Date().toISOString(),
      excerpt: '', fields: rankingFields(ranking, journal.name), matchedBy: ['structured'],
    };
  }
  const recordType = RETRIEVAL_RECORD_TYPES.find((type) => type === locator.recordType);
  if (recordType === undefined || !hasPermission(user.role, 'knowledge.read')) return null;
  const { hits } = retrieveRecordsV1(db, {
    version: 1, query: '', strategy: 'structured', limit: 1, offset: 0,
    scope: { kind: 'record', recordType, recordId: locator.recordId },
  }, user);
  const record = hits[0];
  return record?.kind === 'record' ? record : null;
}

/** Project only the currently authorized sources of a note fetched for this owner. */
export function presentResearchNote(db: Db, user: AuthUser, note: StoredNote): ResearchNote {
  return { ...note, runs: note.runs.map((run) => {
    const question = readOwnedAskQuestion(db, user.id, run.runId);
    return {
      runId: run.runId, mode: run.mode,
      ...(question === undefined ? {} : { question }),
      sources: run.sources.map((source) => question === undefined
        ? { citationId: source.citationId, status: 'unavailable' }
        : presentNoteSource(db, user, source)),
    };
  }) };
}

/** Check ownership and the pinned version again at the moment the reader opens. */
function linkedSource(db: Db, user: AuthUser, noteId: string, runId: string, citationId: string) {
  const note = readResearchNote(db, user.id, noteId);
  const run = note.runs.find((entry) => entry.runId === runId);
  return readOwnedAskQuestion(db, user.id, runId) === undefined ? undefined : run?.sources.find((entry) => entry.citationId === citationId);
}

function missingSource(): never {
  throw new AppError('not_found', '无法读取笔记中的此版来源。');
}

export function readResearchNoteDocument(db: Db, user: AuthUser, noteId: string, runId: string, citationId: string) {
  const source = linkedSource(db, user, noteId, runId, citationId);
  if (source?.locator?.kind !== 'document') return missingSource();
  const context = readDocumentSource(db, user, source.locator);
  if (context === null || context.sourceVersion !== source.locator.sourceVersion) return missingSource();
  return context;
}

export function readResearchNoteRecord(db: Db, user: AuthUser, noteId: string, runId: string, citationId: string) {
  const source = linkedSource(db, user, noteId, runId, citationId);
  if (source?.locator?.kind !== 'record' || (recordDependsOnLinkedFields(source.locator.recordType) && source.recordFingerprint === undefined)) {
    return missingSource();
  }
  const record = readExactRecordSource(db, user, source.locator);
  if (record === null || !matchingRecord(source, source.locator, record)) return missingSource();
  return record;
}
