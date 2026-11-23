/**
 * 服务入口。启动顺序刻意固定为：读配置 → 开库（含迁移）→ 起 HTTP。
 * 顺序颠倒会出现"服务已经在收请求，但表还没建好"的窗口。
 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createApp, SERVICE_NAME, SERVICE_VERSION } from './app.ts';
import { createLabModels } from './agent/models.ts';
import { sweepExpiredSessions } from './auth/session.ts';
import { ensureInitialAdmin } from './auth/users.ts';
import { embeddingModelKey, loadConfig, type AppConfig } from './config.ts';
import { openDb, type Db } from './db/index.ts';
import { isModelReady, warmUp } from './documents/embed.ts';
import { countEmbeddings } from './documents/vector.ts';
import { startPatrolScheduler } from './patrol/scheduler.ts';
import { sweepStaleSessions } from './uploads/store.ts';

async function main(): Promise<void> {
  const startedAt = Date.now();
  const cfg = loadConfig();
  const serveWeb = process.env['SERVE_WEB'] === '1';
  const webRoot = join(cfg.repoRoot, 'apps', 'web', 'dist');
  if (serveWeb && !existsSync(join(webRoot, 'index.html'))) {
    throw new Error('缺少前端构建，请先运行 npm run build -w @knowpilot/web。');
  }

  const { db, migration } = openDb(cfg.dbPath);

  if (migration.applied.length > 0) {
    console.log(`已应用 ${migration.applied.length} 条迁移：${migration.applied.join(', ')}`);
  }
  console.log(
    `数据库结构版本 v${migration.fromVersion} -> v${migration.toVersion}（${cfg.dbPath}）`,
  );

  reportSemanticStatus(cfg, db);

  // 清理久未活动的未完成上传：把 .incoming 里那些没人再会续传的分片删掉。
  // 放在启动时而不是定时器里 —— 详见 uploads/store.ts 的 sweepStaleSessions。
  const swept = sweepStaleSessions(cfg, db, new Date());
  if (swept > 0) {
    console.log(
      `清理了 ${swept} 个超过 ${cfg.uploadSessionTtlDays} 天没动静的上传会话（分片已释放）。`,
    );
  }

  // 过期会话清理。与上面的上传清理同一个位置、同一个理由：
  // 启动是唯一没有并发请求的时刻（见 auth/session.ts 的 sweepExpiredSessions）。
  const sessionsSwept = sweepExpiredSessions(db, new Date());
  if (sessionsSwept > 0) console.log(`清理了 ${sessionsSwept} 条已过期的登录会话。`);

  await reportAuthStatus(cfg, db);

  // 模型集合只建一次。它内部持有 provider 与鉴权解析状态，
  // 每请求重建会让"进程里同时存在几套鉴权"变得说不清。
  const models = createLabModels();

  const app = createApp({
    db,
    config: cfg,
    schemaVersion: migration.toVersion,
    startedAt,
    models,
  });

  // 页面放在外层路由，保持 API 内部的 matchedRoutes 权限判断不受 SPA 通配符影响。
  const web = new Hono();
  web.all('/api', (c) => app.fetch(c.req.raw, c.env));
  web.all('/api/*', (c) => app.fetch(c.req.raw, c.env));
  web.all('/health', (c) => app.fetch(c.req.raw, c.env));
  if (serveWeb) {
    web.use('*', async (c, next) => {
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('Cache-Control', 'no-cache');
      await next();
    });
    web.get('*', serveStatic({ root: webRoot }));
    const spa = serveStatic({ root: webRoot, path: 'index.html' });
    web.get('*', async (c, next) => {
      // 缺失资源和隐藏文件返回 404；仅页面路径回退到 React 入口。
      if (extname(c.req.path) || c.req.path.split('/').some((part) => part.startsWith('.'))) {
        return c.notFound();
      }
      return (await spa(c, next)) ?? c.notFound();
    });
  }
  const server = serve({
    fetch: serveWeb ? web.fetch : app.fetch,
    port: cfg.port,
    ...(process.env['HOST'] ? { hostname: process.env['HOST'] } : {}),
  }, (info) => {
    console.log(`${SERVICE_NAME} v${SERVICE_VERSION} 已启动: http://localhost:${info.port}`);
    console.log(`健康检查: http://localhost:${info.port}/health`);
  });

  // 巡检调度。放在 serve 之后：让 HTTP 先能接请求，巡检慢一点不影响可用性。
  // 它的定时器是 unref 的（见 scheduler.ts），不会妨碍下面的优雅退出。
  const stopPatrol = startPatrolScheduler(db, cfg.patrolIntervalHours);

  // 优雅退出：先停止收新连接，再关库。
  // 不关库在 WAL 模式下可能丢失尚未 checkpoint 的写入。
  const shutdown = (signal: string): void => {
    console.log(`收到 ${signal}，正在关闭...`);
    stopPatrol();
    server.close(() => {
      try {
        db.close();
      } catch (err) {
        console.error('关闭数据库时出错：', err);
      }
      process.exit(0);
    });
    // 兜底：10 秒内没关干净就强退，避免挂死
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * 启动时报告语义检索的状态，并在可用时后台预热模型。
 *
 * 为什么预热：首次调用要把 500 MB 权重读进内存，冷启动那一会儿
 * 恰好会落在"用户第一次点搜索"上，表现为一次莫名其妙的等待。
 * 预热把它挪到启动阶段，代价是启动后多占几百 MB 内存 —— 反正迟早要用。
 *
 * 为什么只报告不报错：模型没下载时关键词检索完全可用。为一个可选增强项
 * 让整个服务起不来，是拿主要功能给次要功能陪葬。
 */
/**
 * 引导第一个管理员，并**打印 cookie 的实际安全属性**。
 *
 * 【为什么要把 cookieSecure 打出来】它是那种"配错了完全没有症状"的配置：
 *   在 http 下带上 `Secure`，浏览器会**静默丢弃**那个 cookie，
 *   表现为"登录接口返回 200、也 Set-Cookie 了，但下一个请求仍然是 401"。
 *   没有任何报错、日志里也看不出异常，而排查方向会先跑到会话表、
 *   再到前端代码，最后才想到是浏览器丢的。开场就把它念出来，
 *   是让这类问题在发生之前就能被一眼看出。
 */
async function reportAuthStatus(cfg: AppConfig, db: Db): Promise<void> {
  const created = await ensureInitialAdmin(
    db,
    { adminUsername: cfg.adminUsername, adminPassword: cfg.adminPassword },
    new Date(),
  );

  if (created !== null) {
    console.log(`已创建初始管理员账号：${created.username}（口令来自 .env）。`);
    console.log('  这个动作只在 users 表为空时发生一次，之后改 .env 不会再建号。');
  } else if (cfg.adminUsername !== undefined && cfg.adminPassword !== undefined) {
    console.log('初始管理员：users 表非空，跳过 .env 引导（改用 /admin/users 管理账号）。');
  } else {
    console.log(
      '初始管理员：未配置 KNOWPILOT_ADMIN_USER / KNOWPILOT_ADMIN_PASSWORD。\n' +
        '  若 users 表还是空的，现在没有任何人能登录 —— 请在 .env 里配好再重启。',
    );
  }

  console.log(
    `登录 cookie：secure=${cfg.cookieSecure ? 'true' : 'false'}` +
      (cfg.cookieSecure
        ? '（只在 https 下会被回传；本地 http 调试请设 COOKIE_SECURE=0）'
        : '（http 下也会回传 —— 仅适用于本地/内网调试）'),
  );
  console.log(
    `会话有效期：闲置 ${cfg.sessionIdleDays} 天过期，绝对上限 ${cfg.sessionMaxDays} 天。`,
  );
}

function reportSemanticStatus(cfg: AppConfig, db: Db): void {
  const model = embeddingModelKey(cfg);
  if (!isModelReady(cfg)) {
    console.log(
      `语义检索：未启用（本地模型未下载）。关键词检索不受影响。\n` +
        `  如需启用：npm run fetch-model -w @knowpilot/server`,
    );
    return;
  }

  warmUp(cfg);
  console.log(`语义检索：已启用（${model}），模型正在后台加载。`);

  const embedded = countEmbeddings(db, model);
  const total = (db.prepare('SELECT COUNT(*) AS n FROM doc_chunks').get() as unknown as { n: number }).n;
  if (embedded < total) {
    console.log(
      `  注意：${total} 个检索块中只有 ${embedded} 个有向量，语义检索覆盖不全。\n` +
        `  补齐：npm run embed -w @knowpilot/server`,
    );
  }
}

main().catch((err: unknown) => {
  // 启动失败必须带着原因退出，而不是留下一个没有异常信息的非零退出码。
  console.error('启动失败：', err);
  process.exit(1);
});
