import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { PageTitle } from '../components/PageTitle.tsx';
import { Link, useSearchParams } from 'react-router-dom';
import {
  FEEDBACK_REASON_LABELS,
  type AdminFeedbackItem,
  type ExportFeedbackDraftResponse,
  type FeedbackDownReason,
  type ListAdminFeedbackResponse,
} from '@knowpilot/shared';
import { apiGet, apiPost, isAbort, toApiError, type ApiError } from '../api.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SkeletonTable } from '../components/Skeleton.tsx';
import { useToast } from '../components/Toast.tsx';
import { OUTCOME_LABELS, outcomeTone } from '../outcome.ts';

/**
 * 回答反馈（O5）。
 *
 * 【这一页回答什么】"用户觉得哪些回答不好，具体不好在哪。"
 *   赞是正样本，所以筛选默认给"全部"而不是只看踩 —— 如果只展示踩，
 *   永远不会有人去看那些赞，而"这套问答到底有没有用"恰恰要靠正样本判断。
 *
 * 【为什么列表里没有回答正文】系统从来不存它（迁移 v6 / v20）。
 *   要看回答就按问题重新问一次；导出草稿里也写明了这一点。
 *
 * 【导出为什么是"草稿"】反馈只说"这不好"，没说"正确答案是什么"。
 *   把负面反馈自动变成金标，等于让被测者给自己出题。所以草稿里的
 *   gold / checks 留空，必须人工补齐，跑批脚本不会自动读取它。
 */
export function AdminFeedbackPage() {
  const [params] = useSearchParams();
  const raw = params.get('rating');
  // 认不出的值按"全部"处理：地址栏可以被手工改，这里不该因此白屏。
  // 真正发给服务端的只有 up / down / all 三档之一。
  const rating: 'up' | 'down' | null = raw === 'up' || raw === 'down' ? raw : null;

  const [data, setData] = useState<ListAdminFeedbackResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [exportError, setExportError] = useState<ApiError | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setData(
          await apiGet<ListAdminFeedbackResponse>(
            `/api/v1/admin/feedback?rating=${rating ?? 'all'}`,
            signal,
          ),
        );
        setError(null);
      } catch (err) {
        if (isAbort(err)) return;
        setError(toApiError(err));
      }
    },
    [rating],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  async function exportDraft(item: AdminFeedbackItem): Promise<void> {
    setExporting(item.runId);
    setExportError(null);
    try {
      const res = await apiPost<ExportFeedbackDraftResponse>(
        `/api/v1/admin/feedback/${item.runId}/export`,
        {},
      );
      downloadJson(res.fileName, res.draft);
      toast.ok(`已导出 ${res.fileName} —— 草稿，需人工补齐后才能进评测基线`);
    } catch (err) {
      // 错误必须留在页面上（带请求 ID），不能走 toast —— 见 Toast.tsx 顶部注释。
      setExportError(toApiError(err));
    } finally {
      setExporting(null);
    }
  }

  const counts = data?.counts ?? { all: 0, up: 0, down: 0 };

  return (
    <>
      <PageTitle icon="feedback">回答反馈</PageTitle>
      <p className="lead">用户对回答的赞与踩，只记评分与说明，不存正文。</p>

      <div className="card">
        <h2>
          反馈列表
          <span className="card-actions">
            <button type="button" className="link-btn" onClick={() => void load()}>
              刷新
            </button>
          </span>
        </h2>
        <p className="dim" style={{ fontSize: '0.8125rem', margin: '0 0 10px' }}>
          只记运行 ID、评分与用户写的说明；要复现某次回答，请回问答页用同一个问题重新提问。
        </p>

        {/* 筛选落 URL：能收藏、能贴给别人、后退键能回到上一档。
            计数是全量计数，不跟着筛选走 —— 否则切到"赞"时"踩"会显示成 0。 */}
        <nav className="tabs" aria-label="按评分筛选">
          <Link to="/admin/feedback" className={rating === null ? 'tab active' : 'tab'}>
            全部 {counts.all}
          </Link>
          <Link
            to="/admin/feedback?rating=down"
            className={rating === 'down' ? 'tab active' : 'tab'}
          >
            只看踩 {counts.down}
          </Link>
          <Link to="/admin/feedback?rating=up" className={rating === 'up' ? 'tab active' : 'tab'}>
            只看赞 {counts.up}
          </Link>
        </nav>

        {error !== null && <ErrorNotice error={error} onRetry={() => void load()} />}
        {data === null && error === null && <SkeletonTable rows={4} cols={7} />}

        {data !== null && data.items.length === 0 && (
          <EmptyState icon="feedback">
            {rating === 'down'
              ? '还没有人点过「没帮助」—— 这不一定是好消息，也可能是大家没在用下面的反馈按钮。'
              : rating === 'up'
                ? '还没有人点过「有帮助」。'
                : '还没有任何反馈。用户在问答页回答下方点「有帮助 / 没帮助」后，这里就会有记录。'}
          </EmptyState>
        )}

        {data !== null && data.items.length > 0 && (
          <div className="admin-table-scroll"><table className="table">
            <thead>
              <tr>
                <th style={{ width: 130 }}>时间</th>
                <th style={{ width: 100 }}>提问人</th>
                <th style={{ width: 64 }}>态度</th>
                <th style={{ width: 180 }}>原因</th>
                <th style={{ width: 200 }}>说明</th>
                <th>问题</th>
                <th style={{ width: 120 }}>运行结果</th>
                <th style={{ width: 100 }}>导出</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.runId}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                    {fmtDateTime(item.updatedAt)}
                  </td>
                  <td>{item.userName}</td>
                  <td>
                    <span className={item.rating === 'up' ? 'pill ok' : 'pill err'}>
                      {item.rating === 'up' ? '赞' : '踩'}
                    </span>
                  </td>
                  <td>{renderReasons(item.reasons)}</td>
                  <td>{item.note === null ? <span className="dim">—</span> : item.note}</td>
                  <td>
                    {item.question === null ? (
                      <span className="dim">（原问答记录已不存在）</span>
                    ) : (
                      <span title={item.question}>
                        {item.question.length > 60
                          ? `${item.question.slice(0, 60)}…`
                          : item.question}
                      </span>
                    )}
                  </td>
                  <td>
                    {item.outcome === null ? (
                      <span className="dim">—</span>
                    ) : (
                      <>
                        <span className={`pill ${outcomeTone(item.outcome)}`}>
                          {OUTCOME_LABELS[item.outcome]}
                        </span>
                        <span className="dim" style={{ fontSize: '0.75rem', display: 'block' }}>
                          引用 {item.citationCount ?? 0} · 缺口 {item.gapCount ?? 0}
                        </span>
                      </>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="link-btn"
                      disabled={exporting === item.runId}
                      onClick={() => void exportDraft(item)}
                    >
                      {exporting === item.runId ? '导出中…' : '导出草稿'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}

        {exportError !== null && <ErrorNotice error={exportError} />}

        <p className="dim" style={{ fontSize: '0.75rem', margin: '12px 0 0' }}>
          导出的是 JSON 草稿，包含提问原文与反馈内容，可能涉及未发表材料 ——
          请只在本地评测环境使用。草稿<b>不会自动进入评测基线</b>：
          gold（金标语料）与 checks（判定项）必须人工补齐。每次导出都会写审计记录。
        </p>
      </div>
    </>
  );
}

function renderReasons(reasons: readonly string[]): ReactNode {
  if (reasons.length === 0) return <span className="dim">—</span>;
  return reasons.map((r) => FEEDBACK_REASON_LABELS[r as FeedbackDownReason] ?? r).join('、');
}

/** ISO → 本地「2026-10-18 13:30」。各页各留一份，理由同 AskPage 里的同名声明的说明。 */
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 前端生成下载。服务端的导出接口返回 JSON 而不是附件流：
 * 走同一条 `request()` 才能复用结构化错误体（附件流出错时前端只能拿到一段空文件）。
 */
function downloadJson(fileName: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  a.remove();
  // 【为什么不立刻 revoke】下载是异步的：Chrome 收完字节后还要落盘，
  //   过早撤销 Blob URL 有把下载打断的风险。60 秒足够；页面若先关掉，
  //   对象 URL 也会随文档一起回收。
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
