import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PageTitle } from '../components/PageTitle.tsx';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type {
  AdminTraceDetail,
  AdminTraceListItem,
  ListAdminTracesResponse,
  TraceStopReason,
  TraceUserFacet,
} from '@knowpilot/shared';
import { apiGet, isAbort, toApiError, type ApiError } from '../api.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SkeletonTable } from '../components/Skeleton.tsx';
import { fmtDateTime, fmtDuration } from '../format.ts';
import { OUTCOME_LABELS, outcomeTone } from '../outcome.ts';

/**
 * 管理端运行 Trace（O7）。
 *
 * 【这一页回答什么】"这次问答过程中到底发生了什么"：模型调了哪些工具、每次
 *   查了什么词、命中几条、预算用在哪一维、哪些 Claim 没过、钱花在哪几次调用上。
 *   它不是"再看一遍答案"—— 回答正文与证据摘录从来不进 Trace（迁移 v22），
 *   要看原文走原来的「查看原文」入口，那条路自己会再做权限校验。
 *
 * 【为什么只给 admin】Trace 里有工具查询词、预算、提示词哈希与内部诊断字段，
 *   是运维视角的数据。导师的 `askRecord.read.all` 是"看本组问了什么"，
 *   不该顺带看到这些。普通成员连入口都看不到，直接敲地址会被路由守卫拦下。
 */

const STOP_REASON_LABELS: Record<TraceStopReason, string> = {
  completed: '正常收尾',
  rounds: '查询次数到顶',
  tool_calls: '工具调用到顶',
  tokens: 'Token 预算到顶',
  wall: '总时长到顶',
  client_aborted: '提问方中止',
  model_error: '模型侧错误',
  exception: '运行异常',
};

const DELIVERY_LABELS: Record<string, string> = {
  verified: '已校验',
  partial: '部分未通过',
  interrupted: '未完成',
  failed: '失败',
};

const LAST_STAGE_LABELS: Record<string, string> = {
  startup: '启动',
  retrieval: '检索',
  generation: '生成',
  assembly: '组装与校验',
};

const ROUTE_LABELS: Record<string, string> = {
  simple: '简单问答',
  multi_source: '多来源',
  state_lookup: '状态查询',
};

const VERDICT_LABELS: Record<string, string> = {
  supported: '有依据',
  contradicted: '与证据矛盾',
  insufficient: '依据不足',
  review_required: '待核对',
  not_checked: '未校验',
};

export function AdminTracePage() {
  const [params, setParams] = useSearchParams();
  const runId = params.get('runId') ?? '';
  const userId = params.get('userId') ?? '';
  const outcome = params.get('outcome') ?? '';
  const [runIdInput, setRunIdInput] = useState(runId);
  const [data, setData] = useState<ListAdminTracesResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  // 地址栏被手工改过时，输入框跟着变回真实筛选值。
  useEffect(() => {
    setRunIdInput(runId);
  }, [runId]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const qs = new URLSearchParams();
      if (runId !== '') qs.set('runId', runId);
      if (userId !== '') qs.set('userId', userId);
      if (outcome !== '') qs.set('outcome', outcome);
      try {
        setData(await apiGet<ListAdminTracesResponse>(`/api/v1/admin/traces?${qs.toString()}`, signal));
        setError(null);
      } catch (err) {
        if (isAbort(err)) return;
        setError(toApiError(err));
      }
    },
    [runId, userId, outcome],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  function applyRunId(e: FormEvent): void {
    e.preventDefault();
    const next = new URLSearchParams(params);
    const value = runIdInput.trim();
    if (value === '') next.delete('runId');
    else next.set('runId', value);
    setParams(next);
  }

  function setFilter(key: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setParams(next);
  }

  const counts = new Map((data?.counts.byOutcome ?? []).map((c) => [c.outcome, c.count]));
  const users: readonly TraceUserFacet[] = data?.users ?? [];

  return (
    <>
      <PageTitle icon="trace">运行 Trace</PageTitle>
      <p className="lead">回放一次问答的工具轨迹、证据与预算。</p>

      <div className="card">
        <h2>
          筛选
          <span className="card-actions">
            <button type="button" className="link-btn" onClick={() => void load()}>
              刷新
            </button>
          </span>
        </h2>
        <p className="dim" style={{ fontSize: '0.8125rem', margin: '0 0 10px' }}>
          这里只展示过程元数据，不含回答正文与证据原文。
        </p>

        <form className="form-row" onSubmit={applyRunId}>
          <label className="field" style={{ flex: '0 1 360px', minWidth: 0 }}>
            <span>运行 ID</span>
            <input
              type="text"
              className="mono"
              value={runIdInput}
              onChange={(e) => setRunIdInput(e.target.value)}
              placeholder="完整 run_id（可粘贴）"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>提问人</span>
            <select value={userId} onChange={(e) => setFilter('userId', e.target.value)}>
              <option value="">全部</option>
              {users.map((u) => (
                <option key={u.userId ?? 'none'} value={u.userId ?? 'none'}>
                  {u.label}（{u.count}）
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="primary">
            按 ID 查询
          </button>
          {(runId !== '' || userId !== '' || outcome !== '') && (
            <button
              type="button"
              className="link-btn"
              onClick={() => setParams(new URLSearchParams())}
            >
              清空筛选
            </button>
          )}
        </form>

        <nav className="tabs" aria-label="按结果筛选" style={{ marginTop: 16 }}>
          <button type="button" className={outcome === '' ? 'tab active' : 'tab'} onClick={() => setFilter('outcome', '')}>
            全部 {data?.counts.all ?? 0}
          </button>
          {(Object.keys(OUTCOME_LABELS) as (keyof typeof OUTCOME_LABELS)[]).map((key) => (
            <button
              key={key}
              type="button"
              className={outcome === key ? 'tab active' : 'tab'}
              onClick={() => setFilter('outcome', key)}
            >
              {OUTCOME_LABELS[key]} {counts.get(key) ?? 0}
            </button>
          ))}
        </nav>

        {error !== null && <ErrorNotice error={error} onRetry={() => void load()} />}
        {data === null && error === null && <SkeletonTable rows={6} cols={8} />}
        {data !== null && data.items.length === 0 && (
          <EmptyState icon="patrol">
            没有符合条件的运行记录。问答跑过一次之后，这里就会出现一行。
          </EmptyState>
        )}

        {data !== null && data.items.length > 0 && (
          <div className="admin-table-scroll"><table className="table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th style={{ width: 150 }}>运行时间</th>
                <th style={{ width: 120 }}>运行 ID</th>
                <th style={{ width: 110 }}>提问人</th>
                <th>问题</th>
                <th style={{ width: 110 }}>结果</th>
                <th style={{ width: 130 }}>停止原因</th>
                <th style={{ width: 90 }}>耗时</th>
                <th style={{ width: 70 }}>证据</th>
                <th style={{ width: 80 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <TraceRow key={item.runId} item={item} />
              ))}
            </tbody>
          </table></div>
        )}

        {data !== null && data.items.length > 0 && (
          <p className="dim" style={{ fontSize: '0.75rem', margin: '10px 0 0' }}>
            问题原文来自问答记录（同一 run_id 的 JOIN）；原始记录不存在时显示「原始记录缺失」。
          </p>
        )}
      </div>
    </>
  );
}

function TraceRow({ item }: { item: AdminTraceListItem }) {
  return (
    <tr>
      <td className="mono">{fmtDateTime(item.askedAt)}</td>
      <td className="mono">
        <Link to={`/admin/traces/${item.runId}`} title={item.runId}>
          {item.runId.slice(0, 8)}
        </Link>
      </td>
      <td>{item.asker ?? <span className="dim">未记录归属</span>}</td>
      <td title={item.question ?? ''}>
        {item.question === null ? (
          <span className="dim">原始记录缺失</span>
        ) : item.question.length > 80 ? (
          `${item.question.slice(0, 80)}…`
        ) : (
          item.question
        )}
      </td>
      <td>
        <span className={`pill ${outcomeTone(item.outcome)}`}>{OUTCOME_LABELS[item.outcome]}</span>
      </td>
      <td>{STOP_REASON_LABELS[item.stopReason] ?? item.stopReason}</td>
      <td className="mono">{fmtDuration(item.durationMs)}</td>
      <td className="mono">{item.evidenceCount}</td>
      <td><Link className="link-btn" to={`/admin/traces/${item.runId}`}>查看详情</Link></td>
    </tr>
  );
}

export function AdminTraceDetailPage() {
  const { runId = '' } = useParams();
  const [data, setData] = useState<AdminTraceDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setData(await apiGet<AdminTraceDetail>(`/api/v1/admin/traces/${encodeURIComponent(runId)}`, signal));
        setError(null);
      } catch (err) {
        if (isAbort(err)) return;
        setError(toApiError(err));
      }
    },
    [runId],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  return (
    <>
      <p style={{ marginBottom: 8 }}>
        <Link className="link-btn" to="/admin/traces">
          ← 返回运行列表
        </Link>
      </p>
      <PageTitle icon="trace">Trace 详情</PageTitle>
      <p className="trace-run-id">
        <span className="trace-run-id-label">运行 ID</span>
        <span className="mono">{runId}</span>
      </p>

      {error !== null && <ErrorNotice error={error} onRetry={() => void load()} />}
      {data === null && error === null && <SkeletonTable rows={8} cols={4} />}
      {data !== null && <TraceDetailBody item={data} />}
    </>
  );
}

function TraceDetailBody({ item }: { item: AdminTraceDetail }) {
  const claimCounts = countBy(item.claimChecks.map((c) => c.verdict));
  const totalUsage = item.usageEvents.reduce(
    (acc, e) => ({
      input: acc.input + (e.inputTokens ?? 0),
      output: acc.output + (e.outputTokens ?? 0),
      cost: acc.cost + (e.costUsd ?? 0),
    }),
    { input: 0, output: 0, cost: 0 },
  );

  return (
    <>
      <div className="card">
        <h2>概览</h2>
        <table className="table">
          <tbody>
            <tr>
              <th scope="row">运行时间</th>
              <td className="mono">{fmtDateTime(item.askedAt)}</td>
              <th scope="row">落库时间</th>
              <td className="mono">{fmtDateTime(item.recordedAt)}</td>
            </tr>
            <tr>
              <th scope="row">提问人</th>
              <td>{item.asker ?? '未记录归属'}</td>
              <th scope="row">结果</th>
              <td>
                <span className={`pill ${outcomeTone(item.outcome)}`}>
                  {OUTCOME_LABELS[item.outcome]}
                </span>
              </td>
            </tr>
            <tr>
              <th scope="row">停止原因</th>
              <td>{STOP_REASON_LABELS[item.stopReason] ?? item.stopReason}</td>
              <th scope="row">交付状态</th>
              <td>{DELIVERY_LABELS[item.deliveryStatus] ?? item.deliveryStatus}</td>
            </tr>
            <tr>
              <th scope="row">最后阶段</th>
              <td>{LAST_STAGE_LABELS[item.lastStage] ?? item.lastStage}</td>
              <th scope="row">任务路由</th>
              <td>{ROUTE_LABELS[item.route] ?? item.route}</td>
            </tr>
            <tr>
              <th scope="row">耗时</th>
              <td className="mono">{fmtDuration(item.durationMs)}</td>
              <th scope="row">模型轮次</th>
              <td className="mono">{item.turn}</td>
            </tr>
            <tr>
              <th scope="row">证据池</th>
              <td className="mono">{item.evidenceCount} 条</td>
              <th scope="row">上下文用量</th>
              <td className="mono">{item.contextChars.toLocaleString()} 字符</td>
            </tr>
            <tr>
              <th scope="row">模型</th>
              <td className="mono">{item.model}</td>
              <th scope="row">提示词哈希</th>
              <td className="mono" title={item.promptHash}>
                {item.promptHash.slice(0, 16)}…
              </td>
            </tr>
            <tr>
              <th scope="row">问题</th>
              <td colSpan={3}>
                {item.question === null ? (
                  <span className="dim">原始问答记录缺失，无法显示问题原文。</span>
                ) : (
                  item.question
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>预算</h2>
        <table className="table">
          <thead>
            <tr>
              <th>维度</th>
              <th style={{ width: 120 }}>额度</th>
              <th style={{ width: 120 }}>已用</th>
              <th style={{ width: 100 }}>用量</th>
            </tr>
          </thead>
          <tbody>
            <BudgetRow label="查询次数" used={item.budget.used.queryCalls} limit={item.budget.limits.maxQueryCalls} />
            <BudgetRow label="工具调用" used={item.budget.used.toolCalls} limit={item.budget.limits.maxToolCalls} />
            <BudgetRow label="Token" used={item.budget.used.tokens} limit={item.budget.limits.maxTokens} />
            <BudgetRow
              label="总时长"
              used={item.budget.used.elapsedMs}
              limit={item.budget.limits.maxWallMs}
              format={(n) => fmtDuration(n)}
            />
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>工具轨迹</h2>
        {item.toolCalls.length === 0 ? (
          <EmptyState icon="patrol">这次运行没有发生工具调用。</EmptyState>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 60 }}>序号</th>
                <th style={{ width: 90 }}>时间</th>
                <th style={{ width: 150 }}>工具</th>
                <th>检索参数</th>
                <th style={{ width: 80 }}>命中</th>
                <th style={{ width: 90 }}>耗时</th>
                <th style={{ width: 90 }}>结果</th>
              </tr>
            </thead>
            <tbody>
              {item.toolCalls.map((t, i) => (
                <tr key={`${t.name}-${t.atMs}-${i}`}>
                  <td className="mono">{i + 1}</td>
                  <td className="mono">+{fmtDuration(t.atMs)}</td>
                  <td className="mono">{t.name}</td>
                  <td>
                    {t.retrieval === undefined ? (t.query ?? <span className="dim">—</span>) : (
                      <span>
                        {t.retrieval.mode === 'keyword' ? '关键词' : t.retrieval.mode === 'hybrid' ? '混合' : '语义'}
                        {t.retrieval.lookup !== undefined && (
                          <> · 词已脱敏{t.retrieval.order === undefined ? '' : ` · 步骤 ${t.retrieval.order + 1}`} · 请求 {t.retrieval.lookup.requestedMode} · {t.retrieval.lookup.scope === 'document' ? '单文档' : '资料库'}
                            {t.retrieval.lookup.material !== undefined && ` · ${t.retrieval.lookup.material}`}
                            {' · '}上限 {t.retrieval.lookup.limit}</>
                        )}
                        {' · '}新增证据 {t.retrieval.newEvidence}
                        {t.retrieval.ranking === 'reranked' && ` · 已重排 ${t.retrieval.rankedCandidates ?? 0} 条`}
                        {t.retrieval.ranking === 'fallback' && ' · 重排回退'}
                        {t.retrieval.rankingMs !== undefined && ` · 重排 ${fmtDuration(t.retrieval.rankingMs)}`}
                      </span>
                    )}
                  </td>
                  <td className="mono">{t.hitCount === null ? '—' : t.hitCount}</td>
                  <td className="mono">{fmtDuration(t.ms)}</td>
                  <td>
                    {t.skipped === 'context_budget' ? <span className="pill">证据额度用尽 · 未检索</span>
                      : t.isError ? <span className="pill err">报错</span> : <span className="pill ok">完成</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>引用与校验</h2>
        <p style={{ marginTop: 0 }}>
          引用片段校验：
          {item.quoteChecks === null ? (
            <span className="dim">
              本次走的是自由文本回落路径，没有结构化摘录可核 —— 这不等于全部通过。
            </span>
          ) : (
            <span className="mono">
              检查 {item.quoteChecks.checked} · 通过 {item.quoteChecks.passed} · 未通过{' '}
              {item.quoteChecks.failed}
            </span>
          )}
        </p>
        <p>
          Claim 校验：
          {item.claimChecks.length === 0 ? (
            <span className="dim">没有可校验的 Claim。</span>
          ) : (
            <span className="mono">
              {Object.entries(claimCounts)
                .map(([verdict, n]) => `${VERDICT_LABELS[verdict] ?? verdict} ${n}`)
                .join(' · ')}
            </span>
          )}
        </p>

        {item.claimChecks.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 100 }}>Claim</th>
                <th style={{ width: 140 }}>判定</th>
                <th>引用证据</th>
                <th>逐句跨度证据</th>
              </tr>
            </thead>
            <tbody>
              {item.claimChecks.map((c) => (
                <tr key={c.claimId}>
                  <td className="mono">{c.claimId}</td>
                  <td>
                    <span className={`pill ${c.verdict === 'supported' ? 'ok' : c.verdict === 'contradicted' ? 'err' : 'warn'}`}>
                      {VERDICT_LABELS[c.verdict] ?? c.verdict}
                    </span>
                  </td>
                  <td className="mono">{c.evidenceIds.join(', ') || '—'}</td>
                  <td className="mono">{c.spanEvidenceIds.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3 style={{ marginTop: 20 }}>正文引用映射</h3>
        {item.citationMap.length === 0 ? (
          <p className="dim">正文没有引用任何证据。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 80 }}>编号</th>
                <th>chunk_id</th>
                <th>record_id</th>
              </tr>
            </thead>
            <tbody>
              {item.citationMap.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.id}</td>
                  <td className="mono">{c.chunkId ?? '—'}</td>
                  <td className="mono">{c.recordId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>证据落点</h2>
        <h3 style={{ marginTop: 0 }}>检索命中</h3>
        {item.retrievalHits.length === 0 ? (
          <p className="dim">这次运行没有检索到文档块。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 70 }}>名次</th>
                <th>chunk_id</th>
                <th style={{ width: 100 }}>分数</th>
              </tr>
            </thead>
            <tbody>
              {item.retrievalHits.map((h) => (
                <tr key={h.chunkId}>
                  <td className="mono">{h.rank + 1}</td>
                  <td className="mono">{h.chunkId}</td>
                  <td className="mono">{h.score.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3 style={{ marginTop: 20 }}>记录类证据</h3>
        {item.recordEvidence.length === 0 ? (
          <p className="dim">这次运行没有查询台账 / 数据集 / 分区记录。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 140 }}>类型</th>
                <th>记录 ID</th>
              </tr>
            </thead>
            <tbody>
              {item.recordEvidence.map((r) => (
                <tr key={`${r.recordType}:${r.recordId}`}>
                  <td className="mono">{r.recordType}</td>
                  <td className="mono">{r.recordId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>改写与计划</h2>
        <p style={{ marginTop: 0 }}>
          计划覆盖：<span className="mono">{item.plan.coverage}</span>（
          {(item.plan.coverageRatio * 100).toFixed(0)}%）
        </p>
        {item.plan.subgoals.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 100 }}>子目标</th>
                <th style={{ width: 120 }}>类型</th>
                <th style={{ width: 120 }}>状态</th>
                <th style={{ width: 100 }}>证据数</th>
              </tr>
            </thead>
            <tbody>
              {item.plan.subgoals.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.id}</td>
                  <td>{s.kind}</td>
                  <td>
                    <span className={`pill ${s.status === 'covered' ? 'ok' : 'warn'}`}>
                      {s.status === 'covered' ? '已覆盖' : '缺失'}
                    </span>
                  </td>
                  <td className="mono">{s.evidenceCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3 style={{ marginTop: 20 }}>追问改写</h3>
        {item.followUpRewrite === null ? (
          <p className="dim">本轮不是追问（或改写失败），没有改写结果。</p>
        ) : (
          <table className="table">
            <tbody>
              <tr>
                <th scope="row" style={{ width: 110 }}>原问题</th>
                <td>{item.followUpRewrite.original}</td>
              </tr>
              <tr>
                <th scope="row">改写后</th>
                <td>{item.followUpRewrite.rewritten}</td>
              </tr>
              <tr>
                <th scope="row">有实质变化</th>
                <td>{item.followUpRewrite.changed ? '是' : '否'}</td>
              </tr>
              <tr>
                <th scope="row">改写耗时</th>
                <td className="mono">{fmtDuration(item.followUpRewrite.ms)}</td>
              </tr>
            </tbody>
          </table>
        )}

        <h3 style={{ marginTop: 20 }}>检索改写事件</h3>
        {item.rewriteEvents.length === 0 ? (
          <p className="dim">没有发生检索改写。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 60 }}>轮次</th>
                <th style={{ width: 130 }}>缺口原因</th>
                <th>查询词</th>
                <th style={{ width: 150 }}>覆盖变化</th>
                <th style={{ width: 130 }}>停止原因</th>
              </tr>
            </thead>
            <tbody>
              {item.rewriteEvents.map((e) => (
                <tr key={e.round}>
                  <td className="mono">{e.round}</td>
                  <td>{e.gapReason}</td>
                  <td>{e.queries.map((q) => q.text).join('；') || '—'}</td>
                  <td className="mono">
                    {e.coverageBefore} → {e.coverageAfter}
                  </td>
                  <td>{e.stoppedReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(item.warnings.length > 0 || item.errors.length > 0) && (
        <div className="card">
          <h2>警告与错误</h2>
          {item.errors.length > 0 && (
            <>
              <h3 style={{ marginTop: 0 }}>错误</h3>
              <ul>
                {item.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </>
          )}
          {item.warnings.length > 0 && (
            <>
              <h3>警告</h3>
              <ul>
                {item.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="card">
        <h2>模型调用流水</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          来自用量流水（与 Trace 通过同一个 run_id 关联），只含 token 与金额，不含内容。
        </p>
        {item.usageEvents.length === 0 ? (
          <EmptyState icon="usage">这次运行没有记录到模型调用流水。</EmptyState>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th style={{ width: 150 }}>模型</th>
                  <th style={{ width: 90 }}>用途</th>
                  <th style={{ width: 100 }}>输入</th>
                  <th style={{ width: 100 }}>输出</th>
                  <th style={{ width: 100 }}>缓存读</th>
                  <th style={{ width: 100 }}>缓存写</th>
                  <th style={{ width: 100 }}>费用</th>
                  <th style={{ width: 90 }}>耗时</th>
                </tr>
              </thead>
              <tbody>
                {item.usageEvents.map((e) => (
                  <tr key={e.eventId}>
                    <td className="mono">{fmtDateTime(e.createdAt)}</td>
                    <td className="mono">{e.model}</td>
                    <td>{e.purpose}</td>
                    <td className="mono">{e.inputTokens?.toLocaleString() ?? '—'}</td>
                    <td className="mono">{e.outputTokens?.toLocaleString() ?? '—'}</td>
                    <td className="mono">{e.cacheRead?.toLocaleString() ?? '—'}</td>
                    <td className="mono">{e.cacheCreation?.toLocaleString() ?? '—'}</td>
                    <td className="mono">{e.costUsd === null ? '—' : `$${e.costUsd.toFixed(6)}`}</td>
                    <td className="mono">{e.durationMs === null ? '—' : fmtDuration(e.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="dim" style={{ fontSize: '0.75rem', margin: '10px 0 0' }}>
              合计：输入 {totalUsage.input.toLocaleString()} · 输出 {totalUsage.output.toLocaleString()} · 费用 $
              {totalUsage.cost.toFixed(6)}
            </p>
          </>
        )}
      </div>
    </>
  );
}

function BudgetRow({
  label,
  used,
  limit,
  format,
}: {
  label: string;
  used: number;
  limit: number;
  format?: (n: number) => string;
}) {
  const fmt = format ?? ((n: number) => n.toLocaleString());
  const ratio = limit <= 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  return (
    <tr>
      <td>{label}</td>
      <td className="mono">{fmt(limit)}</td>
      <td className="mono">{fmt(used)}</td>
      <td className="mono">{ratio}%</td>
    </tr>
  );
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
