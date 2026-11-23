/**
 * 阶段 0 验收脚本：npm run smoke
 *
 * 它验证的不是"能打印出一段话"，而是四件事连成的一条链路：
 *   1. 配置能读到（缺 API Key 时给出人话提示，而不是 undefined 报错）
 *   2. 模型目录能查到（模型 ID 写错立刻失败并列出可用项）
 *   3. 流式调用 + 重试策略能跑通（用的是 pi-ai 自带的重试循环）
 *   4. 用量与费用能拿到（这是需求 7「token 预算统计」的地基）
 *
 * 第 4 点尤其重要：pi-ai 的 Usage 里直接带 cost，我们不需要自己
 * 维护一张价目表、也不需要自己数 token —— 那两件事都极易出错，
 * 而且模型涨价时必然忘记更新。
 */
import {
  contentText,
  retryAssistantCall,
  type AssistantMessage,
  type Context,
  type RetryPolicy,
} from '@earendil-works/pi-ai';
import { loadConfig, requireApiKey } from '../config.ts';
import { createLabModels, DEFAULT_CHAT_MODEL, DEEPSEEK, resolveRuntimeModel } from './models.ts';
import { toAppError } from './classify.ts';

async function main(): Promise<void> {
  const cfg = loadConfig();
  requireApiKey(cfg); // 缺 key 在这里就停，提示怎么写 .env

  const models = createLabModels();
  // 这是纯 `.env` 的探活脚本（不读 `system_config` 表），所以模型名也只认 `.env` + 内置默认。
  const { model } = resolveRuntimeModel(
    models,
    DEEPSEEK,
    cfg.modelChat ?? DEFAULT_CHAT_MODEL,
    DEFAULT_CHAT_MODEL,
  );

  console.log(`模型：${DEEPSEEK}/${model.id}`);
  console.log(`上下文窗口：${model.contextWindow.toLocaleString()} tokens`);
  console.log(`价格（USD / 百万 token）：输入 ${model.cost.input}，输出 ${model.cost.output}`);
  console.log(`输出上限：${model.maxTokens.toLocaleString()} tokens`);
  console.log('─'.repeat(60));

  const context: Context = {
    systemPrompt: '你是知识协作智能体 KnowPilot。用中文回答，简洁，不要客套。',
    messages: [{ role: 'user', content: '你好', timestamp: Date.now() }],
  };

  // 重试策略：最多再试 2 次，首次退避 1s，之后 2s。
  // pi-ai 会自动跳过不可重试的错误（余额不足、密钥失效等），
  // 所以这里不需要再写"哪些错误该重试"的判断。
  const policy: RetryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 1000 };

  let attempt = 0;
  const produce = async (): Promise<AssistantMessage> => {
    attempt += 1;
    const isFirstAttempt = attempt === 1;
    const stream = models.stream(model, context);
    for await (const event of stream) {
      // 只在第一次尝试时打字输出：重试时再打一遍会让人误以为模型重复回答
      if (event.type === 'text_delta' && isFirstAttempt) {
        process.stdout.write(event.delta);
      }
    }
    return await stream.result();
  };

  const startedAt = Date.now();
  const message = await retryAssistantCall(produce, policy, undefined, {
    onRetryScheduled: (n, max, delayMs, errorMessage) => {
      console.log(`\n[重试] 第 ${n}/${max} 次，${delayMs}ms 后。原因：${errorMessage}`);
    },
    onRetryFinished: (success, _n) => {
      if (!success) console.log('[重试] 已用尽重试次数，仍失败。');
    },
  });
  const elapsedMs = Date.now() - startedAt;

  console.log('\n' + '─'.repeat(60));

  const error = toAppError(message, model.contextWindow);
  if (error !== null) {
    // 这里展示分类器的价值：拿到的不是一句字符串，而是可编程的错误码。
    console.log(`失败：stopReason=${message.stopReason}`);
    console.log(`  错误码   : ${error.code}`);
    console.log(`  可重试   : ${error.retryable ? '是' : '否'}`);
    if (error.retryDelayMs !== undefined) {
      console.log(`  建议退避 : ${error.retryDelayMs}ms`);
    }
    console.log(`  说明     : ${error.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`回答（完整文本）：${contentText(message.content)}`);
  console.log(`stopReason：${message.stopReason}`);
  console.log(`耗时：${elapsedMs}ms，尝试次数：${attempt}`);
  console.log('用量与费用：');
  console.log(`  输入 tokens : ${message.usage.input.toLocaleString()}`);
  console.log(`  输出 tokens : ${message.usage.output.toLocaleString()}`);
  console.log(`  缓存读 tokens: ${message.usage.cacheRead.toLocaleString()}`);
  console.log(`  合计 tokens : ${message.usage.totalTokens.toLocaleString()}`);
  console.log(`  费用（USD） : ${message.usage.cost.total.toFixed(6)}`);
  console.log('\n阶段 0 验收通过。');
}

main().catch((err: unknown) => {
  console.error('\n启动失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
