/**
 * 期刊分区库（阶段 3 增补 C）的验证脚本：`npm run verify-journal -w @knowpilot/server`。
 *
 * 【为什么这份不碰网络也不花模型钱】它要钉死的是**导入与人工维护**这套
 *   本地逻辑：种子导进去对不对、重导是不是幂等、人工录入会不会被导入冲掉、
 *   能不能删、搜索转义对不对、显示语义（来源 → 可不可信）判得准不准。
 *   这些全是确定性的，用临时库跑就够了 —— 出一帧网、调一次模型都只会让
 *   结果随外部状态漂移，而不是让结论更可信。
 *
 * 测试使用虚构期刊和分区，覆盖与正式导入共用的写入路径。
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isUnverifiedSource, rankingSourceLabel, UNVERIFIED_WEB_LABEL } from '@knowpilot/shared';
import { openDb, type Db } from '../db/index.ts';
import {
  countJournals,
  deleteManualRanking,
  getJournalById,
  insertManualRanking,
  listRankings,
  loadLatestRanking,
  searchJournals,
  updateJournal,
  updateManualRanking,
  upsertJournal,
} from './repo.ts';
import { importSeed, readSeedFile } from './seed/import.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'knowpilot-journal-verify-'));
const NOW = new Date('2026-10-11T05:00:00.000Z').toISOString();

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

function countRankings(db: Db, journalId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM journal_rankings WHERE journal_id = ?').get(journalId) as unknown as { n: number }).n;
}

function findByName(db: Db, name: string): string {
  const row = db.prepare('SELECT id FROM journals WHERE name = ?').get(name) as unknown as { id: string } | undefined;
  if (row === undefined) throw new Error(`测试前提不成立：库里没有「${name}」`);
  return row.id;
}

function main(): void {
  // 用临时库文件而不是 `:memory:`：openDb 会先 resolve 路径（同 web-check）。
  const { db, migration } = openDb(join(ROOT, 'verify.db'));

  // ── 迁移 v13 ───────────────────────────────────────────────
  console.log('迁移 v13（分区维度列）');
  {
    const cols = (db.prepare('PRAGMA table_info(journal_rankings)').all() as unknown as { name: string }[]).map((c) => c.name);
    check('有 category 列', cols.includes('category'));
    check('有 top 列', cols.includes('top'));
    check('有 note 列', cols.includes('note'));
    check('schema 至少到 v13', migration.toVersion >= 13, `实际 v${migration.toVersion}`);

    // 唯一键必须含 category，否则大类与小类两条会互相覆盖。
    const idx = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_journal_rankings_key'`)
      .get() as unknown as { sql: string };
    check('唯一键含 category', idx.sql.includes('category'), idx.sql);
  }

  // ── 导入 ───────────────────────────────────────────────────
  console.log('导入种子');
  const seed = readSeedFile(new URL('./seed/journals.example.json', import.meta.url));
  const seedRankings = seed.journals.reduce((n, j) => n + j.rankings.length, 0);
  {
    check('虚构种子有 5 本刊', seed.journals.length === 5, `实际 ${seed.journals.length}`);
    const withRs = seed.journals.filter((j) =>
      j.rankings.some((r) => r.system === '中科院' && r.category === '遥感'),
    ).length;
    check('虚构种子有 1 本遥感刊', withRs === 1, `实际 ${withRs}`);
    check('种子 meta 带来源链接', seed.meta.sourceUrl.startsWith('https://'));
  }

  {
    const s = importSeed(db, seed, NOW);
    check('导入后刊数 = 种子刊数', countJournals(db) === seed.journals.length, `库 ${countJournals(db)} vs 种子 ${seed.journals.length}`);
    check('导入后分区数 = 种子分区数', s.totalRankings === seedRankings);
    check('首次导入全部是 created', s.outcomes.created === seedRankings && s.outcomes.updated === 0 && s.outcomes.kept_local === 0, JSON.stringify(s.outcomes));
    check('首次导入新建了全部刊', s.journalsCreated === seed.journals.length);
  }

  {
    const s = importSeed(db, seed, NOW);
    check('重复导入 → 幂等（0 新增 0 更新）', s.outcomes.created === 0 && s.outcomes.updated === 0 && s.outcomes.kept_local === 0, JSON.stringify(s.outcomes));
    check('重复导入 → 全部 unchanged', s.outcomes.unchanged === seedRankings);
    check('重复导入 → 没有新建刊', s.journalsCreated === 0);
  }

  // ── 大类 + 遥感小类两个维度 ────────────────────────────────
  console.log('大类分区与遥感小类分区');
  {
    const jid = findByName(db, 'Example Journal of Remote Sensing');
    const rows = listRankings(db, jid, 50).filter((r) => r.system === '中科院');
    check('遥感刊有 2 条中科院分区（大类 + 小类）', rows.length === 2, `实际 ${rows.length}`);
    const major = rows.find((r) => r.category === '地球科学');
    const rs = rows.find((r) => r.category === '遥感');
    check('大类未分类为 3 区', major?.rank === '3区', JSON.stringify(major));
    check('遥感小类为 4 区', rs?.rank === '4区', JSON.stringify(rs));
    check('两者档位不同（这正是维度必须分开存的原因）', major?.rank !== rs?.rank);

    // 台账那一行只放得下一条 —— 必须取大类那条，否则两台机器上可能显示不同档位。
    const latest = loadLatestRanking(db, jid);
    check('台账单行取的是大类那条', latest?.category === '地球科学' && latest?.rank === '3区', JSON.stringify(latest));
  }
  {
    // 纯计算机刊只有大类一条，没有遥感小类。
    const jid = findByName(db, 'Example Computer Science Review');
    const rows = listRankings(db, jid, 50).filter((r) => r.system === '中科院');
    check('计算机刊只有 1 条中科院分区', rows.length === 1, `实际 ${rows.length}`);
    check('样例计算机刊大类 1 区且是 Top', rows[0]?.rank === '1区' && rows[0]?.top === true, JSON.stringify(rows[0]));
    check('note 带排名分母', rows[0]?.note?.startsWith('排名 ') === true, String(rows[0]?.note));
  }
  {
    // JCR 行：来源是 official，带影响因子
    const jid = findByName(db, 'Example Computer Science Review');
    const jcr = listRankings(db, jid, 50).find((r) => r.system === 'JCR');
    check('JCR 行存在且为 Q1', jcr?.rank === 'Q1', JSON.stringify(jcr));
    check('JCR 行 note 带影响因子', jcr?.note?.includes('IF ') === true, String(jcr?.note));
    check('JCR 行来源为 official', jcr?.source === 'official');
  }

  // ── JCR 未匹配（界面那句标记的判据）────────────────────────
  //
  // 界面上给那几本刊打的「JCR 未匹配」是一句**界面算出来的**话，判据是
  // "有导入来的中科院分区、却一条 JCR 都没有"。这里把那个式子原样跑一遍，
  // 钉住它确实等于种子 meta 里记的 jcrMissing —— 否则改了界面判据之后，
  // 标记会悄悄多出或少掉几本，而没有任何东西会报错。
  console.log('JCR 未匹配');
  {
    const n = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM journals j
           WHERE EXISTS (SELECT 1 FROM journal_rankings r
                         WHERE r.journal_id = j.id AND r.source = 'official' AND r.system = '中科院')
             AND NOT EXISTS (SELECT 1 FROM journal_rankings r2
                             WHERE r2.journal_id = j.id AND r2.system = 'JCR')`,
        )
        .get() as unknown as { n: number }
    ).n;
    check('界面判据框出的正是种子记的那几本', n === seed.meta.jcrMissing, `判据算出 ${n} vs meta ${String(seed.meta.jcrMissing)}`);
  }

  // ── 导入不覆盖人工录入 ─────────────────────────────────────
  console.log('导入与人工录入的优先级');
  {
    const jid = findByName(db, 'Example Computer Science Review');
    // 把种子里的那条大类分区改写成人工录入的另一个档位。
    insertManualRanking(
      db,
      { journalId: jid, year: 2025, system: '中科院', category: '计算机科学', rank: '9区', top: false, note: null, sourceUrl: null },
      NOW,
    );

    const s = importSeed(db, seed, NOW);
    check('导入不覆盖人工录入（计入 kept_local）', s.outcomes.kept_local === 1, JSON.stringify(s.outcomes));
    const row = listRankings(db, jid, 50).find((r) => r.system === '中科院' && r.category === '计算机科学');
    check('人工录入的值仍在', row?.rank === '9区' && row?.source === 'manual', JSON.stringify(row));

    // --force 才覆盖
    const forced = importSeed(db, seed, NOW, { force: true });
    check('--force 覆盖人工录入（计入 updated）', forced.outcomes.updated === 1, JSON.stringify(forced.outcomes));
    const after = listRankings(db, jid, 50).find((r) => r.system === '中科院' && r.category === '计算机科学');
    check('--force 后回到官方值', after?.rank === '1区' && after?.source === 'official', JSON.stringify(after));
  }

  // ── 人工录入与删除 ─────────────────────────────────────────
  console.log('人工录入与删除');
  {
    const jid = findByName(db, 'Example Computing Surveys');
    const made = insertManualRanking(
      db,
      { journalId: jid, year: 2026, system: 'JCR', category: '', rank: 'Q1', top: false, note: '手工订正', sourceUrl: 'https://x.example/' },
      NOW,
    );
    check('人工录入 → source=manual', made.source === 'manual');
    check('人工录入 → verified=0', made.verified === false);
    check('人工录入 → 留了来源链接', made.sourceUrl === 'https://x.example/');

    check('删人工录入的分区 → 成功', deleteManualRanking(db, jid, made.id) === true);
    check('删除后真的没了', listRankings(db, jid, 50).every((r) => r.id !== made.id));

    const official = listRankings(db, jid, 50).find((r) => r.source === 'official');
    check('测试前提：这本刊有官方分区', official !== undefined);
    check('删官方分区 → 被拒绝', deleteManualRanking(db, jid, official?.id ?? '') === false);
    check('官方分区仍在', countRankings(db, jid) > 0);
  }

  // ── 订正：期刊字段 ─────────────────────────────────────────
  console.log('订正期刊的 ISSN / 领域');
  {
    const id = upsertJournal(db, { name: '订正测试刊', issn: '1111-1111', field: '甲学' }, NOW).id;
    const after = updateJournal(db, id, { issn: '2222-2222', field: '乙学' });
    // 这条正是它与 upsertJournal 的分界：那个"已有值优先"，这个"覆盖"。
    check('订正覆盖已有值（与 upsertJournal 的只补空相反）', after?.issn === '2222-2222' && after?.field === '乙学', JSON.stringify(after));
    const cleared = updateJournal(db, id, { issn: null, field: '乙学' });
    check('订正传 null = 清空该项', cleared?.issn === null && cleared?.field === '乙学', JSON.stringify(cleared));
    check('订正不存在的 id → null', updateJournal(db, 'no-such-id', { issn: null, field: null }) === null);
  }

  // ── 订正：人工分区 ─────────────────────────────────────────
  console.log('订正人工录入的分区');
  {
    const jid = findByName(db, 'Example Computing Surveys');
    const made = insertManualRanking(
      db,
      { journalId: jid, year: 2030, system: 'JCR', category: '甲类', rank: 'Q3', top: false, note: null, sourceUrl: null },
      NOW,
    );
    const other = insertManualRanking(
      db,
      { journalId: jid, year: 2031, system: 'JCR', category: '甲类', rank: 'Q4', top: false, note: null, sourceUrl: null },
      NOW,
    );

    const r = updateManualRanking(
      db,
      jid,
      made.id,
      { year: 2030, system: 'JCR', category: '甲类', rank: 'Q1', top: true, note: '订正过', sourceUrl: 'https://y.example/' },
      NOW,
    );
    // 先把结果收窄到一个局部变量：`outcome !== 'updated'` 时 ranking 是 null，
    // 而下面的断言要看的是"更新后的那一行"，分开写比在每行都重复一遍判别式清楚。
    const updated = r.outcome === 'updated' ? r.ranking : null;
    check(
      '订正值 → updated',
      updated !== null && updated.rank === 'Q1' && updated.top === true,
      JSON.stringify(r),
    );
    check('订正的是同一条（id 不变，不是删了重插）', updated?.id === made.id);
    check('订正后来源仍是 manual、verified 仍是 0', updated?.source === 'manual' && updated?.verified === false);
    check('订正的值确实落库了', listRankings(db, jid, 50).find((x) => x.id === made.id)?.note === '订正过');

    // 年份 / 体系 / 维度都在唯一键里 —— 所以"改键"是订正必须支持的动作。
    const moved = updateManualRanking(
      db,
      jid,
      made.id,
      { year: 2032, system: 'JCR', category: '乙类', rank: 'Q1', top: true, note: '订正过', sourceUrl: null },
      NOW,
    );
    check('订正可以改键（年份 / 维度）', moved.outcome === 'updated' && moved.ranking.year === 2032 && moved.ranking.category === '乙类', JSON.stringify(moved));

    // 撞键：改后的键已被**另一条**占着 → 报冲突，且两边都不许动。
    const clash = updateManualRanking(
      db,
      jid,
      made.id,
      { year: 2031, system: 'JCR', category: '甲类', rank: 'Q9', top: false, note: null, sourceUrl: null },
      NOW,
    );
    check('改成已被占用的键 → conflict', clash.outcome === 'conflict' && clash.ranking === null);
    check('冲突时没动被占的那条', listRankings(db, jid, 50).find((x) => x.id === other.id)?.rank === 'Q4');
    check('冲突时也没动自己那条', listRankings(db, jid, 50).find((x) => x.id === made.id)?.year === 2032);

    // 导入与联网的行改不动（同删除：那份数据是权威表的副本，要订正就重导）。
    const official = listRankings(db, jid, 50).find((x) => x.source === 'official');
    check('测试前提：这本刊有官方分区', official !== undefined);
    const denied = updateManualRanking(
      db,
      jid,
      official?.id ?? '',
      { year: 2025, system: '中科院', category: '计算机科学', rank: '9区', top: false, note: null, sourceUrl: null },
      NOW,
    );
    check('订正官方分区 → 被拒绝', denied.outcome === 'not_found');
    check('被拒后官方分区原样', listRankings(db, jid, 50).find((x) => x.id === official?.id)?.source === 'official');

    check(
      '订正不存在的分区 id → not_found',
      updateManualRanking(db, jid, 'no-such-id', { year: 2030, system: 'JCR', category: '', rank: 'Q1', top: false, note: null, sourceUrl: null }, NOW).outcome === 'not_found',
    );

    // 清场：这两条是本次造的，留着会影响后面的统计。
    deleteManualRanking(db, jid, made.id);
    deleteManualRanking(db, jid, other.id);
    check('清场：本次造的两条人工分区已删', listRankings(db, jid, 50).every((x) => x.year < 2030));
  }

  // ── 搜索 ───────────────────────────────────────────────────
  console.log('搜索');
  {
    const byName = searchJournals(db, { keyword: 'remote sensing', limit: 50 });
    check('按刊名（不分大小写）能命中', byName.length > 0);
    check(
      '命中的刊名确实含搜索词',
      byName.every((j) => j.name.toLowerCase().includes('remote sensing')),
      byName.map((j) => j.name).join(', '),
    );

    const byIssn = searchJournals(db, { keyword: '1234-5679', limit: 10 });
    check('按 ISSN 能命中', byIssn.some((j) => j.name === 'Example Computer Science Review'), JSON.stringify(byIssn.map((j) => j.name)));

    // 未转义的 % 会匹配到任何刊名 —— 那正是 escapeLike 要挡的。
    const pct = searchJournals(db, { keyword: '%', limit: 50 });
    check('% 被转义：不匹配任何刊', pct.length === 0, `实际命中 ${pct.length} 本`);

    const none = searchJournals(db, { keyword: '不存在的刊名zzz', limit: 10 });
    check('查不到就是空数组', none.length === 0);

    const all = searchJournals(db, { keyword: undefined, limit: 5 });
    check('空关键词 → 列前 N 本', all.length === 5);

    // 命中数 vs 列出数：界面靠这两个数说"共命中 137 本，这里只显示前 50"。
    // 两者必须来自**同一个** where —— 差一丝，用户就会看到"共 137 本"却翻不到。
    const listed = searchJournals(db, { keyword: 'remote sensing', limit: 500 });
    check('countJournals 带关键词 = 搜索命中的真实条数', countJournals(db, 'remote sensing') === listed.length, `count ${countJournals(db, 'remote sensing')} vs 列出 ${listed.length}`);
    check('空关键词时 countJournals = 全库', countJournals(db) === countJournals(db, undefined));
    const clipped = searchJournals(db, { keyword: 'e', limit: 3 });
    check('命中数不受 limit 影响（界面据此判断被截断）', countJournals(db, 'e') > clipped.length, `命中 ${countJournals(db, 'e')}，只列出 ${clipped.length}`);
  }

  // ── 新建期刊（find-or-create / 补空不覆盖）─────────────────
  console.log('新建与补全期刊');
  {
    const a = upsertJournal(db, { name: '一本全新的刊', issn: '1234-5678', field: '测试学' }, NOW);
    check('新建 → created', a.created === true);
    const b = upsertJournal(db, { name: '一本全新的刊', issn: '9999-0000', field: '别的学' }, NOW);
    check('同名再建 → 复用', b.created === false && b.id === a.id);
    const got = getJournalById(db, a.id);
    check('已有值不被覆盖（只补空）', got?.issn === '1234-5678' && got?.field === '测试学');
    check('大小写不同视为同一本（NOCASE）', upsertJournal(db, { name: '一本全新的刊' }, NOW).id === a.id);
  }

  // ── 显示语义：来源决定可不可信 ─────────────────────────────
  console.log('来源与可信度');
  {
    check('官方分区表 → 不打"未经核对"', isUnverifiedSource('official') === false);
    check('人工录入 → 不打"未经核对"', isUnverifiedSource('manual') === false);
    check('联网检索 → 打"未经核对"', isUnverifiedSource('web_search') === true);
    check('来源标签有中文名', rankingSourceLabel('official') === '官方分区表' && rankingSourceLabel('web_search') === '网络检索');
    check('认不出的来源原样显示，不吞掉', rankingSourceLabel('imported_v2') === 'imported_v2');
    check('免责句非空', UNVERIFIED_WEB_LABEL.length > 0);

    // 官方导入的行 verified 仍是 0 —— 这正是不能拿 verified 当可信度判据的原因。
    const jid = findByName(db, 'Example Computing Surveys');
    const official = listRankings(db, jid, 50).find((r) => r.source === 'official');
    check('官方行的 verified 确实是 0（所以判据只能是 source）', official?.verified === false);
  }

  db.close();
  rmSync(ROOT, { recursive: true, force: true });

  console.log('');
  if (failures.length > 0) {
    console.error(`${failures.length} 项断言失败（通过 ${passed} 项）：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`期刊分区库全部通过（${passed} 项）。`);
  }
}

main();
