import { useCallback, useEffect, useState } from 'react';
import { PageTitle } from '../components/PageTitle.tsx';
import type { MeUsageResponse } from '@knowpilot/shared';
import { apiGet, isAbort, toApiError, type ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SkeletonTable } from '../components/Skeleton.tsx';
import { CNY_RATE_NOTE, CNY_RATE_SOURCE, formatCnyFromUsd } from '../currency.ts';

/**
 * 我的用量（阶段 4B）。
 *
 * 【为什么这一页的口径与管理员看到的全库用量不同】这里只算 `user_id = 我`
 *   的调用。阶段 1–3 的调用没有归属（`usage_events.user_id` 是 NULL），
 *   所以这一页的合计会**小于**全库合计 —— 那不是漏算，是那些调用不是你做的。
 *
 * 【为什么现在只有一个总数，没有按天/按月的图】粒度还没定：按天看是
 *   "今天花了多少"，按月看是"这个月预算还剩多少"，两者要的界面不一样，
 *   而猜一个只会做出没人看的图。阶段 6 的用量治理里跟用户定完再做。
 *   在那之前，`since` 由服务端如实带回来（现在是 null = 自上线以来），
 *   页面照它写清楚统计范围，而不是含糊地说"总计"。
 */
export function UsagePage() {
  const { user } = useAuth();
  const [data, setData] = useState<MeUsageResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await apiGet<MeUsageResponse>('/api/v1/me/usage', signal);
      setData(res);
      setError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setError(toApiError(err));
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const t = data === null ? null : data.totals;

  return (
    <>
      <PageTitle icon="usage">我的用量</PageTitle>
      {/* 导语一行（「界面整理-new」§三「砍 1」）。原来那句"只统计你自己发起的调用，
          所以它会小于管理员看到的全库合计"是在解释**口径差**——那是实现细节；
          页面上的"未记录归属"那一桶已经把这层意思如实画出来了。 */}
      <p className="lead">{user !== null ? `${user.displayName} 的` : ''}模型调用用量与费用。</p>

      <div className="card usage-overview">
        <h2>
          合计
          <span className="card-actions">
            <button type="button" className="link-btn" onClick={() => void load()}>
              刷新
            </button>
          </span>
        </h2>

        {error !== null && <ErrorNotice error={error} onRetry={() => void load()} />}
        {/* 真实内容是 2 行 × 4 列的合计表（行头 + 值），所以骨架也用表格 ——
            用列表骨架的话，内容到达时「行头 + 值」的横向结构会突然出现。 */}
        {data === null && error === null && <SkeletonTable rows={2} cols={4} />}

        {t !== null && data !== null && (
          <>
            <div className="usage-metrics">
              <div className="usage-metric"><span>调用次数</span><strong>{t.calls.toLocaleString()}</strong><small>次调用</small></div>
              <div className="usage-metric"><span>输入 Token</span><strong>{t.inputTokens.toLocaleString()}</strong><small>包含缓存相关调用</small></div>
              <div className="usage-metric"><span>输出 Token</span><strong>{t.outputTokens.toLocaleString()}</strong><small>模型生成内容</small></div>
              <div className="usage-metric"><span>费用（人民币）</span><strong>{formatCnyFromUsd(t.costUsd)}</strong><small>按调用流水折算</small></div>
            </div>
            <p className="dim" style={{ fontSize: '0.75rem', margin: '12px 0 0' }}>
              {CNY_RATE_NOTE} <a href={CNY_RATE_SOURCE} target="_blank" rel="noreferrer">汇率来源</a>
            </p>

            <div className="usage-cache">
              <h3>缓存用量</h3>
              <div><span>缓存读取</span><strong>{t.cacheReadTokens.toLocaleString()} Token</strong></div>
              <div><span>缓存写入</span><strong>{t.cacheWriteTokens.toLocaleString()} Token</strong></div>
            </div>

            <p className="dim" style={{ fontSize: '0.75rem', margin: '12px 0 0' }}>
              统计范围：{data.since === null ? '自上线以来（全部历史）' : `自 ${data.since}`}。
              token 与费用按<b>每一次模型调用</b>记流水，与「问答记录」里那一行是一次问答的汇总 ——
              两者对得上，但对账口径不同（一次问答有多次调用）。
            </p>
          </>
        )}
      </div>
    </>
  );
}
