import type { ReactNode } from 'react';
import {
  INDEX_VERSION,
  MATERIAL_LABELS,
  type DocumentSummary,
} from '@knowpilot/shared';
import { EmptyState } from './EmptyState.tsx';
import { FileTypeIcon } from './FileTypeIcon.tsx';
import { describeDocumentParsing } from '../document-parsing.ts';
import { DocumentParsingNotice } from './DocumentParsingNotice.tsx';

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? n : n.toFixed(1)} ${UNITS[unit]}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

/** 向量数等于块数才算齐；少于就标黄，提醒可以补齐。 */
function vecClass(doc: DocumentSummary): string {
  return doc.embeddedChunkCount >= doc.chunkCount ? 'dim' : 'vec-missing';
}

/**
 * 这份文档的块是旧版流水线切的。
 *
 * 这类文档**仍然搜得到**，只是切法过时 —— 所以它不能显示成错误（红），
 * 也不能不显示（那就没人会发现）。用 warn 黄，与"向量缺一部分"同一档：
 * 都是"能用，但不如它本该有的样子"。
 */
export function isStale(doc: DocumentSummary): boolean {
  return doc.indexVersion < INDEX_VERSION;
}

/** 文档列表把检索状态和重点提醒放在行内，解析详情按需展开。 */
export function DocumentTable({
  items,
  busy,
  canReindex,
  onReindex,
  emptyAction = null,
}: {
  items: readonly DocumentSummary[];
  /**
   * 有重建任务在跑。跑的时候【所有】按钮都禁掉，而不只是正在跑的那一行 ——
   * 批量重建是连着调很多份，期间再点任何一份都会让两批交错，
   * 之后"还剩几份没重建"就说不清了。
   */
  busy: boolean;
  /**
   * 能不能重建（`material.manage`）。
   *
   * 【为什么由调用方传进来，而不是这里自己读 useAuth】这张表是纯展示组件 ——
   *   它不知道也不该知道"谁在用什么权限看它"。权限是页面的事，表格只负责
   *   把给它的东西画出来。顺带：不显示按钮时**整列去掉**，而不是留一列空白，
   *   否则每一行右边都挂着一个看起来坏掉的位置。
   */
  canReindex: boolean;
  onReindex: (id: string) => void;
  /**
   * 空态里的「下一步」。由调用方给 —— 上传入口在页面弹窗里，
   * 表格不需要知道如何打开它（同 canReindex 的理由：表格只负责展示）。
   */
  emptyAction?: ReactNode;
}) {
  if (items.length === 0) {
    return (
      <EmptyState icon="docs" illustration="no-documents" action={emptyAction}>
        知识库还是空的。上传一份 PDF、DOCX、MD 或 TXT，解析建索引后就能用于检索与问答。
      </EmptyState>
    );
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th>标题</th>
          <th style={{ width: 96 }}>材料</th>
          <th style={{ width: 84 }}>状态</th>
          <th style={{ width: 104 }}>块数 / 向量</th>
          <th style={{ width: 84 }}>大小</th>
          {/* 上传者：历史数据（`uploaded_by` 为 NULL）显示「未记录」而不是留白 ——
              "没有记录"与"没有人传"是两件事，留白会被读成后者。 */}
          <th style={{ width: 96 }}>上传者</th>
          <th style={{ width: 156 }}>上传时间</th>
          {canReindex && <th style={{ width: 72 }}>操作</th>}
        </tr>
      </thead>
      <tbody>
        {items.map((doc) => <DocumentRow key={doc.id} doc={doc} busy={busy} canReindex={canReindex} onReindex={onReindex} />)}
      </tbody>
    </table>
  );
}

function DocumentRow({ doc, busy, canReindex, onReindex }: {
  doc: DocumentSummary;
  busy: boolean;
  canReindex: boolean;
  onReindex: (id: string) => void;
}) {
  const parsing = describeDocumentParsing(doc);
  return (
    <tr id={`document-${doc.id}`}>
      <td>
        <div className="doc-title-row">
          <FileTypeIcon fileName={doc.fileName} title={doc.title} />
          <div className="doc-title">{doc.title}</div>
        </div>
        {doc.fileName !== null && doc.fileName !== doc.title && (
          <div className="dim mono" style={{ fontSize: '0.71875rem' }}>{doc.fileName}</div>
        )}
        <DocumentParsingNotice parsing={parsing} compact={!doc.ingestNote} />
      </td>
      <td>
        {MATERIAL_LABELS[doc.material]}
        {/* 知识确认入库时也会物化成一份 material='knowledge' 的文档，
            与用户**自己上传**的知识点文档在列表里长得一模一样。不标出来的话，
            两种来源就分不清了（一个能撤回、一个不能）。 */}
        {doc.knowledgeEntryId !== null && (
          <div style={{ marginTop: 6 }}>
            <span className="pill" title="由知识沉淀确认后生成，不是直接上传的材料">
              知识沉淀
            </span>
          </div>
        )}
      </td>
      <td>
        <span className={`pill ${parsing.status === '已就绪' ? 'ok' : parsing.tone}`}>{parsing.status}</span>
        {isStale(doc) && (
          <div style={{ marginTop: 6 }}>
            <span className="pill warn">需重建</span>
          </div>
        )}
      </td>
      <td className="mono">
        {doc.chunkCount}
        {doc.chunkCount > 0 && (
          // 向量数单独列出来：它少于块数就意味着这份文档的语义检索
          // 只覆盖了一部分，表现为"明明在库里，语义却搜不到"。
          // 两个数字并排，这种缺口一眼可见。
          <span className={vecClass(doc)}> / {doc.embeddedChunkCount}</span>
        )}
      </td>
      <td className="mono">{formatBytes(doc.byteSize)}</td>
      <td className="record-person-value">{doc.uploadedByName ?? <span className="dim">未记录</span>}</td>
      <td className="mono record-date-value">{formatTime(doc.createdAt)}</td>
      {canReindex && (
        <td>
          {/* 按钮对每一份都显示、不等"过时"才出现（只有过时的才给按钮的话，
              用户会以为这是某种异常处理入口）。过时的行有黄色标记指路，
              想主动重切某一份时也不用先想办法把它标成过时。 */}
          <button
            type="button"
            className="link-btn"
            disabled={busy}
            title={`按当前的解析与切块策略（v${INDEX_VERSION}）重新切一遍这份文档`}
            onClick={() => onReindex(doc.id)}
          >
            重建
          </button>
        </td>
      )}
    </tr>
  );
}
