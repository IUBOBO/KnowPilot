import type { QuickSearchHit } from '@knowpilot/shared';

export function searchHitHref(hit: QuickSearchHit): string {
  const focus = encodeURIComponent(hit.id);
  const query = encodeURIComponent(hit.lookup ?? hit.title);
  switch (hit.kind) {
    case 'person': return `/people?q=${query}&focus=${focus}`;
    case 'patent': return `/patents?q=${query}&focus=${focus}`;
    case 'thesis': return `/theses?q=${query}&focus=${focus}`;
    case 'journal': return `/journals?q=${query}`;
    case 'submission': return `/submissions?focus=${focus}`;
    case 'dataset': return `/datasets?focus=${focus}`;
    case 'document':
      return hit.firstChunkId !== null ? `/chunk/${encodeURIComponent(hit.firstChunkId)}`
        : `/docs?material=${hit.material ?? 'paper'}&focus=${focus}`;
  }
}
