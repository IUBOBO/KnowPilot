/**
 * 后端调用封装。所有页面共用这一处，不各自写 fetch。
 *
 * 为什么值得单独一层：
 *   1. 后端所有错误都是同一个结构化形状（code / title / message / retryable / requestId）。
 *      散在各页面里解析，就会出现"这个页面显示请求 ID、那个页面只弹一句 500"的不一致，
 *      而排查线上问题时那个 ID 恰恰是最需要的东西。
 *   2. 网络层失败（后端没起、被防火墙拦）本身不产生 HTTP 响应，
 *      需要在这里合成为一个和业务错误同形状的对象，页面才不用写两套分支。
 */
import type { ApiErrorBody, AskStreamEvent, ErrorCode } from '@knowpilot/shared';

/** 带结构化错误体的异常。页面捕获它就能直接渲染后端给的标题与建议。 */
export class ApiError extends Error {
  readonly body: ApiErrorBody;

  constructor(body: ApiErrorBody) {
    super(body.error.message);
    this.name = 'ApiError';
    this.body = body;
  }
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const e = (value as { error?: unknown }).error;
  if (typeof e !== 'object' || e === null) return false;
  const { code, message, title } = e as Record<string, unknown>;
  return typeof code === 'string' && typeof message === 'string' && typeof title === 'string';
}

function synthetic(
  code: ErrorCode,
  title: string,
  message: string,
  retryable: boolean,
  requestId = '-',
): ApiError {
  return new ApiError({ error: { code, title, message, retryable, requestId } });
}

/**
 * 一次请求的附加行为，与 `RequestInit` 分开写：
 * `RequestInit` 是"怎么发这个请求"，这里是"收到响应之后本应用要额外做
 * 什么"。混在一起的话，将来给 fetch 加参数时容易把它们搞混。
 */
export interface RequestOptions {
  /** GET requests that revalidate evidence access can bypass browser caches. */
  cache?: RequestCache;
  /**
   * 401 时不跳登录页，照常抛 `ApiError`。
   *
   * 只给**探活**用：`GET /api/v1/auth/me` 的 401 意思是"你还没登录"，
   * 那是应用启动时的正常状态，不是会话中途过期。在那里跳转的话，
   * 未登录的人一打开首页就会被弹到登录页，而这是本来就要发生的正常流程 ——
   * 由 `<RequireAuth>` 决定跳不跳，不该在这一层抢先决定。
   */
  noAuthRedirect?: boolean;
}

/**
 * 会话失效时把用户送回登录页。
 *
 * 【为什么带 `next`】不带的话，用户在某个深链接上被弹到登录页，登录完
 *   只会回到首页，刚才那一页就找不回来了 —— 而"打开链接 → 提示要登录 →
 *   登录 → 停在登录页"是很自然的用法。
 *
 * 【为什么已经在 `/login` 时什么都不做】登录失败的响应就是 401。
 *   不排除这一条，用户每输错一次密码就会触发一次"跳到 /login"，
 *   地址栏看着没变但 history 里多一条、页面组件重挂 ——
 *   刚渲染出来的"用户名或密码不正确"会一闪而过，看起来像没反应。
 *
 * 【为什么用整页跳转而不是路由的 navigate】`api.ts` 被 router 那一侧的所有
 *   页面引用，反过来 import router 会形成环。而这里要处理的正是"会话已经
 *   不成立了"这个状态，整页重载顺带把内存里所有页面状态清干净，
 *   反而比保住 SPA 状态更稳妥。
 */
function redirectToLogin(): void {
  if (window.location.pathname === '/login') return;
  const next = window.location.pathname + window.location.search;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

async function request<T>(path: string, init?: RequestInit, opts?: RequestOptions): Promise<T> {
  let res: Response;
  try {
    // credentials 必须显式带上：会话是 httpOnly cookie，而 fetch 的默认值
    // 是 'same-origin' —— 开发期前端在 5173、后端在 3000，走 Vite 代理时
    // 算同源所以碰巧能过；一旦部署成前后端不同源，默认值就会静默丢掉
    // Set-Cookie，症状是"登录成功但下一个请求仍然 401"。
    res = await fetch(path, { credentials: 'include', ...init });
  } catch (err) {
    // AbortError 是我们自己主动取消的（组件卸载、发起了新请求），不是故障，
    // 原样抛出交给调用方忽略。把它显示成"无法连接后端"会误导用户。
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw synthetic(
      'upstream_unavailable',
      '无法连接后端',
      '请求没能发到后端。确认 npm run dev 已在运行、端口 3000 没有被别的进程占用。',
      true,
    );
  }

  // 先读文本再解析：后端正常时总是 JSON，但反向代理/网关出错时会返回 HTML 错误页，
  // 直接 res.json() 会抛出一个和真实原因毫无关系的 "Unexpected token <"。
  const raw = await res.text();
  let parsed: unknown = null;
  try {
    parsed = raw === '' ? null : JSON.parse(raw);
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    // 401 只有一种含义：这个请求需要一个有效会话而没有。它和 403（身份有效但
    // 没这个权限）必须分开处理 —— 403 要显示成"你没权限"，不能拿登录页糊过去，
    // 否则用户会反复登录同一个账号，而问题根本不在登录上。
    if (res.status === 401 && opts?.noAuthRedirect !== true) redirectToLogin();
    if (isApiErrorBody(parsed)) throw new ApiError(parsed);
    throw synthetic(
      'internal',
      '服务返回了无法识别的响应',
      `HTTP ${res.status}，响应不是本服务的错误格式。若经过反向代理，请检查代理配置。`,
      false,
      res.headers.get('x-request-id') ?? '-',
    );
  }

  return parsed as T;
}

export function apiGet<T>(path: string, signal?: AbortSignal, opts?: RequestOptions): Promise<T> {
  const init: RequestInit = {
    ...(signal === undefined ? {} : { signal }),
    ...(opts?.cache === undefined ? {} : { cache: opts.cache }),
  };
  return request<T>(path, init, opts);
}

export function apiPostForm<T>(path: string, form: FormData, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: form,
    ...(signal !== undefined ? { signal } : {}),
  });
}

export function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });
}

/**
 * PUT 一段**裸字节**（分片上传用）。
 *
 * 【为什么不复用 apiPost 的 JSON 那条路】
 *   一片 8 MB，套一层 JSON 要 base64 编码 —— 体积涨三分之一，还要在服务端
 *   解一遍。multipart 同理，而这里没有别的字段要带，分片边界由序号决定，
 *   用不上 multipart 的分界符。
 *
 * 【为什么没有上传进度回调】
 *   `fetch` 不暴露已发送字节数（只有 XHR 的 upload.onprogress 有）。要换 XHR
 *   就得在这里再写一遍"非 2xx 时解析结构化错误体"的逻辑，而两套解析必然漂移。
 *   分片是一整片一次发完，进度按**已完成的分片数**算就够了 ——
 *   代价是进度条按分片跳，8 MB 一跳。
 */
export function apiPutBlob<T>(path: string, body: Blob, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
    ...(signal !== undefined ? { signal } : {}),
  });
}

export function apiPatch<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });
}

/**
 * DELETE 没有请求体，但**不是**不需要返回值：删除接口会把"删掉的是哪一条"
 * 回显回来，界面得拿它写提示（"已删除「XXX」"）。用 204 空响应就得到处
 * 自己拼这句话，而拼错的那一天没人会注意到。
 */
export function apiDelete<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: 'DELETE',
    ...(signal !== undefined ? { signal } : {}),
  });
}

/**
 * 发起一次流式 POST，边收边把事件交给调用方。
 *
 * 【为什么不用 EventSource】
 *   `EventSource` 只能发 GET、没有请求体，而提问必须把问题和勾选确认装在
 *   JSON 体里发出去 —— 那就只能 POST。于是用 `fetch` + `ReadableStream`
 *   自己解 SSE。协议本身很简单，但有几处必须照着做，见 parseSseFrame。
 *
 * 【这个函数什么时候会抛】
 *   · 请求本身没发出去 / 非 2xx 响应（含参数错误，那是在进流之前就返回的普通 JSON）
 *   · 流在收到 `verified_final` / `partial` / `interrupted` / `failed`
 *     **之前**就断了。最后这条是重点：连接被中途掐掉时，`reader` 只会安安静静地
 *     `done`，和"正常放完"长得一模一样。不在这里判一次，页面就会把半截草稿
 *     当完整的渲染出来 —— 一次静默的错误回答，比一次报错危险得多。
 *
 * 正常结束时**不抛**：四种终态事件都通过 `onEvent` 交给调用方处理，
 * 因为怎么显示是页面的事，这一层不该替它决定。
 */
export async function apiPostSse(
  path: string,
  body: unknown,
  onEvent: (event: AskStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      // 这条是**独立**的 fetch，不是 request() 那条，所以 credentials 与
      // 下面那个 401 分支都得各写一遍 —— 漏掉任何一处，鉴权一开，
      // 问答链路会以"无法连接后端"这种毫不相干的报错形式挂掉。
      credentials: 'include',
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw synthetic(
      'upstream_unavailable',
      '无法连接后端',
      '请求没能发到后端。确认 npm run dev 已在运行、端口 3000 没有被别的进程占用。',
      true,
    );
  }

  if (!res.ok) {
    // 与 request() 里同一套：先读文本再解析，代理返回 HTML 错误页时
    // 才能给出"响应不是本服务的错误格式"，而不是一句莫名其妙的 JSON 解析失败。
    const raw = await res.text();
    let parsed: unknown = null;
    try {
      parsed = raw === '' ? null : JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (res.status === 401) redirectToLogin();
    if (isApiErrorBody(parsed)) throw new ApiError(parsed);
    throw synthetic(
      'internal',
      '服务返回了无法识别的响应',
      `HTTP ${res.status}，响应不是本服务的错误格式。若经过反向代理，请检查代理配置。`,
      false,
      res.headers.get('x-request-id') ?? '-',
    );
  }

  if (res.body === null) {
    throw synthetic('internal', '流式响应没有响应体', '浏览器或代理把响应体丢掉了。', false);
  }

  const reader = res.body.getReader();
  // stream: true 让解码器把跨 chunk 截断的多字节字符攒着 ——
  // 中文一个字 3 字节，正好被切在中间时，不这么设就会解出乱码。
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;

  const handle = (event: AskStreamEvent): void => {
    if (
      event.type === 'verified_final' ||
      event.type === 'partial' ||
      event.type === 'interrupted' ||
      event.type === 'failed'
    ) {
      terminal = true;
    }
    onEvent(event);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 统一换行：协议允许 \r\n，Hono 只发 \n，但没必要对两种都写一遍分帧逻辑。
      buffer = buffer.replace(/\r\n/gu, '\n');

      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        // 只处理完整的帧。最后剩下的半帧留在 buffer 里等下一个 chunk ——
        // 拿半截 JSON 去 parse 必然抛，而那个"错误"只是网络把它切成了两半。
        parseSseFrame(buffer.slice(0, sep), handle);
        buffer = buffer.slice(sep + 2);
        sep = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!terminal) {
    throw synthetic(
      'upstream_unavailable',
      '连接中断',
      '回答还没输出完连接就断了。半截回答没有显示出来，请重试。',
      true,
    );
  }
}

/**
 * 解一个 SSE 帧。
 *
 * 只取 `data:` 行，丢弃 `event:` / `id:` / `retry:` 和以 `:` 开头的注释行 ——
 * 事件名已经写在 JSON 体的 `type` 里了，客户端以**体**为准。
 * 两处都读的话，就成了同一件事有两个来源，早晚会漂移。
 * （服务端仍然照发 `event:`，那是给 curl 和将来用 EventSource 的人看的。）
 */
function parseSseFrame(frame: string, onEvent: (event: AskStreamEvent) => void): void {
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue;
    // 规范规定冒号后若有一个空格要去掉 —— 只去一个，其余是数据本身。
    const value = line.slice(5);
    dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
  }
  if (dataLines.length === 0) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join('\n'));
  } catch {
    return;
  }

  // 逐个字段核对而不是整体 as：这条链路上有模型输出，万一掺进来一个
  // 形状不对的帧，宁愿当没收到，也不要让一个 undefined 字段流进渲染层。
  if (typeof parsed !== 'object' || parsed === null) return;
  const type = (parsed as { type?: unknown }).type;
  if (
    type !== 'status' &&
    type !== 'evidence' &&
    type !== 'draft_delta' &&
    type !== 'draft_reset' &&
    type !== 'verified_final' &&
    type !== 'partial' &&
    type !== 'interrupted' &&
    type !== 'failed'
  ) {
    return;
  }
  onEvent(parsed as AskStreamEvent);
}

/** 把任意异常归一成 ApiError，页面只需要处理一种错误类型。 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return synthetic('internal', '前端出现未预期的错误', message, false);
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
