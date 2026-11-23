/**
 * 全系统统一的错误码。
 *
 * 为什么要有这个枚举，而不是随手抛 new Error('xxx')：
 *   1. 调用方（前端、Agent、定时任务）需要据此判断"重试还是放弃"。
 *      字符串报错无法可靠判断，只能靠 includes('timeout') 这种脆弱匹配。
 *   2. 这是我们从参考项目学到的核心教训：瞬时限流要退避重试，
 *      而参数错误重试一万次也是错的，白白烧 token。
 */
export type ErrorCode =
  /** 调用方传参有问题 —— 重试无意义，立刻失败 */
  | 'invalid_argument'
  /** 资源不存在 */
  | 'not_found'
  /** 已登录但无权限 */
  | 'permission_denied'
  /** 未登录 */
  | 'unauthenticated'
  /** 上游限流 —— 可重试，需退避 */
  | 'rate_limited'
  /** 上游 5xx / 网络抖动 —— 可重试 */
  | 'upstream_unavailable'
  /** 上下文超长 —— 重试无用，必须先裁剪输入 */
  | 'context_overflow'
  /** 模型账户余额/额度问题 —— 重试无用，必须人工处理 */
  | 'quota_exceeded'
  /**
   * 磁盘放不下 —— 重试无用，必须先清空间。
   *
   * 【为什么单开一个码，而不是复用 invalid_argument】
   *   上报是 GB 级的：空间不足是最可能撞上的失败，而它和"参数写错了"
   *   要做的事完全相反（一个去清盘、一个去改请求）。归到 invalid_argument
   *   的话，界面标题会显示成「参数有误」——把用户引向完全错误的方向，
   *   而这条错误恰恰是在传了几个小时之后才出现的。
   */
  | 'insufficient_storage'
  /** 上游 API Key 无效/已失效 —— 重试无用，必须换密钥 */
  | 'auth_failed'
  /** 我们自己的代码 bug */
  | 'internal';

/**
 * 哪些错误值得重试。集中定义，避免每个调用点各自判断、口径不一。
 *
 * 注意 context_overflow 和 quota_exceeded 都【不可重试】：
 * 前者重试还是超长，后者重试还是没额度。把它们和限流混为一谈，
 * 是很多 Agent 项目烧光预算的头号原因。
 */
export const RETRYABLE_CODES: readonly ErrorCode[] = [
  'rate_limited',
  'upstream_unavailable',
] as const;

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE_CODES.includes(code);
}

/**
 * HTTP 响应里错误体的形状。前端拿到后可以直接读 code 决定行为，
 * 不必解析 message 文案（文案随时可能改）。
 */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    /** 给用户看的中文说明 */
    message: string;
    /** 给用户看的短标题，界面可直接展示 */
    title: string;
    /** 调用方是否应重试 */
    retryable: boolean;
    /** 建议退避毫秒数，仅 retryable 时有意义 */
    retryDelayMs?: number;
    /** 排查用：把这个 ID 报给管理员即可在日志里定位整条链路 */
    requestId: string;
  };
}

/**
 * 后端内部使用的错误类。抛出它，全局错误中间件会自动转成 ApiErrorBody。
 *
 * 为什么不用 Hono 的 HTTPException：HTTPException 只带状态码和文本，
 * 丢掉了 code / retryable / retryDelayMs —— 而这些正是调用方最需要的。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryDelayMs: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { httpStatus?: number; retryDelayMs?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? DEFAULT_HTTP_STATUS[code];
    this.retryDelayMs = options.retryDelayMs;
  }

  get retryable(): boolean {
    return isRetryable(this.code);
  }
}

const DEFAULT_HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_argument: 400,
  not_found: 404,
  unauthenticated: 401,
  permission_denied: 403,
  rate_limited: 429,
  upstream_unavailable: 502,
  context_overflow: 413,
  quota_exceeded: 402,
  // 507 Insufficient Storage 就是为这一件事定的状态码，比 400 准确得多：
  // 请求本身没有任何问题，是这台机器放不下。
  insufficient_storage: 507,
  // 上游密钥失效是【我们的】配置问题，不是调用方的问题，
  // 因此以 5xx 返回：客户端的请求本身没错，重试也不会有用。
  auth_failed: 502,
  internal: 500,
};
