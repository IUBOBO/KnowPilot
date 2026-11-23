/**
 * 投稿台账 v23 的零模型校验：字段补齐 + 稿件/轮次模型。
 *
 * 用法：npm run verify-ledger -w @knowpilot/server
 * 不建真实库、不调用模型、不发网络请求。
 */
import {
  createSubmission,
  createSubmissionRound,
  getJournalById,
  getSubmission,
  listSubmissionRounds,
  updateJournal,
  updateSubmissionStatus,
  upsertJournal,
} from './repo.ts';
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
const adminId = await insertUser(
  db,
  'ledger-admin',
  { password: 'ledger-pw-1234', role: 'admin' },
  new Date(NOW),
);

// ── 期刊：缩写与网址 ────────────────────────────────────────
{
  const created = upsertJournal(
    db,
    { name: '示例遥感学报', abbr: 'JRS', issn: '1234-5678', field: '遥感', website: 'https://example.com/jrs' },
    NOW,
  );
  check('新建期刊带缩写与网址', created.created === true);
  const journal = getJournalById(db, created.id);
  check('期刊缩写读得回来', journal?.abbr === 'JRS', String(journal?.abbr));
  check('期刊网址读得回来', journal?.website === 'https://example.com/jrs', String(journal?.website));

  // 只补空：已有值不被空值覆盖。
  upsertJournal(db, { name: '示例遥感学报', abbr: null, issn: null, field: '新领域' }, NOW);
  const after = getJournalById(db, created.id);
  check('已有缩写不会被空值覆盖', after?.abbr === 'JRS', String(after?.abbr));
  check('只补空的字段可以补', after?.field === '遥感', String(after?.field));

  // 显式传 null 才清空。
  updateJournal(db, created.id, { website: null });
  check('显式清空网址', getJournalById(db, created.id)?.website === null);
  const partial = updateJournal(db, created.id, { field: '遥感科学' });
  check('只改领域时缩写保持不变', partial?.abbr === 'JRS', String(partial?.abbr));
}

// ── 稿件：新字段 + 第 1 轮 ──────────────────────────────────
let submissionId = '';
{
  const journal = upsertJournal(db, { name: '示例期刊 A', abbr: 'J-A' }, NOW);
  const created = createSubmission(
    db,
    {
      title: '示例遥感分割方法',
      algorithmAbbr: 'DEMO-Net',
      submitterName: '示例同学甲',
      journalName: '示例期刊 A',
      journalField: undefined,
      status: 'under_review',
      submittedAt: null,
      submittedOn: '2026-10-01',
      statusSince: '2026-10-08',
      submissionNumber: 'DEMO-001',
      notes: '示例记录',
      userId: adminId,
    },
    NOW,
  );
  submissionId = created.id;

  const submission = getSubmission(db, submissionId);
  check('稿件简称入库', submission?.algorithmAbbr === 'DEMO-Net', String(submission?.algorithmAbbr));
  check('投稿人入库（文本，未绑定账号）', submission?.submitterName === '示例同学甲');
  check('本轮投稿日期入库', submission?.submittedOn === '2026-10-01', String(submission?.submittedOn));
  check('进入当前状态日期入库', submission?.statusSince === '2026-10-08', String(submission?.statusSince));
  check('当前轮次 = 1', submission?.currentRoundNo === 1, String(submission?.currentRoundNo));
  check('当前投稿号', submission?.submissionNumber === 'DEMO-001', String(submission?.submissionNumber));
  check('建档自动产生第 1 轮', submission?.rounds.length === 1, String(submission?.rounds.length));
  check('第 1 轮的期刊正确', submission?.rounds[0]?.journal?.name === '示例期刊 A');
  check('第 1 轮的投稿号正确', submission?.rounds[0]?.submissionNumber === 'DEMO-001');
  check('第 1 轮日期正确', submission?.rounds[0]?.submittedOn === '2026-10-01');
  check('轮次列表按轮次升序', listSubmissionRounds(db, submissionId).map((r) => r.roundNo).join(',') === '1');
  check('期刊缩写随轮次返回', submission?.rounds[0]?.journal?.abbr === 'J-A');
  check('示例期刊 id 可查', getJournalById(db, journal.id)?.name === '示例期刊 A');
}

// ── 状态变更：主表与当前轮次同步 ────────────────────────────
{
  const updated = updateSubmissionStatus(
    db,
    submissionId,
    'revision_resubmitted',
    '2026-10-15',
    '收到大修意见',
    NOW,
    { userId: adminId, canWriteAll: true },
  );
  check('改状态成功', updated?.status === 'revision_resubmitted', String(updated?.status));
  check('主表记下实际进入日期', updated?.statusSince === '2026-10-15', String(updated?.statusSince));
  check('当前轮次同步状态', updated?.rounds[0]?.status === 'revision_resubmitted');
  check('当前轮次同步日期', updated?.rounds[0]?.statusSince === '2026-10-15');
  check('时间线新增一条', updated?.history.length === 2, String(updated?.history.length));
}

// ── 转投：新增第 2 轮，历史轮次不动 ────────────────────────
{
  const { round, journalCreated } = createSubmissionRound(
    db,
    submissionId,
    {
      journalName: '示例期刊 B',
      journalField: '遥感',
      submittedOn: '2026-10-20',
      status: 'pending_initial',
      statusSince: '2026-10-20',
      submissionNumber: 'DEMO-002',
      notes: '被拒后转投',
      userId: null,
    },
    NOW,
  );
  check('新增第 2 轮', round.roundNo === 2, String(round.roundNo));
  check('第 2 轮期刊正确', round.journal?.name === '示例期刊 B');
  check('第 2 轮投稿号正确', round.submissionNumber === 'DEMO-002');
  check('第 2 轮日期正确', round.submittedOn === '2026-10-20');
  check('新期刊标记为已创建', journalCreated === true);

  const submission = getSubmission(db, submissionId);
  check('主表当前指针切到第 2 轮期刊', submission?.journal?.name === '示例期刊 B');
  check('主表当前状态切到第 2 轮状态', submission?.status === 'pending_initial');
  check('当前轮次号 = 2', submission?.currentRoundNo === 2, String(submission?.currentRoundNo));
  check('当前投稿号切到第 2 轮', submission?.submissionNumber === 'DEMO-002');
  check('两轮都在列表里', submission?.rounds.length === 2, String(submission?.rounds.length));
  check('第 1 轮历史没有被改写',
    submission?.rounds[0]?.submissionNumber === 'DEMO-001' &&
      submission?.rounds[0]?.journal?.name === '示例期刊 A',
    JSON.stringify(submission?.rounds[0]));

  // 同状态转投：不写一条“状态没变”的时间线。
  const beforeHistory = getSubmission(db, submissionId)?.history.length ?? 0;
  createSubmissionRound(
    db,
    submissionId,
    {
      journalName: '示例期刊 C',
      journalField: undefined,
      submittedOn: '2026-10-21',
      status: 'pending_initial',
      statusSince: '2026-10-21',
      submissionNumber: null,
      notes: null,
      userId: null,
    },
    NOW,
  );
  const after = getSubmission(db, submissionId);
  check('同状态新增轮次不写空变更时间线', after?.history.length === beforeHistory);
  check('轮次号继续递增', after?.currentRoundNo === 3, String(after?.currentRoundNo));
}

console.log(`\n${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
