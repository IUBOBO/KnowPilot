/**
 * 回答下方的「下一步」出口（O16）。
 *
 * 只有台账确实没有匹配记录或查询失败时才给操作入口。
 *
 * 【为什么用最后一次成功调用，而不是"只要出现过 0 就报"】模型可以先查一个
 * 关键词没中、再换一个关键词查到。首次 0 次的结果已经被后一次覆盖，
 * 再提示"台账里没有"就是假话。
 */
import type { AskNextAction } from '@knowpilot/shared';
import { DATASET_TOOL, PATENTS_TOOL, SUBMISSIONS_TOOL, THESES_TOOL } from './live-tools.ts';
import { JOURNAL_TOOL } from './journal-tool.ts';

export interface NextActionSignal {
  name: string;
  /** 与 `ToolCallLog` 对齐：没有命中数概念的工具可以不带这个字段。 */
  hitCount?: number | null;
  matchedCount?: number;
  isError: boolean;
}

export interface NextActionInput {
  toolTrace: readonly NextActionSignal[];
  /** 本次回答最终保留的引用条数（文档 + 记录）。 */
  citationCount: number;
  /** `answer.evidenceGaps` 的条数。 */
  gapCount: number;
}

function lastSuccessfulHit(
  trace: readonly NextActionSignal[],
  toolName: string,
): number | null {
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const entry = trace[i];
    if (entry !== undefined && entry.name === toolName && !entry.isError) {
      return entry.matchedCount ?? entry.hitCount ?? null;
    }
  }
  return null;
}

export function suggestNextActions(input: NextActionInput): AskNextAction[] {
  const actions: AskNextAction[] = [];

  if (lastSuccessfulHit(input.toolTrace, SUBMISSIONS_TOOL) === 0) {
    actions.push({
      kind: 'register-submission',
      label: '查看投稿台账',
      to: '/submissions',
      hint: '当前可查看的投稿中没有匹配项',
    });
  }
  if (lastSuccessfulHit(input.toolTrace, JOURNAL_TOOL) === 0) {
    actions.push({
      kind: 'add-journal',
      label: '去期刊分区库补录',
      to: '/journals',
      hint: '分区库里没有对应的记录',
    });
  }
  if (lastSuccessfulHit(input.toolTrace, DATASET_TOOL) === 0) {
    actions.push({
      kind: 'register-dataset',
      label: '去登记数据集',
      to: '/datasets',
      hint: '没有登记过匹配的数据集',
    });
  }
  if (lastSuccessfulHit(input.toolTrace, PATENTS_TOOL) === 0) {
    actions.push({ kind: 'check-patents', label: '查看专利登记', to: '/patents', hint: '当前可查看的专利中没有匹配项' });
  }
  if (lastSuccessfulHit(input.toolTrace, THESES_TOOL) === 0) {
    actions.push({ kind: 'check-theses', label: '查看大论文登记', to: '/theses', hint: '当前可查看的大论文中没有匹配项' });
  }

  // 两类记录都没查到、但用户可能问的是"资料在哪"时不堆四个按钮：
  // 记录类出口更具体，先给它们；最多两个，避免一排按钮又变成新的杂音。
  if (actions.length > 0) return actions.slice(0, 2);

  if (input.citationCount === 0 && input.gapCount > 0) {
    const failed = input.toolTrace.some((step) => step.isError &&
      step.name !== 'submit_answer' && step.name !== 'repair_quotes' &&
      lastSuccessfulHit(input.toolTrace, step.name) === null);
    if (failed) {
      return [{ kind: 'retry-query', label: '重新查询', to: '/ask', hint: '这次没有完成查询，请再试一次' }];
    }
  }

  return [];
}
