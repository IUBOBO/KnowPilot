/**
 * R2 离线实验：A=FTS5 / B=BGE-M3 / C=RRF / D=RRF+Rerank。
 *
 * 用法：
 *   npm run eval-rerank -w @knowpilot/server
 *   npm run eval-rerank -w @knowpilot/server -- --answers     # 追加答案级指标（真调模型，花钱）
 *
 * 【为什么必须是独立脚本，而不是改 eval/run.ts 的评分】
 *   评测跑批回答的是"系统有没有达到验收线"；这里回答的是"要不要换一条检索链路"。
 *   两个问题一旦共用一套评分，实验的临时阈值就会变成产品门槛 —— R2 明确要求
 *   "达不到门槛就保留 RRF，不强求合入"，所以实验结论必须能独立地写"不启用"。
 *
 * 【固定什么】
 *   语料：`seedCorpus` 的固定快照（每轮新建隔离库，同版本同快照）；
 *   查询：用例表里所有带 `gold` 的题目（金标是语料标签，运行时解析成块 id）；
 *   权限：全部以同一个成员用户、无材料过滤执行；
 *   候选规模：Hybrid 固定 RRF_DEPTH=100 融合后取前 `depth`（默认 30）进重排。
 *
 * 【度量什么】
 *   召回与排序分开：Recall@N / MRR@N / nDCG@N（N 默认 limit，候选池按 depth）/ 来源覆盖率；
 *   另报 `hybrid@30` 的召回 —— 那是重排的**候选池上限**，重排不可能超过它。
 *   资源：每条查询的检索耗时 P50/P95、模型加载耗时、进程 RSS 峰值；
 *   失败：回退次数与原因。答案级指标（Supported Claim Rate / 引用覆盖率 / 遗漏率）
 *   只在 `--answers` 下跑，走真实 `eval/run.ts` 两轮，不在这里重复实现。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RankingInfo } from '@knowpilot/shared';
import { loadConfig, onnxPath } from '../config.ts';
import { openDb } from '../db/index.ts';
import { embedTexts } from '../documents/embed.ts';
import { isRerankModelReady, scorePassages } from '../documents/rerank.ts';
import { searchDocuments } from '../documents/search.ts';
import { GC_CASES } from './cases.ts';
import { seedCorpus, type EvalCorpus } from './corpus.ts';
import { createEvalRunRoot } from './guard.ts';
import type { EvalReport, GcCase } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '../..');
const REPO_ROOT = resolve(SERVER_ROOT, '../..');

interface Args {
  limit: number;
  depth: number;
  answers: boolean;
  /** 只重算已有答案报告，不重新调用模型（逗号分隔的两个报告路径）。 */
  scoreAnswers: readonly string[] | null;
}

function parseArgs(argv: readonly string[]): Args {
  let limit = 10;
  let depth = 30;
  let answers = false;
  let scoreAnswers: readonly string[] | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit') {
      limit = Number.parseInt(argv[i + 1] ?? '', 10);
      i += 1;
    } else if (arg === '--depth') {
      depth = Number.parseInt(argv[i + 1] ?? '', 10);
      i += 1;
    } else if (arg === '--answers') {
      answers = true;
    } else if (arg === '--score-answers') {
      scoreAnswers = (argv[i + 1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      i += 1;
    } else {
      throw new Error(
        `未知参数 "${arg}"。可用：--limit <n> / --depth <n> / --answers / --score-answers <off.json>,<on.json>`,
      );
    }
  }
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit 必须是 ≥1 的整数');
  if (!Number.isInteger(depth) || depth < limit) throw new Error('--depth 必须是 ≥limit 的整数');
  return { limit, depth, answers, scoreAnswers };
}

interface ModeRun {
  caseId: string;
  question: string;
  latencyMs: number;
  /** 本次实际返回的全部命中（候选池组可能 ≥10 条）。 */
  hitIds: readonly string[];
  goldIds: readonly string[];
  goldLabels: readonly string[];
  labelCovered: readonly boolean[];
  recall: number;
  mrr: number;
  ndcg: number;
  ranking?: RankingInfo;
}

interface ModeSummary {
  name: string;
  /** 这组指标是按前多少条算的（A–D 为 limit，候选池为 depth）。 */
  at: number;
  queryCount: number;
  recallAt: number;
  mrrAt: number;
  ndcgAt: number;
  sourceCoverage: number;
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
  emptyQueries: number;
  fallbacks: number;
  fallbackReasons: Record<string, number>;
}

const args = parseArgs(process.argv.slice(2));
const base = loadConfig();

if (!isRerankModelReady(base)) {
  console.error(
    `重排模型不在 ${base.embedModelDir}/${base.rerankModelId}。\n` +
      '先运行 npm run fetch-reranker-model -w @knowpilot/server。',
  );
  process.exit(1);
}
if (!existsSync(onnxPath(base))) {
  console.error(`BGE-M3 不在 ${onnxPath(base)}：语义组无法运行，实验没有意义。`);
  process.exit(1);
}

const runsBase = join(REPO_ROOT, 'data', 'eval-runs');
const runRoot = createEvalRunRoot(runsBase, 'rerank');
const dataRoot = join(runRoot, 'datasets');
mkdirSync(dataRoot, { recursive: true });

const cfg = {
  ...base,
  port: 0,
  dbPath: join(runRoot, 'knowpilot.db'),
  uploadDir: join(runRoot, 'uploads'),
  repoRoot: runRoot,
  dataRoot,
  codeRoots: [dataRoot],
  ocrEnabled: false,
  rerankEnabled: false,
  rerankCandidateDepth: args.depth,
};

const { db } = openDb(cfg.dbPath);

const rss = (): number => Math.round(process.memoryUsage().rss / 1024 / 1024);
const rssBaseline = rss();
let rssPeak = rssBaseline;

const seedStart = Date.now();
const corpus = await seedCorpus(db, cfg);
const seedMs = Date.now() - seedStart;
rssPeak = Math.max(rssPeak, rss());

console.log(`R2 重排实验：${corpus.dataSnapshot}`);
console.log(`运行目录：${runRoot}`);
console.log(`语料播种 ${seedMs}ms，进程 RSS ${rss()}MB\n`);

// 预热两套模型，把加载耗时与查询耗时分开记账。
const embedStart = Date.now();
await embedTexts(cfg, ['预热查询']);
const embedLoadMs = Date.now() - embedStart;

const rssBeforeRerank = rss();
const rerankStart = Date.now();
await scorePassages(cfg, '预热查询', ['预热段落，用于把模型加载成本单独计入。']);
const rerankLoadMs = Date.now() - rerankStart;
const rssAfterRerank = rss();
rssPeak = Math.max(rssPeak, rssAfterRerank);

console.log(
  `模型加载：BGE-M3 ${embedLoadMs}ms；Reranker ${rerankLoadMs}ms` +
    `（RSS ${rssBeforeRerank}→${rssAfterRerank}MB）\n`,
);

const cases: readonly GcCase[] = GC_CASES.filter(
  (c) => c.question !== undefined && c.gold !== undefined && c.gold.length > 0,
);

// 只重算已有答案报告（不调模型、不重跑检索）：用于修正度量口径或复核旧结果。
if (args.scoreAnswers !== null) {
  const labels = ['C RRF', 'D RRF+Rerank'];
  const scored = args.scoreAnswers.map((path, i) =>
    answerMetrics(labels[i] ?? `group-${i + 1}`, resolve(REPO_ROOT, path)),
  );
  const fmt = (x: number | null): string => (x === null ? 'N/A' : `${(x * 100).toFixed(1)}%`);
  console.log('答案级指标（重算，未调用模型）：');
  console.log('组                Supported Claim Rate  引用来源覆盖  遗漏率  Claims  矛盾  待核对  依据不足');
  for (const a of scored) {
    console.log(
      `${a.group.padEnd(16)}  ${fmt(a.supportedRate).padStart(20)}  ${fmt(a.citationCoverage).padStart(11)}  ` +
        `${fmt(a.omissionRate).padStart(6)}  ${String(a.claims).padStart(6)}  ${String(a.contradicted).padStart(4)}  ` +
        `${String(a.reviewRequired).padStart(6)}  ${String(a.insufficient).padStart(8)}`,
    );
  }
  // 重算结果写在报告旁边，而不是本轮新建的空目录里 —— 否则报告与结论分家。
  const dirs = new Set(args.scoreAnswers.map((p) => dirname(resolve(REPO_ROOT, p))));
  const outDir = dirs.size === 1 ? [...dirs][0] ?? runRoot : runRoot;
  writeFileSync(
    join(outDir, 'answers-recomputed.json'),
    `${JSON.stringify(scored, null, 2)}\n`,
    'utf8',
  );
  process.exit(0);
}

function goldIdsOf(c: GcCase): string[] {
  return (c.gold ?? []).flatMap((label) => corpus.gold[label] ?? []);
}

function evaluate(
  c: GcCase,
  hits: readonly string[],
  latencyMs: number,
  at: number,
  ranking?: RankingInfo,
): ModeRun {
  const goldIds = goldIdsOf(c);
  const goldSet = new Set(goldIds);
  const top = hits.slice(0, at);
  const hitSet = new Set(top);

  let firstAt = -1;
  for (let i = 0; i < top.length; i += 1) {
    if (goldSet.has(top[i] ?? '')) {
      firstAt = i;
      break;
    }
  }
  const mrr = firstAt === -1 ? 0 : 1 / (firstAt + 1);
  const dcg = top.reduce((sum, id, i) => sum + (goldSet.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const idealCount = Math.min(goldIds.length, at);
  let idcg = 0;
  for (let i = 0; i < idealCount; i += 1) idcg += 1 / Math.log2(i + 2);
  const ndcg = idcg === 0 ? 0 : dcg / idcg;
  const recall = goldIds.length === 0 ? 0 : (goldIds.filter((id) => hitSet.has(id)).length) / goldIds.length;

  return {
    caseId: c.id,
    question: c.question ?? '',
    latencyMs,
    hitIds: hits,
    goldIds,
    goldLabels: c.gold ?? [],
    labelCovered: (c.gold ?? []).map((label) => {
      const ids = corpus.gold[label] ?? [];
      return ids.some((id) => hitSet.has(id));
    }),
    recall,
    mrr,
    ndcg,
    ...(ranking === undefined ? {} : { ranking }),
  };
}

function summarize(name: string, runs: readonly ModeRun[], at: number): ModeSummary {
  const n = runs.length;
  const avg = (xs: readonly number[]): number => (n === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / n);
  const latencies = runs.map((r) => r.latencyMs).sort((a, b) => a - b);
  const pct = (p: number): number => {
    if (latencies.length === 0) return 0;
    const idx = Math.min(latencies.length - 1, Math.max(0, Math.ceil((p / 100) * latencies.length) - 1));
    return latencies[idx] ?? 0;
  };
  const fallbackReasons: Record<string, number> = {};
  let fallbacks = 0;
  for (const r of runs) {
    const reason = r.ranking?.fallbackReason;
    if (reason !== undefined) {
      fallbacks += 1;
      fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
    }
  }
  return {
    name,
    at,
    queryCount: n,
    recallAt: avg(runs.map((r) => r.recall)),
    mrrAt: avg(runs.map((r) => r.mrr)),
    ndcgAt: avg(runs.map((r) => r.ndcg)),
    sourceCoverage: avg(runs.map((r) =>
      r.labelCovered.length === 0 ? 0 : r.labelCovered.filter(Boolean).length / r.labelCovered.length,
    )),
    p50Ms: pct(50),
    p95Ms: pct(95),
    meanMs: avg(runs.map((r) => r.latencyMs)),
    emptyQueries: runs.filter((r) => r.hitIds.length === 0).length,
    fallbacks,
    fallbackReasons,
  };
}

async function runMode(
  name: string,
  mode: 'keyword' | 'semantic' | 'hybrid',
  limit: number,
  rerank: boolean,
  at: number = limit,
): Promise<ModeRun[]> {
  const modeCfg = { ...cfg, rerankEnabled: rerank };
  const out: ModeRun[] = [];
  for (const c of cases) {
    const started = performance.now();
    const res = await searchDocuments(db, modeCfg, {
      query: c.question ?? '',
      mode,
      limit,
    });
    const latencyMs = performance.now() - started;
    rssPeak = Math.max(rssPeak, rss());
    out.push(evaluate(c, res.hits.map((h) => h.chunkId), latencyMs, at, res.ranking));
  }
  console.log(`  ${name} 完成`);
  return out;
}

console.log(`查询集：${cases.length} 条（用例表里所有带 gold 的题目）`);
for (const c of cases) console.log(`  · ${c.id}  ${c.question}`);

const keywordRuns = await runMode(`A FTS5@${args.limit}`, 'keyword', args.limit, false);
const semanticRuns = await runMode(`B BGE-M3@${args.limit}`, 'semantic', args.limit, false);
const hybridRuns = await runMode(`C RRF@${args.limit}`, 'hybrid', args.limit, false);
const rerankRuns = await runMode(`D RRF+Rerank@${args.limit}`, 'hybrid', args.limit, true);
// 候选池召回：C 的前 depth 条就是 D 的候选池（两路召回顺序不随 limit 变）。
const candidateRuns = await runMode(`C 候选池@${args.depth}`, 'hybrid', args.depth, false, args.depth);

const summaries = [
  summarize(`A FTS5@${args.limit}`, keywordRuns, args.limit),
  summarize(`B BGE-M3@${args.limit}`, semanticRuns, args.limit),
  summarize(`C RRF@${args.limit}`, hybridRuns, args.limit),
  summarize(`D RRF+Rerank@${args.limit}`, rerankRuns, args.limit),
  summarize(`C 候选池@${args.depth}（D 的上限）`, candidateRuns, args.depth),
];

function pctText(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function msText(x: number): string {
  return `${x.toFixed(0)}ms`;
}

console.log('\n名称                               Recall@N   MRR@N   nDCG@N   来源覆盖   P50     P95     回退');
for (const s of summaries) {
  console.log(
    `${s.name.padEnd(32)}  ${pctText(s.recallAt).padStart(8)}  ${s.mrrAt.toFixed(3).padStart(6)}  ` +
      `${s.ndcgAt.toFixed(3).padStart(7)}  ${pctText(s.sourceCoverage).padStart(7)}   ` +
      `${msText(s.p50Ms).padStart(6)}  ${msText(s.p95Ms).padStart(6)}  ${s.fallbacks}`,
  );
}

const rerankSuccess = summarize(
  'D（仅重排成功的查询）',
  rerankRuns.filter((r) => r.ranking?.mode === 'rerank'),
  args.limit,
);
if (rerankSuccess.queryCount !== summaries[3]?.queryCount) {
  console.log(
    `\nD 组 ${rerankSuccess.queryCount}/${rerankRuns.length} 条为重排成功；` +
      `仅这 ${rerankSuccess.queryCount} 条的指标：Recall@${args.limit} ${pctText(rerankSuccess.recallAt)}，` +
      `nDCG@${args.limit} ${rerankSuccess.ndcgAt.toFixed(3)}。`,
  );
}
if (summaries[3] !== undefined && summaries[3].fallbacks > 0) {
  console.log('D 组回退原因：');
  for (const [reason, count] of Object.entries(summaries[3].fallbackReasons)) {
    console.log(`  · ${count} 次：${reason}`);
  }
}

console.log(`\n进程 RSS：基线 ${rssBaseline}MB，峰值 ${rssPeak}MB。`);
console.log(`模型加载：BGE-M3 ${embedLoadMs}ms，Reranker ${rerankLoadMs}ms。`);

// ── 答案级指标（可选）────────────────────────────────────────────
interface AnswerMetrics {
  group: string;
  supportedRate: number | null;
  claims: number;
  supported: number;
  contradicted: number;
  reviewRequired: number;
  insufficient: number;
  citationCoverage: number | null;
  omissionRate: number | null;
  delivery: Record<string, number>;
  errors: number;
  reportPath: string;
}

/**
 * 答案级引用覆盖必须**按文档标题**对齐，不能按 chunk id。
 *
 * 【为什么】`--answers` 的每一轮由 `eval/run.ts` 自己新建隔离库、重新播种语料，
 *   块 id 是那一轮现生成的 UUID；父进程手里的 `corpus.gold` 来自另一套块 id。
 *   第一版直接比 id，结果必然是 0% —— 一个"看起来像结论"的假数字。
 *   标题在同一语料版本下稳定，跨库可对齐。
 */
function titlesOfChunks(dbPath: string): Map<string, string> | null {
  if (!existsSync(dbPath)) return null;
  const { db: answerDb } = openDb(dbPath);
  const rows = answerDb
    .prepare(
      `SELECT c.id AS chunk_id, d.title AS title
         FROM doc_chunks c JOIN documents d ON d.id = c.doc_id`,
    )
    .all() as unknown as { chunk_id: string; title: string }[];
  answerDb.close();
  return new Map(rows.map((r) => [r.chunk_id, r.title]));
}

/** 找到某一轮跑批的库：报告里的 runId 与 `.eval-root` 标记内容一致。 */
function findRunDb(runId: string): string | null {
  for (const name of readdirSync(runsBase)) {
    const dir = join(runsBase, name);
    const marker = join(dir, '.eval-root');
    if (!existsSync(marker)) continue;
    if (readFileSync(marker, 'utf8').trim() === runId) return join(dir, 'knowpilot.db');
  }
  return null;
}

/** 语料标签 → 文档标题（标题在同一 dataSnapshot 下稳定）。 */
function labelTitles(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [label, ids] of Object.entries(corpus.gold)) {
    const first = ids[0];
    if (first === undefined) continue;
    const row = db
      .prepare(
        `SELECT d.title AS title FROM doc_chunks c JOIN documents d ON d.id = c.doc_id WHERE c.id = ?`,
      )
      .get(first) as unknown as { title: string } | undefined;
    if (row !== undefined) out.set(label, row.title);
  }
  return out;
}

function answerMetrics(group: string, reportPath: string): AnswerMetrics {
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as EvalReport;
  const traces = report.traces;
  let supported = 0;
  let claims = 0;
  const verdictCounts = { contradicted: 0, review_required: 0, insufficient: 0 };
  for (const t of traces) {
    for (const c of t.claimChecks) {
      claims += 1;
      if (c.verdict === 'supported') supported += 1;
      else if (c.verdict === 'contradicted') verdictCounts.contradicted += 1;
      else if (c.verdict === 'review_required') verdictCounts.review_required += 1;
      else if (c.verdict === 'insufficient') verdictCounts.insufficient += 1;
    }
  }
  const byCase = new Map(traces.map((t) => [t.caseId, t]));
  const titleByChunk = titlesOfChunks(findRunDb(report.runId) ?? '');
  const titleByLabel = labelTitles();
  let labels = 0;
  let covered = 0;
  if (titleByChunk !== null) {
    for (const c of cases.filter((x) => x.id.startsWith('E0-'))) {
      const trace = byCase.get(c.id);
      if (trace === undefined) continue;
      const citedTitles = new Set(
        trace.citationMap.flatMap((x) => {
          const title = x.chunkId === null ? undefined : titleByChunk.get(x.chunkId);
          return title === undefined ? [] : [title];
        }),
      );
      for (const label of c.gold ?? []) {
        labels += 1;
        const title = titleByLabel.get(label);
        if (title !== undefined && citedTitles.has(title)) covered += 1;
      }
    }
  }
  const delivery: Record<string, number> = {};
  for (const t of traces) delivery[t.deliveryStatus] = (delivery[t.deliveryStatus] ?? 0) + 1;
  return {
    group,
    supportedRate: claims === 0 ? null : supported / claims,
    claims,
    supported,
    contradicted: verdictCounts.contradicted,
    reviewRequired: verdictCounts.review_required,
    insufficient: verdictCounts.insufficient,
    citationCoverage: labels === 0 ? null : covered / labels,
    omissionRate: labels === 0 ? null : 1 - covered / labels,
    delivery,
    errors: traces.reduce((n, t) => n + t.errors.length, 0),
    reportPath,
  };
}

let answers: AnswerMetrics[] | null = null;
if (args.answers) {
  const answerCases = cases.filter((c) => c.id.startsWith('E0-')).map((c) => c.id);
  console.log(`\n答案级指标：对 ${answerCases.length} 条 E0 用例各跑 1 次（两组，真调模型）……`);
  answers = [];
  for (const on of [false, true]) {
    const group = on ? 'D RRF+Rerank' : 'C RRF';
    const reportPath = join(runRoot, `answers-${on ? 'rerank' : 'rrf'}.json`);
    const child = spawnSync(
      process.execPath,
      [
        '--env-file-if-exists=../../.env',
        '--import', 'tsx',
        'src/eval/run.ts',
        '--only', answerCases.join(','),
        '--k', '1',
        '--root', runsBase,
        '--report', reportPath,
      ],
      {
        cwd: SERVER_ROOT,
        env: {
          ...process.env,
          KNOWPILOT_EVAL_REAL_MODEL: '1',
          KNOWPILOT_RERANK_ENABLED: on ? '1' : '0',
        },
        stdio: 'inherit',
      },
    );
    if (child.status !== 0 || !existsFile(reportPath)) {
      console.error(`答案级 ${group} 跑批失败（exit ${child.status}），后续指标记为 null。`);
      answers.push({
        group, supportedRate: null, claims: 0, supported: 0, contradicted: 0,
        reviewRequired: 0, insufficient: 0, citationCoverage: null, omissionRate: null,
        delivery: {}, errors: 0, reportPath,
      });
      continue;
    }
    answers.push(answerMetrics(group, reportPath));
  }
  const fmt = (x: number | null): string => (x === null ? 'N/A' : `${(x * 100).toFixed(1)}%`);
  console.log('\n答案级指标（E0 金标题）：');
  console.log('组                Supported Claim Rate  引用来源覆盖  遗漏率  Claims  矛盾  待核对  依据不足');
  for (const a of answers) {
    console.log(
      `${a.group.padEnd(16)}  ${fmt(a.supportedRate).padStart(20)}  ${fmt(a.citationCoverage).padStart(11)}  ` +
        `${fmt(a.omissionRate).padStart(6)}  ${String(a.claims).padStart(6)}  ${String(a.contradicted).padStart(4)}  ` +
        `${String(a.reviewRequired).padStart(6)}  ${String(a.insufficient).padStart(8)}`,
    );
  }
}

function existsFile(path: string): boolean {
  return existsSync(path);
}

const report = {
  at: new Date().toISOString(),
  kind: 'r2-rerank-experiment',
  runRoot,
  dataSnapshot: corpus.dataSnapshot,
  args,
  models: {
    embedModelId: base.embedModelId,
    rerankModelId: base.rerankModelId,
    rerankDtype: base.rerankDtype,
  },
  queries: cases.map((c) => ({ id: c.id, question: c.question, gold: c.gold })),
  load: {
    seedMs,
    embedLoadMs,
    rerankLoadMs,
    rssBaselineMb: rssBaseline,
    rssBeforeRerankMb: rssBeforeRerank,
    rssAfterRerankMb: rssAfterRerank,
    rssPeakMb: rssPeak,
  },
  summaries,
  rerankSuccessSummary: rerankSuccess,
  perQuery: {
    keyword: keywordRuns,
    semantic: semanticRuns,
    hybrid: hybridRuns,
    rerank: rerankRuns,
    hybridCandidates: candidateRuns,
  },
  answers,
  notes: [
    '金标由 AI 起草、未经领域人工复核；只适合同快照下的相对比较。',
    `查询集只有 ${cases.length} 条，P95 实际接近最大值，不能当作稳定的尾部延迟估计。`,
    `D 组的候选池是 C 的前 ${args.depth} 条；候选池召回（${pctText(summaries[4]?.recallAt ?? 0)}）是重排的收益上限。`,
    'Recall/nDCG 按“金标文档切出的全部块”计算：金标是多块文档时，Top10 装不下全部块属正常，来源覆盖率更贴近“答案有没有覆盖这些资料”。',
    '重排模型只调整**已召回候选**的顺序，不能把未召回的金标变出来；因此必须把候选池召回与排序指标分开看。',
    'RSS 是 Node 进程整体（含两套模型与 SQLite），不是重排模型的独占内存。',
  ],
};

const reportPath = join(runRoot, 'rerank-experiment.json');
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\n实验报告：${reportPath}`);
