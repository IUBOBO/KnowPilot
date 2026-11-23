/**
 * 实时查询工具（单元 ④）的验证脚本：`npm run verify-live -w @knowpilot/server`。
 *
 * 【为什么这一份完全不碰模型】两个工具里真正会出错的地方全是确定性的：
 * 关键词能不能匹配到、LIKE 的通配符有没有转义、同一条记录会不会拿到两个编号、
 * 路径的存在性判定对不对、组装出来的引用有没有带上查询时点。
 * 这些用真模型去测只会变成"守着它哪天碰巧出错"。这里直接调工具工厂的
 * `execute`，全部断言钉死，不花一分钱。
 *
 * 【为什么用 :memory: 库 + 临时目录】脚本会插记录、会探目录。用真实配置
 * 就等于污染开发库。临时目录跑完整个删掉，与真实数据无关。
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createDatasetTool,
  createSubmissionsTool,
  type SubmissionsToolDeps,
} from './live-tools.ts';
import { verifyAnswer } from './citations.ts';
import { EvidencePool, renderEvidenceForModel } from './evidence.ts';
import { PUBLIC_ONLY_SCOPE } from '../auth/scope.ts';
import { openDb } from '../db/index.ts';
import type { Db } from '../db/index.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'knowpilot-live-verify-'));
const DATASETS = join(ROOT, 'datasets');

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

/** 直接插一条期刊，返回其 id。 */
function insertJournal(db: Db, name: string): string {
  const id = randomUUID();
  db.prepare('INSERT INTO journals (id, name, issn, field, created_at) VALUES (?, ?, NULL, NULL, ?)').run(
    id,
    name,
    new Date().toISOString(),
  );
  return id;
}

function insertSubmission(
  db: Db,
  input: { title: string; journalId: string | null; status: string; updatedAt: string },
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO submissions (id, user_id, title, journal_id, status, submitted_at, updated_at, notes, created_at)
     VALUES (?, NULL, ?, ?, ?, NULL, ?, NULL, ?)`,
  ).run(id, input.title, input.journalId, input.status, input.updatedAt, now);
  return id;
}

function insertAsset(
  db: Db,
  input: { name: string; location: string; host: string | null; project: string | null },
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO code_assets (id, project, name, location, host, access_note, notes,
       last_check_result, last_checked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 'unchecked', NULL, ?, ?)`,
  ).run(id, input.project, input.name, input.location, input.host, now, now);
  return id;
}

/** 取工具返回的给模型看的那段文字。 */
function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('');
}

const FIXED_NOW = new Date('2026-10-11T04:00:00.000Z');

async function main(): Promise<void> {
  mkdirSync(join(DATASETS, 'organize-smoke'), { recursive: true });
  // gone-set 刻意不建目录 —— 它要验证"探过了，确实没有"。

  // 用临时库文件而不是 `:memory:`：openDb 会先 resolve 路径，
  // 而 `resolve(':memory:')` 会把它变成一个真实路径，打不开。
  const { db } = openDb(join(ROOT, 'verify.db'));

  const journalNature = insertJournal(db, 'Nature Machine Intelligence');
  const journalCvpr = insertJournal(db, 'CVPR');
  db.prepare(
    `INSERT INTO journal_rankings
       (id, journal_id, year, system, rank, source, verified, source_url, fetched_at, created_at)
     VALUES (?, ?, 2025, '中科院', '1区', 'manual', 0, NULL, ?, ?)`,
  ).run(randomUUID(), journalNature, new Date().toISOString(), new Date().toISOString());

  insertSubmission(db, {
    title: '示例论文甲',
    journalId: journalNature,
    status: 'under_review',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
  insertSubmission(db, {
    title: '示例论文乙',
    journalId: journalCvpr,
    status: 'published',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
  insertSubmission(db, {
    title: '100% 相似度实验',
    journalId: null,
    status: 'preparing',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });

  insertAsset(db, {
    name: 'organize-smoke',
    location: join(DATASETS, 'organize-smoke'),
    host: null,
    project: '编码验证',
  });
  insertAsset(db, {
    name: 'remote-set',
    location: '/srv/knowpilot/datasets/nlp/remote-set',
    host: 'lab-server',
    project: 'nlp',
  });
  insertAsset(db, {
    name: 'gone-set',
    location: join(DATASETS, 'gone-set'),
    host: null,
    project: null,
  });

  const pool = new EvidencePool();
  // 本脚本没有身份可言，用"只看公共数据"的范围 —— 而下面插的这条台账
  // 归属列全是 NULL（脚本第 56 行显式写 NULL），正好属于公共历史数据，
  // 所以断言与加权限之前完全一致。行级过滤本身（甲的列表里没有乙的记录）
  // 由 verify-auth 断言。
  const deps: SubmissionsToolDeps = {
    db,
    config: { codeRoots: [ROOT] },
    pool,
    scope: PUBLIC_ONLY_SCOPE,
    now: () => FIXED_NOW,
  };
  const submissions = createSubmissionsTool(deps);
  const datasets = createDatasetTool(deps);

  console.log('投稿台账工具');
  {
    const r = await submissions.execute('t1', { keyword: '示例论文甲' });
    const text = textOf(r);
    check('按标题命中', r.details.evidenceIds.length === 1);
    check('返回文本含状态', text.includes('状态：外审'));
    check('返回文本含查询时点', text.includes('2026-10-11T04:00:00.000Z'));
    check('返回给模型的文本含能力标签', text.includes('【投稿台账】'));
  }

  {
    const r = await submissions.execute('t2', { keyword: 'CVPR' });
    check('按期刊名命中', r.details.evidenceIds.length === 1);
    check(
      '命中项是投给 CVPR 的那条',
      textOf(r).includes('示例论文乙'),
      textOf(r).slice(0, 120),
    );
  }

  {
    const r = await submissions.execute('t3', { status: 'published' });
    check('按状态过滤', r.details.evidenceIds.length === 1);
  }

  {
    const all = await submissions.execute('t4', {});
    check('无关键词 → 返回全部（受 limit 限制）', all.details.evidenceIds.length === 3);
  }

  {
    const r = await submissions.execute('t5', { limit: 1 });
    check('limit 生效', r.details.evidenceIds.length === 1);
  }

  {
    // 库里有条标题真的含 `%`（「100% 相似度实验」）。未转义时 `%` 会变成"任意字符"，
    // 把三条全召回；转义后只该命中那一条。
    const r = await submissions.execute('t6', { keyword: '%' });
    check(
      'LIKE 的 % 被当字面量（只命中真的含 % 的那条）',
      r.details.evidenceIds.length === 1,
      `实际 ${r.details.evidenceIds.length} 条`,
    );
    check('命中的确实是那条含 % 的记录', textOf(r).includes('100%'));
  }

  {
    const r = await submissions.execute('t7', { keyword: '不存在的东西' });
    check('查不到 → 没有证据', r.details.evidenceIds.length === 0);
    check('查不到 → 明确禁止改用文档作答', textOf(r).includes('不要'));
  }

  console.log('数据集探测工具');
  {
    const r = await datasets.execute('t1', { keyword: 'organize-smoke' });
    const text = textOf(r);
    check('按名称命中', r.details.evidenceIds.length === 1);
    check('存在性=存在', text.includes('核对结果：存在'));
    check('给出绝对路径', text.includes(join(DATASETS, 'organize-smoke')));
    check('返回给模型的文本含能力标签', text.includes('【数据集】'));
  }

  {
    const r = await datasets.execute('t2', { keyword: 'gone-set' });
    check('目录真的不在 → 未找到', textOf(r).includes('核对结果：未找到'));
  }

  {
    const r = await datasets.execute('t3', { keyword: 'remote-set' });
    const text = textOf(r);
    check('声明在别的机器上 → 无法核对', text.includes('核对结果：无法核对'));
    check('说明里点明是哪台机器', text.includes('lab-server'));
  }

  {
    const r = await datasets.execute('t4', { keyword: '压根没有' });
    check('查不到 → 没有证据', r.details.evidenceIds.length === 0);
    check('查不到 → 禁止猜路径', textOf(r).includes('不要'));
  }

  console.log('证据池与编号');
  {
    const fresh = new EvidencePool();
    const s = createSubmissionsTool({
      db,
      config: { codeRoots: [ROOT] },
      pool: fresh,
      scope: PUBLIC_ONLY_SCOPE,
      now: () => FIXED_NOW,
    });
    const a = await s.execute('t1', { keyword: '示例论文甲' });
    const b = await s.execute('t2', { keyword: '示例论文甲' });
    check('同一条记录查到两次 → 沿用同一个编号', a.details.evidenceIds[0] === b.details.evidenceIds[0]);
    check('第二次不算新增', b.details.newEvidenceIds.length === 0);
    check('池子只有一个证据', fresh.size === 1);
  }

  {
    // 文档引用与台账引用共用同一串编号
    const fresh = new EvidencePool();
    const s = createSubmissionsTool({
      db,
      config: { codeRoots: [ROOT] },
      pool: fresh,
      scope: PUBLIC_ONLY_SCOPE,
      now: () => FIXED_NOW,
    });
    const rec = await s.execute('t1', { keyword: '示例论文甲' });
    const docId = 'E9';
    check('台账先发号 E1', rec.details.evidenceIds[0] === 'E1');
    const cite = verifyAnswer('该稿在外审 [E1]。', new Map(fresh.all().map((e) => [e.id, e])));
    const c = cite.citations[0];
    check('台账引用可被引用校验保留', cite.citations.length === 1 && c?.id === 'E1');
    if (c?.sourceType === 'record') {
      check('台账引用带查询时点', c.queryTime === '2026-10-11T04:00:00.000Z');
      check('台账引用带记录 id', c.recordId.length > 0);
      check('台账引用没有 chunkId 字段', !('chunkId' in c));
    } else {
      check('台账引用应组装为 record 类型', false, String(c?.sourceType));
    }
    check('文档号 E9 未被台账占用', !rec.details.evidenceIds.includes(docId));
  }

  {
    const ev = pool.all().find((e) => e.kind === 'record');
    const rendered = ev === undefined ? '' : renderEvidenceForModel(ev);
    check('池子里确实有记录类证据', ev !== undefined);
    check('渲染给模型的记录含查询时点', rendered.includes('查询时点'));
    check('渲染给模型的记录含逐行字段', rendered.includes('状态：'));
  }

  {
    // 台账里没有的编号仍会被剔除（沿用引用校验既有行为）
    const r = verifyAnswer('某结论 [E404]。', new Map(pool.all().map((e) => [e.id, e])));
    check('编造的编号被剔除', !r.answer.includes('[E404]') && r.warnings.length > 0);
  }

  // Windows 上必须先关掉 SQLite 句柄再删目录，否则 verify.db 仍被占用，
  // rmSync 抛 EBUSY —— 断言全过了却以失败收场。
  db.close();
  rmSync(ROOT, { recursive: true, force: true });

  console.log('');
  if (failures.length > 0) {
    console.error(`${failures.length} 项断言失败（通过 ${passed} 项）：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`实时查询工具全部通过（${passed} 项）。`);
  }
}

await main();
