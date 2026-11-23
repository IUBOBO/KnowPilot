/**
 * 模型集合的构造与查找。
 *
 * 为什么不直接 builtinModels()：
 *   那个函数会把 pi-ai 内置的 41 家 provider（OpenAI / Anthropic / Bedrock /
 *   Vertex / 各种国内厂商……）全部注册进来，连同它们的模型目录一起进包。
 *   我们只用 DeepSeek 一家，多余的部分是纯粹的体积和攻击面
 *   （每家 provider 都带自己的鉴权逻辑与 baseUrl）。
 *   这里显式只注册一家，是"按需引入"而不是"图省事全拿"。
 *
 * 【接口地址不在这里改】管理端可以配一个自定义的接口地址（指向中转站），但**不要**
 *   想着在这里 `createProvider({ baseUrl })` 去覆盖它 —— 见 `DEFAULT_BASE_URL` 的注释。
 */
import { createModels, type Model, type MutableModels, type Api } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { AppError } from '@knowpilot/shared';

export const DEEPSEEK = 'deepseek';

/** 两个模型槽位的内置默认值（也是"手填了目录外的名字"时用来克隆元数据的模板）。 */
export const DEFAULT_CHAT_MODEL = 'deepseek-flash';
export const DEFAULT_REASONER_MODEL = 'deepseek-v4-pro';

/**
 * 默认接口地址，取自 pi-ai 的 deepseek provider —— **单一来源，不抄一份到我们这**。
 *
 * 【为什么不能靠重建 provider 来换地址】DeepSeek 走的是 openai-completions 这条 API，
 *   而它建客户端时读的是 **`model.baseUrl`**（pi-ai `api/openai-completions.js`
 *   的 `new OpenAI({ baseURL: model.baseUrl })`），**provider 上的 baseUrl 在这条
 *   API 上是死的**。所以"指向中转站"这件事只能在**每次请求的 model 上**覆盖
 *   （落点是 `stream.ts` 的 createStreamFn），重建 provider 什么也改不了。
 *   这条踩过一次就很难查，写在这里。
 */
export const DEFAULT_BASE_URL: string = deepseekProvider().baseUrl ?? 'https://api.deepseek.com';

/** 构造只含 DeepSeek 的模型集合。 */
export function createLabModels(): MutableModels {
  const models = createModels();
  models.setProvider(deepseekProvider());
  return models;
}

/**
 * 查找模型，找不到就立刻失败并列出可用项。
 *
 * 这里必须 fail fast：模型 ID 写错（比如照抄 DeepSeek 官网的
 * "deepseek-chat"，而 pi-ai 目录里叫 "deepseek-flash"）时，
 * 如果不在这里拦住，问题会一路飘到运行时才以
 * "undefined is not a function" 之类的方式炸出来，排查成本高得多。
 *
 * 注意：**用户配的模型名不走这里**（那允许手填目录外的名字，见 `resolveRuntimeModel`）。
 * 这个函数只用于"必须存在于目录里"的内部场景（比如取模板）。
 */
export function requireModel(
  models: MutableModels,
  providerId: string,
  modelId: string,
): Model<Api> {
  const model = models.getModel(providerId, modelId);
  if (model === undefined) {
    const available = models
      .getModels(providerId)
      .map((m) => m.id)
      .join(', ');
    throw new AppError(
      'invalid_argument',
      `模型 "${providerId}/${modelId}" 不在 pi-ai 的目录中。` +
        `该 provider 当前可用：${available === '' ? '(无)' : available}。` +
        `注意模型 ID 要用 pi-ai 目录里的名字，不是厂商官网文档里的名字。`,
    );
  }
  return model;
}

/**
 * 把用户配的模型名解析成一个可用的 `Model`，**目录里没有也不报错**。
 *
 * 【为什么要允许目录外的名字】项目允许把接口地址指向第三方中转站，中转站上的
 *   模型名往往与 pi-ai 目录里的不一样（比如官方叫 `deepseek-chat`）。一律拒绝
 *   等于把这个功能砍掉一半。
 *
 * 【目录外怎么办：拿模板克隆一个 id】pi-ai 调模型要用到一堆元数据
 *   （api / provider / compat / contextWindow / maxTokens / cost / reasoning）。
 *   手填的名字没有这些，就用**同槽位的目录模型**（对话槽 → `deepseek-flash`，
 *   推理槽 → `deepseek-v4-pro`）当模板，只把 `id` 换掉：
 *   · `id` 必须换 —— 它就是发给上游的 `model` 字段，也是用量流水里的标识；
 *   · `api` / `provider` 绝不能动 —— provider 按 `api` 分发实现、按 `provider` 找集合；
 *     而且 `detectCompat` 判的第一件事就是 `provider === 'deepseek'`，保住它，
 *     即使地址换成了中转站也仍然按 DeepSeek 的口径发请求（thinkingFormat、
 *     max_tokens 字段名等都还对）；
 *   · `compat` / `reasoning` / `thinkingLevelMap` / `input` 也都不能动；
 *   · `contextWindow` / `maxTokens` / `cost` 保留模板值 —— 这就是"元数据按模板估算"
 *     的来源，会在界面上如实说明。代价见 `EffectiveModelSettings` 的注释。
 */
export function resolveRuntimeModel(
  models: MutableModels,
  providerId: string,
  modelId: string,
  templateId: string,
): { model: Model<Api>; inCatalog: boolean } {
  const exact = models.getModel(providerId, modelId);
  if (exact !== undefined) return { model: exact, inCatalog: true };
  const template = requireModel(models, providerId, templateId);
  return { model: { ...template, id: modelId }, inCatalog: false };
}
