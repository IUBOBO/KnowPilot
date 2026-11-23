/**
 * O16「下一步」确定性映射的零模型校验。
 *
 * 用法：npm run verify-next-actions
 *
 * 只测纯函数：工具轨迹 + 引用数 + 依据缺口 → 站内出口。
 * 不碰数据库、不调模型、不发网络请求。
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
import { readAnswerTable } from '@knowpilot/shared';
import { runAsk } from './ask-run.ts';
import { createLabModels } from './models.ts';
import { SUBMIT_ANSWER_TOOL } from './tools.ts';
import { suggestNextActions, type NextActionSignal } from './next-actions.ts';
import { DATASET_TOOL, PATENTS_TOOL, SUBMISSIONS_TOOL, THESES_TOOL } from './live-tools.ts';
import { JOURNAL_TOOL } from './journal-tool.ts';
import type { AppConfig } from '../config.ts';
import { openDb } from '../db/index.ts';

let failed = 0;
let total = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  total += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` —— ${detail}`}`);
  if (!ok) failed += 1;
};

const hit = (name: string, count: number | null, isError = false): NextActionSignal => ({
  name,
  hitCount: count,
  isError,
});

function run(input: Parameters<typeof suggestNextActions>[0]) {
  return suggestNextActions(input);
}

// ── 台账 ────────────────────────────────────────────────────
{
  const actions = run({ toolTrace: [hit(SUBMISSIONS_TOOL, 0)], citationCount: 0, gapCount: 1 });
  check('台账 0 命中 → 一个「去登记投稿」出口',
    actions.length === 1 && actions[0]?.kind === 'register-submission', JSON.stringify(actions));
  check('去登记投稿落到 /submissions', actions[0]?.to === '/submissions', String(actions[0]?.to));
  check('出口带说明（为什么出现）', (actions[0]?.hint ?? '').length > 0, String(actions[0]?.hint));
}
{
  const actions = run({
    toolTrace: [hit(SUBMISSIONS_TOOL, 0), hit(SUBMISSIONS_TOOL, 3)],
    citationCount: 2,
    gapCount: 1,
  });
  check('★ 先没查到、后来查到了 → 不再给出口', actions.length === 0, JSON.stringify(actions));
}
{
  // 这里给 citationCount 1：否则会落到"零引用 + 依据缺口 → 去上传资料"那条兜底，
  // 测不到"报错调用被忽略"这件事。
  const actions = run({ toolTrace: [hit(SUBMISSIONS_TOOL, 0, true)], citationCount: 1, gapCount: 1 });
  check('报错的调用不算"0 命中"', actions.length === 0, JSON.stringify(actions));
}

// ── 分区 / 数据集 ───────────────────────────────────────────
{
  const actions = run({ toolTrace: [hit(JOURNAL_TOOL, 0)], citationCount: 0, gapCount: 1 });
  check('分区库 0 命中 → 去补录', actions.length === 1 && actions[0]?.kind === 'add-journal',
    JSON.stringify(actions));
  check('补录落到 /journals', actions[0]?.to === '/journals', String(actions[0]?.to));
}
{
  const actions = run({ toolTrace: [hit(DATASET_TOOL, 0)], citationCount: 0, gapCount: 1 });
  check('数据集 0 命中 → 去登记数据集',
    actions.length === 1 && actions[0]?.kind === 'register-dataset', JSON.stringify(actions));
  check('登记数据集落到 /datasets', actions[0]?.to === '/datasets', String(actions[0]?.to));
}

// ── 多条 / 上限 / 顺序 ──────────────────────────────────────
{
  const actions = run({
    toolTrace: [hit(SUBMISSIONS_TOOL, 0), hit(JOURNAL_TOOL, 0)],
    citationCount: 0,
    gapCount: 2,
  });
  check('两条记录都没查到 → 两个出口', actions.length === 2, JSON.stringify(actions));
  check('顺序固定：台账在前、分区在后',
    actions[0]?.kind === 'register-submission' && actions[1]?.kind === 'add-journal',
    actions.map((a) => a.kind).join(' → '));
}
{
  const actions = run({
    toolTrace: [hit(SUBMISSIONS_TOOL, 0), hit(JOURNAL_TOOL, 0), hit(DATASET_TOOL, 0)],
    citationCount: 0,
    gapCount: 3,
  });
  check('★ 最多两个出口（不把回答下面变成一排按钮）', actions.length === 2, JSON.stringify(actions));
}

// ── 无引用 + 依据缺口 ───────────────────────────────────────
{
  const actions = run({ toolTrace: [], citationCount: 0, gapCount: 1 });
  check('只有零引用和依据缺口时不给上传提示', actions.length === 0, JSON.stringify(actions));
}
{
  const actions = run({ toolTrace: [hit(PATENTS_TOOL, 0), hit(THESES_TOOL, 0)], citationCount: 0, gapCount: 1 });
  check('专利和大论文未匹配时引到对应台账', actions[0]?.to === '/patents' && actions[1]?.to === '/theses');
}
{
  const actions = run({ toolTrace: [{ ...hit(PATENTS_TOOL, 0), matchedCount: 3 }], citationCount: 0, gapCount: 1 });
  check('翻到空页时不会误报台账里没有匹配', actions.length === 0);
}
{
  const actions = run({ toolTrace: [hit(PATENTS_TOOL, null, true)], citationCount: 0, gapCount: 1 });
  check('查询异常时可以重试', actions[0]?.kind === 'retry-query');
}
{
  const actions = run({ toolTrace: [], citationCount: 3, gapCount: 1 });
  check('有引用时不给"去上传"', actions.length === 0, JSON.stringify(actions));
}
{
  const actions = run({ toolTrace: [], citationCount: 0, gapCount: 0 });
  check('零引用但没列依据缺口 → 不给出口', actions.length === 0, JSON.stringify(actions));
}

// ── 契约底线 ────────────────────────────────────────────────
{
  const all = [
    ...run({ toolTrace: [hit(SUBMISSIONS_TOOL, 0)], citationCount: 0, gapCount: 1 }),
    ...run({ toolTrace: [hit(JOURNAL_TOOL, 0)], citationCount: 0, gapCount: 1 }),
    ...run({ toolTrace: [hit(DATASET_TOOL, 0)], citationCount: 0, gapCount: 1 }),
    ...run({ toolTrace: [], citationCount: 0, gapCount: 1 }),
  ];
  check('所有出口都是站内路径（以 / 开头）', all.every((a) => a.to.startsWith('/')),
    all.map((a) => a.to).join(' / '));
  check('所有出口都有文字与说明', all.every((a) => a.label.length > 0 && a.hint.length > 0));
  check('同一输入重复调用结果完全一致（确定性）',
    JSON.stringify(run({ toolTrace: [hit(SUBMISSIONS_TOOL, 0)], citationCount: 0, gapCount: 1 })) ===
      JSON.stringify(run({ toolTrace: [hit(SUBMISSIONS_TOOL, 0)], citationCount: 0, gapCount: 1 })));
}

// ── 集成：真实 runAsk 的装配路径 ───────────────────────────────
// 纯函数测试证明"规则对"，这一段证明**生产路径真的把工具命中数交到了规则手里**。
const ROOT = mkdtempSync(join(tmpdir(), 'knowpilot-next-actions-verify-'));
const CFG: AppConfig = {
  port: 0,
  dbPath: join(ROOT, 'unused.db'),
  uploadDir: join(ROOT, 'uploads'),
  repoRoot: ROOT,
  deepseekApiKey: 'fake-key-for-next-actions-check',
  modelChat: undefined,
  modelReasoner: undefined,
  modelBaseUrl: undefined,
  hfHome: ROOT,
  embedModelDir: join(ROOT, 'models'),
  embedModelId: 'bge-m3',
  embedDtype: 'q8',
  rerankEnabled: false,
  rerankModelId: 'bge-reranker-base',
  rerankDtype: 'q8',
  rerankCandidateDepth: 30,
  rerankTimeoutMs: 3000,
  ocrEnabled: false,
  ocrMaxPages: 1,
  codeRoots: [],
  dataRoot: join(ROOT, 'datasets'),
  uploadMaxBytes: 1024,
  uploadChunkSize: 512,
  uploadSessionTtlDays: 1,
  knowledgeConflictThreshold: 0.76,
  patrolIntervalHours: 24,
  sessionIdleDays: 7,
  sessionMaxDays: 30,
  cookieSecure: false,
  adminUsername: undefined,
  adminPassword: undefined,
};

function buildMessage(
  model: Model<Api>,
  toolCalls: readonly { name: string; args: JsonObject }[],
  nextId: () => string,
): AssistantMessage {
  const content: (TextContent | ToolCall)[] = toolCalls.map((tc) => ({
    type: 'toolCall',
    id: nextId(),
    name: tc.name,
    arguments: tc.args,
  }));
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  };
}

function installFakeModel(
  models: MutableModels,
  script?: (turn: number, context: TranscriptContext) => readonly { name: string; args: JsonObject }[],
): void {
  let turn = 0;
  let callSeq = 0;
  const target = models as unknown as {
    streamSimple: (
      m: Model<Api>,
      c: TranscriptContext,
      o?: SimpleStreamOptions,
    ) => AssistantMessageEventStream;
  };
  target.streamSimple = (model, context) => {
    const toolCalls =
      script?.(turn, context) ?? (turn === 0
        ? [{ name: SUBMISSIONS_TOOL, args: { keyword: 'O16-NO-SUCH-RECORD' } }]
        : [
            {
              name: SUBMIT_ANSWER_TOOL,
              args: {
                answer: '台账里没有这条记录。',
                quotes: [],
                evidence_gaps: ['台账里没有匹配的记录'],
                limits: [],
                confidence_notes: [],
                conflicts: [],
              },
            },
          ]);
    turn += 1;
    const message = buildMessage(model, toolCalls, () => `fake-next-${(callSeq += 1)}`);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'done', reason: 'toolUse', message });
    });
    return stream;
  };
}

async function integrationCheck(): Promise<void> {
  const { db } = openDb(':memory:');
  const models = createLabModels();
  installFakeModel(models);
  const res = await runAsk(
    { db, config: CFG, models },
    { question: 'O16 集成校验（假模型，不出网）', consentConfirmed: true, user: null },
  );

  check('集成：真实 runAsk 装配后给出「去登记投稿」',
    res.nextActions?.some((a) => a.kind === 'register-submission') === true,
    JSON.stringify(res.nextActions));
  check('集成：出口指向 /submissions',
    res.nextActions?.find((a) => a.kind === 'register-submission')?.to === '/submissions');
  check('集成：回答本身仍是零引用（出口不是靠正文猜的）', res.answer.citations.length === 0,
    String(res.answer.citations.length));
}

await integrationCheck();

async function dynamicLookupCheck(): Promise<void> {
  const { db } = openDb(':memory:');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
    VALUES ('u', 'fixture', '测试甲', 'unused', 'member', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO patents (id, name, applicant_name, created_by, created_at, updated_at)
    VALUES ('p', '遥感变化检测专利', '测试乙、测试丙', 'u', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO theses (id, author_name, direction, title, grade, created_at, updated_at)
    VALUES ('t', '测试甲', '遥感变化检测', '遥感实验论文', '不可作为问答来源的成绩', ?, ?)`).run(now, now);
  const models = createLabModels();
  installFakeModel(models, (turn, context) => {
    if (turn === 0) return [{ name: PATENTS_TOOL, args: { registrant: '测试甲' } }];
    const transcript = JSON.stringify(context.messages);
    if (turn === 1) {
      check('专利 tool 按登记人查且不混入申请人', transcript.includes('登记人：测试甲') && !transcript.includes('测试乙、测试丙'));
      return [{ name: 'follow_up_on_evidence', args: {
        follow_ups: [{ evidence_id: 'E1', focus: '测试甲 大论文', kind: 'record' }],
      } }];
    }
    if (turn === 2) {
      check('发现线索之后登记新的核对任务', transcript.includes('已登记 F1'));
      return [{ name: THESES_TOOL, args: { keyword: '测试甲' } }];
    }
    check('大论文返回题名/方向且不返回成绩', transcript.includes('遥感实验论文') && !transcript.includes('不可作为问答来源的成绩'));
    return [{ name: SUBMIT_ANSWER_TOOL, args: {
      answer: '| 类型 | 记录 |\n| --- | --- |\n| 专利 | 测试甲登记了遥感变化检测专利 [E1] |\n| 大论文 | 测试甲的题目为遥感实验论文 [E2] |',
      quotes: [], evidence_gaps: [], limits: [], confidence_notes: [], conflicts: [],
    } }];
  });
  try {
    const res = await runAsk(
      { db, config: CFG, models },
      { question: '按专利登记人找出对应方向的大论文', consentConfirmed: true,
        user: { id: 'u', username: 'fixture', displayName: '测试甲', role: 'member', groupId: null } },
    );
    const table = readAnswerTable(res.answer.answer.split('\n'), 0);
    check('模型提交的表格完整交付', table?.rows.length === 2);
    check('每行保留各自的证据，默认交付无规则语义判定',
      table?.rows[0]?.line.includes('[E1]') === true && table.rows[1]?.line.includes('[E2]') === true &&
      res.answer.verification.status === 'not_checked');
    check('专利和大论文证据都可由服务端核对',
      res.answer.citations.some((c) => c.sourceType === 'record' && c.recordType === 'M-PATENT') &&
      res.answer.citations.some((c) => c.sourceType === 'record' && c.recordType === 'M-THESIS'));
  } finally {
    db.close();
  }
}
await dynamicLookupCheck();

console.log(`\n${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
