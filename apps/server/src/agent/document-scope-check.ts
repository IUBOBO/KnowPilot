import assert from 'node:assert/strict';
import { parseAskDocumentIds, parseAskDocumentScope, parseSearchAskHandoff } from '@knowpilot/shared';

const version = 'a'.repeat(64);
const document = { id: 'a/1', version };
assert.deepEqual(parseAskDocumentScope({ version: 1, documents: [document] }), { version: 1, documents: [document] });
assert.equal(parseAskDocumentScope({ version: 1, documents: [] }), undefined);
assert.equal(parseAskDocumentScope({ version: 1, documents: [document, document] }), undefined);
assert.equal(parseAskDocumentScope({ version: 2, documents: [document] }), undefined);
assert.equal(parseAskDocumentScope({ version: 1, documents: [{ id: 'a/1', version: 'stale' }] }), undefined);
assert.equal(parseAskDocumentIds(['a', ' a ']), undefined);
assert.equal(parseAskDocumentIds(Array.from({ length: 151 }, (_, index) => String(index))), undefined);
const handoff = { version: 1, query: '流程', material: 'sop', documentId: 'a/1', documentIds: ['a/1', 'b'] };
assert.deepEqual(parseSearchAskHandoff(handoff), handoff);
assert.equal(parseSearchAskHandoff({ ...handoff, material: 'unsupported' }), undefined);
console.log('PASS versioned scope and URL handoff validation');
