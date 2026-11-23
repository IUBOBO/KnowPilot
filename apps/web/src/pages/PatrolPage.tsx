import { useCallback, useEffect, useState } from 'react';
import { PageTitle } from '../components/PageTitle.tsx';
import { Link } from 'react-router-dom';
import {
  SUBMISSION_STATUS_LABELS,
  PATROL_TASK_STATUS_LABELS,
  patrolOverdueLabel,
  type PatrolRule,
  type PatrolRuleUpdate,
  type PatrolRulesResponse,
  type PatrolRunSummary,
  type PatrolSubjectStatus,
  type PatrolTask,
  type PatrolTasksResponse,
  type DismissPatrolTaskResponse,
} from '@knowpilot/shared';
import { apiGet, apiPatch, apiPost, isAbort, toApiError, type ApiError } from '../api.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SkeletonLines, SkeletonTable } from '../components/Skeleton.tsx';
import { useToast } from '../components/Toast.tsx';
import { fmtDateTime } from '../format.ts';

/**
 * 巡检（阶段 6，需求 8）。
 *
 * 【这一页在做什么】投稿台账里"多久没动过"是**算出来的**，不是谁盯出来的。
 *   这张页面上半部分是判定规则（按状态分档的阈值），下半部分是算出来的待办。
 *   判据是"当前时间 − 投稿的 updated_at > 该档阈值"，一个减法（02 号 §2.1 的 T3）——
 *   所以"立即巡检"与定时巡检走的是同一个 `reconcile`，手工触发不是另一套逻辑。
 *
 * 【为什么阈值按状态分档】待初审两周没人理是异常，外审六十天是常态。
 *   一个全局阈值要么把外审全标红，要么对初审形同虚设。
 */
export function PatrolPage() {
  const toast = useToast();

  const [rules, setRules] = useState<PatrolRulesResponse | null>(null);
  const [rulesError, setRulesError] = useState<ApiError | null>(null);
  const [tasks, setTasks] = useState<PatrolTasksResponse | null>(null);
  const [tasksError, setTasksError] = useState<ApiError | null>(null);
  const [lastRun, setLastRun] = useState<PatrolRunSummary | null>(null);
  const [running, setRunning] = useState(false);

  /** 改完之后重拉。用一个自增数而不是另写一遍 fetch。 */
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  const loadRules = useCallback(async (signal?: AbortSignal) => {
    try {
      setRules(await apiGet<PatrolRulesResponse>('/api/v1/patrol/rules', signal));
      setRulesError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setRulesError(toApiError(err));
    }
  }, []);

  const loadTasks = useCallback(async (signal?: AbortSignal) => {
    try {
      setTasks(await apiGet<PatrolTasksResponse>('/api/v1/patrol/tasks', signal));
      setTasksError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setTasksError(toApiError(err));
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void loadRules(ac.signal);
    void loadTasks(ac.signal);
    return () => ac.abort();
  }, [loadRules, loadTasks, version]);

  async function onRunNow() {
    setRunning(true);
    try {
      const summary = await apiPost<PatrolRunSummary>('/api/v1/patrol/run', {});
      setLastRun(summary);
      // 三个数都要说：「0 新建、7 条还挂着」与「真的什么都没发生」是两件事，
      // 只报新建数会让人以为按钮没生效（见 PatrolRunSummary 的注释）。
      toast.ok(
        `巡检完成：新建 ${summary.created}，消解 ${summary.resolved}，仍挂着 ${summary.stillOpen}。`,
      );
      reload();
    } catch (err) {
      setTasksError(toApiError(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <PageTitle icon="patrol">巡检</PageTitle>
          <p className="lead">配置各审稿状态的超期天数阈值，自动巡检并生成跟进待办。</p>
        </div>
        <div className="page-head-actions">
          <button type="button" className="btn-primary" disabled={running} onClick={() => void onRunNow()}>
            {running ? '巡检中…' : '立即巡检'}
          </button>
        </div>
      </div>

      {tasks !== null && (
        <div className="patrol-summary">
          <div><span>需跟进</span><strong>{tasks.items.filter((task) => task.status === 'open').length}</strong><small>未忽略的超期待办</small></div>
          <div><span>已忽略</span><strong>{tasks.items.filter((task) => task.status === 'dismissed').length}</strong><small>已记录处理决定</small></div>
          <div><span>本次手动巡检</span><strong>{lastRun === null ? '—' : fmtDateTime(lastRun.at)}</strong><small>{lastRun === null ? '本次会话尚未触发' : `新建 ${lastRun.created} · 消解 ${lastRun.resolved}`}</small></div>
        </div>
      )}

      <RulesCard
        rules={rules}
        error={rulesError}
        onReload={() => void loadRules()}
        onSaved={(msg) => {
          toast.ok(msg);
          reload();
        }}
        lastRun={lastRun}
      />

      <TasksCard
        data={tasks}
        error={tasksError}
        onReload={() => void loadTasks()}
        onDismissed={(task) => {
          toast.ok(
            task.submissionTitle !== null
              ? `已忽略「${task.submissionTitle}」的超期待办。`
              : '已忽略这条超期待办。',
          );
          reload();
        }}
      />
    </>
  );
}

// ── 巡检规则 ────────────────────────────────────────────────────

/** 阈值可填的上限（天）。与服务端 parsePatrolRuleUpdates 的上限同值。 */
const THRESHOLD_MAX = 3650;

function statusLabel(status: PatrolSubjectStatus): string {
  return SUBMISSION_STATUS_LABELS[status];
}

/**
 * 规则的草稿只存"改到一半的值"。
 *
 * 【为什么不复制一份完整的规则数组来编辑】那样"哪几档真被改了"就消失了，
 *   保存时只能把四档全发一遍 —— 语义上等价，但 PATCH 的"不出现的键不动"
 *   就被绕过去了，将来加了别的字段会立刻暴露出问题。这里保留原值，
 *   只在有草稿时覆盖显示，保存时**逐个比对**只发真的变了的档。
 */
type RuleDraft = Record<string, { threshold?: string; enabled?: boolean }>;

function RulesCard({
  rules,
  error,
  onReload,
  onSaved,
  lastRun,
}: {
  rules: PatrolRulesResponse | null;
  error: ApiError | null;
  onReload: () => void;
  onSaved: (message: string) => void;
  lastRun: PatrolRunSummary | null;
}) {
  const [drafts, setDrafts] = useState<RuleDraft>({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<ApiError | null>(null);

  // 规则重新加载后，草稿就过期了 —— 清掉，免得把上一版的值当成"改动"发上去。
  useEffect(() => {
    setDrafts({});
  }, [rules]);

  const items = rules?.rules ?? [];

  const thresholdOf = (r: PatrolRule): string => drafts[r.status]?.threshold ?? String(r.thresholdDays);
  const enabledOf = (r: PatrolRule): boolean => drafts[r.status]?.enabled ?? r.enabled;

  const setDraft = (status: PatrolSubjectStatus, patch: { threshold?: string; enabled?: boolean }) => {
    setDrafts((prev) => ({ ...prev, [status]: { ...prev[status], ...patch } }));
  };

  async function onSave() {
    const changes: PatrolRuleUpdate[] = [];
    for (const r of items) {
      const raw = thresholdOf(r);
      const days = Number(raw);
      const enabled = enabledOf(r);
      const daysChanged = raw !== String(r.thresholdDays);
      const enabledChanged = enabled !== r.enabled;
      if (!daysChanged && !enabledChanged) continue;

      if (daysChanged && (!Number.isInteger(days) || days < 1 || days > THRESHOLD_MAX)) {
        setFormError(`「${statusLabel(r.status)}」的阈值要填 1 到 ${THRESHOLD_MAX} 之间的整数。`);
        return;
      }
      changes.push({
        status: r.status,
        ...(daysChanged ? { thresholdDays: days } : {}),
        ...(enabledChanged ? { enabled } : {}),
      });
    }

    if (changes.length === 0) {
      setFormError(null);
      onSaved('规则没有改动。');
      return;
    }

    setFormError(null);
    setSaveError(null);
    setBusy(true);
    try {
      await apiPatch<PatrolRulesResponse>('/api/v1/patrol/rules', { rules: changes });
      onSaved(`已保存 ${changes.length} 档规则。`);
    } catch (err) {
      setSaveError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>
        巡检规则
        <span className="card-actions">
          <button type="button" className="link-btn" disabled={busy} onClick={onReload}>
            刷新
          </button>
        </span>
      </h2>

      {error !== null && <ErrorNotice error={error} onRetry={onReload} />}
      {/* 真实内容是 4 行 × 3 列（状态 / 阈值 / 启用），所以骨架也用表格。 */}
      {rules === null && error === null && <SkeletonTable rows={4} cols={3} />}

      {rules !== null && (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>状态</th>
                <th style={{ width: 160 }}>超期阈值（天）</th>
                <th style={{ width: 120 }}>启用</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.status}>
                  <td>{statusLabel(r.status)}</td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      max={THRESHOLD_MAX}
                      value={thresholdOf(r)}
                      disabled={busy}
                      aria-label={`${statusLabel(r.status)}的超期阈值（天）`}
                      style={{ width: 90 }}
                      onChange={(e) => setDraft(r.status, { threshold: e.target.value })}
                    />
                  </td>
                  <td>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={enabledOf(r)}
                        disabled={busy}
                        onChange={(e) => setDraft(r.status, { enabled: e.target.checked })}
                      />
                      <span className="dim">{enabledOf(r) ? '启用' : '停用'}</span>
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="form-row" style={{ marginTop: 12, alignItems: 'center' }}>
            <button type="button" disabled={busy} onClick={() => void onSave()}>
              {busy ? '保存中…' : '保存规则'}
            </button>
            <span className="dim" style={{ fontSize: '0.75rem' }}>
              停用某一档 = 不再为它生成待办，已有的会被消解（不是删除，留痕）。
            </span>
          </div>

          {lastRun !== null && (
            <p className="dim" style={{ fontSize: '0.75rem', margin: '8px 0 0' }}>
              上次巡检：{fmtDateTime(lastRun.at)} —— 新建 {lastRun.created}，消解 {lastRun.resolved}，
              仍挂着 {lastRun.stillOpen}。
            </p>
          )}

          {formError !== null && (
            <div className="notice err"><p className="notice-body" style={{ margin: 0 }}>{formError}</p></div>
          )}
          {saveError !== null && <ErrorNotice error={saveError} onRetry={() => setSaveError(null)} />}
        </>
      )}
    </div>
  );
}

// ── 待办 ────────────────────────────────────────────────────────

function TasksCard({
  data,
  error,
  onReload,
  onDismissed,
}: {
  data: PatrolTasksResponse | null;
  error: ApiError | null;
  onReload: () => void;
  onDismissed: (task: PatrolTask) => void;
}) {
  const [target, setTarget] = useState<PatrolTask | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [dismissError, setDismissError] = useState<ApiError | null>(null);

  const items = data?.items ?? [];
  const openItems = items.filter((t) => t.status === 'open');
  const dismissedItems = items.filter((t) => t.status === 'dismissed');

  async function onConfirmDismiss() {
    if (target === null) return;
    setBusy(true);
    setDismissError(null);
    try {
      const trimmed = reason.trim();
      const res = await apiPost<DismissPatrolTaskResponse>(
        `/api/v1/patrol/tasks/${encodeURIComponent(target.id)}/dismiss`,
        trimmed === '' ? {} : { reason: trimmed },
      );
      setTarget(null);
      setReason('');
      onDismissed(res.task);
    } catch (err) {
      setDismissError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>
        {/* 计数分两截：括号里的第一个数是**待处理**的条数（那是要动手的事），
            已忽略的另标出来 —— 否则拿掉最后一条待处理后标题写着「待办（0）」
            却还看得见一行，像是坏掉了。 */}
        待办
        {data !== null &&
          `（${openItems.length}${dismissedItems.length > 0 ? ` · 已忽略 ${dismissedItems.length}` : ''}）`}
        <span className="card-actions">
          <button type="button" className="link-btn" disabled={busy} onClick={onReload}>
            刷新
          </button>
        </span>
      </h2>

      {error !== null && <ErrorNotice error={error} onRetry={onReload} />}
      {/* 真实表格 7 列，骨架也用 7 列，免得内容到达时表头宽度跳一次。 */}
      {data === null && error === null && <SkeletonTable rows={4} cols={7} />}

      {data !== null && items.length === 0 && (
        <EmptyState
          icon="patrol"
          action={
            <button type="button" className="link-btn" onClick={onReload}>
              刷新看看
            </button>
          }
        >
          当前没有超期投稿。这一页是空的，说明台账里每一篇都还在阈值内 ——
          巡检默认每 24 小时自动跑一次，也可以在上面点「立即巡检」手工触发。
        </EmptyState>
      )}

      {data !== null && items.length > 0 && (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>投稿</th>
                <th style={{ width: 120 }}>归属人</th>
                <th style={{ width: 110 }}>当前状态</th>
                <th style={{ width: 160 }}>更新于</th>
                <th style={{ width: 130 }}>超期</th>
                <th style={{ width: 120 }}>待办</th>
                <th style={{ width: 90 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {openItems.map((t) => (
                <TaskRow key={t.id} task={t} onDismiss={() => setTarget(t)} />
              ))}
              {dismissedItems.map((t) => (
                <TaskRow key={t.id} task={t} onDismiss={null} />
              ))}
            </tbody>
          </table>

          {/* 【2026-10-17】这段原先写着 `**显式**`「**这一版**」—— 那是 Markdown 的
              加粗记号，直接渲染出来就是四个刺眼的星号（JSX 不认 Markdown）。
              该强调的地方用 <b>，不该强调的地方就别强调。 */}
          <p className="dim" style={{ fontSize: '0.75rem', margin: '10px 0 0' }}>
            「已忽略」是有人<b>显式</b>划掉的（留了忽略人与时间），它对<b>这一版</b>投稿生效 ——
            投稿一更新又还超期，会重新生成一条新待办。
          </p>
        </>
      )}

      <ConfirmDialog
        open={target !== null}
        title="忽略这条超期待办？"
        confirmLabel="忽略"
        busyLabel="忽略中…"
        cancelLabel="取消"
        busy={busy}
        danger={false}
        onConfirm={() => void onConfirmDismiss()}
        onCancel={() => {
          if (busy) return;
          setTarget(null);
          setReason('');
          setDismissError(null);
        }}
      >
        {target !== null && (
          <p style={{ marginTop: 0 }}>
            {target.submissionTitle !== null ? `「${target.submissionTitle}」` : '这条投稿'}
            {' '}已超期 {target.overdueDays} 天。忽略不只是把它从列表里划掉 ——
            它记录着「有人看过、决定先不管」，投稿下次更新前不会再提醒。
          </p>
        )}
        <label className="field" style={{ flex: '1 1 100%' }}>
          <span>忽略理由（可留空，便于日后回看）</span>
          <input
            type="text"
            value={reason}
            disabled={busy}
            maxLength={200}
            placeholder="例如：已与作者确认，等 ta 自己推进"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {dismissError !== null && <ErrorNotice error={dismissError} onRetry={() => setDismissError(null)} />}
      </ConfirmDialog>
    </div>
  );
}

function TaskRow({ task, onDismiss }: { task: PatrolTask; onDismiss: (() => void) | null }) {
  const muted = task.status === 'dismissed';
  return (
    <tr style={muted ? { opacity: 0.6 } : undefined}>
      <td>
        {/* 台账没有"按 id 定位到某一篇"的锚点，所以这里链到台账整页 —— 不编一个
            点了不会滚到那一条的假锚点。 */}
        <Link to="/submissions">{task.submissionTitle ?? '(投稿已不存在)'}</Link>
      </td>
      <td className={task.ownerName === null ? 'dim' : undefined}>
        {task.ownerName ?? '未记录'}
      </td>
      <td>
        {task.submissionStatus !== null ? (
          SUBMISSION_STATUS_LABELS[task.submissionStatus]
        ) : (
          <span className="dim">—</span>
        )}
      </td>
      <td className="mono" style={{ fontSize: '0.71875rem' }}>
        {task.submissionUpdatedAt !== null ? fmtDateTime(task.submissionUpdatedAt) : '—'}
      </td>
      <td>
        <span className="pill err">{patrolOverdueLabel(task.overdueDays)}</span>
      </td>
      <td>
        <span className={task.status === 'open' ? 'pill warn' : 'pill'}>
          {PATROL_TASK_STATUS_LABELS[task.status]}
        </span>
        {task.dismissReason !== null && task.dismissReason !== '' && (
          <p className="dim" style={{ fontSize: '0.75rem', margin: '4px 0 0' }}>
            {task.dismissReason}
          </p>
        )}
      </td>
      <td>
        {onDismiss !== null ? (
          <button type="button" className="link-btn" onClick={onDismiss}>
            忽略
          </button>
        ) : (
          <span className="dim">—</span>
        )}
      </td>
    </tr>
  );
}
