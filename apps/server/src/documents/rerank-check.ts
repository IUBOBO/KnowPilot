/**
 * Cross-Encoder 重排的接线断言：`npm run verify-rerank -w @knowpilot/server`。
 *
 * 【为什么这些断言必须零模型】
 *   重排真正的风险不是"分数算得准不准"（那是离线实验回答的问题），而是
 *   **接线错了却看起来正常**：开了 flag 没生效、模型失败没有回退、候选深度
 *   把结果截短、回退后顺序却悄悄变了。这些都能在没有 300MB 权重的情况下
 *   用手造打分器钉死。真模型段单独放在最后，没装模型时如实记 NOT_RUN，
 *   不折算成通过。
 *
 * 【用 keyword-only 语料走 hybrid 路径】
 *   不插向量（embedded = 0）时混合检索只剩关键词一路，融合顺序就是 FTS 的
 *   bm25 顺序 —— 完全确定，且不需要 BGE-M3。`isModelReady` 只检查权重文件
 *   是否存在，临时目录里放一个空文件即可让请求进入语义分支，不会真跑推理。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { segmentForIndex } from '@knowpilot/shared';
import { loadConfig, onnxPath, type AppConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { isRerankModelReady, RerankUnavailableError, scorePassages } from './rerank.ts';
import { rankingText } from './ranking-text.ts';
import { parseSectionPath } from './repo.ts';
import { searchDocuments, type SearchDeps } from './search.ts';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${name}${detail === '' ? '' : ` —— ${detail}`}`);
}

function notRun(name: string, reason: string): void {
  console.log(`  · ${name} —— NOT_RUN（${reason}）`);
}

const NOW = '2026-01-01T00:00:00.000Z';
const QUERY = '重排目标';

const tmpRoot = mkdtempSync(join(tmpdir(), 'knowpilot-rerank-'));
process.once('exit', () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows 偶发占用不影响断言结果，留给系统临时目录回收。
  }
});

const baseCfg = loadConfig();
const uploadDir = join(tmpRoot, 'uploads');
mkdirSync(uploadDir, { recursive: true });

const cfgOff: AppConfig = {
  ...baseCfg,
  dbPath: ':memory:',
  uploadDir,
  embedModelDir: join(tmpRoot, 'models'),
  rerankEnabled: false,
  rerankCandidateDepth: 30,
};
// isModelReady 只看文件在不在；空文件足够把请求放进混合路径。
const fakeOnnx = onnxPath(cfgOff);
mkdirSync(dirname(fakeOnnx), { recursive: true });
writeFileSync(fakeOnnx, Buffer.alloc(0));

const cfgOn: AppConfig = { ...cfgOff, rerankEnabled: true };

const { db } = openDb(':memory:');

function insertDoc(id: string, material: string, title: string): void {
  db.prepare(
    `INSERT INTO documents (id, material, title, source_path, content_hash, created_at)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(id, material, title, `hash-${id}`, NOW);
}

function insertChunk(id: string, docId: string, ordinal: number, text: string): void {
  db.prepare(
    `INSERT INTO doc_chunks (id, doc_id, ordinal, text, text_seg, page, token_count)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  ).run(id, docId, ordinal, text, segmentForIndex(text), text.length);
}

insertDoc('doc-rule', 'rule', '制度');
insertDoc('doc-paper', 'paper', '论文');
insertChunk('rule-1', 'doc-rule', 0, `重排目标 第一段内容 [S1]`);
insertChunk('rule-2', 'doc-rule', 1, `重排目标 第二段内容 [S2]`);
insertChunk('rule-3', 'doc-rule', 2, `重排目标 第三段内容 [S3]`);
insertChunk('rule-4', 'doc-rule', 3, `重排目标 第四段内容 [S4]`);
insertChunk('paper-1', 'doc-paper', 0, `重排目标 材料外干扰 [S9]`);

/** 记录每次调用收到的候选原文；分数由调用方决定。 */
function recordingScorer(scores: (texts: string[]) => number[] | Promise<number[]>) {
  const calls: string[][] = [];
  const deps: SearchDeps = {
    scorePassages: async (_cfg, _query, passages) => {
      calls.push([...passages]);
      return scores([...passages]);
    },
  };
  return { calls, deps };
}

const baseline = await searchDocuments(db, cfgOff, { query: QUERY, mode: 'hybrid', limit: 2 });
const baselineIds = baseline.hits.map((h) => h.chunkId);

function textOf(chunkId: string): string {
  const row = db.prepare(
    'SELECT c.text, c.section_path, d.title FROM doc_chunks c JOIN documents d ON d.id = c.doc_id WHERE c.id = ?',
  ).get(chunkId) as
    | { text: string; section_path: string | null; title: string }
    | undefined;
  return row === undefined ? '' : rankingText(row.title, parseSectionPath(row.section_path), row.text);
}

console.log('重排接线（零模型）：开启 / 关闭 / 截断 / 回退');

// ── 1. 关闭：不调用打分器，结果与改造前逐条一致 ────────────────────
{
  const { calls, deps } = recordingScorer(() => {
    throw new Error('关闭重排时不应被调用');
  });
  const res = await searchDocuments(
    db,
    cfgOff,
    { query: QUERY, mode: 'hybrid', limit: 2 },
    deps,
  );
  check('flag 关闭时不调用打分器', calls.length === 0, `实际调用 ${calls.length} 次`);
  check('flag 关闭时响应不出现 ranking', res.ranking === undefined, JSON.stringify(res.ranking));
  check(
    'flag 关闭时顺序与基线一致',
    res.hits.map((h) => h.chunkId).join(',') === baselineIds.join(','),
    `${res.hits.map((h) => h.chunkId).join(',')} vs ${baselineIds.join(',')}`,
  );
  check(
    'flag 关闭时分数仍是 RRF 分',
    res.hits.every((h) => h.score > 0 && h.score < 0.05),
    res.hits.map((h) => h.score).join(','),
  );
}

// ── 2. 开启：只对候选池打分，返回顺序完全由重排分决定 ───────────────
{
  // 给收到的第 i 条（i 从 0 起）打 i 分：最后一条最高，结果必然是倒序。
  // 这样无论 bm25 原始顺序是什么，"重排真的改了顺序"都可断言。
  const { calls, deps } = recordingScorer((texts) => texts.map((_, i) => i));
  const cfgDepth2: AppConfig = { ...cfgOn, rerankCandidateDepth: 2 };
  const res = await searchDocuments(
    db,
    cfgDepth2,
    { query: QUERY, mode: 'hybrid', limit: 2 },
    deps,
  );

  check('开启时打分器被调用一次', calls.length === 1, `实际 ${calls.length} 次`);
  check('候选池被截到 depth=2', (calls[0]?.length ?? 0) === 2, `实际 ${calls[0]?.length}`);
  check(
    '候选池内容 = 融合顺序的前 2 名',
    (calls[0] ?? []).join('|') === baselineIds.map(textOf).join('|'),
    `${(calls[0] ?? []).join('|')} vs ${baselineIds.map(textOf).join('|')}`,
  );
  check('ranking.mode = rerank', res.ranking?.mode === 'rerank', JSON.stringify(res.ranking));
  check('ranking.candidates = 2', res.ranking?.candidates === 2, String(res.ranking?.candidates));
  check('ranking.ms 是数字', typeof res.ranking?.ms === 'number', String(res.ranking?.ms));
  check(
    '结果顺序被重排反转',
    res.hits.map((h) => h.chunkId).join(',') === [...baselineIds].reverse().join(','),
    `${res.hits.map((h) => h.chunkId).join(',')} vs ${[...baselineIds].reverse().join(',')}`,
  );
  check(
    '返回分数是重排分且降序',
    res.hits.length === 2 && res.hits[0]?.score === 1 && res.hits[1]?.score === 0,
    res.hits.map((h) => h.score).join(','),
  );
  check(
    'matchedBy 仍然标注召回路径',
    res.hits.every((h) => h.matchedBy?.includes('keyword') === true),
    JSON.stringify(res.hits.map((h) => h.matchedBy)),
  );
}

// ── 3. 回退：打分器抛错时顺序、分数、说明都回到 RRF ─────────────────
{
  const { calls, deps } = recordingScorer(() => {
    throw new RerankUnavailableError('重排超时（3000ms），已回退 RRF。');
  });
  const res = await searchDocuments(
    db,
    { ...cfgOn, rerankCandidateDepth: 2 },
    { query: QUERY, mode: 'hybrid', limit: 2 },
    deps,
  );

  check('回退发生在打分器调用之后', calls.length === 1, `实际 ${calls.length} 次`);
  check('回退后 ranking.mode = rrf', res.ranking?.mode === 'rrf', JSON.stringify(res.ranking));
  check(
    '回退后 fallbackReason 保留原因',
    res.ranking?.fallbackReason?.includes('超时') === true,
    String(res.ranking?.fallbackReason),
  );
  check('回退后不出现 ranking.ms', res.ranking?.ms === undefined, String(res.ranking?.ms));
  check(
    '回退后顺序与基线一致',
    res.hits.map((h) => h.chunkId).join(',') === baselineIds.join(','),
    res.hits.map((h) => h.chunkId).join(','),
  );
  check(
    '回退后分数回到 RRF 分',
    res.hits.every((h) => h.score > 0 && h.score < 0.05),
    res.hits.map((h) => h.score).join(','),
  );
  check(
    '回退时 notice 明确告知用户',
    res.notice?.includes('重排不可用') === true,
    String(res.notice),
  );
}

// ── 4. 没有候选：不加载模型、不报错，ranking 如实写 candidates=0 ─────
{
  const { calls, deps } = recordingScorer(() => {
    throw new Error('没有候选时不应被调用');
  });
  const start = Date.now();
  const res = await searchDocuments(
    db,
    cfgOn,
    { query: '完全不存在的甲乙丙', mode: 'hybrid', limit: 5 },
    deps,
  );
  check('没有候选时不调用打分器', calls.length === 0, `实际 ${calls.length} 次`);
  // 这条查询本来就会触发"缺向量"的说明；这里只断言不出现重排相关的说明。
  check(
    '没有候选时不添加重排 notice',
    res.notice === undefined || !res.notice.includes('重排'),
    String(res.notice),
  );
  check(
    '没有候选时 ranking = rrf/0',
    res.ranking?.mode === 'rrf' && res.ranking?.candidates === 0,
    JSON.stringify(res.ranking),
  );
  check('没有候选时没有额外耗时', Date.now() - start < 100, `${Date.now() - start}ms`);
}

// ── 5. 材料范围：候选池与最终结果都不能越过 material ─────────────────
{
  const { calls, deps } = recordingScorer((texts) => texts.map((_, i) => i));
  const res = await searchDocuments(
    db,
    { ...cfgOn, rerankCandidateDepth: 30 },
    { query: QUERY, mode: 'hybrid', limit: 3, material: 'rule' },
    deps,
  );
  check(
    '材料过滤后的候选池不含其它材料',
    (calls[0] ?? []).every((t) => !t.includes('[S9]')),
    (calls[0] ?? []).join('|'),
  );
  check(
    '材料过滤后的结果不含其它材料',
    res.hits.every((h) => h.material === 'rule'),
    res.hits.map((h) => h.material).join(','),
  );
  check('材料过滤下仍走重排', res.ranking?.mode === 'rerank', JSON.stringify(res.ranking));
}

// ── 6. 真模型段（默认 NOT_RUN）──────────────────────────────────────
console.log('\n真模型：加载、打分方向、端到端接线');
if (process.env['KNOWPILOT_RERANK_REAL_MODEL'] !== '1') {
  notRun('真模型打分', '未设置 KNOWPILOT_RERANK_REAL_MODEL=1');
} else if (!isRerankModelReady(baseCfg)) {
  notRun('真模型打分', `权重不在 ${baseCfg.embedModelDir}/${baseCfg.rerankModelId}`);
} else {
  const started = Date.now();
  const scores = await scorePassages(baseCfg, '学位论文答辩怎么申请', [
    '研究生学位论文答辩申请的流程包括本人申请、导师审核、学院审核。',
    '图书馆开放时间为每天早八点到晚十点。',
  ]);
  check(
    '相关段分数高于无关段',
    (scores[0] ?? 0) > (scores[1] ?? 0),
    scores.join(','),
  );
  check('真模型打分返回 2 个有限数', scores.length === 2 && scores.every(Number.isFinite), String(scores));
  console.log(`  （首次加载 + 2 条打分耗时 ${Date.now() - started}ms）`);

  // 端到端：数据库仍是 keyword-only，但打分器换成真的，验证 search 的接线。
  const realCfg: AppConfig = { ...cfgOn, rerankEnabled: true, rerankCandidateDepth: 30 };
  const res = await searchDocuments(db, realCfg, { query: QUERY, mode: 'hybrid', limit: 3 });
  check(
    '真模型下 search 走重排而非回退',
    res.ranking?.mode === 'rerank',
    JSON.stringify(res.ranking),
  );
  check(
    '真模型下没有回退说明',
    res.notice === undefined || !res.notice.includes('重排不可用'),
    String(res.notice),
  );
}

console.log('');
if (failed > 0) {
  console.error(`${failed} 项断言失败（通过 ${passed} 项）。`);
  process.exitCode = 1;
} else {
  console.log(`重排接线断言全部通过（${passed} 项）。`);
}
