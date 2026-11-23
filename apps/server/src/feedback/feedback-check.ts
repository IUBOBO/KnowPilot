/**
 * 回答反馈（O5）的验证脚本：`npm run verify-feedback -w @knowpilot/server`。
 *
 * 【这一份钉死的是什么】
 *   · 一次运行只有一条有效反馈，改投是**覆盖**（不是再插一行）；
 *   · 只能给自己的运行打分，别人的运行与不存在的运行在响应上不可区分（都 404）；
 *   · 赞会清掉踩的原因与说明（否则管理端统计把满意的回答也算进问题里）；
 *   · 反馈列表与导出只对 `feedback.manage` 开放，导出会写审计行；
 *   · 表里**没有回答正文** —— 这是从一开始就定下的口径（迁移 v6 / v20）。
 *
 * 【为什么直接插入 ask_records 而不真问一次】同 auth-check：真问一次要花真钱、
 *   要联网，而且测出来的是"今天模型顺不顺"。这一层要钉的是归属、覆盖、权限与形状。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ApiErrorBody,
  ExportFeedbackDraftResponse,
  ListAdminFeedbackResponse,
  SubmitFeedbackResponse,
} from '@knowpilot/shared';
import { createApp } from '../app.ts';
import { createLabModels } from '../agent/models.ts';
import { insertAskRecord } from '../agent/records.ts';
import type { AppConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import type { Db } from '../db/index.ts';
import { SESSION_COOKIE } from '../auth/session.ts';
import { insertUser } from '../auth/users.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'knowpilot-feedback-verify-'));
const FIXED_NOW = new Date('2026-10-18T04:00:00.000Z');

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

function buildConfig(): AppConfig {
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
  };
}

async function main(): Promise<void> {

  const cfg = buildConfig();
  const { db, migration } = openDb(cfg.dbPath);
  // createApp 内部会跑 verifyRouteCoverage —— 它能返回本身就是"所有 /api/v1/*
  // 都登记了权限规则"（包括本阶段新增的三条）。
  const app = createApp({
    db,
    config: cfg,
    schemaVersion: migration.toVersion,
    startedAt: Date.now(),
    models: createLabModels(),
  });

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

  async function loginCookie(username: string, password: string): Promise<string> {
    const res = await api('/api/v1/auth/login', json({ username, password }));
    assert.equal(res.status, 200, `登录 ${username} 应当成功`);
    const raw = res.headers.get('set-cookie') ?? '';
    const token = /kp_session=([^;]*)/u.exec(raw)?.[1];
    assert.ok(token !== undefined && token !== '', `响应里应当有 kp_session：${raw}`);
    return `${SESSION_COOKIE}=${token}`;
  }

  console.log(`\n迁移已到 v${migration.toVersion}，临时根目录：${ROOT}\n`);

  const adminId = await insertUser(
    db,
    'fb-admin',
    { password: 'admin-pw-123456', role: 'admin', displayName: '管理员' },
    FIXED_NOW,
  );
  const memberId = await insertUser(
    db,
    'fb-member',
    { password: 'member-pw-123456', role: 'member', displayName: '成员甲' },
    FIXED_NOW,
  );
  await insertUser(
    db,
    'fb-other',
    { password: 'other-pw-123456', role: 'member', displayName: '成员乙' },
    FIXED_NOW,
  );
  const otherId = (
    db.prepare('SELECT id FROM users WHERE username = ?').get('fb-other') as { id: string }
  ).id;

  const adminCookie = await loginCookie('fb-admin', 'admin-pw-123456');
  const memberCookie = await loginCookie('fb-member', 'member-pw-123456');

  const run = (runId: string, question: string, userId: string | null): void => {
    insertAskRecord(db, {
      runId,
      question,
      askedAt: FIXED_NOW.toISOString(),
      consentConfirmed: true,
      outcome: 'ok',
      citationCount: 2,
      gapCount: 1,
      rounds: 3,
      durationMs: 4200,
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
      warnings: [],
      userId,
    });
  };
  run('run-own', '轻量目标检测用了什么方法？', memberId);
  run('run-other', '请假流程是什么？', otherId);
  run('run-second', '期刊分区怎么查？', memberId);

  // ── 1. 写入与形状 ───────────────────────────────────────────
  console.log('写入反馈：');
  {
    const res = await api(
      '/api/v1/ask-records/run-own/feedback',
      json({ rating: 'down', reasons: ['wrong', 'off-topic'], note: '  引用的段落里没有这句话  ' }),
      memberCookie,
    );
    check('member 给自己的运行打分 → 200', res.status === 200, String(res.status));
    const body = await bodyOf<SubmitFeedbackResponse>(res);
    check('评分是踩', body.feedback.rating === 'down', body.feedback.rating);
    check('预设原因按提交的顺序保存', body.feedback.reasons.join(',') === 'wrong,off-topic');
    check('说明首尾空白被去掉', body.feedback.note === '引用的段落里没有这句话', String(body.feedback.note));
    check('runId 原样返回', body.feedback.runId === 'run-own');
    check(
      '表里只有一条',
      countRows(db, 'answer_feedback') === 1,
      String(countRows(db, 'answer_feedback')),
    );
  }

  // ── 2. 改投覆盖 ─────────────────────────────────────────────
  console.log('\n改投覆盖（同一运行只能有一条有效反馈）：');
  {
    const before = getFeedbackRow(db, 'run-own');
    const res = await api(
      '/api/v1/ask-records/run-own/feedback',
      json({ rating: 'up', reasons: ['wrong'], note: '这条不该留下' }),
      memberCookie,
    );
    const body = await bodyOf<SubmitFeedbackResponse>(res);
    const after = getFeedbackRow(db, 'run-own');
    check('赞覆盖成功', res.status === 200 && body.feedback.rating === 'up', `${res.status} ${body.feedback.rating}`);
    check('赞会清空踩的原因', body.feedback.reasons.length === 0 && after.reasons === '[]');
    check('赞会清空踩的说明', body.feedback.note === null && after.note === null);
    check('仍然只有一条（不是再插一行）', countRows(db, 'answer_feedback') === 1, String(countRows(db, 'answer_feedback')));
    check('created_at 不被改写', after.createdAt === before.createdAt, `${before.createdAt} -> ${after.createdAt}`);
  }

  // ── 3. 参数校验 ─────────────────────────────────────────────
  console.log('\n参数校验：');
  {
    const invalid = async (payload: unknown, label: string): Promise<void> => {
      const res = await api('/api/v1/ask-records/run-own/feedback', json(payload), memberCookie);
      const body = await bodyOf<ApiErrorBody>(res);
      check(`${label} → 400 invalid_argument`, res.status === 400 && body.error.code === 'invalid_argument', `${res.status} ${body.error.code}`);
    };
    await invalid({ rating: 'meh' }, '不认识的评分');
    await invalid({ rating: 'down', reasons: ['nonsense'] }, '不认识的原因键');
    await invalid({ rating: 'down', reasons: 'wrong' }, 'reasons 不是数组');
    await invalid({ rating: 'down', note: 'x'.repeat(501) }, '说明超过 500 字');
    await invalid(['down'], '请求体不是对象');

    // 用 run-second 而不是 run-own：run-own 已在上一段被改成"赞"，
    // 这里再写一次踩会把那条断言的前提掀掉（第一次跑就是这么红的）。
    const dedupe = await api(
      '/api/v1/ask-records/run-second/feedback',
      json({ rating: 'down', reasons: ['slow', 'slow', 'missing'] }),
      memberCookie,
    );
    const body = await bodyOf<SubmitFeedbackResponse>(dedupe);
    check('重复的原因键去重（不是报错）', body.feedback.reasons.join(',') === 'slow,missing', body.feedback.reasons.join(','));
  }

  // ── 4. 归属：别人的运行一律 404 ─────────────────────────────
  console.log('\n归属校验：');
  {
    const other = await api(
      '/api/v1/ask-records/run-other/feedback',
      json({ rating: 'down', reasons: ['wrong'] }),
      memberCookie,
    );
    const otherBody = await bodyOf<ApiErrorBody>(other);
    check('给别人的运行打分 → 404', other.status === 404 && otherBody.error.code === 'not_found', `${other.status} ${otherBody.error.code}`);

    const missing = await api(
      '/api/v1/ask-records/run-does-not-exist/feedback',
      json({ rating: 'down' }),
      memberCookie,
    );
    const missingBody = await bodyOf<ApiErrorBody>(missing);
    check('不存在的运行 → 404', missing.status === 404 && missingBody.error.code === 'not_found');
    check(
      '别人的运行与不存在的运行，文案一致（不可区分）',
      otherBody.error.message === missingBody.error.message,
      `${otherBody.error.message} / ${missingBody.error.message}`,
    );
    check(
      '别人的运行没有被写入',
      (db.prepare('SELECT COUNT(*) AS n FROM answer_feedback WHERE run_id = ?').get('run-other') as { n: number }).n === 0,
    );
  }

  // ── 5. 权限：列表与导出只有管理员 ───────────────────────────
  console.log('\n权限：');
  {
    // 先造一条踩，供后面的筛选与导出使用。
    await api(
      '/api/v1/ask-records/run-second/feedback',
      json({ rating: 'down', reasons: ['missing'], note: '库里明明有这条制度' }),
      memberCookie,
    );

    const anon = await api('/api/v1/admin/feedback');
    check('匿名访问反馈列表 → 401', anon.status === 401, String(anon.status));

    const memberList = await api('/api/v1/admin/feedback', {}, memberCookie);
    check('member 访问反馈列表 → 403', memberList.status === 403, String(memberList.status));

    const memberExport = await api('/api/v1/admin/feedback/run-second/export', { method: 'POST' }, memberCookie);
    check('member 导出草稿 → 403', memberExport.status === 403, String(memberExport.status));
  }

  // ── 6. 管理端列表与筛选 ─────────────────────────────────────
  console.log('\n管理端列表：');
  {
    const all = await bodyOf<ListAdminFeedbackResponse>(await api('/api/v1/admin/feedback', {}, adminCookie));
    check('管理员看到两条反馈', all.items.length === 2, String(all.items.length));
    check(
      '全量计数：all=2 up=1 down=1',
      all.counts.all === 2 && all.counts.up === 1 && all.counts.down === 1,
      JSON.stringify(all.counts),
    );
    const downItem = all.items.find((i) => i.runId === 'run-second');
    check('问题原文来自 ask_records', downItem?.question === '期刊分区怎么查？', String(downItem?.question));
    check('提问人显示名来自 users', downItem?.userName === '成员甲', String(downItem?.userName));
    check(
      '运行结果一并带出（结果 / 引用数 / 缺口数）',
      downItem?.outcome === 'ok' && downItem.citationCount === 2 && downItem.gapCount === 1,
      JSON.stringify({ outcome: downItem?.outcome, c: downItem?.citationCount, g: downItem?.gapCount }),
    );
    check(
      '列表项里没有任何"回答正文"字段',
      all.items.every((i) => !('answer' in i) && !('answerText' in i)),
    );

    const down = await bodyOf<ListAdminFeedbackResponse>(
      await api('/api/v1/admin/feedback?rating=down', {}, adminCookie),
    );
    check('踩筛选只返回踩', down.items.length === 1 && down.items[0]?.runId === 'run-second', String(down.items.length));
    check(
      '筛选后计数仍是全量（否则切档时另一档会显示 0）',
      down.counts.all === 2 && down.counts.up === 1 && down.counts.down === 1,
      JSON.stringify(down.counts),
    );

    const up = await bodyOf<ListAdminFeedbackResponse>(
      await api('/api/v1/admin/feedback?rating=up', {}, adminCookie),
    );
    check('赞筛选只返回赞', up.items.length === 1 && up.items[0]?.runId === 'run-own');

    const bad = await api('/api/v1/admin/feedback?rating=bogus', {}, adminCookie);
    check('拼错的 rating → 400（不静默退化成"全部"）', bad.status === 400, String(bad.status));
  }

  // ── 7. 导出草稿与审计 ───────────────────────────────────────
  console.log('\n导出草稿：');
  {
    const res = await api('/api/v1/admin/feedback/run-second/export', { method: 'POST' }, adminCookie);
    check('管理员导出 → 200', res.status === 200, String(res.status));
    const body = await bodyOf<ExportFeedbackDraftResponse>(res);
    check('kind 标明这是草稿', body.draft.kind === 'knowpilot-eval-case-draft', body.draft.kind);
    check('草稿里带问题原文', body.draft.question === '期刊分区怎么查？', String(body.draft.question));
    check('草稿里带反馈内容', body.draft.feedback.rating === 'down' && body.draft.feedback.note === '库里明明有这条制度');
    check('gold / checks 留空（必须人工补齐）', body.draft.caseDraft.gold.length === 0 && body.draft.caseDraft.checks.length === 0);
    check('notice 说明不保存回答正文', body.draft.notice.includes('不保存回答正文'), body.draft.notice);
    check('文件名以 feedback-draft- 开头', body.fileName.startsWith('feedback-draft-FB-'), body.fileName);
    check(
      '草稿里没有任何回答正文字段',
      !('answer' in body.draft) && !('answerText' in body.draft),
    );

    check('导出写了一条审计', countRows(db, 'feedback_exports') === 1, String(countRows(db, 'feedback_exports')));
    const audit = db
      .prepare('SELECT run_id, rating, exported_by FROM feedback_exports')
      .get() as { run_id: string; rating: string; exported_by: string };
    check(
      '审计内容：哪次运行、什么评分、谁导出的',
      audit.run_id === 'run-second' && audit.rating === 'down' && audit.exported_by === adminId,
      JSON.stringify(audit),
    );

    await api('/api/v1/admin/feedback/run-second/export', { method: 'POST' }, adminCookie);
    check('再次导出会再记一条审计（不覆盖历史）', countRows(db, 'feedback_exports') === 2);

    const missing = await api('/api/v1/admin/feedback/run-does-not-exist/export', { method: 'POST' }, adminCookie);
    check('导出不存在的反馈 → 404', missing.status === 404, String(missing.status));
    check('失败的导出不写审计', countRows(db, 'feedback_exports') === 2);
  }

  // ── 8. 表结构：不存回答正文 ─────────────────────────────────
  console.log('\n表结构（不存回答正文）：');
  {
    const columns = (db.prepare('PRAGMA table_info(answer_feedback)').all() as unknown as { name: string }[]).map(
      (c) => c.name,
    );
    check(
      'answer_feedback 的列里没有 answer / answer_text',
      !columns.includes('answer') && !columns.includes('answer_text'),
      columns.join(','),
    );
    const auditColumns = (
      db.prepare('PRAGMA table_info(feedback_exports)').all() as unknown as { name: string }[]
    ).map((c) => c.name);
    check(
      '审计表也不复制提问或回答内容',
      !auditColumns.includes('question') && !auditColumns.includes('answer'),
      auditColumns.join(','),
    );
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

function countRows(db: Db, table: string): number {
  // 表名来自本文件内的字面量，不是请求输入。
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function getFeedbackRow(
  db: Db,
  runId: string,
): { createdAt: string; reasons: string; note: string | null } {
  const row = db
    .prepare('SELECT created_at, reasons, note FROM answer_feedback WHERE run_id = ?')
    .get(runId) as { created_at: string; reasons: string; note: string | null };
  return { createdAt: row.created_at, reasons: row.reasons, note: row.note };
}

await main();
