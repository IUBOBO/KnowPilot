/**
 * 一次"白话 → 结构化草案"的完整运行：Agent 循环 + 截止信号 + 用量流水。
 *
 * 骨架照抄 `organize/run.ts`（它又是照 `agent/ask-run.ts`）。有一处**必须不同**：
 * 这里记用量流水时**要填真实 userId** —— organize 那处写的是 `null`，因为它是
 * 在登录功能之前写的；而知识沉淀是登录之后的能力，把它记成"无主"，管理端用量页
 * 就会把这份消耗算到没人头上。
 *
 * 【为什么这是一次模型调用，不是多轮探查】与整理不同：整理要先列目录、读清单，
 *   信息在磁盘上；而沉淀的输入是**用户那句话本身**，它已经全在 prompt 里了。
 *   所以这里没有探查工具，只有 submit_entries 一个提交口 —— 一轮就能收工。
 */
import { randomUUID } from 'node:crypto';
import { contentText, type AssistantMessage, type MutableModels, type Usage } from '@earendil-works/pi-ai';
import { Agent, type AgentEvent } from '@earendil-works/pi-agent-core';
import { AppError, KNOWLEDGE_MAX_WALL_MS, type KnowledgeDraftSource, type RunUsage } from '@knowpilot/shared';
import { createStreamFn } from '../agent/stream.ts';
import { DEFAULT_REASONER_MODEL, DEEPSEEK, resolveRuntimeModel } from '../agent/models.ts';
import { requireModelSettings } from '../agent/model-config.ts';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { insertUsageEvent } from '../usage/repo.ts';
import { buildKnowledgePrompt } from './prompt.ts';
import { createSubmitEntriesTool, type DraftInput } from './tools.ts';

export interface KnowledgeDeps {
  db: Db;
  config: AppConfig;
  models: MutableModels;
}

export interface GenerateInput {
  /** 用户那句白话（路由层已 trim 并做过长度下限校验）。 */
  text: string;
  /** 提交人 id；管理端/脚本可能为 null。 */
  userId: string | null;
  requestId?: string;
  sourceKind?: KnowledgeDraftSource['kind'];
}

export interface GenerateOutput {
  runId: string;
  drafts: readonly DraftInput[];
}

/** 把用户的输入包成一段 prompt。**明确标注这是数据、不是指令**（防注入）。 */
function renderInput(text: string): string {
  return [
    '下面是用户写的一段白话，请把它整理成结构化的知识条目：',
    '',
    '<<<用户输入开始>>>',
    text,
    '<<<用户输入结束>>>',
  ].join('\n');
}

export async function generateDrafts(
  deps: KnowledgeDeps,
  input: GenerateInput,
): Promise<GenerateOutput> {
  const cfg = deps.config;
  // 沉淀是"白话 → 提炼结构"的整理型任务，用**推理模型**（不是对话模型）。
  // 用量流水里记的也是推理模型的名字，费用按它算。
  const settings = requireModelSettings(deps.db, cfg);

  const { model } = resolveRuntimeModel(
    deps.models,
    DEEPSEEK,
    settings.reasonerModel,
    DEFAULT_REASONER_MODEL,
  );
  const runId = randomUUID();
  const startedAt = Date.now();
  const logId = input.requestId ?? runId;

  let submitted: readonly DraftInput[] | undefined;
  let assistantTurns = 0;
  let lastAssistant: AssistantMessage | undefined;
  let usage: RunUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  let timedOut = false;

  const deadline = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, KNOWLEDGE_MAX_WALL_MS);

  const submitTool = createSubmitEntriesTool((drafts) => {
    submitted = drafts;
  });

  const agent = new Agent({
    streamFn: createStreamFn(deps.models, deadline.signal, {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
    }),
    initialState: {
      systemPrompt: buildKnowledgePrompt(input.sourceKind),
      model,
      tools: [submitTool],
    },
    finishTurn: (turn) => {
      if (submitted !== undefined) return { action: 'end' };
      if (turn.message.stopReason === 'aborted') return { action: 'end' };
      return undefined;
    },
  });

  deadline.signal.addEventListener('abort', () => agent.abort());

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (event.type !== 'turn_end') return;
    if (event.message.role !== 'assistant') return;
    assistantTurns += 1;
    lastAssistant = event.message;
    usage = addUsage(usage, event.message.usage);
    recordUsage(event.message.usage, assistantTurns);
  });

  let failure: unknown;
  try {
    await agent.prompt(renderInput(input.text));
    await agent.waitForIdle();
  } catch (err) {
    failure = err;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }

  const durationMs = Date.now() - startedAt;

  if (failure !== undefined) {
    const message = failure instanceof Error ? failure.message : String(failure);
    log(logId, runId, { outcome: 'exception', error: message, duration_ms: durationMs });
    throw new AppError('internal', `知识草案生成过程中出错：${message}`);
  }

  // 超时且没产出 → 504，让路由回一个明确的"上游太慢"。
  if (submitted === undefined && timedOut) {
    log(logId, runId, { outcome: 'timeout', duration_ms: durationMs, usage });
    throw new AppError('internal', '知识草案生成超时（上游模型长时间没有返回），请稍后重试。');
  }

  const drafts = submitted ?? [];
  if (drafts.length === 0) {
    const reply = lastAssistant === undefined ? '' : contentText(lastAssistant.content).trim();
    log(logId, runId, {
      outcome: 'empty',
      turns: assistantTurns,
      reply_chars: reply.length,
      duration_ms: durationMs,
      usage,
    });
    throw new AppError(
      'invalid_argument',
      reply === ''
        ? '这段内容里没有可以沉淀成知识的信息，请把要记的事情说得更具体一些。'
        : `这段内容里没有可以沉淀成知识的信息：${reply}`,
    );
  }

  log(logId, runId, {
    outcome: 'ok',
    turns: assistantTurns,
    entries: drafts.length,
    timed_out: timedOut,
    usage,
    duration_ms: durationMs,
  });

  return { runId, drafts };

  /**
   * 记一条用量流水（每次模型调用一行，C-USAGE）。
   *
   * 与 ask-run / organize 同一套约定，唯一区别是**这里填真实 userId**（见文件头）。
   * 写不进去不许影响主流程：流水是辅助记录，不是事实来源。
   */
  function recordUsage(messageUsage: Usage, turn: number): void {
    try {
      insertUsageEvent(deps.db, {
        eventId: `${runId}:${turn}`,
        runId,
        userId: input.userId,
        model: `${DEEPSEEK}/${model.id}`,
        purpose: 'generate',
        inputTokens: finiteOrNull(messageUsage.input),
        outputTokens: finiteOrNull(messageUsage.output),
        cacheRead: finiteOrNull(messageUsage.cacheRead),
        cacheCreation: finiteOrNull(messageUsage.cacheWrite),
        costUsd: finiteOrNull(messageUsage.cost.total),
        durationMs: null,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[${logId}] 用量流水落库失败（不影响本次沉淀）：`, err);
    }
  }
}

function addUsage(total: RunUsage, usage: Usage): RunUsage {
  return {
    inputTokens: total.inputTokens + usage.input,
    outputTokens: total.outputTokens + usage.output,
    cacheReadTokens: total.cacheReadTokens + usage.cacheRead,
    cacheWriteTokens: total.cacheWriteTokens + usage.cacheWrite,
    costUsd: total.costUsd + usage.cost.total,
  };
}

/** 不是有限数就返回 null。理由同 ask-run：宁可显式留空，也不要碰巧留空。 */
function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function log(id: string, runId: string, entry: Record<string, unknown>): void {
  console.log(`[${id}] knowledge ${JSON.stringify({ run_id: runId, ...entry })}`);
}
