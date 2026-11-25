/**
 * pi-agent-core 要求的 StreamFn 与 pi-ai 的 Models 之间的适配层。
 *
 * 【为什么需要这一层：两边的签名不一样】
 *   StreamFn 要求 (model, context: TranscriptContext, options?: SimpleStreamOptions) => ...
 *   Models.streamSimple 是 (model, context: Context, options?: ModelsSimpleStreamOptions) => ...
 *
 *   TranscriptContext 是 Context 的子集（多一个内部 brand 字段），
 *   ModelsSimpleStreamOptions 是 SimpleStreamOptions 的超集（多了可选的 transformHeaders）。
 *   按结构化类型规则，`models.streamSimple` 本身就能赋值给 StreamFn。
 *
 *   所以这一层不是为了"转换类型"，而是为了**注入运行级的东西**：
 *   ① 截止信号：Agent 自己的 abort 只作用于循环本身，一个卡住不返回的 HTTP 请求
 *      不会被它取消。把运行级的 AbortSignal 合进每次请求的 signal，才能真正做到
 *      "5 分钟到了就不再等"。
 *   ② 接口地址与 API key：管理端配的地址/key 要作用到每一次请求上（见下）。
 */
import type { Model, Models, SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';

/**
 * 一次运行用的传输参数：接口地址 + API key。
 *
 * 【为什么要传进来，而不是在 provider 上配】pi-ai 里 DeepSeek 走的是
 *   openai-completions 这条 API，它建客户端时读的是 **`model.baseUrl`**
 *   （`new OpenAI({ baseURL: model.baseUrl })`），**provider 上的 baseUrl 是死的**。
 *   所以"指向中转站"只能在每次请求的 model 对象上覆盖。key 同理：pi-ai 的
 *   stream options 里带 `apiKey` 时会**直接采用、连环境变量都不看**，这正是
 *   "密钥只存在 `system_config` 表里、`.env` 不填也能用"成立的原因。
 *   （两处都在 `node_modules/@earendil-works/pi-ai/dist` 里逐行核过。）
 */
export interface ModelTransport {
  /** 本次运行的接口地址。由解析层兜底，永远有值。 */
  baseUrl: string;
  /** 本次运行的 key。null = 没有（调用方应更早已拦住，这里只是不覆盖）。 */
  apiKey: string | null;
}

/**
 * 合并两个 AbortSignal。
 *
 * 用 AbortSignal.any 而不是自己写 addEventListener 转发：手工转发要处理
 * "源信号已经 aborted"的竞态（此时 listener 不会再触发，必须额外判一次），
 * 而 AbortSignal.any 已经处理过这些边界。
 */
function mergeSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return AbortSignal.any([a, b]);
}

/**
 * 构造一个把 `runSignal` 与传输参数注入每次请求的 StreamFn。
 *
 * @param models    进程级共享的模型集合（不要每次请求重建，见 index.ts）
 * @param runSignal 运行级截止信号（超时或用户取消）。省略则只沿用调用方自己的 signal。
 * @param transport 本次运行要用的接口地址与 key。省略则完全沿用 model / 环境变量里带的东西。
 */
export function createStreamFn(
  models: Models,
  runSignal?: AbortSignal,
  transport?: ModelTransport,
  onRequestStart?: (context: Parameters<StreamFn>[1]) => void,
): StreamFn {
  return (model, context, options?: SimpleStreamOptions) => {
    const signal = mergeSignals(runSignal, options?.signal);
    // exactOptionalPropertyTypes 开着，不能写 { ...options, signal: undefined }，
    // 必须按"有就带上"的方式构造。
    const withSignal = signal === undefined ? options : { ...options, signal };

    const requestModel: Model<typeof model.api> =
      transport !== undefined && transport.baseUrl !== ''
        ? { ...model, baseUrl: transport.baseUrl }
        : model;

    const requestOptions =
      transport !== undefined && transport.apiKey !== null
        ? { ...withSignal, apiKey: transport.apiKey }
        : withSignal;

    onRequestStart?.(context);
    return models.streamSimple(requestModel, context, requestOptions);
  };
}
