import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  SUBMISSION_STATUSES,
  SUBMISSION_STATUS_LABELS,
  isTerminalStatus,
  isUnverifiedSource,
  type CreateSubmissionResponse,
  type CreateSubmissionRoundResponse,
  type DismissPatrolTaskResponse,
  type ListSubmissionsResponse,
  type PatrolTask,
  type PatrolTasksResponse,
  type Submission,
  type SubmissionStatus,
  type UpdateSubmissionResponse,
  type UpdateSubmissionStatusResponse,
} from '@knowpilot/shared';
import { Link, useSearchParams } from 'react-router-dom';
import { apiGet, apiPatch, apiPost, isAbort, toApiError, type ApiError } from '../api.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { LedgerDeleteDialog } from '../components/LedgerDeleteDialog.tsx';
import { Modal } from '../components/Modal.tsx';
import { RecordEdits } from '../components/RecordEdits.tsx';
import { PersonPicker } from '../components/PersonPicker.tsx';
import { RefreshIcon } from '../components/icons.tsx';
import { OverduePill } from '../components/OverduePill.tsx';
import { SkeletonList } from '../components/Skeleton.tsx';
import { NavGlyph } from '../nav-icons.tsx';
import { useAuth } from '../auth.tsx';
import { fmtDate, fmtDateTime, fmtUpdatedAgo } from '../format.ts';
import { useFocusTarget } from '../use-focus-target.ts';
import { LEDGER_RESTORED_EVENT } from '../ledger-events.ts';

/**
 * 投稿台账。
 *
 * 【它和别的页面有什么不同】这一页的数据**不是从文档里检索出来的**，
 * 而是直接查表。台账回答的是「我投的 X **现在**什么状态」—— 用上传的
 * 投稿记录回答等于给出一个过时结论，而用户看不出那是旧的。
 * 这也是为什么这一页没有搜索框、没有引用卡片：它没有"出处"可言，
 * 它自己就是事实来源。
 *
 * 【看到的是谁的记录】所有登录成员都能看全实验室台账；服务端统一给
 * `submission.read.all`。录入人、导师和管理员可订正资料与更新进展。
 */
/**
 * 列表快速筛选档。
 *
 * 【为什么第三档叫「已结束」而不是「已完成」】它收的是三个终态：
 * 已发表、已拒稿、已撤稿。后两个不是"完成"——把拒稿与撤稿写成"已完成"
 * 是在界面上说假话。行内的状态药丸仍然逐条写真实状态。
 *
 * 「超期」只认 `open` 的待办：`dismissed` 是用户看过、决定先不管，
 * 它还在列表里（药丸写「已忽略超期」），但不该再算进"需要处理"的那一档。
 */
type SubmissionFilter = 'all' | 'active' | 'done' | 'overdue';

const SUBMISSION_FILTERS: readonly { key: SubmissionFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'done', label: '已结束' },
  { key: 'overdue', label: '超期' },
];

function parseSubmissionFilter(raw: string | null): SubmissionFilter {
  return raw === 'active' || raw === 'done' || raw === 'overdue' ? raw : 'all';
}

export function SubmissionsPage() {
  const [params] = useSearchParams();
  /** 筛选落 URL（`filter=active|done|overdue`，全部时不带参数）：
   *  能刷新、能收藏、能按后退键回到上一档 —— 与知识库材料标签页同一条约定。 */
  const filter = parseSubmissionFilter(params.get('filter'));

  const [items, setItems] = useState<readonly Submission[] | null>(null);
  const [listError, setListError] = useState<ApiError | null>(null);

  const [status, setStatus] = useState<SubmissionStatus>('preparing');
  const [creating, setCreating] = useState(false);
  /**
   * 「登记一篇投稿」表单是否展开。
   *
   * 【为什么要收进弹窗】这页 90% 的使用是"看台账"，只有少数时候才登记一条。
   * 而原先那张六个字段的表单**常驻在列表上方**，一进页面半屏都是空输入框。
   * 收进弹窗之后，进来第一眼看到的就是台账本身（「界面整理-new」§四.2）。
   */
  const [showCreate, setShowCreate] = useState(false);
  /**
   * 正在展开"改状态"的那一行（null = 都没有展开）。
   *
   * 【为什么由**父组件**持有，而不是每一行自己 useState】提交成功后要把这一行收起来，
   * 而"成功"只有父组件知道（它发请求、它刷新列表）。放在子组件里就得再想办法
   * 把"成功了"传回去 —— 那是把一件事拆成两处状态。同 UsersPage 的做法。
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<ApiError | null>(null);
  const [outcome, setOutcome] = useState<CreateSubmissionResponse | null>(null);

  /** 正在改状态的那一条。用 id 而不是布尔值：列表里同时只该有一条在动，
   *  否则一个全局的 "busy" 会把所有行一起禁用，用户看不出是哪条在处理。 */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; error: ApiError } | null>(null);

  /**
   * 超期待办（阶段 6）。服务端已经把可见性收口在 SQL 里 —— 成员拿到的就是
   * 挂在自己投稿上的那些，管理员拿到全部 —— 所以这里按 targetId 直接索引即可，
   * 前端不必、也不该再判一次归属。
   */
  const [tasks, setTasks] = useState<readonly PatrolTask[]>([]);

  /**
   * 正在确认忽略的那条待办。弹窗提到**页面级**（而不是塞进每一行），
   * 否则一个列表里会挂出十几个弹窗，且每行的触发按钮滚动时会各挂在各处。
   */
  const [dismissTarget, setDismissTarget] = useState<PatrolTask | null>(null);
  const [dismissReason, setDismissReason] = useState('');
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<ApiError | null>(null);

  /** 正在为哪篇稿件新增一轮投稿（null = 弹窗关着）。 */
  const [roundTarget, setRoundTarget] = useState<Submission | null>(null);
  const [roundCreating, setRoundCreating] = useState(false);
  const [roundFormError, setRoundFormError] = useState<string | null>(null);
  const [roundError, setRoundError] = useState<ApiError | null>(null);
  const [roundNotice, setRoundNotice] = useState<string | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<Submission | null>(null);
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [detailsError, setDetailsError] = useState<ApiError | null>(null);
  const [detailsFormError, setDetailsFormError] = useState<string | null>(null);
  const [detailsNotice, setDetailsNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Submission | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);
  const algorithmRef = useRef<HTMLInputElement>(null);
  const submitterRef = useRef<HTMLInputElement>(null);
  const journalRef = useRef<HTMLInputElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const submittedOnRef = useRef<HTMLInputElement>(null);
  const statusSinceRef = useRef<HTMLInputElement>(null);
  const submissionNumberRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLInputElement>(null);

  const loadList = useCallback(async (signal?: AbortSignal) => {
    try {
      const body = await apiGet<ListSubmissionsResponse>('/api/v1/submissions', signal);
      setItems(body.items);
      setListError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setListError(toApiError(err));
    }
  }, []);

  const loadTasks = useCallback(async (signal?: AbortSignal) => {
    try {
      const body = await apiGet<PatrolTasksResponse>('/api/v1/patrol/tasks', signal);
      setTasks(body.items);
    } catch (err) {
      if (isAbort(err)) return;
      // 待办只是台账上的一层标注，是**次要资源** —— 取不到不该把整页拦下来。
      // 失败时留空：这一页照常显示，只是没有超期药丸与「忽略」。
      setTasks([]);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    const refresh = () => {
      void loadList(ac.signal);
      void loadTasks(ac.signal);
    };
    refresh();
    window.addEventListener(LEDGER_RESTORED_EVENT, refresh);
    return () => {
      ac.abort();
      window.removeEventListener(LEDGER_RESTORED_EVENT, refresh);
    };
  }, [loadList, loadTasks]);

  // ⌘K 搜到某条投稿后带 `?focus=` 进来：列表加载完成后把那一行滚进视野。
  useFocusTarget('submission-', items !== null);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitterPersonId = String(new FormData(event.currentTarget).get('submitterPersonId') ?? '').trim();
    const title = titleRef.current?.value.trim() ?? '';
    if (title === '') {
      setFormError('请填写稿件标题。');
      return;
    }
    const submittedOn = submittedOnRef.current?.value ?? '';
    if (status !== 'preparing' && submittedOn === '') {
      setFormError('「准备中」以外的状态请填写投稿日期。实在记不清可以先记成准备中，之后再补。');
      return;
    }

    setFormError(null);
    setCreateError(null);
    setOutcome(null);
    setCreating(true);

    try {
      const result = await apiPost<CreateSubmissionResponse>('/api/v1/submissions', {
        title,
        ...(submitterPersonId ? { submitterPersonId } : {}),
        // 空串不发出去：服务端把空串与"未提供"当同一件事，
        // 但少传一个字段，契约上少一种需要解释的输入。
        ...(trimmed(algorithmRef.current?.value) !== undefined
          ? { algorithmAbbr: trimmed(algorithmRef.current?.value) }
          : {}),
        ...(trimmed(submitterRef.current?.value) !== undefined
          ? { submitterName: trimmed(submitterRef.current?.value) }
          : {}),
        ...(trimmed(journalRef.current?.value) !== undefined
          ? { journalName: trimmed(journalRef.current?.value) }
          : {}),
        ...(trimmed(fieldRef.current?.value) !== undefined
          ? { journalField: trimmed(fieldRef.current?.value) }
          : {}),
        status,
        ...(submittedOn !== '' ? { submittedOn } : {}),
        ...(trimmed(statusSinceRef.current?.value) !== undefined
          ? { statusSince: trimmed(statusSinceRef.current?.value) }
          : {}),
        ...(trimmed(submissionNumberRef.current?.value) !== undefined
          ? { submissionNumber: trimmed(submissionNumberRef.current?.value) }
          : {}),
        ...(trimmed(notesRef.current?.value) !== undefined
          ? { notes: trimmed(notesRef.current?.value) }
          : {}),
      });
      setOutcome(result);

      // 成功才清空表单。失败时保留用户填的内容 —— 让他重填一遍
      // 是那种"再也不想用第二次"的体验。
      if (titleRef.current !== null) titleRef.current.value = '';
      if (algorithmRef.current !== null) algorithmRef.current.value = '';
      if (submitterRef.current !== null) submitterRef.current.value = '';
      if (journalRef.current !== null) journalRef.current.value = '';
      if (fieldRef.current !== null) fieldRef.current.value = '';
      if (submittedOnRef.current !== null) submittedOnRef.current.value = '';
      if (statusSinceRef.current !== null) statusSinceRef.current.value = '';
      if (submissionNumberRef.current !== null) submissionNumberRef.current.value = '';
      if (notesRef.current !== null) notesRef.current.value = '';
      setStatus('preparing');
      // 登记成功就把弹窗收起来（「界面整理-new」§四.2：填完自动关闭并刷新列表）。
      // 失败**不关**：保留用户填的内容，让他改一处再提交，而不是重填六个字段。
      setShowCreate(false);
      await loadList();
    } catch (err) {
      setCreateError(toApiError(err));
    } finally {
      setCreating(false);
    }
  }

  async function onChangeStatus(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    if (busyId !== null) return;

    const form = event.currentTarget;
    const data = new FormData(form);
    const next = String(data.get('status') ?? '');
    const note = String(data.get('note') ?? '').trim();
    const statusSince = String(data.get('statusSince') ?? '').trim();

    setBusyId(id);
    setRowError(null);
    try {
      await apiPost<UpdateSubmissionStatusResponse>(
        `/api/v1/submissions/${encodeURIComponent(id)}/status`,
        {
          status: next,
          ...(statusSince !== '' ? { statusSince } : {}),
          ...(note !== '' ? { note } : {}),
        },
      );
      // 改成了才把这一行的编辑条收起来。失败时留着 —— 错误提示就在这一行里，
      // 收起来等于把提示和它要修的那张表单一起藏了。
      setEditingId(null);
      await loadList();
    } catch (err) {
      setRowError({ id, error: toApiError(err) });
    } finally {
      setBusyId(null);
    }
  }

  async function onCreateRound(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (roundTarget === null || roundCreating) return;
    const data = new FormData(event.currentTarget);
    const status = String(data.get('status') ?? '');
    const submittedOn = String(data.get('submittedOn') ?? '').trim();
    if (status !== 'preparing' && submittedOn === '') {
      setRoundFormError('「准备中」以外的状态请填写这一轮的投稿日期。');
      return;
    }

    const journalName = String(data.get('journalName') ?? '').trim();
    const journalField = String(data.get('journalField') ?? '').trim();
    const submissionNumber = String(data.get('submissionNumber') ?? '').trim();
    const statusSince = String(data.get('statusSince') ?? '').trim();
    const notes = String(data.get('notes') ?? '').trim();

    setRoundFormError(null);
    setRoundError(null);
    setRoundCreating(true);
    try {
      const res = await apiPost<CreateSubmissionRoundResponse>(
        `/api/v1/submissions/${encodeURIComponent(roundTarget.id)}/rounds`,
        {
          status,
          ...(journalName !== '' ? { journalName } : {}),
          ...(journalField !== '' ? { journalField } : {}),
          ...(submittedOn !== '' ? { submittedOn } : {}),
          ...(statusSince !== '' ? { statusSince } : {}),
          ...(submissionNumber !== '' ? { submissionNumber } : {}),
          ...(notes !== '' ? { notes } : {}),
        },
      );
      setRoundTarget(null);
      setRoundNotice(
        `已为「${res.submission.title}」新增第 ${res.round.roundNo} 次投稿` +
          `${res.journalCreated ? '（期刊是这次新建的）' : ''}。`,
      );
      await loadList();
    } catch (err) {
      setRoundError(toApiError(err));
    } finally {
      setRoundCreating(false);
    }
  }

  async function onConfirmDismiss() {
    if (dismissTarget === null) return;
    setDismissing(true);
    setDismissError(null);
    try {
      const trimmed = dismissReason.trim();
      await apiPost<DismissPatrolTaskResponse>(
        `/api/v1/patrol/tasks/${encodeURIComponent(dismissTarget.id)}/dismiss`,
        // 空理由不发出去：服务端把空串与"未提供"当同一件事，少传一个字段少一种输入。
        trimmed === '' ? {} : { reason: trimmed },
      );
      setDismissTarget(null);
      setDismissReason('');
      // 忽略改的是**待办**、不是投稿 —— 所以只重拉待办，不重拉台账
      // （台账那一行一个字都没变，重拉它只会让整页闪一下）。
      await loadTasks();
    } catch (err) {
      setDismissError(toApiError(err));
    } finally {
      setDismissing(false);
    }
  }

  async function onEditDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (detailsTarget === null || detailsSaving) return;
    const data = new FormData(event.currentTarget);
    const value = (key: string): string => String(data.get(key) ?? '').trim();
    const title = value('title');
    if (title === '') {
      setDetailsFormError('稿件标题不能为空。');
      return;
    }
    const submittedOn = value('submittedOn');
    if (detailsTarget.status === 'preparing' && submittedOn !== '') {
      setDetailsFormError('准备中的稿件不能填写投稿日期；请先改变状态。');
      return;
    }
    setDetailsFormError(null);
    setDetailsError(null);
    setDetailsSaving(true);
    try {
      await apiPatch<UpdateSubmissionResponse>(
        `/api/v1/submissions/${encodeURIComponent(detailsTarget.id)}`,
        {
          expectedRevision: detailsTarget.revision,
          title,
          algorithmAbbr: value('algorithmAbbr') || null,
          submitterName: value('submitterName') || null,
          submitterPersonId: value('submitterPersonId') || null,
          journalName: value('journalName') || null,
          journalField: value('journalField') || null,
          submittedOn: submittedOn || null,
          statusSince: value('statusSince') || null,
          submissionNumber: value('submissionNumber') || null,
          notes: value('notes') || null,
        },
      );
      setDetailsTarget(null);
      setDetailsNotice(`已保存「${title}」的资料。`);
      await Promise.all([loadList(), loadTasks()]);
    } catch (err) {
      setDetailsError(toApiError(err));
    } finally {
      setDetailsSaving(false);
    }
  }

  function onDeleted(title: string) {
    setDeleteTarget(null);
    setEditingId(null);
    setDeleteNotice(`已删除投稿「${title}」。`);
    void loadList();
    void loadTasks();
  }

  // 已经用过的刊名，给录入框做候选，顺手挡住"Nature" / "nature " 这类
  // 只差一个空格的重名 —— 服务端会按大小写不敏感去重，但拼错字它救不了。
  const journalNames = [
    ...new Set((items ?? []).map((s) => s.journal?.name).filter((n): n is string => n !== undefined)),
  ];

  // 待办按投稿 id 索引，好让每一行自己去认领它。
  const taskBySubmission = new Map(tasks.map((t) => [t.targetId, t]));

  const counts =
    items === null
      ? null
      : {
          all: items.length,
          active: items.filter((s) => !isTerminalStatus(s.status)).length,
          done: items.filter((s) => isTerminalStatus(s.status)).length,
          overdue: items.filter((s) => taskBySubmission.get(s.id)?.status === 'open').length,
        };

  const visible =
    items === null
      ? null
      : items.filter((s) => {
          if (filter === 'active') return !isTerminalStatus(s.status);
          if (filter === 'done') return isTerminalStatus(s.status);
          if (filter === 'overdue') return taskBySubmission.get(s.id)?.status === 'open';
          return true;
        });

  const filterLabel = SUBMISSION_FILTERS.find((f) => f.key === filter)?.label ?? '全部';

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <div className="page-title">
            <span className="page-title-icon">
              <NavGlyph name="submissions" size={20} />
            </span>
            <h1>投稿台账</h1>
          </div>
          <p className="lead">登记并追踪课题组稿件的审稿流转状态与时间线。</p>
        </div>
        <div className="page-head-actions">
          {/* 全页**只留这一个**刷新（原先列表卡片右上角还有一个）。
              同一页出现两个"刷新"，用户得先想"这两个刷的是不是一样的东西"。 */}
          <button type="button" className="link-btn" onClick={() => void loadList()}>
            <RefreshIcon />
            刷新
          </button>
          <button type="button" className="btn-primary" onClick={() => setShowCreate(true)}>
            + 登记投稿
          </button>
        </div>
      </div>

      {/* 快速筛选条：点一下就把列表收到那一档，不用靠滚动去数。
          做成 <Link> 而不是按钮 —— 每一档都有自己的地址（同知识库材料标签页）。
          计数来自服务端已按权限过滤后的数据，前端不再判一次归属。 */}
      {items !== null && items.length > 0 && (
        <nav className="tabs" aria-label="按稿件状态筛选">
          {SUBMISSION_FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <Link
                key={f.key}
                to={f.key === 'all' ? '/submissions' : `/submissions?filter=${f.key}`}
                className={active ? 'tab active' : 'tab'}
                aria-current={active ? 'page' : undefined}
              >
                {f.label}
                {counts !== null && <span className="tab-count">{counts[f.key]}</span>}
              </Link>
            );
          })}
        </nav>
      )}

      <Modal
        open={showCreate}
        wide
        title="登记一篇投稿"
        onClose={() => setShowCreate(false)}
        footer={
          <>
            <button type="button" className="link-btn" disabled={creating} onClick={() => setShowCreate(false)}>
              取消
            </button>
            {/* 提交按钮在 `<form>` 外面，用 htmlFor 关联到表单上 ——
                这样它仍走原生提交路径（回车键、浏览器校验都对），
                而按钮本身能留在底部动作区里（与确认弹窗的位置一致）。 */}
            <button type="submit" form="submission-create" className="btn-primary" disabled={creating}>
              {creating ? '登记中…' : '登记'}
            </button>
          </>
        }
      >
        <form id="submission-create" className="form-row" onSubmit={(e) => void onCreate(e)}>
          <label className="field" style={{ flex: '1 1 100%' }}>
            <span>稿件标题</span>
            <input name="title" ref={titleRef} type="text" placeholder="必填" />
          </label>

          <label className="field">
            <span>算法/稿件简称（可留空）</span>
            <input name="algorithmAbbr" ref={algorithmRef} type="text" placeholder="如 DEMO-Net" />
          </label>

          <label className="field">
            <span>投稿人（可留空）</span>
            <input name="submitterName" ref={submitterRef} type="text" placeholder="实际负责投稿的人，不是录入者" />
          </label>
          <PersonPicker name="submitterPersonId" people={[]} initialId="" initialName={null} />

          <label className="field">
            <span>期刊（可留空）</span>
            <input name="journalName" ref={journalRef} type="text" list="journal-names" placeholder="留空表示还没定" />
            <datalist id="journal-names">
              {journalNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </label>

          <label className="field">
            <span>领域（可留空）</span>
            <input name="journalField" ref={fieldRef} type="text" placeholder="仅新建期刊时写入" />
          </label>

          <label className="field">
            <span>当前状态</span>
            <select
              name="status"
              value={status}
              onChange={(e) => setStatus(e.target.value as SubmissionStatus)}
            >
              {SUBMISSION_STATUSES.map((s) => (
                <option key={s} value={s}>{SUBMISSION_STATUS_LABELS[s]}</option>
              ))}
            </select>
          </label>

          {/* 「准备中」= 还没投出去，所以投稿时间在这一档下没有意义。
              界面上禁掉它，服务端也会拒（两边都要拦，理由同 consentConfirmed）。 */}
          <label className="field">
            <span>投稿日期{status === 'preparing' ? '（准备中无需填）' : ''}</span>
            <input name="submittedOn" ref={submittedOnRef} type="date" disabled={status === 'preparing'} />
          </label>

          <label className="field">
            <span>进入当前状态的日期（可留空）</span>
            <input name="statusSince" ref={statusSinceRef} type="date" />
          </label>

          <label className="field">
            <span>投稿号 / 稿件编号（可留空）</span>
            <input name="submissionNumber" ref={submissionNumberRef} type="text" placeholder="期刊分配的编号" />
          </label>

          <label className="field">
            <span>备注（可留空）</span>
            <input name="notes" ref={notesRef} type="text" placeholder="如「共同一作」" />
          </label>
          {/* 提交按钮**不在这里** —— 它在弹窗底部的动作区里（`form="submission-create"`），
              与其它弹窗的"取消 / 确定"待在同一个位置。 */}
        </form>

        {formError !== null && (
          <div className="notice err"><p className="notice-body">{formError}</p></div>
        )}

        {createError !== null && (
          <ErrorNotice error={createError} onRetry={() => setCreateError(null)} />
        )}
      </Modal>

      {/* 登记成功的回执落在**页面上**（不是弹窗里）—— 弹窗此时已经关掉了，
          而"期刊是这次新建的 / 复用了已有记录"这件事用户得看得到。
          它是这一页里唯一一条"刚刚发生了什么"，刷新即消失。 */}
      {roundNotice !== null && (
        <div className="notice ok">
          <p className="notice-body" style={{ margin: 0 }}>{roundNotice}</p>
        </div>
      )}

      {outcome !== null && (
        <div className="notice ok">
          <p className="notice-title">
            <span className="pill ok">已登记</span>{' '}
            <span className="dim">{outcome.submission.title}</span>
          </p>
          <p className="notice-body" style={{ marginBottom: 0 }}>
            {outcome.submission.journal !== null ? (
              <>
                期刊「{outcome.submission.journal.name}」
                {outcome.journalCreated
                  ? '是这次新建的，分区库还没收录它 —— 到期刊分区库补录一条即可显示在这里。'
                  : '复用了已有记录，本页其余同名稿件共享它的分区。'}
              </>
            ) : (
              '没有填期刊。之后可以随时补，也可以先这样记着。'
            )}
          </p>
        </div>
      )}

      <div className="card submissions-list-panel">
        <h2>投稿记录{visible !== null && `（${visible.length} 条）`}</h2>
        <p className="dim">登录成员可查看全部投稿。录入人、导师和管理员可以编辑资料和更新进展。</p>
        {detailsNotice !== null && <div className="notice ok" role="status"><p className="notice-body">{detailsNotice}</p></div>}
        {deleteNotice !== null && <div className="notice ok" role="status"><p className="notice-body">{deleteNotice}</p></div>}

        {listError !== null && <ErrorNotice error={listError} onRetry={() => void loadList()} />}
        {items === null && listError === null && <SkeletonList rows={3} />}
        {items !== null && items.length === 0 && (
          <EmptyState
            icon="submissions"
            preview={<SubmissionEmptyPreview />}
            action={
              <button
                type="button"
                className="btn-primary"
                onClick={() => setShowCreate(true)}
              >
                登记第一篇投稿
              </button>
            }
          >
            还没有投稿记录。登记后，每篇稿件会显示期刊、当前状态和关键日期；
            展开卡片可查看状态轨迹与投稿轮次。
          </EmptyState>
        )}

        {/* 筛选后的空态与"一条都还没登记"是两件事：前者要告诉人
            "换一档或看全部"，后者才该引导去登记第一篇。 */}
        {visible !== null && items !== null && items.length > 0 && visible.length === 0 && (
          <EmptyState
            icon="submissions"
            action={<Link className="link-btn" to="/submissions">查看全部投稿</Link>}
          >
            「{filterLabel}」这一档下没有投稿。换一档看看，或者查看全部。
          </EmptyState>
        )}

        {visible !== null && visible.length > 0 && (
          <ul className="sub-list">
            {visible.map((s, index) => (
              <SubmissionItem
                key={s.id}
                submission={s}
                initialExpanded={index === 0}
                patrolTask={taskBySubmission.get(s.id)}
                busy={busyId === s.id}
                editing={editingId === s.id}
                onToggleEdit={() => setEditingId(editingId === s.id ? null : s.id)}
                error={rowError !== null && rowError.id === s.id ? rowError.error : null}
                onSubmit={(e) => void onChangeStatus(e, s.id)}
                onDismiss={(task) => setDismissTarget(task)}
                onDismissError={() => setRowError(null)}
                onAddRound={() => {
                  setRoundTarget(s);
                  setRoundFormError(null);
                  setRoundError(null);
                }}
                onEditDetails={() => {
                  setDetailsTarget(s);
                  setDetailsError(null);
                  setDetailsFormError(null);
                  setDetailsNotice(null);
                }}
                onDelete={() => {
                  setDeleteTarget(s);
                  setDeleteNotice(null);
                }}
              />
            ))}
          </ul>
        )}

        {/* 这一段解释「已超期 N 天」是怎么来的。**不能把 14/60/30/90 写死** ——
            阈值现在由管理员在「巡检」页配置，写死的那一版迟早会跟实际不符
            （原先那句正是这么变成假的）。 */}
        <p className="dim" style={{ fontSize: '0.75rem', margin: '14px 0 0' }}>
          「已超期 N 天」由巡检按<b>各档超期阈值</b>自动判出（分「待初审 / 外审 / 修回后再审 / 待上线」四档，
          阈值由管理员在「巡检」页配置），不是谁手动标的。忽略只对<b>这一版</b>投稿生效 ——
          投稿再更新、又还超期，会重新提醒。
        </p>
      </div>

      <Modal
        open={detailsTarget !== null}
        wide
        title={detailsTarget === null ? '编辑投稿资料' : `编辑「${detailsTarget.title}」的资料`}
        onClose={() => { if (!detailsSaving) setDetailsTarget(null); }}
        footer={<>
          <button type="button" className="link-btn" disabled={detailsSaving} onClick={() => setDetailsTarget(null)}>取消</button>
          <button type="submit" form="submission-details-edit" className="btn-primary" disabled={detailsSaving}>{detailsSaving ? '保存中…' : '保存修改'}</button>
        </>}
      >
        {detailsTarget !== null && (
          <form key={detailsTarget.id} id="submission-details-edit" className="form-row" onSubmit={(e) => void onEditDetails(e)}>
            <label className="field" style={{ flex: '1 1 100%' }}><span>稿件标题</span><input name="title" type="text" defaultValue={detailsTarget.title} required /></label>
            <label className="field"><span>算法/稿件简称</span><input name="algorithmAbbr" type="text" defaultValue={detailsTarget.algorithmAbbr ?? ''} /></label>
            <label className="field"><span>投稿人</span><input name="submitterName" type="text" defaultValue={detailsTarget.submitterName ?? ''} /></label>
            <PersonPicker name="submitterPersonId" people={[]} initialId={detailsTarget.submitterPersonId ?? ''}
              initialName={detailsTarget.submitterName} />
            <label className="field"><span>当前轮次期刊</span><input name="journalName" type="text" list="edit-journal-names" defaultValue={detailsTarget.journal?.name ?? ''} /><datalist id="edit-journal-names">{journalNames.map((name) => <option key={name} value={name} />)}</datalist></label>
            <label className="field"><span>领域（仅新建期刊时填写）</span><input name="journalField" type="text" /></label>
            <label className="field"><span>当前轮次投稿日期</span><input name="submittedOn" type="date" defaultValue={detailsTarget.submittedOn ?? (detailsTarget.submittedAt === null ? '' : fmtDate(detailsTarget.submittedAt))} disabled={detailsTarget.status === 'preparing'} /></label>
            <label className="field"><span>进入当前状态的日期</span><input name="statusSince" type="date" defaultValue={detailsTarget.statusSince ?? ''} /></label>
            <label className="field"><span>当前轮次投稿编号</span><input name="submissionNumber" type="text" defaultValue={detailsTarget.submissionNumber ?? ''} /></label>
            <label className="field" style={{ flex: '1 1 100%' }}><span>备注</span><input name="notes" type="text" defaultValue={detailsTarget.notes ?? ''} /></label>
            <p className="dim" style={{ flexBasis: '100%', margin: 0, fontSize: '.8125rem' }}>这里只订正稿件和当前轮次的资料；以前的投稿轮次不会改动。状态变化请使用卡片中的「改状态」。</p>
            {detailsFormError !== null && <div className="notice err" style={{ flexBasis: '100%' }}>{detailsFormError}</div>}
            {detailsError !== null && <ErrorNotice error={detailsError} onRetry={() => setDetailsError(null)} />}
            {detailsError?.body.error.message.includes('已被其他人更新') && (
              <button type="button" className="btn-outline" onClick={() => { setDetailsTarget(null); void loadList(); }}>
                关闭并加载最新资料
              </button>
            )}
          </form>
        )}
      </Modal>

      <ConfirmDialog
        open={dismissTarget !== null}
        title="忽略这条超期提醒？"
        confirmLabel="忽略"
        busyLabel="忽略中…"
        cancelLabel="取消"
        busy={dismissing}
        danger={false}
        onConfirm={() => void onConfirmDismiss()}
        onCancel={() => {
          if (dismissing) return;
          setDismissTarget(null);
          setDismissReason('');
          setDismissError(null);
        }}
      >
        {dismissTarget !== null && (
          <p style={{ marginTop: 0 }}>
            {dismissTarget.submissionTitle !== null
              ? `「${dismissTarget.submissionTitle}」`
              : '这条投稿'}{' '}
            已超期 {dismissTarget.overdueDays} 天。忽略不只是把它从提醒里划掉 ——
            它记录着「你看过、决定先不管」，投稿下次更新前不会再提醒。
          </p>
        )}
        <label className="field" style={{ flex: '1 1 100%' }}>
          <span>忽略理由（可留空，便于日后回看）</span>
          <input
            type="text"
            value={dismissReason}
            disabled={dismissing}
            maxLength={200}
            placeholder="例如：已与导师确认，等外审结果"
            onChange={(e) => setDismissReason(e.target.value)}
          />
        </label>
        {dismissError !== null && <ErrorNotice error={dismissError} onRetry={() => setDismissError(null)} />}
      </ConfirmDialog>

      <LedgerDeleteDialog kind="submission" target={deleteTarget}
        onCancel={() => setDeleteTarget(null)} onDeleted={onDeleted} />

      <Modal
        open={roundTarget !== null}
        wide
        title={roundTarget === null ? '新增一轮投稿' : `为「${roundTarget.title}」新增一轮投稿`}
        onClose={() => {
          if (!roundCreating) setRoundTarget(null);
        }}
        footer={
          <>
            <button
              type="button"
              className="link-btn"
              disabled={roundCreating}
              onClick={() => setRoundTarget(null)}
            >
              取消
            </button>
            <button type="submit" form="submission-round-create" className="btn-primary" disabled={roundCreating}>
              {roundCreating ? '保存中…' : '新增这一轮'}
            </button>
          </>
        }
      >
        <form id="submission-round-create" className="form-row" onSubmit={(e) => void onCreateRound(e)}>
          <label className="field">
            <span>期刊（可留空）</span>
            <input name="journalName" type="text" list="journal-names" placeholder="转投到哪本刊" />
          </label>
          <label className="field">
            <span>领域（可留空）</span>
            <input name="journalField" type="text" placeholder="仅新建期刊时写入" />
          </label>
          <label className="field">
            <span>这一轮的投稿日期</span>
            <input name="submittedOn" type="date" />
          </label>
          <label className="field">
            <span>当前状态</span>
            <select name="status" defaultValue="pending_initial">
              {SUBMISSION_STATUSES.map((st) => (
                <option key={st} value={st}>{SUBMISSION_STATUS_LABELS[st]}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>进入该状态的日期（可留空）</span>
            <input name="statusSince" type="date" />
          </label>
          <label className="field">
            <span>投稿号 / 稿件编号（可留空）</span>
            <input name="submissionNumber" type="text" placeholder="期刊分配的编号" />
          </label>
          <label className="field" style={{ flex: '1 1 100%' }}>
            <span>备注（可留空）</span>
            <input name="notes" type="text" placeholder="如「被拒后转投」" />
          </label>
        </form>
        {roundFormError !== null && (
          <div className="notice err"><p className="notice-body">{roundFormError}</p></div>
        )}
        {roundError !== null && (
          <ErrorNotice error={roundError} onRetry={() => setRoundError(null)} />
        )}
      </Modal>
    </>
  );
}

function SubmissionItem({
  submission: s,
  initialExpanded,
  patrolTask,
  busy,
  editing,
  onToggleEdit,
  error,
  onSubmit,
  onDismiss,
  onDismissError,
  onAddRound,
  onEditDetails,
  onDelete,
}: {
  submission: Submission;
  initialExpanded: boolean;
  /** 这条投稿上的超期待办（没有就是 undefined）。已按可见范围过滤过。 */
  patrolTask: PatrolTask | undefined;
  busy: boolean;
  /** 这一行是否正展开着"改状态"编辑条。状态由父组件持有（见 SubmissionsPage 里的说明）。 */
  editing: boolean;
  onToggleEdit: () => void;
  error: ApiError | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDismiss: (task: PatrolTask) => void;
  onDismissError: () => void;
  onAddRound: () => void;
  onEditDetails: () => void;
  onDelete: () => void;
}) {
  const journal = s.journal;
  const rank = s.ranking;
  const [expanded, setExpanded] = useState(initialExpanded);

  const { can, user } = useAuth();
  const recordedByMe = user !== null && s.submittedById === user.id;
  const canEdit = recordedByMe || can('submission.write.all');

  return (
    <li className={`sub-item sub-record${expanded ? ' is-expanded' : ''}`} id={`submission-${s.id}`}>
      <div className="sub-record-head">
        <span className="sub-journal-mark" aria-hidden="true">
          {journalMonogram(journal?.name ?? '', journal?.abbr)}
        </span>
        <div className="sub-record-identity">
          <h3 className="sub-title">
            {s.title}
            {s.algorithmAbbr !== null && <span className="sub-algorithm">（{s.algorithmAbbr}）</span>}
          </h3>
          <div className="sub-record-byline">
            <p className="sub-record-journal">
              <span className="record-field-label">期刊</span>
              <span className="sub-journal">{journal?.name ?? '未填期刊'}</span>
              {journal?.abbr !== undefined && journal?.abbr !== null && <span className="sub-journal-extra">（{journal.abbr}）</span>}
              {journal?.field !== undefined && journal?.field !== null && <span className="sub-journal-extra"> · {journal.field}</span>}
            </p>
            <p className="sub-record-person"><span className="record-field-label">投稿人</span><span className="record-person-value">{s.submitterName ?? '未记录'}</span></p>
          </div>
        </div>
        <div className="sub-record-flags">
          <span className={`pill sub-status-pill ${statusTone(s.status)}`}>{SUBMISSION_STATUS_LABELS[s.status]}</span>
          {patrolTask !== undefined && <OverduePill task={patrolTask} />}
        </div>
        {canEdit && (
          <button type="button" className="sub-record-edit" onClick={onEditDetails}>
            编辑资料
          </button>
        )}
        {(recordedByMe || can('ledger.delete.all')) && (
          <button
            type="button"
            className="sub-record-delete"
            aria-label={`删除投稿「${s.title}」`}
            onClick={onDelete}
          >
            删除记录
          </button>
        )}
        <button
          type="button"
          className="sub-record-toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? `submission-details-${s.id}` : undefined}
          aria-label={`${expanded ? '收起' : '展开'}「${s.title}」的详细信息`}
          onClick={() => setExpanded((value) => !value)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <dl className="sub-record-facts">
        <div><dt>投稿轮次</dt><dd>第 {s.currentRoundNo} 次投稿</dd></div>
        <div><dt>投稿编号</dt><dd className="mono">{s.submissionNumber ?? '未记录'}</dd></div>
        <div><dt>当前状态</dt><dd><span className={`sub-fact-status ${statusTone(s.status)}`}>{SUBMISSION_STATUS_LABELS[s.status]}</span></dd></div>
        <div><dt>投稿日期</dt><dd className="record-date-value">{(s.submittedOn ?? fmtDate(s.submittedAt)) || '未记录'}</dd></div>
        <div><dt>进入当前状态</dt><dd className="record-date-value">{s.statusSince ?? '未记录'}</dd></div>
        {patrolTask !== undefined && <div><dt>超期提醒</dt><dd className={patrolTask.status === 'open' ? 'sub-fact-overdue' : ''}>{patrolTask.status === 'open' ? `${patrolTask.overdueDays} 天` : '已忽略'}</dd></div>}
      </dl>

      {error !== null && <ErrorNotice error={error} onRetry={onDismissError} />}

      {expanded && <div className="sub-record-details" id={`submission-details-${s.id}`}>
        <div className="sub-record-context">
          <p>
            <span className="sub-context-label">期刊分区</span>
            {rank === null ? (
              <Link
                className="sub-journal-link"
                to={journal === null ? '/journals' : { pathname: '/journals', search: `?q=${encodeURIComponent(journal.name)}&add=1` }}
              >
                未收录 · 前往期刊分区库补录
              </Link>
            ) : (
              <span>
                {rank.system} {rank.year} 年
                {rank.category !== '' && <>（{rank.category}）</>} <b>{rank.rank}</b>
                {rank.top && <span className="sub-top"> Top</span>}
                {isUnverifiedSource(rank.source) && <span className="sub-unverified"> · 未经核对</span>}
              </span>
            )}
          </p>
          <p><span className="sub-context-label">投稿人</span>{s.submitterName ?? '未记录'}</p>
          <p><span className="sub-context-label">录入人</span>{s.submittedByName ?? '未记录'}</p>
          <p><span className="sub-context-label">最近更新</span><time dateTime={s.updatedAt} title={fmtDateTime(s.updatedAt)}>{fmtUpdatedAgo(s.updatedAt)}</time></p>
        </div>
        {s.notes !== null && s.notes !== '' && <p className="sub-record-note"><b>备注</b>{s.notes}</p>}

        {s.history.length > 0 && (
          <div className="sub-progress-wrap">
            <h4>状态轨迹</h4>
            <ol className="sub-progress" tabIndex={0} aria-label="状态轨迹，可横向滚动查看全部变更">
              {s.history.map((h, index) => (
                <li key={h.id} className={index === s.history.length - 1 ? 'current' : ''}>
                  <span className="sub-progress-node" aria-hidden="true" />
                  <strong>{h.fromStatus === null ? `建档 · ${SUBMISSION_STATUS_LABELS[h.toStatus]}` : SUBMISSION_STATUS_LABELS[h.toStatus]}</strong>
                  <time dateTime={h.changedAt}>{fmtDateTime(h.changedAt)}</time>
                  {h.note !== null && h.note !== '' && <span>{h.note}</span>}
                </li>
              ))}
            </ol>
          </div>
        )}

      {canEdit && (
        editing ? (
          // 展开态：紧凑的一行编辑条（「界面整理-new」§四.2）。
          // 默认态只留一颗「改状态」—— 原先每一行都常驻这套表单和一个实心大按钮，
          // 十条记录就是十个深青色按钮，整屏的主次全乱了。
          <form className="sub-actions" onSubmit={onSubmit}>
            <label className="field">
              <span>改为</span>
              <select name="status" defaultValue={s.status} disabled={busy}>
                {SUBMISSION_STATUSES.map((st) => (
                  <option key={st} value={st} disabled={st === s.status}>
                    {SUBMISSION_STATUS_LABELS[st]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>进入该状态的日期（可留空）</span>
              <input name="statusSince" type="date" disabled={busy} />
            </label>
            <label className="field">
              <span>变更说明（可留空）</span>
              <input name="note" type="text" placeholder="会记进时间线" disabled={busy} />
            </label>
            {/* 保存是这一行的主操作，用次级尺寸就够了 —— 页头那个「+ 登记投稿」
                才是整页的主按钮。一屏里出现十几个实心主按钮等于没有主按钮。 */}
            <button type="submit" className="btn-primary btn-sm" disabled={busy}>
              {busy ? '提交中…' : '保存'}
            </button>
            <button type="button" className="link-btn" disabled={busy} onClick={onToggleEdit}>
              取消
            </button>
          </form>
        ) : (
          <div className="sub-actions-idle">
            <button type="button" className="btn-outline" onClick={onToggleEdit}>
              改状态
            </button>
            <button type="button" className="btn-outline" onClick={onAddRound}>
              转投 / 新增一轮
            </button>
          </div>
        )
      )}

      {patrolTask !== undefined && patrolTask.status === 'open' && (
        <button type="button" className="link-btn sub-dismiss-action" onClick={() => onDismiss(patrolTask)}>
          忽略这条超期提醒
        </button>
      )}

      {s.rounds.length > 1 && (
        <details className="sub-history">
          <summary>投稿轮次（{s.rounds.length}）</summary>
          <ol className="timeline">
            {s.rounds.map((r) => (
              <li key={r.id}>
                第 {r.roundNo} 次 · {r.journal?.name ?? '未填期刊'}
                {r.journal?.abbr !== null && r.journal?.abbr !== undefined && <>（{r.journal.abbr}）</>}
                {' · '}
                {r.submittedOn ?? '日期未记录'}
                {' · '}
                {SUBMISSION_STATUS_LABELS[r.status]}
                {r.statusSince !== null && <span className="dim">（{r.statusSince} 进入）</span>}
                {r.submissionNumber !== null && (
                  <span className="dim"> · 投稿号 {r.submissionNumber}</span>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}

      <RecordEdits edits={s.edits} />

      </div>}
    </li>
  );
}

/** 空态里的示意行：只说明"有记录后长什么样"，不参与读屏与数据。 */
function SubmissionEmptyPreview() {
  return (
    <div className="empty-demo" aria-hidden="true">
      <p className="empty-demo-label">
        <span className="pill">示例</span>
        有记录后，这一块长这样
      </p>
      <div className="empty-demo-row">
        <span className="empty-demo-main">
          <span className="empty-demo-title">一篇准备中的稿件</span>
          <span className="empty-demo-meta">期刊未定 · 刚刚更新</span>
        </span>
        <span className="pill">{SUBMISSION_STATUS_LABELS.preparing}</span>
      </div>
      <div className="empty-demo-row">
        <span className="empty-demo-main">
          <span className="empty-demo-title">一篇已投出的稿件</span>
          <span className="empty-demo-meta">示例期刊 · 已投稿 12 天</span>
        </span>
        <span className="pill">{SUBMISSION_STATUS_LABELS.under_review}</span>
      </div>
      <p className="empty-demo-note">状态时间线在行内展开，不需要另开详情页。</p>
    </div>
  );
}

/**
 * 状态对应的 pill 配色。
 *
 * 状态色帮助扫读：待初审用蓝、外审与修回后再审用暖金、
 * 已录用与已发表用绿、拒稿与撤稿用红。超期另有明确的红色文字和天数，
 * 阶段颜色本身不表示超期。
 */
function statusTone(status: SubmissionStatus): string {
  if (status === 'pending_initial') return 'pending';
  if (status === 'under_review' || status === 'revision_resubmitted') return 'review';
  if (status === 'accepted_pending' || status === 'published') return 'ok';
  if (status === 'rejected' || status === 'withdrawn') return 'err';
  return 'preparing';
}

/** 期刊的文字识别块只从已登记的名称或缩写生成，不冒充期刊官方标识。 */
function journalMonogram(name: string, abbr: string | null | undefined): string {
  const short = abbr?.replace(/[^\p{L}\p{N}]/gu, '');
  if (short) return Array.from(short).slice(0, 2).join('').toUpperCase();
  const words = name.match(/[A-Za-z]+/g);
  if (words && words.length > 1) return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase();
  return Array.from(name.trim()).slice(0, 2).join('').toUpperCase() || '刊';
}

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t === undefined || t === '' ? undefined : t;
}

