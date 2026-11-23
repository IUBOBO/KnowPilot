/**
 * 四维预算与统一终态的验证脚本：`npm run verify-budget -w @knowpilot/server`。
 *
 * 【为什么必须"注入一个假模型"，而不是等真模型碰巧触发出这些情况】
 *   要验的四件事 —— 查询次数到顶、工具调用总量到顶、Token 预算到顶、超时 ——
 *   在真实问答里**几乎不会自然发生**（真发生了也多半是用户报障）。等它出现再验，
 *   等于永远没验过。而把生产值调低去逼它，又要真花钱、真等 5 分钟。
 *   所以这里换掉 `models.streamSimple`（pi-ai 留给扩展用的那个口子），
 *   用一段**照剧本演的**假模型：它想调什么工具、报多少 token、要不要卡住，
 *   全部由用例写死。被测的是 `ask-run.ts` 里那段真实的预算判定与终态回报，
 *   一行都没被替换 —— 假的是模型，不是被测对象。
 *
 * 【为什么几维都压得很低，而不是用生产值】判据是同一段代码，压低了测的是
 *   "到顶会不会真的停下来"，这是**低配下的正确性**；生产值只影响阈值大小，
 *   不影响判定逻辑。压低之后整份脚本零成本、几百毫秒跑完。
 *
 * 【它同时守住"每次 attempt 恰一个终态"】每个场景都断言 `onFinalize` 恰好回调
 *   一次、且 `ask_records` 恰好一行。零次 = 报告里少一条（静默），两次 = 重复计数
 *   （也静默）—— 这两种都只能靠断言发现。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonObject,
  type Model,
  type MutableModels,
  type SimpleStreamOptions,
  type TextContent,
  type ToolCall,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import type { Answer } from '@knowpilot/shared';
import type { AppConfig } from '../config.ts';
import { openDb, type Db } from '../db/index.ts';
import { AskAbortedError, runAsk, type AskFinalization } from './ask-run.ts';
import type { BudgetLimits } from './budget.ts';
import { createLabModels } from './models.ts';
import { RETRIEVE_TOOL, SUBMIT_ANSWER_TOOL } from './tools.ts';

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

// ── 假模型 ────────────────────────────────────────────────────────

/** 一步剧本：这一次"模型"要干什么。 */
interface Spec {
  /** 要调的工具（按顺序）。省略 = 这一轮不调工具。 */
  toolCalls?: readonly { name: string; args: JsonObject }[];
  /** 普通文本内容（回落路径会用）。 */
  text?: string;
  /** 这一次调用上报的用量。默认很小，不影响预算。 */
  usage?: { input: number; output: number };
  /** `true` = 这个请求一直不返回，直到运行级信号中止它（用来测超时）。 */
  hang?: boolean;
}

/** 剧本函数：第几轮 + 当时的上下文 → 这一步怎么演。 */
type Strategy = (turn: number, context: TranscriptContext) => Spec;

function retrieveSpec(query: string): Spec {
  return { toolCalls: [{ name: RETRIEVE_TOOL, args: { query } }] };
}

/** 交一份**结构完整**的答案（五个字段一个不少，否则会被当成"没按约定提交"）。 */
function submitSpec(answerText: string): Spec {
  return {
    toolCalls: [
      {
        name: SUBMIT_ANSWER_TOOL,
        args: {
          answer: answerText,
          // O2 起提交答案必须带 quotes 字段（没有引用时传空数组）。缺了它工具
          // 会拒绝，假模型就会一直重试到预算耗尽 —— 这不是被测逻辑的问题。
          quotes: [],
          evidence_gaps: [],
          limits: [],
          confidence_notes: [],
          conflicts: [],
        },
      },
    ],
  };
}

/**
 * 把假模型装到模型集合上。
 *
 * 【为什么不是造一个全新的假 `Models`】`runAsk` 里还会走 `resolveRuntimeModel`，
 *   它要按 ID 去目录里找模型（找不到就报"目录里没有这个模型"）。真集合已经有目录了，
 *   只把 `streamSimple` 换掉，目录照旧 —— 替换面越小，脚本离"真实路径"越近。
 */
function installFakeModel(models: MutableModels, strategy: Strategy): { turns: () => number } {
  let turns = 0;
  let callSeq = 0;
  const target = models as unknown as {
    streamSimple: (m: Model<Api>, c: TranscriptContext, o?: SimpleStreamOptions) => AssistantMessageEventStream;
  };
  target.streamSimple = (model, context, options) => {
    const spec = strategy(turns, context);
    turns += 1;
    const stream = createAssistantMessageEventStream();
    const message = buildMessage(model, spec, () => {
      callSeq += 1;
      return `fake-${callSeq}`;
    });

    if (spec.hang === true) {
      // 真模型卡住时也是这个形状：请求发出去、一直没有响应，直到运行级信号把它取消。
      const onAbort = (): void => {
        stream.push({
          type: 'error',
          reason: 'aborted',
          error: { ...message, stopReason: 'aborted' },
        });
      };
      if (options?.signal?.aborted === true) queueMicrotask(onAbort);
      else options?.signal?.addEventListener('abort', onAbort, { once: true });
      return stream;
    }

    queueMicrotask(() => {
      stream.push({
        type: 'done',
        reason: spec.toolCalls === undefined || spec.toolCalls.length === 0 ? 'stop' : 'toolUse',
        message,
      });
    });
    return stream;
  };
  return { turns: () => turns };
}

function buildMessage(model: Model<Api>, spec: Spec, nextId: () => string): AssistantMessage {
  const content: (TextContent | ToolCall)[] = [];
  if (spec.text !== undefined && spec.text !== '') content.push({ type: 'text', text: spec.text });
  for (const tc of spec.toolCalls ?? []) {
    content.push({ type: 'toolCall', id: nextId(), name: tc.name, arguments: tc.args });
  }
  const input = spec.usage?.input ?? 10;
  const output = spec.usage?.output ?? 5;
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: spec.toolCalls === undefined || spec.toolCalls.length === 0 ? 'stop' : 'toolUse',
    timestamp: Date.now(),
  };
}

// ── 场景骨架 ──────────────────────────────────────────────────────

interface ScenarioResult {
  finalizations: readonly AskFinalization[];
  answer?: Answer;
  error?: unknown;
  db: Db;
}

const CFG = (root: string): AppConfig => ({
  port: 0,
  dbPath: join(root, 'unused.db'),
  uploadDir: join(root, 'uploads'),
  repoRoot: root,
  deepseekApiKey: 'fake-key-for-budget-check',
  modelChat: undefined,
  modelReasoner: undefined,
  modelBaseUrl: undefined,
  hfHome: root,
  embedModelDir: join(root, 'models'),
  embedModelId: 'bge-m3',
  embedDtype: 'q8',
  rerankEnabled: false,
  rerankModelId: 'bge-reranker-base',
  rerankDtype: 'q8',
  rerankCandidateDepth: 30,
  rerankTimeoutMs: 3000,
  // 关掉 OCR：这一份验的是预算与终态，不该顺路把 OCR 模型拉起来。
  ocrEnabled: false,
  ocrMaxPages: 1,
  codeRoots: [],
  dataRoot: join(root, 'datasets'),
  uploadMaxBytes: 1024,
  uploadChunkSize: 512,
  uploadSessionTtlDays: 1,
  knowledgeConflictThreshold: 0.82,
  patrolIntervalHours: 24,
  sessionIdleDays: 7,
  sessionMaxDays: 30,
  cookieSecure: false,
  adminUsername: undefined,
  adminPassword: undefined,
});

async function scenario(opts: {
  budget: Partial<BudgetLimits>;
  strategy: Strategy;
  /** 由场景自己决定什么时候中止（测客户端断开用）。 */
  onEvent?: (ev: { type: string }) => void;
  signal?: AbortSignal;
}): Promise<ScenarioResult> {
  // 每个场景一个**独立的内存库**：`ask_records` 的行数断言不能跨场景串味。
  const { db } = openDb(':memory:');
  const cfg = CFG(mkdtempSync(join(tmpdir(), 'knowpilot-budget-verify-')));
  const models = createLabModels();
  installFakeModel(models, opts.strategy);

  const finalizations: AskFinalization[] = [];
  try {
    const res = await runAsk(
      { db, config: cfg, models },
      { question: '验证用问题（假模型，不出网）', consentConfirmed: true, user: null, budget: opts.budget },
      {
        onFinalize: (f) => finalizations.push(f),
        ...(opts.onEvent === undefined ? {} : { onEvent: opts.onEvent }),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      },
    );
    return { finalizations, answer: res.answer, db };
  } catch (err) {
    return { finalizations, error: err, db };
  }
}

function askRecordCount(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM ask_records').get() as unknown as { n: number };
  return row.n;
}

/** 终态唯一性：每个场景都要过这一关。 */
function checkSingleTerminal(label: string, r: ScenarioResult): void {
  check(`${label}：onFinalize 恰好回调一次`, r.finalizations.length === 1, `实际 ${r.finalizations.length} 次`);
  check(`${label}：ask_records 恰好一行`, askRecordCount(r.db) === 1, `实际 ${askRecordCount(r.db)} 行`);
  const saved = r.db.prepare('SELECT delivery_status FROM ask_records').get() as unknown as { delivery_status: string } | undefined;
  check(`${label}：记录中的交付状态与终态一致`, saved?.delivery_status === r.finalizations[0]?.deliveryStatus, String(saved?.delivery_status));
}

// ── 场景 1：查询轮次到顶 ─────────────────────────────────────────
console.log('预算 · 轮次维：查询次数到顶后封掉查询工具，仍要交付答案');

{
  // 前 3 轮一直检索（第 3 次会被拦下），第 4 轮改交答案 —— 模拟"模型读到拦截理由后收手"。
  const r = await scenario({
    budget: { maxQueryCalls: 2, maxToolCalls: 15, maxTokens: 1_000_000, maxWallMs: 30_000 },
    strategy: (turn) => (turn < 3 ? retrieveSpec(`第 ${turn + 1} 次检索`) : submitSpec('已按手上的证据作答 [E1]')),
  });
  checkSingleTerminal('轮次维', r);
  const f = r.finalizations[0];
  check('轮次维：终态是 ok（到上限不是失败）', f?.outcome === 'ok', String(f?.outcome));
  check('轮次维：stopReason 指认是轮次', f?.stopReason === 'rounds', String(f?.stopReason));
  check('轮次维：查询次数停在上限 2 次', f?.budget.used.queryCalls === 2, String(f?.budget.used.queryCalls));
  check('轮次维：确实把答案交出来了', (r.answer?.answer ?? '').includes('已按手上的证据作答'), r.answer?.answer);
  check(
    '轮次维：交付状态不是 failed（到上限 ≠ 失败）',
    f?.deliveryStatus === 'verified' || f?.deliveryStatus === 'partial',
    String(f?.deliveryStatus),
  );
}

// ── 场景 2：工具调用总量到顶（循环兜底）──────────────────────────
console.log('预算 · 工具维：模型死循环般地调工具时，循环被掐断');

{
  // 永远只检索、从不交答案 —— 这正是"轮次计数不再增长、只有总量还在涨"的那种形态。
  const r = await scenario({
    budget: { maxQueryCalls: 100, maxToolCalls: 3, maxTokens: 1_000_000, maxWallMs: 30_000 },
    strategy: () => retrieveSpec('死循环检索'),
  });
  checkSingleTerminal('工具维', r);
  const f = r.finalizations[0];
  check('工具维：stopReason 指认是工具总量', f?.stopReason === 'tool_calls', String(f?.stopReason));
  check('工具维：工具调用总量停在上限 3 次', f?.budget.used.toolCalls === 3, String(f?.budget.used.toolCalls));
  // 第 3 次尝试**是被工具预算自己拦下的**（`beforeToolCall` 先记总量再判），
  // 所以成功查询只有 2 次。两维各记各的，不要互相污染。
  check(
    '工具维：第 3 次尝试被拦下，成功查询停在 2 次',
    f?.budget.used.queryCalls === 2,
    String(f?.budget.used.queryCalls),
  );
  // 没有 submit_answer → 走回落路径，并且**如实说明**结构化字段是猜的。
  check(
    '工具维：回落路径如实告知"模型没按约定提交"',
    (r.answer?.warnings ?? []).some((w) => w.includes('没有调用 submit_answer')),
    (r.answer?.warnings ?? []).join(' | '),
  );
}

// ── 场景 3：Token 预算到顶 ───────────────────────────────────────
console.log('预算 · Token 维：累计 token 越线后不再放行查询');

{
  // 每轮报 700 token，上限 1000 → 第二轮结束时越线。
  const r = await scenario({
    budget: { maxQueryCalls: 100, maxToolCalls: 100, maxTokens: 1000, maxWallMs: 30_000 },
    strategy: (turn) =>
      turn < 2
        ? { ...retrieveSpec(`第 ${turn + 1} 次检索`), usage: { input: 600, output: 100 } }
        : { ...submitSpec('token 到顶后作答'), usage: { input: 600, output: 100 } },
  });
  checkSingleTerminal('Token 维', r);
  const f = r.finalizations[0];
  check('Token 维：stopReason 指认是 token', f?.stopReason === 'tokens', String(f?.stopReason));
  check(
    'Token 维：累计用量确实越过了上限',
    (f?.budget.used.tokens ?? 0) >= (f?.budget.limits.maxTokens ?? 0),
    `${f?.budget.used.tokens} vs ${f?.budget.limits.maxTokens}`,
  );
  // 这一条的判据是"第 3 次查询有没有被拦下"：拦下了才会只查 2 次。
  check('Token 维：越线之后不再放行查询（停在 2 次）', f?.budget.used.queryCalls === 2, String(f?.budget.used.queryCalls));
}

// ── 场景 4：提问方中止 ───────────────────────────────────────────
console.log('终态 · 中止：抛 AskAbortedError，但不产出半截答案');

{
  const controller = new AbortController();
  const r = await scenario({
    budget: { maxQueryCalls: 100, maxToolCalls: 100, maxTokens: 1_000_000, maxWallMs: 30_000 },
    strategy: () => retrieveSpec('会被中止的检索'),
    signal: controller.signal,
    // 工具一开始跑就中止 —— 这正是"用户点了停止"发生时机的忠实再现。
    onEvent: (ev) => {
      if (ev.type === 'status') controller.abort();
    },
  });
  checkSingleTerminal('中止', r);
  const f = r.finalizations[0];
  check('中止：抛的是 AskAbortedError', r.error instanceof AskAbortedError, String(r.error));
  check('中止：没有交出答案', r.answer === undefined);
  check('中止：outcome 是 aborted', f?.outcome === 'aborted', String(f?.outcome));
  check('中止：stopReason 指认是提问方', f?.stopReason === 'client_aborted', String(f?.stopReason));
  check('中止：lastStage 停在 retrieval', f?.lastStage === 'retrieval', String(f?.lastStage));
  // X1a：中止是 interrupted，不是正常完成；没有提交答案时不得编出 Claim。
  check('中止：交付状态是 interrupted', f?.deliveryStatus === 'interrupted', String(f?.deliveryStatus));
  check('中止：没有可交付的 Claim', (f?.claimChecks.length ?? -1) === 0, String(f?.claimChecks.length));
}

// ── 场景 5：墙钟超时 ─────────────────────────────────────────────
console.log('预算 · 时间维：请求一直不返回时，到点中止并如实告知');

{
  const r = await scenario({
    budget: { maxQueryCalls: 100, maxToolCalls: 100, maxTokens: 1_000_000, maxWallMs: 400 },
    // 第一次调用就一直挂着 —— 超时拦的就是这种"上游不响"的形态。
    strategy: () => ({ hang: true }),
  });
  checkSingleTerminal('时间维', r);
  const f = r.finalizations[0];
  check('时间维：没有抛错，而是返回了一段说明', r.error === undefined, String(r.error));
  check('时间维：outcome 是 timeout', f?.outcome === 'timeout', String(f?.outcome));
  check('时间维：stopReason 指认是墙钟', f?.stopReason === 'wall', String(f?.stopReason));
  check('时间维：如实告知了时限', (r.answer?.answer ?? '').includes('时限'), r.answer?.answer);
  check('时间维：证据缺口写明了这次没答案', (r.answer?.evidenceGaps ?? []).length === 1);
  // X1a：超时是 interrupted + not_checked；不把"没跑完"写成"已验证"。
  check('时间维：交付状态是 interrupted', f?.deliveryStatus === 'interrupted', String(f?.deliveryStatus));
  check(
    '时间维：Claim 总账是 not_checked（没有可校验内容）',
    r.answer?.verification.status === 'not_checked',
    r.answer?.verification.status,
  );
  check('时间维：Trace 里没有伪造的 Claim', (f?.claimChecks.length ?? -1) === 0, String(f?.claimChecks.length));
}

// ── 汇总 ──────────────────────────────────────────────────────────
console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} 项断言失败：`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log(`预算与终态断言全部通过（${passed} 项）。`);
}
