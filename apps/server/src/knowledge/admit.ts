/**
 * 确认一条草案 → 物化成一份真正的知识库文档 → 回写 `knowledge_entries`。
 *
 * 【这是整个阶段 5 唯一让知识进索引的地方】`proposed` 待在外面（GC-12），
 *   只有走完这里才会出现在 `documents` 里、才会被检索到。所以"未确认就搜不到"
 *   不是靠某处 if 拦出来的，而是**这条路径没有别的入口**这个事实。
 *
 * 【为什么复用 uploadDocument + ingestDocument 而不是自己写一套写库逻辑】
 *   自己拼 SQL 意味着要重新算 content_hash、重新决定落盘命名、重新切块、
 *   重新对准 `doc_chunks_fts` 的触发器 —— 每一处都能悄悄写错，而错了之后
 *   表现是"知识确认了但搜不到"，最难查。复用之后，确认进来的文档与用户上传的
 *   文档走**同一条**流水线，索引行为天然一致。
 */
import { createHash } from 'node:crypto';
import { embeddingModelKey, type AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { findById as findDocument } from '../documents/repo.ts';
import { ingestDocument } from '../documents/ingest.ts';
import { uploadDocument } from '../documents/upload.ts';
import type { IngestReport, KnowledgeEntry, KnowledgeNote } from '@knowpilot/shared';
import { knowledgeTitle } from '@knowpilot/shared';
import { renderKnowledgeMarkdown } from './markdown.ts';
import { markActive } from './repo.ts';

export interface AdmitActor {
  id: string;
}

export interface AdmitResult {
  documentId: string;
  /** true = 库里已有一份**一字不差**的文档，复用了它。 */
  duplicated: boolean;
  /** 本次是否真跑了索引。duplicated 且文档已就绪时为 false。 */
  ingested: boolean;
  ingest: IngestReport | null;
}

/**
 * 文件名。**只用于展示**（磁盘上那份叫 `<sha256>.md`，见 upload.ts），
 * 但仍要清掉路径分隔符与控制字符：`documents.file_name` 会原样显示在知识库列表里，
 * 一个带 `\` 或换行的名字会让列表看起来像坏了。
 */
function safeFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return `${cleaned === '' ? '知识条目' : cleaned}.md`;
}

/**
 * 一条草案入库。
 *
 * 【三步各自带事务，故意不合成一个大事务】upload / ingest / markActive 每一步
 *   自己就是原子的，但把三步圈在一起会把 embedding 计算也圈进事务里
 *   （`ingest.ts` 特意把它放在事务外，因为模型推理可能几秒到几十秒）。
 *   代价是进程崩在中间会留下"文档已索引、条目还 proposed"的中间态 ——
 *   这个态**再点一次确认就能自愈**（见下面对 duplicated 的处理）。
 */
export async function admitEntry(
  db: Db,
  cfg: AppConfig,
  args: { entry: KnowledgeEntry; actor: AdmitActor; note: KnowledgeNote | null },
): Promise<AdmitResult> {
  const { entry, actor } = args;
  const title = knowledgeTitle(entry.content, entry.kind);
  const markdown = renderKnowledgeMarkdown(entry);
  const file = new File([markdown], safeFileName(title), { type: 'text/markdown' });

  const up = await uploadDocument(db, cfg, {
    file,
    material: 'knowledge',
    title,
    uploadedBy: actor.id,
    // 确认这个动作本身就含"我知道它要进知识库"——与上传页勾选框同一条闸门，
    // 只是这里已经在人点「确认」时问过了。
    consentConfirmedBy: actor.id,
  });

  // 【为什么不能简单地 `if (!duplicated) ingest`】那会让上面那个中间态**永远卡住**：
  //   崩在 upload 与 ingest 之间时，文档行已存在但没切块，第二次确认会因
  //   duplicated 直接跳过索引，条目却标成 active —— 于是"确认成功但搜不到"。
  //   所以判据改成"这份文档此刻是不是就绪"，而不是"我这次是不是新建的"。
  //   真要跑的仍只有没就绪的那种，重复索引不会发生。
  const needsIngest = !up.duplicated || !isDocumentReady(db, cfg, up.documentId);
  const ingest = needsIngest ? await ingestDocument(db, cfg, up.documentId) : null;

  markActive(db, {
    id: entry.id,
    confirmedBy: actor.id,
    confirmedAt: new Date().toISOString(),
    documentId: up.documentId,
    note: args.note,
  });

  return { documentId: up.documentId, duplicated: up.duplicated, ingested: needsIngest, ingest };
}

/**
 * 这份文档是否已经切好块了。
 *
 * 【为什么看块数而不是看 status】`status='ready'` 与"有块"是两件事：解析成功但
 *   一个字都没切出来的文档也会是 ready（空文件、纯图无文字层的扫描件）。
 *   而我们要判的是"它现在能不能被搜到"，那取决于块，不取决于状态字段。
 */
function isDocumentReady(db: Db, cfg: AppConfig, documentId: string): boolean {
  const row = findDocument(db, documentId, embeddingModelKey(cfg));
  if (row === undefined) return false;
  const counted = db
    .prepare('SELECT COUNT(*) AS n FROM doc_chunks WHERE doc_id = ?')
    .get(documentId) as unknown as { n: number };
  return counted.n > 0;
}

/** 内容哈希，与 `upload.ts` 用同一个算法。留作核对入口（脚本里断言去重行为用）。 */
export function contentHashOf(markdown: string): string {
  return createHash('sha256').update(Buffer.from(markdown, 'utf8')).digest('hex');
}
