/** Zero-model regression for semantic boundaries and multi-term keyword recall. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMatchQuery, INDEX_VERSION, segmentForIndex } from '@knowpilot/shared';
import { embeddingModelKey, loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { chunkDocument } from './chunk.ts';
import { extractDocument, type ParsedBlock } from './extract.ts';
import { ingestDocument } from './ingest.ts';
import { rankingText } from './ranking-text.ts';
import { getChunkContext } from './repo.ts';
import { searchDocuments } from './search.ts';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`);
  if (ok) passed += 1;
  else failed += 1;
}
function body(text: string, sectionPath: string[] = [], page: number | null = null): ParsedBlock {
  return { text, sectionPath, page, kind: 'body', level: null };
}
function heading(text: string, page: number | null = null): ParsedBlock {
  return { text, sectionPath: [], page, kind: 'heading', level: 1 };
}

const sections = chunkDocument([
  heading('第一章 采集'),
  body('样品采集前核对标签。', ['第一章 采集']),
  heading('第二章 保存'),
  body('样品保存时保持低温。', ['第二章 保存']),
]);
check('短章节不跨节合并', sections.length === 2);
check('章节路径与正文对应', sections[0]?.sectionPath.join('/') === '第一章 采集' && sections[1]?.sectionPath.join('/') === '第二章 保存');
check('标题与本节短正文一起可检索', sections[0]?.text.includes('样品采集前') === true);

const sentences = Array.from({ length: 40 }, (_, i) => `第${i + 1}项处理步骤应核对来源并保存记录。`);
const long = chunkDocument([body(sentences.join(''))]);
check('长段落切成多块', long.length > 1);
check('句子不在块边界截断', sentences.every((sentence) => long.some((chunk) => chunk.text.includes(sentence))));
check('长段落没有空块', long.every((chunk) => chunk.text.trim() !== ''));
const englishSentences = Array.from({ length: 45 }, (_, i) => `Step ${i + 1} validates the source and keeps the record.`);
const english = chunkDocument([body(englishSentences.join(' '))]);
check('英文句子不在块边界截断且保留空格', englishSentences.every((sentence) => english.some((chunk) => chunk.text.includes(sentence))));
const noPunctuation = chunkDocument([body('仪'.repeat(1250))]);
check('无标点超长句有上限且不产生空块', noPunctuation.length === 3 && noPunctuation.every((chunk) => chunk.text.length > 0 && chunk.text.length <= 600));
const pages = chunkDocument([body('第一页。', [], 1), body('第二页。', [], 2)]);
check('不同页仍严格隔离', pages.length === 2 && pages[0]?.page === 1 && pages[1]?.page === 2);
const indexed = rankingText('样品操作规程', ['准备', '低温保存'], '温度保持在 4 摄氏度。');
check('向量输入含文档与章节语境', indexed.startsWith('样品操作规程 › 准备 › 低温保存\n'));
check('向量输入保留可逐字引用的正文', indexed.endsWith('温度保持在 4 摄氏度。'));

const { db } = openDb(':memory:');
const now = '2026-10-24T00:00:00.000Z';
function add(id: string, material: string, text: string): void {
  db.prepare('INSERT INTO documents (id, material, title, content_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(`doc-${id}`, material, `演示 ${id}`, `hash-${id}`, now);
  db.prepare('INSERT INTO doc_chunks (id, doc_id, ordinal, text, text_seg, token_count) VALUES (?, ?, 0, ?, ?, ?)')
    .run(id, `doc-${id}`, text, segmentForIndex(text), text.length);
}
add('target', 'rule', '借用精密仪器，须提前填写申请单并经负责人批准。');
add('generic', 'rule', '本方法介绍常规统计步骤。');
add('other-material', 'paper', '精密仪器的理论分析不涉及借用申请。');
const cfg = { ...loadConfig(), embedModelDir: '__model_absent_for_quality_check__' };
const query = '精密仪器借用申请方法是什么';
const oldExactCount = db.prepare('SELECT COUNT(*) AS n FROM doc_chunks_fts WHERE doc_chunks_fts MATCH ?')
  .get(buildMatchQuery(query)) as { n: number };
check('旧整句短语在词序变化时零命中（复现）', oldExactCount.n === 0);
const result = await searchDocuments(db, cfg, { query, mode: 'keyword', limit: 8, material: 'rule' });
check('词序变化时能召回目标', result.hits[0]?.chunkId === 'target');
check('只含一个宽泛词的结果不补入', !result.hits.some((hit) => hit.chunkId === 'generic'));
check('材料范围过滤在候选阶段生效', result.hits.every((hit) => hit.material === 'rule'));
const exact = await searchDocuments(db, cfg, { query: '精密仪器', mode: 'keyword', limit: 8 });
check('短语精确查询仍可用', exact.hits.some((hit) => hit.chunkId === 'target'));
const escaped = await searchDocuments(db, cfg, { query: '精密仪器" OR *', mode: 'keyword', limit: 8 });
check('特殊字符不会破坏 FTS 查询', Array.isArray(escaped.hits));
add('named-paper', 'paper', '该方法采用了对照实验并分析结果。');
db.prepare('UPDATE documents SET title = ? WHERE id = ?').run('南京大学学报', 'doc-named-paper');
add('title-distractor', 'rule', '南京大学学报介绍了其它研究方法。');
const named = await searchDocuments(db, cfg, {
  query: '南京大学学报用了什么方法', mode: 'keyword', limit: 8,
});
check('明确提到文档名时标题相关块排在正文提及块前', named.hits[0]?.chunkId === 'named-paper');
add('marker-distractor', 'knowledge', '这是一条含有草案专用标记的对照资料。');
const marker = await searchDocuments(db, cfg, {
  query: '待确认草案专用标记丁戊己', mode: 'keyword', limit: 8,
});
check('完整标记词不被宽松词匹配误报', marker.hits.length === 0);

const tempRoot = mkdtempSync(join(tmpdir(), 'knowpilot-reindex-quality-'));
try {
  const file = join(tempRoot, 'fixture.md');
  writeFileSync(file, '## 2.1 数据集\n样本来自甲。\n## 2.5 结果\n准确率见表。', 'utf8');
  const sibling = await extractDocument(file);
  const resultBody = sibling.blocks.find((block) => block.text === '准确率见表。');
  check('缺一级标题时同级二级标题不误嵌套', resultBody?.sectionPath.join('/') === '2.5 结果');
  writeFileSync(file, '# 总则\n### 跳级标题\n第一段。\n### 并列标题\n第二段。', 'utf8');
  const skipped = await extractDocument(file);
  const siblingBody = skipped.blocks.find((block) => block.text === '第二段。');
  check('跳级标题后同级标题保持并列', siblingBody?.sectionPath.join('/') === '总则/并列标题');
  const first = '# 采集\n采样前核对标签。\n\n# 保存\n样品应在低温条件下保存。';
  writeFileSync(file, first, 'utf8');
  db.prepare('INSERT INTO documents (id, material, title, source_path, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('doc-reindex', 'sop', '样品操作规程', file, 'hash-reindex', now);
  await ingestDocument(db, cfg, 'doc-reindex');
  const ids = (): { id: string; text: string }[] => db.prepare(
    'SELECT id, text FROM doc_chunks WHERE doc_id = ? ORDER BY ordinal',
  ).all('doc-reindex') as { id: string; text: string }[];
  const before = ids();
  await ingestDocument(db, cfg, 'doc-reindex');
  const same = ids();
  check('同一原件重建保持块 id', before.length === same.length && before.every((row, i) => row.id === same[i]?.id));
  writeFileSync(file, first.replace('低温条件下', '恒定低温环境中'), 'utf8');
  await ingestDocument(db, cfg, 'doc-reindex');
  const changed = ids();
  check('修改一节后未变章节沿用 id', before[0]?.id === changed[0]?.id);
  check('修改一节后变动章节换 id', before[1]?.id !== changed[1]?.id);
  const archived = before[1] === undefined ? null : getChunkContext(db, before[1].id);
  check('旧引用仍可读取历史原文并标明版本',
    archived?.archivedIndexVersion === INDEX_VERSION && archived.chunk.text.includes('低温条件下'));
  const oldSearch = await searchDocuments(db, cfg, { query: '低温条件下', mode: 'keyword', limit: 8 });
  check('历史原文不混入当前检索', !oldSearch.hits.some((hit) => hit.chunkId === before[1]?.id));
  db.prepare('INSERT INTO chunk_embeddings (chunk_id, model, dim, vec, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(changed[0]!.id, embeddingModelKey(cfg), 1, Buffer.alloc(4), now);
  let refused = false;
  try {
    await ingestDocument(db, cfg, 'doc-reindex');
  } catch {
    refused = true;
  }
  check('模型不可用时不覆盖已有向量索引', refused && ids().every((row, i) => row.id === changed[i]?.id));
  db.prepare('DELETE FROM documents WHERE id = ?').run('doc-reindex');
  check('撤下文档时历史片段同步删除',
    before[1] !== undefined && getChunkContext(db, before[1].id) === null);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
db.close();

console.log(`\n检索质量回归：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exitCode = 1;
