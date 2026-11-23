/**
 * 一次整理对话的完整运行：Agent 循环 + 预算控制 + 收集计划。
 *
 * 骨架照抄 `agent/ask-run.ts`（三重闸、截止信号、用量流水），但有一处语义差别
 * 必须写下来：**这里不落问答记录表**。整理不是问答，question/answer 这套形状
 * 按不到它头上；它自己的可追溯性由 `organize_plans` / `organize_actions` 承担
 * （计划先落库再执行）。用量流水照记 —— 这几次模型调用是真的花了钱。
 *
 * 【多轮对话为什么不进 pi-agent 的消息数组】`runAsk` 是一次 `agent.prompt()`
 * 跑到底，没有多轮先例；而 pi-agent 的 `initialState.messages` 播种行为未实证。
 * 所以这里改成：**每次请求新起一个 Agent，把整段对话拼进 prompt** ——
 * 零新机制、零未验证的假设。代价是每轮重新探查一次目录（几次只读调用，很便宜），
 * 换来的是服务端完全无状态：两个标签页同时聊也不会串味。
 */
import { randomUUID } from 'node:crypto';
import { contentText, type AssistantMessage, type MutableModels, type Usage } from '@earendil-works/pi-ai';
import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type BeforeToolCallResult,
  type PrepareNextTurnContext,
} from '@earendil-works/pi-agent-core';
import {
  AppError,
  ORGANIZE_MAX_TOOL_ROUNDS,
  ORGANIZE_MAX_WALL_MS,
  type OrganizeMessage,
  type OrganizePlan,
  type RunUsage,
} from '@knowpilot/shared';
import { createStreamFn } from '../agent/stream.ts';
import { DEFAULT_REASONER_MODEL, DEEPSEEK, resolveRuntimeModel } from '../agent/models.ts';
import { requireModelSettings } from '../agent/model-config.ts';
import { type AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { insertUsageEvent } from '../usage/repo.ts';
import { buildOrganizePrompt } from './prompt.ts';
import {
  createListDirTool,
  createReadFileTool,
  createSubmitPlanTool,
  ORGANIZE_LIST_DIR,
  ORGANIZE_READ_FILE,
  ORGANIZE_SUBMIT_PLAN,
} from './tools.ts';

export interface OrganizeDeps {
  db: Db;
  config: AppConfig;
  models: MutableModels;
}

export interface OrganizeInput {
  /** 数据集根的绝对路径（已经过路由层的前置校验）。 */
  datasetDir: string;
  datasetName: string;
  /** 完整对话记录（含用户这条新消息）。 */
  messages: readonly OrganizeMessage[];
  requestId?: string;
}

export interface OrganizeOutput {
  runId: string;
  reply: string;
  plan: OrganizePlan | null;
}

/** 轮次上限之外的硬停止余量。理由同 ask-run：到上限后仍需几轮把手上的事说完。 */
const HARD_STOP_EXTRA_TURNS = 3;

/** 把对话记录拼成一段 prompt。空对话由路由层挡在前面，这里只管非空。 */
function renderConversation(messages: readonly OrganizeMessage[]): string {
  const lines = ['这是到目前为止的对话记录（按时间顺序）：', ''];
  for (const m of messages) {
    lines.push(m.role === 'user' ? `用户：${m.content}` : `你：${m.content}`);
    lines.push('');
  }
  lines.push('请接着完成用户最新的那条要求。');
  return lines.join('\n');
}

/** 把拟好的计划渲染成一段文字，附在回复末尾 —— 这样它自然进入下一轮的对话记录。 */
function renderPlan(plan: OrganizePlan): string {
  return [
    '',
    '【我拟的整理计划】',
    plan.summary,
    ...plan.rules.map((r) => `· 把 ${r.match} 移到 ${r.toDir}/`),
  ].join('\n');
}

export async function runOrganize(
  deps: OrganizeDeps,
  input: OrganizeInput,
): Promise<OrganizeOutput> {
  const cfg = deps.config;
  // 整理是"白话 → 拟规则 → 人确认 → 执行"的规划型任务，用**推理模型**（不是对话模型）。
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

  let submittedPlan: OrganizePlan | undefined;
  let toolRounds = 0;
  let totalToolCalls = 0;
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
  }, ORGANIZE_MAX_WALL_MS);

  const listTool = createListDirTool(input.datasetDir);
  const readTool = createReadFileTool(input.datasetDir);
  const submitTool = createSubmitPlanTool((plan) => {
    submittedPlan = plan;
  });

  const agent = new Agent({
    streamFn: createStreamFn(deps.models, deadline.signal, {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
    }),
    // 必须串行：`terminate` 只在同一批工具结果全部设置时才生效（见 ask-run）。
    toolExecution: 'sequential',
    initialState: {
      systemPrompt: buildOrganizePrompt({
        datasetDir: input.datasetDir,
        datasetName: input.datasetName,
      }),
      model,
      tools: [listTool, readTool, submitTool] as AgentTool<any, any>[],
    },
    beforeToolCall: (ctx): Promise<BeforeToolCallResult | undefined> => {
      // 提交计划永远放行。若把它也算进上限，模型探满之后就再也交不出计划了 ——
      // 那等于把"到上限"变成"整轮失败"，而我们要的是"停下，输出已有结论"。
      if (ctx.toolCall.name === ORGANIZE_SUBMIT_PLAN) return Promise.resolve(undefined);

      totalToolCalls += 1;
      if (toolRounds >= ORGANIZE_MAX_TOOL_ROUNDS) {
        return Promise.resolve({
          block: true,
          terminate: true,
          reason:
            `已达本次探查次数上限（${ORGANIZE_MAX_TOOL_ROUNDS} 次）。不要再看了，` +
            `请基于已经看到的内容拟计划；如果信息不够，就在回复里说明你还需要什么。`,
        });
      }
      toolRounds += 1;
      return Promise.resolve(undefined);
    },
    prepareNextTurnWithContext: (ctx: PrepareNextTurnContext) => {
      if (toolRounds < ORGANIZE_MAX_TOOL_ROUNDS && totalToolCalls <= ORGANIZE_MAX_TOOL_ROUNDS) {
        return undefined;
      }
      // 与计数器无关的兜底：到上限后把探查工具从下一轮的声明里摘掉，只留提交计划。
      return {
        context: {
          messages: ctx.context.messages,
          tools: [submitTool] as AgentTool<any, any>[],
        },
      };
    },
    finishTurn: (turn) => {
      if (submittedPlan !== undefined) return { action: 'end' };
      if (totalToolCalls >= ORGANIZE_MAX_TOOL_ROUNDS + HARD_STOP_EXTRA_TURNS) return { action: 'end' };
      if (turn.message.stopReason === 'aborted') return { action: 'end' };
      return undefined;
    },
  });

  deadline.signal.addEventListener('abort', () => agent.abort());

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    handleEvent(event);
  });

  function handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'tool_execution_start':
        hooksStatus(event.toolName);
        return;
      case 'turn_end':
        if (event.message.role === 'assistant') {
          assistantTurns += 1;
          lastAssistant = event.message;
          usage = addUsage(usage, event.message.usage);
          recordUsage(event.message.usage, assistantTurns);
        }
        return;
      default:
        return;
    }
  }

  function hooksStatus(toolName: string): void {
    if (toolName === ORGANIZE_LIST_DIR || toolName === ORGANIZE_READ_FILE) {
      console.log(`[${logId}] organize 探查：${toolName}`);
    }
  }

  let failure: unknown;
  try {
    await agent.prompt(renderConversation(input.messages));
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
    throw new AppError('internal', `整理计划生成过程中出错：${message}`);
  }

  const baseReply = lastAssistant === undefined ? '' : contentText(lastAssistant.content).trim();
  const plan = submittedPlan ?? null;

  if (plan !== null && plan.rules.length === 0 && baseReply === '') {
    throw new AppError('internal', '模型没有给出任何计划或说明，请重试一次。');
  }

  const reply =
    plan === null
      ? baseReply === ''
        ? '（这次没有生成内容，请再说一次你的整理需求。）'
        : baseReply
      : `${baseReply}${renderPlan(plan)}`.trim();

  log(logId, runId, {
    outcome: 'ok',
    turns: assistantTurns,
    tool_rounds: toolRounds,
    submitted: plan !== null,
    rules: plan === null ? 0 : plan.rules.length,
    timed_out: timedOut,
    usage,
    duration_ms: durationMs,
  });

  return { runId, reply, plan };

  /**
   * 记一条用量流水（每次模型调用一行，C-USAGE）。
   *
   * 与 ask-run 里那份是同一套约定，只是这里**没有 run 级记录表要落**。
   * 写不进去不许影响主流程：流水是辅助记录，不是事实来源。
   */
  function recordUsage(messageUsage: Usage, turn: number): void {
    try {
      insertUsageEvent(deps.db, {
        eventId: `${runId}:${turn}`,
        runId,
        // 阶段 1–3 没有登录，与 documents.uploaded_by 同一个判断：宁可留空。
        userId: null,
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
      console.error(`[${logId}] 用量流水落库失败（不影响本次整理）：`, err);
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
  console.log(`[${id}] organize ${JSON.stringify({ run_id: runId, ...entry })}`);
}
