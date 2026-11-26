import { MATERIALS, type Material } from './documents.ts';

export const ASK_DOCUMENT_SCOPE_LIMIT = 150;

export interface AskDocumentRef {
  id: string;
  version: string;
}

export interface AskDocumentScopeV1 {
  version: 1;
  documents: readonly AskDocumentRef[];
}

export interface AskScopeDocument extends AskDocumentRef {
  title: string;
}

export interface SearchAskHandoffV1 {
  version: 1;
  query: string;
  documentIds: readonly string[];
  kind?: 'all' | 'document';
  material?: Material;
  documentId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function isAskDocumentId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && value.trim() === value && !/[\x00-\x1f]/u.test(value);
}

export function parseAskDocumentIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > ASK_DOCUMENT_SCOPE_LIMIT ||
    !value.every(isAskDocumentId) || new Set(value).size !== value.length) return undefined;
  return [...value];
}

export function parseAskDocumentScope(value: unknown): AskDocumentScopeV1 | undefined {
  const entry = asRecord(value);
  if (entry?.version !== 1 || !Array.isArray(entry.documents)) return undefined;
  const refs = entry.documents.map(asRecord);
  const ids = parseAskDocumentIds(refs.map((ref) => ref?.id));
  if (ids === undefined || refs.some((ref) => typeof ref?.version !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(ref.version))) return undefined;
  return { version: 1, documents: ids.map((id, i) => ({ id, version: refs[i]!.version as string })) };
}

export function parseSearchAskHandoff(value: unknown): SearchAskHandoffV1 | undefined {
  const entry = asRecord(value);
  if (entry?.version !== 1 || typeof entry.query !== 'string' || entry.query.length > 100) return undefined;
  const documentIds = parseAskDocumentIds(entry.documentIds);
  const material = MATERIALS.find((item) => item === entry.material);
  const kind = entry.kind === 'all' || entry.kind === 'document' ? entry.kind : undefined;
  if (documentIds === undefined || (entry.kind !== undefined && kind === undefined) || (entry.material !== undefined && material === undefined) ||
    (entry.documentId !== undefined && !isAskDocumentId(entry.documentId))) return undefined;
  return {
    version: 1, query: entry.query, documentIds,
    ...(kind === undefined ? {} : { kind }),
    ...(material === undefined ? {} : { material }),
    ...(entry.documentId === undefined ? {} : { documentId: entry.documentId }),
  };
}
