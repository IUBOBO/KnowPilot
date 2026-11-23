/**
 * 数据集整理的验证脚本：`npm run verify-organize -w @knowpilot/server`。
 *
 * 【这个脚本不花模型的钱】它验证的是"规则算得对不对、文件移得对不对、
 *   边界拦不拦得住"，这些全部不经过模型 —— 走 `api()` 打真实的
 *   路由栈，但只打预览/执行/历史三条，不碰生成那条。生成要花费真钱，
 *   留在 `npm run organize` 里人工跑。
 *
 * 【为什么用 api() 而不是起服务再 curl】同 upload-check.ts：
 *   要验的东西全在 Hono 路由与中间件里，app.request 走的就是同一条路，
 *   省掉"挑端口、起子进程、等它就绪、跑完杀掉"这一整套夹具 ——
 *   而那套夹具自身出错时，很难判断是接口坏了还是夹具坏了。
 *
 * 【为什么所有东西都指向临时根目录】这个脚本会**真的移动文件**。
 *   用真实配置就等于在真数据集上做实验。临时根目录可以整个删掉。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchesGlob } from '@knowpilot/shared';
import type {
  ApiErrorBody,
  CreateCodeAssetResponse,
  ListOrganizePlansResponse,
  OrganizeExecuteResponse,
  OrganizePreviewResponse,
  OrganizeRule,
  OrganizeUndoResponse,
} from '@knowpilot/shared';
import { createApp } from '../app.ts';
import { createLabModels } from '../agent/models.ts';
import type { AppConfig } from '../config.ts';
import { SESSION_COOKIE, createSession } from '../auth/session.ts';
import { insertUser } from '../auth/users.ts';
import { openDb } from '../db/index.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'knowpilot-organize-verify-'));

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

function buildConfig(): AppConfig {
  const dataRoot = join(ROOT, 'datasets');
  return {
    port: 0,
    dbPath: join(ROOT, 'knowpilot.db'),
    uploadDir: join(ROOT, 'uploads'),
    repoRoot: ROOT,
    deepseekApiKey: undefined,
    modelChat: 'deepseek-flash',
    modelReasoner: 'deepseek-v4-pro',
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
    codeRoots: [dataRoot],
    dataRoot,
    uploadMaxBytes: 1024 * 1024,
    uploadChunkSize: 1024 * 1024,
    uploadSessionTtlDays: 7,
    // 鉴权相关的 5 个字段。这些脚本自己建用户、自己发会话（见 createApp 之后那段），
    // 不需要 .env 引导管理员，所以两个 admin* 显式留空。
    knowledgeConflictThreshold: 0.82,
    patrolIntervalHours: 24,
    sessionIdleDays: 7,
    sessionMaxDays: 30,
    cookieSecure: false,
    adminUsername: undefined,
    adminPassword: undefined,
  };
}

/**
 * 会话 cookie。main 里建好账号之后填上；`withCookie` 在这里读它。
 *
 * 【为什么必须显式塞进请求头】`api()` 不过网络，浏览器那套
 * "cookie 自动回传"完全不适用 —— 不带头的话每个接口都会如实回 401。
 */
let sessionCookie = '';

/** 把会话 cookie 合进请求头。 */
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

  // ── 会话 ───────────────────────────────────────────────────
  //
  // 【为什么给脚本建用户、而不是给 createApp 加一个"关闭鉴权"的开关】
  //   那种开关一旦存在，就有可能在某个时刻被打到真实部署上 —— 一条完整的
  //   绕过路径，而且它平时不生效、出事时没人想得到。所以鉴权照开着，
  //   脚本自己走一遍真实的建号 + 发会话。
  //
  // 用 member 而不是 admin 是有意的：本脚本的数据集全部经由 HTTP 的
  // `POST /api/v1/code-assets` 登记，`created_by` 因此就是这个人 ——
  // 于是整理校验里的"归属必须是本人"这条也一并被真实走过了
  // （admin 会绕过归属判断，那样反而少验一层）。
  const verifierId = await insertUser(
    db,
    'verify-user',
    { password: 'verify-pw-123456', role: 'member', displayName: '验证账号' },
    new Date(),
  );
  {
    const { token } = createSession(db, {
      userId: verifierId,
      now: new Date(),
      idleDays: cfg.sessionIdleDays,
      maxDays: cfg.sessionMaxDays,
      ip: null,
      userAgent: null,
    });
    sessionCookie = `${SESSION_COOKIE}=${token}`;
  }

  /** 带会话 cookie 打真实路由。 */
  const api = async (path: string, init: RequestInit = {}): Promise<Response> =>
    app.request(path, withCookie(init));

  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const bodyOf = async <T>(res: Response): Promise<T> => (await res.json()) as T;

  /** 在临时数据集里造一个文件。 */
  function put(relDir: string, name: string, content = 'x'): string {
    const dir = join(cfg.dataRoot, relDir);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  }

  /** 登记一个数据集，返回它的 id。 */
  async function register(relDir: string, host?: string): Promise<string> {
    const location = join(cfg.dataRoot, relDir);
    const res = await api(
      '/api/v1/code-assets',
      json({
        name: relDir.split('/').pop(),
        location,
        ...(host !== undefined ? { host } : {}),
      }),
    );
    const body = await bodyOf<CreateCodeAssetResponse>(res);
    assert.equal(res.status, 201, `登记 ${relDir} 应当成功：${JSON.stringify(body)}`);
    return body.asset.id;
  }

  /** 数一个目录（含子目录）里的文件总数。用来断言"一个都没少"。 */
  function countFiles(dir: string): number {
    let n = 0;
    const walk = (d: string): void => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) n += 1;
      }
    };
    walk(dir);
    return n;
  }

  const previewOf = async (id: string, rules: readonly OrganizeRule[], summary = '测试计划') => {
    const res = await api(
      `/api/v1/code-assets/${id}/organize/preview`,
      json({ plan: { summary, rules } }),
    );
    // 400 时响应体是 ApiErrorBody、200 时是 OrganizePreviewResponse，
    // 用交叉类型一次覆盖两种情况，免得每个用例都要自己再读一遍响应体。
    return { res, body: await bodyOf<OrganizePreviewResponse & ApiErrorBody>(res) };
  };

  const executeOf = async (
    id: string,
    rules: readonly OrganizeRule[],
    expectedMoves: number,
    summary = '测试计划',
  ) => {
    const res = await api(
      `/api/v1/code-assets/${id}/organize/execute`,
      json({ plan: { summary, rules }, expectedMoves, confirmed: true }),
    );
    return { res, body: await bodyOf<OrganizeExecuteResponse & ApiErrorBody>(res) };
  };

  const plansOf = async (id: string) =>
    (await bodyOf<ListOrganizePlansResponse>(await api(`/api/v1/code-assets/${id}/organize-plans`)))
      .items;

  const undoOf = async (id: string, planId: string, body: unknown = { confirmed: true }) => {
    const res = await api(
      `/api/v1/code-assets/${id}/organize-plans/${planId}/undo`,
      json(body),
    );
    return { res, body: await bodyOf<OrganizeUndoResponse & ApiErrorBody>(res) };
  };

  console.log(`\n迁移已到 v${migration.toVersion}，临时根目录：${ROOT}\n`);

  // ── 1. glob 匹配器（纯函数，最该被盯住的一块）─────────────────
  console.log('glob 匹配器：');
  await check('* 不跨目录段', () => {
    assert.equal(matchesGlob('a.png', '*.png'), true);
    assert.equal(matchesGlob('x/a.png', '*.png'), false);
  });
  await check('**/*.png 也能匹配根目录下的文件（**/ 是"零段或多段"）', () => {
    assert.equal(matchesGlob('a.png', '**/*.png'), true);
    assert.equal(matchesGlob('x/a.png', '**/*.png'), true);
    assert.equal(matchesGlob('x/y/a.png', '**/*.png'), true);
  });
  await check('train/*.txt 只匹配那一层', () => {
    assert.equal(matchesGlob('train/a.txt', 'train/*.txt'), true);
    assert.equal(matchesGlob('train/sub/a.txt', 'train/*.txt'), false);
    assert.equal(matchesGlob('a.txt', 'train/*.txt'), false);
  });
  await check('? 匹配单个字符，且不吃 /', () => {
    assert.equal(matchesGlob('ab.png', 'a?.png'), true);
    assert.equal(matchesGlob('abc.png', 'a?.png'), false);
    assert.equal(matchesGlob('a/b.png', 'a?b.png'), false);
  });
  await check('正则元字符被转义（+ 当字面量）', () => {
    assert.equal(matchesGlob('a+b.png', 'a+b.png'), true);
    assert.equal(matchesGlob('aXb.png', 'a+b.png'), false);
  });
  await check('两端锚定：*.png 不匹配 a.png.bak', () => {
    assert.equal(matchesGlob('a.png.bak', '*.png'), false);
  });
  await check('光秃秃的 ** 吃掉一切（含 /）', () => {
    assert.equal(matchesGlob('a/b/c', '**'), true);
    assert.equal(matchesGlob('images/a.png', 'images/**'), true);
    assert.equal(matchesGlob('x/images/a.png', 'images/**'), false);
  });
  await check('大小写敏感', () => {
    assert.equal(matchesGlob('a.PNG', '*.png'), false);
  });

  // ── 2. 预览 ────────────────────────────────────────────────
  console.log('\n预览：');
  const dirA = 'medical/demo';
  put(dirA, 'root1.png');
  put(dirA, 'root2.png');
  put(`${dirA}/sub`, 'deep.png');
  put(`${dirA}/train`, 'a.txt');
  put(`${dirA}/train`, 'b.txt');
  put(`${dirA}/val`, 'c.txt');
  const idA = await register(dirA);

  const rulesA: OrganizeRule[] = [
    { match: '**/*.png', toDir: 'images' },
    { match: 'train/*.txt', toDir: 'labels/train' },
  ];

  await check('预览：命中数、样例、createdDirs、untouched 都对得上', async () => {
    const { res, body } = await previewOf(idA, rulesA);
    assert.equal(res.status, 200);
    const p = body.preview;
    assert.equal(p.totalMoves, 5, '3 个 png + 2 个 txt');
    assert.equal(p.rules[0]?.matched, 3);
    assert.equal(p.rules[1]?.matched, 2);
    assert.deepEqual([...p.createdDirs].sort(), ['images', 'labels/train']);
    assert.equal(p.untouched, 1, 'val/c.txt 谁也不碰');
    assert.ok(p.rules[0]?.sample.includes('root1.png'));
  });

  await check('预览：规则命中 0 条会给出警告', async () => {
    const { body } = await previewOf(idA, [{ match: '**/*.jpg', toDir: 'jpg' }]);
    assert.equal(body.preview.totalMoves, 0);
    assert.ok(body.preview.warnings.some((w) => w.includes('没有匹配到')));
  });

  await check('★ 预览：目标子树内的文件不再被规则匹配（规则不会自我循环）', async () => {
    // images/ 已经在上一轮里被建出来了吗？还没有。先执行一遍造出 images/。
    const first = await executeOf(idA, rulesA, 5);
    assert.equal(first.res.status, 200, JSON.stringify(first.body));
    // 现在 images/ 下有 3 个 png。再预览同一条规则：它们不该被再次匹配。
    const { body } = await previewOf(idA, rulesA);
    assert.equal(body.preview.rules[0]?.matched, 0, '已经在 images 里的 png 不该被再匹配');
    assert.equal(body.preview.totalMoves, 0);
  });

  // ── 3. 执行 ────────────────────────────────────────────────
  console.log('\n执行：');
  await check('★ 执行：文件真的移到位了（在磁盘上复验）', () => {
    assert.ok(existsSync(join(cfg.dataRoot, dirA, 'images/root1.png')));
    assert.ok(existsSync(join(cfg.dataRoot, dirA, 'images/root2.png')));
    assert.ok(existsSync(join(cfg.dataRoot, dirA, 'images/deep.png')));
    assert.ok(existsSync(join(cfg.dataRoot, dirA, 'labels/train/a.txt')));
    assert.ok(existsSync(join(cfg.dataRoot, dirA, 'labels/train/b.txt')));
    assert.ok(existsSync(join(cfg.dataRoot, dirA, 'val/c.txt')), '没被规则覆盖的文件必须原地不动');
    assert.equal(existsSync(join(cfg.dataRoot, dirA, 'root1.png')), false, '原位置不该还留着');
  });

  await check('★ 执行：文件总数一个不少（全程只增不删）', () => {
    // 6 个原始文件 → 移完之后仍然 6 个。少一个就说明有东西被覆盖或删掉了。
    assert.equal(countFiles(join(cfg.dataRoot, dirA)), 6);
  });

  await check('执行：计划行与动作行的数量与磁盘一致，状态是 executed', async () => {
    const res = await api(`/api/v1/code-assets/${idA}/organize-plans`);
    const { items } = await bodyOf<ListOrganizePlansResponse>(res);
    const latest = items[0];
    assert.ok(latest);
    assert.equal(latest.status, 'executed');
    assert.equal(latest.plannedMoves, 5);
    assert.equal(latest.moved, 5);
    assert.equal(latest.failedCount, 0);
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM organize_actions WHERE plan_id = ?')
      .get(latest.id) as unknown as { n: number };
    assert.equal(Number(n.n), 2 + 5, '2 条 mkdir + 5 条 move');
  });

  await check('重名不覆盖：后来的改成 "名字 (1).ext"', async () => {
    const dirB = 'medical/dup';
    put(`${dirB}/a`, 'dup.png', 'first');
    put(`${dirB}/b`, 'dup.png', 'second');
    const idB = await register(dirB);
    const { body: pv } = await previewOf(idB, [{ match: '**/dup.png', toDir: 'images' }]);
    assert.equal(pv.preview.totalMoves, 2);
    assert.ok(pv.preview.warnings.some((w) => w.includes('同名')), '应当提示会撞名');

    const { res } = await executeOf(idB, [{ match: '**/dup.png', toDir: 'images' }], 2);
    assert.equal(res.status, 200);
    assert.ok(existsSync(join(cfg.dataRoot, dirB, 'images/dup.png')));
    assert.ok(existsSync(join(cfg.dataRoot, dirB, 'images/dup (1).png')));
    assert.equal(countFiles(join(cfg.dataRoot, dirB)), 2, '两个文件都还在，一个没被覆盖');
  });

  await check('★ 越界规则（../）被拒，且一条文件都没动', async () => {
    const dirC = 'medical/escape';
    put(dirC, 'x.png');
    const idC = await register(dirC);
    const before = countFiles(join(cfg.dataRoot, dirC));

    const bad = [{ match: '**/*.png', toDir: '../evil' }];
    const { body: pv } = await previewOf(idC, bad);
    assert.ok(pv.preview.rules[0]?.problem, '越界目标应当在预览里被标为有问题');
    assert.equal(pv.preview.totalMoves, 0);

    const { res, body } = await executeOf(idC, bad, 0);
    assert.equal(res.status, 400);
    assert.match(body.error.message, /不合法|越出/u);
    assert.equal(countFiles(join(cfg.dataRoot, dirC)), before, '被拒的计划不该动任何文件');
    assert.equal(existsSync(join(cfg.dataRoot, 'medical/evil')), false);

    // 被拒的计划要留下痕迹（"谁试过做什么"本身就是要留痕的事）。
    const res2 = await api(`/api/v1/code-assets/${idC}/organize-plans`);
    const { items } = await bodyOf<ListOrganizePlansResponse>(res2);
    assert.equal(items[0]?.status, 'failed');
    assert.ok((items[0]?.note ?? '').length > 0);
  });

  await check('绝对路径规则也被拒', async () => {
    const { body } = await previewOf(idA, [{ match: '**/*.png', toDir: '/tmp/x' }]);
    assert.ok(body.preview.rules[0]?.problem);
  });

  await check('★ 预览与执行对不上（文件变过）→ 400，不动文件', async () => {
    const dirD = 'medical/moving';
    put(dirD, 'one.png');
    put(dirD, 'two.png');
    const idD = await register(dirD);
    const rule = [{ match: '**/*.png', toDir: 'images' }];

    const { body: pv } = await previewOf(idD, rule);
    assert.equal(pv.preview.totalMoves, 2);

    // 预览之后又来了一个文件 —— 用户确认的是"2 个"，现在能匹配到 3 个。
    put(dirD, 'three.png');
    const { res, body } = await executeOf(idD, rule, 2);
    assert.equal(res.status, 400);
    assert.match(body.error.message, /变过了|重新预览/u);
    assert.equal(existsSync(join(cfg.dataRoot, dirD, 'images')), false, '对不上时一条都不该动');

    // 用对的条数再来一次，就成功了。
    const ok = await executeOf(idD, rule, 3);
    assert.equal(ok.res.status, 200);
    assert.equal(ok.body.moved, 3);
  });

  await check('空计划 → 400', async () => {
    const { res } = await executeOf(idA, [], 0);
    assert.equal(res.status, 400);
  });

  // ── 4. 撤销（O6）─────────────────────────────────────────────
  console.log('\n撤销：');
  const dirU = 'medical/undo';
  put(dirU, 'one.png', 'alpha');
  put(dirU, 'two.png', 'beta');
  put(`${dirU}/keep`, 'three.png', 'gamma');
  const idU = await register(dirU);
  const rulesU: OrganizeRule[] = [{ match: '**/*.png', toDir: 'images' }];

  await check('★ 撤销：文件全部移回原位、数量一个不少，新建的目录不删', async () => {
    const exec = await executeOf(idU, rulesU, 3);
    assert.equal(exec.res.status, 200, JSON.stringify(exec.body));
    assert.equal(exec.body.moved, 3);

    const before = (await plansOf(idU))[0];
    assert.ok(before);
    assert.equal(before.status, 'executed');
    assert.equal(before.undoable, true, '刚执行完、有指纹，应当可撤销');
    assert.equal(before.undoBlockedReason, null);

    const { res, body } = await undoOf(idU, before.id);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.restored, 3);
    assert.equal(body.skipped, 0);
    assert.equal(body.failedCount, 0);

    assert.ok(existsSync(join(cfg.dataRoot, dirU, 'one.png')));
    assert.ok(existsSync(join(cfg.dataRoot, dirU, 'two.png')));
    assert.ok(existsSync(join(cfg.dataRoot, dirU, 'keep/three.png')));
    assert.equal(existsSync(join(cfg.dataRoot, dirU, 'images/one.png')), false);
    assert.equal(countFiles(join(cfg.dataRoot, dirU)), 3, '只移回，不删除');
    assert.ok(existsSync(join(cfg.dataRoot, dirU, 'images')), '整理时新建的目录保留，不删目录');
  });

  await check('撤销后：历史显示 undone 与撤销计数，且不能重复撤销', async () => {
    const p = (await plansOf(idU))[0];
    assert.ok(p);
    assert.equal(p.status, 'undone');
    assert.equal(p.undoMoved, 3);
    assert.equal(p.undoSkipped, 0);
    assert.equal(p.undoFailed, 0);
    assert.ok(p.undoneAt !== null);
    assert.equal(p.undoable, false);

    const again = await undoOf(idU, p.id);
    assert.equal(again.res.status, 400);
    assert.match(again.body.error.message, /已经撤销/u);
  });

  await check('★ 撤销：整理后被改动过的文件跳过，其余照常移回', async () => {
    const dirV = 'medical/undo-changed';
    put(dirV, 'one.png', 'original');
    put(dirV, 'two.png', 'second');
    const idV = await register(dirV);
    const rules: OrganizeRule[] = [{ match: '**/*.png', toDir: 'images' }];
    const exec = await executeOf(idV, rules, 2);
    assert.equal(exec.res.status, 200, JSON.stringify(exec.body));

    // 用户在整理之后改了其中一个文件 —— 它已经不是当初被移动的那个了。
    writeFileSync(join(cfg.dataRoot, dirV, 'images/one.png'), 'changed-content-longer');

    const p = (await plansOf(idV))[0];
    assert.ok(p);
    assert.equal(p.undoable, true, '整份计划可撤；单个文件被改是撤销时逐条判的');

    const { res, body } = await undoOf(idV, p.id);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.restored, 1);
    assert.equal(body.skipped, 1);
    assert.ok(
      body.actions.some((a) => a.status === 'skipped' && /改动/u.test(a.reason ?? '')),
      '跳过的原因必须说清是被改动过',
    );
    assert.ok(existsSync(join(cfg.dataRoot, dirV, 'images/one.png')), '被改动的文件留在原地');
    assert.ok(existsSync(join(cfg.dataRoot, dirV, 'two.png')), '没被改动的那个移回去了');
    assert.equal(countFiles(join(cfg.dataRoot, dirV)), 2);

    const after = (await plansOf(idV))[0];
    assert.ok(after);
    assert.equal(after.status, 'undone');
    assert.equal(after.undoSkipped, 1);
  });

  await check('撤销：原位置已有同名文件 → 跳过，绝不覆盖', async () => {
    const dirW = 'medical/undo-taken';
    put(dirW, 'a.png', 'moved-version');
    const idW = await register(dirW);
    const rules: OrganizeRule[] = [{ match: '*.png', toDir: 'images' }];
    const exec = await executeOf(idW, rules, 1);
    assert.equal(exec.res.status, 200, JSON.stringify(exec.body));

    // 整理之后，用户又在原位置放了一个同名文件。
    put(dirW, 'a.png', 'new-version');

    const p = (await plansOf(idW))[0];
    assert.ok(p);
    const { res, body } = await undoOf(idW, p.id);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.restored, 0);
    assert.equal(body.skipped, 1);
    assert.match(body.actions[0]?.reason ?? '', /同名/u);

    assert.equal(
      readFileSync(join(cfg.dataRoot, dirW, 'a.png'), 'utf8'),
      'new-version',
      '原位置的新文件没被覆盖',
    );
    assert.equal(
      readFileSync(join(cfg.dataRoot, dirW, 'images/a.png'), 'utf8'),
      'moved-version',
      '整理出来的文件也没被误移',
    );

    // 一条都没移回 → 磁盘上什么都没变，计划必须仍是 executed（可以处理后重试）。
    const after = (await plansOf(idW))[0];
    assert.ok(after);
    assert.equal(after.status, 'executed');
    assert.equal(after.undoable, true);
  });

  await check('★ 撤销：老计划没有文件指纹 → 400 拒绝（不盲移）', async () => {
    const dirX = 'medical/undo-legacy';
    put(dirX, 'x.png');
    const idX = await register(dirX);
    const exec = await executeOf(idX, [{ match: '*.png', toDir: 'images' }], 1);
    assert.equal(exec.res.status, 200, JSON.stringify(exec.body));

    // 模拟 v21 之前执行的老行：没有 size / mtime_ms。
    const p = (await plansOf(idX))[0];
    assert.ok(p);
    db.prepare('UPDATE organize_actions SET size = NULL, mtime_ms = NULL WHERE plan_id = ?').run(p.id);

    const listed = (await plansOf(idX))[0];
    assert.ok(listed);
    assert.equal(listed.undoable, false);
    assert.match(listed.undoBlockedReason ?? '', /指纹/u);

    const { res, body } = await undoOf(idX, p.id);
    assert.equal(res.status, 400);
    assert.match(body.error.message, /指纹|撤销功能上线前/u);
    assert.ok(existsSync(join(cfg.dataRoot, dirX, 'images/x.png')), '被拒的撤销一个文件都不动');
  });

  await check('撤销：未确认 → 400', async () => {
    const p = (await plansOf(idU))[0];
    assert.ok(p);
    const { res, body } = await undoOf(idU, p.id, {});
    assert.equal(res.status, 400);
    assert.match(body.error.message, /确认/u);
  });

  await check('★ 代码检查：执行与撤销的代码里没有任何删除调用', () => {
    // 【为什么要检查源码】"只增不删"是这一模块的铁律，靠人每次 review 记住不可靠。
    //   这里只看真正的调用形状（带括号），注释里提到 rm/unlink 不算。
    const deletionCall = /\b(?:rmSync|unlinkSync|rmdirSync|unlink|rmdir|rm)\s*\(/u;
    for (const file of ['execute.ts', 'undo.ts', 'preview.ts', 'repo.ts']) {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      assert.equal(deletionCall.test(src), false, `${file} 里出现了删除调用`);
    }
  });

  // ── 5. 前置校验 ────────────────────────────────────────────
  console.log('\n前置校验：');
  await check('未登记的 asset → 404', async () => {
    const { res } = await previewOf('nope', [{ match: '*', toDir: 'x' }]);
    assert.equal(res.status, 404);
  });

  await check('声明在别的机器上（host 非空）→ 400，本机不碰', async () => {
    const dirE = 'medical/remote';
    mkdirSync(join(cfg.dataRoot, dirE), { recursive: true });
    const idE = await register(dirE, 'lab-server');
    const { res, body } = await previewOf(idE, [{ match: '*', toDir: 'x' }]);
    assert.equal(res.status, 400);
    assert.match(body.error.message, /lab-server/u);
  });

  await check('目录此刻不存在 → 400', async () => {
    const dirF = 'medical/gone';
    mkdirSync(join(cfg.dataRoot, dirF), { recursive: true });
    const idF = await register(dirF);
    rmSync(join(cfg.dataRoot, dirF), { recursive: true, force: true });
    const { res } = await previewOf(idF, [{ match: '*', toDir: 'x' }]);
    assert.equal(res.status, 400);
  });

  await check('未确认（confirmed 不为 true）→ 400', async () => {
    const res = await api(
      `/api/v1/code-assets/${idA}/organize/execute`,
      json({ plan: { summary: 's', rules: [] }, expectedMoves: 0 }),
    );
    assert.equal(res.status, 400);
    const body = await bodyOf<ApiErrorBody>(res);
    assert.match(body.error.message, /确认/u);
  });

  await check('历史接口：未登记的 asset → 404', async () => {
    const res = await api('/api/v1/code-assets/nope/organize-plans');
    assert.equal(res.status, 404);
  });

  // ── 结果 ───────────────────────────────────────────────────
  db.close();
  const total = passed + failures.length;
  console.log(`\n${passed}/${total} 通过`);
  if (failures.length > 0) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`\n临时数据留在 ${ROOT}（可直接删除，与真实数据集无关）。`);
  }
}

await main();
