/**
 * 问答结果的文案与配色。
 *
 * 【为什么提出来单独放】「问答记录」页与管理端概览都要显示同一批结果，
 *   而两处各写一份的话，加一个新 outcome 时必然漏一处 —— 漏掉的那处
 *   会显示成 `undefined`（还是渲染得出来，所以不会报错，只会看着奇怪）。
 *   这与 `SystemHealth` 被提出来是同一条理由。
 */
import type { AskOutcome } from '@knowpilot/shared';

export const OUTCOME_LABELS: Record<AskOutcome, string> = {
  ok: '正常完成',
  timeout: '超时',
  model_error: '模型出错',
  exception: '异常',
  aborted: '已中止',
};

/**
 * 结果对应的配色。
 *
 * 只有 `ok` 是绿的；`aborted`（用户自己点了停止）也不算错误，用中性色 ——
 * 把它涂红会让"我主动停掉的一次提问"看起来像一次故障。
 */
export function outcomeTone(outcome: AskOutcome): string {
  if (outcome === 'ok') return 'ok';
  if (outcome === 'aborted') return '';
  return 'err';
}
