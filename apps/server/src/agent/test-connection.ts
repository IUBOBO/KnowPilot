/**
 * 「测试连接」：往管理员配的接口地址发一次**极小的真实请求**，如实报告结果。
 *
 * 【为什么要真的发一次，而不是只做本地校验】接口地址与 key 是否被上游接受，
 *   本地无论怎么校验都推不出来 —— 地址能解析不代表对方听得懂，key 格式对不代表
 *   它属于这个服务商。这个按钮的价值就是"存之前先试一次"。
 *
 * 【为什么只花一次钱、只测对话模型】请求带 `maxTokens: 4`（最省的合法请求），
 *   且只对**对话模型**发。两个模型名只做本地目录校验：多测一次推理模型要再花一次钱，
 *   而它能验证的东西（key + 地址是否被接受）与对话模型完全重合。
 *   这一点在界面上写明 —— 它打的是**用户自己付费的端点**。
 *
 * 【为什么不回显上游的响应体】上游出错时返回的正文里常带它自己的提示、有时还回显
 *   一部分密钥。这里一律只给"中文结论 + HTTP 状态码"，正文只用于**本地分类**，
 *   一个字节都不出这道门。顺带也避免了它成为读内网的跳板。
 */
import type {
  TestConnectionKind,
  TestModelConnectionRequest,
  TestModelConnectionResponse,
} from '@knowpilot/shared';
import type { MutableModels } from '@earendil-works/pi-ai';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { catalogEntries, resolveModelSettings } from './model-config.ts';
import { DEFAULT_CHAT_MODEL, DEEPSEEK, resolveRuntimeModel } from './models.ts';

/** 测试请求的输出上限。够拿到一个 HTTP 状态码就行，不必真的说完一句话。 */
const TEST_MAX_TOKENS = 4;

/**
 * 测试请求的超时。比正常运行短得多：这是个交互式按钮，用户就等在页面上。
 * 15 秒足够一次跨境往返，超了就说明这个地址基本不可用。
 */
const TEST_TIMEOUT_MS = 15_000;

/** 留空（含只有空白）就回落到生效值 —— 与保存接口"留空 = 不覆盖"是同一个口径。 */
function pick(raw: string | undefined, fallback: string | undefined): string | undefined {
  const v = raw?.trim();
  if (v !== undefined && v !== '') return v;
  return fallback;
}

/** 每个分类对应一句给用户看的中文结论。**不含上游原文**。 */
const MESSAGES: Record<TestConnectionKind, string> = {
  ok: '连接成功：接口地址与 API key 都被上游接受。',
  auth: '鉴权失败：接口地址通了，但这把 API key 不被接受。请核对密钥是否正确、是否属于这个地址对应的服务商。',
  not_found:
    '接口路径不对：地址连得上，但对方没有这个接口（HTTP 404）。多数中转站要求地址末尾带上 /v1，请核对。',
  rate_limited: '被上游限流（HTTP 429）：地址与密钥多半是对的，只是请求太频繁或额度用尽。',
  bad_response:
    '上游拒绝了这次请求（HTTP 400/422）：地址通了、密钥大概率也对，但请求格式不被接受 —— 常见于把地址填成了某个具体端点，而不是服务根地址。',
  upstream: '上游服务端出错（HTTP 5xx）：地址通了，是对方那边的问题，稍后重试。',
  unreachable:
    '连不上这个地址：连接被拒或域名解析不了。请核对地址是否可达（本机网络、防火墙、是否需要代理）。',
  timeout: `请求超时：这个地址没有在 ${TEST_TIMEOUT_MS / 1000} 秒内响应。`,
  not_configured: '还没有 API key，无法测试（密钥框留空，系统里也没配过）。',
};

/**
 * 按 HTTP 状态码分类。有状态码时**优先用它**，不从正文猜 —— 正文的措辞随上游变，
 * 而状态码是 HTTP 协议的一部分。
 */
function kindByStatus(status: number): TestConnectionKind | null {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream';
  if (status >= 400) return 'bad_response';
  return null;
}

/**
 * 拿不到状态码时的兜底：只能从错误的文字里认几个众所周知的形状。
 *
 * 【为什么这里可以看正文，而对外不能】看正文是为了**分类**（连不上 vs 超时），
 *   分类结果用中文另写一遍给用户；正文本身不出门。这两件事不矛盾。
 */
function kindByMessage(message: string): TestConnectionKind {
  if (/timeout|timed out|aborted|ETIMEDOUT/i.test(message)) return 'timeout';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|Connection error|fetch failed|EHOSTUNREACH/i.test(message)) {
    return 'unreachable';
  }
  if (/\b401\b|\b403\b/.test(message)) return 'auth';
  if (/\b404\b/.test(message)) return 'not_found';
  if (/\b429\b/.test(message)) return 'rate_limited';
  return 'upstream';
}

export interface TestConnectionDeps {
  db: Db;
  config: AppConfig;
  models: MutableModels;
}

export async function testModelConnection(
  deps: TestConnectionDeps,
  input: TestModelConnectionRequest,
): Promise<TestModelConnectionResponse> {
  const effective = resolveModelSettings(deps.db, deps.config);
  const catalog = catalogEntries(deps.models);
  const inCatalog = (id: string): boolean => catalog.some((m) => m.id === id);

  const baseUrl = pick(input.baseUrl, effective.baseUrl) ?? effective.baseUrl;
  const chatModel = pick(input.chatModel, effective.chatModel) ?? effective.chatModel;
  const apiKey = pick(input.apiKey, effective.apiKey ?? undefined);

  const common = {
    baseUrl,
    chatModel,
    chatInCatalog: inCatalog(chatModel),
    reasonerModel: effective.reasonerModel,
    reasonerInCatalog: inCatalog(effective.reasonerModel),
  };

  if (apiKey === undefined) {
    // 没 key 就不出网。否则这次"测试"必然是一次注定 401 的付费请求。
    return { kind: 'not_configured', ok: false, httpStatus: null, message: MESSAGES.not_configured, elapsedMs: 0, ...common };
  }

  const { model } = resolveRuntimeModel(deps.models, DEEPSEEK, chatModel, DEFAULT_CHAT_MODEL);
  const requestModel = baseUrl === model.baseUrl ? model : { ...model, baseUrl };

  const startedAt = Date.now();
  let httpStatus: number | null = null;

  try {
    const message = await deps.models.completeSimple(
      requestModel,
      {
        systemPrompt: '这是一次连接测试。只需回复一个字。',
        messages: [{ role: 'user' as const, content: 'ping', timestamp: Date.now() }],
      },
      {
        apiKey,
        maxTokens: TEST_MAX_TOKENS,
        maxRetries: 0,
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        // 只取状态码。正文永远不进我们的响应体（见模块注释）。
        onResponse: (response) => {
          httpStatus = response.status;
        },
      },
    );

    if (message.stopReason === 'aborted') {
      return { kind: 'timeout', ok: false, httpStatus, message: MESSAGES.timeout, elapsedMs: Date.now() - startedAt, ...common };
    }
    if (message.stopReason === 'error') {
      // pi-ai 把 4xx/5xx 收成了"错误消息"而不是抛出，这里要一并认下。
      const kind = (httpStatus === null ? null : kindByStatus(httpStatus)) ?? kindByMessage(message.errorMessage ?? '');
      return { kind, ok: false, httpStatus, message: MESSAGES[kind], elapsedMs: Date.now() - startedAt, ...common };
    }

    // 有回话就是通了。`stopReason: 'length'` 是预期的（只给 4 个 token）。
    return { kind: 'ok', ok: true, httpStatus, message: MESSAGES.ok, elapsedMs: Date.now() - startedAt, ...common };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const kind = (httpStatus === null ? null : kindByStatus(httpStatus)) ?? kindByMessage(raw);
    return { kind, ok: false, httpStatus, message: MESSAGES[kind], elapsedMs: Date.now() - startedAt, ...common };
  }
}
