/** Offline end-to-end regressions: real runAsk/tools/verification, scripted cloud transport. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type Context, type JsonObject, type MutableModels } from '@earendil-works/pi-ai';
import { segmentForIndex } from '@knowpilot/shared';
import { openDb } from '../db/index.ts';
import { loadConfig } from '../config.ts';
import { runAsk, type AskFinalization, type AskRunEvent } from './ask-run.ts';
import { createLabModels } from './models.ts';
import { routeTask } from './task-router.ts';
import { shouldPrefetchDocuments } from './latency-policy.ts';
import { READ_PAPER_TOOL, RETRIEVE_TOOL, REPAIR_QUOTES_TOOL, SUBMIT_ANSWER_TOOL } from './tools.ts';

let passed = 0;
function check(label: string, fn: () => void) { fn(); passed++; console.log(`✓ ${label}`); }
const question = '样品处理规程中的离心条件是什么？';
const source = '样品离心条件为3000转每分钟，持续10分钟。';
const body = `${source.replace(/。$/u, '')}[E1]。`;
const args = (quotes: JsonObject[] = [{ evidence_id: 'E1', quote: source }]): JsonObject => ({ answer: body, quotes, evidence_gaps: [], limits: ['仅依据样品处理规程。'], confidence_notes: [], conflicts: [] });
type Spec = { tool: string; args: JsonObject; wait?: number; hang?: boolean };
type Strategy = (turn: number, context: Context) => Spec;

async function scenario(strategy: Strategy, budget = {}, signal?: AbortSignal, extraEvidence = false) {
  const { db } = openDb(':memory:');
  db.prepare('INSERT INTO documents(id,title,material,content_hash,created_at) VALUES(?,?,?,?,?)').run('doc', '样品处理规程', 'method', 'hash', '2026-01-01');
  db.prepare('INSERT INTO doc_chunks(id,doc_id,ordinal,text,text_seg,page,section_path,token_count) VALUES(?,?,?,?,?,?,?,?)').run('chunk', 'doc', 0, source, segmentForIndex(source), 1, '["离心条件"]', source.length);
  if (extraEvidence) {
    const second = source + '离心后的上清液应立即转移至新容器。';
    db.prepare('INSERT INTO doc_chunks(id,doc_id,ordinal,text,text_seg,page,section_path,token_count) VALUES(?,?,?,?,?,?,?,?)').run('chunk-2', 'doc', 1, second, segmentForIndex(second), 2, '["离心条件"]', second.length);
  }
  const config = { ...loadConfig(), deepseekApiKey: 'fake-latency-key', embedModelDir: '__latency_check_no_model__', rerankEnabled: false };
  const models = createLabModels();
  let turns = 0;
  const events: AskRunEvent[] = [];
  const finalizations: AskFinalization[] = [];
  const target = models as MutableModels;
  target.streamSimple = (model, context, options) => {
    const spec = strategy(turns++, context);
    const stream = createAssistantMessageEventStream();
    const msg: AssistantMessage = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'toolCall', id: `call-${turns}`, name: spec.tool, arguments: spec.args }],
      usage: { input: 40, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse', timestamp: Date.now(),
    };
    void (async () => {
      if (spec.hang) {
        const end = () => stream.push({ type: 'error', reason: 'aborted', error: { ...msg, stopReason: 'aborted' } });
        if (options?.signal?.aborted) end();
        else options?.signal?.addEventListener('abort', end, { once: true });
        return;
      }
      await delay(spec.wait ?? 12);
      stream.push({ type: 'start', partial: { ...msg, content: [] } });
      await delay(18);
      stream.push({ type: 'done', reason: 'toolUse', message: msg });
    })();
    return stream;
  };
  try {
    const response = await runAsk({ db, config, models }, { question, consentConfirmed: true, user: null, budget }, {
      onEvent: (event) => events.push(event), onFinalize: (entry) => finalizations.push(entry), ...(signal === undefined ? {} : { signal }),
    });
    const usageRows = db.prepare('SELECT duration_ms FROM usage_events ORDER BY created_at,event_id').all() as { duration_ms: number }[];
    return { response, events, f: finalizations[0]!, turns, usageRows, error: undefined };
  } catch (error) {
    return { response: undefined, events, f: finalizations[0]!, turns, usageRows: [], error };
  } finally { db.close(); }
}

for (const q of ['硕士毕业要求是什么？', question, 'DeepLab论文采用了什么方法？']) {
  check(`文档首问提前检索：${q}`, () => assert(shouldPrefetchDocuments(q, routeTask(q), false, false)));
}
for (const q of ['论文甲与论文乙的差别？', '目前投稿状态如何？', '这个论文的方法呢？', '其他论文的方法是什么？', '期刊JCR分区是多少？', '数据集路径在哪里？', '用户用量是多少？', '明天天气如何？']) {
  check(`保留 Agent 路径：${q}`, () => assert(!shouldPrefetchDocuments(q, routeTask(q), false, false)));
}
check('追问不预检索', () => assert(!shouldPrefetchDocuments(question, 'simple', true, false)));
check('续跑不预检索', () => assert(!shouldPrefetchDocuments(question, 'simple', false, true)));

let r = await scenario((turn, context) => {
  assert.equal(turn, 0);
  assert(JSON.stringify(context.messages).includes('<evidence id=\\"E1\\"'));
  assert(getCurrentTools(context.messages).some((tool) => tool.name === RETRIEVE_TOOL));
  assert(!getCurrentTools(context.messages).some((tool) => tool.name === REPAIR_QUOTES_TOOL));
  return { tool: SUBMIT_ANSWER_TOOL, args: args() };
});
check('先取证再一次生成完成，有可核对引用', () => { assert.ifError(r.error); assert.equal(r.turns, 1); assert.equal(r.response?.answer.citations.length, 1); assert.equal(r.response.delivery.status, 'verified'); assert.equal(r.f.budget.used.queryCalls, 1); });
check('提前检索纳入 Trace、预算及证据', () => { assert.equal(r.f.toolTrace?.[0]?.name, RETRIEVE_TOOL); assert.equal(r.f.evidenceCount, 1); assert(r.f.contextChars > 0 && r.f.contextChars <= 8000); });
check('模型计时从请求起算，排除工具结束时刻覆盖', () => { assert.equal(r.usageRows.length, 1); assert(r.usageRows[0]!.duration_ms >= 28); assert((r.f.modelTimings?.[0]?.firstResponseMs ?? 0) >= 10); });
check('检索、生成、核验都有明确结束耗时', () => { for (const phase of ['retrieval', 'generation', 'verification']) { const start = r.events.find((e) => e.type === 'status' && e.phase === phase); assert(start?.type === 'status'); assert(r.events.some((e) => e.type === 'status' && e.stepId === start.stepId && e.state === 'end' && e.durationMs !== undefined)); } });

r = await scenario((turn, context) => {
  if (turn === 0) return { tool: SUBMIT_ANSWER_TOOL, args: args([]) };
  assert.equal(turn, 1);
  assert.deepEqual(getCurrentTools(context.messages).map((tool) => tool.name), [REPAIR_QUOTES_TOOL]);
  return { tool: REPAIR_QUOTES_TOOL, args: { quotes: [{ evidence_id: 'E1', quote: source }], answer: '不应采用的新正文' } };
});
check('补正只需要第二次短调用，正文和限制由服务端保留', () => { assert.ifError(r.error); assert.equal(r.turns, 2); assert.equal(r.response?.answer.answer, body); assert.equal(r.response.answer.citations.length, 1); assert.deepEqual(r.response.answer.limits, ['仅依据样品处理规程。']); });
check('引用补正不清空草稿，且有独立阶段', () => { assert(!r.events.some((e) => e.type === 'draft_reset')); assert(r.events.some((e) => e.type === 'status' && e.phase === 'quote_repair')); assert.equal(r.f.budget.used.queryCalls, 1); assert.equal(r.f.modelTimings?.[1]?.phase, 'quote_repair'); });

r = await scenario((turn) => turn === 0
  ? { tool: SUBMIT_ANSWER_TOOL, args: { ...args(), answer: `${source.replace(/。$/u, '')}[E1][E2]。` } }
  : { tool: REPAIR_QUOTES_TOOL, args: { quotes: [{ evidence_id: 'E2', quote: source }] } }, {}, undefined, true);
check('局部补正只传缺失摘录，已有正确摘录仍保留', () => { assert.ifError(r.error); assert.equal(r.turns, 2); assert.equal(r.response?.answer.citations.length, 2); assert.equal(r.response.answer.quoteChecks?.failed, 0); });

r = await scenario((turn) => turn === 0 ? { tool: SUBMIT_ANSWER_TOOL, args: args([]) } : { tool: REPAIR_QUOTES_TOOL, args: { quotes: [{ evidence_id: 'E1', quote: '捏造的引用无法通过逐字原文核验' }] } });
check('错误摘录仍被移除，交付保留未核实状态', () => { assert.equal(r.response?.answer.citations.length, 0); assert.equal(r.response.delivery.status, 'partial'); assert((r.response.answer.quoteChecks?.failed ?? 0) > 0); });

r = await scenario(() => ({ tool: SUBMIT_ANSWER_TOOL, args: args([]) }), { maxTokens: 50 });
check('Token 到顶不再发起补正，保留原稿并移除无效引用', () => { assert.equal(r.turns, 1); assert.equal(r.f.stopReason, 'tokens'); assert.equal(r.response?.answer.citations.length, 0); });

r = await scenario((turn) => turn === 0 ? { tool: SUBMIT_ANSWER_TOOL, args: args([]) } : { tool: SUBMIT_ANSWER_TOOL, args: { ...args(), answer: '试图覆盖正文' } }, { maxToolCalls: 4 });
check('修复期间不能用 submit_answer 覆盖正文，错误协议只尝试一次', () => { assert(!r.response?.answer.answer.includes('试图覆盖正文')); assert.equal(r.turns, 2); assert.equal(r.response?.delivery.status, 'partial'); });

r = await scenario((turn) => {
  const queries = [question, '离心条件', '样品离心'];
  return turn < 3 ? { tool: RETRIEVE_TOOL, args: { query: queries[turn]! } } : { tool: SUBMIT_ANSWER_TOOL, args: args() };
});
check('复用提前查询，Agent 只执行一次定向补查', () => {
  assert.ifError(r.error);
  assert.equal(r.f.budget.used.queryCalls, 2);
  assert.equal(r.f.rewriteRounds, 1);
  assert.equal(r.f.evidenceCount, 1);
  assert.equal(r.f.toolTrace?.filter((t) => t.name === RETRIEVE_TOOL && !t.isError).length, 2);
  assert.equal(r.events.filter((e) => e.type === 'status' && e.phase === 'retrieval' && e.state === 'start').length, 2);
});

r = await scenario((turn, context) => {
  if (turn === 0) return { tool: READ_PAPER_TOOL, args: { evidence_id: 'E1', scope: 'section', query: '离心条件' } };
  if (turn === 1) return { tool: READ_PAPER_TOOL, args: { evidence_id: 'E1', scope: 'full', from: 0 } };
  assert(JSON.stringify(context.messages).includes('已到达解析文本末尾'));
  return { tool: SUBMIT_ANSWER_TOOL, args: args() };
}, {}, undefined, true);
check('Agent 可自行选择按章节精读或顺序查阅已解析全文', () => {
  assert.ifError(r.error);
  assert.equal(r.f.toolTrace?.filter((t) => t.name === READ_PAPER_TOOL && !t.isError).length, 2);
  assert.equal(r.response?.answer.citations[0]?.sourceType, 'document');
});

r = await scenario(() => ({ tool: SUBMIT_ANSWER_TOOL, args: args() }), { maxQueryCalls: 0 });
check('零查询预算不会通过提前检索越权取证', () => { assert.equal(r.f.budget.used.queryCalls, 0); assert.equal(r.f.evidenceCount, 0); assert.equal(r.response?.answer.citations.length, 0); });

r = await scenario(() => ({ tool: SUBMIT_ANSWER_TOOL, args: args(), hang: true }), { maxWallMs: 60 });
check('在模型等待阶段超时仍有唯一终态及已取得证据', () => { assert.ifError(r.error); assert.equal(r.f.stopReason, 'wall'); assert.equal(r.f.lastStage, 'generation'); assert.equal(r.response?.delivery.status, 'interrupted'); assert.equal(r.f.evidenceCount, 1); assert.equal(r.f.modelTimings?.[0]?.firstResponseMs, null); });
console.log(`\n问答延迟回归 ${passed}/${passed} 通过（假模型，零云端调用）。`);
