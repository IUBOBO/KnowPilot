/**
 * 数据集上传的验证脚本：`npm run verify-upload -w @knowpilot/server`。
 *
 * 【为什么不真正起一个服务、用 curl 打】
 *   这一整套要验证的东西（建会话、续传、拼装、幂等、路径穿越）全部走的是
 *   Hono 的路由与中间件，`api()` 走的就是同一条路 —— 只是不经过
 *   TCP。省掉的是"挑一个端口、起一个子进程、等它起来、跑完再杀掉"这一整套
 *   夹具，而那套夹具本身从来没被验证过，出错时很难判断是接口坏了还是夹具坏了。
 *
 * 【为什么要自己拼一份配置，而不是 loadConfig()】
 *   这个脚本会往库里写记录、往磁盘上放文件。用真实配置就等于污染开发库，
 *   还会因为 DATA_ROOT 指向真实数据集目录而把测试文件混进真数据里。
 *   所以配置全部指向一个临时根目录，跑完可以整个删掉，与真实数据无关。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { createLabModels } from '../agent/models.ts';
import type { AppConfig } from '../config.ts';
import { SESSION_COOKIE, createSession } from '../auth/session.ts';
import { insertUser } from '../auth/users.ts';
import { openDb } from '../db/index.ts';
import { insertSession } from './repo.ts';
import type {
  AbortUploadResponse,
  ApiErrorBody,
  CompleteUploadResponse,
  CreateUploadResponse,
  GetUploadResponse,
  ListCodeAssetsResponse,
  ListUploadsResponse,
  PutChunkResponse,
} from '@knowpilot/shared';

const ROOT = mkdtempSync(join(tmpdir(), 'knowpilot-upload-verify-'));
const CHUNK = 1024 * 1024; // 1 MB：故意小，几 MB 的测试文件就能切出好几片

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

/** 可复现的伪随机字节，避免每次跑验证都依赖 Math.random。 */
function makeBytes(n: number): Buffer {
  const buf = Buffer.allocUnsafe(n);
  let x = 20261007;
  for (let i = 0; i < n; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = x & 0xff;
  }
  return buf;
}

function buildConfig(overrides: Partial<AppConfig> = {}): AppConfig {
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
    // 让"核对"能真的探到东西：允许根目录就是数据集根目录本身。
    codeRoots: [dataRoot],
    dataRoot,
    uploadMaxBytes: 64 * 1024 * 1024,
    uploadChunkSize: CHUNK,
    uploadSessionTtlDays: 7,
    knowledgeConflictThreshold: 0.82,
    patrolIntervalHours: 24,
    // 鉴权相关的 5 个字段。这些脚本自己建用户、自己发会话（见 createApp 之后那段），
    // 不需要 .env 引导管理员，所以两个 admin* 显式留空。
    sessionIdleDays: 7,
    sessionMaxDays: 30,
    cookieSecure: false,
    adminUsername: undefined,
    adminPassword: undefined,
    ...overrides,
  };
}

/**
 * 会话 cookie。main 里建好账号之后填上；`withCookie` 在这里读它。
 *
 * 【为什么必须显式塞进请求头】`api()` 不过网络，浏览器那套
 * "cookie 自动回传"完全不适用 —— 不带头的话每个接口都会如实回 401。
 */
let sessionCookie = '';

/**
 * 把会话 cookie 合进请求头。
 *
 * cookie 可以换：归属那一组要拿**另一个人**的身份打同一个接口，
 * 而那正是这些断言的意义所在 —— 用同一个 cookie 只能验证"接口通不通"，
 * 验证不了"换个身份是否被挡住"。
 */
function withCookie(init: RequestInit, cookie: string = sessionCookie): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), cookie },
  };
}

async function main(): Promise<void> {

  const cfg = buildConfig();
  const { db, migration } = openDb(cfg.dbPath);
  const models = createLabModels();
  const app = createApp({
    db,
    config: cfg,
    schemaVersion: migration.toVersion,
    startedAt: Date.now(),
    models,
  });
  // 第二个实例：只把单文件上限调到"实际上没有上限"，用来验证磁盘空间那道闸。
  // 需要单独一个实例，是因为正常那套里有"超过 64 MB 直接拒"的前置检查，
  // 而我们要测的恰好是它后面那一步（507 而不是 400）。
  const appNoCap = createApp({
    db,
    config: buildConfig({ uploadMaxBytes: Number.MAX_SAFE_INTEGER }),
    schemaVersion: migration.toVersion,
    startedAt: Date.now(),
    models,
  });

  // ── 会话 ───────────────────────────────────────────────────
  //
  // 【为什么给脚本建用户、而不是给 createApp 加一个"关闭鉴权"的开关】
  //   那种开关一旦存在，就有可能在某个时刻被打到真实部署上 —— 一条完整的
  //   绕过路径，而且它平时不生效、出事时没人想得到。所以鉴权照开着，
  //   脚本自己走一遍真实的建号 + 发会话。顺带把登录链路的两端也验了一遍。
  //
  // 用的是 member：它正是这些接口的真实使用者角色（上传数据集与登记数据集
  // 都落在 code.register 上）。
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
  const apiNoCap = async (path: string, init: RequestInit = {}): Promise<Response> =>
    appNoCap.request(path, withCookie(init));

  /** 换一个人打同一套接口（归属那一组用）。 */
  const apiAs = async (cookie: string, path: string, init: RequestInit = {}): Promise<Response> =>
    app.request(path, withCookie(init, cookie));

  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  async function bodyOf<T>(res: Response): Promise<T> {
    return (await res.json()) as T;
  }

  console.log(`\n迁移已到 v${migration.toVersion}，临时根目录：${ROOT}\n`);

  // ── 正常路径：分片、续传、拼装 ──────────────────────────────
  const payload = makeBytes(3 * CHUNK + 4242); // 4 片，最后一片不满
  const expectSha = createHash('sha256').update(payload).digest('hex');
  const targetDir = 'medical/amos22';
  const createReq = {
    targetDir,
    fileName: 'amos22.tar.gz',
    totalBytes: payload.length,
    lastModifiedMs: 1759800000000,
  };

  let sessionId = '';

  await check('建会话 → 201、分片数按 chunkSize 算对', async () => {
    const res = await api('/api/v1/uploads', json(createReq));
    assert.equal(res.status, 201);
    const body = await bodyOf<CreateUploadResponse>(res);
    assert.equal(body.resumed, false);
    assert.equal(body.session.chunkSize, CHUNK);
    assert.equal(body.session.chunkCount, 4);
    assert.deepEqual(body.session.received, []);
    assert.equal(body.session.status, 'pending');
    sessionId = body.session.id;
    assert.match(sessionId, /^[0-9a-f]{64}$/u, 'id 应当是派生的 sha256');
  });

  await check('GET 会话 → 空进度', async () => {
    const res = await api(`/api/v1/uploads/${sessionId}`);
    assert.equal(res.status, 200);
    const body = await bodyOf<GetUploadResponse>(res);
    assert.deepEqual(body.session.received, []);
    assert.equal(body.session.receivedBytes, 0);
  });

  await check('传 2 片 → received 升序、字节数正确', async () => {
    for (const i of [0, 1]) {
      const res = await api(`/api/v1/uploads/${sessionId}/chunks/${i}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: payload.subarray(i * CHUNK, (i + 1) * CHUNK),
      });
      assert.equal(res.status, 200);
    }
    const res = await api(`/api/v1/uploads/${sessionId}`);
    const body = await bodyOf<GetUploadResponse>(res);
    assert.deepEqual(body.session.received, [0, 1]);
    assert.equal(body.session.receivedBytes, 2 * CHUNK);
  });

  await check('乱序传第 3 片 → received 仍然是升序', async () => {
    const res = await api(`/api/v1/uploads/${sessionId}/chunks/2`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload.subarray(2 * CHUNK, 3 * CHUNK),
    });
    assert.equal(res.status, 200);
    const body = await bodyOf<PutChunkResponse>(res);
    assert.deepEqual(body.received, [0, 1, 2]);
  });

  await check('★ 模拟中断后重进：只有 3/4 片，还差第 3 片', async () => {
    // 这里就是"刷新页面、重新拖进同一个文件"之后发生的事：客户端只有文件本身，
    // 它算出同一个 id，问到这里已经收到了哪些片，于是只补缺口。
    const res = await api('/api/v1/uploads', json(createReq));
    assert.equal(res.status, 200, '已存在的会话应当返回 200（续传）而不是 201');
    const body = await bodyOf<CreateUploadResponse>(res);
    assert.equal(body.resumed, true);
    assert.deepEqual(body.session.received, [0, 1, 2]);
    const missing = [0, 1, 2, 3].filter((i) => !body.session.received.includes(i));
    assert.deepEqual(missing, [3]);
    // 续传只要补 1 片，而不是 4 片 —— 这是"断点续传真的省了钱"的硬指标。
    assert.ok(body.session.receivedBytes / body.session.totalBytes > 0.6);
  });

  await check('补最后一片 → 拼装落位，sha256 与源文件逐字节一致', async () => {
    const res = await api(`/api/v1/uploads/${sessionId}/chunks/3`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload.subarray(3 * CHUNK),
    });
    assert.equal(res.status, 200);

    const done = await api(`/api/v1/uploads/${sessionId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(done.status, 200);
    const body = await bodyOf<CompleteUploadResponse>(done);
    assert.equal(body.sha256, expectSha);
    assert.equal(body.byteSize, payload.length);
    assert.equal(body.storedPath, join(cfg.dataRoot, targetDir, 'amos22.tar.gz'));
    assert.equal(body.session.status, 'completed');
  });

  await check('落位的文件内容与源文件一致；.incoming 已清空', async () => {
    const bytes = readFileSync(join(cfg.dataRoot, targetDir, 'amos22.tar.gz'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectSha);
    const incoming = readdirSyncSafe(join(cfg.dataRoot, '.incoming'));
    assert.deepEqual(incoming, [], '落位之后暂存目录不该还留着东西');
  });

  await check('★ 自动登记：新建一条，location 是目标目录的绝对路径', async () => {
    const res = await api('/api/v1/code-assets');
    const body = await bodyOf<ListCodeAssetsResponse>(res);
    const mine = body.items.filter((a) => a.location === join(cfg.dataRoot, targetDir));
    assert.equal(mine.length, 1, '同一个目录不该登记出两条');
    assert.equal(mine[0]?.name, 'amos22');
    assert.equal(mine[0]?.lastCheckResult, 'exists', 'codeRoots 覆盖了它，应当探得到');
  });

  await check('★ complete 幂等：重试不重新拼、sha 不变', async () => {
    const res = await api(`/api/v1/uploads/${sessionId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 200);
    const body = await bodyOf<CompleteUploadResponse>(res);
    assert.equal(body.sha256, expectSha);
    assert.equal(body.assetCreated, false, '重试不该再登记一条');
    const list = await api('/api/v1/code-assets');
    const { items } = await bodyOf<ListCodeAssetsResponse>(list);
    assert.equal(items.filter((a) => a.location === join(cfg.dataRoot, targetDir)).length, 1);
  });

  await check('★ 同一个文件再传一次：认出已完成，不再收分片', async () => {
    const res = await api('/api/v1/uploads', json(createReq));
    const body = await bodyOf<CreateUploadResponse>(res);
    assert.equal(body.session.status, 'completed');
    assert.equal(body.session.storedPath, `${targetDir}/amos22.tar.gz`);
    const put = await api(`/api/v1/uploads/${sessionId}/chunks/0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload.subarray(0, CHUNK),
    });
    assert.equal(put.status, 400, '已完成的会话不该再收分片');
  });

  await check('已完成的上传：DELETE 被拒（不会删掉已落位的数据）', async () => {
    const res = await api(`/api/v1/uploads/${sessionId}`, { method: 'DELETE' });
    assert.equal(res.status, 400);
    const body = await bodyOf<ApiErrorBody>(res);
    assert.equal(body.error.code, 'invalid_argument');
    assert.match(body.error.message, /不会删除/u);
  });

  // ── 第二个文件进同一个目录：不重复登记 ──────────────────────
  await check('第二个文件进同一目录 → assetCreated=false，仍只有一条登记', async () => {
    const small = makeBytes(CHUNK + 7);
    const req = {
      targetDir,
      fileName: 'readme.txt',
      totalBytes: small.length,
      lastModifiedMs: 1759800001000,
    };
    const c = await api('/api/v1/uploads', json(req));
    const { session } = await bodyOf<CreateUploadResponse>(c);
    for (let i = 0; i < session.chunkCount; i += 1) {
      await api(`/api/v1/uploads/${session.id}/chunks/${i}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: small.subarray(i * CHUNK, (i + 1) * CHUNK),
      });
    }
    const done = await api(`/api/v1/uploads/${session.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = await bodyOf<CompleteUploadResponse>(done);
    assert.equal(body.assetCreated, false);
    assert.equal(body.asset?.name, 'amos22', '应当返回原来那一条');
    const list = await api('/api/v1/code-assets');
    const { items } = await bodyOf<ListCodeAssetsResponse>(list);
    assert.equal(items.filter((a) => a.location === join(cfg.dataRoot, targetDir)).length, 1);
  });

  // ── 中文名 ───────────────────────────────────────────────────
  await check('中文领域名 + 中文文件名 → 正常落位', async () => {
    const small = makeBytes(1000);
    const req = {
      targetDir: '医学影像/肺结节',
      fileName: '标注数据 v2.zip',
      totalBytes: small.length,
      lastModifiedMs: 1759800002000,
    };
    const c = await api('/api/v1/uploads', json(req));
    assert.equal(c.status, 201);
    const { session } = await bodyOf<CreateUploadResponse>(c);
    await api(`/api/v1/uploads/${session.id}/chunks/0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: small,
    });
    const done = await api(`/api/v1/uploads/${session.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = await bodyOf<CompleteUploadResponse>(done);
    assert.equal(body.session.fileName, '标注数据 v2.zip');
    assert.ok(existsSync(body.storedPath), `落位的文件应当存在：${body.storedPath}`);
  });

  // ── 路径与参数校验 ──────────────────────────────────────────
  await check('★ 路径穿越 ../../etc → 400', async () => {
    const res = await api(
      '/api/v1/uploads',
      json({ ...createReq, targetDir: '../../etc' }),
    );
    assert.equal(res.status, 400);
    const body = await bodyOf<ApiErrorBody>(res);
    assert.equal(body.error.code, 'invalid_argument');
  });

  await check('绝对路径 targetDir → 400', async () => {
    const res = await api(
      '/api/v1/uploads',
      json({ ...createReq, targetDir: '/hdd1/datasets/x' }),
    );
    assert.equal(res.status, 400);
  });

  await check('Windows 驱动器路径 → 400', async () => {
    const res = await api(
      '/api/v1/uploads',
      json({ ...createReq, targetDir: 'E:\\data' }),
    );
    assert.equal(res.status, 400);
  });

  await check('文件名里带路径 → 400', async () => {
    const res = await api(
      '/api/v1/uploads',
      json({ ...createReq, fileName: '../evil.tar' }),
    );
    assert.equal(res.status, 400);
  });

  await check('保留设备名 con → 400', async () => {
    const res = await api('/api/v1/uploads', json({ ...createReq, fileName: 'con.txt' }));
    assert.equal(res.status, 400);
  });

  await check('结尾是点的名字 → 400（Windows 会静默吃掉那个点）', async () => {
    const res = await api('/api/v1/uploads', json({ ...createReq, fileName: 'a.' }));
    assert.equal(res.status, 400);
  });

  await check('反斜杠写的 targetDir 归一后正常通过', async () => {
    const res = await api(
      '/api/v1/uploads',
      json({ ...createReq, targetDir: 'medical\\retina', fileName: 'x.bin' }),
    );
    assert.equal(res.status, 201);
    const body = await bodyOf<CreateUploadResponse>(res);
    assert.equal(body.session.targetDir, 'medical/retina');
  });

  await check('totalBytes 是字符串 → 400（不猜数字）', async () => {
    const res = await api('/api/v1/uploads', json({ ...createReq, totalBytes: '123' }));
    assert.equal(res.status, 400);
  });

  await check('超过单文件上限 → 400，且在建会话时就拒', async () => {
    const res = await api(
      '/api/v1/uploads',
      json({ ...createReq, totalBytes: 128 * 1024 * 1024 }),
    );
    assert.equal(res.status, 400);
    const body = await bodyOf<ApiErrorBody>(res);
    assert.match(body.error.message, /超过单次上传上限/u);
  });

  await check('★ 磁盘放不下 → 507 而不是 400', async () => {
    // 用 appNoCap：正常那个实例会先被"超过 64 MB 上限"拦成 400，
    // 而这里要验的恰恰是它后面那一步 —— 上限放行之后，磁盘那道闸给的是 507。
    const res = await apiNoCap(
      '/api/v1/uploads',
      json({ ...createReq, totalBytes: 900_000_000_000_000, lastModifiedMs: 1 }),
    );
    assert.equal(res.status, 507);
    const body = await bodyOf<ApiErrorBody>(res);
    assert.equal(body.error.code, 'insufficient_storage');
    assert.equal(body.error.title, '磁盘空间不足');
  });

  await check('分片大小不对 → 400，且提示整片重传', async () => {
    const c = await api(
      '/api/v1/uploads',
      json({ ...createReq, fileName: 'size-test.bin', lastModifiedMs: 2 }),
    );
    const { session } = await bodyOf<CreateUploadResponse>(c);
    const res = await api(`/api/v1/uploads/${session.id}/chunks/0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: makeBytes(CHUNK - 1),
    });
    assert.equal(res.status, 400);
    const body = await bodyOf<ApiErrorBody>(res);
    assert.match(body.error.message, /整片重传/u);
  });

  await check('分片序号越界 → 400', async () => {
    const res = await api(`/api/v1/uploads/${sessionId}/chunks/99`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: makeBytes(CHUNK),
    });
    assert.equal(res.status, 400);
  });

  await check('分片序号不是数字 → 400', async () => {
    const res = await api(`/api/v1/uploads/${sessionId}/chunks/abc`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: makeBytes(CHUNK),
    });
    assert.equal(res.status, 400);
  });

  // ── 磁盘是唯一事实来源 ──────────────────────────────────────
  await check('★ 手工删掉一片 → 进度如实少一片（库里没有"已收到"这一列可骗）', async () => {
    const c = await api(
      '/api/v1/uploads',
      json({ ...createReq, fileName: 'truth.bin', lastModifiedMs: 3 }),
    );
    const { session } = await bodyOf<CreateUploadResponse>(c);
    for (let i = 0; i < session.chunkCount; i += 1) {
      await api(`/api/v1/uploads/${session.id}/chunks/${i}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: payload.subarray(i * CHUNK, (i + 1) * CHUNK),
      });
    }
    rmSync(join(cfg.dataRoot, '.incoming', session.id, '000001.part'));
    const res = await api(`/api/v1/uploads/${session.id}`);
    const body = await bodyOf<GetUploadResponse>(res);
    assert.deepEqual(body.session.received, [0, 2, 3]);
  });

  await check('★ 半片不算"已收到"（被截断的分片会被忽略）', async () => {
    const c = await api(
      '/api/v1/uploads',
      json({ ...createReq, fileName: 'half.bin', lastModifiedMs: 4 }),
    );
    const { session } = await bodyOf<CreateUploadResponse>(c);
    const dir = join(cfg.dataRoot, '.incoming', session.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '000000.part'), payload.subarray(0, 1000)); // 只写了 1000 字节
    writeFileSync(join(dir, '000001.part'), payload.subarray(CHUNK, 2 * CHUNK));
    const res = await api(`/api/v1/uploads/${session.id}`);
    const body = await bodyOf<GetUploadResponse>(res);
    assert.deepEqual(body.session.received, [1], '那个半片应当被当成没收到');
  });

  await check('分片没收齐就 complete → 400，并列出还差哪几片', async () => {
    const c = await api(
      '/api/v1/uploads',
      json({ ...createReq, fileName: 'notyet.bin', lastModifiedMs: 5 }),
    );
    const { session } = await bodyOf<CreateUploadResponse>(c);
    await api(`/api/v1/uploads/${session.id}/chunks/0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload.subarray(0, CHUNK),
    });
    const res = await api(`/api/v1/uploads/${session.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 400);
    const body = await bodyOf<ApiErrorBody>(res);
    assert.match(body.error.message, /还差 3 片/u);
  });

  // ── 放弃与恢复 ──────────────────────────────────────────────
  await check('★ 放弃上传 → 分片被删；同一个文件再建会话会恢复成 pending', async () => {
    const req = { ...createReq, fileName: 'abandon.bin', lastModifiedMs: 6 };
    const c = await api('/api/v1/uploads', json(req));
    const { session } = await bodyOf<CreateUploadResponse>(c);
    await api(`/api/v1/uploads/${session.id}/chunks/0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload.subarray(0, CHUNK),
    });
    const del = await api(`/api/v1/uploads/${session.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const aborted = await bodyOf<AbortUploadResponse>(del);
    assert.equal(aborted.aborted.discardedChunks, 1);
    assert.equal(
      existsSync(join(cfg.dataRoot, '.incoming', session.id)),
      false,
      '暂存目录应当被整个删掉',
    );

    const again = await api('/api/v1/uploads', json(req));
    const body = await bodyOf<CreateUploadResponse>(again);
    assert.equal(body.session.status, 'pending');
    assert.deepEqual(body.session.received, [], '放弃之后不该还有残留的分片');
  });

  await check('不存在的会话 → 404', async () => {
    const res = await api('/api/v1/uploads/deadbeef');
    assert.equal(res.status, 404);
  });

  await check('shape 不对的 id（.. ）→ 404，且不会跑到数据根目录外', async () => {
    const res = await api('/api/v1/uploads/..%2F..%2Fetc');
    assert.equal(res.status, 404);
  });

  // ── 上传完了之后，数据集管理页看到的记录 ─────────────────────
  await check('登记记录能在 /api/v1/code-assets 里查到，且带得上来历', async () => {
    const res = await api('/api/v1/code-assets');
    const body = await bodyOf<ListCodeAssetsResponse>(res);
    const mine = body.items.find((a) => a.location === join(cfg.dataRoot, targetDir));
    assert.ok(mine, '应当能查到');
    assert.match(mine.notes ?? '', /由数据集上传落位/u);
    assert.ok(mine.lastCheckedAt !== null);
  });

  // ── 未传完清单（刷新页面之后接着传就靠它）────────────────────
  //
  // 这一组测的是"界面凭什么知道服务器上还躺着什么"。它必须只列 pending，
  // 且每一条的进度都得来自磁盘 —— 否则刷新之后看到的进度和刚才不一样。
  await check('★ 未传完清单：列出 pending 会话，进度来自磁盘', async () => {
    const req = { ...createReq, fileName: 'listme.bin', lastModifiedMs: 77 };
    const c = await api('/api/v1/uploads', json(req));
    const { session } = await bodyOf<CreateUploadResponse>(c);
    await api(`/api/v1/uploads/${session.id}/chunks/1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload.subarray(CHUNK, 2 * CHUNK),
    });

    const res = await api('/api/v1/uploads');
    assert.equal(res.status, 200);
    const body = await bodyOf<ListUploadsResponse>(res);
    assert.equal(body.dataRoot, cfg.dataRoot, 'dataRoot 要如实回给界面（界面上要显示文件落到哪）');
    assert.equal(body.maxBytes, cfg.uploadMaxBytes);

    const mine = body.items.find((s) => s.id === session.id);
    assert.ok(mine, '刚传了一片、还没传完的会话应当在清单里');
    assert.deepEqual(mine.received, [1], '只传了第 1 片');
    assert.equal(mine.receivedBytes, CHUNK);
    assert.equal(mine.status, 'pending');
  });

  await check('清单里没有已完成/已放弃的会话', async () => {
    const res = await api('/api/v1/uploads');
    const body = await bodyOf<ListUploadsResponse>(res);
    assert.ok(
      body.items.every((s) => s.status === 'pending'),
      '清单只该列 pending —— 已完成的文件在数据集管理里查，不该混进"待办"',
    );
    assert.equal(
      body.items.some((s) => s.id === sessionId),
      false,
      '刚才那份已经落位了，不该还留在未传完清单里',
    );
  });

  await check('limit 生效', async () => {
    const res = await api('/api/v1/uploads?limit=1');
    const body = await bodyOf<ListUploadsResponse>(res);
    assert.equal(body.items.length, 1);
  });

  // ── 归属：会话不是公共资源 ──────────────────────────────────
  //
  // 会话 id 由**文件自身的特征**派生（目标目录 + 文件名 + 总字节 + 最后修改时间，
  // 见 shared/uploads.ts），所以它不是一个秘密 —— 知道那个文件的人自己就能算出来。
  // 补上归属之前，"接着传别人的半截上传""把别人传了一半的文件拼完落位"
  // "放弃掉别人正在传的任务"全都不需要任何身份。这一组钉住的就是这几件事。
  //
  // 三个身份：verifier（本脚本一直用的 member）、other（另一个 member）、
  // admin。成员的资料**不**互相可见，"是不是管理员"则是另一档。
  const { token: otherToken } = createSession(db, {
    userId: await insertUser(
      db,
      'verify-other',
      { password: 'verify-pw-654321', role: 'member', displayName: '另一个成员' },
      new Date(),
    ),
    now: new Date(),
    idleDays: cfg.sessionIdleDays,
    maxDays: cfg.sessionMaxDays,
    ip: null,
    userAgent: null,
  });
  const { token: adminToken } = createSession(db, {
    userId: await insertUser(
      db,
      'verify-admin',
      { password: 'verify-pw-admin-1', role: 'admin', displayName: '验证管理员' },
      new Date(),
    ),
    now: new Date(),
    idleDays: cfg.sessionIdleDays,
    maxDays: cfg.sessionMaxDays,
    ip: null,
    userAgent: null,
  });
  const otherCookie = `${SESSION_COOKIE}=${otherToken}`;
  const adminCookie = `${SESSION_COOKIE}=${adminToken}`;

  // 别人手上那份（未传完，只传了 1 片）。
  const theirReq = {
    targetDir: 'medical/others',
    fileName: 'theirs.bin',
    totalBytes: 4096,
    lastModifiedMs: 123456789,
  };
  const theirRes = await apiAs(otherCookie, '/api/v1/uploads', json(theirReq));
  const { session: theirSession } = await bodyOf<CreateUploadResponse>(theirRes);
  await apiAs(otherCookie, `/api/v1/uploads/${theirSession.id}/chunks/0`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: makeBytes(4096),
  });

  await check('★ 不是你的会话：查进度 → 404（与"不存在"共用答复，不泄露它存在）', async () => {
    const res = await api(`/api/v1/uploads/${theirSession.id}`);
    assert.equal(res.status, 404);
  });

  await check('★ 不是你的会话：往里收片 → 404', async () => {
    const res = await api(`/api/v1/uploads/${theirSession.id}/chunks/0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: makeBytes(4096),
    });
    assert.equal(res.status, 404);
    // 404 只是"答复"，还得确认磁盘**真的**没被写进去 —— 否则就是一个
    // "应答很正确、副作用照做"的越权口子。
    const again = await apiAs(otherCookie, `/api/v1/uploads/${theirSession.id}`);
    const body = await bodyOf<GetUploadResponse>(again);
    assert.deepEqual(body.session.received, [0], '别人的片数不该变');
  });

  await check('★ 不是你的会话：替别人拼装落位 → 404', async () => {
    const res = await api(`/api/v1/uploads/${theirSession.id}/complete`, json({}));
    assert.equal(res.status, 404);
    const body = await bodyOf<ApiErrorBody>(res);
    assert.equal(body.error.code, 'not_found');
  });

  await check('★ 不是你的会话：放弃别人的任务 → 404，且会话仍是 pending', async () => {
    const res = await api(`/api/v1/uploads/${theirSession.id}`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    const after = await apiAs(adminCookie, `/api/v1/uploads/${theirSession.id}`);
    const body = await bodyOf<GetUploadResponse>(after);
    assert.equal(body.session.status, 'pending', '别人的会话不该被这一下放弃掉');
  });

  await check('★ 未传完清单按归属筛：成员的清单里没有别人的会话', async () => {
    const mine = await bodyOf<ListUploadsResponse>(await api('/api/v1/uploads?limit=200'));
    assert.equal(
      mine.items.some((s) => s.id === theirSession.id),
      false,
      '别人的半截上传不该出现在我的"待办"里',
    );
    const theirs = await bodyOf<ListUploadsResponse>(
      await apiAs(otherCookie, '/api/v1/uploads?limit=200'),
    );
    assert.equal(
      theirs.items.some((s) => s.id === theirSession.id),
      true,
      '而它必须出现在**他自己**的清单里 —— 否则他刷新页面就找不到自己在传什么了',
    );
  });

  await check('★ 同一份文件：别人建过会话 → 409（不能悄悄接管）', async () => {
    const res = await api('/api/v1/uploads', json(theirReq));
    assert.equal(res.status, 409);
    const body = await bodyOf<ApiErrorBody>(res);
    // 文案要能指路。只回一句"冲突"，用户唯一能做的就是反复点重试。
    assert.match(body.error.message, /别人/u);
  });

  await check('★ 管理员看得到也管得了别人的会话（要能替人收尾）', async () => {
    const seen = await apiAs(adminCookie, `/api/v1/uploads?limit=200`);
    const body = await bodyOf<ListUploadsResponse>(seen);
    assert.equal(
      body.items.some((s) => s.id === theirSession.id),
      true,
      '管理员要看得到在途的搬运 —— 否则"磁盘被谁占着"这件事没人答得上来',
    );
    const res = await apiAs(adminCookie, `/api/v1/uploads/${theirSession.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  });

  // NULL 归属 = 阶段 3（还没有登录时）留下的公共历史行。**放行**是有意的：
  // 那批会话不属于任何人，而写入侧的 createdBy 是必填的（见 repo.ts 的
  // insertSession），今天没有人能再造出一个 NULL 归属的会话来冒充历史数据。
  // id 必须长成会话 id 的样子（64 位十六进制，见 uploads/layout.ts 的 assertSessionId）——
  // 任意字符串会在读片目录那一步被判形状不对，测不到"归属放行"这件事本身。
  const LEGACY_ID = '5e55' + '10a'.repeat(20); // 「有 'legacy' 味道」的固定值，不可能是真实文件的哈希
  insertSession(db, {
    id: LEGACY_ID,
    targetDir: 'medical/legacy',
    fileName: 'legacy.bin',
    totalBytes: 4096,
    chunkSize: CHUNK,
    chunkCount: 1,
    createdBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await check('★ NULL 归属的历史会话：所有登录用户都能接着传（公共历史数据）', async () => {
    const res = await api(`/api/v1/uploads/${LEGACY_ID}`);
    assert.equal(res.status, 200);
    const mine = await bodyOf<ListUploadsResponse>(await api('/api/v1/uploads?limit=200'));
    assert.equal(
      mine.items.some((s) => s.id === LEGACY_ID),
      true,
      '公共历史行对谁都可见 —— 否则阶段 3 传了一半的文件再也没人能接着传',
    );
  });

  // ── 结果 ────────────────────────────────────────────────────
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

/** 目录不存在时 readdir 会抛 ENOENT；对"这里还有没有残留"这个问题，空目录与不存在是同一个答案。 */
function readdirSyncSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

await main();
