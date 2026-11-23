/**
 * 巡检（阶段 6）的验证脚本：`npm run verify-patrol -w @knowpilot/server`。
 *
 * 【为什么这份不碰网络也不花模型钱】巡检本身是 T3：比较时间戳，判据全是确定性的。
 *   要钉死的也正是这些确定性的东西 —— 边界（正好等于阈值算不算超期）、
 *   幂等（跑两遍会不会翻倍）、忽略语义、规则改动是否生效、行级可见。
 *   出一帧网、调一次模型都只会让结论随外部状态漂移，不会让它更可信。
 *
 * 【为什么用临时库 + 直连 repo/HTTP】与 auth-check 同一套路：起一个真的 app、
 *   造几个用户与会话、打真实路由。测的是"成员到底能不能看到别人的待办"
 *   这一类**跨层**的行为，只调 repo 是测不出权限闸门那一段的。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAY_MS, type AdminUsageResponse } from '@knowpilot/shared';
import { createApp } from '../app.ts';
import { createLabModels } from '../agent/models.ts';
import { createSession } from '../auth/session.ts';
import { insertUser } from '../auth/users.ts';
import { ruleFor } from '../auth/routes.ts';
import type { AppConfig } from '../config.ts';
import { openDb, type Db } from '../db/index.ts';
import { insertSubmission } from '../submissions/repo.ts';
import { insertUsageEvent, listUsageByLocalDay, sumUsageByUser } from '../usage/repo.ts';
import { countOpenTasks, countUserQuotas, dismissTask, listRules, listTasks, updateRule } from './repo.ts';
import { evaluateOverdue, reconcile, type PatrolRuleView } from './scan.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'knowpilot-patrol-verify-'));
const NOW = new Date('2026-10-13T04:00:00.000Z');

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  failures.push(`${name}${detail === '' ? '' : ` —— ${detail}`}`);
  console.log(`  ✗ ${name}${detail === '' ? '' : ` —— ${detail}`}`);
}

function buildConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    dbPath: join(ROOT, 'knowpilot.db'),
    uploadDir: join(ROOT, 'uploads'),
    repoRoot: ROOT,
    deepseekApiKey: undefined,
    modelChat: undefined,
    modelReasoner: undefined,
    modelBaseUrl: undefined,
    hfHome: join(ROOT, 'hf'),
    embedModelDir: join(ROOT, 'hf', 'knowpilot-models'),
    embedModelId: 'bge-m3',
    embedDtype: 'q8',
    rerankEnabled: false,
    rerankModelId: 'bge-reranker-base',
    rerankDtype: 'q8',
    rerankCandidateDepth: 30,
    rerankTimeoutMs: 3000,
    ocrEnabled: false,
    ocrMaxPages: 1,
    codeRoots: [join(ROOT, 'datasets')],
    dataRoot: join(ROOT, 'datasets'),
    uploadMaxBytes: 1024 * 1024,
    uploadChunkSize: 1024 * 1024,
    uploadSessionTtlDays: 7,
    knowledgeConflictThreshold: 0.82,
    patrolIntervalHours: 24,
    sessionIdleDays: 7,
    sessionMaxDays: 30,
    cookieSecure: false,
    adminUsername: undefined,
    adminPassword: undefined,
    ...overrides,
  };
}

/** 相对"此刻"的 N 天前。对账测试用真实时钟，取值都留了大余量，确定得起来。 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/** 清掉本段造的投稿与待办，免得影响下一段的计数。临时库，随手删。 */
function wipe(db: Db): void {
  db.exec('DELETE FROM patrol_tasks');
  db.exec('DELETE FROM submissions');
}

function insertTestSubmission(
  db: Db,
  opts: { status: string; days: number; userId?: string | null },
): string {
  return insertSubmission(
    db,
    {
      title: `测试投稿-${opts.status}-${opts.days}天`,
      journalId: null,
      status: opts.status as never,
      submittedAt: null,
      notes: null,
      userId: opts.userId ?? null,
    },
    daysAgo(opts.days),
  );
}

async function main(): Promise<void> {

  const cfg = buildConfig();
  const { db, migration } = openDb(cfg.dbPath);
  // createApp 内部会跑 verifyRouteCoverage —— 它能返回本身就是"所有 /api/v1/* 都登记了"。
  const app = createApp({
    db,
    config: cfg,
    schemaVersion: migration.toVersion,
    startedAt: Date.now(),
    models: createLabModels(),
  });

  // 巡检会往 `updated_by` / `dismissed_by` 里写操作人 id，两列都有指向 users 的外键，
  // 所以得有一个**真实存在**的用户。用它的 id，而不是随手编一个字符串 ——
  // 编的字符串会被外键挡下（这正是"谁改的"不该是编出来的那件事的体现）。
  const actorId = await insertUser(
    db,
    'PatrolActor',
    { password: 'actor-pw-1234', role: 'admin', displayName: '巡检操作人' },
    NOW,
  );

  // 用量报表的读者：一个 admin（有 usage.read.all）、一个 member（没有）。
  // 前者用来读 /admin/usage，后者用来钉死"成员进不去"。
  const usageAdminId = await insertUser(
    db,
    'PatrolUsageAdmin',
    { password: 'ua-pw-1234', role: 'admin', displayName: '用量管理员' },
    NOW,
  );
  const usageMemberId = await insertUser(
    db,
    'PatrolUsageMember',
    { password: 'um-pw-1234', role: 'member', displayName: '用量成员' },
    NOW,
  );
  const usageAdminCookie = `kp_session=${createSession(db, { userId: usageAdminId, now: new Date(), idleDays: 7, maxDays: 30, ip: null, userAgent: null }).token}`;
  const usageMemberCookie = `kp_session=${createSession(db, { userId: usageMemberId, now: new Date(), idleDays: 7, maxDays: 30, ip: null, userAgent: null }).token}`;

  // ── 1. 迁移 v18 ────────────────────────────────────────────
  console.log('迁移 v18');
  {
    const tables = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table'
             AND name IN ('patrol_rules','patrol_tasks','user_quotas') ORDER BY name`,
        )
        .all() as unknown as { name: string }[]
    ).map((r) => r.name);
    check(
      '三张表都在',
      tables.join(',') === 'patrol_rules,patrol_tasks,user_quotas',
      tables.join(','),
    );
    check('schema 至少到 v18', migration.toVersion >= 18, `实际 v${migration.toVersion}`);

    const rules = listRules(db);
    check('patrol_rules 恰四行', rules.length === 4, `实际 ${rules.length}`);
    const byStatus = new Map(rules.map((r) => [r.status, r.thresholdDays]));
    check(
      '阈值是 14 / 60 / 30 / 90',
      byStatus.get('pending_initial') === 14 &&
        byStatus.get('under_review') === 60 &&
        byStatus.get('revision_resubmitted') === 30 &&
        byStatus.get('accepted_pending') === 90,
      JSON.stringify([...byStatus]),
    );
    check('四行默认都启用', rules.every((r) => r.enabled));

    const idx = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_patrol_tasks_live'`)
      .get() as unknown as { sql: string } | undefined;
    check(
      '★ 局部唯一索引在（一条投稿至多一个活待办）',
      idx !== undefined && idx.sql.includes('WHERE') && idx.sql.includes("'open','dismissed'"),
      idx?.sql ?? '(没有这个索引)',
    );

    const quota = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='user_quotas'`)
      .get() as unknown as { sql: string } | undefined;
    check("user_quotas 默认 action_on_exceed = 'record_only'", quota?.sql.includes("'record_only'") === true);
  }

  // ── 2. 纯逻辑：边界 + 非进行中的档 ─────────────────────────
  console.log('判定规则（纯函数）');
  {
    const rules = new Map<string, PatrolRuleView>([
      ['pending_initial', { thresholdDays: 14, enabled: true }],
    ]);
    const now = NOW;
    const at = (days: number): string => new Date(now.getTime() - days * DAY_MS).toISOString();
    const sub = (status: string, days: number): { id: string; userId: null; status: string; updatedAt: string } => ({
      id: `s-${status}-${days}`,
      userId: null,
      status,
      updatedAt: at(days),
    });

    const hits = (status: string, days: number): number =>
      evaluateOverdue([sub(status, days)], rules, now).length;

    check('正好等于阈值（14 天）不算超期', hits('pending_initial', 14) === 0);
    check('阈值 +1 天算超期', hits('pending_initial', 15) === 1);
    check('13.5 天不算（取整天数）', hits('pending_initial', 13.5) === 0);

    for (const s of ['preparing', 'published', 'rejected', 'withdrawn']) {
      check(`「${s}」永不产生命中`, hits(s, 9999) === 0);
    }
    check('认不出的状态不命中', hits('no_such_status', 9999) === 0);

    // 停用的档不命中
    const off = new Map<string, PatrolRuleView>([['pending_initial', { thresholdDays: 14, enabled: false }]]);
    check('规则停用 → 不命中', evaluateOverdue([sub('pending_initial', 9999)], off, now).length === 0);
    // 没有这一档的规则 → 不命中
    check('该档没有规则 → 不命中', evaluateOverdue([sub('under_review', 9999)], rules, now).length === 0);

    // 超期天数如实算出来（留痕用）
    const one = evaluateOverdue([sub('pending_initial', 20)], rules, now);
    check('overdueDays 如实 = 20', one[0]?.overdueDays === 20, String(one[0]?.overdueDays));
    check('thresholdDays 留的是判定时的值', one[0]?.thresholdDays === 14);
  }

  // ── 3. 幂等 ────────────────────────────────────────────────
  console.log('幂等（同一天跑两遍）');
  {
    wipe(db);
    insertTestSubmission(db, { status: 'pending_initial', days: 100 });
    const first = reconcile(db, new Date());
    check('首轮新建 1 条', first.created === 1, JSON.stringify(first));
    const second = reconcile(db, new Date());
    check('次轮新建 0 条（幂等）', second.created === 0, JSON.stringify(second));
    check('次轮也消解 0 条', second.resolved === 0);
    check('待办总数仍是 1', countOpenTasks(db) === 1);
  }

  // ── 4. 投稿一动 → 重建 / 消解 ──────────────────────────────
  console.log('投稿改动后的对账');
  {
    wipe(db);
    const id = insertTestSubmission(db, { status: 'pending_initial', days: 100 });
    reconcile(db, new Date());
    const before = listTasks(db, 10, { userId: '', canManageAll: true })[0];
    check('测试前提：已有一条待办', before !== undefined);

    // 改成 90 天前 —— 仍然超期，但版本变了
    const newer = daysAgo(90);
    db.prepare('UPDATE submissions SET updated_at = ? WHERE id = ?').run(newer, id);
    const r = reconcile(db, new Date());
    check('★ 版本变了 → 旧的消解、新的重建', r.resolved === 1 && r.created === 1, JSON.stringify(r));
    const live = listTasks(db, 10, { userId: '', canManageAll: true });
    check('活待办仍是 1 条', live.length === 1, `实际 ${live.length}`);
    check('新待办的 observedUpdatedAt 跟上了新版本', live[0]?.observedUpdatedAt === newer);
    check('仍然只有 1 条 open', countOpenTasks(db) === 1);

    // 改成终态 → 不再超期
    db.prepare(`UPDATE submissions SET status = 'published', updated_at = ? WHERE id = ?`).run(
      daysAgo(200),
      id,
    );
    const r2 = reconcile(db, new Date());
    check('★ 进终态 → 待办被消解', r2.resolved === 1 && r2.created === 0, JSON.stringify(r2));
    check('没有活待办了', countOpenTasks(db) === 0);
  }

  // ── 5. 忽略语义 ────────────────────────────────────────────
  console.log('忽略');
  {
    wipe(db);
    const id = insertTestSubmission(db, { status: 'pending_initial', days: 100 });
    reconcile(db, new Date());
    const task = listTasks(db, 10, { userId: '', canManageAll: true })[0];
    if (task === undefined) throw new Error('测试前提不成立：忽略段开始时没有待办');

    const dismissed = dismissTask(
      db,
      task.id,
      { userId: actorId, canManageAll: true },
      '已知，暂不处理',
      new Date().toISOString(),
    );
    check('忽略后状态变 dismissed', dismissed?.status === 'dismissed');
    check('记下了忽略理由', dismissed?.dismissReason === '已知，暂不处理');

    const again = reconcile(db, new Date());
    check('★ 同版本重跑不重建忽略过的待办', again.created === 0 && again.resolved === 0, JSON.stringify(again));
    const stillThere = listTasks(db, 10, { userId: '', canManageAll: true });
    check('忽略的那条还在（dismissed）', stillThere.length === 1 && stillThere[0]?.status === 'dismissed');

    // 版本一变且仍超期 → 生成**新**的 open
    const newer = daysAgo(95);
    db.prepare('UPDATE submissions SET updated_at = ? WHERE id = ?').run(newer, id);
    const r = reconcile(db, new Date());
    check('★ 版本变了 → 重新生成新待办', r.created === 1 && r.resolved === 1, JSON.stringify(r));
    const after = listTasks(db, 10, { userId: '', canManageAll: true });
    check('新待办是 open', after.length === 1 && after[0]?.status === 'open');
  }

  // ── 6. 规则改动生效 ────────────────────────────────────────
  console.log('规则改动');
  {
    wipe(db);
    insertTestSubmission(db, { status: 'pending_initial', days: 10 });
    const r1 = reconcile(db, new Date());
    check('10 天 < 默认 14 天 → 不生成待办', r1.created === 0 && countOpenTasks(db) === 0, JSON.stringify(r1));

    const lowered = updateRule(db, 'pending_initial', { thresholdDays: 5 }, actorId, new Date().toISOString());
    check('改阈值返回了更新后的规则', lowered?.thresholdDays === 5);
    const r2 = reconcile(db, new Date());
    check('★ 阈值改小 → 该档开始命中', r2.created === 1, JSON.stringify(r2));

    const disabled = updateRule(db, 'pending_initial', { enabled: false }, actorId, new Date().toISOString());
    check('停用返回 enabled=false', disabled?.enabled === false);
    const r3 = reconcile(db, new Date());
    check('★ 停用 → 已有的被消解、不再生成', r3.resolved === 1 && r3.created === 0, JSON.stringify(r3));
    check('没有活待办', countOpenTasks(db) === 0);

    // 恢复默认，免得影响后面的段落（临时库其实不必，但保持状态干净）
    updateRule(db, 'pending_initial', { thresholdDays: 14, enabled: true }, actorId, new Date().toISOString());
    check('更新人能查到（updatedByName 走 JOIN）', listRules(db).find((x) => x.status === 'pending_initial')?.updatedBy === actorId);
  }

  // ── 7. 行级可见（走真实 HTTP）──────────────────────────────
  console.log('行级可见');
  {
    wipe(db);
    const memberId = await insertUser(db, 'PatrolMember', { password: 'member-pw-1234', role: 'member', displayName: '成员甲' }, NOW);
    const adminId = await insertUser(db, 'PatrolAdmin', { password: 'admin-pw-1234', role: 'admin', displayName: '管理员' }, NOW);
    const memberCookie = `kp_session=${createSession(db, { userId: memberId, now: new Date(), idleDays: 7, maxDays: 30, ip: null, userAgent: null }).token}`;
    const adminCookie = `kp_session=${createSession(db, { userId: adminId, now: new Date(), idleDays: 7, maxDays: 30, ip: null, userAgent: null }).token}`;

    insertTestSubmission(db, { status: 'pending_initial', days: 100, userId: memberId });
    const orphanId = insertTestSubmission(db, { status: 'pending_initial', days: 100, userId: null });
    reconcile(db, new Date());

    const getTasks = async (cookie: string): Promise<{ items: { id: string; ownerId: string | null; targetId: string; status: string }[] }> => {
      const res = await app.request('/api/v1/patrol/tasks', { headers: { cookie } });
      return (await res.json()) as never;
    };

    const memberView = await getTasks(memberCookie);
    check('成员只看到自己投稿的待办', memberView.items.length === 1, `实际 ${memberView.items.length}`);
    check('看到的那条确实是自己的', memberView.items[0]?.ownerId === memberId);

    const adminView = await getTasks(adminCookie);
    check('管理员看到全部', adminView.items.length === 2, `实际 ${adminView.items.length}`);
    check('含那条无主投稿的待办', adminView.items.some((t) => t.targetId === orphanId));

    const orphanTask = adminView.items.find((t) => t.targetId === orphanId);
    check('测试前提：无主待办存在', orphanTask !== undefined);
    const denied = await app.request(`/api/v1/patrol/tasks/${orphanTask?.id ?? 'x'}/dismiss`, {
      method: 'POST',
      headers: { cookie: memberCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    check('★ 成员忽略别人的（无主）待办 → 404', denied.status === 404, String(denied.status));

    const mine = memberView.items[0];
    const ok = await app.request(`/api/v1/patrol/tasks/${mine?.id ?? 'x'}/dismiss`, {
      method: 'POST',
      headers: { cookie: memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: '我自己处理' }),
    });
    check('成员能忽略自己的待办', ok.status === 200, String(ok.status));
    const after = await getTasks(memberCookie);
    check('忽略后仍是同一条（状态变 dismissed）', after.items[0]?.status === 'dismissed');

    // 管理端规则接口：成员进不去
    const rulesAsMember = await app.request('/api/v1/patrol/rules', { headers: { cookie: memberCookie } });
    check('★ 成员进不了规则接口（patrol.manage）', rulesAsMember.status === 403, String(rulesAsMember.status));
    const rulesAsAdmin = await app.request('/api/v1/patrol/rules', { headers: { cookie: adminCookie } });
    check('管理员能读规则', rulesAsAdmin.status === 200);
  }

  // ── 8. 用量聚合（按人 / 按本地日）───────────────────────────
  console.log('用量聚合');
  {
    db.exec('DELETE FROM usage_events'); // 本段自造自清，临时库

    const event = (o: {
      userId: string | null;
      cost: number;
      input: number;
      createdAt: string;
    }): void => {
      insertUsageEvent(db, {
        eventId: randomUUID(),
        runId: null,
        userId: o.userId,
        model: 'deepseek-chat',
        purpose: 'generate',
        inputTokens: o.input,
        outputTokens: 10,
        cacheRead: 0,
        cacheCreation: 0,
        costUsd: o.cost,
        durationMs: 100,
        createdAt: o.createdAt,
      });
    };

    // ① 按人：两个人各若干次 + 一条无归属
    event({ userId: actorId, cost: 1, input: 100, createdAt: '2026-10-13T02:00:00.000Z' });
    event({ userId: actorId, cost: 3, input: 200, createdAt: '2026-10-13T03:00:00.000Z' });
    event({ userId: usageMemberId, cost: 5, input: 50, createdAt: '2026-10-13T04:00:00.000Z' });
    event({ userId: null, cost: 0.5, input: 20, createdAt: '2026-10-13T05:00:00.000Z' });

    const byUser = sumUsageByUser(db);
    check('按人分成三桶（含无归属）', byUser.length === 3, `实际 ${byUser.length}`);
    check(
      '花得多的在前',
      byUser[0]?.userId === usageMemberId,
      byUser.map((b) => b.userId).join(','),
    );
    const actorBucket = byUser.find((b) => b.userId === actorId);
    check(
      '同一个人的两次调用累成一条',
      actorBucket?.totals.calls === 2 && actorBucket?.totals.costUsd === 4,
      JSON.stringify(actorBucket?.totals),
    );
    const orphan = byUser.find((b) => b.userId === null);
    check(
      '★ 无归属自成一桶（阶段 1–3 的花费不丢）',
      orphan?.totals.calls === 1 && orphan?.totals.costUsd === 0.5,
      JSON.stringify(orphan?.totals),
    );
    check('取到了显示名（LEFT JOIN users）', actorBucket?.displayName === '巡检操作人', String(actorBucket?.displayName));

    // ② 走真实 HTTP：管理员拿得到，成员被挡在门外
    const adminRes = await app.request('/api/v1/admin/usage', { headers: { cookie: usageAdminCookie } });
    check('管理员能读 /admin/usage', adminRes.status === 200, String(adminRes.status));
    const usage = (await adminRes.json()) as AdminUsageResponse;
    check('合计与按人分桶一致（4 次调用）', usage.total.calls === 4, JSON.stringify(usage.total));
    check('byUser 三个桶', usage.byUser.length === 3, `实际 ${usage.byUser.length}`);
    check('★ 无归属桶带 isUnattributed 标记', usage.byUser.some((b) => b.isUnattributed === true));
    check('since 缺省回 null（统计范围 = 全部历史）', usage.since === null, String(usage.since));
    check('byDay 也回来了', usage.byDay.length >= 1, `实际 ${usage.byDay.length}`);

    const memberRes = await app.request('/api/v1/admin/usage', { headers: { cookie: usageMemberCookie } });
    check('★ 成员进不了 /admin/usage（usage.read.all）', memberRes.status === 403, String(memberRes.status));

    const badSince = await app.request('/api/v1/admin/usage?since=nope', {
      headers: { cookie: usageAdminCookie },
    });
    check('★ 认不出的 since → 400（不静默当全部历史）', badSince.status === 400, String(badSince.status));

    // ③ 按本地日：本地 00:10 与 23:50 只差 20 分钟，却跨了本地日界
    db.exec('DELETE FROM usage_events');
    const early = new Date(2026, 9, 13, 0, 10).toISOString(); // 本地 10-13 00:10
    const late = new Date(2026, 9, 12, 23, 50).toISOString(); // 本地 10-12 23:50
    event({ userId: actorId, cost: 1, input: 1, createdAt: early });
    event({ userId: actorId, cost: 2, input: 2, createdAt: late });

    const byDay = listUsageByLocalDay(db);
    check('★ 相隔 20 分钟也跨成两个桶（按本地日）', byDay.length === 2, `实际 ${byDay.length}`);
    const day13 = byDay.find((d) => d.day === '2026-10-13');
    const day12 = byDay.find((d) => d.day === '2026-10-12');
    check('早的那条落在本地 10-13（cost 1）', day13?.totals.costUsd === 1, JSON.stringify(day13));
    check('晚的那条落在本地 10-12（cost 2）', day12?.totals.costUsd === 2, JSON.stringify(day12));
    // 【这条的咬合力在东八区】early 的 UTC 日是 10-12 —— `substr(created_at,1,10)`
    // 会把它归到 10-12，与"本地 10-13"差一天。用一个独立的本地日推算
    // （toLocaleDateString('en-CA')）核对，而不是重抄一遍 dayOf。
    check(
      '★ 归的是本地日，不是 UTC 日',
      day13?.day === new Date(early).toLocaleDateString('en-CA') && day13?.day === '2026-10-13',
      `桶日 ${day13?.day} / UTC 日 ${early.slice(0, 10)}`,
    );
    check('最近的本地日在最前', byDay[0]?.day === '2026-10-13', byDay.map((d) => d.day).join(','));
  }

  // ── 9. 配额（只建表、不阻断）───────────────────────────────
  console.log('配额');
  {
    check('user_quotas 初始为空（本阶段不提供设置入口）', countUserQuotas(db) === 0, `实际 ${countUserQuotas(db)}`);

    const before = (await (
      await app.request('/api/v1/admin/usage', { headers: { cookie: usageAdminCookie } })
    ).json()) as AdminUsageResponse;
    check('★ 未配置 → quota.configured=false', before.quota.configured === false);

    // 插一行，证明 configured 的判据是"表里有没有行"，而不是写死的 false。
    db.prepare(
      `INSERT INTO user_quotas (user_id, period, token_limit, cost_limit, action_on_exceed, updated_at)
       VALUES (?, 'monthly', 1000000, 10.0, 'record_only', ?)`,
    ).run(actorId, new Date().toISOString());
    check('插入一行后 countUserQuotas 认得出来', countUserQuotas(db) === 1);

    const after = (await (
      await app.request('/api/v1/admin/usage', { headers: { cookie: usageAdminCookie } })
    ).json()) as AdminUsageResponse;
    check('★ 配了行 → quota.configured=true（判据来自数据）', after.quota.configured === true);

    const row = db
      .prepare('SELECT action_on_exceed FROM user_quotas WHERE user_id = ?')
      .get(actorId) as unknown as { action_on_exceed: string };
    check('默认动作是 record_only（只记录、不阻断）', row.action_on_exceed === 'record_only');

    // 收尾：本阶段"未设配额"是常态，把探针行删掉，别影响后续。
    db.prepare('DELETE FROM user_quotas').run();
    check('清空后回到未配置', countUserQuotas(db) === 0);
  }

  // ── 10. 路由登记 ───────────────────────────────────────────
  console.log('路由登记');
  {
    check('createApp 正常启动 = 全部 /api/v1/* 都已登记', true);
    check(
      '规则读写与立即巡检要求 patrol.manage',
      ruleFor('GET', '/api/v1/patrol/rules') === 'patrol.manage' &&
        ruleFor('PATCH', '/api/v1/patrol/rules') === 'patrol.manage' &&
        ruleFor('POST', '/api/v1/patrol/run') === 'patrol.manage',
    );
    check(
      '待办列表与忽略登记 authenticated（行级过滤在 SQL）',
      ruleFor('GET', '/api/v1/patrol/tasks') === 'authenticated' &&
        ruleFor('POST', '/api/v1/patrol/tasks/:id/dismiss') === 'authenticated',
    );
    check('用量报表要求 usage.read.all', ruleFor('GET', '/api/v1/admin/usage') === 'usage.read.all');
  }

  db.close();
  rmSync(ROOT, { recursive: true, force: true });

  console.log('');
  if (failures.length > 0) {
    console.error(`${failures.length} 项断言失败（通过 ${passed} 项）：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`巡检全部通过（${passed} 项）。`);
  }
}

main().catch((err: unknown) => {
  console.error('验证脚本异常退出：', err);
  process.exitCode = 1;
});
