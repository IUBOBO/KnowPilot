/**
 * 首页「今日工作台」的聚合查询（O14）。
 *
 * 与各自列表页的口径刻意不同：
 *   · 超期只数 `patrol_tasks.status = 'open'` —— `dismissed` 是"看过、决定先不管"，
 *     它不是待办；把它算进来，用户会在首页看到一件自己已经处理过的事。
 *   · 草案只数 `created_by = 我 AND status = 'proposed'` —— 可见性规则在
 *     知识沉淀页收口，这里只回答"我这边还有几条没确认"。
 *   · 上传只数 `created_by = 我 AND status = 'pending'` —— `aborted` 是主动放弃，
 *     不该在首页继续催。
 *
 * 三项都**没有权限就不查**，返回 null 由界面说明原因；不要用 0 冒充。
 */
import type { MeKnowledgeSummary, MePendingSummary } from '@knowpilot/shared';
import type { Db } from '../db/index.ts';

export interface MePendingScope {
  canSubmitKnowledge: boolean;
  canUpload: boolean;
}

function count(db: Db, sql: string, ...params: readonly (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as unknown as { n: number };
  return row.n;
}

export function pendingForUser(db: Db, userId: string, scope: MePendingScope): MePendingSummary {
  return {
    overdueSubmissions: count(
      db,
      "SELECT COUNT(*) AS n FROM patrol_tasks WHERE owner_id = ? AND status = 'open'",
      userId,
    ),
    proposedKnowledge: scope.canSubmitKnowledge
      ? count(
          db,
          "SELECT COUNT(*) AS n FROM knowledge_entries WHERE created_by = ? AND status = 'proposed'",
          userId,
        )
      : null,
    unfinishedUploads: scope.canUpload
      ? count(
          db,
          "SELECT COUNT(*) AS n FROM upload_sessions WHERE created_by = ? AND status = 'pending'",
          userId,
        )
      : null,
  };
}

/**
 * 知识库概况。这是**全库共享**的一份统计，与"我上传了什么"无关。
 * `embedded` 按当前向量模型去重统计 —— 换模型后旧向量还在表里，
 * 不去重会把它们也算成"已覆盖"。
 */
export function knowledgeSummary(db: Db, model: string): MeKnowledgeSummary {
  return {
    documents: count(db, 'SELECT COUNT(*) AS n FROM documents'),
    chunks: count(db, 'SELECT COUNT(*) AS n FROM doc_chunks'),
    embedded: count(
      db,
      'SELECT COUNT(DISTINCT chunk_id) AS n FROM chunk_embeddings WHERE model = ?',
      model,
    ),
  };
}
