import { useEffect, useState } from 'react';
import { MATERIAL_LABELS } from '@knowpilot/shared';
import type { AskProcessEventV1, AskProcessPhase, AskProcessSource, AskProcessStep, AskProcessV1, AskStatusEvent } from '@knowpilot/shared';
import { AskWarningNotice } from '../../components/AskWarningNotice.tsx';

/**
 * 流式过程中累积的一步（O9）。
 *
 * 新版 status 用 stepId 对齐开始与结束，durationMs 是服务端实测。
 * 旧服务没有结束字段时保留未知耗时；evidence 落在最近的检索步骤上。
 */
export interface TimelineStep {
  label: string;
  stepId?: string;
  durationMs?: number;
  /** 相对本次提问开始的毫秒偏移 */
  atMs: number;
  /** 这一步新增的证据条数（没有则是 0） */
  added: number;
}

export function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(2)} 秒`;
}

export function LiveElapsedTime({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), 30);
    return () => window.clearInterval(id);
  }, []);
  return formatElapsed(Math.max(0, now - startedAt));
}

const PHASE_LABEL: Record<AskProcessPhase, string> = {
  intent: '识别问题类型', understanding: '理解追问', resume: '恢复已有证据',
  retrieval: '查找资料', generation: '组织回答', quote_repair: '补全引用摘录', verification: '核验回答与引用',
};
const SOURCE_LABEL: Record<AskProcessSource, string> = {
  documents: '检索文档', paper: '阅读论文原文', submissions: '查询投稿台账', datasets: '查询数据集',
  journals: '查询期刊分区', patents: '查询专利', theses: '查询大论文', people: '查询人员档案',
};
const MODE_LABEL = { keyword: '关键词', semantic: '语义', hybrid: '混合' };

function processLabel(step: AskProcessStep): string {
  const label = step.source === undefined ? PHASE_LABEL[step.phase] : SOURCE_LABEL[step.source];
  return step.supplementary === true ? `补查 · ${label}` : label;
}

export function appendProcess(current: AskProcessV1 | undefined, event: AskProcessEventV1): AskProcessV1 {
  const steps = [...(current?.steps ?? [])];
  const position = steps.findIndex((step) => step.order === event.step.order);
  if (position < 0) steps.push(event.step);
  else steps[position] = event.step;
  return { version: 1, steps, counts: event.counts };
}

export function activityLabel(event: AskStatusEvent): string {
  if (event.process?.version === 1 && event.process.step !== undefined) return `正在${processLabel(event.process.step)}`;
  if (event.phase === 'understanding') return '正在理解问题';
  if (event.phase === 'generation') return '正在整理回答';
  if (event.phase === 'quote_repair' || event.phase === 'verification') return '正在整理来源';
  if (event.message.startsWith('正在查') || event.message.startsWith('正在核对数据集')) {
    return event.message.replace(/…$/u, '');
  }
  return event.phase === 'retrieval' || event.message.includes('检索') ? '正在查找资料' : '正在准备回答';
}

export interface AskProcessProps {
  steps: readonly TimelineStep[];
  elapsedMs?: number;
  runningSince?: number | undefined;
  warnings?: readonly string[];
  process?: AskProcessV1 | undefined;
  endState?: 'cancelled' | 'failed' | undefined;
  showUnavailable?: boolean;
}

export function QueryDetails({ process, steps, elapsedMs, runningSince, warnings = [], endState, showUnavailable }: AskProcessProps) {
  if (process?.version !== 1 || !Array.isArray(process.steps) || !process.counts) {
    if (steps.length === 0) {
      return showUnavailable || warnings.length > 0 ? (
        <>
          {showUnavailable && <p className="ask-query-details dim">查询过程不可用（此历史回答未保存执行事件）。</p>}
          <AskWarningNotice warnings={warnings} />
        </>
      ) : null;
    }
    return (
      <details className="ask-query-details">
        <summary>查询过程</summary>
        <ol className="ask-query-steps">
          {steps.map((step, index) => (
            <li key={step.stepId ?? index}>
              <span>{step.label.replace(/^正在/u, '')}</span>
              <span className="ask-query-duration">
                {step.added > 0 && `找到 ${step.added} 条证据 · `}
                {step.durationMs === undefined ? '耗时未知' : formatElapsed(step.durationMs)}
              </span>
            </li>
          ))}
        </ol>
        <AskWarningNotice warnings={warnings} />
      </details>
    );
  }

  const { counts } = process;
  const candidateCount = counts.candidates ??
    (process.steps.some((step: AskProcessStep) => step.phase === 'retrieval' && step.state !== 'skipped') ? '未观察到' : '检索未执行');
  const summary = [
    counts.documents === undefined ? undefined : `${counts.documents} 份文档`,
    counts.pooled === undefined ? undefined : `${counts.pooled} 条证据`,
    elapsedMs === undefined ? undefined : formatElapsed(elapsedMs),
  ].filter((part) => part !== undefined);
  return (
    <details className="ask-query-details">
      <summary>查询过程{summary.length > 0 && ` · ${summary.join(' · ')}`}</summary>
      <p className="ask-query-duration">
        候选（逐次合计）{candidateCount} · 入池 {counts.pooled ?? '未观察到'} ·
        {' '}模型上下文 {counts.modelVisible ?? '未观察到'} · 终稿引用 {counts.citations ?? '未生成'}
      </p>
      <ol className="ask-query-steps">
        {process.steps.map((step: AskProcessStep) => {
          const running = step.state === 'running' && endState === undefined && runningSince !== undefined;
          const stopped = step.state === 'running' && !running;
          const status = step.state === 'failed' || (stopped && endState === 'failed') ? '失败'
            : step.state === 'interrupted' || stopped ? '中断'
            : step.state === 'skipped' ? '证据额度用尽 · 未检索' : undefined;
          const detail = [
            status,
            step.lookup === undefined ? undefined : `子查询（词已脱敏）· 步骤 ${step.order + 1} · 请求 ${MODE_LABEL[step.lookup.requestedMode]} · ${step.lookup.scope === 'document' ? '单文档' : '资料库'} · 上限 ${step.lookup.limit}`,
            step.lookup?.material === undefined ? undefined : MATERIAL_LABELS[step.lookup.material],
            step.actualMode === undefined ? undefined : MODE_LABEL[step.actualMode],
            step.candidates === undefined ? undefined : `候选 ${step.candidates}`,
            step.newEvidence === undefined ? undefined : `新增证据 ${step.newEvidence}`,
            step.ranking === 'reranked' ? (step.rankedCandidates === undefined ? '已重排' : `已重排 ${step.rankedCandidates} 条`)
              : step.ranking === 'fallback' ? '重排回退' : undefined,
            step.rankingMs === undefined ? undefined : `重排耗时 ${formatElapsed(step.rankingMs)}`,
            step.degraded === true ? '降级' : undefined,
            step.durationMs === undefined ? undefined : formatElapsed(step.durationMs),
          ].filter((part) => part !== undefined);
          return (
            <li key={step.order}>
              <span>{processLabel(step)}</span>
              <span className="ask-query-duration">
                {detail.join(' · ')}
                {running && runningSince !== undefined && <LiveElapsedTime startedAt={runningSince + step.atMs} />}
              </span>
            </li>
          );
        })}
      </ol>
      <AskWarningNotice warnings={warnings} />
    </details>
  );
}
