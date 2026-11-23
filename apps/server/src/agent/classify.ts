/**
 * 把 pi-ai 的失败消息翻译成我们自己的错误码。
 *
 * 为什么需要这一层（这是从两个参考项目里学到的最重要的一课）：
 *   pi-ai 对失败只给一个 `errorMessage: string`，不给结构化错误码。
 *   而"要不要重试"完全取决于失败的**性质**：
 *     · 限流 / 网络抖动  → 退避后重试有意义
 *     · 余额不足 / 密钥失效 / 上下文超长 → 重试一万次同样失败，
 *       只会白白烧钱并让用户多等
 *   如果拿不到结构化的性质，调用方就只能靠字符串猜，或者干脆统一重试 ——
 *   后者正是很多 Agent 项目烧光预算的根因。
 *
 * 所以：分类器的输出必须是**有限枚举**，而不是字符串。
 * 注意分类的顺序是有语义的（见 toAppError 内的注释），改动顺序会改变行为。
 */
import { isContextOverflow, isRetryableAssistantError } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { AppError } from '@knowpilot/shared';

/** 限流：稍等重试真的会好，退避要够长（DeepSeek 按分钟计窗口） */
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /rate\s*limit/i,
  /too many requests/i,
  /\b429\b/,
  /\bTPM\b|\bRPM\b/,
  /请求(过于)?频繁|限流/,
];

/** 余额/额度：重试无用，必须人工充值 */
const QUOTA_PATTERNS: readonly RegExp[] = [
  /insufficient\s+balance/i,
  /exceeded your current quota/i,
  /quota/i,
  /billing/i,
  /余额不足|欠费|额度不足/,
];

/** 密钥问题：重试无用，必须换 key */
const AUTH_PATTERNS: readonly RegExp[] = [
  /invalid\s+api\s*key/i,
  /authentication\s+fails?/i,
  /\b401\b/,
  /\b403\b/,
  /api\s*key.*(missing|required)/i,
  /密钥无效|鉴权失败/,
];

/** 网络层抖动：可重试，但退避短一点 */
const NETWORK_PATTERNS: readonly RegExp[] = [
  /fetch failed/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/,
  /socket hang up/i,
  /network\s*error/i,
  /连接失败|网络异常/,
];

function matches(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * 失败消息 → AppError。成功时返回 null（调用方据此判断是否出错）。
 *
 * @param message       pi-ai 返回的助手消息（含 stopReason 与 errorMessage）
 * @param contextWindow 该模型的上下文窗口，用于识别"静默溢出"
 *                      （某些 provider 不报错，只是悄悄截断）
 */
export function toAppError(message: AssistantMessage, contextWindow?: number): AppError | null {
  // 只有 stopReason === 'error' 才是失败。
  // 'aborted' 是调用方主动取消，不算错误 —— 把它当错误处理会导致
  // 用户点"停止"后界面弹出报错。
  if (message.stopReason !== 'error') return null;

  const raw = message.errorMessage ?? '(无错误信息)';

  // 顺序即优先级，不能随意调换：
  // 1) 先判上下文超长。超长的报错文案里经常夹带 "400" 和 "invalid"，
  //    若先跑通用匹配会被误判成参数错误，从而给出错误的处理建议。
  if (isContextOverflow(message, contextWindow)) {
    return new AppError(
      'context_overflow',
      `输入超出模型上下文上限，需要先裁剪检索结果再重试。原始信息：${raw}`,
    );
  }

  // 2) 再判密钥与余额。这两个都【不可重试】，必须排在限流之前 ——
  //    否则会被限流规则先捕获，导致系统对着一个没钱的账户反复重试。
  if (matches(AUTH_PATTERNS, raw)) {
    return new AppError('auth_failed', `上游模型鉴权失败，请检查 DEEPSEEK_API_KEY。原始信息：${raw}`);
  }
  if (matches(QUOTA_PATTERNS, raw)) {
    return new AppError('quota_exceeded', `模型账户额度不足，需要人工充值。原始信息：${raw}`);
  }

  // 3) 交由 pi-ai 自己判断是否属于"瞬时可重试"。
  //    直接用它而不是我们再写一套，是因为它已经覆盖了各家的报错措辞，
  //    并且明确把配额/计费类排除在外。重复实现只会带来两套会各自漂移的判断。
  if (isRetryableAssistantError(message)) {
    if (matches(RATE_LIMIT_PATTERNS, raw)) {
      return new AppError('rate_limited', `模型限流：${raw}`, { retryDelayMs: 5000 });
    }
    return new AppError('upstream_unavailable', `上游暂时不可用：${raw}`, { retryDelayMs: 2000 });
  }

  if (matches(NETWORK_PATTERNS, raw)) {
    return new AppError('upstream_unavailable', `网络异常：${raw}`, { retryDelayMs: 1000 });
  }

  // 兜底：归为 internal 且【不可重试】。
  // 未知失败很可能是我们自己的 bug，自动重试只会让它再炸一次。
  return new AppError('internal', `模型调用失败（未归类的错误）：${raw}`);
}
