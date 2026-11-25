import type { Citation } from './answer.ts';
import type { EvidenceLocator } from './search.ts';

/** An open intent produced from a server-issued citation or retrieval result. */
export interface EvidenceOpenRequest {
  version: 1;
  locator: EvidenceLocator;
  citation?: {
    runId: string;
    citationId: string;
  };
}

/** True means handled by the reader. Loading and access are checked separately. */
export type OpenEvidence = (request: EvidenceOpenRequest) => boolean;

function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Older citations without a source version keep their existing link behavior. */
export function citationEvidenceRequest(runId: string, citation: Citation): EvidenceOpenRequest | null {
  if (!present(runId) || !present(citation.id) || !present(citation.sourceVersion)) return null;

  const origin = { runId, citationId: citation.id };
  const sourceVersion = citation.sourceVersion;
  if (citation.sourceType === 'document' && present(citation.documentId) && present(citation.chunkId)) {
    return { version: 1, citation: origin, locator: {
      kind: 'document', documentId: citation.documentId, chunkId: citation.chunkId, sourceVersion,
    } };
  }
  if (citation.sourceType === 'record' && present(citation.recordType) && present(citation.recordId)) {
    return { version: 1, citation: origin, locator: {
      kind: 'record', recordType: citation.recordType, recordId: citation.recordId, sourceVersion,
    } };
  }
  return null;
}

export function sameEvidenceLocator(a: EvidenceLocator, b: EvidenceLocator): boolean {
  if (a.sourceVersion !== b.sourceVersion) return false;
  if (a.kind === 'document' && b.kind === 'document') {
    return a.documentId === b.documentId && a.chunkId === b.chunkId;
  }
  return a.kind === 'record' && b.kind === 'record' &&
    a.recordType === b.recordType && a.recordId === b.recordId;
}
