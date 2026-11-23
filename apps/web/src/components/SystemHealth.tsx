/**
 * 前后端连通性。
 *
 * 阶段 0 加它不是为了装饰：很多项目到很后面才发现代理没配好、CORS 没过、
 * 类型对不上，那时已经有几十个接口，排查成本高得多。留着它对排查仍然有用
 * —— 它显示的 schemaVersion 是"建库脚本跑没跑"最直接的证据。
 *
 * 【为什么从 HomePage.tsx 提出来】管理端概览（`/admin`）要显示同一块。
 *   同一份东西在两个页面出现时，复制一份的代价不是多写 60 行，而是
 *   **以后改一处忘一处**：比如将来把 /health 换成 /api/v1/health 时，
 *   只改了首页那份，管理端就静默地一直报"无法连接后端"。
 */
import { useCallback, useEffect, useState } from 'react';
import type { ApiErrorBody, HealthResponse } from '@knowpilot/shared';
import { Skeleton } from './Skeleton.tsx';

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ok'; data: HealthResponse }
  | { kind: 'error'; body: ApiErrorBody };

export function SystemHealth() {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/health', signal !== undefined ? { signal } : {});
      const body: unknown = await res.json();
      if (!res.ok) {
        setState({ kind: 'error', body: body as ApiErrorBody });
        return;
      }
      setState({ kind: 'ok', data: body as HealthResponse });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setState({
        kind: 'error',
        body: {
          error: {
            code: 'upstream_unavailable',
            title: '无法连接后端',
            message: '前端起来了，但连不上后端服务。确认 npm run dev:server 已在运行。',
            retryable: true,
            retryDelayMs: 1000,
            requestId: '-',
          },
        },
      });
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  return (
    <div className="card">
      <h2>系统状态</h2>
      {/* 骨架照着真实那一行的形状摆：一个 pill + 一段文字。
          这样"检查中"切到"已连通"时行高不变，整张卡不跳。
          原本的「检查中…」就是一个 pill —— 改成骨架不是嫌它难看，是因为
          它给不出**这一行最后有多长**，而那是判断"页面稳不稳"的唯一依据。
          无障碍：骨架自身 aria-hidden，所以另配一句视觉隐藏的「检查中…」，
          否则这一档对读屏用户等于消失（原本那个 pill 是读得到的）。 */}
      {state.kind === 'loading' && (
        <div className="sk-wrap" role="status">
          <span className="sr-only">检查中…</span>
          <div className="sk-row">
            <Skeleton className="sk-pill" />
            <Skeleton className="sk-title" />
          </div>
        </div>
      )}

      {state.kind === 'ok' && (
        <p style={{ margin: 0 }}>
          <span className="pill ok">已连通</span> {state.data.service} v{state.data.version}
          {' · '}
          <span className="dim">数据库结构 v{state.data.schemaVersion}</span>
        </p>
      )}

      {state.kind === 'error' && (
        <>
          <p>
            <span className="pill err">{state.body.error.title}</span>{' '}
            <span className="mono dim">code = {state.body.error.code}</span>
          </p>
          <p style={{ marginBottom: 0 }}>{state.body.error.message}</p>
          {state.body.error.retryable && (
            <p style={{ marginBottom: 0 }}>
              <button type="button" onClick={() => void load()}>重试</button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
