/**
 * Excel 台账导入草稿（投稿台账信息优化 · 第四步）。
 *
 * 上传 `.xlsx` 只生成**草稿**：不写业务表。逐行展示识别结果与问题，
 * 由人确认后单行或批量导入。原文件与草稿只对上传者（管理员可看全部）可见。
 */

export const LEDGER_IMPORT_TARGETS = ['person', 'submission', 'patent', 'thesis'] as const;
export type LedgerImportTarget = (typeof LEDGER_IMPORT_TARGETS)[number];

export const LEDGER_TARGET_LABELS: Record<LedgerImportTarget, string> = {
  person: '人员',
  submission: '论文投稿',
  patent: '专利',
  thesis: '大论文',
};

export const LEDGER_ROW_STATUSES = [
  'ready',
  'needs_review',
  'duplicate',
  'invalid',
  'imported',
  'skipped',
] as const;
export type LedgerRowStatus = (typeof LEDGER_ROW_STATUSES)[number];

export const LEDGER_ROW_STATUS_LABELS: Record<LedgerRowStatus, string> = {
  ready: '可导入',
  needs_review: '待核实',
  duplicate: '疑似重复',
  invalid: '无效',
  imported: '已导入',
  skipped: '已跳过',
};

export interface LedgerImportRow {
  id: string;
  batchId: string;
  sheetName: string;
  /** Excel 原始行号（从 1 开始，含表头）。 */
  rowNo: number;
  target: LedgerImportTarget;
  /** 原始单元格文本，列名 → 值。 */
  raw: Record<string, string | null>;
  /** 规范化后的建议值；用户可修改。 */
  normalized: Record<string, string | null>;
  issues: readonly string[];
  status: LedgerRowStatus;
  targetId: string | null;
  resultMessage: string | null;
}

export interface LedgerImportBatch {
  id: string;
  fileName: string;
  status: 'draft' | 'imported' | 'discarded';
  total: number;
  counts: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

export interface ListLedgerBatchesResponse {
  items: readonly LedgerImportBatch[];
}

export interface LedgerBatchDetailResponse {
  batch: LedgerImportBatch;
  rows: readonly LedgerImportRow[];
}

export interface UploadLedgerBatchResponse {
  batch: LedgerImportBatch;
  rows: readonly LedgerImportRow[];
}

export interface UpdateLedgerRowRequest {
  normalized?: Record<string, string | null>;
  /** true = 跳过这一行；false/省略 = 恢复为可导入判断。 */
  skip?: boolean;
}

export interface UpdateLedgerRowResponse {
  row: LedgerImportRow;
  batch: LedgerImportBatch;
}

export interface ImportLedgerRowResponse {
  row: LedgerImportRow;
  batch: LedgerImportBatch;
}

/** 真实数据导出：按当前可见范围生成工作簿，并写审计。 */
export interface ExportLedgerRequest {
  keyword?: string;
  /** 省略 = 四类都导；顺序不影响结果。 */
  targets?: readonly LedgerImportTarget[];
}

export interface ImportReadyResponse {
  results: readonly {
    rowId: string;
    status: LedgerRowStatus;
    message: string;
    targetId: string | null;
  }[];
  batch: LedgerImportBatch;
}
