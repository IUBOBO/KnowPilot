import {
  RECORD_TYPES,
  hasPermission,
  type AskHistoryRecord,
  type AskRecord,
  type AskRecordSource,
  type AuthUser,
  type RecordType,
  type TraceCitationRef,
  type TraceRecordEvidence,
  type TraceRetrievalHit,
} from '@knowpilot/shared';
import { submissionScope } from '../auth/scope.ts';
import { getCodeAsset } from '../code/repo.ts';
import type { Db } from '../db/index.ts';
import { getPatentFor } from '../patents/repo.ts';
import { getPerson } from '../people/repo.ts';
import { getJournalById, getSubmissionFor } from '../submissions/repo.ts';
import { getThesis } from '../theses/repo.ts';

function readArray<T>(raw: string): T[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

export function withAskRecordSources(db: Db, items: readonly AskRecord[], viewer: AuthUser): AskHistoryRecord[] {
  if (items.length === 0) return [];
  const rows = db.prepare(
    `SELECT a.run_id, t.retrieval_hits_json, t.record_evidence_json, t.citation_map_json,
            CASE WHEN a.user_id = ? THEN a.answer_preview END AS answer_preview
       FROM ask_records a LEFT JOIN ask_run_traces t ON t.run_id = a.run_id
      WHERE a.run_id IN (SELECT value FROM json_each(?))`,
  ).all(viewer.id, JSON.stringify(items.map((item) => item.runId))) as unknown as {
    run_id: string;
    retrieval_hits_json: string | null;
    record_evidence_json: string | null;
    citation_map_json: string | null;
    answer_preview: string | null;
  }[];
  const previews = new Map(rows.map((row) => [row.run_id, row.answer_preview]));
  const traces = new Map(rows.flatMap((row) => row.citation_map_json === null ? [] : [[row.run_id, {
    hits: readArray<TraceRetrievalHit>(row.retrieval_hits_json ?? '[]'),
    records: readArray<TraceRecordEvidence>(row.record_evidence_json ?? '[]'),
    citations: readArray<TraceCitationRef>(row.citation_map_json),
  }] as const]));
  const chunkIds = new Set([...traces.values()].flatMap((trace) => [
    ...trace.hits.map((hit) => hit.chunkId),
    ...trace.citations.flatMap((ref) => ref.chunkId === null ? [] : [ref.chunkId]),
  ]));
  const documents = new Map<string, { chunk_id: string; doc_id: string; title: string }>();
  if (chunkIds.size > 0 && hasPermission(viewer.role, 'knowledge.read')) {
    const docRows = db.prepare(
      `WITH ids AS (SELECT value AS id FROM json_each(?))
       SELECT c.id AS chunk_id, c.doc_id, CASE WHEN d.material = 'knowledge' THEN '知识条目' ELSE d.title END AS title
         FROM ids JOIN doc_chunks c ON c.id = ids.id JOIN documents d ON d.id = c.doc_id
       UNION ALL
       SELECT c.id, c.doc_id, CASE WHEN c.material = 'knowledge' THEN '知识条目' ELSE c.doc_title END
         FROM ids JOIN archived_doc_chunks c ON c.id = ids.id
        WHERE NOT EXISTS (SELECT 1 FROM doc_chunks live WHERE live.id = c.id)`,
    ).all(JSON.stringify([...chunkIds])) as unknown as { chunk_id: string; doc_id: string; title: string }[];
    for (const row of docRows) documents.set(row.chunk_id, row);
  }

  const titles = new Map<string, string | undefined>();
  return items.map((item) => {
    const trace = traces.get(item.runId);
    const answerPreview = previews.get(item.runId) ?? null;
    if (trace === undefined) return { ...item, answerPreview, sources: null, otherSources: [] };
    const cited = new Map<string, AskRecordSource>();
    const others = new Map<string, AskRecordSource>();
    function addDocument(chunkId: string, target: Map<string, AskRecordSource>): void {
      const doc = documents.get(chunkId);
      if (doc === undefined) return;
      const key = `document:${doc.doc_id}`;
      if (!cited.has(key) && !target.has(key)) target.set(key, { id: doc.chunk_id, title: doc.title, type: 'document' });
    }
    function addRecord({ recordType, recordId }: TraceRecordEvidence, target: Map<string, AskRecordSource>): void {
      const type = RECORD_TYPES.find((candidate) => candidate === recordType);
      if (type === undefined) return;
      const id = type === 'M-JOURNAL' ? recordId.split(':', 1)[0]! : recordId;
      const key = `${type}:${id}`;
      if (cited.has(key) || target.has(key)) return;
      if (!titles.has(key)) titles.set(key, recordTitle(db, viewer, type, id));
      const title = titles.get(key);
      if (title !== undefined) target.set(key, { id, title, type });
    }
    for (const ref of trace.citations) {
      if (ref.chunkId !== null) addDocument(ref.chunkId, cited);
      if (ref.recordId !== null) {
        const record = trace.records.find((item) => item.recordId === ref.recordId);
        if (record !== undefined) addRecord(record, cited);
      }
    }
    for (const hit of trace.hits) addDocument(hit.chunkId, others);
    for (const record of trace.records) addRecord(record, others);
    return { ...item, answerPreview, sources: [...cited.values()], otherSources: [...others.values()] };
  });
}

function recordTitle(db: Db, viewer: AuthUser, type: RecordType, id: string): string | undefined {
  const { role, id: userId } = viewer;
  switch (type) {
    case 'M-PERSON':
      if (hasPermission(role, 'people.read')) return getPerson(db, id, { userId, canReadSensitive: false, canManage: false })?.name;
      break;
    case 'M-SUBMIT':
      if (hasPermission(role, 'submission.read.all')) return getSubmissionFor(db, id, submissionScope(viewer))?.title;
      break;
    case 'M-PATENT':
      if (hasPermission(role, 'patent.read.all')) return getPatentFor(db, id, { userId, canReadAll: true })?.name;
      break;
    case 'M-CODE':
      if (hasPermission(role, 'code.read')) return getCodeAsset(db, id)?.name;
      break;
    case 'M-JOURNAL':
      if (hasPermission(role, 'journal.read')) return getJournalById(db, id)?.name;
      break;
    case 'M-THESIS':
      if (hasPermission(role, 'thesis.read')) {
        const thesis = getThesis(db, id, { userId, canReadGrade: false });
        return thesis?.title ?? thesis?.personName ?? thesis?.authorName ?? undefined;
      }
  }
}
