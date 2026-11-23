/**
 * `.xlsx` 四表识别（人员 / 论文 / 专利 / 大论文）。
 *
 * 【只做本地规则，不调模型】识别依据是表头与单元格内容；无法判断的值
 * 留空并标成待核实，不猜标题、身份、状态或日期。
 */
import ExcelJS from 'exceljs';
import { AppError } from '@knowpilot/shared';
import type { LedgerImportTarget, LedgerRowStatus } from '@knowpilot/shared';

export interface ParsedRow {
  sheetName: string;
  rowNo: number;
  target: LedgerImportTarget;
  raw: Record<string, string | null>;
  normalized: Record<string, string | null>;
  issues: string[];
  status: LedgerRowStatus;
}

type FieldAliases = Record<string, readonly string[]>;

const ALIASES: Record<LedgerImportTarget, FieldAliases> = {
  person: {
    name: ['姓名', '名字'],
    studentNo: ['学号', '学生学号'],
  },
  submission: {
    title: ['论文题目', '稿件标题', '题目'],
    algorithmAbbr: ['论文算法缩写', '算法缩写', '稿件简称'],
    journalName: ['投稿期刊', '期刊', '期刊名称'],
    journalAbbr: ['期刊缩写'],
    submitterName: ['投稿人', '负责人'],
    submittedOn: ['首次投稿时间', '投稿日期', '投稿时间'],
    status: ['状态', '当前状态'],
    statusSince: ['进入当前状态的时间', '进入当前状态的日期'],
    submissionNumber: ['投稿号', '稿件编号'],
  },
  patent: {
    name: ['专利名称', '名称'],
    patentNo: ['专利号'],
    applicantName: ['申请人'],
    firstSubmittedOn: ['首次提交时间', '提交时间', '申请日'],
    substantiveExamOn: ['实审时间', '实审日期'],
    publishedOn: ['公开时间', '公开日期'],
    grantedOn: ['授权日', '授权日期', '授权公告日'],
  },
  thesis: {
    authorName: ['姓名', '作者'],
    direction: ['研究方向'],
    title: ['题目', '论文题目'],
    grade: ['成绩'],
  },
};

const REQUIRED: Record<LedgerImportTarget, readonly string[]> = {
  person: ['name'],
  submission: ['title', 'status'],
  patent: ['name'],
  thesis: ['authorName'],
};

const STATUS_MAP: Record<string, string> = {
  准备中: 'preparing',
  未投: 'preparing',
  投稿: 'pending_initial',
  首次: 'pending_initial',
  待初审: 'pending_initial',
  审稿: 'under_review',
  外审: 'under_review',
  二审: 'revision_resubmitted',
  再审: 'revision_resubmitted',
  修回: 'revision_resubmitted',
  修回后再审: 'revision_resubmitted',
  录用: 'accepted_pending',
  待上线: 'accepted_pending',
  已录用: 'accepted_pending',
  发表: 'published',
  已发表: 'published',
  拒: 'rejected',
  被拒: 'rejected',
  拒稿: 'rejected',
  已拒稿: 'rejected',
  撤: 'withdrawn',
  撤稿: 'withdrawn',
  已撤稿: 'withdrawn',
};

function normHeader(value: string): string {
  return value.replace(/[\s　:：()（）]/gu, '').trim();
}

function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())}`;
  }
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' ? null : t;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return cellText(value.text);
    if ('richText' in value && Array.isArray(value.richText)) {
      return cellText(value.richText.map((r) => r.text).join(''));
    }
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if ('formula' in value) return null;
  }
  return null;
}

/**
 * 只接受四位年份的日期；Excel 序列号按 1899-12-30 起算。
 * `26.4.6` 这类两位年份明确标成待核实，不擅自补 20。
 */
function parseDate(raw: string | null, field: string, issues: string[]): string | null {
  if (raw === null) return null;
  const t = raw.trim();
  if (t === '' || t === '-' || t === '—' || t === '/') return null;
  if (/^\d+(\.\d+)?$/u.test(t)) {
    // Excel 序列号（1900 日期系统）。
    const serial = Number(t);
    if (Number.isFinite(serial) && serial > 20000 && serial < 80000) {
      const ms = Math.round((serial - 25569) * 86400_000);
      const d = new Date(ms);
      const p = (n: number): string => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    }
    issues.push(`${field}「${t}」看起来不是日期，保持为空`);
    return null;
  }
  if (/^\d{1,2}[./]\d{1,2}[./]\d{1,2}$/u.test(t)) {
    issues.push(`${field}「${t}」只有两位年份，需确认年份后手工填写`);
    return null;
  }
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u.exec(t);
  if (m === null) {
    issues.push(`${field}「${t}」不是可识别的日期，保持为空`);
    return null;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    issues.push(`${field}「${t}」不是真实存在的日期，保持为空`);
    return null;
  }
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function detectTarget(header: readonly string[]): { target: LedgerImportTarget; score: number } {
  const headers = new Set(header.map(normHeader));
  let best: { target: LedgerImportTarget; score: number } = { target: 'person', score: 0 };
  for (const target of Object.keys(ALIASES) as LedgerImportTarget[]) {
    let score = 0;
    for (const aliases of Object.values(ALIASES[target])) {
      if (aliases.some((a) => headers.has(normHeader(a)))) score += 1;
    }
    if (score > best.score) best = { target, score };
  }
  return best;
}

function headerMap(
  header: readonly string[],
  target: LedgerImportTarget,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const [field, aliases] of Object.entries(ALIASES[target])) {
    for (let i = 0; i < header.length; i += 1) {
      if (aliases.some((a) => normHeader(a) === normHeader(header[i] ?? ''))) {
        // 存 1 起的列号：后面直接用 raw[String(col)] 取单元格。
        map.set(field, i + 1);
        break;
      }
    }
  }
  return map;
}

export async function parseLedgerWorkbook(buffer: Buffer): Promise<ParsedRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  // 填写示例必须拒绝：它的结构看起来和真实表一样，不拦就会把虚构数据写进正式库。
  for (const ws of wb.worksheets) {
    if (ws.name.includes('示例说明')) {
      throw new AppError('invalid_argument', '这是填写示例，禁止导入正式台账。');
    }
    for (let r = 1; r <= Math.min(ws.rowCount, 5); r += 1) {
      const row = ws.getRow(r);
      let hit = false;
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = cellText(cell.value) ?? '';
        if (text.includes('禁止导入正式台账')) hit = true;
      });
      if (hit) {
        throw new AppError('invalid_argument', '这是填写示例，禁止导入正式台账。');
      }
    }
  }

  const rows: ParsedRow[] = [];

  for (const ws of wb.worksheets) {
    // 找表头：前 10 行里命中已知列名最多的一行。
    let headerRowNo = 0;
    let header: string[] = [];
    let target: LedgerImportTarget | null = null;
    let bestScore = 0;
    for (let r = 1; r <= Math.min(ws.rowCount, 10); r += 1) {
      const row = ws.getRow(r);
      // 按真实列号铺满，空表头也占位；否则后面的列号会整体左移。
      const values: string[] = new Array(ws.columnCount).fill('');
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        if (col <= ws.columnCount) values[col - 1] = cellText(cell.value) ?? '';
      });
      const detected = detectTarget(values);
      if (detected.score > bestScore) {
        bestScore = detected.score;
        headerRowNo = r;
        header = values;
        target = detected.target;
      }
    }
    if (target === null || bestScore < 2) continue;
    const map = headerMap(header, target);
    if (map.size === 0) continue;

    for (let r = headerRowNo + 1; r <= ws.rowCount; r += 1) {
      const row = ws.getRow(r);
      const raw: Record<string, string | null> = {};
      let nonEmpty = false;
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const text = cellText(cell.value);
        if (text === null) return;
        nonEmpty = true;
        raw[String(col)] = text;
      });
      if (!nonEmpty) continue;

      const normalized: Record<string, string | null> = {};
      const issues: string[] = [];
      for (const [field, col] of map) {
        const headerName = header[col - 1] ?? String(col);
        const value = raw[String(col)] ?? null;
        if (field.endsWith('On')) {
          normalized[field] = parseDate(value, headerName, issues);
        } else if (field === 'status') {
          const mapped = value === null ? null : STATUS_MAP[value.replace(/\s+/gu, '')];
          if (value !== null && mapped === undefined) {
            issues.push(`状态「${value}」无法自动对应到系统状态，保持待核实`);
          }
          normalized[field] = mapped ?? null;
        } else {
          normalized[field] = value;
        }
      }

      for (const field of REQUIRED[target]) {
        if (normalized[field] === null || normalized[field] === '') {
          issues.push(`缺少必填字段：${field}`);
        }
      }
      if (target === 'submission') {
        if (normalized['status'] === null) issues.push('缺少可识别的当前状态');
        if (normalized['submittedOn'] === null && normalized['status'] !== 'preparing') {
          issues.push('缺少首次投稿日期');
        }
      }
      if (target === 'patent') {
        const first = normalized['firstSubmittedOn'] ?? null;
        const exam = normalized['substantiveExamOn'] ?? null;
        const pub = normalized['publishedOn'] ?? null;
        const grant = normalized['grantedOn'] ?? null;
        if (first !== null && exam !== null && exam < first) {
          issues.push('实审时间早于首次提交时间，需复核');
        }
        if (first !== null && pub !== null && pub < first) {
          issues.push('公开时间早于首次提交时间，需复核');
        }
        if (grant !== null && ((first !== null && grant < first) || (pub !== null && grant < pub))) {
          issues.push('授权日期早于申请或公开日期，需复核');
        }
      }

      const invalid = REQUIRED[target].some(
        (f) => normalized[f] === null || normalized[f] === '',
      );
      rows.push({
        sheetName: ws.name,
        rowNo: r,
        target,
        raw,
        normalized,
        issues,
        status: invalid ? 'invalid' : issues.length > 0 ? 'needs_review' : 'ready',
      });
    }
  }

  return rows;
}
