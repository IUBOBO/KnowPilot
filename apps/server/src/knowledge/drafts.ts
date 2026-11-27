import { randomUUID } from 'node:crypto';
import {
  AppError, KNOWLEDGE_KINDS, KNOWLEDGE_MAX_INPUT_CHARS, hasPermission,
  type AuthUser, type CreateKnowledgeDraftsResponse, type KnowledgeDraftDetails,
  type ChunkContextResponse, type KnowledgeDraftOrigin, type KnowledgeEntry, type KnowledgeReviewSource,
} from '@knowpilot/shared';
import type { Db } from '../db/index.ts';
import { getChunkContext } from '../documents/repo.ts';
import { generateDrafts, type KnowledgeDeps } from './generate.ts';
import { draftFingerprint, parseDraftSource, readDraftText, resolveDraftSource, revalidateDraftOrigin } from './draft-source.ts';
import { findById, insertEntries, listByGroup, updateDraftContent } from './repo.ts';
import type { DraftInput } from './tools.ts';

const inFlight = new WeakMap<Db, Set<string>>();

function contention(): never {
  throw new AppError('invalid_argument', '此草稿正在处理。请刷新后重试。', { httpStatus: 409 });
}

function isBusy(db: Db, id: string): boolean {
  return inFlight.get(db)?.has(id) === true;
}

export async function withKnowledgeDraftMutation<T>(db: Db, id: string, work: () => Promise<T>): Promise<T> {
  if (isBusy(db, id)) return contention();
  const locks = inFlight.get(db) ?? new Set<string>();
  inFlight.set(db, locks);
  locks.add(id);
  try {
    return await work();
  } finally {
    locks.delete(id);
  }
}

function supportedText(excerpt: string, candidate: unknown, limit: number): string | undefined {
  const value = typeof candidate === 'string' ? candidate.trim() : '';
  return value.length > 0 && value.length <= limit && excerpt.includes(value) ? value : undefined;
}

function draftDetails(origin: KnowledgeDraftOrigin, draft: DraftInput): KnowledgeDraftDetails {
  const evidence = supportedText(origin.excerpt, draft.evidence, 400);
  const claim = evidence === undefined || origin.excerpt !== draft.content.trim() ? 'unclassified' :
    origin.kind === 'ask' || draft.claim === 'inference' ? 'inference' :
      draft.claim === 'literature' && origin.kind === 'document' ? 'literature' :
        draft.claim === 'experience' && origin.kind !== 'document' ? 'experience' : 'unclassified';
  const question = supportedText(origin.excerpt, draft.question, 400);
  const conclusion = supportedText(origin.excerpt, draft.conclusion, 400);
  const conditions = supportedText(origin.excerpt, draft.conditions, 400);
  const tags = Array.isArray(draft.tags) ? [...new Set(draft.tags.map((tag) =>
    supportedText(origin.excerpt, tag, 32)).filter((tag) => tag !== undefined))].slice(0, 8) : [];
  return {
    claim, ...(evidence === undefined ? {} : { evidence }), ...(question === undefined ? {} : { question }),
    ...(conclusion === undefined ? {} : { conclusion }), ...(conditions === undefined ? {} : { conditions }),
    ...(tags.length === 0 ? {} : { tags }),
  };
}

export async function createKnowledgeDrafts(
  deps: KnowledgeDeps,
  user: AuthUser,
  body: Record<string, unknown>,
  requestId?: string,
  generate = generateDrafts,
): Promise<CreateKnowledgeDraftsResponse> {
  if (!hasPermission(user.role, 'knowledge.submit')) throw new AppError('permission_denied', '当前账号无权生成知识草稿。');
  if (body.consentConfirmed !== true) throw new AppError('invalid_argument', '请先确认将本次素材发送至云端模型处理。');
  const origin = resolveDraftSource(deps.db, user, parseDraftSource(body.source, body.text));
  const groupId = 'draft-' + draftFingerprint(user.id, origin.kind, origin.id, origin.version,
    origin.kind === 'document' ? origin.chunkId : '',
    origin.kind === 'note' && origin.selection !== undefined ? JSON.stringify(origin.selection) : '', origin.excerpt);
  const current = () => ({
    groupId, entries: listByGroup(deps.db, groupId).filter((entry) => entry.createdById === user.id),
  });
  const existing = current();
  if (existing.entries.length > 0) return existing;
  return withKnowledgeDraftMutation(deps.db, groupId, async () => {
    const out = await generate(deps, {
      text: origin.excerpt, sourceKind: origin.kind, userId: user.id, ...(requestId === undefined ? {} : { requestId }),
    });
    revalidateDraftOrigin(deps.db, origin);
    const candidates = out.drafts.filter((draft) =>
      KNOWLEDGE_KINDS.includes(draft.kind) && draft.content.trim().length > 0 && draft.content.length <= KNOWLEDGE_MAX_INPUT_CHARS).slice(0, 12);
    if (candidates.length === 0) throw new AppError('invalid_argument', '没有生成可预览的草稿，请调整素材后重试。');
    insertEntries(deps.db, candidates.map((draft) => ({
      id: randomUUID(), kind: draft.kind, content: draft.content.trim(),
      sourceType: origin.kind === 'ask' ? 'conversation' : origin.kind === 'document' ? 'upload' : origin.kind,
      sourceId: origin.kind === 'ask' ? null : origin.id, sessionId: origin.kind === 'ask' ? origin.id : null,
      observedAt: origin.at, groupId, createdBy: user.id, note: {
        draftSource: origin, draftDetails: draftDetails(origin, draft), revision: 1, lifecycleVersion: 1,
      },
    })), true);
    return current();
  });
}

/** Recheck original ownership and source inside each admission transition. */
export function assertKnowledgeDraftSource(db: Db, entry: KnowledgeEntry): void {
  const origin = entry.note?.draftSource;
  if (origin === undefined) return;
  if (origin.by !== entry.createdById) throw new AppError('not_found', '无法读取草稿来源。');
  revalidateDraftOrigin(db, origin);
}

export function assertKnowledgeDraftReady(db: Db, entry: KnowledgeEntry): void {
  assertKnowledgeDraftSource(db, entry);
  if (entry.note?.draftSource !== undefined) {
    const current = findById(db, entry.id);
    if (current?.status !== entry.status || current.note?.revision !== entry.note.revision ||
        current.content !== entry.content || current.kind !== entry.kind) return contention();
  }
  if (entry.note?.draftDetails?.claim === 'unclassified') {
    throw new AppError('invalid_argument', '草稿依据不足。请先编辑，补充可确认的内容。');
  }
}

export function editKnowledgeDraft(db: Db, user: AuthUser, id: string, raw: Record<string, unknown>): KnowledgeEntry {
  const entry = findById(db, id);
  if (entry === null || entry.createdById !== user.id) throw new AppError('not_found', '没有这条知识草稿。');
  if (entry.status !== 'proposed' || isBusy(db, id)) return contention();
  assertKnowledgeDraftSource(db, entry);
  const revision = entry.note?.revision ?? 1;
  if (raw.revision !== revision) return contention();
  const content = readDraftText(raw.content);
  const kind = KNOWLEDGE_KINDS.find((option) => option === raw.kind);
  if (kind === undefined) throw new AppError('invalid_argument', '请选择有效的知识类型。');
  const note = {
    ...entry.note, revision: revision + 1,
    ...(content === entry.content ? {} : { draftDetails: { claim: 'edited' as const } }),
  };
  if (!updateDraftContent(db, { id, owner: user.id, revision, content, kind, note })) return contention();
  const saved = findById(db, id);
  if (saved === null) throw new AppError('internal', '无法读取修改后的草稿。');
  return saved;
}

/** Reviewers get a verification result for private sources, and a versioned reader only for visible documents. */
export function inspectReviewSource(db: Db, viewer: AuthUser, entry: KnowledgeEntry):
  { summary: KnowledgeReviewSource; context?: ChunkContextResponse } | undefined {
  const origin = entry.note?.draftSource;
  if (!hasPermission(viewer.role, 'knowledge.review') || origin === undefined ||
      (entry.status !== 'active' && (entry.status !== 'conflicted' || entry.note?.draftSubmitted !== true))) return undefined;
  const unavailable = { summary: { kind: origin.kind, verification: 'unavailable' } } as const;
  try {
    assertKnowledgeDraftSource(db, entry);
  } catch (error) {
    if (error instanceof AppError && error.httpStatus >= 400 && error.httpStatus < 500) return unavailable;
    throw error;
  }

  const summary: KnowledgeReviewSource = {
    kind: origin.kind,
    verification: origin.excerptVerification,
    capturedAt: origin.at,
    ...(origin.kind === 'note' || origin.kind === 'ask' ? { version: origin.version } : {}),
  };
  if (origin.kind !== 'document') return { summary };
  if (!hasPermission(viewer.role, 'knowledge.read')) return unavailable;
  const context = getChunkContext(db, origin.chunkId);
  if (context === null || context.archivedIndexVersion !== undefined || context.document.id !== origin.id ||
      context.sourceVersion === undefined) return unavailable;
  return {
    summary: { ...summary, version: context.sourceVersion, document: {
      title: context.document.title,
      locator: { kind: 'document', documentId: origin.id, chunkId: origin.chunkId, sourceVersion: context.sourceVersion },
    } },
    context,
  };
}

export function presentKnowledgeEntry(entry: KnowledgeEntry, viewer: AuthUser | null, db?: Db): KnowledgeEntry {
  if (entry.note?.draftSource === undefined) return entry;
  let sourceAvailable = true;
  try {
    if (db !== undefined) assertKnowledgeDraftSource(db, entry);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    sourceAvailable = false;
  }
  if (sourceAvailable && entry.createdById === viewer?.id) return entry;
  const { draftSource: _, draftDetails, lifecycle, reviewSubmission: _submission, ...remaining } = entry.note;
  const hideContent = !sourceAvailable && entry.status !== 'active';
  return {
    ...entry, sourceId: null, sessionId: null,
    ...(hideContent ? { title: '来源已失效', content: '草稿来源已撤回、更新或不可访问。' } : {}),
    note: {
      ...remaining,
      ...(lifecycle === undefined ? {} : { lifecycle: sourceAvailable ? lifecycle : { ...lifecycle, incomingContext: {} } }),
      ...(draftDetails === undefined ? {} : { draftDetails: { claim: draftDetails.claim } }),
    },
  };
}
