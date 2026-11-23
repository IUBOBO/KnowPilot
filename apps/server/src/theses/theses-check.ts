/**
 * 大论文台账的零模型校验：成绩可见性、题目变更历史、人员关联与搜索。
 *
 * 用法：npm run verify-theses -w @knowpilot/server
 */
import { getThesis, insertThesis, listTheses, updateThesis, type ThesisViewer } from './repo.ts';
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

const adminId = await insertUser(db, 'th-admin', { password: 'th-pw-1234', role: 'admin' }, new Date(NOW));
const mentorId = await insertUser(db, 'th-mentor', { password: 'th-pw-1234', role: 'mentor' }, new Date(NOW));
const memberId = await insertUser(db, 'th-member', { password: 'th-pw-1234', role: 'member' }, new Date(NOW));
const otherId = await insertUser(db, 'th-other', { password: 'th-pw-1234', role: 'member' }, new Date(NOW));

const personA = insertPerson(
  db,
  { name: '示例同学甲', studentNo: '01001', groupId: null, status: 'active', userId: memberId, note: null, createdBy: adminId },
  NOW,
);
const personB = insertPerson(
  db,
  { name: '示例同学乙', studentNo: '01002', groupId: null, status: 'active', userId: otherId, note: null, createdBy: adminId },
  NOW,
);

// canReadGrade=false 是底层遮罩的兼容性用例；当前所有登录角色实际均持有该权限。
const memberView: ThesisViewer = { userId: memberId, canReadGrade: false };
const otherView: ThesisViewer = { userId: otherId, canReadGrade: false };
const mentorView: ThesisViewer = { userId: mentorId, canReadGrade: true };
const adminView: ThesisViewer = { userId: adminId, canReadGrade: true };

const aId = insertThesis(
  db,
  { personId: personA, authorName: '示例同学甲', direction: '遥感', title: '示例研究方向的方法与应用', grade: '90', notes: null, createdBy: adminId },
  NOW,
);
const bId = insertThesis(
  db,
  { personId: personB, authorName: '示例同学乙', direction: '医学影像', title: '三维分割方法研究', grade: '85', notes: null, createdBy: adminId },
  NOW,
);

console.log('成绩可见性');
{
  const self = getThesis(db, aId, memberView);
  check('本人能看到自己的成绩', self?.grade === '90' && self.gradeVisible === true);
  check('本人标记 isSelf', self?.isSelf === true);
  check('本人能看到关联人员姓名', self?.personName === '示例同学甲');
  const otherPerson = getThesis(db, bId, memberView);
  check('受限视角看别人的成绩 → null + visible=false',
    otherPerson?.grade === null && otherPerson.gradeVisible === false);
  check('别人的基础信息仍然可见', otherPerson?.title === '三维分割方法研究');
  check('别人的记录不标 isSelf', otherPerson?.isSelf === false);

  const mentor = getThesis(db, bId, mentorView);
  check('导师能看到别人的成绩', mentor?.grade === '85' && mentor.gradeVisible === true);
  const admin = getThesis(db, aId, adminView);
  check('管理员能看到成绩', admin?.grade === '90');
}

console.log('列表与搜索');
{
  const list = listTheses(db, { keyword: undefined, limit: 20 }, memberView);
  check('列表总数 = 2', list.total === 2, String(list.total));
  check('受限视角在列表里看不到别人的成绩',
    list.items.find((t) => t.id === bId)?.grade === null);
  check('成员能看到自己的成绩',
    list.items.find((t) => t.id === aId)?.grade === '90');

  const byAuthor = listTheses(db, { keyword: '示例同学乙', limit: 20 }, memberView);
  check('按作者姓名搜索', byAuthor.matched === 1, String(byAuthor.matched));
  const byDirection = listTheses(db, { keyword: '遥感', limit: 20 }, memberView);
  check('按研究方向搜索', byDirection.matched === 1);
  const byTitle = listTheses(db, { keyword: '三维分割', limit: 20 }, memberView);
  check('按题目搜索', byTitle.matched === 1);
  const byGrade = listTheses(db, { keyword: '90', limit: 20 }, memberView);
  check('★ 成绩不参与普通搜索', byGrade.matched === 0, String(byGrade.matched));
}

console.log('题目变更历史');
{
  updateThesis(db, aId, { title: '修订后的题目' }, '2026-10-22T08:00:00.000Z', adminId);
  const t = getThesis(db, aId, adminView);
  check('题目更新生效', t?.title === '修订后的题目');
  check('产生一条变更历史', t?.titleHistory.length === 1, String(t?.titleHistory.length));
  check('历史保留旧题目', t?.titleHistory[0]?.oldTitle === '示例研究方向的方法与应用');
  check('历史记录新题目', t?.titleHistory[0]?.newTitle === '修订后的题目');
  check('历史记录经办人', t?.titleHistory[0]?.changedByName === 'th-admin');

  updateThesis(db, aId, { title: null }, '2026-10-23T08:00:00.000Z', adminId);
  const cleared = getThesis(db, aId, adminView);
  check('题目可以清空（未定题）', cleared?.title === null);
  check('清空也留历史', cleared?.titleHistory.length === 2, String(cleared?.titleHistory.length));
  check('清空历史的旧值正确', cleared?.titleHistory[1]?.oldTitle === '修订后的题目');
}

console.log('其它字段');
{
  updateThesis(db, aId, { grade: '95', direction: '遥感科学', notes: '已定稿' }, '2026-10-24T08:00:00.000Z', adminId);
  const t = getThesis(db, aId, adminView);
  check('成绩可更新', t?.grade === '95');
  check('方向可更新', t?.direction === '遥感科学');
  check('备注可更新', t?.notes === '已定稿');
  check('改成绩不产生题目历史', t?.titleHistory.length === 2, String(t?.titleHistory.length));

  updateThesis(db, aId, { grade: null }, '2026-10-25T08:00:00.000Z', adminId);
  check('成绩可以清空（未出结果）', getThesis(db, aId, adminView)?.grade === null);

  const noPerson = insertThesis(
    db,
    { personId: null, authorName: '历史人员', direction: null, title: null, grade: null, notes: '原表缺失', createdBy: adminId },
    NOW,
  );
  const hist = getThesis(db, noPerson, adminView);
  check('没有人员关联的历史记录仍可存在', hist?.personId === null && hist.authorName === '历史人员');
  check('题目暂缺可表达', hist?.title === null);
  check('成绩暂缺可表达', hist?.grade === null && hist.gradeVisible === true);
}

console.log('大论文列表翻页');
{
  for (let i = 0; i < 201; i += 1) {
    insertThesis(db, {
      personId: null, authorName: `批量作者 ${i}`, direction: null,
      title: null, grade: null, notes: null, createdBy: adminId,
    }, NOW);
  }
  const first = listTheses(db, { keyword: '批量作者', limit: 200, offset: 0 }, memberView);
  const second = listTheses(db, { keyword: '批量作者', limit: 200, offset: 200 }, memberView);
  check('大论文匹配总数不受 200 条截断影响', first.matched === 201);
  check('第 201 条大论文可继续加载', first.items.length === 200 && second.items.length === 1);
}

console.log(`\n${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
