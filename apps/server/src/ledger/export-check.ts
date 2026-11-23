/**
 * 台账模板 / 示例 / 真实导出的零模型校验。
 *
 * 用法：npm run verify-ledger-export -w @knowpilot/server
 */
import ExcelJS from 'exceljs';
import { buildDataWorkbook, buildExampleWorkbook, buildTemplateWorkbook } from './export.ts';
import { parseLedgerWorkbook } from './parse.ts';
import { getSubmission, createSubmission } from '../submissions/repo.ts';
import { createPatent, listPatents } from '../patents/repo.ts';
import { insertThesis, getThesis, listTheses } from '../theses/repo.ts';
import { insertPerson, listPeople } from '../people/repo.ts';
import { openDb } from '../db/index.ts';
import { insertUser } from '../auth/users.ts';
import { hasPermission } from '@knowpilot/shared';

let failed = 0;
let total = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  total += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` —— ${detail}`}`);
  if (!ok) failed += 1;
};

async function load(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

const NOW = new Date('2026-10-21T08:00:00.000Z');
const { db } = openDb(':memory:');
const adminId = await insertUser(db, 'exp-admin', { password: 'exp-pw-1234', role: 'admin' }, NOW);
const mentorId = await insertUser(db, 'exp-mentor', { password: 'exp-pw-1234', role: 'mentor' }, NOW);
const memberId = await insertUser(db, 'exp-member', { password: 'exp-pw-1234', role: 'member' }, NOW);

const personA = insertPerson(
  db,
  { name: '导出同学甲', studentNo: '03001', groupId: null, status: 'active', userId: memberId, note: null, createdBy: adminId },
  NOW.toISOString(),
);
insertPerson(
  db,
  { name: '导出同学乙', studentNo: '03002', groupId: null, status: 'active', userId: null, note: null, createdBy: adminId },
  NOW.toISOString(),
);

const subA = createSubmission(
  db,
  {
    title: '导出论文 A', algorithmAbbr: 'EX-A', submitterName: '导出同学甲',
    journalName: '导出期刊 A', journalField: undefined,
    status: 'under_review', submittedAt: null, submittedOn: '2026-09-01',
    statusSince: '2026-09-02', submissionNumber: 'EX-001', notes: null, userId: memberId,
  },
  NOW.toISOString(),
).id;
const subB = createSubmission(
  db,
  {
    title: '导出论文 B', algorithmAbbr: null, submitterName: null,
    journalName: '导出期刊 B', journalField: undefined,
    status: 'published', submittedAt: null, submittedOn: '2026-08-01',
    statusSince: null, submissionNumber: null, notes: null, userId: adminId,
  },
  NOW.toISOString(),
).id;

createPatent(
  db,
  {
    name: '导出专利 A', patentNo: 'EX-PAT-001', applicantName: '导出同学甲',
    applicantPersonId: personA, firstSubmittedOn: '2026-09-01',
    substantiveExamOn: '2026-10-01', publishedOn: null, notes: null,
    ownerUserId: memberId, createdBy: memberId,
  },
  NOW.toISOString(),
);
createPatent(
  db,
  {
    name: '导出专利 B', patentNo: 'EX-PAT-002', applicantName: '导出同学乙',
    applicantPersonId: null, firstSubmittedOn: null,
    substantiveExamOn: null, publishedOn: null, notes: null,
    ownerUserId: mentorId, createdBy: mentorId,
  },
  NOW.toISOString(),
);

const thesisA = insertThesis(
  db,
  {
    personId: personA, authorName: '导出同学甲', direction: '遥感',
    title: '导出大论文 A', grade: 'EX-GRADE-1', notes: null, createdBy: adminId,
  },
  NOW.toISOString(),
);
insertThesis(
  db,
  {
    personId: null, authorName: '导出同学乙', direction: '医学影像',
    title: '导出大论文 B', grade: 'EX-GRADE-2', notes: null, createdBy: adminId,
  },
  NOW.toISOString(),
);

console.log('模板');
{
  const wb = await load(await buildTemplateWorkbook());
  check('模板有四张数据表 + 填写说明',
    ['论文','专利','个人信息','大论文题目','填写说明'].every((n) => wb.getWorksheet(n) !== undefined),
    wb.worksheets.map((w) => w.name).join(','));
  const paper = wb.getWorksheet('论文');
  check('论文表头是导师原表 9 列',
    (paper?.getRow(1).values as unknown[]).slice(1).join(',') ===
      '论文题目,论文算法缩写,投稿期刊,期刊缩写,投稿人,首次投稿时间,状态,进入当前状态的时间,投稿号');
  check('模板数据区为空', (paper?.rowCount ?? 0) === 1, String(paper?.rowCount));
}

console.log('填写示例');
{
  const buffer = await buildExampleWorkbook();
  const wb = await load(buffer);
  check('示例带「示例说明」工作表', wb.getWorksheet('示例说明') !== undefined);
  let rejected = false;
  let message = '';
  try {
    await parseLedgerWorkbook(buffer);
  } catch (err) {
    rejected = true;
    message = err instanceof Error ? err.message : String(err);
  }
  check('导入入口拒绝示例文件', rejected && message.includes('禁止导入'), message);
}

console.log('成员导出');
{
  const subs = [getSubmission(db, subA), getSubmission(db, subB)];
  if (subs.some((s) => s === null)) throw new Error('submission missing');
  const people = listPeople(db, { keyword: undefined, limit: 100 }, {
    userId: memberId, canReadSensitive: hasPermission('member', 'people.read.sensitive'), canManage: false,
  }).items;
  const patents = listPatents(db, { keyword: undefined, limit: 100 }, { userId: memberId, canReadAll: true });
  const theses = listTheses(db, { keyword: undefined, limit: 100 }, {
    userId: memberId, canReadGrade: hasPermission('member', 'thesis.read.grade'),
  }).items;
  const built = await buildDataWorkbook({
    submissions: subs.filter((s): s is NonNullable<typeof s> => s !== null),
    patents,
    people,
    theses,
    scopeLabel: '成员：人员与成果、投稿台账共享；学号与大论文成绩可见',
    keyword: null,
    now: NOW,
    targets: ['submission','patent','person','thesis'],
  });
  const wb = await load(built.buffer);
  const paperRows = wb.getWorksheet('论文')?.rowCount ?? 0;
  check('成员导出包含两篇共享论文', paperRows === 3, String(paperRows));
  check('专利表包含他人登记的专利', (wb.getWorksheet('专利')?.rowCount ?? 0) === 3);
  check('人员表包含两人', (wb.getWorksheet('个人信息')?.rowCount ?? 0) === 3);
  const personSheet = wb.getWorksheet('个人信息');
  const ownPersonRow = [2, 3].find((n) => personSheet?.getRow(n).getCell(1).value === '导出同学甲');
  const otherPersonRow = [2, 3].find((n) => personSheet?.getRow(n).getCell(1).value === '导出同学乙');
  check('自己的学号可见', ownPersonRow !== undefined && String(personSheet?.getRow(ownPersonRow).getCell(2).value) === '03001');
  const otherStudentNo = otherPersonRow === undefined ? undefined : personSheet?.getRow(otherPersonRow).getCell(2).value;
  check('他人的学号也可导出', otherPersonRow !== undefined && String(otherStudentNo) === '03002');
  check('大论文表包含他人记录', (wb.getWorksheet('大论文题目')?.rowCount ?? 0) === 3);
  check('大论文成绩对本人可见', String(wb.getWorksheet('大论文题目')?.getRow(2).getCell(4).value) === 'EX-GRADE-1');
  check('他人的大论文成绩也可导出', String(wb.getWorksheet('大论文题目')?.getRow(3).getCell(4).value) === 'EX-GRADE-2');
  check('导出说明写明范围', String(wb.getWorksheet('导出说明')?.getRow(2).getCell(2).value).includes('成员'));
  check('计数正确', built.counts['submission'] === 2 && built.counts['patent'] === 2 &&
    built.counts['person'] === 2 && built.counts['thesis'] === 2, JSON.stringify(built.counts));
}

console.log('导师/管理员导出');
{
  const allPeople = listPeople(db, { keyword: undefined, limit: 100 }, {
    userId: mentorId, canReadSensitive: true, canManage: false,
  }).items;
  const thesisIds = db.prepare('SELECT id FROM theses').all() as unknown as { id: string }[];
  const thesisRows = thesisIds
    .map((t) => getThesis(db, t.id, { userId: mentorId, canReadGrade: true }))
    .filter((t): t is NonNullable<typeof t> => t !== null);
  const allPatents = listPatents(db, { keyword: undefined, limit: 100 }, { userId: mentorId, canReadAll: true });
  const built = await buildDataWorkbook({
    submissions: [getSubmission(db, subA)!, getSubmission(db, subB)!],
    patents: allPatents,
    people: allPeople,
    theses: thesisRows,
    scopeLabel: '导师：全库',
    keyword: null,
    now: NOW,
    targets: ['submission','patent','person','thesis'],
  });
  const wb = await load(built.buffer);
  check('导师导出人员两条', (wb.getWorksheet('个人信息')?.rowCount ?? 0) === 3);
  check('导师能看到完整学号',
    String(wb.getWorksheet('个人信息')?.getRow(2).getCell(2).value).startsWith('03'));
  check('导师导出大论文两条', (wb.getWorksheet('大论文题目')?.rowCount ?? 0) === 3);
  check('导师能看到成绩',
    String(wb.getWorksheet('大论文题目')?.getRow(2).getCell(4).value).startsWith('EX-GRADE'));
  check('导师导出两篇论文', (wb.getWorksheet('论文')?.rowCount ?? 0) === 3);
  check('测试前提：管理员/导师两篇都可见', allPatents.length >= 1 && thesisRows.length === 2);
}

console.log(`\n${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
