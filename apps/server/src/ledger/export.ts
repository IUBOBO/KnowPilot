/**
 * 台账模板 / 填写示例 / 真实数据导出（投稿台账信息优化 · 第五步）。
 *
 * 模板与示例是固定内容；真实数据由调用方按服务端可见范围先取好再传进来，
 * 这一层不再判断权限。工作簿里只有业务字段，不写任何系统内部 id。
 */
import ExcelJS from 'exceljs';
import {
  SUBMISSION_STATUS_LABELS,
  type LedgerImportTarget,
  type Patent,
  type Person,
  type Submission,
  type Thesis,
} from '@knowpilot/shared';

const SUBMISSION_HEADERS = [
  '论文题目','论文算法缩写','投稿期刊','期刊缩写','投稿人','首次投稿时间','状态','进入当前状态的时间','投稿号',
] as const;
const PATENT_HEADERS = ['专利名称','专利号','申请人','首次提交时间','实审时间','公开时间','授权日期'] as const;
const PERSON_HEADERS = ['姓名','学号'] as const;
const THESIS_HEADERS = ['姓名','研究方向','题目','成绩'] as const;

function styleSheet(ws: ExcelJS.Worksheet, headers: readonly string[]): void {
  ws.addRow([...headers]);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (let i = 1; i <= headers.length; i += 1) {
    ws.getColumn(i).width = Math.max(12, Math.min(36, headers[i - 1]?.length ?? 12));
  }
}

function addNotesSheet(wb: ExcelJS.Workbook): void {
  const ws = wb.addWorksheet('填写说明');
  ws.addRow(['KnowPilot 台账填写说明']);
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.addRow([]);
  ws.addRow(['1. 四张工作表按表头识别，请不要删掉表头行；列顺序可以调整。']);
  ws.addRow(['2. 日期写成 YYYY-MM-DD。两位年份（如 26.4.6）不会自动补年份，导入时会标待核实。']);
  ws.addRow(['3. 学号、专利号、投稿号按文本填写，保留前导零。']);
  ws.addRow(['4. 空白表示“未知/未提供”，不要用 0 或 - 冒充真实值。']);
  ws.addRow(['5. 上传后先进入草稿，逐行核实后再导入；本模板本身不包含任何数据。']);
  ws.getColumn(1).width = 90;
}

export async function buildTemplateWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  styleSheet(wb.addWorksheet('论文'), SUBMISSION_HEADERS);
  styleSheet(wb.addWorksheet('专利'), PATENT_HEADERS);
  styleSheet(wb.addWorksheet('个人信息'), PERSON_HEADERS);
  styleSheet(wb.addWorksheet('大论文题目'), THESIS_HEADERS);
  addNotesSheet(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function buildExampleWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const marker = wb.addWorksheet('示例说明');
  marker.addRow(['这是填写示例，禁止导入正式台账']);
  marker.addRow(['所有姓名、学号、专利号、题目和成绩均为虚构，仅用于说明格式。']);
  marker.addRow(['导入入口会识别本文件并拒绝写入正式库。']);
  marker.getRow(1).font = { bold: true, color: { argb: 'FFB00020' } };
  marker.getColumn(1).width = 90;

  const paper = wb.addWorksheet('论文');
  styleSheet(paper, SUBMISSION_HEADERS);
  paper.addRow(['示例遥感分割方法','DEMO-Net','示例期刊 A','DEMO-A','示例同学甲','2026-10-01','投稿','2026-10-08','DEMO-001']);

  const patent = wb.addWorksheet('专利');
  styleSheet(patent, PATENT_HEADERS);
  patent.addRow(['示例图像处理方法','DEMO-PATENT-001','示例同学乙','2026-09-01','2026-10-01','']);

  const person = wb.addWorksheet('个人信息');
  styleSheet(person, PERSON_HEADERS);
  person.addRow(['示例同学甲','DEMO-STUDENT-001']);

  const thesis = wb.addWorksheet('大论文题目');
  styleSheet(thesis, THESIS_HEADERS);
  thesis.addRow(['示例同学甲','示例研究方向','示例研究方向的方法与应用','']);

  addNotesSheet(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface ExportDataInput {
  submissions: readonly Submission[];
  patents: readonly Patent[];
  people: readonly Person[];
  theses: readonly Thesis[];
  /** 给人看的范围说明；按当前登录角色的读取权限生成。 */
  scopeLabel: string;
  keyword: string | null;
  now: Date;
  targets: readonly LedgerImportTarget[];
}

export interface ExportDataResult {
  buffer: Buffer;
  counts: Record<string, number>;
}

export async function buildDataWorkbook(input: ExportDataInput): Promise<ExportDataResult> {
  const wb = new ExcelJS.Workbook();
  const want = (t: LedgerImportTarget): boolean => input.targets.includes(t);
  const counts: Record<string, number> = {};

  if (want('submission')) {
    const ws = wb.addWorksheet('论文');
    styleSheet(ws, SUBMISSION_HEADERS);
    for (const s of input.submissions) {
      ws.addRow([
        s.title,
        s.algorithmAbbr ?? '',
        s.journal?.name ?? '',
        s.journal?.abbr ?? '',
        s.submitterName ?? '',
        s.submittedOn ?? '',
        SUBMISSION_STATUS_LABELS[s.status],
        s.statusSince ?? '',
        s.submissionNumber ?? '',
      ]);
    }
    counts['submission'] = input.submissions.length;
  }

  if (want('patent')) {
    const ws = wb.addWorksheet('专利');
    styleSheet(ws, PATENT_HEADERS);
    for (const p of input.patents) {
      ws.addRow([
        p.name,
        p.patentNo ?? '',
        p.applicantPersonName ?? p.applicantName ?? '',
        p.firstSubmittedOn ?? '',
        p.substantiveExamOn ?? '',
        p.publishedOn ?? '',
        p.grantedOn ?? '',
      ]);
    }
    counts['patent'] = input.patents.length;
  }

  if (want('person')) {
    const ws = wb.addWorksheet('个人信息');
    styleSheet(ws, PERSON_HEADERS);
    for (const p of input.people) {
      ws.addRow([p.name, p.studentNoVisible ? p.studentNo ?? '' : '']);
    }
    counts['person'] = input.people.length;
  }

  if (want('thesis')) {
    const ws = wb.addWorksheet('大论文题目');
    styleSheet(ws, THESIS_HEADERS);
    for (const t of input.theses) {
      ws.addRow([
        t.personName ?? t.authorName,
        t.direction ?? '',
        t.title ?? '',
        t.gradeVisible ? t.grade ?? '' : '',
      ]);
    }
    counts['thesis'] = input.theses.length;
  }

  const notes = wb.addWorksheet('导出说明');
  notes.addRow(['导出时间', input.now.toISOString()]);
  notes.addRow(['可见范围', input.scopeLabel]);
  notes.addRow(['搜索条件', input.keyword ?? '（无）']);
  notes.addRow(['说明', '论文表按当前投稿轮次导出；历史轮次请在系统内查看。']);
  notes.addRow(['说明', '学号向登录成员开放；成绩只导出导出人有权看到的值。']);
  notes.addRow(['说明', '空白表示未知/未提供，不要当成 0 或“无”。']);
  notes.getColumn(1).width = 16;
  notes.getColumn(2).width = 70;

  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), counts };
}
