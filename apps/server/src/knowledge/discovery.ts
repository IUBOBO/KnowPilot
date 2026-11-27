import { randomUUID } from 'node:crypto';
import {
  AppError, hasPermission, type AuthUser, type KnowledgeDiscoveryResponse, type KnowledgeDraftSource,
} from '@knowpilot/shared';
import type { Db } from '../db/index.ts';
import { draftFingerprint, parseDraftSource, resolveDraftSource } from './draft-source.ts';
import {
  classifyKnowledge, DISCOVERY_COOLDOWN_MS, DISCOVERY_DAILY_LIMIT, DISCOVERY_PENDING_LIMIT,
  discoveryFingerprint, hasDifferentProjectOrConditions,
} from './discovery-classifier.ts';

type Source = Exclude<KnowledgeDraftSource, { kind: 'manual' }>;
interface DiscoveryRow {
  id: string;
  source_json: string;
  source_version: string;
  fingerprint: string;
  created_at: string;
  status: 'pending' | 'ignored';
}
const DAY_MS = 24 * 60 * 60_000;

interface CandidateRow {
  id: string;
  content: string;
  doc_id: string;
  confirmed_at: string | null;
  content_hash: string;
  index_version: number;
}

function candidateRevision(row: CandidateRow): string {
  return draftFingerprint(row.content, row.doc_id, row.confirmed_at ?? '', row.content_hash, String(row.index_version));
}

// Knowledge search is shared among accounts with knowledge.read. During candidate
// collection only ready, indexed, active knowledge qualifies; private rows never enter.
const activeCandidates = `SELECT ke.id, ke.content, d.id AS doc_id, ke.confirmed_at, d.content_hash, d.index_version
  FROM knowledge_entries ke JOIN documents d ON d.id = ke.document_id
  WHERE ke.status = 'active' AND d.status = 'ready' AND d.material = 'knowledge'
    AND EXISTS (SELECT 1 FROM doc_chunks c WHERE c.doc_id = d.id)`;

function listActiveCandidates(db: Db, user: AuthUser): CandidateRow[] {
  return hasPermission(user.role, 'knowledge.read')
    ? db.prepare(activeCandidates).all() as unknown as CandidateRow[]
    : [];
}

export function discoverMatch(db: Db, user: AuthUser, content: string) {
  return classifyKnowledge(content, listActiveCandidates(db, user)
    .map((row) => ({ id: row.id, content: row.content, revision: candidateRevision(row) })));
}

export function vectorCandidates(db: Db, user: AuthUser, content: string, model: string) {
  const eligible = listActiveCandidates(db, user).filter((row) => !hasDifferentProjectOrConditions(content, row.content));
  const revisions = eligible.map((row) => draftFingerprint(row.id, candidateRevision(row))).sort();
  const documentIds = [...new Set(eligible.map((row) => row.doc_id))];
  // Backfill can change the vector pool without changing a document's index version.
  const vectors = documentIds.length === 0 ? [] : db.prepare(`SELECT c.doc_id, c.id, e.dim, e.created_at
    FROM chunk_embeddings e JOIN doc_chunks c ON c.id=e.chunk_id
    WHERE e.model=? AND c.doc_id IN (SELECT value FROM json_each(?))
    ORDER BY c.doc_id,c.id`).all(model, JSON.stringify(documentIds));
  return { ids: new Set(eligible.map((row) => row.id)), revision: draftFingerprint(JSON.stringify(revisions), JSON.stringify(vectors)) };
}

export function currentCandidateRevision(db: Db, user: AuthUser, id: string): string | undefined {
  if (!hasPermission(user.role, 'knowledge.read')) return undefined;
  const row = db.prepare(activeCandidates + ' AND ke.id=?').get(id) as unknown as CandidateRow | undefined;
  return row === undefined ? undefined : candidateRevision(row);
}

export function discoveryEnabled(db: Db, owner: string): boolean {
  const row = db.prepare('SELECT enabled FROM knowledge_discovery_settings WHERE owner_id=?').get(owner);
  return row?.enabled !== 0;
}

export function setDiscoveryEnabled(db: Db, owner: string, enabled: boolean): void {
  db.prepare(`INSERT INTO knowledge_discovery_settings(owner_id, enabled) VALUES(?,?)
    ON CONFLICT(owner_id) DO UPDATE SET enabled=excluded.enabled`).run(owner, Number(enabled));
}

export function ignoreDiscovery(db: Db, owner: string, id: string): void {
  const result = db.prepare("UPDATE knowledge_discoveries SET status='ignored' WHERE id=? AND owner_id=?").run(id, owner);
  if (result.changes === 0) throw new AppError('not_found', '没有这条知识建议。');
}

function resolveAvailable(db: Db, user: AuthUser, source: Source) {
  try {
    return resolveDraftSource(db, user, source);
  } catch (error) {
    if (error instanceof AppError && error.httpStatus >= 400 && error.httpStatus < 500) return undefined;
    throw error;
  }
}

function storedSource(serialized: string): Source | undefined {
  try {
    const source = parseDraftSource(JSON.parse(serialized), undefined);
    return source.kind === 'manual' ? undefined : source;
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof AppError && error.code === 'invalid_argument')) return undefined;
    throw error;
  }
}

function currentOrigin(db: Db, user: AuthUser, row: DiscoveryRow, source: Source | undefined) {
  if (source === undefined) return undefined;
  const origin = resolveAvailable(db, user, source);
  return origin?.excerptVerification === 'matched' && origin.version === row.source_version &&
    discoveryFingerprint(origin.excerpt) === row.fingerprint ? origin : undefined;
}

export function recordDiscovery(db: Db, user: AuthUser, source: Source, now = new Date()): boolean {
  if (!hasPermission(user.role, 'knowledge.submit') || !hasPermission(user.role, 'knowledge.read') ||
      !discoveryEnabled(db, user.id)) return false;
  const origin = resolveAvailable(db, user, source);
  if (origin === undefined || origin.excerptVerification !== 'matched') return false;

  const fingerprint = discoveryFingerprint(origin.excerpt);
  const serialized = JSON.stringify(source);
  const existing = db.prepare(`SELECT id, source_json, source_version, fingerprint, status, created_at
    FROM knowledge_discoveries WHERE owner_id=? AND fingerprint=?`).get(user.id, fingerprint) as DiscoveryRow | undefined;
  if (existing?.status === 'ignored') return false;
  const prior = existing === undefined ? undefined : storedSource(existing.source_json);
  if (existing !== undefined && currentOrigin(db, user, existing, prior) !== undefined) return false;

  const visibleSince = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  // Reuse an unexpired pending slot after its source becomes invalid. This preserves
  // its original time budget, including metadata-only edits to the same note.
  if (existing !== undefined && existing.created_at > visibleSince) {
    const rebound = db.prepare(`UPDATE knowledge_discoveries SET source_json=?, source_version=?
      WHERE id=? AND owner_id=? AND status='pending' AND source_json=? AND source_version=? AND created_at=?
        AND COALESCE((SELECT enabled FROM knowledge_discovery_settings WHERE owner_id=?),1)=1`)
      .run(serialized, origin.version, existing.id, user.id, existing.source_json, existing.source_version,
        existing.created_at, user.id);
    return rebound.changes !== 0 && (prior?.kind !== source.kind || prior.id !== source.id);
  }

  // Expired invalid slots may be shown again with a new timestamp and the normal
  // cooldown and budget. A concurrent refresh or ignore wins over a stale observation.
  const result = db.prepare(`INSERT INTO knowledge_discoveries
      (id, owner_id, source_json, source_version, fingerprint, status, created_at)
    SELECT ?, ?, ?, ?, ?, 'pending', ?
    WHERE COALESCE((SELECT enabled FROM knowledge_discovery_settings WHERE owner_id=?),1)=1
      AND NOT EXISTS (SELECT 1 FROM knowledge_discoveries WHERE owner_id=? AND created_at>?)
      AND (SELECT count(*) FROM knowledge_discoveries WHERE owner_id=? AND created_at>?) < ?
    ON CONFLICT(owner_id,fingerprint) DO UPDATE SET
      source_json=excluded.source_json, source_version=excluded.source_version, created_at=excluded.created_at
    WHERE id=? AND status='pending' AND source_json=? AND source_version=? AND created_at=?`).run(
    randomUUID(), user.id, serialized, origin.version, fingerprint, now.toISOString(),
    user.id, user.id, new Date(now.getTime() - DISCOVERY_COOLDOWN_MS).toISOString(),
    user.id, new Date(now.getTime() - DAY_MS).toISOString(), DISCOVERY_DAILY_LIMIT,
    existing?.id ?? null, existing?.source_json ?? null, existing?.source_version ?? null, existing?.created_at ?? null,
  );
  return result.changes !== 0;
}

export function recordAskDiscovery(db: Db, user: AuthUser, id: string): boolean {
  const row = db.prepare(`SELECT answer_preview FROM ask_records WHERE run_id=? AND user_id=?
    AND outcome='ok' AND delivery_status='verified' AND citation_count>0 AND consent_confirmed=1`).get(id, user.id);
  const excerpt = row?.answer_preview;
  if (typeof excerpt !== 'string' || excerpt.trim().length < 24) return false;
  let source: KnowledgeDraftSource;
  try {
    source = parseDraftSource({ kind: 'ask', id, excerpt }, undefined);
  } catch (error) {
    if (error instanceof AppError && error.code === 'invalid_argument') return false;
    throw error;
  }
  return source.kind === 'ask' && recordDiscovery(db, user, source);
}

export function recordDocumentDiscovery(db: Db, user: AuthUser, id: string, chunkId: string, version: number): boolean {
  const row = db.prepare('SELECT 1 FROM documents WHERE id=? AND uploaded_by=?').get(id, user.id);
  return row !== undefined && recordDiscovery(db, user, { kind: 'document', id, chunkId, version: String(version) });
}

export function listDiscoveries(db: Db, user: AuthUser): KnowledgeDiscoveryResponse {
  const enabled = discoveryEnabled(db, user.id);
  if (!enabled || !hasPermission(user.role, 'knowledge.submit') || !hasPermission(user.role, 'knowledge.read')) {
    return { enabled, items: [] };
  }
  const rows = db.prepare(`SELECT id, source_json, source_version, fingerprint, created_at, status FROM knowledge_discoveries
    WHERE owner_id=? AND status='pending' AND created_at>?
    ORDER BY created_at DESC, id LIMIT ?`).all(user.id, new Date(Date.now() - 7 * DAY_MS).toISOString(),
      3 * DISCOVERY_PENDING_LIMIT) as unknown as DiscoveryRow[];
  const items: KnowledgeDiscoveryResponse['items'][number][] = [];
  for (const row of rows) {
    const source = storedSource(row.source_json);
    const origin = currentOrigin(db, user, row, source);
    if (source === undefined || origin === undefined) continue;
    items.push({ id: row.id, createdAt: row.created_at, source, excerpt: origin.excerpt.slice(0, 260),
      ...discoverMatch(db, user, origin.excerpt) });
    if (items.length === DISCOVERY_PENDING_LIMIT) break;
  }
  return { enabled, items };
}
