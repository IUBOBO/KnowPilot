import { useEffect, useState } from 'react';
import type { AskStatusEvent } from '@knowpilot/shared';
import { AskWarningNotice } from '../../components/AskWarningNotice.tsx';

/**
 * 流式过程中累积的一步（O9）。
 *
 * 新版 status 用 stepId 对齐开始与结束，durationMs 是服务端实测。
 * 旧服务没有结束字段时保留相邻事件估算；evidence 落在最近的检索步骤上。
 */
export interface TimelineStep {
  label: string;
  stepId?: string;
  durationMs?: number;
  /** 相对本次提问开始的毫秒偏移 */
  atMs: number;
  /** 这一步新增的证据条数（没有则是 0） */
  added: number;
  /** 这一步结束后证据池的累计条数 */
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

export function activityLabel(event: AskStatusEvent): string {
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
}

export function QueryDetails({ steps, elapsedMs = 0, runningSince, warnings = [] }: AskProcessProps) {
  if (steps.length === 0 && warnings.length === 0) return null;
  return (
    <details className="ask-query-details">
      <summary>查询过程</summary>
      {steps.length > 0 && (
        <ol className="ask-query-steps">
          {steps.map((step, i) => {
            const nextStep = steps[i + 1];
            const end = nextStep?.atMs ?? elapsedMs;
            const ms = step.durationMs ?? Math.max(0, end - step.atMs);
            return (
              <li key={step.stepId ?? i}>
                <span>{step.label.replace(/^正在/u, '')}</span>
                <span className="ask-query-duration">
                  {step.added > 0 && `找到 ${step.added} 条 · `}
                  {runningSince !== undefined && nextStep === undefined && step.durationMs === undefined
                    ? <LiveElapsedTime startedAt={runningSince + step.atMs} /> : formatElapsed(ms)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <AskWarningNotice warnings={warnings} />
    </details>
  );
}
