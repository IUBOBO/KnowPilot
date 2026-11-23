/**
 * 知识沉淀的验证脚本：`npm run verify-knowledge -w @knowpilot/server`。
 *
 * 【这个脚本不花模型的钱】它直接调 repo（`insertEntries`）造草案，不走生成那条
 *   路由 —— 生成要花费真钱，留在 `npm run knowledge`（临时 CLI）里人工跑。
 *   脚本验的是"权限、可见性、状态机、索引边界"这些确定的性质。
 *
 * 【骨架照 organize-check.ts】`api()` 打真实路由栈（app.request），自建临时
 *   根目录与临时库，跑完可整个删掉。为什么不新增一套夹具：同 upload-check 的
 *   理由 —— 挑端口、起子进程、等就绪那套夹具自身出错时，很难判断是接口坏了
 *   还是夹具坏了。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ApiErrorBody,
  ConfirmKnowledgeGroupResponse,
  CreateKnowledgeDraftsResponse,
  DocumentSummary,
  KnowledgeEntry,
  KnowledgeReviewQueueResponse,
  ListDocumentsResponse,
  ListKnowledgeEntriesResponse,
  RejectKnowledgeResponse,
  ResolveKnowledgeResponse,
  ResubmitKnowledgeResponse,
  SearchResponse,
  WithdrawKnowledgeResponse,
} from '@knowpilot/shared';
import { createApp } from '../app.ts';
import { createLabModels } from '../agent/models.ts';
import { defaultHfHome, findRepoRoot, type AppConfig } from '../config.ts';
import { SESSION_COOKIE, createSession } from '../auth/session.ts';
import { insertUser } from '../auth/users.ts';
import { ruleFor } from '../auth/routes.ts';
import { openDb } from '../db/index.ts';
import type { Db } from '../db/index.ts';
import { isModelReady } from '../documents/embed.ts';
import { ingestDocument } from '../documents/ingest.ts';
import { uploadDocument } from '../documents/upload.ts';
import {
  findById as findEntry,
  insertEntries,
  listByGroup,
  markActive,
  markConflicted,
} from './repo.ts';
import { nearestActive } from './conflict.ts';
import { renderKnowledgeMarkdown } from './markdown.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'knowpilot-knowledge-verify-'));

let passed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name} —— ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 本脚本的临时根目录。
 *
 * 【默认为什么把模型指向临时目录】这样 `isModelReady` 必然为假 → 冲突检测整体
 *   走降级分支、十几秒跑完全部 51 条断言、**不花一分钱**。
 *   要跑真实 embedding 的那段可选检查（校准 + 真冲突对），设
 *   `KNOWLEDGE_CHECK_REAL_MODEL=1` 再跑一次 —— 那时它改用真实的模型目录。
 *   刻意做成**显式开关**而不是"检测到模型就自动跑"：自动跑意味着这个脚本的
 *   耗时与是否花钱取决于那台机器上碰巧有没有下过模型，同一套命令在两台机器上
 *   行为不同，是最难交接的一种。
 */
const REAL_MODEL = process.env['KNOWLEDGE_CHECK_REAL_MODEL'] === '1';
const REAL_HF_HOME = defaultHfHome(findRepoRoot(process.cwd()));

function buildConfig(): AppConfig {
  const hfHome = REAL_MODEL ? REAL_HF_HOME : join(ROOT, 'hf');
  return {
    port: 0,
    dbPath: join(ROOT, 'knowpilot.db'),
    uploadDir: join(ROOT, 'uploads'),
    repoRoot: ROOT,
    deepseekApiKey: undefined,
    modelChat: 'deepseek-flash',
    modelReasoner: 'deepseek-v4-pro',
    modelBaseUrl: undefined,
    hfHome,
    // 默认指向临时目录 → 嵌入模型必然不就绪 → 冲突检测走降级分支，不花一分钱。
    embedModelDir: join(hfHome, 'knowpilot-models'),
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
    knowledgeConflictThreshold: 0.76,
    patrolIntervalHours: 24,
    sessionIdleDays: 7,
    sessionMaxDays: 30,
    cookieSecure: false,
    adminUsername: undefined,
    adminPassword: undefined,
  };
}

let sessionCookie = '';

/** 数某张表有多少行。表名是代码里写死的字面量，不是外部输入，故可直接拼。 */
function countRows(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as { n: number };
  return row.n;
}

function withCookie(init: RequestInit): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), cookie: sessionCookie },
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

  // ── 账号：member（有 read/submit，无 review）+ mentor（有 review）──
  //
  // 【为什么要两个角色】行级可见性（只看自己的）与 review 的越权，两件事都要
  //   有反例才验得出来。同一个人身上验不了。
  const now = new Date();
  const memberId = await insertUser(
    db,
    'kb-member',
    { password: 'kb-member-pw-2026', role: 'member', displayName: '成员甲' },
    now,
  );
  const otherId = await insertUser(
    db,
    'kb-other',
    { password: 'kb-other-pw-2026', role: 'member', displayName: '成员乙' },
    now,
  );
  const mentorId = await insertUser(
    db,
    'kb-mentor',
    { password: 'kb-mentor-pw-2026', role: 'mentor', displayName: '导师' },
    now,
  );

  const cookieFor = (userId: string): string => {
    const { token } = createSession(db, {
      userId,
      now: new Date(),
      idleDays: cfg.sessionIdleDays,
      maxDays: cfg.sessionMaxDays,
      ip: null,
      userAgent: null,
    });
    return `${SESSION_COOKIE}=${token}`;
  };
  const asMember = cookieFor(memberId);
  const asOther = cookieFor(otherId);
  const asMentor = cookieFor(mentorId);
  // 默认身份 = 成员甲。不默认成空的话，下面不走 runAs 的那几条（对照文档、
  // 纯 SQL 造的草案）会以"未登录"跑，如实回 401 —— 那样失败的是夹具而不是被测代码。
  sessionCookie = asMember;

  const api = async (path: string, init: RequestInit = {}): Promise<Response> =>
    app.request(path, withCookie(init));
  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const bodyOf = async <T>(res: Response): Promise<T> => (await res.json()) as T;

  const runAs = async <T>(cookie: string, fn: () => Promise<T>): Promise<T> => {
    const prev = sessionCookie;
    sessionCookie = cookie;
    try {
      return await fn();
    } finally {
      sessionCookie = prev;
    }
  };

  const search = async (q: string): Promise<SearchResponse> => {
    const res = await api(`/api/v1/search?mode=keyword&q=${encodeURIComponent(q)}`);
    // ⚠️ 先把 body 读出来再断言：`assert.equal(res.status, 200, \`…${await res.text()}\`)`
    //   里的模板串是**无条件求值**的，即便断言通过也已经把 body 消费掉，
    //   下一句 res.json() 就会抛 "Body has already been read"。
    const body = await bodyOf<SearchResponse>(res);
    assert.equal(res.status, 200, `检索应成功，实际 ${res.status}：${JSON.stringify(body)}`);
    return body;
  };

  console.log(`\n迁移已到 v${migration.toVersion}，临时根目录：${ROOT}\n`);

  // ── 1. 迁移与表结构 ────────────────────────────────────────
  await check('迁移 v17 已应用，knowledge_entries 列与设计一致', () => {
    assert.ok(migration.toVersion >= 17, `期望 >= 17，实际 ${migration.toVersion}`);
    const cols = (db.prepare('PRAGMA table_info(knowledge_entries)').all() as unknown as {
      name: string;
    }[]).map((r) => r.name);
    for (const c of [
      'id', 'kind', 'status', 'content', 'source_type', 'source_id', 'session_id',
      'observed_at', 'confirmed_by', 'confirmed_at', 'group_id', 'created_by',
      'document_id', 'note',
    ]) {
      assert.ok(cols.includes(c), `缺少列 ${c}；实有 ${cols.join(',')}`);
    }
  });

  await check('document_id 外键是 ON DELETE SET NULL（撤索引依赖它）', () => {
    const fks = db.prepare('PRAGMA foreign_key_list(knowledge_entries)').all() as unknown as {
      from: string;
      table: string;
      to: string;
      on_delete: string;
    }[];
    const docFk = fks.find((f) => f.from === 'document_id');
    assert.ok(docFk !== undefined, '缺少 document_id 外键');
    assert.equal(docFk.table, 'documents');
    assert.equal(docFk.on_delete, 'SET NULL', `期望 SET NULL，实际 ${docFk.on_delete}`);
  });

  // ── 2. 路由登记 ────────────────────────────────────────────
  await check('八条知识路由都登记了权限（含撤回与重新提交）', () => {
    assert.equal(ruleFor('GET', '/api/v1/knowledge'), 'knowledge.read');
    assert.equal(ruleFor('POST', '/api/v1/knowledge/drafts'), 'knowledge.submit');
    assert.equal(ruleFor('GET', '/api/v1/knowledge/review'), 'knowledge.review');
    assert.equal(
      ruleFor('POST', '/api/v1/knowledge/groups/:groupId/confirm'),
      'knowledge.submit',
    );
    assert.equal(ruleFor('POST', '/api/v1/knowledge/:id/reject'), 'knowledge.submit');
    assert.equal(ruleFor('POST', '/api/v1/knowledge/:id/resolve'), 'knowledge.review');
    assert.equal(ruleFor('POST', '/api/v1/knowledge/:id/withdraw'), 'knowledge.submit');
    assert.equal(ruleFor('POST', '/api/v1/knowledge/:id/resubmit'), 'knowledge.submit');
  });

  // ── 3. 生成入口的输入闸门（不花模型钱：闸门在调模型之前）──────
  await check('drafts：未勾选同意 → 400', async () => {
    const res = await runAs(asMember, () =>
      api('/api/v1/knowledge/drafts', json({ text: '本组服务器共八张显卡，日常共享使用。' })),
    );
    assert.equal(res.status, 400);
    const body = await bodyOf<ApiErrorBody>(res);
    assert.match(body.error.message, /确认/u);
  });

  await check('drafts：内容太短 → 400', async () => {
    const res = await runAs(asMember, () =>
      api('/api/v1/knowledge/drafts', json({ text: '嗯', consentConfirmed: true })),
    );
    assert.equal(res.status, 400);
    const body = await bodyOf<ApiErrorBody>(res);
    assert.match(body.error.message, /太短/u);
  });

  await check('drafts：内容过长 → 400', async () => {
    const res = await runAs(asMember, () =>
      api(
        '/api/v1/knowledge/drafts',
        json({ text: '甲'.repeat(4001), consentConfirmed: true }),
      ),
    );
    assert.equal(res.status, 400);
    const body = await bodyOf<ApiErrorBody>(res);
    assert.match(body.error.message, /太长/u);
  });

  await check('drafts：text 不是字符串 → 400', async () => {
    const res = await runAs(asMember, () =>
      api('/api/v1/knowledge/drafts', json({ text: 42, consentConfirmed: true })),
    );
    assert.equal(res.status, 400);
  });

  // ── 4. GC-12 前半：草案不进索引、检索不到 ──────────────────
  //
  // 【为什么要先放一份"对照文档"】把草案搜不到和"检索本身坏了"区分开 ——
  //   一个空库上搜什么都搜不到，那种 0 命中证明不了任何事。
  const CONTROL_MARK = '对照文档专用标记甲乙丙';
  const DRAFT_MARK = '待确认草案专用标记丁戊己';
  const REJECT_MARK = '被驳回内容专用标记庚辛壬';

  await check('对照文档：上传并入库后，检索得到（证明检索本身是通的）', async () => {
    const file = new File([`# 对照文档\n\n这份文档含有${CONTROL_MARK}，用来证明检索链路是通的。\n`], 'control.md', {
      type: 'text/markdown',
    });
    const up = await uploadDocument(db, cfg, {
      file,
      material: 'knowledge',
      title: '对照文档',
      uploadedBy: memberId,
      consentConfirmedBy: memberId,
    });
    await ingestDocument(db, cfg, up.documentId);
    const hits = await search(CONTROL_MARK);
    assert.ok(hits.hits.length >= 1, `对照文档应当被检索到，实际 ${hits.hits.length} 条`);
  });

  const groupId = 'grp-unitB-0001';
  const draftIds = ['kd-b1', 'kd-b2'];

  await check('插入一组 proposed 草案（直接调 repo，不走模型）', () => {
    insertEntries(db, [
      {
        id: draftIds[0] ?? 'kd-b1',
        kind: 'fact',
        content: `本组服务器共八张显卡。${DRAFT_MARK}`,
        sourceType: 'conversation',
        sourceId: null,
        sessionId: null,
        observedAt: new Date().toISOString(),
        groupId,
        createdBy: memberId,
      },
      {
        id: draftIds[1] ?? 'kd-b2',
        kind: 'decision',
        // 【为什么不带 DRAFT_MARK】两条都带同一个生造标记词的话，它们彼此的
        //   相似度会被那个词抬起来。默认路径下模型不就绪看不出来，但一旦用
        //   `KNOWLEDGE_CHECK_REAL_MODEL=1` 跑真实向量，第二条就可能被判成与
        //   第一条冲突 —— 于是这一组"两条都该 active"的断言会莫名其妙地红。
        //   唯一标记只留在第一条上（GC-12 的两条断言都用它）。
        content: '投稿一律走盲审模板，不要用普通模板。',
        sourceType: 'conversation',
        sourceId: null,
        sessionId: null,
        observedAt: new Date().toISOString(),
        groupId,
        createdBy: memberId,
      },
    ]);
    assert.equal(listByGroup(db, groupId).length, 2);
  });

  await check('GC-12 前半：草案检索不到（同一词在对照文档上却是命中的）', async () => {
    const hits = await search(DRAFT_MARK);
    assert.equal(hits.hits.length, 0, `草案不该被检索到，实际命中 ${hits.hits.length} 条`);
  });

  await check('GC-12 前半：草案不在 documents 里（所以按 material 也找不到）', async () => {
    const res = await runAs(asMember, () => api('/api/v1/documents?material=knowledge'));
    const body = await bodyOf<ListDocumentsResponse>(res);
    const titles = body.items.map((d: DocumentSummary) => d.title);
    assert.ok(!titles.includes(DRAFT_MARK), `documents 里不该出现草案：${titles.join(',')}`);
    // 对照文档应该在
    assert.ok(titles.includes('对照文档'), '对照文档应当出现在列表里');
  });

  // ── 5. 列表与行级可见性 ────────────────────────────────────
  await check('GET /knowledge：member 看得到自己提交的一组', async () => {
    const res = await runAs(asMember, () => api('/api/v1/knowledge'));
    assert.equal(res.status, 200);
    const body = await bodyOf<ListKnowledgeEntriesResponse>(res);
    assert.ok(
      body.items.some((e: KnowledgeEntry) => e.groupId === groupId),
      '应当看到自己那组草案',
    );
  });

  await check('GET /knowledge：另一个 member 看不到（不是他的）', async () => {
    const res = await runAs(asOther, () => api('/api/v1/knowledge'));
    const body = await bodyOf<ListKnowledgeEntriesResponse>(res);
    assert.ok(
      !body.items.some((e: KnowledgeEntry) => e.groupId === groupId),
      '别的成员不该看到这一组草案',
    );
  });

  await check('GET /knowledge：mentor（有 review）看不到**未确认的草案**（本轮收口）', async () => {
    const res = await runAs(asMentor, () => api('/api/v1/knowledge'));
    const body = await bodyOf<ListKnowledgeEntriesResponse>(res);
    // proposed 是作者还没提交的东西，不该摊给审核者 —— 即使他有 review 权限。
    assert.ok(
      !body.items.some((e: KnowledgeEntry) => e.status === 'proposed'),
      `导师不该看到任何未确认草案，实际看到 ${body.items.filter((e) => e.status === 'proposed').length} 条`,
    );
  });

  await check('GET /knowledge?status=proposed 过滤生效', async () => {
    const res = await runAs(asMember, () => api('/api/v1/knowledge?status=proposed'));
    const body = await bodyOf<ListKnowledgeEntriesResponse>(res);
    assert.ok(body.items.length >= 2);
    assert.ok(body.items.every((e: KnowledgeEntry) => e.status === 'proposed'));
  });

  await check('GET /knowledge：非法 status → 400', async () => {
    const res = await runAs(asMember, () => api('/api/v1/knowledge?status=nonsense'));
    assert.equal(res.status, 400);
  });

  // ── 6. 返回体的形状（前端要用）────────────────────────────
  await check('条目带 title / createdByName，且 title 来自正文', async () => {
    const res = await runAs(asMember, () => api('/api/v1/knowledge'));
    const body = await bodyOf<ListKnowledgeEntriesResponse>(res);
    const entry = body.items.find((e: KnowledgeEntry) => e.groupId === groupId);
    assert.ok(entry !== undefined);
    assert.equal(entry.createdByName, '成员甲');
    assert.equal(entry.kind, 'fact');
    assert.ok(entry.title.length > 0 && !entry.title.includes('\n'), '标题应是单行非空');
    assert.equal(entry.status, 'proposed');
    assert.equal(entry.documentId, null);
  });

  // ── 7. 未登录 ──────────────────────────────────────────────
  await check('GET /knowledge：未登录 → 401', async () => {
    const res = await app.request('/api/v1/knowledge');
    assert.equal(res.status, 401);
  });

  // ── 8. 确认入库（单元 C）：GC-12 后半 ──────────────────────
  //
  // 这一段是本阶段的验收动作本身：同一句话，确认**前**搜不到、确认**后**搜得到。
  const docsBefore = countRows(db, 'documents');

  await check('确认整组：owner 确认自己的 → 逐条 active', async () => {
    const res = await runAs(asMember, () =>
      api(`/api/v1/knowledge/groups/${groupId}/confirm`, json({ consentConfirmed: true })),
    );
    const body = await bodyOf<ConfirmKnowledgeGroupResponse>(res);
    assert.equal(res.status, 200, `确认应成功，实际 ${res.status}：${JSON.stringify(body)}`);
    assert.equal(body.results.length, 2);
    assert.ok(
      body.results.every((r) => r.outcome === 'active'),
      `两条都该入库，实际 ${JSON.stringify(body.results)}`,
    );
    const entries = listByGroup(db, groupId);
    assert.ok(entries.every((e) => e.status === 'active'), '条目状态应为 active');
    assert.ok(entries.every((e) => e.documentId !== null), 'active 条目应指向一份文档');
    assert.ok(entries.every((e) => e.confirmedByName === '成员甲'), '应记下确认人');
    assert.ok(entries.every((e) => e.firstChunkId !== null), '应能给出"查看入库原文"的落点');
  });

  await check('确认整组：documents 新增 2 行 material=knowledge 且已就绪、有块', () => {
    const after = countRows(db, 'documents');
    assert.equal(after, docsBefore + 2, `应新增 2 份文档，实际新增 ${after - docsBefore}`);
    const rows = db
      .prepare(
        `SELECT d.status,
                (SELECT COUNT(*) FROM doc_chunks c WHERE c.doc_id = d.id) AS chunks
           FROM documents d
          WHERE d.material = 'knowledge' AND d.id IN (?, ?)`,
      )
      .all(
        ...listByGroup(db, groupId).map((e) => e.documentId ?? ''),
      ) as unknown as { status: string; chunks: number }[];
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.status, 'ready', '文档应解析就绪');
      assert.ok(r.chunks > 0, '应有已建索引的块（0 块 = 搜不到）');
    }
  });

  await check('GC-12 后半：同一个词，确认前 0 命中 → 确认后搜得到', async () => {
    const hits = await search(DRAFT_MARK);
    assert.ok(hits.hits.length >= 1, `确认后应当搜得到，实际 ${hits.hits.length} 条`);
    // 命中的应当是那份由知识条目物化出来的文档，而不是别的东西
    const titles = new Set(hits.hits.map((h) => h.documentTitle));
    assert.ok(titles.size > 0, '命中项应当带文档标题');
    const entryTitles = new Set(listByGroup(db, groupId).map((e) => e.title));
    for (const t of titles) {
      assert.ok(entryTitles.has(t), `命中的 ${JSON.stringify(t)} 应当是这两条知识的标题之一`);
    }
  });

  await check('入库文档的标题 = shared 的 knowledgeTitle 结果', () => {
    for (const entry of listByGroup(db, groupId)) {
      const doc = db
        .prepare('SELECT title FROM documents WHERE id = ?')
        .get(entry.documentId ?? '') as unknown as { title: string } | undefined;
      assert.ok(doc !== undefined, '文档应当存在');
      assert.equal(doc.title, entry.title, '两处标题必须一致（列表名 ≠ 入库名的典型漂移）');
    }
  });

  await check('原件能下载回来，且是那份 markdown', async () => {
    const entry = listByGroup(db, groupId)[0];
    assert.ok(entry !== undefined && entry.documentId !== null);
    const res = await runAs(asMember, () =>
      api(`/api/v1/documents/${entry.documentId ?? ''}/file`),
    );
    assert.equal(res.status, 200, `下载应成功，实际 ${res.status}`);
    const text = await res.text();
    assert.ok(text.includes(DRAFT_MARK), '下载回来的应当是含该知识的 markdown');
  });

  // ── 9. 幂等与状态门槛 ─────────────────────────────────────
  await check('幂等：重复确认同一组 → 全 skipped、documents 不再增', async () => {
    const before = countRows(db, 'documents');
    const res = await runAs(asMember, () =>
      api(`/api/v1/knowledge/groups/${groupId}/confirm`, json({ consentConfirmed: true })),
    );
    assert.equal(res.status, 200);
    const body = await bodyOf<ConfirmKnowledgeGroupResponse>(res);
    assert.ok(
      body.results.every((r) => r.outcome === 'skipped'),
      `重复确认应当全部跳过，实际 ${JSON.stringify(body.results)}`,
    );
    assert.equal(countRows(db, 'documents'), before, '重复确认不该再建文档');
  });

  await check('确认整组：未勾选同意 → 400', async () => {
    const res = await runAs(asMember, () =>
      api(`/api/v1/knowledge/groups/${groupId}/confirm`, json({})),
    );
    assert.equal(res.status, 400);
  });

  // ── 10. owner-or-review 与不泄露存在性 ────────────────────
  const otherGroupId = 'grp-unitC-0002';
  await check('另一组草案（属于成员乙），供越权断言用', () => {
    insertEntries(db, [
      {
        id: 'kd-c1',
        kind: 'lesson',
        content: '上次引用没核对卷号被退稿。',
        sourceType: 'conversation',
        sourceId: null,
        sessionId: null,
        observedAt: new Date().toISOString(),
        groupId: otherGroupId,
        createdBy: otherId,
      },
    ]);
  });

  await check('member 确认别人的一组 → 404（不泄露存在性）', async () => {
    const res = await runAs(asMember, () =>
      api(`/api/v1/knowledge/groups/${otherGroupId}/confirm`, json({ consentConfirmed: true })),
    );
    assert.equal(res.status, 404, `应当 404 而不是 403/200，实际 ${res.status}`);
    assert.equal(
      listByGroup(db, otherGroupId)[0]?.status,
      'proposed',
      '越权尝试不该改动任何东西',
    );
  });

  await check('mentor 确认别人的一组 → 200（有 review 权限）', async () => {
    const res = await runAs(asMentor, () =>
      api(`/api/v1/knowledge/groups/${otherGroupId}/confirm`, json({ consentConfirmed: true })),
    );
    assert.equal(res.status, 200, `导师应当可以代确认，实际 ${res.status}`);
    const body = await bodyOf<ConfirmKnowledgeGroupResponse>(res);
    assert.equal(body.results[0]?.outcome, 'active');
    assert.equal(listByGroup(db, otherGroupId)[0]?.status, 'active');
    assert.equal(
      listByGroup(db, otherGroupId)[0]?.confirmedByName,
      '导师',
      '确认人应当是导师，不是提交人',
    );
  });

  await check('不存在的 groupId → 404', async () => {
    const res = await runAs(asMember, () =>
      api('/api/v1/knowledge/groups/no-such-group/confirm', json({ consentConfirmed: true })),
    );
    assert.equal(res.status, 404);
  });

  // ── 11. 驳回 ───────────────────────────────────────────────
  const rejectGroupId = 'grp-unitC-0003';
  const rejectId = 'kd-c2';

  await check('驳回：落 deleted、不建文档、同一个词仍搜不到', async () => {
    insertEntries(db, [
      {
        id: rejectId,
        kind: 'fact',
        content: `这条注定被驳回。${REJECT_MARK}`,
        sourceType: 'conversation',
        sourceId: null,
        sessionId: null,
        observedAt: new Date().toISOString(),
        groupId: rejectGroupId,
        createdBy: memberId,
      },
    ]);
    const docsBeforeReject = countRows(db, 'documents');
    const res = await runAs(asMember, () =>
      api(`/api/v1/knowledge/${rejectId}/reject`, json({ reason: '这条不准确' })),
    );
    assert.equal(res.status, 200, `驳回应成功，实际 ${res.status}`);
    const body = await bodyOf<RejectKnowledgeResponse>(res);
    assert.equal(body.entry.status, 'deleted');
    assert.equal(body.entry.note?.reason, '这条不准确', '驳回原因应当留痕');
    assert.equal(countRows(db, 'documents'), docsBeforeReject, '驳回不该建文档');
    const hits = await search(REJECT_MARK);
    assert.equal(hits.hits.length, 0, '被驳回的内容不该被检索到');
  });

  await check('驳回：已驳回的不能再驳（幂等而非崩）', async () => {
    const res = await runAs(asMember, () =>
      api(`/api/v1/knowledge/${rejectId}/reject`, json({})),
    );
    assert.equal(res.status, 400);
  });

  await check('驳回：别人的条目 → 404', async () => {
    // 导师那条已经 active，换一条别人的 proposed
    const foreign = 'kd-c3';
    insertEntries(db, [
      {
        id: foreign,
        kind: 'fact',
        content: '成员乙的一条草案。',
        sourceType: 'conversation',
        sourceId: null,
        sessionId: null,
        observedAt: new Date().toISOString(),
        groupId: 'grp-unitC-0004',
        createdBy: otherId,
      },
    ]);
    const res = await runAs(asMember, () => api(`/api/v1/knowledge/${foreign}/reject`, json({})));
    assert.equal(res.status, 404);
    assert.equal(findEntry(db, foreign)?.status, 'proposed', '越权尝试不该改动任何东西');
  });

  await check('驳回原因过长 → 400（且条目仍未被改动）', async () => {
    const longId = 'kd-c4';
    insertEntries(db, [
      {
        id: longId,
        kind: 'fact',
        content: '为超长驳回原因准备的草案。',
        sourceType: 'conversation',
        sourceId: null,
        sessionId: null,
        observedAt: new Date().toISOString(),
        groupId: 'grp-unitC-0005',
        createdBy: memberId,
      },
    ]);
    const res = await runAs(asMember, () =>
      api(`/api/v1/knowledge/${longId}/reject`, json({ reason: '甲'.repeat(201) })),
    );
    assert.equal(res.status, 400);
    assert.equal(findEntry(db, longId)?.status, 'proposed');
  });

  // ── 12. 用量流水的归属 ────────────────────────────────────
  await check('确认入库不产生用量流水（只有模型调用才产生）', () => {
    // 本单元全程没调模型。已有流水只可能来自别处，这里断言"没有新增"
    const n = countRows(db, 'usage_events');
    assert.equal(n, 0, `确认入库不该写用量流水，实际有 ${n} 条`);
  });

  if (!REAL_MODEL) {
    await check('降级诚实性：模型未就绪时确认仍然成功（不假装查过冲突）', async () => {
      // 本脚本默认把 embedModelDir 指向临时目录 → isModelReady 为 false。
      assert.equal(isModelReady(cfg), false, '本脚本的前提是模型不就绪');
      const first = listByGroup(db, groupId)[0];
      assert.equal(first?.status, 'active', '模型不就绪不该挡住入库');
      // 【这条断言是这一段的重点】"没查"必须留下痕迹。若 note 是 null，
      //   库里与界面上都会显示成"查过且不冲突"——那是把一次没做的事说成做了。
      assert.match(
        first?.note?.reason ?? '',
        /未做冲突检测/u,
        `note.reason 里应当如实写明没做冲突检测，实际 ${JSON.stringify(first?.note)}`,
      );
    });
  } else {
    // 打开真实向量后前提不成立，这一条验不了（模型是就绪的）。
    // 它的价值在默认路径上，那里模型必然不就绪，所以不是被跳过了「一次」，
    // 而是换了一条路径跑 —— 上面真实向量段覆盖的是另一种情形。
    console.log('  （真实向量模式下，模型是就绪的，跳过"模型未就绪"那一条）');
  }

  // ── 13. 纯函数打分器（零模型开销）─────────────────────────
  //
  // 【为什么这段能完全脱离模型】nearestActive 是纯函数：喂合成向量即可。
  //   阈值两侧的行为因此是**确定性**的，不需要跑一次几秒的 embedding。
  const unit = (cos: number): Float32Array =>
    // 与 (1,0) 夹角 θ 的单位向量，点积恰为 cos —— 于是合成分数就是余弦本身。
    new Float32Array([cos, Math.sqrt(1 - cos * cos)]);

  await check('nearestActive：取最大那个（不是第一个）', () => {
    const rows = [
      { vec: unit(0.5), text: '不相关的一条', docId: 'd3', entryId: 'e3' },
      { vec: unit(0.95), text: '最像的一条', docId: 'd1', entryId: 'e1' },
      { vec: unit(0.8), text: '居中的一条', docId: 'd2', entryId: 'e2' },
    ];
    const best = nearestActive(new Float32Array([1, 0]), rows);
    assert.ok(best !== null);
    assert.equal(best.entryId, 'e1', '应当返回分数最高的那条');
    assert.ok(Math.abs(best.score - 0.95) < 1e-6, `分数应当≈0.95，实际 ${best.score}`);
    assert.equal(best.documentId, 'd1');
  });

  await check('nearestActive：阈值两侧的判据确实分得开', () => {
    const threshold = cfg.knowledgeConflictThreshold;
    // 分数跟着阈值走，而不是写死 0.95 / 0.80 —— 阈值一改（O11 从 0.82 调到 0.76），
    // 写死的那一对就会从"两侧"变成"同侧"，断言失败但产品没坏。
    const above = Math.min(0.99, threshold + 0.1);
    const below = threshold - 0.05;
    const high = nearestActive(new Float32Array([1, 0]), [
      { vec: unit(above), text: 'a', docId: 'd1', entryId: 'e1' },
    ]);
    const low = nearestActive(new Float32Array([1, 0]), [
      { vec: unit(below), text: 'b', docId: 'd2', entryId: 'e2' },
    ]);
    assert.ok(high !== null && high.score >= threshold, `${above} 应当被判为冲突`);
    assert.ok(low !== null && low.score < threshold, `${below} 应当放行`);
  });

  await check('nearestActive：空集合 → null；零向量 → null；维度不符 → 跳过', () => {
    assert.equal(nearestActive(new Float32Array([1, 0]), []), null, '没得比就是 null');
    assert.equal(
      nearestActive(new Float32Array([0, 0]), [
        { vec: unit(0.9), text: 'a', docId: 'd', entryId: 'e' },
      ]),
      null,
      '零向量没有方向，不该和谁相像',
    );
    assert.equal(
      nearestActive(new Float32Array([1, 0]), [
        { vec: new Float32Array([1, 0, 0]), text: 'a', docId: 'd', entryId: 'e' },
      ]),
      null,
      '维度不同的向量不可比，应当跳过而不是硬算',
    );
  });

  await check('nearestActive：未归一化的向量也算得出正确的余弦', () => {
    // (2,0) 与 (1,0) 同向，余弦应为 1（而不是点积给的 2）。
    // 这条是防"直接把点积当余弦"的回归：那会让阈值比较静默地为真。
    const best = nearestActive(new Float32Array([1, 0]), [
      { vec: new Float32Array([2, 0]), text: 'a', docId: 'd', entryId: 'e' },
    ]);
    assert.ok(best !== null);
    assert.ok(Math.abs(best.score - 1) < 1e-6, `余弦应当≈1，实际 ${best.score}`);
  });

  // ── 14. 审核队列的闸门 ────────────────────────────────────
  await check('GET /knowledge/review：member → 403（没有 review 权限）', async () => {
    const res = await runAs(asMember, () => api('/api/v1/knowledge/review'));
    assert.equal(res.status, 403);
  });

  await check('GET /knowledge/review：mentor → 200，只列 conflicted，且带上阈值', async () => {
    const res = await runAs(asMentor, () => api('/api/v1/knowledge/review'));
    assert.equal(res.status, 200);
    const body = await bodyOf<KnowledgeReviewQueueResponse>(res);
    assert.equal(body.threshold, cfg.knowledgeConflictThreshold, '界面要显示阈值，必须回传');
    assert.ok(
      body.items.every((e) => e.status === 'conflicted'),
      '队列里只该有冲突条目（未确认的草案归作者自己）',
    );
    // 此时库里有一条别人的 proposed（kd-c4）：它绝不能出现在队列里。
    assert.ok(
      !body.items.some((e) => e.id === 'kd-c4'),
      '未确认的草案不该进审核队列',
    );
  });

  // ── 15. 裁决三分支（合成 conflicted 条目，零模型开销）──────
  //
  // 【怎么在没有模型的情况下造出 conflicted】冲突检测是模型干的，但**状态机不是**。
  //   这里直接插一条草案再用 markConflicted 标成冲突、note 里指向一个真实的
  //   已生效邻居 —— 于是裁决的三条分支都能被真实走过。
  const neighborId = listByGroup(db, groupId)[0]?.id ?? '';
  const neighborDoc = listByGroup(db, groupId)[0]?.documentId ?? null;

  function seedConflicted(id: string, content: string, groupId: string, by: string): void {
    insertEntries(db, [
      {
        id,
        kind: 'fact',
        content,
        sourceType: 'conversation',
        sourceId: null,
        sessionId: null,
        observedAt: new Date().toISOString(),
        groupId,
        createdBy: by,
      },
    ]);
    markConflicted(db, id, {
      conflict: {
        score: 0.91,
        threshold: cfg.knowledgeConflictThreshold,
        model: 'synthetic-for-test',
        neighborEntryId: neighborId,
        neighborDocumentId: neighborDoc,
        neighborExcerpt: '（合成）',
      },
    });
  }

  await check('裁决：非 conflicted 的条目 → 400（不能拿裁决接口当万能改状态）', async () => {
    const res = await runAs(asMentor, () =>
      api(`/api/v1/knowledge/${neighborId}/resolve`, json({ resolution: 'admit' })),
    );
    assert.equal(res.status, 400);
  });

  await check('裁决：member → 403', async () => {
    seedConflicted('kd-d-admit', '合成的一条冲突草案（admit）。', 'grp-unitD-0001', memberId);
    const res = await runAs(asMember, () =>
      api('/api/v1/knowledge/kd-d-admit/resolve', json({ resolution: 'admit' })),
    );
    assert.equal(res.status, 403);
    assert.equal(findEntry(db, 'kd-d-admit')?.status, 'conflicted', '越权不该改动任何东西');
  });

  await check('裁决：决议词非法 → 400', async () => {
    const res = await runAs(asMentor, () =>
      api('/api/v1/knowledge/kd-d-admit/resolve', json({ resolution: 'whatever' })),
    );
    assert.equal(res.status, 400);
  });

  await check('裁决 admit：新条 active、邻居原样不动', async () => {
    const neighborBefore = findEntry(db, neighborId);
    const res = await runAs(asMentor, () =>
      api('/api/v1/knowledge/kd-d-admit/resolve', json({ resolution: 'admit' })),
    );
    assert.equal(res.status, 200, `实际 ${res.status}`);
    const body = await bodyOf<ResolveKnowledgeResponse>(res);
    assert.equal(body.entry.status, 'active');
    assert.equal(body.supersededEntryId, null, '允许并存不该取代任何东西');
    assert.equal(body.entry.note?.resolution?.kind, 'admit');
    assert.equal(body.entry.note?.resolution?.by, mentorId, '裁决人要留痕');
    assert.deepEqual(findEntry(db, neighborId), neighborBefore, '邻居应当一个字节都没变');
  });

  await check('裁决 reject：新条落 deleted、邻居原样不动', async () => {
    seedConflicted('kd-d-reject', '合成的一条冲突草案（reject）。', 'grp-unitD-0002', memberId);
    const neighborBefore = findEntry(db, neighborId);
    const res = await runAs(asMentor, () =>
      api('/api/v1/knowledge/kd-d-reject/resolve', json({ resolution: 'reject' })),
    );
    assert.equal(res.status, 200);
    const body = await bodyOf<ResolveKnowledgeResponse>(res);
    assert.equal(body.entry.status, 'deleted');
    assert.equal(body.supersededEntryId, null);
    assert.deepEqual(findEntry(db, neighborId), neighborBefore, '邻居应当一个字节都没变');
  });

  // supersede 需要一个**内容唯一**的邻居，否则"旧内容搜不到了"验不出来 ——
  // 上面那组草案两条都含同一个标记词，撤掉一条另一条照样命中，断言会假通过。
  const oldMark = '被取代内容专用标记子丑寅';
  const newMark = '取代者内容专用标记卯辰巳';
  const supGroupId = 'grp-unitD-0003';

  await check('裁决 supersede：先造一条生效的旧知识（含唯一标记）', async () => {
    insertEntries(db, [
      {
        id: 'kd-d-old',
        kind: 'fact',
        content: `旧的那条。${oldMark}`,
        sourceType: 'conversation',
        sourceId: null,
        sessionId: null,
        observedAt: new Date().toISOString(),
        groupId: supGroupId,
        createdBy: memberId,
      },
    ]);
    const res = await runAs(asMember, () =>
      api(`/api/v1/knowledge/groups/${supGroupId}/confirm`, json({ consentConfirmed: true })),
    );
    assert.equal(res.status, 200);
    assert.equal(findEntry(db, 'kd-d-old')?.status, 'active');
    const hits = await search(oldMark);
    assert.ok(hits.hits.length >= 1, '先证明旧的确实搜得到');
  });

  await check('裁决 supersede：撤下旧文档后，旧内容真的搜不到了（本服务首次删 documents 行）', async () => {
    const old = findEntry(db, 'kd-d-old');
    const oldDoc = old?.documentId ?? '';
    assert.ok(oldDoc !== '', '旧条目应当有文档');

    // 新条：内容不同（不同标记），note.conflict 指向旧条
    insertEntries(db, [
      {
        id: 'kd-d-new',
        kind: 'fact',
        content: `新的那条。${newMark}`,
        sourceType: 'conversation',
        sourceId: null,
        sessionId: null,
        observedAt: new Date().toISOString(),
        groupId: supGroupId,
        createdBy: memberId,
      },
    ]);
    markConflicted(db, 'kd-d-new', {
      conflict: {
        score: 0.93,
        threshold: cfg.knowledgeConflictThreshold,
        model: 'synthetic-for-test',
        neighborEntryId: 'kd-d-old',
        neighborDocumentId: oldDoc,
        neighborExcerpt: '（合成）',
      },
    });

    const docsBefore = countRows(db, 'documents');
    const res = await runAs(asMentor, () =>
      api('/api/v1/knowledge/kd-d-new/resolve', json({ resolution: 'supersede' })),
    );
    assert.equal(res.status, 200, `实际 ${res.status}`);
    const body = await bodyOf<ResolveKnowledgeResponse>(res);
    assert.equal(body.entry.status, 'active', '新条应当生效');
    assert.equal(body.supersededEntryId, 'kd-d-old');

    // 旧条：superseded，且 document_id 被外键置空
    const oldAfter = findEntry(db, 'kd-d-old');
    assert.equal(oldAfter?.status, 'superseded');
    assert.equal(oldAfter?.documentId, null, 'document_id 应当被 ON DELETE SET NULL 置空');

    // documents 那一行真的没了
    assert.equal(countRows(db, 'documents'), docsBefore, '新条建一份、旧条删一份，净变化为 0');
    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM documents WHERE id = ?')
      .get(oldDoc) as unknown as { n: number };
    assert.equal(remaining.n, 0, '旧文档行应当被真的删掉');

    // ★ 这是本阶段最关键的一条断言：检索结果真的变了
    const oldHits = await search(oldMark);
    assert.equal(oldHits.hits.length, 0, '被取代的内容不该还能搜到');
    const newHits = await search(newMark);
    assert.ok(newHits.hits.length >= 1, '取代者应当搜得到');
  });

  await check('裁决 supersede：级联干净（没有指向已删文档的孤儿块）', () => {
    // 外键 CASCADE 只要有一处写错（比如某张表忘了 ON DELETE CASCADE），
    // 删 documents 就会被挡回来、或者留下悬空的块 —— 两种都会让检索出怪结果。
    const orphans = db
      .prepare(
        'SELECT COUNT(*) AS n FROM doc_chunks c LEFT JOIN documents d ON d.id = c.doc_id WHERE d.id IS NULL',
      )
      .get() as unknown as { n: number };
    assert.equal(orphans.n, 0, '不该有指向已删文档的孤儿块（外键级联应当清干净）');
  });

  await check('裁决后条目仍是终态、不可再裁决', async () => {
    const res = await runAs(asMentor, () =>
      api('/api/v1/knowledge/kd-d-old/resolve', json({ resolution: 'admit' })),
    );
    assert.equal(res.status, 400, 'superseded 是终态，不该还能被裁决');
  });

  await check('裁决：不存在的 id → 404', async () => {
    const res = await runAs(asMentor, () =>
      api('/api/v1/knowledge/no-such-entry/resolve', json({ resolution: 'admit' })),
    );
    assert.equal(res.status, 404);
  });

  // ── 16. 本轮补的四个缺口：撤回 / 重新提交 / 可见性 / 来源标记 ──
  //
  // 【为什么这一段全部零模型开销】它们验的都是**状态机与 SQL 谓词**，与向量无关。
  //   撤回要造的"共用文档"状态用 markActive 直接构造，刻意绕开冲突检测 ——
  //   否则真实向量模式下两条一字不差的内容会被判成冲突，这个状态根本造不出来。

  // 16a. 撤回一条已生效的知识
  const wMark = '撤回专用标记午未申';
  const wGroup = 'grp-withdraw-0001';
  const wId = 'kd-w-1';

  await check('撤回：先造一条生效的知识（含唯一标记）', async () => {
    insertEntries(db, [
      {
        id: wId,
        kind: 'fact',
        content: `这条会被撤回。${wMark}`,
        sourceType: 'conversation',
        sourceId: null,
        sessionId: null,
        observedAt: new Date().toISOString(),
        groupId: wGroup,
        createdBy: memberId,
      },
    ]);
    const res = await runAs(asMember, () =>
      api(`/api/v1/knowledge/groups/${wGroup}/confirm`, json({ consentConfirmed: true })),
    );
    assert.equal(res.status, 200);
    assert.equal(findEntry(db, wId)?.status, 'active');
    assert.ok(findEntry(db, wId)?.documentId !== null, '生效条目应指向一份文档');
    const hits = await search(wMark);
    assert.ok(hits.hits.length >= 1, '先证明它确实搜得到');
  });

  await check('撤回：active → withdrawn，索引真的撤下（同一词 0 命中）', async () => {
    const docsBefore = countRows(db, 'documents');
    const res = await runAs(asMember, () =>
      api(`/api/v1/knowledge/${wId}/withdraw`, json({ reason: '口径变了' })),
    );
    assert.equal(res.status, 200, `实际 ${res.status}`);
    const body = await bodyOf<WithdrawKnowledgeResponse>(res);
    assert.equal(body.entry.status, 'withdrawn');
    assert.equal(body.entry.documentId, null, 'document_id 应被 ON DELETE SET NULL 置空');
    assert.equal(body.entry.note?.withdrawn?.reason, '口径变了', '撤回原因应当留痕');
    assert.equal(body.entry.note?.withdrawn?.by, memberId, '撤回人应当留痕');
    assert.equal(body.documentRemoved, true, '没有别的引用者时应当真的删掉文档');
    assert.equal(countRows(db, 'documents'), docsBefore - 1, 'documents 应少一行');
    // ★ GC-12 的第三次复验，且这次是"内容从索引里真的拿掉"（不是"从没进去过"）
    const hits = await search(wMark);
    assert.equal(hits.hits.length, 0, '撤回后不该还能搜到');
  });

  await check('撤回：别人的（无 review）→ 404；重复撤 → 400', async () => {
    const foreign = await runAs(asOther, () =>
      api(`/api/v1/knowledge/${wId}/withdraw`, json({})),
    );
    assert.equal(foreign.status, 404, `非 owner 非 review 应当 404，实际 ${foreign.status}`);
    const again = await runAs(asMember, () => api(`/api/v1/knowledge/${wId}/withdraw`, json({})));
    assert.equal(again.status, 400, '已撤回是终态，不能再撤');
  });

  await check('撤回：proposed 的不能撤 → 400（且不改动）', async () => {
    const res = await runAs(asMember, () => api('/api/v1/knowledge/kd-c4/withdraw', json({})));
    assert.equal(res.status, 400);
    assert.equal(findEntry(db, 'kd-c4')?.status, 'proposed', '400 不该改动任何东西');
  });

  // 16b. ★ 共用文档：两条一字不差的知识共用一份文档，撤一条不能误删
  const shareMark = '共用文档专用标记酉戌亥';

  await check('★ 共用文档：还有别的生效条目指着这份文档时，撤一条不删（去掉守卫必挂）', async () => {
    // A：正常确认入库，拿到文档 Da。
    insertEntries(db, [
      {
        id: 'kd-share-a',
        kind: 'fact',
        content: shareMark,
        sourceType: 'conversation',
        sourceId: null,
        sessionId: null,
        observedAt: new Date().toISOString(),
        groupId: 'grp-share-a',
        createdBy: memberId,
      },
    ]);
    const r1 = await runAs(asMember, () =>
      api('/api/v1/knowledge/groups/grp-share-a/confirm', json({ consentConfirmed: true })),
    );
    assert.equal(r1.status, 200);
    const da = findEntry(db, 'kd-share-a')?.documentId ?? '';
    assert.ok(da !== '', 'A 应当有一份文档');

    // B：内容与 A **逐字节相同**。真实路径下它会因 content_hash 去重而落到同一份
    //   文档；这里直接 markActive 指过去，把"共用文档"这个状态确定地造出来。
    insertEntries(db, [
      {
        id: 'kd-share-b',
        kind: 'fact',
        content: shareMark,
        sourceType: 'conversation',
        sourceId: null,
        sessionId: null,
        observedAt: new Date().toISOString(),
        groupId: 'grp-share-b',
        createdBy: memberId,
      },
    ]);
    markActive(db, {
      id: 'kd-share-b',
      confirmedBy: memberId,
      confirmedAt: new Date().toISOString(),
      documentId: da,
      note: null,
    });
    assert.equal(findEntry(db, 'kd-share-b')?.documentId, da, '两条应当共用同一份文档');

    const docsBefore = countRows(db, 'documents');
    // 撤 A：B 还 active 指着 Da → 不能删。
    const resA = await runAs(asMember, () =>
      api('/api/v1/knowledge/kd-share-a/withdraw', json({})),
    );
    assert.equal(resA.status, 200);
    const bodyA = await bodyOf<WithdrawKnowledgeResponse>(resA);
    assert.equal(bodyA.documentRemoved, false, '还有别的生效条目引用它，不该删');
    assert.equal(countRows(db, 'documents'), docsBefore, 'documents 行数应当不变');
    assert.ok((await search(shareMark)).hits.length >= 1, 'B 还活着，内容仍应搜得到');

    // 再撤 B：这下没有引用者了 → 才真的删。
    const resB = await runAs(asMember, () =>
      api('/api/v1/knowledge/kd-share-b/withdraw', json({})),
    );
    assert.equal(resB.status, 200);
    const bodyB = await bodyOf<WithdrawKnowledgeResponse>(resB);
    assert.equal(bodyB.documentRemoved, true, '没有引用者了，应当真的删掉');
    assert.equal(countRows(db, 'documents'), docsBefore - 1, 'documents 应少一行');
    assert.equal((await search(shareMark)).hits.length, 0, '最后一条也撤了，内容才彻底搜不到');
  });

  // 16c. 重新提交
  await check('重新提交：驳回后的条目 → 新 id、新批次、proposed，原行一个字节没变', async () => {
    const before = findEntry(db, rejectId);
    assert.equal(before?.status, 'deleted');
    const res = await runAs(asMember, () =>
      api(`/api/v1/knowledge/${rejectId}/resubmit`, json({})),
    );
    assert.equal(res.status, 200, `实际 ${res.status}`);
    const body = await bodyOf<ResubmitKnowledgeResponse>(res);
    const neo = body.entry;
    assert.notEqual(neo.id, rejectId, '应当是一条新条目');
    assert.notEqual(neo.groupId, rejectGroupId, '应当落在新的批次里');
    assert.equal(neo.status, 'proposed');
    assert.equal(neo.content, before?.content, '正文应当与原条一致');
    assert.equal(neo.kind, before?.kind);
    assert.equal(neo.createdById, memberId);
    assert.equal(neo.note?.resubmittedFrom, rejectId, 'note 里应指向原条目');
    assert.deepEqual(findEntry(db, rejectId), before, '原行应当一个字节都没变');
  });

  await check('重新提交：撤回后的条目也能重提', async () => {
    const res = await runAs(asMember, () => api(`/api/v1/knowledge/${wId}/resubmit`, json({})));
    assert.equal(res.status, 200);
    const body = await bodyOf<ResubmitKnowledgeResponse>(res);
    assert.equal(body.entry.status, 'proposed');
    assert.equal(body.entry.note?.resubmittedFrom, wId);
    assert.equal(findEntry(db, wId)?.status, 'withdrawn', '原行仍是已撤回（留痕）');
  });

  await check('重新提交：proposed / active 不能重提 → 400；别人的 → 404', async () => {
    const prop = await runAs(asMember, () => api('/api/v1/knowledge/kd-c4/resubmit', json({})));
    assert.equal(prop.status, 400, 'proposed 不是可重提的状态');
    const act = await runAs(asMember, () =>
      api(`/api/v1/knowledge/${neighborId}/resubmit`, json({})),
    );
    assert.equal(act.status, 400, 'active 不是可重提的状态');
    const foreign = await runAs(asMember, () => api('/api/v1/knowledge/kd-c3/resubmit', json({})));
    assert.equal(foreign.status, 404, '别人的条目应当 404（不泄露存在性）');
  });

  // 16d. 可见性：proposed 只对作者本人可见
  await check('可见性：作者的 proposed 自己看得到，导师看不到草案但看得到其 active/deleted', async () => {
    const mine = await runAs(asMember, () => api('/api/v1/knowledge?status=proposed'));
    const mineBody = await bodyOf<ListKnowledgeEntriesResponse>(mine);
    assert.ok(
      mineBody.items.some((e) => e.id === 'kd-c4'),
      '作者自己应看得到自己的草案',
    );

    const mentor = await runAs(asMentor, () => api('/api/v1/knowledge'));
    const mb = await bodyOf<ListKnowledgeEntriesResponse>(mentor);
    assert.ok(
      !mb.items.some((e) => e.status === 'proposed'),
      '导师看不到任何未确认草案',
    );
    assert.ok(
      mb.items.some((e) => e.id === neighborId && e.status === 'active'),
      '导师仍看得到别人的 active 条目',
    );
    assert.ok(
      mb.items.some((e) => e.id === rejectId && e.status === 'deleted'),
      '导师仍看得到别人的 deleted（已驳回）条目',
    );
  });

  // 16e. 审核队列：只列 conflicted
  await check('审核队列：proposed 与 conflicted 并存时，只列 conflicted', async () => {
    seedConflicted('kd-q-1', '队列专用冲突草案。', 'grp-q-0001', memberId);
    const res = await runAs(asMentor, () => api('/api/v1/knowledge/review'));
    const body = await bodyOf<KnowledgeReviewQueueResponse>(res);
    assert.ok(
      body.items.some((e) => e.id === 'kd-q-1' && e.status === 'conflicted'),
      '冲突条目应当在队列里',
    );
    assert.ok(
      !body.items.some((e) => e.status === 'proposed'),
      '未确认草案不该在队列里',
    );
    assert.equal(body.threshold, cfg.knowledgeConflictThreshold, '仍要回传阈值');
  });

  // 16f. 来源标记：知识生成的文档 vs 用户上传的材料
  await check('来源标记：知识生成的文档带 knowledgeEntryId，用户上传的为 null', async () => {
    const res = await runAs(asMember, () => api('/api/v1/documents?material=knowledge'));
    const body = await bodyOf<ListDocumentsResponse>(res);
    const control = body.items.find((d) => d.title === '对照文档');
    assert.ok(control !== undefined, '对照文档应当在列表里');
    assert.equal(control.knowledgeEntryId, null, '用户自己上传的材料不该带来源标记');

    const entry = listByGroup(db, groupId)[0];
    const entryDoc = entry?.documentId ?? '';
    assert.ok(entryDoc !== '', '那组生效知识应当有一份文档');
    const derived = body.items.find((d) => d.id === entryDoc);
    assert.ok(derived !== undefined, '知识生成的文档应当在列表里');
    assert.equal(derived.knowledgeEntryId, entry?.id, '应当指向那条知识条目');
  });

  // ── 17. 可选段：模型就绪时才跑（真实 embedding）────────────
  //
  // 【为什么默认跳过】这一段要加载 BGE-M3（首次数秒）并真的算向量。默认路径
  //   应该又快又不花钱，所以由 `KNOWLEDGE_CHECK_REAL_MODEL=1` 显式打开。
  if (!REAL_MODEL) {
    console.log(
      '\n（跳过真实向量的检查段。要跑它：' +
        'KNOWLEDGE_CHECK_REAL_MODEL=1 npm run verify-knowledge -w @knowpilot/server）',
    );
  } else if (!isModelReady(cfg)) {
    console.log(
      `\n（已要求跑真实向量段，但模型未就绪：${cfg.embedModelDir} 下没有 ${cfg.embedModelId} 的权重。` +
        '先跑 npm run fetch-model -w @knowpilot/server）',
    );
  } else {
    await runRealModelSection();
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
    console.log(`\n临时数据留在 ${ROOT}（可直接删除，与真实库无关）。`);
  }

  /**
   * 真实向量段：先做阈值校准，再验一次"真冲突会挂起且不建文档"。
   *
   * 【校准为什么只打印不断言】这个阈值本来就是"没有实测过、要靠这次看分布来定"的
   *   东西。把它写成断言，等于让一个未经证实的数字替整个检查把关 ——
   *   断言通过只说明"我的猜测与我的猜测一致"。所以这里如实打印两组的分数，
   *   由人看过之后再决定要不要改 `config.ts` 里的默认值。
   */
  async function runRealModelSection(): Promise<void> {
    console.log('\n── 真实向量段（模型已就绪）──────────────────\n');

    const samePairs: [string, string][] = [
      ['本组服务器共有八张 A100 显卡，日常共享使用。', '组里的服务器一共八张 A100 显卡，大家共用。'],
      ['投稿一律走盲审模板，不要用普通模板。', '论文投稿必须使用盲审版本模板。'],
    ];
    const diffPairs: [string, string][] = [
      ['本组服务器共有八张 A100 显卡，日常共享使用。', '去年十二月那篇稿子被退回来是因为引用格式不对。'],
      ['投稿一律走盲审模板，不要用普通模板。', '数据集的分割比例目前还没定下来。'],
    ];

    const { embedTexts } = await import('../documents/embed.ts');
    // 【必须渲染成入库的形态再算】否则印出来的分布不是运行时真正比较的东西 ——
    //   线上两侧都带 `# 标题` 与 `> 来源：…` 两行，少了它们这组数字就偏乐观（偏低）。
    const rendered = [...samePairs, ...diffPairs]
      .flat()
      .map((s) => renderKnowledgeMarkdown({ kind: 'fact', content: s }));

    let vecs: Float32Array[] = [];
    try {
      vecs = await embedTexts(cfg, rendered);
    } catch (err) {
      console.log(`  模型推理失败，本段跳过：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const at = (i: number): Float32Array => vecs[i] ?? new Float32Array();

    console.log(`  当前阈值：${cfg.knowledgeConflictThreshold}`);
    console.log('  ── 应当判为「同一件事」的对 ──');
    samePairs.forEach(([a], k) => {
      const i = k * 2;
      const best = nearestActive(at(i), [
        { vec: at(i + 1), text: rendered[i + 1] ?? '', docId: `d${i + 1}`, entryId: `e${i + 1}` },
      ]);
      console.log(`    ${(best?.score ?? 0).toFixed(4)}  ${a}`);
    });
    console.log('  ── 应当判为「明显不同」的对 ──');
    diffPairs.forEach(([a], k) => {
      const i = (samePairs.length + k) * 2;
      const best = nearestActive(at(i), [
        { vec: at(i + 1), text: rendered[i + 1] ?? '', docId: `d${i + 1}`, entryId: `e${i + 1}` },
      ]);
      console.log(`    ${(best?.score ?? 0).toFixed(4)}  ${a}`);
    });
    console.log(
      '\n  （两组的分数若有重叠，说明这个阈值分不开，需要按这批数字重定；' +
        '把结果记进 docs/亮点与踩坑.md。）',
    );

    // ── 真冲突：用**完全相同**的两条正文，相似度必然为 1 ──
    //
    // 【为什么用完全相同而不是"很像"】"很像"能否越过阈值取决于那个还没定下来的
    //   数字，用它做断言会让这条检查随阈值改动而随机红绿。完全相同的两条相似度
    //   必然是 1，**只要阈值 ≤ 1 就一定挂起** —— 这条断言因此是确定的。
    await check('真冲突：与已生效知识完全相同的一条 → conflicted 且没建文档', async () => {
      const content = '真实向量段用来造冲突的一条知识正文。';
      const seedGroup = 'grp-real-0001';
      insertEntries(db, [
        {
          id: 'kd-real-seed',
          kind: 'fact',
          content,
          sourceType: 'conversation',
          sourceId: null,
          sessionId: null,
          observedAt: new Date().toISOString(),
          groupId: seedGroup,
          createdBy: memberId,
        },
      ]);
      const first = await runAs(asMember, () =>
        api(`/api/v1/knowledge/groups/${seedGroup}/confirm`, json({ consentConfirmed: true })),
      );
      assert.equal(first.status, 200);
      assert.equal(findEntry(db, 'kd-real-seed')?.status, 'active', '先得有一条生效的');

      const docsBefore = countRows(db, 'documents');
      const dupGroup = 'grp-real-0002';
      insertEntries(db, [
        {
          id: 'kd-real-dup',
          kind: 'fact',
          content,
          sourceType: 'conversation',
          sourceId: null,
          sessionId: null,
          observedAt: new Date().toISOString(),
          groupId: dupGroup,
          createdBy: memberId,
        },
      ]);
      const res = await runAs(asMember, () =>
        api(`/api/v1/knowledge/groups/${dupGroup}/confirm`, json({ consentConfirmed: true })),
      );
      assert.equal(res.status, 200);
      const body = await bodyOf<ConfirmKnowledgeGroupResponse>(res);
      assert.equal(
        body.results[0]?.outcome,
        'conflicted',
        `完全相同的内容应当被判为冲突，实际 ${JSON.stringify(body.results)}`,
      );
      const dup = findEntry(db, 'kd-real-dup');
      assert.equal(dup?.status, 'conflicted');
      assert.equal(dup?.documentId, null, '挂起的条目绝不能建文档（否则它就搜得到了）');
      // 【为什么敢断言 0.999 而不是"差不多就行"】两侧的字符串是**逐字节相同**的
      //   （候选来自 renderKnowledgeMarkdown，邻居来自切块后的块文本，二者一致 ——
      //   这一条正是靠两次减法才成立的：去掉 `# ` 前缀、去掉结尾空行）。
      //   而同一个模型对同一串的重复推理是确定的（实测余弦恰为 1.0）。
      //   所以这里卡到 0.999 是在验"那两个减法别被人改回去"，不是在跟浮点误差妥协。
      assert.ok(
        (dup?.note?.conflict?.score ?? 0) > 0.999,
        `完全相同的两条应当算出 ≈1.0，实际 ${dup?.note?.conflict?.score}`,
      );
      assert.equal(countRows(db, 'documents'), docsBefore, '挂起不该建文档');
    });
  }
}

await main();
