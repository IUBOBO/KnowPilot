import {
  SEARCH_MAX_LIMIT, type DocumentRetrievalHit, type Material, type TextSegment,
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

const excerptGraphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const PREVIEW_LENGTH = 180;
const PREVIEW_LIMIT_WITH_HIT = 224;

/** Shorten only the displayed prefix. Keep the server’s original hit boundaries. */
export function previewPassage(segments: readonly TextSegment[]): readonly TextSegment[] {
  const text = segments.map((segment) => segment.text).join('');
  const firstHit = segments.findIndex((segment) => segment.hit && segment.text !== '');
  const firstHitStart = firstHit === -1 ? -1
    : segments.slice(0, firstHit).reduce((length, segment) => length + segment.text.length, 0);
  const firstHitEnd = firstHitStart + (segments[firstHit]?.text.length ?? 0);
  let graphemes = 0;
  let end = 0;
  let previewEnd = 0;
  for (const { index, segment } of excerptGraphemes.segment(text)) {
    end = index + segment.length;
    graphemes += 1;
    if (graphemes === PREVIEW_LENGTH) {
      previewEnd = end;
      if (firstHitStart < end) break;
    }
    if (graphemes > PREVIEW_LENGTH) {
      if (end >= firstHitEnd || graphemes === PREVIEW_LIMIT_WITH_HIT) {
        // Extend only when at least part of the first match is in reach.
        end = firstHitStart < end ? end : previewEnd;
        break;
      }
    }
  }
  if (end === text.length) return segments;

  const preview: TextSegment[] = [];
  let remaining = end;
  for (const segment of segments) {
    if (remaining === 0) break;
    preview.push(segment.text.length <= remaining ? segment : { ...segment, text: segment.text.slice(0, remaining) });
    remaining -= Math.min(remaining, segment.text.length);
  }
  return preview;
}

export const SEARCH_PAGE_SIZE = 8;

export function pageSearchSample<T>(rows: readonly T[], index: number) {
  const pageCount = Math.max(1, Math.ceil(rows.length / SEARCH_PAGE_SIZE));
  const pageIndex = Math.min(Math.max(index, 0), pageCount - 1);
  const offset = pageIndex * SEARCH_PAGE_SIZE;
  return { pageIndex, pageCount, rows: rows.slice(offset, offset + SEARCH_PAGE_SIZE) };
}
