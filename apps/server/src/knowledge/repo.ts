/**
 * knowledge_entries 表的读写。数据库列名 snake_case，对外契约 camelCase，
 * 转换只在这一个文件里发生（与 documents/repo.ts 同一条纪律）。
 *
 * 【本文件不含业务】这里只有"把行读出来 / 把值写进去"。冲突检测、确认入库、
 *   权限裁决全在上层（conflict.ts / admit.ts / 路由 handler）—— 与
 *   admin/repo.ts「算范围的人一个地方，用范围的人各自一处」是同一条分工。
 */
import type { KnowledgeEntry, KnowledgeKind, KnowledgeNote, KnowledgeSourceType, KnowledgeStatus } from '@knowpilot/shared';
import { knowledgeTitle } from '@knowpilot/shared';
import type { Db } from '../db/index.ts';
import type { RowScope } from '../auth/scope.ts';
import { scopePredicate } from '../auth/scope.ts';

/** 库里的一行。`created_by_name` 等两个名字列来自 LEFT JOIN users。 */
interface KnowledgeRow {
  id: string;
  kind: string;
  status: string;
  content: string;
  source_type: string;
  source_id: string | null;
  session_id: string | null;
  observed_at: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  group_id: string;
  created_by: string | null;
  document_id: string | null;
  note: string | null;
  created_by_name: string | null;
  confirmed_by_name: string | null;
  first_chunk_id: string | null;
}

/**
 * 选择列。两个显示名用 LEFT JOIN 取（created_by / confirmed_by 都可能为 NULL，
 * 用内连接会让这些行整条消失）；first_chunk_id 用相关子查询现算 —— 它只是
 * "给列表一个可点的跳转目标"，不落成列，免得文档重跑索引时要同步维护。
 */
const COLUMNS = `e.id, e.kind, e.status, e.content, e.source_type, e.source_id, e.session_id,
  e.observed_at, e.confirmed_by, e.confirmed_at, e.group_id, e.created_by,
  e.document_id, e.note,
  cu.display_name AS created_by_name,
  fu.display_name AS confirmed_by_name,
  (SELECT c.id FROM doc_chunks c WHERE c.doc_id = e.document_id ORDER BY c.ordinal LIMIT 1) AS first_chunk_id`;

const FROM = `FROM knowledge_entries e
  LEFT JOIN users cu ON cu.id = e.created_by
  LEFT JOIN users fu ON fu.id = e.confirmed_by`;

/**
 * 解析 `note` 列。坏 JSON 当 null 而不是抛错 —— 与 documents/repo.ts 的
 * parseSectionPath 同一个理由：这是"锦上添花"的说明，不值得为它让请求失败。
 */
function parseNote(raw: string | null): KnowledgeNote | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as KnowledgeNote;
  } catch {
    return null;
  }
}

function toEntry(row: KnowledgeRow): KnowledgeEntry {
  const kind = row.kind as KnowledgeKind;
  const note = parseNote(row.note);
  const conflict = note?.conflict;
  return {
    id: row.id,
    kind,
    status: row.status as KnowledgeStatus,
    content: row.content,
    title: knowledgeTitle(row.content, kind),
    sourceType: row.source_type as KnowledgeSourceType,
    sourceId: row.source_id,
    sessionId: row.session_id,
    observedAt: row.observed_at,
    groupId: row.group_id,
    createdById: row.created_by,
    createdByName: row.created_by_name,
    confirmedByName: row.confirmed_by_name,
    confirmedAt: row.confirmed_at,
    documentId: row.document_id,
    firstChunkId: row.first_chunk_id,
    note,
    // neighbor 是 note.conflict 的界面投影：只在真发生过冲突时有值。
    neighbor:
      conflict === undefined
        ? null
        : { entryId: conflict.neighborEntryId, excerpt: conflict.neighborExcerpt, score: conflict.score },
  };
}

/** 待落库的一条草案。 */
export interface NewEntry {
  id: string;
  kind: KnowledgeKind;
  content: string;
  sourceType: KnowledgeSourceType;
  sourceId: string | null;
  sessionId: string | null;
  observedAt: string;
  groupId: string;
  createdBy: string;
  note?: KnowledgeNote;
}

/**
 * 插入一组草案，**一个事务**。
 *
 * 【为什么整组要么全进要么全不进】半组草案在界面上没法解释：用户看到两条、
 *   少了第三条，却不知道少的那条是模型没产出还是写库失败。整组原子落库之后，
 *   "返回的是什么，库里就是什么"。
 */
export function insertEntries(db: Db, rows: readonly NewEntry[], reuseGroup = false): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO knowledge_entries
       (id, kind, status, content, source_type, source_id, session_id,
        observed_at, group_id, created_by, note)
     VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    if (reuseGroup && db.prepare('SELECT 1 FROM knowledge_entries WHERE group_id=? AND created_by=?')
      .get(rows[0]!.groupId, rows[0]!.createdBy) !== undefined) {
      db.exec('COMMIT');
      return;
    }
    for (const r of rows) {
      stmt.run(
        r.id,
        r.kind,
        r.content,
        r.sourceType,
        r.sourceId,
        r.sessionId,
        r.observedAt,
        r.groupId,
        r.createdBy,
        noteParam(r.note ?? null),
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function updateDraftContent(db: Db, args: {
  id: string; owner: string; revision: number; content: string; kind: KnowledgeKind; note: KnowledgeNote;
}): boolean {
  const { changes } = db.prepare(
    `UPDATE knowledge_entries SET content=?, kind=?, note=?
      WHERE id=? AND created_by=? AND status='proposed'
        AND COALESCE(CASE WHEN json_valid(note) THEN json_extract(note, '$.revision') END, 1)=?`,
  ).run(args.content,args.kind,noteParam(args.note),args.id,args.owner,args.revision);
  return changes === 1;
}

export function findById(db: Db, id: string): KnowledgeEntry | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} ${FROM} WHERE e.id = ?`)
    .get(id) as unknown as KnowledgeRow | undefined;
  return row === undefined ? null : toEntry(row);
}

/** 按批次号取一组（确认整组时用）。按观察时间升序，保持草案原始顺序。 */
export function listByGroup(db: Db, groupId: string): KnowledgeEntry[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} ${FROM} WHERE e.group_id = ? ORDER BY e.observed_at ASC, e.id ASC`)
    .all(groupId) as unknown as KnowledgeRow[];
  return rows.map(toEntry);
}

/**
 * 我看得到的条目。可见性**在 WHERE 里**过滤（见 auth/scope.ts 顶部）——
 * 先查再筛会让 LIMIT 变形（"限 200 条"变成"限 200 条之后剩下的"）。
 *
 * 【`canReview` 这一档：未确认的草案只对作者本人可见】
 *   光凭 `knowledgeScope` 不够 —— 它把"有 review 权限"直接当成"能读全部"，
 *   于是 `proposed` 草案会对审核者全量可见，而草案只是"模型拟出来、人还没决定
 *   要不要"的中间物，不是已提交的东西。审核者真正该看到的是**已提交**的东西
 *   （`conflicted` 是作者按过「确认整组」才产生的）。
 *   ⚠️ 收口**不能**写成 `(scope.sql OR (canReview AND …))`：canReadAll 一档让
 *   `scope.sql` 恒为真，OR 再收也收不住。所以这里把 scope 的 canReadAll **压成
 *   false**，只留"自己的 + 公共历史数据"这一支，再 OR 上"审核者可看的非草案"。
 *   `auth/scope.ts` 的 knowledgeScope 一个字不改 —— 它描述的仍是"能读全部"，
 *   收口发生在知识模块自己的查询里，离这条业务规则更近。
 *
 * 【已知边界，不为知识单独破例】`scopePredicate` 里有一条
 *   `created_by IS NULL → 放行`（公共历史数据没有归属，对所有人可见）。
 *   于是由脚本/历史数据造出的、`created_by` 为 NULL 的 `proposed` 行仍对所有人
 *   可见 —— 但真实草案一定带 `created_by`，这条缝只对着测试数据，不额外处理。
 *
 * 可选 `status` 过滤同样放进 SQL，理由同上。
 */
export function listVisible(
  db: Db,
  limit: number,
  scope: RowScope,
  status: KnowledgeStatus | undefined,
  canReview: boolean,
): KnowledgeEntry[] {
  // canReadAll 只描述"这个人的范围"，不该在这里直接放行 —— 见上面的说明。
  const own = scopePredicate('created_by', { ...scope, canReadAll: false });
  // 参数顺序 = SQL 里占位符出现的顺序：own 的几个 → canReview 的 → status 的 → limit。
  const clauses = [`(${own.sql} OR (? = 1 AND e.status <> 'proposed' AND (
    CASE WHEN json_valid(e.note) THEN json_type(e.note, '$.draftSource') IS NULL
      OR json_extract(e.note, '$.draftSubmitted') = 1 ELSE 1 END
  )))`];
  const params: (string | number | null)[] = [...own.params, canReview ? 1 : 0];
  if (status !== undefined) {
    clauses.push('e.status = ?');
    params.push(status);
  }
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} ${FROM}
        WHERE ${clauses.join(' AND ')}
        ORDER BY e.observed_at DESC LIMIT ?`,
    )
    .all(...params, limit) as unknown as KnowledgeRow[];
  return rows.map(toEntry);
}

/**
 * 审核队列：**只列全组人的冲突条目**。
 *
 * 【为什么这里不走 scopePredicate】这一条路由的闸门是 `knowledge.review`
 *   （只有 admin / mentor 能进来），所以"所有条目都该看到"是路由层已经保证的
 *   事实，不需要再按归属筛。
 * 【为什么不再含 proposed】未确认的草案是作者**还没提交**的东西，把它摊给审核者
 *   等于替作者做决定 —— 收口后本队列是一条真正的"待我裁决"的队列：`conflicted`
 *   是作者按过「确认整组」、撞上已有知识才产生的，属于已提交，必须由审核者消化。
 *   于是排序也简单了：只剩一种状态，按观察时间先来先到。
 */
export function listReviewQueue(db: Db, limit: number): KnowledgeEntry[] {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} ${FROM}
        WHERE e.status = 'conflicted'
        ORDER BY e.observed_at ASC LIMIT ?`,
    )
    .all(limit) as unknown as KnowledgeRow[];
  return rows.map(toEntry);
}

/** note 序列化：null 就写 NULL，否则 JSON 字符串。 */
function noteParam(note: KnowledgeNote | null): string | null {
  return note === null ? null : JSON.stringify(note);
}

/** 确认通过：落 active、记确认人与时刻、指向索引里那份文档。 */
export function markActive(
  db: Db,
  args: {
    id: string;
    confirmedBy: string;
    confirmedAt: string;
    documentId: string;
    note: KnowledgeNote | null;
  },
): void {
  db.prepare(
    `UPDATE knowledge_entries
        SET status = 'active', confirmed_by = ?, confirmed_at = ?, document_id = ?, note = ?
      WHERE id = ?`,
  ).run(args.confirmedBy, args.confirmedAt, args.documentId, noteParam(submittedNote(args.note)), args.id);
}

function submittedNote(note: KnowledgeNote | null): KnowledgeNote | null {
  return note?.draftSource === undefined ? note : { ...note, draftSubmitted: true };
}

/** 确认时判定冲突：落 conflicted，note 里带上撞上的对象与分数。 */
export function markConflicted(db: Db, id: string, note: KnowledgeNote): void {
  db.prepare(`UPDATE knowledge_entries SET status = 'conflicted', note = ? WHERE id = ?`).run(
    noteParam(submittedNote(note)),
    id,
  );
}

/** 驳回：落 deleted（终态），note 里记原因。 */
export function markRejected(db: Db, id: string, note: KnowledgeNote | null): void {
  db.prepare(`UPDATE knowledge_entries SET status = 'deleted', note = ? WHERE id = ?`).run(
    noteParam(note),
    id,
  );
}

/** 被取代：落 superseded（终态）。旧文档的撤下由上层另行处理。 */
export function markSuperseded(db: Db, id: string, note: KnowledgeNote | null): void {
  db.prepare(`UPDATE knowledge_entries SET status = 'superseded', note = ? WHERE id = ?`).run(
    noteParam(note),
    id,
  );
}

/**
 * 撤回：落 withdrawn（终态），note 里记是谁、何时、为什么撤的。
 *
 * 与 `markSuperseded` 的区别只在状态名 —— 索引里那份文档的撤下由上层用
 * `withdrawDocumentIfUnreferenced` 处理（先撤索引、再改状态，见 app.ts 的撤回 handler）。
 */
export function markWithdrawn(db: Db, id: string, note: KnowledgeNote | null): void {
  db.prepare(`UPDATE knowledge_entries SET status = 'withdrawn', note = ? WHERE id = ?`).run(
    noteParam(note),
    id,
  );
}

/**
 * 重新提交：把一条已驳回 / 已撤回的知识，作为**一条新草案**插回来。
 *
 * 【为什么是插一条新行，而不是把原行改回 proposed】
 *   原行是 `deleted` / `withdrawn` 的留痕 —— "这条被谁驳回过 / 谁撤回过"是唯一
 *   记录这件事的地方（见知识状态机的说明）。在原行上原地复活会把它抹掉。
 * 【为什么给新 group_id】`group_id` 的语义是"一次输入产出的草案批次"（v17 迁移
 *   注释里写明的），重新提交是一次新的提交动作，理应落在新批次里；顺带避免
 *   "老批次里混着已驳回和待确认"这种语义混乱。调用方负责生成新 id 与新批次号。
 */
export function insertResubmission(
  db: Db,
  args: {
    id: string;
    kind: KnowledgeKind;
    content: string;
    observedAt: string;
    groupId: string;
    createdBy: string;
    /** 保留原条目的来源与审阅信息，重新提交仍需独立确认。 */
    sourceEntryId: string;
    source?: KnowledgeEntry;
  },
): void {
  db.prepare(
    `INSERT INTO knowledge_entries
       (id, kind, status, content, source_type, source_id, session_id,
        observed_at, group_id, created_by, note)
     VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.id,
    args.kind,
    args.content,
    args.source?.sourceType ?? 'conversation',
    args.source?.sourceId ?? null,
    args.source?.sessionId ?? null,
    args.observedAt,
    args.groupId,
    args.createdBy,
    JSON.stringify({
      ...(args.source?.note?.draftSource === undefined ? {} : { draftSource: args.source.note.draftSource }),
      ...(args.source?.note?.draftDetails === undefined ? {} : { draftDetails: args.source.note.draftDetails }),
      revision: 1, resubmittedFrom: args.sourceEntryId,
    }),
  );
}

/** 一行已生效知识的向量，供冲突检测比对。 */
export interface ActiveVectorRow {
  /** BLOB，用 embed.ts 的 blobToVec 解码。 */
  vec: Uint8Array;
  dim: number;
  /** 该块的正文（取摘录用）。 */
  text: string;
  docId: string;
  entryId: string;
}

/**
 * 取"由知识条目沉淀出来的"已生效文档的所有块向量。
 *
 * 【为什么只跟 knowledge_entries 关联、不跟全部 material='knowledge' 的文档比】
 *   ① 冲突的裁决对象必须是一条 `knowledge_entry`（`supersede` 要把它标成
 *      superseded），用户自己上传的知识点文档没有对应条目，撞上了也无从裁决；
 *   ② 更要命的是反向后果：若拿全部 knowledge 文档比对，`supersede` 会去删
 *      **用户自己上传**的知识点文档 —— 那是别人的材料，一次裁决顺手删掉，
 *      绝对不能做。所以这里用 JOIN 收口到"有对应条目的文档"。
 */
export function activeKnowledgeVectors(db: Db, model: string): ActiveVectorRow[] {
  const rows = db
    .prepare(
      `SELECT e.vec, e.dim, c.text, c.doc_id, ke.id AS entry_id
         FROM chunk_embeddings e
         JOIN doc_chunks c         ON c.id = e.chunk_id
         JOIN knowledge_entries ke ON ke.document_id = c.doc_id
        WHERE e.model = ? AND ke.status = 'active'`,
    )
    .all(model) as unknown as { vec: Uint8Array; dim: number; text: string; doc_id: string; entry_id: string }[];
  return rows.map((r) => ({
    vec: r.vec,
    dim: r.dim,
    text: r.text,
    docId: r.doc_id,
    entryId: r.entry_id,
  }));
}
