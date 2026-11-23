/**
 * 专利台账的零模型校验：行级可见、事件留痕、空值与写入权限。
 *
 * 用法：npm run verify-patents -w @knowpilot/server
 */
import {
  canWritePatent,
  createPatent,
  getPatent,
  getPatentFor,
  listPatents,
  listPatentPage,
  updatePatent,
} from './repo.ts';
import { insertPerson } from '../people/repo.ts';
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

const adminId = await insertUser(db, 'pat-admin', { password: 'pat-pw-1234', role: 'admin' }, new Date(NOW));
const mentorId = await insertUser(db, 'pat-mentor', { password: 'pat-pw-1234', role: 'mentor' }, new Date(NOW));
const memberId = await insertUser(db, 'pat-member', { password: 'pat-pw-1234', role: 'member' }, new Date(NOW));
const otherId = await insertUser(db, 'pat-other', { password: 'pat-pw-1234', role: 'member' }, new Date(NOW));
const personId = insertPerson(
  db,
  { name: '示例同学乙', studentNo: '00777', groupId: null, status: 'active', userId: memberId, note: null, createdBy: adminId },
  NOW,
);

const id = createPatent(
  db,
  {
    name: '示例图像处理方法',
    patentNo: null,
    applicantName: '示例同学乙',
    applicantPersonId: personId,
    firstSubmittedOn: '2026-09-01',
    substantiveExamOn: null,
    publishedOn: null,
    notes: null,
    ownerUserId: memberId,
    createdBy: memberId,
  },
  NOW,
);

console.log('建档与空值');
{
  const p = getPatent(db, id);
  check('专利名称入库', p?.name === '示例图像处理方法');
  check('专利号可暂缺', p?.patentNo === null);
  check('实审/公开可暂缺', p?.substantiveExamOn === null && p?.publishedOn === null);
  check('首次提交日期入库', p?.firstSubmittedOn === '2026-09-01');
  check('申请人姓名快照保留', p?.applicantName === '示例同学乙');
  check('人员关联生效', p?.applicantPersonId === personId && p.applicantPersonName === '示例同学乙');
  check('登记人显示', p?.ownerUserId === memberId && p.ownerName === 'pat-member');
  check('建档事件有首次提交', p?.events.some((e) => e.kind === 'submitted' && e.occurredOn === '2026-09-01') === true);
  check('未填的日期不产生假事件', !p?.events.some((e) => e.kind === 'substantive_exam' || e.kind === 'published'));
  check('事件记下了录入人', p?.events[0]?.recordedByName === 'pat-member');
}

// 显式传入 canReadAll=false/true，检验底层行级隔离；当前所有登录角色实际均为 true。
console.log('行级可见（底层范围）');
{
  const own = listPatents(db, { keyword: undefined, limit: 20 }, { userId: memberId, canReadAll: false });
  check('成员看得到自己的专利', own.length === 1 && own[0]?.id === id);
  const other = listPatents(db, { keyword: undefined, limit: 20 }, { userId: otherId, canReadAll: false });
  check('未获全量读取的他人看不到', other.length === 0);
  const mentor = listPatents(db, { keyword: undefined, limit: 20 }, { userId: mentorId, canReadAll: true });
  check('导师看得到全部', mentor.length === 1);
  check('成员按 id 取自己的可见', getPatentFor(db, id, { userId: memberId, canReadAll: false })?.id === id);
  check('未获全量读取时按 id 取别人的 → null', getPatentFor(db, id, { userId: otherId, canReadAll: false }) === null);
  check('导师按 id 可见', getPatentFor(db, id, { userId: mentorId, canReadAll: true })?.id === id);
}

console.log('写入权限（底层范围）');
{
  const p = getPatent(db, id);
  if (p === null) throw new Error('patent missing');
  check('本人可写', canWritePatent(p, { userId: memberId, canWriteAll: false }));
  check('未获全量写入的他人不可写', !canWritePatent(p, { userId: otherId, canWriteAll: false }));
  check('未获全量写入时导师也不可改别人的',
    !canWritePatent(p, { userId: mentorId, canWriteAll: false }));
  check('管理员可写', canWritePatent(p, { userId: adminId, canWriteAll: true }));
}

console.log('事件留痕');
{
  updatePatent(
    db,
    id,
    { patentNo: 'DEMO-PATENT-001', substantiveExamOn: '2026-10-01' },
    '2026-10-22T08:00:00.000Z',
    memberId,
  );
  let p = getPatent(db, id);
  check('补录专利号成功', p?.patentNo === 'DEMO-PATENT-001');
  check('补专利号产生事件', p?.events.some((e) => e.kind === 'patent_no' && (e.note ?? '').includes('DEMO-PATENT-001')) === true);
  check('实审时间入库', p?.substantiveExamOn === '2026-10-01');
  check('实审事件带日期', p?.events.some((e) => e.kind === 'substantive_exam' && e.occurredOn === '2026-10-01') === true);

  updatePatent(db, id, { publishedOn: '2026-10-20', name: '示例图像处理方法（改名）' }, '2026-10-23T08:00:00.000Z', memberId);
  p = getPatent(db, id);
  check('公开时间入库', p?.publishedOn === '2026-10-20');
  check('公开事件带日期', p?.events.some((e) => e.kind === 'published' && e.occurredOn === '2026-10-20') === true);
  check('改名事件保留旧名', p?.events.some((e) => e.kind === 'renamed' && (e.note ?? '').includes('示例图像处理方法')) === true);
  check('旧事件没有被覆盖', p?.events.filter((e) => e.kind === 'submitted').length === 1);
  check('事件数 = 5（提交/专利号/实审/公开/改名）', p?.events.length === 5, String(p?.events.length));
}

console.log('搜索与清空');
{
  const byNo = listPatents(db, { keyword: 'DEMO-PATENT', limit: 20 }, { userId: memberId, canReadAll: false });
  check('按专利号搜索', byNo.length === 1);
  const byApplicant = listPatents(db, { keyword: '示例同学乙', limit: 20 }, { userId: memberId, canReadAll: false });
  check('按申请人（人员主档姓名）搜索', byApplicant.length === 1);

  updatePatent(db, id, { patentNo: null, publishedOn: null }, '2026-10-24T08:00:00.000Z', memberId);
  const p = getPatent(db, id);
  check('专利号可以清空', p?.patentNo === null);
  check('公开日期可以清空', p?.publishedOn === null);
  check('清空专利号也留事件', p?.events.some((e) => e.kind === 'patent_no' && e.note === '清空专利号') === true);
}

console.log('完整列表计数与翻页');
{
  for (let i = 0; i < 201; i += 1) {
    createPatent(db, {
      name: `批量专利 ${i}`, patentNo: null, applicantName: null,
      applicantPersonId: null, firstSubmittedOn: null, substantiveExamOn: null,
      publishedOn: null, notes: null, ownerUserId: memberId, createdBy: memberId,
    }, NOW);
  }
  const scope = { userId: memberId, canReadAll: true };
  const first = listPatentPage(db, { keyword: undefined, filter: 'all', limit: 200, offset: 0 }, scope);
  const second = listPatentPage(db, { keyword: undefined, filter: 'all', limit: 200, offset: 200 }, scope);
  check('专利总数不受 200 条截断影响', first.total === 202 && first.counts.all === 202);
  check('第 201 条以后可继续加载', first.items.length === 200 && second.items.length === 2);
  check('搜索计数在完整结果集上计算',
    listPatentPage(db, { keyword: '批量专利', filter: 'missing_number', limit: 200, offset: 0 }, scope).matched === 201);
}

console.log(`\n${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
