/**
 * 引用校验的断言脚本：`npm run verify-citations -w @knowpilot/server`
 *
 * 【为什么这一份必须是纯函数测试，不能"跑一次真实问答看看"】
 *   引用校验要拦的是**模型偶发编造出处**。用真实问答去测，等于守着它哪天碰巧出错 ——
 *   平时全绿，出事时已经晚了。这里用手造的证据池直接构造出错的输入，
 *   把两类失败（编造引用、无引用却不下结论）钉死在断言里。不花一分钱模型费。
 */
import { extractEvidenceIds, removeEvidenceMarkers } from '@knowpilot/shared';
import { extractEvidenceGapLine, findQuoteIssues, verifyAnswer } from './citations.ts';
import type { Evidence } from './evidence.ts';

function fake(id: string, chunkId: string): Evidence {
  return {
    kind: 'document',
    id,
    chunkId,
    documentId: `doc-${chunkId}`,
    documentTitle: '测试文档.pdf',
    material: 'rule',
    page: 1,
    sectionPath: ['一、总则'],
    text: '这是测试用的原文。',
    originalChars: '这是测试用的原文。'.length,
    sourceVersion: '1',
    score: 0.5,
  };
}

let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${name}${detail === '' ? '' : ` —— ${detail}`}`);
}

const pool = new Map<string, Evidence>([
  ['E1', fake('E1', 'chunk-1')],
  ['E2', fake('E2', 'chunk-2')],
]);

console.log('引用校验');

{
  const r = verifyAnswer('学位授予由学位评定委员会审定 [E1]。', pool);
  const first = r.citations[0];
  check('正文引用有效证据 → 保留', r.citations.length === 1 && first?.id === 'E1');
  check('正文引用有效证据 → 无警告', r.warnings.length === 0);
  check('文档引用标记为 document 类型', first?.sourceType === 'document');
  check('引用带回原文块 id', first?.sourceType === 'document' && first.chunkId === 'chunk-1');
  check(
    '页码与章节由服务端回填',
    first?.sourceType === 'document' && first.page === 1 && first.sectionPath[0] === '一、总则',
  );
}

{
  // 幻觉引用：模型编了一个没返回过的编号
  const r = verifyAnswer('查重率博士低于 10% [E1]，硕士低于 15% [E9]。', pool);
  check('编造的引用被剔除', !r.answer.includes('[E9]'), r.answer);
  check('有效引用仍保留', r.answer.includes('[E1]') && r.citations.length === 1);
  check('编造引用产生警告', r.warnings.some((w) => w.includes('[E9]')));
  check('编造引用不进入引用列表', r.citations.every((c) => c.id !== 'E9'));
}

{
  // GC-08 失败形态：没有引用，却也不承认没有依据
  const r = verifyAnswer('实验室差旅报销上限为每人每次 2000 元。', pool);
  check('无引用且不承认缺依据 → 警告', r.warnings.some((w) => w.includes('未找到依据')));
  check('无引用 → 引用列表为空', r.citations.length === 0);
}

{
  // GC-08 正确形态
  const r = verifyAnswer('未找到依据。库中没有关于差旅报销的规定。', pool);
  check('无引用但写明「未找到依据」→ 不告警', r.warnings.length === 0);
}

{
  // 部分有依据：有依据的引用，缺的部分写进缺口，都不告警
  const r = verifyAnswer('学位授予由学位评定委员会审定 [E1]。报销标准未找到依据。', pool);
  check('部分有依据 → 不告警', r.warnings.length === 0);
  check('部分有依据 → 引用只含有效项', r.citations.length === 1);
}

{
  // 实时记录引用：与文档引用共用同一串编号，但组装出来的引用**没有** chunkId /
  // 页码，而是带上查询时点与结构化字段。混在一份回答里也必须各自正确。
  const live: Evidence = {
    kind: 'record',
    id: 'E3',
    recordType: 'M-SUBMIT',
    recordId: 'sub-1',
    recordTitle: '示例论文',
    queryTime: '2026-10-11T04:00:00.000Z',
    recordUpdatedAt: '2026-10-01T00:00:00.000Z',
    fields: [{ label: '状态', value: '外审' }],
    originalChars: '状态：外审'.length,
    sourceVersion: '2026-10-01T00:00:00.000Z',
  };
  const mixed = new Map<string, Evidence>([
    ['E1', fake('E1', 'chunk-1')],
    ['E3', live],
  ]);
  const r = verifyAnswer('该稿目前在外审 [E3]。另外制度里有规定 [E1]。', mixed);

  const rec = r.citations.find((c) => c.id === 'E3');
  check('台账引用组装为 record 类型', rec?.sourceType === 'record');
  if (rec?.sourceType === 'record') {
    check('台账引用带查询时点', rec.queryTime === '2026-10-11T04:00:00.000Z');
    check('台账引用的字段来自服务端', rec.fields[0]?.value === '外审');
    check('台账引用的摘录就是字段文本', rec.excerpt === '状态：外审');
    check('台账引用不带版本时 version 不出现', rec.version === undefined);
    check(
      '台账引用保留原文长度与来源版本',
      rec.originalChars === '状态：外审'.length && rec.sourceVersion === '2026-10-01T00:00:00.000Z',
      `${rec.originalChars}/${rec.sourceVersion}`,
    );
  }
  const docCite = r.citations.find((c) => c.id === 'E1');
  check('文档引用仍组装为 document 类型', docCite?.sourceType === 'document');
  check(
    '文档引用保留原文长度与来源版本（C1/X2a）',
    docCite?.originalChars === '这是测试用的原文。'.length && docCite?.sourceVersion === '1',
    `${docCite?.originalChars}/${docCite?.sourceVersion}`,
  );
  check('两类引用混在一份回答里不产生警告', r.warnings.length === 0);
  check('引用顺序仍按正文首次出现', r.citations.map((c) => c.id).join(',') === 'E3,E1');
}

console.log('引用片段校验（O2）');
{
  const answer = '第一条 [E1]，第二条 [E2]。';
  const issues = findQuoteIssues(answer, pool, [{ evidenceId: 'E1', quote: '这是测试用的原文。' }]);
  check('提交前只指出缺摘录的 E2', issues.length === 1 && issues[0]?.evidenceId === 'E2' && issues[0].reason === 'missing');
  const mismatch = findQuoteIssues(answer, pool, [
    { evidenceId: 'E1', quote: '这是测试用的原文。' },
    { evidenceId: 'E2', quote: '并不存在于原文的摘录。' },
  ]);
  check('提交前区分摘录不符', mismatch.length === 1 && mismatch[0]?.reason === 'mismatch');
  check('提交前有效摘录全部通过', findQuoteIssues(answer, pool, [
    { evidenceId: 'E1', quote: '这是测试用的原文。' },
    { evidenceId: 'E2', quote: '这是测试用的原文。' },
  ]).length === 0);
}
{
  // 摘录逐字命中 → 引用保留，并且客户端能拿到那段已核对的摘录。
  const r = verifyAnswer('这是测试用的原文 [E1]。', pool, {
    quotes: [{ evidenceId: 'E1', quote: '这是测试用的原文。' }],
    requireQuotes: true,
  });
  const cite = r.citations[0];
  check('摘录逐字命中 → 引用保留', r.citations.length === 1 && cite?.id === 'E1');
  check('摘录逐字命中 → 无警告', r.warnings.length === 0, JSON.stringify(r.warnings));
  check('摘录计数为 1/1', r.quoteChecks.checked === 1 && r.quoteChecks.passed === 1 && r.quoteChecks.failed === 0);
  check('文档引用带回已核对的摘录', cite?.sourceType === 'document' && cite.quote === '这是测试用的原文。');
}

{
  // 空白差异容忍：换行/缩进不该判成"改字"。
  const r = verifyAnswer('这是测试用的原文 [E1]。', pool, {
    quotes: [{ evidenceId: 'E1', quote: '这是测试用\n  的原文。' }],
    requireQuotes: true,
  });
  check('摘录只差空白 → 仍通过', r.citations.length === 1 && r.quoteChecks.passed === 1);
}

{
  // 验收要求的核心负例：编号对、摘录错。
  const r = verifyAnswer('这是测试用的伪原文 [E1]。', pool, {
    quotes: [{ evidenceId: 'E1', quote: '这是测试用的伪原文。' }],
    requireQuotes: true,
  });
  check('编号对、摘录错 → 引用被剔除', r.citations.length === 0);
  check('编号对、摘录错 → 正文标记也被剔除', !r.answer.includes('[E1]'), r.answer);
  check('编号对、摘录错 → 告警说明摘录与原文不符', r.warnings.some((w) => w.includes('摘录与原文不符')));
  check('编号对、摘录错 → 计数为 0/1', r.quoteChecks.checked === 1 && r.quoteChecks.passed === 0 && r.quoteChecks.failed === 1);
}

{
  // 缺摘录与过短摘录都按"没有可核对摘录"处理。
  const missing = verifyAnswer('这是测试用的原文 [E1]。', pool, { requireQuotes: true });
  check('缺摘录 → 引用被剔除', missing.citations.length === 0);
  check('缺摘录 → 告警说明没有提供摘录', missing.warnings.some((w) => w.includes('没有提供可核对的摘录')));

  const short = verifyAnswer('这是测试用的原文 [E1]。', pool, {
    quotes: [{ evidenceId: 'E1', quote: '原文。' }],
    requireQuotes: true,
  });
  check('过短摘录 → 不当作通过', short.citations.length === 0 && short.quoteChecks.failed === 1);
}

{
  // 多条引用只坏一条：好的保留、坏的剔除，不能一票否决整份回答。
  const r = verifyAnswer('甲 [E1]，乙 [E2]。', pool, {
    quotes: [
      { evidenceId: 'E1', quote: '这是测试用的原文。' },
      { evidenceId: 'E2', quote: '这是测试用的假原文。' },
    ],
    requireQuotes: true,
  });
  check('多条引用逐条判 → 只保留通过的那条', r.citations.length === 1 && r.citations[0]?.id === 'E1');
  check('多条引用逐条判 → 计数 1/2', r.quoteChecks.checked === 2 && r.quoteChecks.passed === 1 && r.quoteChecks.failed === 1);
}

{
  // 台账记录不要求摘录：内容由服务端填充，只核对编号。
  const record: Evidence = {
    kind: 'record',
    id: 'E4',
    recordType: 'M-SUBMIT',
    recordId: 'sub-2',
    recordTitle: '示例论文二',
    queryTime: '2026-10-18T00:00:00.000Z',
    recordUpdatedAt: null,
    fields: [{ label: '状态', value: '外审' }],
    originalChars: '状态：外审'.length,
    sourceVersion: '2026-10-18T00:00:00.000Z',
  };
  const r = verifyAnswer('该稿在外审 [E4]。', new Map([['E4', record]]), { requireQuotes: true });
  check('记录引用不需要摘录 → 保留', r.citations.length === 1 && r.citations[0]?.id === 'E4');
  check('记录引用不进入片段校验计数', r.quoteChecks.checked === 0 && r.warnings.length === 0);
}

{
  // 不要求校验时（回落路径）不误伤任何引用。
  const r = verifyAnswer('这是测试用的原文 [E1]。', pool, {
    quotes: [{ evidenceId: 'E1', quote: '完全不对的摘录内容。' }],
  });
  check('未要求校验 → 不按摘录剔除', r.citations.length === 1 && r.quoteChecks.checked === 0);
}

console.log('证据标记解析');
{
  check('按首次出现顺序去重', JSON.stringify(extractEvidenceIds('a[E3] b[E1] c[E3]')) === '["E3","E1"]');
  check('不认小写 e', extractEvidenceIds('[e1]').length === 0);
  const del = removeEvidenceMarkers('甲[E1]乙[E9]丙', new Set(['E9']));
  check('只删指定编号', del.text === '甲[E1]乙丙' && del.removed[0] === 'E9');
}

console.log('依据缺口行提取（回落路径）');
{
  const r = extractEvidenceGapLine('正文内容。\n依据缺口：缺 A\n依据缺口：无');
  check('抽出缺口并在正文中移除该行', r.gaps.length === 1 && r.gaps[0] === '缺 A', JSON.stringify(r.gaps));
  check('「无」不当作一条缺口', r.gaps.length === 1);
  check('正文不残留标记行', !r.text.includes('依据缺口'));
}

console.log('');
if (failed > 0) {
  console.error(`${failed} 项断言失败。`);
  process.exitCode = 1;
} else {
  console.log('引用校验全部通过。');
}
