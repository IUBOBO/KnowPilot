import {
  AppError, INDEX_VERSION,
  type AuthUser, type DocumentRetrievalHit, type DocumentRetrievalRequest, type RecordRetrievalRequest,
  type RetrievalDiagnostic, type RetrievalResponseV1, type SearchResponse,
} from '@knowpilot/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { loadChunkEvidenceRows } from '../documents/repo.ts';
import { searchDocumentCandidates, type SearchDeps } from '../documents/search.ts';
import { queryLedger, recordSourceVersion, renderRecordBody } from './records.ts';

export async function retrieveDocumentPage(
  db: Db, config: AppConfig, request: DocumentRetrievalRequest, deps?: SearchDeps, documentIds?: readonly string[],
): Promise<{ search: SearchResponse; diagnostics: readonly RetrievalDiagnostic[]; nextOffset: number | null }> {
  const { material, documentId } = request.scope;
  const { result, diagnostics } = await searchDocumentCandidates(db, config, {
    query: request.query, mode: request.strategy, limit: request.candidateLimit,
    ...(material === undefined ? {} : { material }),
    ...(documentId === undefined ? {} : { documentId }),
    ...(documentIds === undefined ? {} : { documentIds }),
  }, deps);
  const end = request.offset + request.limit;
  const hits = result.hits.slice(request.offset, end);
  return {
    search: { ...result, returned: hits.length, hits },
    diagnostics,
    nextOffset: end < result.hits.length ? end : null,
  };
}

export async function retrieveDocumentsV1(
  db: Db, config: AppConfig, request: DocumentRetrievalRequest, deps?: SearchDeps,
): Promise<RetrievalResponseV1> {
  const { search, diagnostics, nextOffset } = await retrieveDocumentPage(db, config, request, deps);
  const flags = new Set(diagnostics);
  const fallbackNotice = '重排不可用，已按融合排序返回。';
  // Legacy callers retain their existing message. The versioned contract reports public diagnostics only.
  const ranking = search.ranking?.fallbackReason === undefined ? search.ranking
    : { ...search.ranking, fallbackReason: fallbackNotice };
  const notice = flags.has('rerank_fallback') ? fallbackNotice : search.notice;
  const { documentId, material } = request.scope;
  if (documentId !== undefined || material !== undefined) {
    const condition = documentId === undefined ? 'd.material = ?' : 'd.id = ? AND (? IS NULL OR d.material = ?)';
    const parameters = documentId === undefined ? [material ?? null] : [documentId, material ?? null, material ?? null];
    const states = db.prepare(`SELECT DISTINCT CASE
      WHEN d.status <> 'ready' OR NOT EXISTS (SELECT 1 FROM doc_chunks c WHERE c.doc_id = d.id)
        THEN 'index_unavailable'
      WHEN d.index_version < ? THEN 'index_stale'
    END AS diagnostic FROM documents d WHERE ${condition} ORDER BY diagnostic`)
      .all(INDEX_VERSION, ...parameters) as { diagnostic: 'index_stale' | 'index_unavailable' | null }[];
    for (const { diagnostic } of states) {
      if (diagnostic !== null) flags.add(diagnostic);
    }
  }
  const versions = loadChunkEvidenceRows(db, search.hits.map((hit) => hit.chunkId));
  const hits: DocumentRetrievalHit[] = [];
  for (const hit of search.hits) {
    const source = versions.get(hit.chunkId);
    if (source === undefined || source.documentId !== hit.documentId || source.material !== hit.material) continue;
    if (source.indexVersion < INDEX_VERSION) flags.add('index_stale');
    hits.push({
      ...hit,
      kind: 'document',
      sourceVersion: String(source.indexVersion),
      excerpt: hit.segments.map((segment) => segment.text).join(''),
      matchedBy: hit.matchedBy ?? (search.mode === 'hybrid' ? [] : [search.mode]),
    });
  }
  return {
    version: 1, query: search.query, scope: request.scope, requestedStrategy: request.strategy,
    strategy: search.mode, state: hits.length === 0 ? 'empty' : 'ok', diagnostics: [...flags],
    offset: request.offset, nextOffset, hits,
    ...(ranking === undefined ? {} : { ranking }),
    ...(notice === undefined ? {} : { notice }),
  };
}

export function retrieveRecordsV1(db: Db, request: RecordRetrievalRequest, user: AuthUser): RetrievalResponseV1 {
  const scope = request.scope;
  if (scope.recordId !== undefined && (request.offset !== 0 ||
      Object.entries(scope).some(([key, value]) => !['kind', 'recordType', 'recordId'].includes(key) && value !== undefined))) {
    throw new AppError('invalid_argument', '按 ID 查询记录时不能使用列表筛选或偏移。');
  }
  const keyword = request.query.trim();
  const page = { keyword, limit: request.limit, offset: request.offset,
    ...(scope.recordId === undefined ? {} : { recordId: scope.recordId }),
    ...(scope.groupId === undefined ? {} : { groupId: scope.groupId }),
  };
  const person = 'personId' in scope && scope.personId !== undefined ? { personId: scope.personId } : {};
  const year = 'year' in scope && scope.year !== undefined ? { year: scope.year } : {};
  const query = scope.recordType === 'M-SUBMIT' ? { ...page, ...person, ...year, type: scope.recordType, status: scope.status }
    : scope.recordType === 'M-PATENT' ? { ...page, ...person, ...year, type: scope.recordType, filter: scope.milestone ?? 'all' }
    : scope.recordType === 'M-PERSON' ? { ...page, type: scope.recordType, ...(scope.status === undefined ? {} : { status: scope.status }) }
    : { ...page, ...person, type: scope.recordType };
  const { records, matched } = queryLedger(db, query, { user }, new Date().toISOString());
  const hits = records.map((record) => ({
    ...record,
    kind: 'record' as const,
    sourceVersion: recordSourceVersion(record),
    excerpt: renderRecordBody(record.fields),
    matchedBy: ['structured'] as const,
  }));
  const end = request.offset + hits.length;
  return {
    version: 1, query: keyword, scope: request.scope, requestedStrategy: 'structured', strategy: 'structured',
    state: hits.length === 0 ? 'empty' : 'ok', diagnostics: [],
    offset: request.offset, nextOffset: hits.length > 0 && end < matched ? end : null, hits,
  };
}
