import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEARCH_MAX_LIMIT } from '@knowpilot/shared';
import { groupPassagesByDocument, pageSearchSample, passageSearchPath } from '../src/pages/search/search-results.ts';

test('V1 document search sends the supported filters and one bounded relevance sample', () => {
  const url = new URL(passageSearchPath({
    query: '校准 & 流程怎么做？', material: 'sop', documentId: 'sample/doc',
  }), 'http://127.0.0.1');
  assert.equal(url.pathname, '/api/v1/search');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    q: '校准 & 流程怎么做？', contractVersion: '1', mode: 'keyword',
    limit: String(SEARCH_MAX_LIMIT), candidateLimit: String(SEARCH_MAX_LIMIT), material: 'sop', documentId: 'sample/doc',
  });
  const unfiltered = passageSearchPath({ query: 'query', material: undefined, documentId: undefined });
  assert.doesNotMatch(unfiltered, /[?&](?:material|documentId)=/u);
});

test('Group by document ID before paginating and retain ranked passage order', () => {
  const ranked = Array.from({ length: SEARCH_MAX_LIMIT }, (_, index) => ({
    documentId: `doc-${index % 10}`, chunkId: `chunk-${index}`,
    documentTitle: '相同标题的不同资料',
  }));
  const groups = groupPassagesByDocument(ranked);
  assert.equal(groups.length, 10);
  assert.equal(ranked.length, 50);
  assert.deepEqual(groups[0].map((hit) => hit.chunkId), ['chunk-0', 'chunk-10', 'chunk-20', 'chunk-30', 'chunk-40']);
  assert.deepEqual(pageSearchSample(groups, 0).rows.map(([head]) => head.documentId), ranked.slice(0, 8).map((hit) => hit.documentId));
  assert.deepEqual(pageSearchSample(groups, 1).rows.map(([head]) => head.documentId), ['doc-8', 'doc-9']);
  assert.equal(pageSearchSample(ranked, 6).pageCount, 7);
  assert.deepEqual(pageSearchSample(ranked, 10).rows, ranked.slice(48));
  assert.deepEqual(pageSearchSample([], 9), { pageIndex: 0, pageCount: 1, rows: [] });
});
