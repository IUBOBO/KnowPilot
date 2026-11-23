/**
 * 人员主档的零模型校验：学号可见性、重名、唯一性与账号绑定。
 *
 * 用法：npm run verify-people -w @knowpilot/server
 */
import {
  findPersonByStudentNo,
  findPersonByUserId,
  getPerson,
  insertPerson,
  listPeople,
  updatePerson,
  type PersonViewer,
} from './repo.ts';
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

const NOW = '2026-10-21T08:00:00.000Z';
const { db } = openDb(':memory:');

const adminId = await insertUser(db, 'people-admin', { password: 'people-pw-1234', role: 'admin' }, new Date(NOW));
const mentorId = await insertUser(db, 'people-mentor', { password: 'people-pw-1234', role: 'mentor' }, new Date(NOW));
const memberId = await insertUser(db, 'people-member', { password: 'people-pw-1234', role: 'member' }, new Date(NOW));
const otherId = await insertUser(db, 'people-other', { password: 'people-pw-1234', role: 'member' }, new Date(NOW));

const adminView: PersonViewer = { userId: adminId, canReadSensitive: true, canManage: true };
const mentorView: PersonViewer = { userId: mentorId, canReadSensitive: true, canManage: false };
const memberView: PersonViewer = { userId: memberId, canReadSensitive: hasPermission('member', 'people.read.sensitive'), canManage: false };
const otherView: PersonViewer = { userId: otherId, canReadSensitive: hasPermission('member', 'people.read.sensitive'), canManage: false };
const restrictedView: PersonViewer = { userId: null, canReadSensitive: false, canManage: false };

const aId = insertPerson(
  db,
  {
    name: '张三',
    studentNo: '00123',
    groupId: '遥感组',
    status: 'active',
    userId: memberId,
    note: null,
    createdBy: adminId,
  },
  NOW,
);
const bId = insertPerson(
  db,
  { name: '张三', studentNo: null, groupId: null, status: 'active', userId: null, note: null, createdBy: adminId },
  NOW,
);
const cId = insertPerson(
  db,
  { name: '李四', studentNo: '00456', groupId: null, status: 'graduated', userId: null, note: '历史人员', createdBy: adminId },
  NOW,
);

console.log('可见性');
{
  const self = getPerson(db, aId, memberView);
  check('本人能看到自己的学号', self?.studentNo === '00123' && self.studentNoVisible === true);
  check('本人标记 isSelf', self?.isSelf === true);
  const otherPerson = getPerson(db, cId, memberView);
  check('成员能看到他人的完整学号',
    otherPerson?.studentNo === '00456' && otherPerson.studentNoVisible === true);
  check('成员看别人的姓名仍然可见', otherPerson?.name === '李四');
  const restrictedPerson = getPerson(db, cId, restrictedView);
  check('未授权调用方仍收不到学号', restrictedPerson?.studentNo === null && restrictedPerson.studentNoVisible === false);
  check('成员拿不到账号绑定', self?.linkedUserId === null && self.linkedUsername === null);

  const mentorSee = getPerson(db, aId, mentorView);
  check('导师能看到完整学号', mentorSee?.studentNo === '00123' && mentorSee.studentNoVisible === true);
  check('导师拿不到账号绑定（不是 manage）', mentorSee?.linkedUserId === null);

  const adminSee = getPerson(db, aId, adminView);
  check('管理员能看到账号绑定', adminSee?.linkedUserId === memberId && adminSee.linkedUsername === 'people-member');
}

console.log('重名与唯一性');
{
  const list = listPeople(db, { keyword: '张三', limit: 20 }, adminView);
  check('重名允许存在且都能查到', list.matched === 2, String(list.matched));
  check('总数不受搜索词影响', list.total === 3, String(list.total));
  check('同名学生没有被自动合并', new Set(list.items.map((p) => p.id)).size === 2);

  let duplicateNo = false;
  try {
    insertPerson(
      db,
      { name: '王五', studentNo: '00123', groupId: null, status: 'active', userId: null, note: null, createdBy: adminId },
      NOW,
    );
  } catch {
    duplicateNo = true;
  }
  check('学号重复被唯一索引挡住', duplicateNo);
  check('按学号能找到已占用记录', findPersonByStudentNo(db, '00123')?.id === aId);

  let duplicateUser = false;
  try {
    insertPerson(
      db,
      { name: '王五', studentNo: '00999', groupId: null, status: 'active', userId: memberId, note: null, createdBy: adminId },
      NOW,
    );
  } catch {
    duplicateUser = true;
  }
  check('一个账号不能被两条人员记录绑定', duplicateUser);
  check('按账号能找到绑定记录', findPersonByUserId(db, memberId)?.id === aId);
}

console.log('搜索权限');
{
  const byNoMember = listPeople(db, { keyword: '00123', limit: 20 }, memberView);
  check('成员可以按学号搜索', byNoMember.matched === 1, String(byNoMember.matched));
  const byNoRestricted = listPeople(db, { keyword: '00123', limit: 20 }, restrictedView);
  check('未授权调用方不能按学号搜索', byNoRestricted.matched === 0, String(byNoRestricted.matched));
  const byNoMentor = listPeople(db, { keyword: '00123', limit: 20 }, mentorView);
  check('有敏感权限的人可以按学号搜索', byNoMentor.matched === 1, String(byNoMentor.matched));
  const byName = listPeople(db, { keyword: '李四', limit: 20 }, otherView);
  check('姓名搜索对所有人开放', byName.matched === 1);
  check('列表里别人的学号可见', byName.items[0]?.studentNo === '00456' && byName.items[0]?.studentNoVisible === true);
}

console.log('修改与解绑');
{
  updatePerson(db, aId, { studentNo: null, userId: null, status: 'graduated' }, NOW);
  const after = getPerson(db, aId, adminView);
  check('学号可以清空', after?.studentNo === null);
  check('账号可以解绑', after?.linkedUserId === null);
  check('状态可以改', after?.status === 'graduated', String(after?.status));
  check('解绑后按账号查不到', findPersonByUserId(db, memberId) === null);

  const selfAfterUnbind = getPerson(db, aId, memberView);
  check('解绑后本人也不再把这条当成自己', selfAfterUnbind?.isSelf === false);
  check('解绑不影响成员的学号查看权（已清空学号）',
    selfAfterUnbind?.studentNo === null && selfAfterUnbind.studentNoVisible === true);
}

console.log('历史人员');
{
  const historical = getPerson(db, cId, adminView);
  check('没有账号的历史人员仍可存在', historical !== null && historical.linkedUserId === null);
  check('历史人员状态可表达', historical?.status === 'graduated');
}

console.log('年级派生与排序');
{
  const base = { groupId: null, status: 'active' as const, userId: null, note: null, createdBy: adminId };
  insertPerson(db, { ...base, name: '年级验证乙', studentNo: '202522000645' }, NOW);
  const grade24Id = insertPerson(db, { ...base, name: '年级验证甲', studentNo: '002400000001' }, NOW);
  insertPerson(db, { ...base, name: '年级验证丙', studentNo: '202322000645' }, NOW);
  insertPerson(db, { ...base, name: '年级验证未知', studentNo: 'X-2024' }, NOW);
  const result = listPeople(db, { keyword: '年级验证', limit: 20 }, adminView);
  check('学号第 3、4 位派生 24级', getPerson(db, grade24Id, adminView)?.grade === '24');
  check('年级递增，无法识别者排末尾',
    result.items.map((person) => person.grade ?? '未知').join(',') === '23,24,25,未知');
  check('搜索后的 limit 仍按年级顺序截取',
    listPeople(db, { keyword: '年级验证', limit: 2 }, adminView).items.map((person) => person.grade).join(',') === '23,24');
}

console.log(`\n${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
