/**
 * 认证与权限地基（阶段 4A）的验证脚本：`npm run verify-auth -w @knowpilot/server`。
 *
 * 【这一份要钉死的是什么】不是"登录能用"，而是**越权不可能**：
 *   没带会话的请求一律 401；有会话但角色不对的一律 403；
 *   投稿台账对登录用户共享读取与订正，删除仍仅管理员；
 *   没登记权限规则的路由让服务**起不来**。
 *   最后一条尤其重要 —— 它把"忘了给新接口加权限"从运行时的静默漏洞
 *   变成了启动期的硬报错。
 *
 * 【为什么走 app.request 而不是起服务再 curl】同 upload-check.ts：
 *   要验的全在 Hono 的中间件与路由里，`app.request()` 走的是同一条路，
 *   只是不过 TCP。省掉的那套夹具本身从没被验证过，出错时很难分辨
 *   是接口坏了还是夹具坏了。
 *
 * 【一个必须记住的坑】`app.request()` 不过网络，浏览器那套
 *   "cookie 自动回传"完全不适用 —— 会话 cookie 必须显式写进请求头。
 *   这里封装成 `api()`，正是为了不让人漏掉它。
 *
 * 【为什么限流断言不是"计时"而是"看状态码"】plan 里写的是"断言未触发
 *   scrypt（计时断言）"。计时断言在本机负载波动时是真会飘的。更硬的证据是：
 *   被限流的请求回的是 **429 而不是 401** —— 而 429 只可能在
 *   `loginLimiter.check()` 那一行抛出，那一行**就在校验口令之前**。
 *   状态码本身证明了执行顺序，不依赖时钟。计时只作为辅助（见下方那一项）。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type {
  AdminOverviewResponse,
  ApiErrorBody,
  CreateUserResponse,
  ListAskRecordsResponse,
  ListSubmissionsResponse,
  ListUsersResponse,
  LoginResponse,
  MeOverviewResponse,
  MeResponse,
  MeUsageResponse,
  ResetPasswordResponse,
  SystemConfigResponse,
  TestModelConnectionResponse,
  UpdateUserResponse,
} from '@knowpilot/shared';
import { createApp } from '../app.ts';
import { createLabModels } from '../agent/models.ts';
import { insertAskRecord } from '../agent/records.ts';
import { embeddingModelKey, type AppConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import type { Db } from '../db/index.ts';
import { getSubmissionFor, insertSubmission, listSubmissions, searchSubmissions } from '../submissions/repo.ts';
import { insertPerson } from '../people/repo.ts';
import { createPatent } from '../patents/repo.ts';
import { insertThesis } from '../theses/repo.ts';
import { insertUsageEvent } from '../usage/repo.ts';
import { getDummyHash, hashPassword, verifyPassword } from './password.ts';
import { LoginRateLimiter } from './rate-limit.ts';
import { ROUTE_PERMISSIONS, ruleFor, verifyRouteCoverage } from './routes.ts';
import { askRecordScope, submissionScope } from './scope.ts';
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  deleteUserSessions,
  resolveSession,
} from './session.ts';
import { countUsers, ensureInitialAdmin, insertUser } from './users.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'knowpilot-auth-'));
const FIXED_NOW = new Date('2026-10-11T04:00:00.000Z');

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
    // 模型层**留空**：这一层的"没有 .env"是默认状态，脚本要靠它断言"空表 + 无 .env
    // → 一切来自内置默认"。要测 `.env` 兜底层时用 overrides 显式传（见第 10 段）。
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
    // 与 dev 环境一致：http 下 cookie 绝不能带 Secure。本脚本会断言响应头里
    // 真的没有它 —— 这正是"登录成功但下一个请求仍 401"那个坑的根因。
    cookieSecure: false,
    adminUsername: undefined,
    adminPassword: undefined,
    ...overrides,
  };
}

async function main(): Promise<void> {
  const cfg = buildConfig();
  const { db, migration } = openDb(cfg.dbPath);
  const app = createApp({
    db,
    config: cfg,
    schemaVersion: migration.toVersion,
    startedAt: Date.now(),
    models: createLabModels(),
  });

  /** 带会话 cookie 打真实路由。`cookie` 省略时就是"没登录"的那条路。 */
  const api = async (
    path: string,
    init: RequestInit = {},
    cookie?: string,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
    };
    if (cookie !== undefined) headers['cookie'] = cookie;
    return app.request(path, { ...init, headers });
  };

  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const bodyOf = async <T>(res: Response): Promise<T> => (await res.json()) as T;

  /** 登录并拿回 cookie 头。失败时断言直接炸在调用处。 */
  async function loginCookie(username: string, password: string): Promise<string> {
    const res = await api('/api/v1/auth/login', json({ username, password }));
    assert.equal(res.status, 200, `登录 ${username} 应当成功`);
    const raw = res.headers.get('set-cookie') ?? '';
    const token = /kp_session=([^;]*)/u.exec(raw)?.[1];
    assert.ok(token !== undefined && token !== '', `响应里应当有 kp_session：${raw}`);
    return `${SESSION_COOKIE}=${token}`;
  }

  console.log(`\n迁移已到 v${migration.toVersion}，临时根目录：${ROOT}\n`);

  // ── 1. 口令哈希 ────────────────────────────────────────────
  console.log('口令哈希：');
  {
    const stored = await hashPassword('正确口令-123456');
    check('往返：对的口令 → true', await verifyPassword('正确口令-123456', stored));
    check('错的口令 → false', (await verifyPassword('错的口令', stored)) === false);
    const parts = stored.split('$');
    check(
      '格式自描述：scrypt$N$r$p$salt$hash 六段',
      parts.length === 6 && parts[0] === 'scrypt' && parts[1] === '16384',
      stored.slice(0, 24),
    );
    check('同一个口令两次哈希不相同（加了盐）', (await hashPassword('x')) !== (await hashPassword('x')));
    check(
      '参数被改坏的存储值 → false，而不是抛异常',
      (await verifyPassword('x', 'scrypt$16384$8$1$!!$!!')) === false,
    );
    check(
      '长度不同的存储值 → false（timingSafeEqual 长度不等会抛，必须先比长度）',
      (await verifyPassword('x', 'scrypt$16384$8$1$YWJj$YWJjZA==')) === false,
    );
    check('dummy hash 可重复取得且格式合法', (await getDummyHash()) === (await getDummyHash()));
  }

  // ── 2. 会话 ────────────────────────────────────────────────
  console.log('\n会话：');
  {
    const uid = await insertUser(db, 'SessUser', { password: 'pw-123456789', role: 'member' }, FIXED_NOW);
    const { token } = createSession(db, {
      userId: uid,
      now: FIXED_NOW,
      idleDays: 7,
      maxDays: 30,
      ip: '10.0.0.1',
      userAgent: 'verify',
    });
    const at = (ms: number): Date => new Date(FIXED_NOW.getTime() + ms);
    const DAY = 86_400_000;

    check('刚建的会话解析得出来，用户名已归一为小写', resolveSession(db, token, FIXED_NOW, 7)?.user.username === 'sessuser');
    check('闲置未超限 → 有效', resolveSession(db, token, at(6 * DAY), 7) !== null);
    check('闲置超过 idleDays → null', resolveSession(db, token, at(8 * DAY), 7) === null);
    check('过期即从库里删掉（不是"查出来再判断"）', countSessions(db, uid) === 0);

    const s2 = createSession(db, { userId: uid, now: FIXED_NOW, idleDays: 7, maxDays: 30, ip: null, userAgent: null });
    check('绝对上限先到 → null（用得再勤也要重登）', resolveSession(db, s2.token, at(31 * DAY), 7) === null);
    check('绝对上限生效时也删掉了行', countSessions(db, uid) === 0);

    const s3 = createSession(db, { userId: uid, now: FIXED_NOW, idleDays: 7, maxDays: 30, ip: null, userAgent: null });
    check('登出 → 该会话失效', deleteSession(db, s3.token) === true && resolveSession(db, s3.token, FIXED_NOW, 7) === null);
    check('登出两次：第二次返回 false（幂等，不报错）', deleteSession(db, s3.token) === false);

    const a = createSession(db, { userId: uid, now: FIXED_NOW, idleDays: 7, maxDays: 30, ip: null, userAgent: null });
    const b = createSession(db, { userId: uid, now: FIXED_NOW, idleDays: 7, maxDays: 30, ip: null, userAgent: null });
    check('同一个人可以有两个会话（两个浏览器）', resolveSession(db, a.token, FIXED_NOW, 7) !== null);
    deleteUserSessions(db, uid);
    check(
      '改密/禁用时一键踢掉全部会话',
      resolveSession(db, a.token, FIXED_NOW, 7) === null && resolveSession(db, b.token, FIXED_NOW, 7) === null,
    );

    // 账号被禁用 → 会话当场吊销，而不是"暂时当作没登录"。
    const s4 = createSession(db, { userId: uid, now: FIXED_NOW, idleDays: 7, maxDays: 30, ip: null, userAgent: null });
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(uid);
    check('账号被禁用 → 会话立即失效', resolveSession(db, s4.token, FIXED_NOW, 7) === null);
    check('禁用时把该用户的会话行也删了（启用后旧 cookie 不会复活）', countSessions(db, uid) === 0);
    db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(uid);
  }

  // ── 3. 初始管理员 ───────────────────────────────────────────
  console.log('\n初始管理员（只在 users 表为空时建）：');
  {
    // 用一个全新的库，免得受上面已经建出来的用户影响。
    const { db: fresh, migration: m2 } = openDb(join(ROOT, 'fresh.db'));
    check('新库里 users 为空', countUsers(fresh) === 0);

    const created = await ensureInitialAdmin(
      fresh,
      { adminUsername: '  Root ', adminPassword: 'root-pw-123456' },
      FIXED_NOW,
    );
    check('配了两个变量 → 建号', created !== null);
    check('用户名被归一为小写', created?.username === 'root');
    check('建出来的确实是 admin', findRole(fresh, 'root') === 'admin');
    check('口令是哈希存的，不是明文', (findHash(fresh, 'root') ?? '').startsWith('scrypt$'));

    const again = await ensureInitialAdmin(
      fresh,
      { adminUsername: 'other', adminPassword: 'other-pw-123456' },
      FIXED_NOW,
    );
    check('users 非空 → 什么都不做（不覆盖、不追加）', again === null && countUsers(fresh) === 1);

    const { db: empty2 } = openDb(join(ROOT, 'noconfig.db'));
    check(
      '没配变量 → 不建号，也不报错',
      (await ensureInitialAdmin(empty2, { adminUsername: undefined, adminPassword: undefined }, FIXED_NOW)) === null,
    );
    empty2.close();
    fresh.close();
    check('m2 拿到的是同一个版本号', m2.toVersion === migration.toVersion);
  }

  // ── 4. 路由权限表 + 启动自检 ────────────────────────────────
  console.log('\n路由权限表与启动自检：');
  {
    // createApp 已经在上面成功返回 —— 那本身就是"覆盖自检通过"的证据：
    // 只要有一条 /api/v1/* 没登记，createApp 会在这里之前就抛出来。
    check('createApp 正常启动 = 现有全部 /api/v1/* 都已登记', true);
    check(
      '登录是 public、登出与 me 是 authenticated',
      ruleFor('POST', '/api/v1/auth/login') === 'public' &&
        ruleFor('POST', '/api/v1/auth/logout') === 'authenticated' &&
        ruleFor('GET', '/api/v1/auth/me') === 'authenticated',
    );
    check('未登记的路由查出来是 undefined（调用方必须当拒绝）', ruleFor('GET', '/api/v1/nope') === undefined);
    check(
      '下载原件要求 knowledge.read（欠账 1）',
      ruleFor('GET', '/api/v1/documents/:id/file') === 'knowledge.read',
    );
    check('删除数据集要求 code.write（欠账 5）', ruleFor('DELETE', '/api/v1/code-assets/:id') === 'code.write');
    check('新增分区要求 journal.add', ruleFor('POST', '/api/v1/journals/:id/rankings') === 'journal.add');
    check(
      '订正分区要求 journal.manage（欠账 6）',
      ruleFor('PATCH', '/api/v1/journals/:id/rankings/:rankingId') === 'journal.manage',
    );
    check(
      '表里没有重复登记（重复会让"改了一处、另一处没改"无法察觉）',
      new Set(ROUTE_PERMISSIONS.map((r) => `${r.method} ${r.path}`)).size === ROUTE_PERMISSIONS.length,
    );

    // 故意漏登记一条 —— 自检必须拦住它。
    const leaky = new Hono();
    leaky.get('/api/v1/secret', (c) => c.text('ok'));
    leaky.get('/health', (c) => c.text('ok'));
    let threw: string | null = null;
    try {
      verifyRouteCoverage(leaky.routes);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    check('有一条未登记的路由 → 自检抛错，服务起不来', threw !== null, String(threw));
    check('报错里点名了那条路由与去哪个文件登记', (threw ?? '').includes('GET /api/v1/secret') && (threw ?? '').includes('ROUTE_PERMISSIONS'));
    check('非 /api/v1 的路径不参与检查（/health 不该被要求登记）', !(threw ?? '').includes('/health'));
  }

  // ── 5. 闸门：未登录 / 角色不足 ───────────────────────────────
  console.log('\n权限闸门：');
  const adminId = await insertUser(db, 'Admin', { password: 'admin-pw-123456', role: 'admin', displayName: '管理员' }, FIXED_NOW);
  const memberId = await insertUser(db, 'Member', { password: 'member-pw-123456', role: 'member', displayName: '成员' }, FIXED_NOW);
  const mentorId = await insertUser(db, 'Mentor', { password: 'mentor-pw-123456', role: 'mentor', displayName: '导师' }, FIXED_NOW);
  const memberCookie = await loginCookie('member', 'member-pw-123456');
  const adminCookie = await loginCookie('admin', 'admin-pw-123456');
  const mentorCookie = await loginCookie('mentor', 'mentor-pw-123456');
  void mentorCookie;

  {
    const anon = await api('/api/v1/submissions');
    const body = await bodyOf<ApiErrorBody>(anon);
    check('没带会话 → 401 unauthenticated', anon.status === 401 && body.error.code === 'unauthenticated', `${anon.status} ${body.error.code}`);
    check('401 的响应体不含堆栈（只有 code/title/message/requestId）', !('stack' in body.error));

    const anonMe = await api('/api/v1/auth/me');
    check('/auth/me 未登录 → 401', anonMe.status === 401);

    const anonHealth = await api('/health');
    check('/health 不需要登录（否则健康检查要带口令）', anonHealth.status === 200);

    const anonNothing = await api('/api/v1/definitely-not-a-route');
    check('不存在的接口 → 404 而不是 403（403 会让人以为"有权限就能用"）', anonNothing.status === 404, String(anonNothing.status));
  }

  {
    const res = await api('/api/v1/auth/login', json({ username: 'member', password: 'member-pw-123456' }));
    const setCookie = res.headers.get('set-cookie') ?? '';
    check('登录成功 → 200，响应体带 user 与 expiresAt', res.status === 200 && (await bodyOf<LoginResponse>(res)).user.username === 'member');
    check('cookie 是 HttpOnly（JS 读不到）', /HttpOnly/iu.test(setCookie), setCookie);
    check('cookie 是 SameSite=Lax（挡跨站 POST）', /SameSite=Lax/iu.test(setCookie), setCookie);
    check(
      '★ dev 的 http 下 cookie **没有** Secure（带了会被浏览器静默丢弃 → "登录成功但仍 401"）',
      !/Secure/iu.test(setCookie),
      setCookie,
    );
  }

  {
    const me = await bodyOf<MeResponse>(await api('/api/v1/auth/me', {}, memberCookie));
    check('member 的权限里有 chat.use，没有 system.config', me.permissions.includes('chat.use') && !me.permissions.includes('system.config'));
    check('member 没有 users.manage / material.manage', !me.permissions.includes('users.manage') && !me.permissions.includes('material.manage'));
    const m = await bodyOf<MeResponse>(await api('/api/v1/auth/me', {}, adminCookie));
    check('admin 拿到全部权限点', m.permissions.length > me.permissions.length && m.permissions.includes('users.manage'));
  }

  {
    // 期刊分区库：新增全员可做（欠账 6 的三档设计），订正/删除只有 admin/mentor。
    const j = await api('/api/v1/journals', json({ name: '权限验证用刊' }), memberCookie);
    check('member 可以新增期刊（journal.add）', j.status === 201 || j.status === 200, String(j.status));
    const journalId = (await bodyOf<{ journal?: { id: string } }>(j)).journal?.id ?? '';

    const add = await api(
      '/api/v1/journals/' + journalId + '/rankings',
      json({ year: 2025, system: '中科院', category: '甲类', rank: '1区', top: true }),
      memberCookie,
    );
    check('member 可以新增分区（journal.add）', add.status === 201 || add.status === 200, String(add.status));
    const rankingId = (await bodyOf<{ ranking?: { id: string } }>(add)).ranking?.id ?? '';

    const patch = await api(
      `/api/v1/journals/${journalId}/rankings/${rankingId}`,
      json({ year: 2025, system: '中科院', category: '甲类', rank: '2区', top: true }, 'PATCH'),
      memberCookie,
    );
    const patchBody = await bodyOf<ApiErrorBody>(patch);
    check(
      '★ member 订正分区 → 403 permission_denied',
      patch.status === 403 && patchBody.error.code === 'permission_denied',
      `${patch.status} ${patchBody.error.code}`,
    );
    const del = await api(`/api/v1/journals/${journalId}/rankings/${rankingId}`, { method: 'DELETE' }, memberCookie);
    check('★ member 删除分区 → 403', del.status === 403, String(del.status));

    const mentorPatch = await api(
      `/api/v1/journals/${journalId}/rankings/${rankingId}`,
      json({ year: 2025, system: '中科院', category: '甲类', rank: '2区', top: true }, 'PATCH'),
      mentorCookie,
    );
    check('mentor 订正分区 → 放行（journal.manage）', mentorPatch.status === 200, String(mentorPatch.status));
  }

  {
    // 文档重建索引：material.manage 只归 admin（按文档 04 §3.2 的模板）。
    const res = await api('/api/v1/documents/nope/reindex', { method: 'POST' }, memberCookie);
    const body = await bodyOf<ApiErrorBody>(res);
    check(
      'member 重建索引 → 403（不是 404 —— 权限先于资源存在性）',
      res.status === 403 && body.error.code === 'permission_denied',
      `${res.status} ${body.error.code}`,
    );
    check('admin 重建索引 → 走到 handler（404 因为文档不存在）', (await api('/api/v1/documents/nope/reindex', { method: 'POST' }, adminCookie)).status === 404);
  }

  // ── 6. 投稿共享读取与订正（GC-10）──────────────────────────
  console.log('\n投稿共享读取与订正（GC-10）：');
  const subA = insertSubmission(db, { title: '甲的稿子', journalId: null, status: 'preparing', submittedAt: null, notes: null, userId: memberId }, FIXED_NOW.toISOString());
  const subB = insertSubmission(db, { title: '乙的稿子', journalId: null, status: 'preparing', submittedAt: null, notes: null, userId: mentorId }, FIXED_NOW.toISOString());
  const subPublic = insertSubmission(db, { title: '阶段一遗留的公共稿子', journalId: null, status: 'preparing', submittedAt: null, notes: null, userId: null }, FIXED_NOW.toISOString());
  {
    const memberScope = submissionScope({ id: memberId, username: 'member', displayName: '成员', role: 'member', groupId: null });
    const adminScope = submissionScope({ id: adminId, username: 'admin', displayName: '管理员', role: 'admin', groupId: null });

    const mine = listSubmissions(db, 50, memberScope).map((s) => s.id);
    check('member 看得到自己的', mine.includes(subA));
    check('member 看得到归属为 NULL 的公共历史数据', mine.includes(subPublic));
    check('★ member 看得到别人的投稿', mine.includes(subB));

    const all = listSubmissions(db, 50, adminScope).map((s) => s.id);
    check('admin 看得到全部三条', [subA, subB, subPublic].every((id) => all.includes(id)));

    check('搜索路径同样可查他人投稿（Agent 工具走这条）', searchSubmissions(db, { keyword: '乙的稿子', status: undefined, limit: 50, scope: memberScope }).some((s) => s.id === subB));
    check('搜索能查到自己的', searchSubmissions(db, { keyword: '甲的稿子', status: undefined, limit: 50, scope: memberScope }).some((s) => s.id === subA));

    check('★ 取别人的详情 → 有（只读）', getSubmissionFor(db, subB, memberScope) !== null);
    check('取自己的详情 → 有', getSubmissionFor(db, subA, memberScope) !== null);
    check('admin 取任何一条 → 有', getSubmissionFor(db, subB, adminScope) !== null);
    check('没有身份的范围只能看公共数据', listSubmissions(db, 50, { userId: '', canReadAll: false, canReadGroup: false, groupId: null }).every((s) => s.id === subPublic));

    // 走 HTTP 再验一遍：证明 handler 真的把 scope 传下去了（而不是 repo 层对、接线层漏）。
    const httpMine = await bodyOf<ListSubmissionsResponse>(await api('/api/v1/submissions', {}, memberCookie));
    const httpIds = httpMine.items.map((s) => s.id);
    check('HTTP：member 的列表含全部三条', [subA, subB, subPublic].every((id) => httpIds.includes(id)));
    const otherRounds = await api(`/api/v1/submissions/${subB}/rounds`, {}, memberCookie);
    check('HTTP：member 可读取他人投稿轮次', otherRounds.status === 200, String(otherRounds.status));
    const quickSearch = await api('/api/v1/quick-search?q=%E4%B9%99%E7%9A%84%E7%A8%BF%E5%AD%90', {}, memberCookie);
    check('HTTP：全局搜索可找到他人投稿', quickSearch.status === 200 && (await quickSearch.text()).includes('乙的稿子'));
    const httpAll = await bodyOf<ListSubmissionsResponse>(await api('/api/v1/submissions', {}, adminCookie));
    check('HTTP：admin 的列表是三条', [subA, subB, subPublic].every((id) => httpAll.items.some((s) => s.id === id)));
  }

  {
    const other = await api(`/api/v1/submissions/${subB}/status`, json({ status: 'under_review' }), memberCookie);
    check('member 不能改他人的投稿状态', other.status === 403);
    const mentorStatus = await api(`/api/v1/submissions/${subB}/status`, json({ status: 'under_review' }), mentorCookie);
    check('导师可以更新本人投稿', mentorStatus.status === 200);
    const otherSameStatus = await api(`/api/v1/submissions/${subB}/status`, json({ status: 'under_review' }), mentorCookie);
    check('相同状态不能重复记入轨迹 → 400', otherSameStatus.status === 400, String(otherSameStatus.status));
    const roundBody = json({
      journalName: '跨账号期刊', submittedOn: '2026-10-10', status: 'pending_initial',
      statusSince: '2026-10-10', submissionNumber: 'CROSS-001',
    });
    check('member 不能给他人投稿新增轮次',
      (await api(`/api/v1/submissions/${subB}/rounds`, roundBody, memberCookie)).status === 403);
    check('管理员可新增他人投稿轮次',
      (await api(`/api/v1/submissions/${subB}/rounds`, roundBody, adminCookie)).status === 201);
    const submissionRevision = (db.prepare('SELECT revision FROM submissions WHERE id = ?').get(subB) as { revision: number }).revision;
    const editBody = json({
      expectedRevision: submissionRevision,
      title: '订正后的乙稿', algorithmAbbr: 'Corrected', submitterName: '新投稿人',
      journalName: '订正后的期刊', submittedOn: '2026-10-09',
      statusSince: '2026-10-11', submissionNumber: 'CROSS-002', notes: '日期与姓名已订正',
    }, 'PATCH');
    check('member 不能订正他人投稿',
      (await api(`/api/v1/submissions/${subB}`, editBody, memberCookie)).status === 403);
    check('管理员可订正他人投稿',
      (await api(`/api/v1/submissions/${subB}`, editBody, adminCookie)).status === 200);
    const edited = getSubmissionFor(db, subB, submissionScope({ id: memberId, username: 'member', displayName: '成员', role: 'member', groupId: null }));
    check('订正后主记录和当前轮次一致，旧轮次保留',
      edited?.title === '订正后的乙稿' && edited.submitterName === '新投稿人' &&
      edited.journal?.name === '订正后的期刊' && edited.submittedOn === '2026-10-09' &&
      edited.statusSince === '2026-10-11' && edited.submissionNumber === 'CROSS-002' &&
      edited.rounds.at(-1)?.submissionNumber === 'CROSS-002' &&
      edited.rounds[0]?.journal === null);
    check('投稿资料订正记录了标题和投稿人变更', edited?.edits[0]?.changes['title']?.before === '乙的稿子' &&
      edited.edits[0]?.changes['submitterName']?.after === '新投稿人');
    check('旧版本不能覆盖刚保存的投稿资料',
      (await api(`/api/v1/submissions/${subB}`, json({ expectedRevision: submissionRevision, notes: '旧表单覆盖' }, 'PATCH'), mentorCookie)).status === 409);
    check('资料订正不能绕过状态时间线',
      (await api(`/api/v1/submissions/${subB}`, json({ status: 'published' }, 'PATCH'), mentorCookie)).status === 400);
    check('资料订正拒绝无效日期',
      (await api(`/api/v1/submissions/${subB}`, json({ expectedRevision: edited?.revision, submittedOn: '2026-02-30' }, 'PATCH'), mentorCookie)).status === 400);
    const pub = await api(`/api/v1/submissions/${subPublic}/status`, json({ status: 'under_review' }), memberCookie);
    check('member 不能更新无录入账号的投稿', pub.status === 403);
    check('导师可补订无录入账号的投稿',
      (await api(`/api/v1/submissions/${subPublic}/status`, json({ status: 'under_review' }), mentorCookie)).status === 200);
    const mineStatus = await api(`/api/v1/submissions/${subA}/status`, json({ status: 'under_review' }), memberCookie);
    check('member 改自己的状态 → 200', mineStatus.status === 200, String(mineStatus.status));
    const adminStatus = await api(`/api/v1/submissions/${subB}/status`, json({ status: 'under_review' }), adminCookie);
    check('admin 可改任何一条 → 200', adminStatus.status === 200, String(adminStatus.status));
    check(
      '改状态落库时记下了"是谁改的"',
      (db.prepare('SELECT changed_by FROM submission_history WHERE submission_id = ? ORDER BY changed_at DESC LIMIT 1').get(subA) as unknown as { changed_by: string | null }).changed_by === memberId,
    );
    check('导师可以代改成员的投稿进展',
      (await api(`/api/v1/submissions/${subA}/status`, json({ status: 'pending_initial' }), mentorCookie)).status === 200);
  }

  // ── 7. 人员成果共享读取，敏感字段与写入保持原边界 ───────────
  {
    const mistaken = insertSubmission(db, {
      title: '误录待删除稿件', journalId: null, status: 'preparing',
      submittedAt: null, notes: null, userId: memberId,
    }, FIXED_NOW.toISOString());
    db.prepare(
      `INSERT INTO submission_history
        (id, submission_id, from_status, to_status, changed_by, changed_at, note)
       VALUES (?, ?, NULL, 'preparing', ?, ?, NULL)`,
    ).run(randomUUID(), mistaken, memberId, FIXED_NOW.toISOString());
    db.prepare(
      `INSERT INTO patrol_tasks
        (id, target_type, target_id, owner_id, status, threshold_days, overdue_days,
         observed_updated_at, created_at)
       VALUES (?, 'submission', ?, ?, 'open', 14, 1, ?, ?)`,
    ).run(randomUUID(), mistaken, memberId, FIXED_NOW.toISOString(), FIXED_NOW.toISOString());
    const batchId = randomUUID();
    db.prepare(
      `INSERT INTO ledger_import_batches
        (id, file_name, file_hash, stored_path, uploaded_by, status, created_at, updated_at)
       VALUES (?, 'fixture.xlsx', 'fixture', 'fixture.xlsx', ?, 'imported', ?, ?)`,
    ).run(batchId, memberId, FIXED_NOW.toISOString(), FIXED_NOW.toISOString());
    const importRowId = randomUUID();
    db.prepare(
      `INSERT INTO ledger_import_rows
        (id, batch_id, sheet_name, row_no, target, raw_json, normalized_json,
         issues_json, status, target_id, created_at, updated_at)
       VALUES (?, ?, '论文', 2, 'submission', '{}', '{}', '[]', 'imported', ?, ?, ?)`,
    ).run(importRowId, batchId, mistaken, FIXED_NOW.toISOString(), FIXED_NOW.toISOString());

    check('mentor 不能删除成员的误录投稿',
      (await api(`/api/v1/submissions/${mistaken}`, { method: 'DELETE' }, mentorCookie)).status === 403);
    check('未登录不能删除投稿',
      (await api(`/api/v1/submissions/${mistaken}`, { method: 'DELETE' })).status === 401);
    check('越权请求没有删除记录', getSubmissionFor(db, mistaken,
      submissionScope({ id: memberId, username: 'member', displayName: '成员', role: 'member', groupId: null })) !== null);
    const deleted = await api(`/api/v1/submissions/${mistaken}`, { method: 'DELETE' }, memberCookie);
    check('成员可删除自己录入的投稿并收到标题', deleted.status === 200 &&
      (await deleted.text()).includes('误录待删除稿件'));
    const active = await bodyOf<ListSubmissionsResponse>(await api('/api/v1/submissions', {}, adminCookie));
    const tasks = await api('/api/v1/patrol/tasks', {}, memberCookie);
    check('已删除投稿从列表、投稿轮次、搜索和巡检待办隐藏',
      !active.items.some((item) => item.id === mistaken) &&
      (await api(`/api/v1/submissions/${mistaken}/rounds`, {}, adminCookie)).status === 404 &&
      !(await (await api('/api/v1/quick-search?q=' + encodeURIComponent('误录待删除稿件'), {}, memberCookie)).text()).includes(mistaken) &&
      !(await tasks.text()).includes(mistaken));
    for (const [table, column] of [
      ['submissions', 'id'], ['submission_rounds', 'submission_id'],
      ['submission_history', 'submission_id'], ['patrol_tasks', 'target_id'],
    ]) {
      const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
        .get(mistaken) as { n: number };
      check(`删除保留 ${table} 供恢复`, count.n === 1, String(count.n));
    }
    const audit = db.prepare(
      'SELECT id, title, deleted_by FROM ledger_deletions WHERE kind = ? AND record_id = ?',
    ).get('submission', mistaken) as { id: string; title: string; deleted_by: string };
    check('删除审计保留标题与成员身份',
      audit.title === '误录待删除稿件' && audit.deleted_by === memberId);
    const importRow = db.prepare(
      'SELECT target_id, result_message FROM ledger_import_rows WHERE id = ?',
    ).get(importRowId) as { target_id: string | null; result_message: string | null } | undefined;
    check('Excel 草稿保留关联，恢复后仍指向原投稿', importRow?.target_id === mistaken);
    check('重复删除返回 404',
      (await api(`/api/v1/submissions/${mistaken}`, { method: 'DELETE' }, adminCookie)).status === 404);
    check('删除消息仅导师和管理员可见',
      (await api('/api/v1/ledger-deletions', {}, memberCookie)).status === 403 &&
      (await (await api('/api/v1/ledger-deletions', {}, mentorCookie)).text()).includes(audit.id) &&
      (await (await api('/api/v1/ledger-deletions', {}, adminCookie)).text()).includes(audit.id));
    const restorePath = `/api/v1/ledger-deletions/${audit.id}/restore`;
    check('仅管理员可恢复',
      (await api(restorePath, json({}), memberCookie)).status === 403 &&
      (await api(restorePath, json({}), mentorCookie)).status === 403 &&
      (await api(restorePath, json({}), adminCookie)).status === 200);
    check('恢复后可读原投稿轮次，重复恢复返回 404',
      (await api(`/api/v1/submissions/${mistaken}/rounds`, {}, memberCookie)).status === 200 &&
      (await api(restorePath, json({}), adminCookie)).status === 404);
    check('删除其他记录不受影响', getSubmissionFor(db, subA,
      submissionScope({ id: memberId, username: 'member', displayName: '成员', role: 'member', groupId: null })) !== null);
  }

  // ── 7. 人员成果共享读取，敏感字段与写入保持原边界 ───────────
  console.log('\n人员成果档案共享读取：');
  {
    const personId = insertPerson(db, {
      name: '跨账号成果人员', studentNo: 'TEST-PRIVATE-2026', groupId: null,
      status: 'active', userId: mentorId, note: null, createdBy: adminId,
    }, FIXED_NOW.toISOString());
    const patentId = createPatent(db, {
      name: '跨账号成果专利', patentNo: 'TEST-PATENT-2026', applicantName: '跨账号成果人员',
      applicantPersonId: personId, firstSubmittedOn: null, substantiveExamOn: null,
      publishedOn: null, notes: null, ownerUserId: mentorId, createdBy: mentorId,
    }, FIXED_NOW.toISOString());
    const thesisId = insertThesis(db, {
      personId, authorName: '跨账号成果人员', direction: '图像处理',
      title: '跨账号成果大论文', grade: 'TEST-PRIVATE-GRADE', notes: null, createdBy: mentorId,
    }, FIXED_NOW.toISOString());

    const patents = await api('/api/v1/patents', {}, memberCookie);
    check('HTTP：member 可在专利列表看到导师的记录', patents.status === 200 && (await patents.text()).includes(patentId));
    const patentDetail = await api(`/api/v1/patents/${patentId}`, {}, memberCookie);
    check('HTTP：member 可读取导师专利详情', patentDetail.status === 200 && (await patentDetail.text()).includes('跨账号成果专利'));
    const patentRevision = (db.prepare('SELECT revision FROM patents WHERE id = ?').get(patentId) as { revision: number }).revision;
    const editPatentBody = json({
      expectedRevision: patentRevision,
      name: '订正后的专利名称', applicantName: '订正后的申请人',
      firstSubmittedOn: '2026-10-01', notes: '补充说明',
    }, 'PATCH');
    check('member 不能编辑或删除导师录入的专利',
      (await api(`/api/v1/patents/${patentId}`, editPatentBody, memberCookie)).status === 403 &&
      (await api(`/api/v1/patents/${patentId}`, { method: 'DELETE' }, memberCookie)).status === 403);
    check('管理员可订正导师录入的专利',
      (await api(`/api/v1/patents/${patentId}`, editPatentBody, adminCookie)).status === 200);
    const patentAfter = await bodyOf<{ patent: { name: string; applicantName: string | null; firstSubmittedOn: string | null } }>(
      await api(`/api/v1/patents/${patentId}`, {}, memberCookie),
    );
    check('专利订正结果可读回', patentAfter.patent.name === '订正后的专利名称' &&
      patentAfter.patent.applicantName === '订正后的申请人' && patentAfter.patent.firstSubmittedOn === '2026-10-01');
    check('旧版本不能覆盖专利，申请人订正留痕',
      (await api(`/api/v1/patents/${patentId}`, json({ expectedRevision: patentRevision, notes: '旧表单' }, 'PATCH'), mentorCookie)).status === 409 &&
      (db.prepare("SELECT changes_json FROM record_edit_audits WHERE record_type = 'patent' AND record_id = ?").get(patentId) as { changes_json: string } | undefined)?.changes_json.includes('applicantName') === true);

    const people = await bodyOf<{ items: { id: string; studentNo: string | null; studentNoVisible: boolean }[] }>(
      await api('/api/v1/people', {}, memberCookie),
    );
    const person = people.items.find((p) => p.id === personId);
    check('HTTP：member 可见他人人员档案及完整学号', person !== undefined && person.studentNo === 'TEST-PRIVATE-2026' && person.studentNoVisible);
    const theses = await bodyOf<{ items: { id: string; grade: string | null; gradeVisible: boolean }[] }>(
      await api('/api/v1/theses', {}, memberCookie),
    );
    const thesis = theses.items.find((t) => t.id === thesisId);
    check('HTTP：member 可见他人大论文及成绩', thesis !== undefined && thesis.grade === 'TEST-PRIVATE-GRADE' && thesis.gradeVisible);
    const thesisRevision = (db.prepare('SELECT revision FROM theses WHERE id = ?').get(thesisId) as { revision: number }).revision;
    const editThesisBody = json({
      expectedRevision: thesisRevision,
      authorName: '订正后的作者', title: '订正后的论文题目', grade: '优', direction: '遥感',
    }, 'PATCH');
    check('member 不能编辑他人大论文资料和成绩',
      (await api(`/api/v1/theses/${thesisId}`, editThesisBody, memberCookie)).status === 403);
    check('管理员可编辑他人大论文资料和成绩',
      (await api(`/api/v1/theses/${thesisId}`, editThesisBody, adminCookie)).status === 200);
    const thesisAfter = await bodyOf<{ thesis: { authorName: string; title: string | null; grade: string | null } }>(
      await api(`/api/v1/theses/${thesisId}`, {}, memberCookie),
    );
    check('大论文订正结果可读回', thesisAfter.thesis.authorName === '订正后的作者' &&
      thesisAfter.thesis.title === '订正后的论文题目' && thesisAfter.thesis.grade === '优');
    check('旧版本不能覆盖大论文，成绩订正留痕',
      (await api(`/api/v1/theses/${thesisId}`, json({ expectedRevision: thesisRevision, notes: '旧表单' }, 'PATCH'), mentorCookie)).status === 409 &&
      (db.prepare("SELECT changes_json FROM record_edit_audits WHERE record_type = 'thesis' AND record_id = ?").get(thesisId) as { changes_json: string } | undefined)?.changes_json.includes('grade') === true);

    const authorId = insertPerson(db, {
      name: '成员作者', studentNo: null, groupId: null, status: 'active', userId: memberId, note: null, createdBy: adminId,
    }, FIXED_NOW.toISOString());
    const delegatedThesis = insertThesis(db, {
      personId: authorId, authorName: '成员作者', direction: null, title: null,
      grade: null, notes: null, createdBy: mentorId,
    }, FIXED_NOW.toISOString());
    const delegatedPath = `/api/v1/theses/${delegatedThesis}`;
    check('作者可以填写导师代录论文的成绩',
      (await api(delegatedPath, json({ expectedRevision: 0, grade: '优' }, 'PATCH'), memberCookie)).status === 200);
    check('作者代录记录的成绩权限不含资料和删除权限',
      (await api(delegatedPath, json({ expectedRevision: 1, grade: '良', title: '改题目' }, 'PATCH'), memberCookie)).status === 403 &&
      (await api(delegatedPath, { method: 'DELETE' }, memberCookie)).status === 403);

    const ownThesis = await bodyOf<{ thesis: { id: string; revision: number } }>(await api('/api/v1/theses', json({
      personId: authorId, grade: '良',
    }), memberCookie));
    const ownPath = `/api/v1/theses/${ownThesis.thesis.id}`;
    check('普通录入人不能更换已有成绩的关联作者',
      (await api(ownPath, json({ expectedRevision: ownThesis.thesis.revision, personId }, 'PATCH'), memberCookie)).status === 403);
    check('普通成员不能给他人代填成绩',
      (await api('/api/v1/theses', json({ personId, grade: '良' }), memberCookie)).status === 403);
    for (const [kind, path, recorder] of [
      ['patent', `/api/v1/patents/${patentId}`, mentorCookie],
      ['thesis', ownPath, memberCookie],
    ] as const) {
      check(`录入人可以删除 ${kind}，删除后隐藏详情`,
        (await api(path, { method: 'DELETE' }, recorder)).status === 200 &&
        (await api(path, {}, adminCookie)).status === 404);
      const deletion = db.prepare('SELECT id FROM ledger_deletions WHERE kind = ?').get(kind) as { id: string };
      check(`管理员可以恢复 ${kind}`,
        (await api(`/api/v1/ledger-deletions/${deletion.id}/restore`, json({}), adminCookie)).status === 200 &&
        (await api(path, {}, memberCookie)).status === 200);
    }
  }

  // ── 8. 问答记录的可见范围（own + all）───────────────────────
  console.log('\n问答记录可见范围（成员看自己、导师与管理员看全部）：');
  {
    // 【为什么直接调 repo 而不是真问一次】真问一次要花真钱、要联网，
    // 而且那样测出来的是"今天模型顺不顺"。这里要钉死的是**过滤**。
    // 至于"提问时 userId 有没有被传进去"，见本文件末尾的"未覆盖"说明。
    const rec = (runId: string, question: string, userId: string | null): void => {
      insertAskRecord(db, {
        runId,
        question,
        askedAt: FIXED_NOW.toISOString(),
        consentConfirmed: true,
        outcome: 'ok',
        citationCount: 1,
        gapCount: 0,
        rounds: 1,
        durationMs: 100,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
        warnings: [],
        userId,
      });
    };
    rec('run-a', '甲问的问题', memberId);
    rec('run-b', '乙问的问题', mentorId);
    rec('run-old', '阶段一遗留的公共问题', null);

    const memberAsks = await bodyOf<ListAskRecordsResponse>(await api('/api/v1/ask-records', {}, memberCookie));
    const ids = memberAsks.items.map((r) => r.runId);
    check('member 看得到自己的提问', ids.includes('run-a'));
    check('★ member 看不到别人的提问原文（原文不脱敏，所以这条尤其要紧）', !ids.includes('run-b'));
    check('member 看得到公共历史记录', ids.includes('run-old'));

    const mentorAsks = await bodyOf<ListAskRecordsResponse>(await api('/api/v1/ask-records', {}, mentorCookie));
    check('mentor 看得到全部（askRecord.read.all）', ['run-a', 'run-b', 'run-old'].every((id) => mentorAsks.items.some((r) => r.runId === id)));
    const firstPage = await bodyOf<ListAskRecordsResponse>(await api('/api/v1/ask-records?limit=1', {}, memberCookie));
    const secondPage = await bodyOf<ListAskRecordsResponse>(await api('/api/v1/ask-records?limit=1&offset=1', {}, memberCookie));
    check('分页先按权限过滤，再按稳定的时间顺序截取',
      firstPage.hasMore && firstPage.items[0]?.runId === 'run-old' && secondPage.items[0]?.runId === 'run-a');
    check('无 Trace 的旧历史来源明确标为未记录',
      firstPage.items[0]?.sources === null && firstPage.items[0].otherSources.length === 0);
    const search = encodeURIComponent('乙问');
    const memberSearch = await bodyOf<ListAskRecordsResponse>(await api(`/api/v1/ask-records?q=${search}`, {}, memberCookie));
    const mentorSearch = await bodyOf<ListAskRecordsResponse>(await api(`/api/v1/ask-records?q=${search}`, {}, mentorCookie));
    check('关键词搜索遵守问答可见范围',
      memberSearch.items.length === 0 && mentorSearch.items.length === 1 && mentorSearch.items[0]?.runId === 'run-b');
    check('成员不能选其他账号的回答进行复核',
      (await api('/api/v1/ask-records/run-b/review', json({ answer: '回答', consentConfirmed: true }), memberCookie)).status === 404);

    check(
      '没有身份的范围看不到任何人的提问，只看得到公共记录',
      ['run-a', 'run-b'].every((id) => !askRecordScope(null).canReadAll) &&
        askRecordScope(null).userId === '',
    );
  }

  // ── 8. 归属回填（欠账 3、4）────────────────────────────────
  console.log('\n归属回填：上传文档记下"谁传的、谁确认的"：');
  {
    const form = new FormData();
    form.append('file', new File(['# 验证用文档\n\n这是一份用于验证归属回填的文档。\n'], 'auth-verify.md', { type: 'text/markdown' }));
    form.append('material', 'knowledge');
    form.append('consentConfirmed', 'true');

    const res = await api('/api/v1/documents', { method: 'POST', body: form }, memberCookie);
    const uploaded = await bodyOf<{ document?: { id: string } }>(res);
    check('上传成功 → 201（member 有 material.upload）', res.status === 201, String(res.status));

    const row = db
      .prepare('SELECT uploaded_by, consent_confirmed_by, consent_confirmed_at FROM documents WHERE id = ?')
      .get(uploaded.document?.id ?? '') as unknown as
      | { uploaded_by: string | null; consent_confirmed_by: string | null; consent_confirmed_at: string | null }
      | undefined;
    check('documents.uploaded_by = 上传者（欠账 4 收口）', row?.uploaded_by === memberId, String(row?.uploaded_by));
    check('documents.consent_confirmed_by = 确认人（欠账 3 收口）', row?.consent_confirmed_by === memberId);
    check('consent_confirmed_at 落了时刻', typeof row?.consent_confirmed_at === 'string' && row.consent_confirmed_at !== '');

    // 没勾确认 → 拦在落盘之前（约束 4 的闸门必须在接口层）
    const noConsent = new FormData();
    noConsent.append('file', new File(['x'], 'no-consent.md', { type: 'text/markdown' }));
    noConsent.append('material', 'knowledge');
    const blocked = await api('/api/v1/documents', { method: 'POST', body: noConsent }, memberCookie);
    check('没勾确认 → 400（不落盘、不建库）', blocked.status === 400, String(blocked.status));
    check(
      '被拒的上传没有留下任何记录',
      (db.prepare("SELECT COUNT(*) AS n FROM documents WHERE title LIKE '%no-consent%'").get() as unknown as { n: number }).n === 0,
    );
  }

  // ── 8.5 「我的」：严格只算自己（阶段 4B）────────────────────
  console.log('\n「我的」概览与用量：口径是"我做过什么"，不是"我能看到什么"：');
  {
    // 三档用量的流水：自己的、别人的、无归属的（阶段 1–3 的调用）。
    const usage = (eventId: string, userId: string | null, cost: number): void => {
      insertUsageEvent(db, {
        eventId,
        runId: null,
        userId,
        model: 'verify-model',
        purpose: 'generate',
        inputTokens: 100,
        outputTokens: 20,
        cacheRead: 0,
        cacheCreation: 0,
        costUsd: cost,
        durationMs: 10,
        createdAt: FIXED_NOW.toISOString(),
      });
    };
    usage('ev-member', memberId, 0.5);
    usage('ev-mentor', mentorId, 9.9);
    usage('ev-nobody', null, 42);

    const mine = await bodyOf<MeOverviewResponse>(await api('/api/v1/me/overview', {}, memberCookie));
    const mineSubs = mine.submissions.map((s) => s.id);
    check('我登记的那条投稿在里面', mineSubs.includes(subA));
    check(
      '★ 归属为 NULL 的公共历史投稿**不在**「我的动态」里（它在台账里可见，但那不是"我做的"）',
      !mineSubs.includes(subPublic),
    );
    check('别人的投稿不在里面', !mineSubs.includes(subB));

    const mineAsks = mine.askRecords.map((r) => r.runId);
    check('我问过的问题在里面', mineAsks.includes('run-a'));
    check(
      '★ 公共历史问答记录**不在**里面 —— 与 /ask-records 的行为刻意不同（那边它可见）',
      !mineAsks.includes('run-old'),
    );
    check('别人的提问不在里面', !mineAsks.includes('run-b'));

    check(
      '我的资料 = 我上传的那一份，且带上传者显示名',
      mine.documents.length > 0 && mine.documents.every((d) => d.uploadedByName === '成员'),
      JSON.stringify(mine.documents.map((d) => d.uploadedByName)),
    );

    // O14 今日工作台：三项计数与知识库概况都在同一个响应里，
    // 计数是本人的（保留上面恢复投稿后的待办）。
    check(
      '工作台：恢复投稿后原超期待办再次可见',
      mine.pending.overdueSubmissions === 1,
      String(mine.pending.overdueSubmissions),
    );
    check(
      '工作台：待确认草案按创建人过滤（成员为 0）',
      mine.pending.proposedKnowledge === 0,
      String(mine.pending.proposedKnowledge),
    );
    check(
      '工作台：未完成上传按发起人过滤（成员为 0）',
      mine.pending.unfinishedUploads === 0,
      String(mine.pending.unfinishedUploads),
    );
    check(
      '工作台：知识库概况是全库统计且向量数不超过块数',
      mine.knowledge !== null &&
        mine.knowledge.documents > 0 &&
        mine.knowledge.chunks >= mine.knowledge.embedded,
      JSON.stringify(mine.knowledge),
    );

    // 同一个接口换个人调，看到的是**另一个人的**动态 —— 证明过滤按会话走，
    // 而不是"把所有人的都返回回去，让前端挑"。
    const mentorOv = await bodyOf<MeOverviewResponse>(await api('/api/v1/me/overview', {}, mentorCookie));
    check('导师的 overview 是自己的（含他自己的稿子）', mentorOv.submissions.some((s) => s.id === subB));
    check('★ 导师的 overview 里没有成员的稿子（导师在台账里看得到，但这里问的是"我做的"）', !mentorOv.submissions.some((s) => s.id === subA));
    check('导师的 overview 里没有成员的提问', !mentorOv.askRecords.some((r) => r.runId === 'run-a'));

    const mu = await bodyOf<MeUsageResponse>(await api('/api/v1/me/usage', {}, memberCookie));
    check('我的用量只算 user_id = 我 的流水（1 次）', mu.totals.calls === 1, String(mu.totals.calls));
    check('金额是我那一条，不是全库合计', Math.abs(mu.totals.costUsd - 0.5) < 1e-9, String(mu.totals.costUsd));
    check('token 明细跟着一起回来', mu.totals.inputTokens === 100 && mu.totals.outputTokens === 20);
    check('since 为 null = 全部历史（本期不做按天/按月粒度）', mu.since === null);

    const otherUsage = await bodyOf<MeUsageResponse>(await api('/api/v1/me/usage', {}, adminCookie));
    check('admin 没调过模型 → 0 次（无归属的流水不算给任何人）', otherUsage.totals.calls === 0, String(otherUsage.totals.calls));

    // 未登录两条都必须是 401。`usage.read.own` 与 `authenticated` 是两种规则，
    // 但"没登录"这条底线对两者都成立。
    const anonOverview = await api('/api/v1/me/overview');
    const anonUsage = await api('/api/v1/me/usage');
    check('未登录访问 /me/overview → 401', anonOverview.status === 401, String(anonOverview.status));
    check('未登录访问 /me/usage → 401', anonUsage.status === 401, String(anonUsage.status));

    // 右栏「最近入库」靠列表接口里的 uploadedByName 显示上传者。
    const docs = await bodyOf<{ items: { uploadedByName: string | null }[] }>(await api('/api/v1/documents', {}, memberCookie));
    check(
      '文档列表带上上传者显示名（右栏要显示它；历史数据是 null，不是"匿名"）',
      docs.items.some((d) => d.uploadedByName === '成员'),
    );
  }

  // ── 8.6 管理端概览：三块数据各自按权限发放（阶段 4C）────────
  console.log('\n管理端概览：三块数据各自按权限发放：');
  {
    const ovAdmin = await bodyOf<AdminOverviewResponse>(await api('/api/v1/admin/overview', {}, adminCookie));
    check(
      'admin 三块都拿得到',
      ovAdmin.users !== null && ovAdmin.documents !== null && ovAdmin.recentAsks !== null,
    );
    check('用户总数与 users 表一致', ovAdmin.users?.total === countUsers(db), String(ovAdmin.users?.total));
    check(
      '恒等式：启用 + 禁用 = 总数',
      ovAdmin.users !== null && ovAdmin.users.active + ovAdmin.users.disabled === ovAdmin.users.total,
    );
    check(
      '★ 按角色分组：三个模板各有人',
      ['admin', 'mentor', 'member'].every((r) => ovAdmin.users?.byRole.some((x) => x.role === r)),
      JSON.stringify(ovAdmin.users?.byRole),
    );

    const ovMember = await bodyOf<AdminOverviewResponse>(await api('/api/v1/admin/overview', {}, memberCookie));
    check(
      '★ member 拿不到用户数与最近问答（是服务端没查，不是查了再丢掉）',
      ovMember.users === null && ovMember.recentAsks === null,
    );
    check('member 仍拿得到文档与索引统计（knowledge.read 是全员权限）', ovMember.documents !== null);
    check('未登录访问 → 401', (await api('/api/v1/admin/overview')).status === 401);

    // 导师有 `askRecord.read.all` 但没有 `users.manage`。用它证明"按块发放"
    // 既不是"要么全给要么全不给"，也不是按"算不算管理端的人"一刀切。
    const ovMentor = await bodyOf<AdminOverviewResponse>(await api('/api/v1/admin/overview', {}, mentorCookie));
    check('★ mentor：有最近问答、没有用户数', ovMentor.recentAsks !== null && ovMentor.users === null);

    const asks = ovAdmin.recentAsks ?? [];
    check('最近问答带上提问人的显示名', asks.some((a) => a.asker === '成员'), JSON.stringify(asks.map((a) => a.asker)));
    check(
      '★ 无归属的历史记录 asker 为 null —— 那不等于"匿名"，是那时还没有登录',
      asks.some((a) => a.asker === null),
    );

    // 索引欠账：新加 2 个块，其中**只有 1 个**算的是当前模型的向量。
    // 另一条是"别的模型算的" —— 它必须**不算已索引**：换了模型之后旧向量与
    // 新向量不在同一个空间里，把它算进去会让"索引齐了"变成一句假话。
    // 模型标识从配置算出来，而不是写死字符串 —— 写死的话改了 EMBED_DTYPE
    // 这个用例会静默变成"永远不成立"，然后被人顺手删掉。
    const before = ovAdmin.documents;
    assert.ok(before !== null, 'admin 应当拿得到文档统计');
    db.prepare(
      "INSERT INTO documents (id, material, title, content_hash, status, created_at) VALUES ('ov-doc','paper','概览验证','ov-hash','ready',?)",
    ).run(FIXED_NOW.toISOString());
    for (const [id, ord] of [['ov-c1', 0], ['ov-c2', 1]] as const) {
      db.prepare('INSERT INTO doc_chunks (id, doc_id, ordinal, text, text_seg) VALUES (?, ?, ?, ?, ?)').run(
        id,
        'ov-doc',
        ord,
        `块${ord}`,
        `块${ord}`,
      );
    }
    const putVec = (chunkId: string, model: string): void => {
      db.prepare(
        'INSERT INTO chunk_embeddings (chunk_id, model, dim, vec, created_at) VALUES (?, ?, 2, ?, ?)',
      ).run(chunkId, model, new Uint8Array(8), FIXED_NOW.toISOString());
    };
    putVec('ov-c1', embeddingModelKey(cfg));
    putVec('ov-c2', '别的模型');

    const after = (await bodyOf<AdminOverviewResponse>(await api('/api/v1/admin/overview', {}, adminCookie)))
      .documents;
    assert.ok(after !== null);
    check('新增 2 块 → chunks 跟着 +2', after.chunks === before.chunks + 2, `${before.chunks} → ${after.chunks}`);
    check(
      '★ embedded 只 +1（别的模型算的那条不算已索引）',
      after.embedded === before.embedded + 1,
      `${before.embedded} → ${after.embedded}`,
    );
    check(
      'missingEmbeddings 相应 +1',
      after.missingEmbeddings === before.missingEmbeddings + 1,
      `${before.missingEmbeddings} → ${after.missingEmbeddings}`,
    );
  }

  // ── 8.7 账号管理（阶段 4C 单元 ②）──────────────────────────
  console.log('\n账号管理：只有 admin 能碰，且不许把自己锁在门外：');
  {
    check(
      '四条都登记为 users.manage（没有更细的分档）',
      ruleFor('GET', '/api/v1/users') === 'users.manage' &&
        ruleFor('POST', '/api/v1/users') === 'users.manage' &&
        ruleFor('PATCH', '/api/v1/users/:id') === 'users.manage' &&
        ruleFor('POST', '/api/v1/users/:id/password') === 'users.manage',
    );

    // 1) member 四个接口一律 403；未登录一律 401。
    const memberAttempts: readonly (readonly [string, Response])[] = [
      ['看账号列表', await api('/api/v1/users', {}, memberCookie)],
      ['建号', await api('/api/v1/users', json({ username: 'x1', password: 'x1-pw-1234567', role: 'member' }), memberCookie)],
      ['改账号', await api(`/api/v1/users/${memberId}`, json({ displayName: '改我自己' }, 'PATCH'), memberCookie)],
      ['重设口令', await api(`/api/v1/users/${memberId}/password`, json({ password: 'set-by-myself-pw' }), memberCookie)],
    ];
    for (const [what, res] of memberAttempts) {
      check(`★ member ${what} → 403`, res.status === 403, String(res.status));
    }
    check('未登录看账号列表 → 401', (await api('/api/v1/users')).status === 401);
    check(
      '被拒的 member 建号没有留下记录（403 发生在任何一次写库之前）',
      (db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'x1'").get() as unknown as { n: number }).n === 0,
    );

    // 2) 列表。
    const listRes = await api('/api/v1/users', {}, adminCookie);
    const list = await bodyOf<ListUsersResponse>(listRes);
    check('admin 看得到列表 → 200', listRes.status === 200, String(listRes.status));
    check(
      '列表里有三个角色各自的账号',
      ['admin', 'member', 'mentor'].every((u) => list.items.some((x) => x.username === u)),
    );
    check(
      '★ 列表项里**没有**任何口令字段（不是"记得别发"—— shared 的类型里就没有它）',
      list.items.every((u) => !('password_hash' in u) && !('passwordHash' in u)),
      JSON.stringify(Object.keys(list.items[0] ?? {})),
    );
    check(
      '列表项带上了状态与两个时间戳（管理端视图比 /auth/me 多这几项）',
      list.items.every((u) => typeof u.status === 'string' && typeof u.createdAt === 'string'),
    );

    // 3) 建号：用户名归一化、显示名兜底、口令是哈希存的。
    const createdRes = await api(
      '/api/v1/users',
      json({ username: 'NewUser', password: 'newuser-pw-123456', role: 'member' }),
      adminCookie,
    );
    const created = await bodyOf<CreateUserResponse>(createdRes);
    check('建号 → 201', createdRes.status === 201, String(createdRes.status));
    check('★ 用户名归一为小写落库', created.user.username === 'newuser', created.user.username);
    check('没给显示名 → 退回用户名（不是空串，页面上要有东西显示）', created.user.displayName === 'newuser');
    check('新账号默认启用', created.user.status === 'active');
    check('落库的是口令哈希，不是明文', (findHash(db, 'newuser') ?? '').startsWith('scrypt$'));
    const newUserId = created.user.id;

    // 4) 重名 / 短口令：都在写库之前拦下。
    const dup = await api(
      '/api/v1/users',
      json({ username: 'NEWUSER', password: 'another-pw-123456', role: 'member' }),
      adminCookie,
    );
    const dupBody = await bodyOf<ApiErrorBody>(dup);
    check('★ 只差大小写的重名 → 409（唯一索引之前先用人话拦住）', dup.status === 409, `${dup.status} ${dupBody.error.code}`);
    check(
      '409 的报错里给出归一化后的名字（管理员才知道撞的是谁）',
      dupBody.error.message.includes('newuser'),
      dupBody.error.message,
    );

    const shortPw = await api(
      '/api/v1/users',
      json({ username: 'shorty', password: '123', role: 'member' }),
      adminCookie,
    );
    check('口令短于 4 位 → 400', shortPw.status === 400, String(shortPw.status));
    check(
      '被拒的建号没有留下记录',
      (db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'shorty'").get() as unknown as { n: number }).n === 0,
    );

    // 5) 新账号能登录；改角色**立刻生效且不踢会话**。
    const newCookie = await loginCookie('newuser', 'newuser-pw-123456');
    check('新建的账号能用自己的口令登录', true);

    const promotedRes = await api(`/api/v1/users/${newUserId}`, json({ role: 'mentor' }, 'PATCH'), adminCookie);
    const promoted = await bodyOf<UpdateUserResponse>(promotedRes);
    check('改角色 → 200', promotedRes.status === 200, String(promotedRes.status));
    check(
      '★ 改角色**不踢会话**（sessionsRevoked = 0）—— 踢掉只会让人莫名其妙掉线',
      promoted.sessionsRevoked === 0,
      String(promoted.sessionsRevoked),
    );
    const afterRole = await bodyOf<MeResponse>(await api('/api/v1/auth/me', {}, newCookie));
    check(
      '★ 同一个 cookie 的下一个请求就是新角色（权限每请求现从库 JOIN，不必重登）',
      afterRole.user.role === 'mentor',
      afterRole.user.role,
    );
    check('新角色带来的权限点也跟着变了', afterRole.permissions.includes('journal.manage'));

    // 6) 课题组：能设、也能用 null 清空（三个可改字段里唯一允许被清空的）。
    const g1 = await api(`/api/v1/users/${newUserId}`, json({ groupId: '遥感组' }, 'PATCH'), adminCookie);
    check('课题组能设上', (await bodyOf<UpdateUserResponse>(g1)).user.groupId === '遥感组');
    const g2 = await api(`/api/v1/users/${newUserId}`, json({ groupId: null }, 'PATCH'), adminCookie);
    check('课题组能给 null 清空（回到"未分组"）', (await bodyOf<UpdateUserResponse>(g2)).user.groupId === null);

    // 7) 禁用**别人**：当场切断他的会话。
    const disabledRes = await api(`/api/v1/users/${newUserId}`, json({ status: 'disabled' }, 'PATCH'), adminCookie);
    const disabled = await bodyOf<UpdateUserResponse>(disabledRes);
    check('禁用 → 200', disabledRes.status === 200, String(disabledRes.status));
    check('★ 禁用踢掉了那个人的会话（sessionsRevoked = 1）', disabled.sessionsRevoked === 1, String(disabled.sessionsRevoked));
    check('★ 被禁用后旧 cookie 立刻 401', (await api('/api/v1/auth/me', {}, newCookie)).status === 401);
    check(
      '被禁用的账号也登不进来（与"口令错"同一个 401，不泄露账号是否存在）',
      (await api('/api/v1/auth/login', json({ username: 'newuser', password: 'newuser-pw-123456' }))).status === 401,
    );

    // 8) 重新启用 → 能登录；重设口令 → 旧会话与旧口令一起作废。
    const enabledRes = await api(`/api/v1/users/${newUserId}`, json({ status: 'active' }, 'PATCH'), adminCookie);
    check('重新启用 → 200', enabledRes.status === 200, String(enabledRes.status));
    const cookie2 = await loginCookie('newuser', 'newuser-pw-123456');

    const resetRes = await api(`/api/v1/users/${newUserId}/password`, json({ password: 'brand-new-pw-1234' }), adminCookie);
    const reset = await bodyOf<ResetPasswordResponse>(resetRes);
    check('重设口令 → 200 并带回用户名', resetRes.status === 200 && reset.username === 'newuser');
    check('★ 重设口令踢掉全部会话（sessionsRevoked ≥ 1）', reset.sessionsRevoked >= 1, String(reset.sessionsRevoked));
    check(
      '★ 旧 cookie 立刻失效（会话里不带口令，不踢就成了"改了密码别人还能进"）',
      (await api('/api/v1/auth/me', {}, cookie2)).status === 401,
    );
    check(
      '旧口令登不进来',
      (await api('/api/v1/auth/login', json({ username: 'newuser', password: 'newuser-pw-123456' }))).status === 401,
    );
    const postResetCookie = await loginCookie('newuser', 'brand-new-pw-1234');
    check('新口令能登录', true);

    // 8.5) 改用户名：只换登录名，会话与账号都不动。
    const renameRes = await api(
      `/api/v1/users/${newUserId}`,
      json({ username: 'RenamedUser' }, 'PATCH'),
      adminCookie,
    );
    const renamed = await bodyOf<UpdateUserResponse>(renameRes);
    check('改用户名 → 200', renameRes.status === 200, String(renameRes.status));
    check('★ 用户名归一为小写（与建号同一条规则）', renamed.user.username === 'renameduser', renamed.user.username);
    check(
      '建号时没单独填显示名 → 改名时显示名跟着走（不留下"用户名新、显示名旧"的一行）',
      renamed.user.displayName === 'renameduser',
      renamed.user.displayName,
    );
    check('★ 改名不踢会话（sessionsRevoked = 0）', renamed.sessionsRevoked === 0, String(renamed.sessionsRevoked));
    const afterRenameMe = await bodyOf<MeResponse>(await api('/api/v1/auth/me', {}, postResetCookie));
    check(
      '★ 旧 cookie 仍然有效，且 /auth/me 立刻返回新用户名',
      afterRenameMe.user.username === 'renameduser',
      afterRenameMe.user.username,
    );
    check(
      '旧用户名登不进来（改名不是"再开一个别名"）',
      (await api('/api/v1/auth/login', json({ username: 'newuser', password: 'brand-new-pw-1234' }))).status === 401,
    );
    await loginCookie('renameduser', 'brand-new-pw-1234');
    check('新用户名能登录', true);

    const renameDup = await api(
      `/api/v1/users/${newUserId}`,
      json({ username: 'MEMBER' }, 'PATCH'),
      adminCookie,
    );
    const renameDupBody = await bodyOf<ApiErrorBody>(renameDup);
    check('改成已有用户名（只差大小写）→ 409', renameDup.status === 409, `${renameDup.status} ${renameDupBody.error.code}`);
    check(
      '409 的报错里给出归一化后的名字',
      renameDupBody.error.message.includes('member'),
      renameDupBody.error.message,
    );
    check(
      '用户名带空格 → 400',
      (await api(`/api/v1/users/${newUserId}`, json({ username: 'bad name' }, 'PATCH'), adminCookie)).status === 400,
    );
    check(
      '空用户名 → 400',
      (await api(`/api/v1/users/${newUserId}`, json({ username: '   ' }, 'PATCH'), adminCookie)).status === 400,
    );
    const afterRejectedRenames = db
      .prepare('SELECT username FROM users WHERE id = ?')
      .get(newUserId) as unknown as { username: string };
    check('被拒的改名都没有动库里的用户名', afterRejectedRenames.username === 'renameduser',
      afterRejectedRenames.username);

    // 显示名单独设过的人，改名时不能被顺手覆盖。
    const customDisplay = await api(
      `/api/v1/users/${newUserId}`,
      json({ displayName: '自定义显示名' }, 'PATCH'),
      adminCookie,
    );
    check('先单独设一个显示名', (await bodyOf<UpdateUserResponse>(customDisplay)).user.displayName === '自定义显示名');
    const secondRename = await api(
      `/api/v1/users/${newUserId}`,
      json({ username: 'RenamedUser2' }, 'PATCH'),
      adminCookie,
    );
    const renamedAgain = await bodyOf<UpdateUserResponse>(secondRename);
    check('再改用户名 → 新名生效', renamedAgain.user.username === 'renameduser2', renamedAgain.user.username);
    check(
      '★ 已经单独设过的显示名保持不动',
      renamedAgain.user.displayName === '自定义显示名',
      renamedAgain.user.displayName,
    );

    // 9) ★ 不许把自己锁在门外。
    const selfDisable = await api(`/api/v1/users/${adminId}`, json({ status: 'disabled' }, 'PATCH'), adminCookie);
    const selfDisableBody = await bodyOf<ApiErrorBody>(selfDisable);
    check(
      '★ 管理员禁用自己 → 400（这是唯一能把所有人关在管理端之外的操作）',
      selfDisable.status === 400,
      `${selfDisable.status} ${selfDisableBody.error.code}`,
    );
    const selfDemote = await api(`/api/v1/users/${adminId}`, json({ role: 'member' }, 'PATCH'), adminCookie);
    check('★ 管理员把自己降级 → 400', selfDemote.status === 400, String(selfDemote.status));

    const adminRow = db.prepare('SELECT role, status FROM users WHERE id = ?').get(adminId) as unknown as {
      role: string;
      status: string;
    };
    check('两次被拒都没有改动库里的那一行', adminRow.role === 'admin' && adminRow.status === 'active');
    check('★ 拒掉之后 admin 的会话还在（不是"拒绝但把人踢了"）', (await api('/api/v1/auth/me', {}, adminCookie)).status === 200);

    const selfRename = await api(`/api/v1/users/${adminId}`, json({ displayName: '总管理员' }, 'PATCH'), adminCookie);
    check('只挡禁用与降级：改自己的显示名仍然可以', selfRename.status === 200, String(selfRename.status));

    // 10) 边界：不存在的 id、空补丁、口令太短。
    const ghost = await api(
      '/api/v1/users/00000000-0000-0000-0000-000000000000',
      json({ displayName: '查无此人' }, 'PATCH'),
      adminCookie,
    );
    check('改一个不存在的 id → 404', ghost.status === 404, String(ghost.status));
    const noSuchPw = await api(
      '/api/v1/users/00000000-0000-0000-0000-000000000000/password',
      json({ password: 'whatever-pw-1234567' }),
      adminCookie,
    );
    check('给不存在的 id 重设口令 → 404（与 PATCH 同一个答案）', noSuchPw.status === 404, String(noSuchPw.status));

    const emptyPatch = await api(`/api/v1/users/${newUserId}`, json({}, 'PATCH'), adminCookie);
    check(
      '一个字段都不给的 PATCH → 200 且如实返回现状（不是 400 —— 客户端"每次都回传全部字段"不该因此报错）',
      emptyPatch.status === 200,
      String(emptyPatch.status),
    );
    const shortReset = await api(`/api/v1/users/${newUserId}/password`, json({ password: '123' }), adminCookie);
    check('重设口令也查长度 → 400', shortReset.status === 400, String(shortReset.status));
  }

  // ── 8.8 系统配置（阶段 4C 单元 ③，2026-10-12 由「联网搜索」改造为大模型接口）──
  //
  // 这一段最要紧的不是"能改配置"，而是**改配置的这条路上一个密钥字节都不外流**。
  // 4C ③ 之前 `GET /api/v1/system-config` 会把这个表里的 `value` 原样回给任何
  // 登录用户 —— 而表里存着服务商 API key 的明文。那是一条真实的、可被任何
  // member 触发的泄露。下面第 5、6、9 组断言就是钉死这一点的。
  console.log('\n系统配置（大模型接口）：改得对，且密钥不出门：');
  {
    const get = async (cookie?: string): Promise<{ res: Response; view: SystemConfigResponse }> => {
      const res = await api('/api/v1/system-config', {}, cookie);
      return { res, view: await bodyOf<SystemConfigResponse>(res) };
    };
    const testConn = async (
      body: unknown,
      cookie?: string,
    ): Promise<{ res: Response; view: TestModelConnectionResponse }> => {
      const res = await api('/api/v1/system-config/test-connection', json(body, 'POST'), cookie);
      return { res, view: await bodyOf<TestModelConnectionResponse>(res) };
    };

    // 修改人的期望值**从 /auth/me 现取**，不写死字符串：8.7 那一段会把 admin 的
    // 显示名改掉（那是它自己的用例），写死的话这一段会因为**别的段落的副作用**
    // 而红 —— 而它那一刻的失败信息（"期望 管理员，得到 总管理员"）会把人引向
    // 配置页的显示逻辑，实际上那里什么问题都没有。
    const adminName = (await bodyOf<MeResponse>(await api('/api/v1/auth/me', {}, adminCookie))).user.displayName;

    check(
      '读、写、测连接都登记为 system.config（原来读是 authenticated —— 那条规则配着"不回显密钥"的注释，而代码并没有做到）',
      ruleFor('GET', '/api/v1/system-config') === 'system.config' &&
        ruleFor('PATCH', '/api/v1/system-config') === 'system.config' &&
        ruleFor('POST', '/api/v1/system-config/test-connection') === 'system.config',
    );

    // 1) 权限。测连接比保存更值得收紧：它能让服务端去打**调用方指定的任意外站地址**。
    check('未登录读配置 → 401', (await api('/api/v1/system-config')).status === 401);
    check(
      '★ member 读配置 → 403（这一条在本单元之前是 200，且会把服务商 key 的明文一起给出去）',
      (await api('/api/v1/system-config', {}, memberCookie)).status === 403,
    );
    const memberWrite = await api('/api/v1/system-config', json({ chat: 'deepseek-v4-pro' }, 'PATCH'), memberCookie);
    check('★ member 改配置 → 403', memberWrite.status === 403, String(memberWrite.status));
    check(
      '被拒的 member 没有改到库（403 在任何一次写库之前）',
      (db.prepare("SELECT COUNT(*) AS n FROM system_config WHERE key = 'model.chat'").get() as unknown as {
        n: number;
      }).n === 0,
    );
    check('★ 未登录测连接 → 401', (await api('/api/v1/system-config/test-connection', json({}, 'POST'))).status === 401);
    check(
      '★ member 测连接 → 403（它能让服务端去打任意外站地址，不能给非 admin）',
      (await api('/api/v1/system-config/test-connection', json({}, 'POST'), memberCookie)).status === 403,
    );
    // 计划里写的是 PUT，实现用了 PATCH（与 users / code-assets 的部分更新语义一致）。
    // 这条断言把这个决定钉住：PUT 是**没登记的**，所以是 404（没有这个 handler），
    // 而不是 403 —— 免得日后有人顺手补一个 PUT，多出一条语义重叠的写入口。
    check('PUT 这条路不存在 → 404（写入口只有 PATCH 一个）', (await api('/api/v1/system-config', json({}, 'PUT'), adminCookie)).status === 404);

    // 2) 起点：表是空的，一切来自内置默认。**这正是配置页最容易被做错的状态** ——
    //    只看表里有什么，页面会显示成"什么都没配"，而实际上默认值是生效的。
    const empty = await get(adminCookie);
    check('admin 读配置 → 200', empty.res.status === 200, String(empty.res.status));
    check('表里还没有任何 model.* 配置行', empty.view.items.every((i) => !i.key.startsWith('model.')), JSON.stringify(empty.view.items.map((i) => i.key)));
    check(
      '★ 接口地址默认取 pi-ai 目录里 DeepSeek 的地址，来源标注为 default',
      empty.view.model.baseUrl === 'https://api.deepseek.com' && empty.view.model.baseUrlSource === 'default',
      JSON.stringify(empty.view.model),
    );
    check(
      '两个模型槽位的默认值：对话 deepseek-flash、推理 deepseek-v4-pro，来源都是 default',
      empty.view.model.chatModel === 'deepseek-flash' &&
        empty.view.model.reasonerModel === 'deepseek-v4-pro' &&
        empty.view.model.chatModelSource === 'default' &&
        empty.view.model.reasonerModelSource === 'default',
    );
    check(
      '★ 目录里确实有这两个模型（下拉的候选项来自服务端下发的 catalog）',
      empty.view.model.chatInCatalog === true &&
        empty.view.model.reasonerInCatalog === true &&
        empty.view.model.catalog.some((m) => m.id === 'deepseek-flash') &&
        empty.view.model.catalog.some((m) => m.id === 'deepseek-v4-pro'),
      JSON.stringify(empty.view.model.catalog),
    );
    check(
      '★ 没有 key → available=false 且 apiKeySource=none（这一页要能说清"为什么调不了模型"）',
      empty.view.model.available === false && empty.view.model.apiKeySource === 'none',
      JSON.stringify(empty.view.model),
    );

    // 3) 写：只改动过的那一项，没传的键一律不动。
    const setChat = await api('/api/v1/system-config', json({ chat: 'deepseek-v4-pro' }, 'PATCH'), adminCookie);
    const afterChat = await bodyOf<SystemConfigResponse>(setChat);
    check('改对话模型 → 200', setChat.status === 200, String(setChat.status));
    check(
      '对话模型立刻生效，来源变成 table',
      afterChat.model.chatModel === 'deepseek-v4-pro' && afterChat.model.chatModelSource === 'table',
    );
    check('★ 没传的项没有被顺手改掉（推理模型仍是默认值）', afterChat.model.reasonerModel === 'deepseek-v4-pro' && afterChat.model.reasonerModelSource === 'default');
    check('表里只多了 model.chat 这一行', afterChat.items.length === 1, JSON.stringify(afterChat.items.map((i) => i.key)));
    check(
      '这一行记下了修改人（admin 的显示名）与时间',
      afterChat.items[0]?.updatedByName === adminName && typeof afterChat.items[0]?.updatedAt === 'string',
      JSON.stringify(afterChat.items[0]),
    );

    // 3b) ★ 手填一个目录外的模型名：**不准报错**（第三方中转站的模型名与目录不同），
    //     如实标出"不在目录里"，由页面提示"元数据按模板估算"。
    const typed = await api('/api/v1/system-config', json({ chat: 'deepseek-chat' }, 'PATCH'), adminCookie);
    const typedView = await bodyOf<SystemConfigResponse>(typed);
    check('★ 手填目录外的模型名 → 200（不许因为不在目录里就拒绝）', typed.status === 200, String(typed.status));
    check(
      '★ 它被如实标成"不在目录里"（不是假装它在目录里）',
      typedView.model.chatModel === 'deepseek-chat' && typedView.model.chatInCatalog === false,
      JSON.stringify(typedView.model),
    );
    await api('/api/v1/system-config', json({ chat: '' }, 'PATCH'), adminCookie);

    // 4) 校验：都在写库之前拦下，且一次被拒的多字段补丁一项都不落库。
    const cases: readonly (readonly [string, unknown, number])[] = [
      ['接口地址没带协议', { baseUrl: 'api.deepseek.com' }, 400],
      ['接口地址协议不是 http(s)', { baseUrl: 'ftp://api.deepseek.com' }, 400],
      ['★ 接口地址里带 userinfo（能藏凭据的地方，一律不收）', { baseUrl: 'https://user:pass@api.deepseek.com' }, 400],
      ['key 太短（像是只粘了一半）', { apiKey: 'abc' }, 400],
      ['key 中间带空格（像是连文档一起粘的）', { apiKey: 'sk-abc def123456' }, 400],
      ['字段名不认识（api_key vs apiKey）', { api_key: 'sk-whatever-123' }, 400],
      ['旧域名的字段（联网搜索已下线）', { provider: 'tavily' }, 400],
    ];
    for (const [what, body, want] of cases) {
      const res = await api('/api/v1/system-config', json(body, 'PATCH'), adminCookie);
      check(`${what} → ${want}`, res.status === want, `${res.status} ${JSON.stringify(body)}`);
    }
    const mixed = await api(
      '/api/v1/system-config',
      json({ reasoner: 'deepseek-chat', baseUrl: 'ftp://x.example.com' }, 'PATCH'),
      adminCookie,
    );
    check('多字段补丁里有一个非法 → 整体 400', mixed.status === 400, String(mixed.status));
    check(
      '★ 被拒的补丁一项都没落库（同一个补丁里合法的那个也没进去）',
      (await get(adminCookie)).view.model.reasonerModelSource === 'default',
      '推理模型应仍是内置默认（source=default）',
    );

    // 5) 密钥：能写、能用，但**任何一个字节都不出现在响应里**。
    const KEY = 'fixture-only-' + randomUUID();
    const setKey = await api('/api/v1/system-config', json({ apiKey: KEY }, 'PATCH'), adminCookie);
    const keyRes = await setKey.text();
    const keyView = JSON.parse(keyRes) as SystemConfigResponse;
    check('写 key → 200', setKey.status === 200, String(setKey.status));
    check('★ key 写进去之后 available=true', keyView.model.available === true && keyView.model.apiKeySource === 'table');
    check('★★ 写 key 的响应体里**不含** key 明文（逐字搜一遍整个 JSON）', !keyRes.includes(KEY), '响应里出现了密钥明文！');
    check(
      '★ 密钥行的 value 是 null、但 isSet=true（靠 isSet 区分"没填"与"不回显"）',
      keyView.items.some((i) => i.key === 'model.api_key' && i.value === null && i.isSet),
      JSON.stringify(keyView.items.filter((i) => i.key === 'model.api_key')),
    );

    const readAgain = await get(adminCookie);
    const readText = JSON.stringify(readAgain.view);
    check('★★ 再读一次也不含 key 明文', !readText.includes(KEY));
    check(
      '★ EffectiveModelSettings 这个类型里根本没有 apiKey 字段（不是"记得别发"）',
      !('apiKey' in readAgain.view.model),
      JSON.stringify(Object.keys(readAgain.view.model)),
    );
    check(
      '非密钥项照常显示值（掩码是按"键名的形状"判的，不是把整张表都藏起来）',
      readAgain.view.items.some((i) => i.key === 'model.api_key' && i.isSet),
    );

    // 6) 命令行 / 部署脚本写的行：updated_by 是 NULL。
    //    界面必须能把它与"网页改的"分开 —— null 只有这一种解释（用户只停用不删除，
    //    所以有 updated_by 的行一定连得上人）。
    db.prepare(
      "INSERT INTO system_config (key, value, updated_at, updated_by) VALUES ('model.reasoner', 'deepseek-v4-pro', ?, NULL)",
    ).run(FIXED_NOW.toISOString());
    const cliView = (await get(adminCookie)).view;
    const cliRow = cliView.items.find((i) => i.key === 'model.reasoner');
    check('★ 命令行写的行：updatedByName 为 null（不是"没人改过"，是"不是网页改的"）', cliRow?.updatedByName === null && cliRow?.value === 'deepseek-v4-pro', JSON.stringify(cliRow));
    check('表里那一行马上生效（改完不必重启）', cliView.model.reasonerModel === 'deepseek-v4-pro' && cliView.model.reasonerModelSource === 'table');

    // 7) ★ 掩码按**键名的形状**判，而不是按"哪几个键该掩"的白名单。
    //    这条断言是给未来加配置项的人看的：新加一个叫 xxx_secret 的项，
    //    它自动不回显 —— 不需要有人记得回来改这里。
    db.prepare(
      "INSERT INTO system_config (key, value, updated_at, updated_by) VALUES ('patrol.webhook_secret', 'wh-secret-0987654321', ?, NULL)",
    ).run(FIXED_NOW.toISOString());
    const futureText = JSON.stringify((await get(adminCookie)).view);
    check('★★ 表里多了一个 xxx_secret 的项 → 它的值同样不会出现在响应里', !futureText.includes('wh-secret-0987654321'));
    check(
      '那一行只以"已保存"的形式出现',
      (await get(adminCookie)).view.items.some((i) => i.key === 'patrol.webhook_secret' && i.value === null && i.isSet),
    );

    // 8) 清空：空串 = 回落下一层（这里没有 .env，所以回落到内置默认）。
    const clearBase = await api('/api/v1/system-config', json({ baseUrl: '' }, 'PATCH'), adminCookie);
    const clearedBase = await bodyOf<SystemConfigResponse>(clearBase);
    check(
      '接口地址传空串 → 回落到内置默认（来源变回 default）',
      clearedBase.model.baseUrl === 'https://api.deepseek.com' && clearedBase.model.baseUrlSource === 'default',
      JSON.stringify(clearedBase.model),
    );
    check(
      '清空是**写空串**而不是删行（那一行还在，仍记得是谁清的）',
      clearedBase.items.some((i) => i.key === 'model.base_url' && i.value === '' && i.updatedByName === adminName),
    );

    const clearKey = await api('/api/v1/system-config', json({ apiKey: '' }, 'PATCH'), adminCookie);
    const clearedKey = await bodyOf<SystemConfigResponse>(clearKey);
    check('key 传空串 → 清掉，available 回到 false', clearedKey.model.available === false && clearedKey.model.apiKeySource === 'none');

    // 8b) 测试连接的**离线**部分：此刻表与 `.env` 都没有 key，所以下面这条**不该出网**。
    //     （它必须排在上面的"清掉 key"之后 —— 排在写 key 之前的那版真的打到了
    //      api.deepseek.com，拿回一个 401，于是"不出网"这条断言就成了假的。）
    //     真"通了 / 401 / 地址不通"要真的出网，交给探针与浏览器 e2e，不在这个脚本里做。
    const noKey = await testConn({}, adminCookie);
    check(
      '★ 没配 key 时点测试连接 → 200 且 kind=not_configured（**不出网**，不花冤枉钱）',
      noKey.res.status === 200 && noKey.view.kind === 'not_configured' && noKey.view.ok === false,
      JSON.stringify(noKey.view),
    );
    check('★ 这个结论带状态码 null（没有上游响应可言）', noKey.view.httpStatus === null);
    check(
      '★ 结论是中文、不含任何上游正文（密钥永不出门的另一面）',
      noKey.view.message.length > 0 && !noKey.view.message.includes('sk-'),
      noKey.view.message,
    );
    const badAddr = await testConn({ baseUrl: 'ftp://api.deepseek.com' }, adminCookie);
    check('★ 测试连接里地址非法 → 400（与保存走同一套校验）', badAddr.res.status === 400, String(badAddr.res.status));
    const badField = await testConn({ api_key: 'sk-whatever-123' }, adminCookie);
    check('测试连接里字段名不认识 → 400', badField.res.status === 400, String(badField.res.status));

    // 9) 空补丁：不是错误（与 users 的 PATCH 同一个口径）。
    const noop = await api('/api/v1/system-config', json({}, 'PATCH'), adminCookie);
    check('空补丁 → 200（客户端"把全部字段回传一遍"不该被当成错误）', noop.status === 200, String(noop.status));

    // 10) `.env` 是兜底那一层：换个带 key 与地址的配置再起一个 app，
    //     "表里没有但可用"这个状态必须能被说清（来源标注为 env）。
    const envApp = createApp({
      db,
      config: buildConfig({
        deepseekApiKey: 'env-key-1234567890',
        modelBaseUrl: 'https://relay.example.com/v1',
      }),
      schemaVersion: migration.toVersion,
      startedAt: Date.now(),
      models: createLabModels(),
    });
    const envRes = await envApp.request('/api/v1/system-config', { headers: { cookie: adminCookie } });
    const envView = (await envRes.json()) as SystemConfigResponse;
    check('★ 表里没有 key、`.env` 里有 → available=true 且 apiKeySource 标为 env', envView.model.available === true && envView.model.apiKeySource === 'env', JSON.stringify(envView.model));
    check(
      '接口地址也回落到 `.env` 的值',
      envView.model.baseUrl === 'https://relay.example.com/v1' && envView.model.baseUrlSource === 'env',
    );
    check(
      '★ 这种情况下列表里那一行仍然是"没有 key"（表里的空值行 ≠ 生效值；表与它是两件事）',
      envView.items.every((i) => !(i.key === 'model.api_key' && i.isSet)),
      JSON.stringify(envView.items.filter((i) => i.key === 'model.api_key')),
    );
  }

  // ── 9. 登录限流 ────────────────────────────────────────────
  console.log('\n登录限流：');
  {
    // 直接测限流器本身：窗口过期后必须放行（否则被挡的人永远进不来）。
    const limiter = new LoginRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i += 1) limiter.recordFailure('1.2.3.4', 'u', t0);
    let hit: unknown = null;
    try {
      limiter.check('1.2.3.4', 'u', t0);
    } catch (err) {
      hit = err;
    }
    check('同一 IP + 同一用户名连错 5 次 → 第 6 次被挡', hit !== null);
    check(
      '挡住时给的是 rate_limited + retryDelayMs（客户端知道该等多久）',
      (hit as { code?: string }).code === 'rate_limited' && ((hit as { retryDelayMs?: number }).retryDelayMs ?? 0) >= 1000,
      JSON.stringify(hit),
    );
    try {
      limiter.check('1.2.3.4', 'u', t0 + 15 * 60_000 + 1);
      check('窗口滑过之后放行（不做永久锁账号）', true);
    } catch {
      check('窗口滑过之后放行（不做永久锁账号）', false);
    }
    // 全局那档不该被"某人登录成功"清掉 —— 否则攻击者用自己的账号就能重置计数。
    const l2 = new LoginRateLimiter();
    for (let i = 0; i < 100; i += 1) l2.recordFailure(`ip-${i}`, `u-${i}`, t0);
    l2.recordSuccess('ip-0', 'u-0');
    let globalHit = false;
    try {
      l2.check('brand-new-ip', 'brand-new-user', t0);
    } catch {
      globalHit = true;
    }
    check('分布式撞库：换 IP 也挡得住（全局那档不被成功登录重置）', globalHit);

    // 走 HTTP 再验一遍：被限流的请求回的是 429 —— 而 429 只可能在
    // loginLimiter.check() 那一行抛出，那一行就在校验口令之前。
    const probeIp = '203.0.113.9';
    const tReal0 = Date.now();
    const realFail = await api('/api/v1/auth/login', {
      ...json({ username: 'member', password: 'definitely-wrong' }),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
    });
    const realMs = Date.now() - tReal0;
    check('口令错 → 401 unauthenticated（不是 403，也不是"用户不存在"）', realFail.status === 401 && (await bodyOf<ApiErrorBody>(realFail)).error.code === 'unauthenticated');

    for (let i = 0; i < 5; i += 1) {
      await api('/api/v1/auth/login', {
        ...json({ username: 'member', password: 'definitely-wrong' }),
        headers: { 'content-type': 'application/json', 'x-forwarded-for': probeIp },
      });
    }
    const tLimit0 = Date.now();
    const limited = await api('/api/v1/auth/login', {
      ...json({ username: 'member', password: 'definitely-wrong' }),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': probeIp },
    });
    const limitedMs = Date.now() - tLimit0;
    const limitedBody = await bodyOf<ApiErrorBody>(limited);
    check(
      '★ 连续失败 → HTTP 429 rate_limited',
      limited.status === 429 && limitedBody.error.code === 'rate_limited',
      `${limited.status} ${limitedBody.error.code}`,
    );
    check('429 的响应带 retryable=true 与 retryDelayMs', limitedBody.error.retryable === true && (limitedBody.error.retryDelayMs ?? 0) >= 1000);
    check(
      '★ 限流在**算哈希之前**：被挡的请求显著快于一次真实校验（429 只可能从 check() 那行抛出）',
      limitedMs * 2 < realMs,
      `被挡 ${limitedMs}ms vs 真实 ${realMs}ms`,
    );
    const stillOk = await api('/api/v1/auth/login', json({ username: 'admin', password: 'admin-pw-123456' }));
    check('限流是按键的，别的账号不受影响', stillOk.status === 200, String(stillOk.status));
  }

  // ── 结果 ───────────────────────────────────────────────────
  db.close();
  const total = passed + failures.length;
  console.log(`\n${passed}/${total} 通过`);
  if (failures.length > 0) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`\n临时数据留在 ${ROOT}（可直接删除，与真实数据无关）。`);
  }
}

/** 这个用户当前有几个会话。断言"过期即删"用。 */
function countSessions(db: Db, userId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?').get(userId) as unknown as { n: number };
  return row.n;
}

function findRole(db: Db, username: string): string | null {
  const row = db.prepare('SELECT role FROM users WHERE username = ?').get(username) as unknown as { role: string } | undefined;
  return row?.role ?? null;
}

function findHash(db: Db, username: string): string | null {
  const row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(username) as unknown as { password_hash: string } | undefined;
  return row?.password_hash ?? null;
}

await main();
