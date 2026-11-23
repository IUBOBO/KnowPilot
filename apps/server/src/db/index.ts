/**
 * SQLite 连接与迁移执行器。
 *
 * 用 Node 22 内置的 node:sqlite，不引 better-sqlite3。理由：
 *   better-sqlite3 是原生扩展，安装时要编译 C++，Windows 上需要
 *   Visual Studio Build Tools + Python。实验室机器装环境失败，
 *   十有八九卡在这一步。内置模块零编译，换个 Node 版本也不会 ABI 不匹配。
 *   代价是 node:sqlite 在 Node 22 上标记为 experimental，API 可能变动 ——
 *   可接受，因为我们只用了最基础的 exec/prepare。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MIGRATIONS, type Migration } from './migrations.ts';

export type Db = DatabaseSync;

export interface MigrateResult {
  fromVersion: number;
  toVersion: number;
  applied: readonly string[];
}

function checksum(sql: string): string {
  // 归一化空白后再算哈希：避免编辑器把 LF 换成 CRLF 就误报"迁移被篡改"
  return createHash('sha256').update(sql.replace(/\s+/g, ' ').trim()).digest('hex');
}

/**
 * 打开数据库并把结构升到最新版。
 *
 * 每次启动都调用，幂等：已应用的迁移会跳过。
 */
export function openDb(dbPath: string): { db: Db; migration: MigrateResult } {
  // 【为什么 ':memory:' 要先判、不能过 `resolve`】`resolve(':memory:')` 会把它
  //   拼成一个**绝对路径**（形如 `E:\…\:memory:`），于是下面那个
  //   `abs !== ':memory:'` 永远为真、`mkdirSync` 去建一个名字带冒号的目录 ——
  //   Windows 上直接 `unable to open database file`。也就是说内存库这个分支
  //   **从来没能用**，而它看上去像是支持的。2026-10-16 写 T1 的故障注入用例时踩到。
  const abs = dbPath === ':memory:' ? dbPath : resolve(dbPath);
  if (abs !== ':memory:') {
    mkdirSync(dirname(abs), { recursive: true });
  }

  const db = new DatabaseSync(abs, { enableForeignKeyConstraints: true });

  // WAL 让读写不互相阻塞（管理端看用量时，用户端问答不会被卡住）。
  // 必须在任何事务之外执行，且 :memory: 不支持，故跳过。
  if (abs !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');

  const migration = migrate(db);
  return { db, migration };
}

/**
 * 执行迁移。事务保证：要么这条迁移整个生效，要么完全没发生。
 * 中途失败不会留下"改了一半的表"。
 */
export function migrate(db: Db): MigrateResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const rows = db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as unknown as { version: number; name: string; checksum: string }[];

  const appliedVersions = new Set(rows.map((r) => r.version));
  const fromVersion = rows.length > 0 ? Math.max(...rows.map((r) => r.version)) : 0;

  // 校验历史迁移未被篡改。这是防"某人在生产库上手动改过结构、
  // 或改了已发布的迁移脚本导致新老环境结构不一致"——那种不一致极难排查。
  for (const row of rows) {
    const def = MIGRATIONS.find((m) => m.version === row.version);
    if (!def) {
      throw new Error(
        `数据库里记录了迁移 v${row.version}(${row.name})，但代码里找不到对应定义。` +
          `说明这个库来自更新版本的代码，当前代码无法安全操作它。`,
      );
    }
    const actual = checksum(def.sql);
    if (actual !== row.checksum) {
      throw new Error(
        `迁移 v${row.version}(${row.name}) 的内容已被修改，校验和不符。\n` +
          `已应用的迁移不允许再改；如需变更请追加一条新的迁移。\n` +
          `若确认是本机开发库，可删除数据库文件重建。`,
      );
    }
  }

  const pending = MIGRATIONS.filter((m) => !appliedVersions.has(m.version)).sort(
    (a, b) => a.version - b.version,
  );

  const applied: string[] = [];
  for (const m of pending) {
    applyOne(db, m);
    applied.push(`v${m.version}:${m.name}`);
  }

  const toVersion = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), fromVersion);
  return { fromVersion, toVersion, applied };
}

function applyOne(db: Db, m: Migration): void {
  db.exec('BEGIN');
  try {
    db.exec(m.sql);
    db.prepare(
      'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
    ).run(m.version, m.name, checksum(m.sql), new Date().toISOString());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw new Error(`迁移 v${m.version}(${m.name}) 执行失败，已回滚：${String(err)}`, {
      cause: err,
    });
  }
}
