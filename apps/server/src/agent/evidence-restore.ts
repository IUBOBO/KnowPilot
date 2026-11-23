/**
 * 从检查点恢复**记录类**证据（S7/X1b）。
 *
 * 检查点里只留 `recordType + recordId + sourceVersion`，不存字段快照。
 * 恢复时按记录身份回表重读，再做两件事：
 *   1. **可见性重验**：台账记录重新走 `scopePredicate`（成员只能看自己的）；
 *      看不见 = 与不存在一样丢弃，不把"存在但无权"当成可恢复。
 *   2. **版本重验**：记录的 sourceVersion（台账/数据集的 updatedAt、
 *      期刊分区的「年+体系+维度」）与检查点不一致时丢弃 —— 这条记录在我们
 *      停下之后被改过，拿新状态冒充"上次取得的证据"会让旧结论失去依据。
 *
 * 丢弃数量由调用方计入 `resumeDropped`，并在续跑提示词里如实告诉模型。
 * 文档证据的恢复在 `ask-run.ts` 里按 chunkId+indexVersion 另走一条路径。
 */
import type { AuthUser, CitationField } from '@knowpilot/shared';
import type { RowScope } from '../auth/scope.ts';
import { checkAsset, probeRoots } from '../code/check.ts';
import { getCodeAsset } from '../code/repo.ts';
import type { Db } from '../db/index.ts';
import { getJournalById, getSubmissionFor, listRankings } from '../submissions/repo.ts';
import type { RecordEvidenceInput } from './evidence.ts';
import { rankingFields, rankingRecordId } from './journal-tool.ts';
import { assetFields, restoreLedgerEvidence, submissionFields } from './live-tools.ts';
import type { CheckpointRecordRef } from './task-store.ts';

export interface RecordRestoreResult {
  records: RecordEvidenceInput[];
  dropped: number;
}

export function resolveRecordEvidence(input: {
  db: Db;
  codeRoots: readonly string[];
  scope: RowScope;
  user?: AuthUser | null;
  refs: readonly CheckpointRecordRef[];
  queryTime: string;
}): RecordRestoreResult {
  const records: RecordEvidenceInput[] = [];
  let dropped = 0;

  // 数据集的"还在不在"要现场探一遍，与 probe_dataset 工具同一口径。
  // 根目录只探一次：同一批记录共享同一次磁盘状态。
  const roots = input.codeRoots.length > 0 ? probeRoots(input.codeRoots) : [];

  for (const ref of input.refs) {
    const restored = restoreOne(input, ref, roots);
    if (restored === null) {
      dropped += 1;
      continue;
    }
    records.push(restored);
  }

  return { records, dropped };
}

function restoreOne(
  input: { db: Db; scope: RowScope; queryTime: string; user?: AuthUser | null },
  ref: CheckpointRecordRef,
  roots: ReturnType<typeof probeRoots>,
): RecordEvidenceInput | null {
  if (ref.recordType === 'M-PATENT' || ref.recordType === 'M-THESIS' || ref.recordType === 'M-PERSON') {
    if (!input.user) return null;
    const record = restoreLedgerEvidence(input.db, input.user, ref.recordType, ref.recordId, input.queryTime);
    return record?.recordUpdatedAt === ref.sourceVersion ? record : null;
  }
  if (ref.recordType === 'M-SUBMIT') {
    // 可见性在 SQL 里重验：成员只能恢复自己的台账记录。
    const submission = getSubmissionFor(input.db, ref.recordId, input.scope);
    if (submission === null) return null;
    if (submission.updatedAt !== ref.sourceVersion) return null;
    return {
      recordType: 'M-SUBMIT',
      recordId: submission.id,
      recordTitle: submission.title,
      queryTime: input.queryTime,
      recordUpdatedAt: submission.updatedAt,
      fields: submissionFields(submission),
    };
  }

  if (ref.recordType === 'M-CODE') {
    const asset = getCodeAsset(input.db, ref.recordId);
    if (asset === null) return null;
    if (asset.updatedAt !== ref.sourceVersion) return null;
    return {
      recordType: 'M-CODE',
      recordId: asset.id,
      recordTitle: asset.name,
      queryTime: input.queryTime,
      recordUpdatedAt: asset.updatedAt,
      fields: assetFields(asset, checkAsset(asset.location, asset.host, roots)),
    };
  }

  if (ref.recordType === 'M-JOURNAL') {
    // recordId 形如 `journalId:year:system:category`；category 本身可能含冒号，
    // 所以前两段之后整段都归 category。
    const parts = ref.recordId.split(':');
    if (parts.length < 4) return null;
    const journalId = parts[0]!;
    const year = Number.parseInt(parts[1]!, 10);
    const system = parts[2]!;
    const category = parts.slice(3).join(':');
    if (!Number.isFinite(year)) return null;

    const journal = getJournalById(input.db, journalId);
    if (journal === null) return null;
    const ranking = listRankings(input.db, journalId, 200).find(
      (r) => r.year === year && r.system === system && r.category === category,
    );
    if (ranking === undefined) return null;

    const version =
      category === '' ? `${year} ${system}` : `${year} ${system} ${category}`;
    if (version !== ref.sourceVersion) return null;
    if (rankingRecordId(journalId, ranking) !== ref.recordId) return null;

    const fields: CitationField[] = rankingFields(ranking, journal.name);
    return {
      recordType: 'M-JOURNAL',
      recordId: ref.recordId,
      recordTitle: journal.name,
      queryTime: input.queryTime,
      recordUpdatedAt: null,
      version,
      fields,
    };
  }

  return null;
}
