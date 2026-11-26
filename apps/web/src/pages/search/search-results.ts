import {
  SEARCH_MAX_LIMIT, type DocumentRetrievalHit, type Material,
} from '@knowpilot/shared';

export interface DocumentSearchScope {
  query: string;
  material: Material | undefined;
  documentId: string | undefined;
}

export function passageSearchPath({ query, material, documentId }: DocumentSearchScope): string {
  const params = new URLSearchParams({
    q: query, contractVersion: '1', mode: 'keyword',
    limit: String(SEARCH_MAX_LIMIT), candidateLimit: String(SEARCH_MAX_LIMIT),
  });
  if (material !== undefined) params.set('material', material);
  if (documentId !== undefined) params.set('documentId', documentId);
  return `/api/v1/search?${params}`;
}

/** Preserve service relevance order. Each document is ranked by its first (best) hit. */
export function groupPassagesByDocument(passages: readonly DocumentRetrievalHit[]) {
  const groups = new Map<string, DocumentRetrievalHit[]>();
  for (const hit of passages) {
    const group = groups.get(hit.documentId);
    if (group === undefined) groups.set(hit.documentId, [hit]);
    else group.push(hit);
  }
  return [...groups.values()];
}

export const SEARCH_PAGE_SIZE = 8;

export function pageSearchSample<T>(rows: readonly T[], index: number) {
  const pageCount = Math.max(1, Math.ceil(rows.length / SEARCH_PAGE_SIZE));
  const pageIndex = Math.min(Math.max(index, 0), pageCount - 1);
  const offset = pageIndex * SEARCH_PAGE_SIZE;
  return { pageIndex, pageCount, rows: rows.slice(offset, offset + SEARCH_PAGE_SIZE) };
}
