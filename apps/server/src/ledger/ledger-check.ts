/**
 * Excel 台账导入的零模型校验：四表识别、草稿状态、逐行/批量导入与归属。
 *
 * 用法：npm run verify-ledger-import -w @knowpilot/server
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { parseLedgerWorkbook } from './parse.ts';
import { createBatch, getBatch, importReady, importRow, listBatches, updateRow } from './service.ts';
import { openDb } from '../db/index.ts';
import { insertUser } from '../auth/users.ts';

let failed = 0;
let total = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  total += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` —— ${detail}`}`);
  if (!ok) failed += 1;
};

const NOW = '2026-10-21T08:00:00.000Z';
const { db } = openDb(':memory:');
const adminId = await insertUser(db, 'ledger-admin', { password: 'ledger-pw-1234', role: 'admin' }, new Date(NOW));
const memberId = await insertUser(db, 'ledger-member', { password: 'ledger-pw-1234', role: 'member' }, new Date(NOW));

const wb = new ExcelJS.Workbook();
const paper = wb.addWorksheet('论文');
paper.addRow(['论文题目','论文算法缩写','投稿期刊','期刊缩写','投稿人','首次投稿时间','状态','进入当前状态的时间','投稿号']);
paper.addRow(['示例论文 A','A-Net','示例期刊 A','J-A','示例同学甲','2026-09-01','投稿','2026-09-02','P-001']);
paper.addRow(['', '', '', '', '', '', '投稿', '', '']);
paper.addRow(['示例论文 B','B-Net','示例期刊 B','J-B','示例同学乙','26.4.6','转投','','P-002']);

const patent = wb.addWorksheet('专利');
patent.addRow(['专利名称','专利号','申请人','首次提交时间','实审时间','公开时间']);
patent.addRow(['示例专利 A','PAT-001','示例同学甲','2026-09-01','2026-10-01','']);
patent.addRow(['示例专利 B','PAT-002','示例同学乙','2026-09-01','2026-08-01','']);

const people = wb.addWorksheet('个人信息');
people.addRow(['姓名','学号']);
people.addRow(['示例同学甲','00101']);
people.addRow(['示例同学乙','2026']);

const thesis = wb.addWorksheet('大论文题目');
thesis.addRow(['姓名','研究方向','题目','成绩']);
thesis.addRow(['示例同学甲','遥感','示例大论文题目 A','90']);
thesis.addRow(['王五','未知方向','示例大论文题目 B','']);

const buffer = Buffer.from(await wb.xlsx.writeBuffer());
const storage = mkdtempSync(join(tmpdir(), 'kp-ledger-'));

try {
  console.log('识别');
  {
    const rows = await parseLedgerWorkbook(buffer);
    check('识别出四类记录', new Set(rows.map((r) => r.target)).size === 4,
      [...new Set(rows.map((r) => r.target))].join(','));
    check('空论文题目判无效', rows.some((r) => r.target === 'submission' && r.status === 'invalid'));
    check('两位年份标待核实',
      rows.some((r) => r.target === 'submission' && r.normalized['submittedOn'] === null && r.issues.some((i) => i.includes('两位年份'))));
    check('转投标待核实',
      rows.some((r) => r.target === 'submission' && r.issues.some((i) => i.includes('状态'))));
    check('专利日期倒置标待核实',
      rows.some((r) => r.target === 'patent' && r.issues.some((i) => i.includes('早于首次提交'))));
    check('学号按文本保留', rows.some((r) => r.target === 'person' && r.normalized['studentNo'] === '00101'));
  }

  console.log('草稿');
  const created = await createBatch(
    db,
    storage,
    { buffer, fileName: '台账.xlsx' },
    memberId,
    NOW,
  );
  check('上传返回批次与逐行草稿', created.rows.length >= 8, String(created.rows.length));
  check('原文件已落盘', existsSync(join(storage, `${created.batch.id}.xlsx`)));
  check('批次属于上传者', created.batch.total === created.rows.length);
  check('草稿里有可导入行', created.rows.some((r) => r.status === 'ready'));
  check('草稿里有无效行', created.rows.some((r) => r.status === 'invalid'));
  check('草稿里有待核实行', created.rows.some((r) => r.status === 'needs_review'));

  const otherView = { userId: adminId, canManageAll: false };
  let hidden = false;
  try {
    getBatch(db, created.batch.id, otherView);
  } catch {
    hidden = true;
  }
  check('非上传者且非管理员看不到草稿', hidden);
  const adminView = { userId: adminId, canManageAll: true };
  check('管理员能看全部草稿', getBatch(db, created.batch.id, adminView).rows.length === created.rows.length);
  check('批次列表按归属过滤', listBatches(db, otherView, 20).length === 0);

  console.log('逐行编辑与跳过');
  {
    const invalid = created.rows.find((r) => r.status === 'invalid');
    if (invalid === undefined) throw new Error('缺少无效行');
    const edited = updateRow(
      db,
      created.batch.id,
      invalid.id,
      { normalized: { ...invalid.normalized, title: '补全后的论文标题', submittedOn: '2026-09-10', status: 'pending_initial' } },
      { userId: memberId, canManageAll: false },
      NOW,
    );
    check('补全必填字段后变为可导入', edited.row.status === 'ready', edited.row.status);
    const skipped = updateRow(
      db,
      created.batch.id,
      invalid.id,
      { skip: true },
      { userId: memberId, canManageAll: false },
      NOW,
    );
    check('可以跳过一行', skipped.row.status === 'skipped');
    const restored = updateRow(
      db,
      created.batch.id,
      invalid.id,
      { skip: false },
      { userId: memberId, canManageAll: false },
      NOW,
    );
    check('恢复后重新校验', restored.row.status === 'ready');
  }

  console.log('批量导入');
  {
    const result = importReady(db, created.batch.id, { userId: memberId, canManageAll: false }, NOW);
    check('批量导入有结果', result.results.length > 0, String(result.results.length));
    const imported = result.results.filter((r) => r.status === 'imported');
    check('至少导入一条', imported.length > 0, String(imported.length));

    const peopleCount = (db.prepare('SELECT COUNT(*) AS n FROM people').get() as unknown as { n: number }).n;
    check('人员导入成功', peopleCount === 2, String(peopleCount));
    const subCount = (db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE title IN ('示例论文 A', '补全后的论文标题')").get() as unknown as { n: number }).n;
    check('两篇可导入论文都成功', subCount === 2, String(subCount));
    const patentCount = (db.prepare("SELECT COUNT(*) AS n FROM patents WHERE name LIKE '示例专利%'").get() as unknown as { n: number }).n;
    check('专利导入成功', patentCount >= 1, String(patentCount));
    const thesisCount = (db.prepare("SELECT COUNT(*) AS n FROM theses WHERE title LIKE '示例大论文题目%'").get() as unknown as { n: number }).n;
    check('普通成员无法通过 Excel 代录他人成绩', thesisCount === 0 && result.results.some((r) =>
      r.status === 'needs_review' && r.message.includes('清空成绩')));

    const unmatched = result.results.find((r) => r.status === 'needs_review');
    check('未匹配人员的大论文留在待核实', unmatched !== undefined);

    const importedRows = db
      .prepare("SELECT COUNT(*) AS n FROM ledger_import_rows WHERE batch_id = ? AND status = 'imported'")
      .get(created.batch.id) as unknown as { n: number };
    check('已导入行状态已落库', importedRows.n === imported.length, String(importedRows.n));

    const graded = created.rows.find((r) => r.target === 'thesis' && r.normalized['grade'] === '90');
    if (graded === undefined) throw new Error('缺少带成绩的大论文行');
    updateRow(db, created.batch.id, graded.id, { normalized: graded.normalized }, adminView, NOW);
    const confirmed = importRow(db, created.batch.id, graded.id, adminView, NOW);
    const archived = db.prepare('SELECT grade, created_by FROM theses WHERE id = ?').get(confirmed.row.targetId);
    check('管理员确认成员上传的成绩，归属最终确认账号',
      confirmed.row.status === 'imported' && archived?.grade === '90' && archived.created_by === adminId);
  }

  console.log('单行重复导入');
  {
    const ready = db
      .prepare("SELECT id FROM ledger_import_rows WHERE batch_id = ? AND status = 'imported' LIMIT 1")
      .get(created.batch.id) as unknown as { id: string };
    const before = (db.prepare('SELECT COUNT(*) AS n FROM submissions').get() as unknown as { n: number }).n;
    const row = importRow(
      db,
      created.batch.id,
      ready.id,
      { userId: memberId, canManageAll: false },
      NOW,
    );
    const after = (db.prepare('SELECT COUNT(*) AS n FROM submissions').get() as unknown as { n: number }).n;
    check('已导入行再次导入不会重复建记录', after === before && row.row.status === 'imported' && row.row.targetId !== null,
      `before=${before} after=${after} target=${row.row.targetId}`);
  }
} finally {
  rmSync(storage, { recursive: true, force: true });
}

console.log(`\n${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
