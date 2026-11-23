import { useCallback, useEffect, useState } from 'react';
import { PageTitle } from '../components/PageTitle.tsx';
import { Link } from 'react-router-dom';
import type { AdminUsageResponse, MyUsageTotals, UsageBucket } from '@knowpilot/shared';
import { apiGet, isAbort, toApiError, type ApiError } from '../api.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SkeletonTable } from '../components/Skeleton.tsx';
import { CNY_RATE_NOTE, CNY_RATE_SOURCE, formatCnyFromUsd } from '../currency.ts';

/**
 * 用量与预算（阶段 6，需求 7）。
 *
 * 【与「我的用量」的区别】`/me/usage` 只算 `user_id = 我`；这一页是**全实验室**的
 *   花费与每个人的用量。所以它是 `usage.read.all`，成员进不来（路由守卫 + 服务端闸门）。
 *
 * 【为什么按人、按日两张表都单列 cacheRead / cacheWrite】03 号 §7 把它们的成本口径
 *   写死了：缓存读/写**不得混进 input tokens**。缓存读通常比 input 便宜一个数量级，
 *   合并之后"这家模型省不省钱"就再也看不出来了 —— 而省不省钱正是这张表要回答的。
 *
 * 【为什么底部要写"配额：未设"】03 号 §7 的 A 类成本边界本阶段**只记录、不阻断**。
 *   这里如实写清，而不是画一个进度条让人以为快超了。
 */
export function AdminUsagePage() {
  const [data, setData] = useState<AdminUsageResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setData(await apiGet<AdminUsageResponse>('/api/v1/admin/usage', signal));
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

  const unattributed = data?.byUser.find((b) => b.isUnattributed === true) ?? null;

  return (
    <>
      <PageTitle icon="usage">用量与预算</PageTitle>
      <p className="lead">全实验室的模型调用用量与费用。</p>

      <div className="card">
        <h2>
          合计
          <span className="card-actions">
            <button type="button" className="link-btn" onClick={() => void load()}>
              刷新
            </button>
          </span>
        </h2>
        <p className="dim" style={{ fontSize: '0.8125rem', margin: '0 0 10px' }}>
          按人和本地日两个口径分开统计；一次问答通常有多次模型调用，所以计次会比问答记录多。
        </p>
        <p className="dim" style={{ fontSize: '0.75rem', margin: '0 0 12px' }}>
          {CNY_RATE_NOTE} <a href={CNY_RATE_SOURCE} target="_blank" rel="noreferrer">汇率来源</a>
        </p>

        {error !== null && <ErrorNotice error={error} onRetry={() => void load()} />}
        {data === null && error === null && <SkeletonTable rows={3} cols={4} />}

        {data !== null && (
          <>
            <TotalsTable t={data.total} />
            <p className="dim" style={{ fontSize: '0.75rem', margin: '12px 0 0' }}>
              统计范围：{data.since === null ? '自上线以来（全部历史）' : `自 ${data.since}`}。
            </p>
          </>
        )}
      </div>

      <div className="card">
        <h2>按人</h2>

        {data === null && error === null && <SkeletonTable rows={4} cols={7} />}

        {data !== null && data.byUser.length === 0 && (
          <EmptyState icon="usage">
            还没有任何模型调用记录。全库只要有人问过一次或整理过一次数据集，这一页就会有数字。
          </EmptyState>
        )}

        {data !== null && data.byUser.length > 0 && (
          <>
            <div className="admin-table-scroll"><table className="table">
              <thead>
                <tr>
                  <th>归属人</th>
                  <th style={{ width: 90 }}>调用次数</th>
                  <th style={{ width: 120 }}>输入 token</th>
                  <th style={{ width: 120 }}>输出 token</th>
                  <th style={{ width: 120 }}>缓存读</th>
                  <th style={{ width: 120 }}>缓存写</th>
                  <th style={{ width: 110 }}>费用（人民币）</th>
                </tr>
              </thead>
              <tbody>
                {data.byUser.map((b) => (
                  <BucketRow key={b.key} bucket={b} />
                ))}
              </tbody>
            </table></div>

            {/* 未归属桶的说明只在真的出现时给 —— 这张页面是新部署时，可能一条都没有。 */}
            {unattributed !== null && (
              <p className="dim" style={{ fontSize: '0.75rem', margin: '10px 0 0' }}>
                「未记录归属」是阶段 1–3 的调用（那时还没有登录），它们的花费是真实的，
                但不属于任何人，所以单独列一行 —— 丢掉这一行，这里的合计就会和全库合计对不上。
                它们也不计入任何人的「我的用量」。
              </p>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>按日</h2>

        {data === null && error === null && <SkeletonTable rows={5} cols={7} />}

        {data !== null && data.byDay.length === 0 && (
          <EmptyState icon="usage">还没有按日的数据。</EmptyState>
        )}

        {data !== null && data.byDay.length > 0 && (
          <>
            <div className="admin-table-scroll"><table className="table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th style={{ width: 90 }}>调用次数</th>
                  <th style={{ width: 120 }}>输入 token</th>
                  <th style={{ width: 120 }}>输出 token</th>
                  <th style={{ width: 120 }}>缓存读</th>
                  <th style={{ width: 120 }}>缓存写</th>
                  <th style={{ width: 110 }}>费用（人民币）</th>
                </tr>
              </thead>
              <tbody>
                {data.byDay.map((b) => (
                  <tr key={b.key}>
                    <td className="mono">{b.label}</td>
                    <td className="mono">{b.totals.calls}</td>
                    <td className="mono">{b.totals.inputTokens.toLocaleString()}</td>
                    <td className="mono">{b.totals.outputTokens.toLocaleString()}</td>
                    <td className="mono">{b.totals.cacheReadTokens.toLocaleString()}</td>
                    <td className="mono">{b.totals.cacheWriteTokens.toLocaleString()}</td>
                    <td className="mono">{formatCnyFromUsd(b.totals.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            <p className="dim" style={{ fontSize: '0.75rem', margin: '10px 0 0' }}>
              日期按<b>本机时区</b>归日（不是 UTC）：凌晨 0–8 点的调用仍算作当天，不会掉到前一天。
            </p>
          </>
        )}
      </div>

      <div className="card">
        <h2>配额</h2>
        <p style={{ margin: 0 }}>
          {data !== null && data.quota.configured ? (
            <>已配置配额记录。</>
          ) : (
            <>
              <b>未设配额。</b>
              本阶段只记录、不阻断 —— 用量照常累计，不会有请求因为超限被拒绝。
            </>
          )}
        </p>
        <p className="dim" style={{ fontSize: '0.75rem', margin: '8px 0 0' }}>
          「我的用量」在 <Link to="/me/usage">这里</Link>，只算你自己的调用。
        </p>
      </div>
    </>
  );
}

/** 按人的一行。无归属那一桶显示成说明性的标签，而不是当成一个人。 */
function BucketRow({ bucket }: { bucket: UsageBucket }) {
  return (
    <tr>
      <td className={bucket.isUnattributed === true ? 'dim' : undefined}>{bucket.label}</td>
      <td className="mono">{bucket.totals.calls}</td>
      <td className="mono">{bucket.totals.inputTokens.toLocaleString()}</td>
      <td className="mono">{bucket.totals.outputTokens.toLocaleString()}</td>
      <td className="mono">{bucket.totals.cacheReadTokens.toLocaleString()}</td>
      <td className="mono">{bucket.totals.cacheWriteTokens.toLocaleString()}</td>
      <td className="mono">{formatCnyFromUsd(bucket.totals.costUsd)}</td>
    </tr>
  );
}

/** 合计指标与个人页使用同一套视觉口径。 */
function TotalsTable({ t }: { t: MyUsageTotals }) {
  return (
    <div className="usage-metrics admin-usage-metrics">
      <div className="usage-metric"><span>调用次数</span><strong>{t.calls.toLocaleString()}</strong><small>次模型调用</small></div>
      <div className="usage-metric"><span>输入 Token</span><strong>{t.inputTokens.toLocaleString()}</strong><small>缓存读 {t.cacheReadTokens.toLocaleString()}</small></div>
      <div className="usage-metric"><span>输出 Token</span><strong>{t.outputTokens.toLocaleString()}</strong><small>缓存写 {t.cacheWriteTokens.toLocaleString()}</small></div>
      <div className="usage-metric"><span>费用（人民币）</span><strong>{formatCnyFromUsd(t.costUsd)}</strong><small>按调用流水折算</small></div>
    </div>
  );
}
