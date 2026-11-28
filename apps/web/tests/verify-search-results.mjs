import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEARCH_MAX_LIMIT } from '@knowpilot/shared';
import { groupPassagesByDocument, pageSearchSample, passageSearchPath, previewPassage } from '../src/pages/search/search-results.ts';

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

test('Leave short and empty excerpts intact; shorten long excerpts without guessing hits', () => {
  const short = [{ text: 'a calibration sample', hit: false }];
  assert.equal(previewPassage(short), short);
  const empty = [];
  assert.equal(previewPassage(empty), empty);
  const noHits = [{ text: '未命中'.repeat(80), hit: false }];
  assert.deepEqual(previewPassage(noHits), [{ text: '未命中'.repeat(60), hit: false }]);
});

test('Preserve server hit boundaries and composed graphemes in a clipped prefix', () => {
  const leading = { text: '校'.repeat(177), hit: false };
  const repeated = { text: '准', hit: false };
  const actualHit = { text: '准e\u0301👩‍🔬水', hit: true };
  const result = previewPassage([leading, repeated, actualHit, { text: '。'.repeat(70), hit: false }]);
  assert.deepEqual(result, [leading, repeated, { text: '准e\u0301', hit: true }]);

  const crossSegment = [
    { text: '校'.repeat(179) + 'e', hit: false },
    { text: '\u0301' + '验'.repeat(50), hit: true },
  ];
  assert.deepEqual(previewPassage(crossSegment), [crossSegment[0], { text: '\u0301', hit: true }]);

  const emoji = [
    { text: '校'.repeat(179), hit: false },
    { text: '👩‍🔬水' + '验'.repeat(50), hit: true },
  ];
  assert.deepEqual(previewPassage(emoji), [emoji[0], { text: '👩‍🔬', hit: true }]);
});

test('Keep a nearby first match visible and bound far-away matches', () => {
  const nearby = { text: '读'.repeat(192), hit: false };
  const hit = { text: '校准', hit: true };
  const tail = { text: '。'.repeat(80), hit: false };
  assert.deepEqual(previewPassage([nearby, hit, tail]), [nearby, hit]);
  const far = { text: '读'.repeat(240), hit: false };
  assert.deepEqual(previewPassage([far, hit, tail]), [{ text: '读'.repeat(180), hit: false }]);
});
