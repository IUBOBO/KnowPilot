/**
 * 检索候选范围的断言脚本：`npm run verify-retrieval -w @knowpilot/server`。
 *
 * 【它防的是哪一类回归】
 *   R1 修的是一个**静默召回失败**：语义检索先在**全库**取 TopN，再按 `material`
 *   过滤。只要另一个材料下恰好有 N 条更相近的干扰块，目标块连候选都进不了，
 *   过滤后 0 命中 —— 界面上只会显示"没找到"，不报错、不崩溃。
 *   这类问题不会让任何既有断言变红，所以必须专门构造"101 条干扰 + 1 条目标"。
 *
 * 【两段，各自回答不同的问题】
 *   1. 合成向量段（零模型、必跑）：直接摆出 101 条更相近的干扰向量，断言
 *      "全库 TopN 里没有目标"与"范围内 TopN 里目标排第一"——把**候选顺序**钉死。
 *      同时验证空范围、维度不符、关键词路径、模型缺失降级四条边界。
 *   2. 实机段（`KNOWPILOT_RETRIEVAL_REAL_MODEL=1` 才跑）：走真实的
 *      `uploadDocument + ingestDocument + searchDocuments`，用真 BGE-M3 复现
 *      同一场景。它证明"接线也对了"，而不是只证明排序函数对了。
 *      没开开关时如实记 NOT_RUN，不折算成通过。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { segmentForIndex } from '@knowpilot/shared';
import { loadConfig, onnxPath } from '../config.ts';
import { openDb } from '../db/index.ts';
import { createRetrieveTool, type RetrieveDetails } from '../agent/tools.ts';
import { EvidencePool } from '../agent/evidence.ts';
import { isModelReady, vecToBlob } from './embed.ts';
import { ingestDocument } from './ingest.ts';
import { loadNeighborChunks, searchDocuments } from './search.ts';
import { uploadDocument } from './upload.ts';
import { countEmbeddings, rankChunksWithVector } from './vector.ts';

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

const MODEL = 'retrieval-check-q8';
const DIM = 8;
const NOW = '2026-01-01T00:00:00.000Z';
const TARGET_QUERY_TEXT = '目标标记';

const tmpRoot = mkdtempSync(join(tmpdir(), 'knowpilot-retrieval-'));
// 断言中途抛错也要清掉本脚本现建的目录（U3a 的教训：收尾写在最后一行，
// 一出错就不执行）。目录名由 mkdtemp 唯一生成，只删自己建的那个。
process.once('exit', () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // 退出阶段删不掉（Windows 偶尔有短暂占用）不影响断言结果，留给系统临时目录回收。
  }
});
const uploadDir = join(tmpRoot, 'uploads');
mkdirSync(uploadDir, { recursive: true });

const baseCfg = loadConfig();
const cfg = { ...baseCfg, dbPath: ':memory:', uploadDir };
const { db } = openDb(':memory:');

function insertDoc(id: string, material: string, title: string): void {
  db.prepare(
    `INSERT INTO documents (id, material, title, source_path, content_hash, created_at)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(id, material, title, `hash-${id}`, NOW);
}

function insertChunk(
  id: string,
  docId: string,
  ordinal: number,
  text: string,
  opts: { page?: number | null; sectionPath?: readonly string[] } = {},
): void {
  db.prepare(
    `INSERT INTO doc_chunks (id, doc_id, ordinal, text, text_seg, page, token_count, section_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    docId,
    ordinal,
    text,
    segmentForIndex(text),
    opts.page ?? null,
    text.length,
    JSON.stringify(opts.sectionPath ?? []),
  );
}

function insertVector(chunkId: string, vec: readonly number[]): void {
  db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model, dim, vec, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(chunkId, MODEL, DIM, vecToBlob(Float32Array.from(vec)), NOW);
}

// ── 语料：101 条 paper 干扰 + 1 条 rule 目标 + 1 条 rule 无关 ──────────
insertDoc('doc-paper', 'paper', '干扰：精密仪器外借流程');
insertDoc('doc-rule', 'rule', '目标：精密仪器借用管理办法');
insertDoc('doc-rule-other', 'rule', '无关：会议室预约说明');
// 一份**没有向量**的材料：用来验证"材料内缺向量"的提示按材料说，而不是按全库说。
insertDoc('doc-sop', 'sop', '无向量：操作规程');
insertChunk('sop-1', 'doc-sop', 0, '操作规程正文：取样前须核对标签。');

const distractorIds: string[] = [];
for (let i = 0; i < 101; i += 1) {
  const id = `paper-${String(i).padStart(3, '0')}`;
  insertChunk(
    id,
    'doc-paper',
    i,
    `借用精密仪器需要办哪些手续？第 ${i + 1} 节从理论角度讨论这个问题的流程设计。`,
  );
  // 与查询向量完全相同：每条都比"换了说法的目标段"更相近。
  insertVector(id, [1, 0, 0, 0, 0, 0, 0, 0]);
  distractorIds.push(id);
}
insertChunk('rule-target', 'doc-rule', 0, `实验室规定：借用精密仪器须提前申请。${TARGET_QUERY_TEXT}`);
insertVector('rule-target', [0.8, 0.6, 0, 0, 0, 0, 0, 0]);
insertChunk('rule-other', 'doc-rule-other', 0, '会议室预约请提前一天登记。');
insertVector('rule-other', [0, 1, 0, 0, 0, 0, 0, 0]);

const queryVec = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
const ruleScope = new Set(['rule-target', 'rule-other']);

// ── 1. 合成向量：复现"先 TopN 再过滤"的丢目标，再验证范围前置 ──────
console.log('候选范围 · 合成向量（零模型）：101 条干扰下的目标召回');

{
  const globalTop = rankChunksWithVector(db, MODEL, queryVec, 8);
  check('全库 Top8 恰好 8 条', globalTop.length === 8, `实际 ${globalTop.length}`);
  check(
    '全库 Top8 全部是干扰块（复现条件成立）',
    globalTop.every((r) => distractorIds.includes(r.chunkId)),
    globalTop.map((r) => r.chunkId).join('、'),
  );
  check(
    '全库 Top8 不含目标块',
    !globalTop.some((r) => r.chunkId === 'rule-target'),
    globalTop.map((r) => r.chunkId).join('、'),
  );

  // 改造前的算法：先取全库 TopN，再按范围过滤。这一行就是那个"事后过滤"。
  const naiveFiltered = globalTop.filter((r) => ruleScope.has(r.chunkId));
  check('旧算法（先 TopN 后过滤）在 rule 范围下 0 命中', naiveFiltered.length === 0, `实际 ${naiveFiltered.length}`);

  const scopedTop = rankChunksWithVector(db, MODEL, queryVec, 8, ruleScope);
  check('范围前置后目标被召回', scopedTop.some((r) => r.chunkId === 'rule-target'));
  check('范围前置后目标排第一', scopedTop[0]?.chunkId === 'rule-target', scopedTop[0]?.chunkId ?? '（空）');
  check('范围内只返回 2 条（不会把范围外的块混进来）', scopedTop.length === 2, `实际 ${scopedTop.length}`);

  const emptyScope = rankChunksWithVector(db, MODEL, queryVec, 8, new Set<string>());
  check('空范围返回空（不是退回全库）', emptyScope.length === 0, `实际 ${emptyScope.length}`);

  let threw = '';
  try {
    rankChunksWithVector(db, MODEL, Float32Array.from([1, 0, 0]), 8);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check('维度不符仍然报错（没有因改造吞掉自检）', threw.includes('维度'), threw);
}

// ── 2. 计数也按同一范围 ────────────────────────────────────────────
console.log('向量计数：材料内的覆盖率必须按材料数');

{
  check('全局已建向量 = 103', countEmbeddings(db, MODEL) === 103, String(countEmbeddings(db, MODEL)));
  check('rule 范围内已建向量 = 2', countEmbeddings(db, MODEL, 'rule') === 2, String(countEmbeddings(db, MODEL, 'rule')));
  check('paper 范围内已建向量 = 101', countEmbeddings(db, MODEL, 'paper') === 101, String(countEmbeddings(db, MODEL, 'paper')));
  check('sop 范围内已建向量 = 0', countEmbeddings(db, MODEL, 'sop') === 0, String(countEmbeddings(db, MODEL, 'sop')));
}

// ── 3. 关键词路径与降级提示（真实 searchDocuments，零模型）──────────
console.log('检索路径：关键词过滤 + 模型缺失降级');

{
  const keyword = await searchDocuments(db, cfg, {
    query: TARGET_QUERY_TEXT,
    mode: 'keyword',
    limit: 8,
    material: 'rule',
  });
  check('关键词 + rule 过滤命中目标', keyword.hits.some((h) => h.chunkId === 'rule-target'), `命中 ${keyword.hits.length}`);
  check('关键词 + rule 过滤不混入 paper 干扰', keyword.hits.every((h) => h.documentId !== 'doc-paper'));

  const wrongMaterial = await searchDocuments(db, cfg, {
    query: TARGET_QUERY_TEXT,
    mode: 'keyword',
    limit: 8,
    material: 'paper',
  });
  check('关键词 + paper 过滤 0 命中（目标不在该材料）', wrongMaterial.hits.length === 0, `命中 ${wrongMaterial.hits.length}`);

  // 模型文件不存在：语义模式必须降级成关键词，并把"降级了"说出来。
  // 这是 R1 明确要求保留的既有可见行为。
  const fallbackCfg = { ...cfg, embedModelDir: join(tmpRoot, 'missing-model') };
  const fallback = await searchDocuments(db, fallbackCfg, {
    query: TARGET_QUERY_TEXT,
    mode: 'semantic',
    limit: 8,
    material: 'rule',
  });
  check('模型缺失时 mode 回落为 keyword', fallback.mode === 'keyword', fallback.mode);
  check('模型缺失时提示包含「语义检索不可用」', (fallback.notice ?? '').includes('语义检索不可用'), fallback.notice ?? '（无提示）');
  check('模型缺失时仍能返回关键词命中', fallback.hits.some((h) => h.chunkId === 'rule-target'));

  // 模型"就绪"但该材料下一个向量都没有：语义路径应在**不加载模型**的情况下
  // 直接返回"当前材料下没有向量"，而不是说成"库里没有内容"。
  // 用一个空 ONNX 文件骗过 isModelReady；embedded=0 会在推理之前就返回。
  const fakeReadyCfg = {
    ...cfg,
    embedModelId: 'retrieval-check',
    embedDtype: 'q8' as const,
    embedModelDir: join(tmpRoot, 'fake-model'),
  };
  mkdirSync(dirname(onnxPath(fakeReadyCfg)), { recursive: true });
  writeFileSync(onnxPath(fakeReadyCfg), '');
  const noVectors = await searchDocuments(db, fakeReadyCfg, {
    query: '取样',
    mode: 'semantic',
    limit: 8,
    material: 'sop',
  });
  check('材料内无向量时语义返回 0 条', noVectors.hits.length === 0, `命中 ${noVectors.hits.length}`);
  check(
    '材料内无向量时按材料提示（不说成"库里没有"）',
    (noVectors.notice ?? '').includes('当前材料下 1 个检索块都还没有向量'),
    noVectors.notice ?? '（无提示）',
  );
  check(
    '材料内无向量时提示不出现「库里还没有可检索的内容」',
    !(noVectors.notice ?? '').includes('库里还没有可检索的内容'),
    noVectors.notice ?? '（无提示）',
  );
}

// ── 4. 实机段（可选）：真 BGE-M3 走完整入库 + 检索 ─────────────────
console.log('实机复现 · 真 BGE-M3（KNOWPILOT_RETRIEVAL_REAL_MODEL=1 才跑）');

if (process.env['KNOWPILOT_RETRIEVAL_REAL_MODEL'] !== '1') {
  notRun('101 干扰 + 1 目标的端到端召回', '未设 KNOWPILOT_RETRIEVAL_REAL_MODEL=1');
} else if (!isModelReady(baseCfg)) {
  notRun('101 干扰 + 1 目标的端到端召回', '本地 BGE-M3 权重不存在');
} else {
  const live = await runLive();
  check('干扰文档切出 >= 101 块', live.distractorChunks >= 101, String(live.distractorChunks));
  check('目标文档切出 1 块', live.targetChunks === 1, String(live.targetChunks));
  check('不加材料过滤时，目标不在全局前 8（复现条件成立）', !live.targetInGlobalTop, live.globalHits.map((h) => h.chunkId).join('、'));
  check('加 rule 过滤时，语义检索召回目标', live.targetInSemanticFiltered, `命中 ${live.semanticFiltered.length}`);
  check('加 rule 过滤时，混合检索召回目标', live.targetInHybridFiltered, `命中 ${live.hybridFiltered.length}`);
}

async function runLive(): Promise<{
  distractorChunks: number;
  targetChunks: number;
  globalHits: { chunkId: string }[];
  targetInGlobalTop: boolean;
  semanticFiltered: { chunkId: string }[];
  targetInSemanticFiltered: boolean;
  hybridFiltered: { chunkId: string }[];
  targetInHybridFiltered: boolean;
}> {
  const { db: liveDb } = openDb(':memory:');
  const targetBody = [
    '# 精密仪器借用管理办法',
    '',
    '实验室的精密仪器外借时，借用人需要提前在共享平台上填写申请，写明用途与归还日期，并由导师确认。',
  ].join('\n');
  const sections: string[] = ['# 精密仪器外借流程的理论分析（干扰语料）', ''];
  for (let i = 1; i <= 101; i += 1) {
    sections.push(`## 第 ${i} 节 外借手续的理论讨论`, '');
    // 逐条复述问题原句，让干扰块在语义上比"换了说法的目标段"更贴近查询。
    sections.push(
      `借用精密仪器需要办哪些手续？本节从理论角度讨论这个问题：借用人提出申请、说明用途与归还日期、` +
        `由导师确认，再在平台上完成登记。第 ${i} 节强调流程设计与制度约束，不给出实验室的实际办理口径。`,
    );
    sections.push('');
  }

  const seed = async (material: string, title: string, body: string): Promise<{ docId: string; chunks: number }> => {
    const file = new File([body], `${title}.md`, { type: 'text/markdown' });
    const up = await uploadDocument(liveDb, cfg, {
      file,
      material,
      title,
      uploadedBy: null,
      consentConfirmedBy: null,
    });
    await ingestDocument(liveDb, cfg, up.documentId);
    const row = liveDb
      .prepare('SELECT COUNT(*) AS n FROM doc_chunks WHERE doc_id = ?')
      .get(up.documentId) as unknown as { n: number };
    return { docId: up.documentId, chunks: row.n };
  };

  const target = await seed('rule', '目标-精密仪器借用管理办法', targetBody);
  const distractors = await seed('paper', '干扰-外借流程理论分析', sections.join('\n'));
  const query = '借用精密仪器需要办哪些手续？';

  const global = await searchDocuments(liveDb, cfg, { query, mode: 'semantic', limit: 8 });
  const semanticFiltered = await searchDocuments(liveDb, cfg, {
    query,
    mode: 'semantic',
    limit: 8,
    material: 'rule',
  });
  const hybridFiltered = await searchDocuments(liveDb, cfg, {
    query,
    mode: 'hybrid',
    limit: 8,
    material: 'rule',
  });

  return {
    distractorChunks: distractors.chunks,
    targetChunks: target.chunks,
    globalHits: global.hits.map((h) => ({ chunkId: h.chunkId })),
    targetInGlobalTop: global.hits.some((h) => h.documentId === target.docId),
    semanticFiltered: semanticFiltered.hits.map((h) => ({ chunkId: h.chunkId })),
    targetInSemanticFiltered: semanticFiltered.hits.some((h) => h.documentId === target.docId),
    hybridFiltered: hybridFiltered.hits.map((h) => ({ chunkId: h.chunkId })),
    targetInHybridFiltered: hybridFiltered.hits.some((h) => h.documentId === target.docId),
  };
}

// ── O1 邻近上下文：只取同页/同章节的紧邻块 ────────────────────────
console.log('\nO1 邻近上下文（同页 / 同章节）');

insertDoc('doc-neighbor', 'rule', '邻近块测试：同章节');
insertChunk('nb-0', 'doc-neighbor', 0, '第一节第一段：背景说明。', { sectionPath: ['1 背景'] });
insertChunk('nb-1', 'doc-neighbor', 1, '第一节第二段：命中块。', { sectionPath: ['1 背景'] });
insertChunk('nb-2', 'doc-neighbor', 2, '第二节第一段：换了章节。', { sectionPath: ['2 方法'] });
insertChunk('nb-3', 'doc-neighbor', 3, '第二节第二段：同章节的下一块。', { sectionPath: ['2 方法'] });

const sameSectionNeighbors = loadNeighborChunks(db, [
  { chunkId: 'nb-1', documentId: 'doc-neighbor' },
  { chunkId: 'nb-2', documentId: 'doc-neighbor' },
]);
const nb1 = sameSectionNeighbors.get('nb-1') ?? [];
const nb2 = sameSectionNeighbors.get('nb-2') ?? [];
check('同章节前一块被取到', nb1.some((c) => c.chunkId === 'nb-0' && c.relation === 'previous'));
check('跨章节的紧邻块不被取到', !nb1.some((c) => c.chunkId === 'nb-2'));
check('上下文不重复收录命中块本身', !nb2.some((c) => c.chunkId === 'nb-1'));
check('同章节后一块被取到', nb2.some((c) => c.chunkId === 'nb-3' && c.relation === 'next'));

insertDoc('doc-page', 'rule', '邻近块测试：同页');
insertChunk('pg-0', 'doc-page', 0, '第 7 页第一段。', { page: 7, sectionPath: ['A'] });
insertChunk('pg-1', 'doc-page', 1, '第 7 页第二段。', { page: 7, sectionPath: ['B'] });
insertChunk('pg-2', 'doc-page', 2, '第 8 页第一段。', { page: 8, sectionPath: ['C'] });
const pageNeighbors = loadNeighborChunks(db, [{ chunkId: 'pg-1', documentId: 'doc-page' }]);
const pg1 = pageNeighbors.get('pg-1') ?? [];
check('同页但不同章节不作为上下文', !pg1.some((c) => c.chunkId === 'pg-0'));
check('跨页块不作为上下文', !pg1.some((c) => c.chunkId === 'pg-2'));

insertDoc('doc-page-only', 'rule', '邻近块测试：无章节页');
insertChunk('po-0', 'doc-page-only', 0, '同页无标题第一段。', { page: 7 });
insertChunk('po-1', 'doc-page-only', 1, '同页无标题第二段。', { page: 7 });
const pageOnly = loadNeighborChunks(db, [{ chunkId: 'po-1', documentId: 'doc-page-only' }]);
check('无章节信息时同页可补上下文', (pageOnly.get('po-1') ?? []).some((c) => c.chunkId === 'po-0'));

insertDoc('doc-none', 'rule', '邻近块测试：不同页不同章节');
insertChunk('nn-0', 'doc-none', 0, '第一页。', { page: 1, sectionPath: ['A'] });
insertChunk('nn-1', 'doc-none', 1, '第二页。', { page: 2, sectionPath: ['B'] });
const noneNeighbors = loadNeighborChunks(db, [{ chunkId: 'nn-1', documentId: 'doc-none' }]);
check('既不同页也不同章节 → 不附上下文', (noneNeighbors.get('nn-1') ?? []).length === 0);
check('空命中不产生上下文', loadNeighborChunks(db, []).size === 0);

// 走一遍真实的 retrieve 工具：上下文必须出现在 tool 结果里，但**不能**进证据池。
const pool = new EvidencePool();
const retrieve = createRetrieveTool({ db, config: cfg, pool });
const toolResult = await retrieve.execute('neighbor-check', {
  query: '命中块',
  mode: 'keyword',
  limit: 8,
});
const toolDetails = toolResult.details as RetrieveDetails;
const evidenceChunkIds = toolDetails.evidenceIds
  .map((id) => pool.get(id))
  .filter((ev): ev is NonNullable<typeof ev> => ev !== undefined)
  .map((ev) => (ev.kind === 'document' ? ev.chunkId : ''));
check('retrieve 命中了测试块', evidenceChunkIds.includes('nb-1'));
check('同章节前一块作为上下文附带', toolDetails.contextChunkIds?.includes('nb-0') === true);
check('上下文块不在证据池里', !evidenceChunkIds.includes('nb-0'));
const toolText = toolResult.content[0]?.type === 'text' ? toolResult.content[0].text : '';
const contextStart = toolText.indexOf('<context');
const contextEnd = toolText.indexOf('</context>');
const contextBlock =
  contextStart >= 0 && contextEnd > contextStart
    ? toolText.slice(contextStart, contextEnd + '</context>'.length)
    : '';
check('上下文块渲染为 context 标签', contextBlock !== '');
check('上下文标签自身没有证据号', contextBlock !== '' && !contextBlock.includes('id="E'));

// ── 收尾 ──────────────────────────────────────────────────────────
// 临时目录由上面的 process.once('exit') 清理。
console.log('');
if (failed > 0) {
  console.error(`${failed} 项断言失败（通过 ${passed} 项）。`);
  process.exitCode = 1;
} else {
  console.log(`检索候选范围断言全部通过（${passed} 项）。`);
}
