import {
  RETRIEVAL_RECORD_TYPES,
  citationEvidenceRequest,
  sameEvidenceLocator,
  type Citation,
  type ChunkContextResponse,
  type DocumentEvidenceLocator,
  type EvidenceOpenRequest,
  type RecordEvidenceLocator,
  type RecordRetrievalHit,
  type RetrievalResponseV1,
} from '@knowpilot/shared';
import { apiGet } from '../../api.ts';

interface EvidenceReaderSource {
  request: EvidenceOpenRequest;
  recordHref?: string;
  /** Only server-issued text, matched verbatim against the fresh source, can produce a mark. */
  quote?: string;
}

export type EvidenceReaderSources = readonly EvidenceReaderSource[];

export function answerEvidenceSources(
  runId: string, citations: readonly Citation[], recordLink?: (citation: Citation) => string | undefined,
): EvidenceReaderSources {
  return citations.flatMap((citation) => {
    const request = citationEvidenceRequest(runId, citation);
    if (request === null) return [];
    if (citation.sourceType === 'document') return [{ request, quote: citation.quote ?? citation.excerpt }];
    const recordHref = citation.sourceType === 'record' ? recordLink?.(citation) : undefined;
    return recordHref === undefined ? [{ request }] : [{ request, recordHref }];
  });
}

function journalEvidencePath(recordId: string): string | undefined {
  // The final field can contain colons; a plain journal hit has no ranking locator.
  const [id, year, system, ...dimension] = recordId.split(':');
  if (!id || !year || !/^[1-9]\d{3}$/u.test(year) || !system || dimension.length === 0) return undefined;
  const query = new URLSearchParams({ year, system, category: dimension.join(':') });
  return `/api/v1/journals/${encodeURIComponent(id)}/rankings/evidence?${query}`;
}

function exactRecordPath(locator: RecordEvidenceLocator): string | undefined {
  if (locator.recordType === 'M-CODE') return `/api/v1/code-assets/${encodeURIComponent(locator.recordId)}/evidence`;
  if (locator.recordType === 'M-JOURNAL') return journalEvidencePath(locator.recordId);
  return undefined;
}

export function supportsEvidence(request: EvidenceOpenRequest): boolean {
  const locator = request.locator;
  if (locator.kind === 'document') return true;
  return exactRecordPath(locator) !== undefined || RETRIEVAL_RECORD_TYPES.some((type) => type === locator.recordType);
}

/** Match the active host catalog before doing any I/O. A historical answer may reuse an evidence ID. */
export function resolveEvidenceSource(sources: EvidenceReaderSources, request: EvidenceOpenRequest) {
  if (request.version !== 1 || !supportsEvidence(request)) return undefined;
  return sources.find((source) =>
    source.request.citation?.runId === request.citation?.runId &&
    source.request.citation?.citationId === request.citation?.citationId &&
    sameEvidenceLocator(source.request.locator, request.locator),
  );
}

type SourceVersion = 'matched' | 'changed' | 'unknown';
export type LoadedEvidence =
  | { kind: 'document'; context: ChunkContextResponse; version: SourceVersion; highlight: readonly [number, number] | null }
  | { kind: 'record'; hit: RecordRetrievalHit; version: SourceVersion }
  | { kind: 'unavailable' };

function compareVersion(expected: string, current: string | undefined): SourceVersion {
  if (!current) return 'unknown';
  return current === expected ? 'matched' : 'changed';
}

function loadDocument(locator: DocumentEvidenceLocator, quote?: string, signal?: AbortSignal): Promise<LoadedEvidence> {
  return apiGet<ChunkContextResponse>(`/api/v1/chunks/${encodeURIComponent(locator.chunkId)}`, signal, { noAuthRedirect: true, cache: 'no-store' })
    .then((context) => {
      if (context.document.id !== locator.documentId || context.chunk.id !== locator.chunkId) {
        return { kind: 'unavailable' };
      }
      const currentVersion = context.sourceVersion ?? context.archivedIndexVersion?.toString();
      const version = compareVersion(locator.sourceVersion, currentVersion);
      const text = context.chunk.text;
      const start = version === 'matched' && quote?.trim() ? text.indexOf(quote) : -1;
      const highlight = quote !== undefined && start >= 0 && text.indexOf(quote, start + 1) === -1
        ? [start, start + quote.length] as const
        : null;
      return { kind: 'document', context, version, highlight };
    });
}

export async function loadEvidence(source: EvidenceReaderSource, signal: AbortSignal): Promise<LoadedEvidence> {
  const { locator } = source.request;
  try {
    if (locator.kind === 'document') return await loadDocument(locator, source.quote, signal);
    if (!supportsEvidence(source.request)) return { kind: 'unavailable' };

    const opts = { noAuthRedirect: true, cache: 'no-store' } as const;
    const exactPath = exactRecordPath(locator);
    let hit;
    if (exactPath !== undefined) {
      hit = await apiGet<RecordRetrievalHit>(exactPath, signal, opts);
    } else {
      const query = new URLSearchParams({ contractVersion: '1', recordType: locator.recordType, recordId: locator.recordId });
      const response = await apiGet<RetrievalResponseV1>(`/api/v1/search?${query}`, signal, opts);
      if (response.version !== 1 || response.hits.length !== 1) return { kind: 'unavailable' };
      hit = response.hits[0];
    }
    if (hit?.kind !== 'record' || hit.recordType !== locator.recordType || hit.recordId !== locator.recordId) {
      return { kind: 'unavailable' };
    }
    const version = compareVersion(locator.sourceVersion, hit.sourceVersion);
    if (hit.recordType === 'M-JOURNAL' && version !== 'matched') return { kind: 'unavailable' };
    return { kind: 'record', hit, version };
  } catch {
    // Neither a revoked source nor an unresolvable historical locator should fall back to cached excerpts.
    return { kind: 'unavailable' };
  }
}
