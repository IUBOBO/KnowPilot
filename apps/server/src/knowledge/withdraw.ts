/**
 * 把一份知识文档从索引里撤下来：`supersede` 裁决的那一半动作。
 *
 * 【为什么必须物理删 `documents` 那一行，而不是把 status 标成别的】
 *   `search.ts` 的四条查询路径（关键词 / 语义 / 混合 / 计数）**只按 `d.material`
 *   过滤，从不看 `documents.status`**。也就是说文档只要还在表里，就一定会被检索到 ——
 *   "标个状态让它消失"在这套实现里根本不成立。而阶段 5 的一个前提是检索代码
 *   零改动，所以唯一的办法就是把行删掉。这个结论是核实过的，不是猜的。
 *
 * 【连带删掉的东西】靠既有外键级联，不需要在这里逐表删：
 *   `doc_chunks` → CASCADE → `chunk_embeddings` → CASCADE；
 *   FTS 索引由 `doc_chunks_ad` 触发器同步清理（见 migrations 里的三个触发器）。
 *   `knowledge_entries.document_id` 是 `ON DELETE SET NULL` —— 这一条**必须成立**，
 *   否则这条 DELETE 会被外键挡回来直接抛错。
 *
 * 【磁盘上那份原件故意留着】它按内容 sha256 命名，可能被别的条目共用
 *   （两条一字不差的知识只有一份文件，见 admit.ts 的查重）；而且它只是几十 KB 的
 *   markdown。为了删索引顺手删文件，风险远大于收益。
 */
import type { Db } from '../db/index.ts';
import { invalidateVectorCache } from '../documents/vector.ts';

/**
 * 删掉文档行并让向量缓存失效。返回实际删掉的行数（0 = 本来就不在）。
 *
 * 【为什么一定要 invalidateVectorCache】`documents/vector.ts` 里那份缓存是
 *   **进程内**的向量快照，检索时直接读它、不回库。不失效的话，这份文档的向量
 *   会继续在内存里参与排序，表现为"已经撤下的知识还搜得到"—— 而且刷新页面、
 *   重新搜都不管用，只有重启服务才会好。这类"只在长时间运行的进程里出现"的
 *   缺陷最难复现，所以在这里强制失效。
 */
export function withdrawDocument(db: Db, documentId: string): number {
  const result = db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
  invalidateVectorCache();
  return Number(result.changes);
}

/**
 * 有引用者就不删：撤一份文档前先确认除"自己"外没有别的**已生效**知识指着它。
 *
 * 【为什么简单的 `withdrawDocument` 不够 —— 一个真实的缺陷】
 *   两份**逐字节相同**的知识，在上传阶段会被 `content_hash` 去重成**同一份**
 *   `documents` 行（`admit.ts` 的 `duplicated: true` 分支）。于是：
 *   A、B 两条知识都 `active`、都指着同一个 `document_id`。此时撤 A —— 若直接
 *   `DELETE`，那份文档没了，**B 还活着但内容凭空搜不到**（`document_id` 被
 *   `ON DELETE SET NULL` 置空，B 却仍是 `active`，界面上看不出任何异常）。
 *   原先只有 `supersede` 分支会删文档，而它只挡了"新条与邻居是同一份文档"
 *   （`app.ts` 里那条 `neighbor.documentId !== admitted.documentId`），
 *   **挡不住第三个引用者**。撤回功能一上，这条路就成了日常路径，必须堵死。
 *
 * @param exceptEntryId 正在被撤回 / 取代的那一条自己；它不算"引用者"。
 * @returns 实际删掉的行数；0 表示"没删"（无此文档，或还有别的引用者）。
 */
export function withdrawDocumentIfUnreferenced(
  db: Db,
  documentId: string,
  exceptEntryId: string,
): number {
  const stillReferenced = db
    .prepare(
      `SELECT COUNT(*) AS n FROM knowledge_entries
        WHERE document_id = ? AND status = 'active' AND id <> ?`,
    )
    .get(documentId, exceptEntryId) as unknown as { n: number };
  if (stillReferenced.n > 0) return 0;
  return withdrawDocument(db, documentId);
}
