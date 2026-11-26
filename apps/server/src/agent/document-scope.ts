import { createHash } from 'node:crypto';
import { AppError, hasPermission, type AskDocumentScopeV1, type AskScopeDocument, type AuthUser } from '@knowpilot/shared';
import type { Db } from '../db/index.ts';

export function resolveAskScopeDocuments(
  db: Db, user: AuthUser | null, ids: readonly string[],
): AskScopeDocument[] {
  if (user === null || !hasPermission(user.role, 'knowledge.read')) {
    throw new AppError('permission_denied', '当前账号没有资料检索权限。');
  }
  const rows = db.prepare(
    `SELECT id, title, content_hash, index_version, created_at,
       (SELECT json_group_array(id) FROM (SELECT id FROM doc_chunks c WHERE c.doc_id = d.id ORDER BY ordinal, id)) AS chunks
     FROM documents d
     WHERE d.id IN (${ids.map(() => '?').join(',')}) AND status = 'ready'
     AND EXISTS (SELECT 1 FROM doc_chunks c WHERE c.doc_id = d.id)`,
  ).all(...ids) as { id: string; title: string; content_hash: string; index_version: number; created_at: string; chunks: string }[];
  const documents = new Map(rows.map((row) => [row.id, {
    id: row.id,
    title: row.title,
    version: createHash('sha256').update(JSON.stringify([row.content_hash, row.index_version, row.created_at, row.chunks])).digest('hex'),
  }]));
  return ids.flatMap((id) => {
    const document = documents.get(id);
    return document === undefined ? [] : [document];
  });
}

export function requireAskScopeDocuments(db: Db, user: AuthUser | null, scope: AskDocumentScopeV1): Set<string> {
  const current = resolveAskScopeDocuments(db, user, scope.documents.map((doc) => doc.id));
  const versions = new Map(current.map((doc) => [doc.id, doc.version]));
  if (scope.documents.length === 0 || scope.documents.some((doc) => versions.get(doc.id) !== doc.version)) {
    throw new AppError('invalid_argument', '选定资料已失效、版本变化或不可检索。请重新选择资料，或主动改为全库检索。');
  }
  return new Set(versions.keys());
}
