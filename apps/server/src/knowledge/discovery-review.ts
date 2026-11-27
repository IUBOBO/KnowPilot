import {
  AppError, hasPermission, type AuthUser, type KnowledgeEntry, type KnowledgeLifecycleReview, type KnowledgeNote,
} from '@knowpilot/shared';
import { findUserById } from '../auth/users.ts';
import { embeddingModelKey, type AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { admitEntry } from './admit.ts';
import { detectConflict, type ConflictCheck } from './conflict.ts';
import { DISCOVERY_SIMILARITY_THRESHOLD } from './discovery-classifier.ts';
import { currentCandidateRevision, discoverMatch, vectorCandidates } from './discovery.ts';
import { readDraftText } from './draft-source.ts';
import { assertKnowledgeDraftReady } from './drafts.ts';
import { findById, markSuperseded } from './repo.ts';
import { withdrawDocumentIfUnreferenced } from './withdraw.ts';

function classifyDraftForPublication(db: Db, user: AuthUser, entry: KnowledgeEntry) {
  const match = discoverMatch(db, user, entry.content);
  if (match.kind === 'duplicate') {
    throw new AppError('invalid_argument', '已有完全重复的正式知识。可忽略或驳回本草稿。', { httpStatus: 409 });
  }
  if (match.kind === 'insufficient') {
    throw new AppError('invalid_argument', '缺少明确依据，或条件、版本等字段不明确。请补充后再确认。', { httpStatus: 409 });
  }
  if (match.neighbor === null || (match.kind !== 'supplement' && match.kind !== 'version' && match.kind !== 'conflict')) {
    return undefined;
  }
  const current = findById(db, match.neighbor.id);
  if (current === null) return undefined;

  const lifecycle: KnowledgeLifecycleReview = {
    kind: match.kind, targetId: match.neighbor.id, targetRevision: match.neighbor.revision,
    targetContext: match.neighbor.context, incomingContext: match.context, mode: 'pending',
  };
  return {
    check: { kind: 'conflict', conflict: {
      score: match.score, threshold: DISCOVERY_SIMILARITY_THRESHOLD, model: 'local-terms-v1',
      neighborEntryId: current.id, neighborDocumentId: current.documentId, neighborExcerpt: match.neighbor.excerpt,
    }} satisfies ConflictCheck,
    lifecycle,
  };
}

interface VectorRevision {
  model: string;
  revision: string;
}

export async function checkDraftPublication(
  db: Db, config: AppConfig, user: AuthUser, entry: KnowledgeEntry, checkVectors = detectConflict,
): Promise<{ check: ConflictCheck; lifecycle?: KnowledgeLifecycleReview | undefined; vectorRevision?: VectorRevision }> {
  if (entry.note?.lifecycleVersion !== 1) return { check: await checkVectors(db, config, entry) };

  const proposal = classifyDraftForPublication(db, user, entry);
  if (proposal !== undefined) return proposal;

  const model = embeddingModelKey(config);
  const eligible = vectorCandidates(db, user, entry.content, model);
  const check = await checkVectors(db, config, entry, (id) => eligible.ids.has(id));
  if (check.kind === 'conflict') {
    throw new AppError('invalid_argument', '与正式知识相似但缺少可核对的依据、条件或版本。请补充后再确认。', { httpStatus: 409 });
  }
  // Keep the observations made before fallback even when embedding is unavailable.
  return { check, vectorRevision: { model, revision: eligible.revision } };
}

export function assertStillDirectPublication(db: Db, user: AuthUser, entry: KnowledgeEntry, vectorRevision?: VectorRevision): void {
  assertKnowledgeDraftReady(db, entry);
  if (entry.note?.lifecycleVersion !== 1) return;
  if (classifyDraftForPublication(db, user, entry) !== undefined ||
      (vectorRevision !== undefined &&
        vectorCandidates(db, user, entry.content, vectorRevision.model).revision !== vectorRevision.revision)) {
    throw new AppError('invalid_argument', '正式知识在处理期间发生变化，请重试确认。', { httpStatus: 409 });
  }
}

export async function resolveLifecycle(
  db: Db, config: AppConfig, user: AuthUser, entry: KnowledgeEntry,
  lifecycle: KnowledgeLifecycleReview, resolution: 'merge' | 'supersede' | 'admit', rawContent: unknown, now: string,
): Promise<string | null> {
  if (!hasPermission(user.role, 'knowledge.review')) throw new AppError('permission_denied', '需要知识审核权限。');
  const updatedContent = resolution === 'merge' ? readDraftText(rawContent) : entry.content;
  if (resolution === 'merge' && updatedContent === entry.content.trim()) {
    throw new AppError('invalid_argument', '请提供需要发布的完整合并内容。');
  }
  const revalidate = () => {
    assertKnowledgeDraftReady(db, entry);
    const reviewer = findUserById(db, user.id);
    if (reviewer === undefined || reviewer.status !== 'active' || !hasPermission(reviewer.role, 'knowledge.review')) {
      throw new AppError('permission_denied', '当前账号已不能审核知识。');
    }
    if (currentCandidateRevision(db, user, lifecycle.targetId) !== lifecycle.targetRevision) {
      throw new AppError('invalid_argument', '对照知识已经变化。请先驳回当前稿，由作者重新提交以便比对。', { httpStatus: 409 });
    }
    if (discoverMatch(db, user, updatedContent).kind === 'duplicate') {
      throw new AppError('invalid_argument', '审核正文与已有正式知识完全重复。', { httpStatus: 409 });
    }
  };
  revalidate();
  const target = findById(db, lifecycle.targetId)!;
  const replacing = resolution !== 'admit';
  const supersededEntryId = replacing ? target.id : null;
  const note: KnowledgeNote = {
    ...entry.note,
    ...(resolution === 'merge' ? {
      revision: (entry.note?.revision ?? 1) + 1,
      reviewSubmission: {
        revision: entry.note?.revision ?? 1, content: entry.content,
        ...(entry.note?.draftDetails === undefined ? {} : { details: entry.note.draftDetails }),
      },
      draftDetails: { claim: 'reviewed_merge' },
    } : {}),
    lifecycle: { ...lifecycle, mode: resolution === 'supersede' ? 'update' : resolution },
    resolution: { kind: resolution, by: user.id, at: now, ...(replacing ? { supersededEntryId: target.id } : {}) },
  };
  await admitEntry(db, config, {
    entry: { ...entry, content: updatedContent, note },
    actor: { id: user.id },
    note,
    revalidate,
    onPublished: () => {
      if (resolution === 'merge') db.prepare("UPDATE knowledge_entries SET content=? WHERE id=? AND status='active'")
        .run(updatedContent, entry.id);
      if (replacing) {
        if (target.documentId !== null) withdrawDocumentIfUnreferenced(db, target.documentId, target.id);
        markSuperseded(db, target.id, {
          ...target.note, replacement: { kind: resolution, by: user.id, at: now, entryId: entry.id },
        });
      }
    },
  });
  return supersededEntryId;
}
