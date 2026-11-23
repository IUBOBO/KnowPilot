import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PageTitle } from '../components/PageTitle.tsx';
import {
  MIN_PASSWORD_LENGTH,
  ROLES,
  USER_STATUSES,
  USER_STATUS_LABELS,
  type CreateUserResponse,
  type ListUsersResponse,
  type ManagedUser,
  type ResetPasswordResponse,
  type Role,
  type UpdateUserResponse,
  type UserStatus,
} from '@knowpilot/shared';
import { apiGet, apiPatch, apiPost, isAbort, toApiError, type ApiError } from '../api.ts';
import { roleLabel, useAuth } from '../auth.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Modal } from '../components/Modal.tsx';
import { RefreshIcon } from '../components/icons.tsx';
import { SkeletonTable } from '../components/Skeleton.tsx';
import { fmtDateTime } from '../format.ts';

/**
 * 用户与权限（阶段 4C 单元 ②）。
 *
 * 【这一页为什么只有 admin 能进】四个接口全挂在 `users.manage` 上，而三个角色
 *   模板里只有 `admin_full` 有这个权限点。没有更细的分档 —— "能看账号列表"
 *   与"能改账号"在本项目里不是两件事（见 server 的 routes.ts）。
 *
 * 【为什么列表页要做成"就地改"而不是每条点进详情页】要改的东西一共就四项
 *   （显示名、角色、状态、课题组），并且管理员来这一页的动机多半是"给谁换个
 *   角色"。跳一层详情页意味着每次改一个字都要多两次导航，还要回答
 *   "我刚才改的是哪个人"。
 *
 * 【为什么把"不能改自己"画在界面上】服务端会拦（见 app.ts 的自锁守卫），
 *   但只靠服务端拦的话，管理员会先填一遍、点保存、吃一个 400 —— 那时他
 *   才第一次知道这条规矩。选择框直接置灰 + 写清为什么，是在他动手**之前**
 *   就说清楚。**注意这只是提前告知，边界仍在服务端**：前端的置灰不构成
 *   任何保护，任何人都能直接调接口。
 */
export function UsersPage() {
  const { user: me, refresh } = useAuth();

  const [state, setState] = useState<ListUsersResponse | null>(null);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<UserStatus | 'all'>('all');
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  /** 改完之后靠它把列表重拉一遍。用一个自增数而不是另写一遍 fetch。 */
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  // 「新建账号」在**同一页**上方，所以空态的下一步是把光标送过去，而不是给链接。
  /** 「新建账号」弹窗是否展开。 */
  const [showCreate, setShowCreate] = useState(false);
  /** 建号回执（关掉弹窗之后由页面显示）。 */
  const [created, setCreated] = useState<string | null>(null);

  /** 建号成功：刷新列表 + 记下回执。 */
  const onCreated = useCallback(
    (message: string) => {
      setCreated(message);
      reload();
    },
    // reload 来自 useAuth，身份稳定；这里显式列出以免漏掉依赖。
    [reload],
  );

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await apiGet<ListUsersResponse>('/api/v1/users', signal);
      if (signal?.aborted) return;
      setState(response);
      setError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setError(toApiError(err));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load, version]);

  /** 正在展开编辑的账号 id。null = 都没有展开。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 正在展开"重置口令"的账号 id。与 editingId 互斥 —— 一行同时开两张表单太挤。 */
  const [resettingId, setResettingId] = useState<string | null>(null);

  /** 某次保存把自己改了（改了显示名），需要让侧栏跟着变。 */
  const onSelfChanged = useCallback(() => {
    void refresh();
  }, [refresh]);
  const visible = state?.items.filter((account) => {
    const needle = query.trim().toLocaleLowerCase();
    return (needle === '' || `${account.username} ${account.displayName} ${account.groupId ?? ''}`.toLocaleLowerCase().includes(needle))
      && (roleFilter === 'all' || account.role === roleFilter)
      && (statusFilter === 'all' || account.status === statusFilter);
  }) ?? null;

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <PageTitle icon="users">用户与权限</PageTitle>
          <p className="lead">管理账号、角色权限模板与登录状态。</p>
        </div>
        <div className="page-head-actions">
          <button type="button" className="link-btn" disabled={loading} onClick={() => void load()}>
            <RefreshIcon />
            刷新
          </button>
          <button type="button" className="btn-primary" onClick={() => setShowCreate(true)}>
            + 新建账号
          </button>
        </div>
      </div>

      <NewUserModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={onCreated} />

      {/* 建号回执落在**页面上**（弹窗此时已经关上）：用户要看的是"建成了谁"，
          而这句话原先写在弹窗里，弹窗一关就没人看见了。 */}
      {created !== null && (
        <div className="notice ok"><p className="notice-body" style={{ margin: 0 }}>{created}</p></div>
      )}

      <div className="card">
        <h2>账号{state !== null && `（${state.items.length}）`}</h2>

        {state !== null && state.items.length > 0 && (
          <div className="users-filter-row">
            <label className="field users-filter-search"><span>搜索账号</span>
              <input type="search" value={query} placeholder="用户名、显示名或课题组" onChange={(event) => setQuery(event.target.value)} />
            </label>
            <label className="field"><span>角色</span>
              <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value as Role | 'all')}>
                <option value="all">全部角色</option>
                {ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
              </select>
            </label>
            <label className="field"><span>状态</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as UserStatus | 'all')}>
                <option value="all">全部状态</option>
                {USER_STATUSES.map((status) => <option key={status} value={status}>{USER_STATUS_LABELS[status]}</option>)}
              </select>
            </label>
          </div>
        )}

        {error !== null && <ErrorNotice error={error} onRetry={() => void load()} />}
        {/* 真实表格 7 列（用户名/显示名/角色/状态/课题组/创建时间/操作），
            所以骨架也用 7 列 —— 列数不一致的话，内容到达时表头宽度会跳一次。 */}
        {state === null && error === null && <SkeletonTable rows={4} cols={7} />}

        {state !== null && state.items.length === 0 && (
          <EmptyState
            icon="users"
            action={
              <button type="button" className="link-btn" onClick={() => setShowCreate(true)}>
                去新建一个
              </button>
            }
          >
            还没有账号。第一个管理员来自 <span className="mono">.env</span> 的
            KNOWPILOT_ADMIN_USER / KNOWPILOT_ADMIN_PASSWORD，只在库为空时创建一次；
            之后都在右上角「新建账号」里建。
          </EmptyState>
        )}

        {state !== null && state.items.length > 0 && visible !== null && visible.length === 0 && (
          <EmptyState icon="users" illustration="no-results">没有匹配的账号，请调整搜索或筛选条件。</EmptyState>
        )}

        {visible !== null && visible.length > 0 && (
          <div className="admin-table-scroll"><table className="table">
            <thead>
              <tr>
                <th style={{ width: 150 }}>用户名</th>
                <th style={{ width: 140 }}>显示名</th>
                <th style={{ width: 90 }}>角色</th>
                <th style={{ width: 90 }}>状态</th>
                <th>课题组</th>
                <th style={{ width: 150 }}>创建时间</th>
                <th style={{ width: 130 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  isSelf={me !== null && me.id === u.id}
                  editing={editingId === u.id}
                  resetting={resettingId === u.id}
                  onToggleEdit={() => {
                    setEditingId(editingId === u.id ? null : u.id);
                    setResettingId(null);
                  }}
                  onToggleReset={() => {
                    setResettingId(resettingId === u.id ? null : u.id);
                    setEditingId(null);
                  }}
                  onClose={() => {
                    setEditingId(null);
                    setResettingId(null);
                  }}
                  onChanged={reload}
                  onSelfChanged={onSelfChanged}
                />
              ))}
            </tbody>
          </table></div>
        )}

        <p className="dim" style={{ fontSize: '0.75rem', margin: '10px 0 0' }}>
          用户名一律转小写保存（<span className="mono">Admin</span> 与 <span className="mono">admin</span> 是同一个账号）。
          管理员可以在「编辑」里改用户名 —— 改的是登录名，不是换账号：
          历史记录与已登录会话都保留，旧用户名从改名起失效。显示名是给人看的，中文随意。
        </p>
      </div>
    </>
  );
}

// ── 新建账号 ────────────────────────────────────────────────────

/**
 * 新建账号（2026-10-16 起收进弹窗）。
 *
 * 【为什么从常驻卡片改成弹窗】管理员日常打开这一页是**看用户表**，
 *   新建账号是一年几次的事。而那张六个字段的表单原先常驻在表格上方，
 *   把表格挤到下半屏（「界面整理-new」§四.2）。
 *
 * 【为什么不再需要 `usernameRef`】原先列表为空时，空态的"下一步"要把光标
 *   送进那张表单（同一页上方）。改成弹窗之后**不用再传 ref** ——
 *   `Modal` 打开时本来就会把焦点给弹窗里第一个输入框，那正是用户名那一格。
 *   少一个从页面穿到表单的 ref，就少一条会随重构失效的连线。
 */
function NewUserModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** 建号成功后回调：父组件刷新列表，并把回执显示在页面上。 */
  onCreated: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);

    const username = String(fd.get('username') ?? '').trim();
    if (username === '') {
      setFormError('用户名不能为空。');
      return;
    }
    if (/\s/.test(username)) {
      setFormError('用户名不能含空格。');
      return;
    }
    const password = String(fd.get('password') ?? '');
    // 前端也拦一道：服务端同样会拒，但让用户为一次必然失败的请求等一个往返，
    // 不如当场说清（理由同期刊分区库那边的时间校验）。
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFormError(`口令至少 ${MIN_PASSWORD_LENGTH} 位。`);
      return;
    }
    const role = String(fd.get('role') ?? '');
    if (!isRole(role)) {
      setFormError('角色只能是管理员、导师或成员。');
      return;
    }

    const displayName = String(fd.get('displayName') ?? '').trim();
    const groupId = String(fd.get('groupId') ?? '').trim();

    setFormError(null);
    setError(null);
    setBusy(true);
    try {
      const res = await apiPost<CreateUserResponse>('/api/v1/users', {
        username,
        password,
        role,
        // 空串不发出去：服务端把空串与"未提供"当同一件事（显示名会退回用户名）。
        // 少传一个字段，契约上就少一种需要解释的输入。
        ...(displayName !== '' ? { displayName } : {}),
        ...(groupId !== '' ? { groupId } : {}),
      });
      // 建成功就关掉弹窗、把回执交给页面显示（失败**不关**：错误提示就在弹窗里，
      // 关掉等于让用户重填一遍六个字段）。
      form.reset();
      onCreated(`已建号「${res.user.displayName}」（用户名 ${res.user.username}，${roleLabel(res.user.role)}）。`);
      onClose();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      wide
      title="新建账号"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="link-btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" form="user-create" className="btn-primary" disabled={busy}>
            {busy ? '建号中…' : '建号'}
          </button>
        </>
      }
    >
      <form id="user-create" className="form-row" onSubmit={(e) => void onSubmit(e)}>
        <label className="field">
          <span>用户名</span>
          <input name="username" type="text" placeholder="用于登录，如 zhangsan" autoComplete="off" />
        </label>
        <label className="field">
          <span>显示名（可留空）</span>
          <input name="displayName" type="text" placeholder="留空则用用户名" />
        </label>
        <label className="field">
          <span>初始口令</span>
          <input name="password" type="password" placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位`} autoComplete="new-password" />
        </label>
        <label className="field">
          <span>角色</span>
          <select name="role" defaultValue="member">
            {ROLES.map((r) => (
              <option key={r} value={r}>{roleLabel(r)}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>课题组（可留空）</span>
          <input name="groupId" type="text" placeholder="当前部署未启用分组" />
        </label>
        <p className="dim" style={{ flexBasis: '100%', margin: 0, fontSize: '0.8125rem' }}>
          口令只查长度（≥ {MIN_PASSWORD_LENGTH} 位）。建完请当面或私下告诉本人，并让他自己登录改掉。
        </p>
        {/* 提交按钮在弹窗底部动作区（`form="user-create"`），不在这里。 */}
      </form>

      {formError !== null && (
        <div className="notice err"><p className="notice-body" style={{ margin: 0 }}>{formError}</p></div>
      )}
      {error !== null && <ErrorNotice error={error} onRetry={() => setError(null)} />}
    </Modal>
  );
}

// ── 一行账号 ────────────────────────────────────────────────────

function UserRow({
  user,
  isSelf,
  editing,
  resetting,
  onToggleEdit,
  onToggleReset,
  onClose,
  onChanged,
  onSelfChanged,
}: {
  user: ManagedUser;
  /** 这一行是当前登录的人自己。**不能禁用自己、不能把自己降级**（见服务端自锁守卫）。 */
  isSelf: boolean;
  editing: boolean;
  resetting: boolean;
  onToggleEdit: () => void;
  onToggleReset: () => void;
  onClose: () => void;
  onChanged: () => void;
  onSelfChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const username = String(fd.get('username') ?? '').trim();
    if (username === '') {
      setFormError('用户名不能为空 —— 它是登录时用的名字。');
      return;
    }
    if (/\s/.test(username)) {
      setFormError('用户名不能含空格。');
      return;
    }
    const displayName = String(fd.get('displayName') ?? '').trim();
    if (displayName === '') {
      setFormError('显示名不能为空 —— 侧栏与记录里都要显示它。');
      return;
    }
    // 自己的那两行选择框是 disabled 的，FormData 里就没有这两个键 ——
    // 于是补丁里也不会出现它们，服务端就不会去改（而不是传个空值把角色洗掉）。
    const role = fd.get('role');
    const status = fd.get('status');
    // 与建号同一条规则：服务端会再归一化一次，这里先转小写只是为了"没改"判断准确。
    const normalizedUsername = username.toLowerCase();
    const renamed = normalizedUsername !== user.username;

    setFormError(null);
    setRowError(null);
    setNotice(null);
    setBusy(true);
    try {
      const groupId = String(fd.get('groupId') ?? '').trim();
      const res = await apiPatch<UpdateUserResponse>(`/api/v1/users/${encodeURIComponent(user.id)}`, {
        // 只在真的改名时才发这个字段：改显示名/角色时没必要顺带写一次用户名。
        ...(renamed ? { username: normalizedUsername } : {}),
        // 只在显示名真的变了时才发。这条很重要：建号时没填显示名的人，
        // 显示名就是当时的用户名；改名时如果这里仍原样回传旧显示名，
        // 服务端就分不清"我要保留它"还是"它只是没改"，自动跟随逻辑会被盖掉。
        ...(displayName !== user.displayName ? { displayName } : {}),
        // 空串 → null = 清空课题组（契约里的三态：缺省=不动、有值=改、空=清空）。
        groupId: groupId === '' ? null : groupId,
        ...(role !== null && isRole(String(role)) ? { role: String(role) as Role } : {}),
        ...(status !== null && isUserStatus(String(status)) ? { status: String(status) as UserStatus } : {}),
      });
      onClose();
      const renamedNote = renamed
        ? `用户名已从「${user.username}」改为「${res.user.username}」—— 旧用户名不能再登录，已登录的会话不受影响。`
        : '';
      setNotice(
        res.sessionsRevoked > 0
          ? `已保存「${res.user.displayName}」，并切断了 ta 的 ${res.sessionsRevoked} 个会话。`
          : renamedNote !== ''
            ? renamedNote
            : `已保存「${res.user.displayName}」。`,
      );
      if (isSelf) onSelfChanged();
      onChanged();
    } catch (err) {
      setRowError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = String(new FormData(form).get('password') ?? '');
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFormError(`口令至少 ${MIN_PASSWORD_LENGTH} 位。`);
      return;
    }

    setFormError(null);
    setRowError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await apiPost<ResetPasswordResponse>(
        `/api/v1/users/${encodeURIComponent(user.id)}/password`,
        { password },
      );
      form.reset();
      onClose();
      setNotice(
        res.sessionsRevoked > 0
          ? `已重设「${res.username}」的口令，并切断 ta 的 ${res.sessionsRevoked} 个会话 —— 旧登录立刻失效。`
          : `已重设「${res.username}」的口令。ta 当前没有活跃会话。`,
      );
      // 重设自己口令后 `refresh()` 会把 /me 再拉一次；会话已失效，拉不到就
      // 保持现状（见 auth.tsx 的 refresh 注释），下一次请求的 401 才把人送去登录页。
      if (isSelf) onSelfChanged();
      onChanged();
    } catch (err) {
      setRowError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  const selfHint = '不能禁用或降级自己的账号 —— 只有管理员持有 users.manage，'
    + '一旦把自己锁掉，管理端就没人能进了。请让另一位管理员来改。';

  return (
    <>
      <tr>
        <td className="mono">
          {user.username}
          {isSelf && <span className="pill" style={{ marginLeft: 6 }}>你</span>}
        </td>
        <td>{user.displayName}</td>
        <td>{roleLabel(user.role)}</td>
        <td>
          <span className={user.status === 'active' ? 'pill ok' : 'pill err'}>
            {USER_STATUS_LABELS[user.status]}
          </span>
        </td>
        <td className="dim">{user.groupId ?? '—'}</td>
        <td className="mono" style={{ fontSize: '0.71875rem' }}>{fmtDateTime(user.createdAt)}</td>
        <td>
          {/* 先「编辑」后「重置口令」：改角色是常见的，重设口令是少见的。
              把常见的放前面，别让人在误点一次才看清哪个影响更大。
              两个按钮必须包在 `.row-actions` 里：不加容器时它们会在窄列里折成两行，
              整行高度翻倍（见 index.css 里那条注释）。 */}
          <span className="row-actions">
            <button type="button" className="link-btn" disabled={busy} onClick={onToggleEdit}>
              编辑
            </button>
            <button type="button" className="link-btn" disabled={busy} onClick={onToggleReset}>
              重置口令
            </button>
          </span>
        </td>
      </tr>

      {editing && (
        <tr>
          <td colSpan={7} style={{ background: 'var(--surface-2)' }}>
            <form className="form-row" onSubmit={(e) => void onSave(e)}>
              <label className="field" style={{ flex: '1 1 180px' }}>
                <span>用户名（登录名）</span>
                <input name="username" type="text" defaultValue={user.username} autoComplete="off" />
              </label>
              <label className="field" style={{ flex: '1 1 180px' }}>
                <span>显示名</span>
                <input name="displayName" type="text" defaultValue={user.displayName} />
              </label>
              <label className="field">
                <span>角色</span>
                <select
                  name="role"
                  defaultValue={user.role}
                  disabled={isSelf}
                  title={isSelf ? selfHint : undefined}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{roleLabel(r)}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>状态</span>
                <select
                  name="status"
                  defaultValue={user.status}
                  disabled={isSelf}
                  title={isSelf ? selfHint : undefined}
                >
                  {USER_STATUSES.map((s) => (
                    <option key={s} value={s}>{USER_STATUS_LABELS[s]}</option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ flex: '1 1 180px' }}>
                <span>课题组（留空 = 未分组）</span>
                <input name="groupId" type="text" defaultValue={user.groupId ?? ''} />
              </label>
              <button type="submit" disabled={busy}>
                {busy ? '保存中…' : '保存'}
              </button>
              <button type="button" className="link-btn" disabled={busy} onClick={onClose}>
                取消
              </button>
            </form>

            <p className="dim" style={{ fontSize: '0.75rem', margin: '8px 0 0' }}>
              改<b>用户名</b>只改登录名：账号、口令、名下记录都不变，已登录的会话也不受影响；
              但<b>旧用户名从此登不进来</b>。你自己改名后，下次登录请用新用户名。
              {isSelf ? (
                <>
                  {' '}{selfHint}显示名与课题组仍可改。
                </>
              ) : (
                <>
                  {' '}改成<b>禁用</b>会立刻切断 ta 的会话；改角色、改显示名不需要重新登录，
                  下一个请求就是新角色（权限是每次请求现从库里读的）。
                  重置口令请看旁边的按钮 —— 它必须把旧会话一起切断。
                </>
              )}
            </p>

            {formError !== null && (
              <div className="notice err"><p className="notice-body" style={{ margin: 0 }}>{formError}</p></div>
            )}
            {rowError !== null && <ErrorNotice error={rowError} onRetry={() => setRowError(null)} />}
          </td>
        </tr>
      )}

      {resetting && (
        <tr>
          <td colSpan={7} style={{ background: 'var(--surface-2)' }}>
            <form className="form-row" onSubmit={(e) => void onReset(e)}>
              <label className="field" style={{ flex: '1 1 240px' }}>
                <span>新口令</span>
                <input
                  name="password"
                  type="password"
                  placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位`}
                  autoComplete="new-password"
                />
              </label>
              <button type="submit" disabled={busy}>
                {busy ? '重设中…' : '重设口令'}
              </button>
              <button type="button" className="link-btn" disabled={busy} onClick={onClose}>
                取消
              </button>
            </form>

            <p className="dim" style={{ fontSize: '0.75rem', margin: '8px 0 0' }}>
              重设口令会<b>切断这个人全部会话</b>：会话里不带口令，不切断的话旧登录照样能用
              —— 那就成了"改了密码，别人还能进"。
            </p>

            {formError !== null && (
              <div className="notice err"><p className="notice-body" style={{ margin: 0 }}>{formError}</p></div>
            )}
            {rowError !== null && <ErrorNotice error={rowError} onRetry={() => setRowError(null)} />}
          </td>
        </tr>
      )}

      {!editing && !resetting && notice !== null && (
        <tr>
          <td colSpan={7} style={{ background: 'var(--surface-2)' }}>
            <div className="notice ok" style={{ margin: 0 }}>
              <p className="notice-body" style={{ margin: 0 }}>{notice}</p>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function isRole(raw: string): raw is Role {
  return (ROLES as readonly string[]).includes(raw);
}

function isUserStatus(raw: string): raw is UserStatus {
  return (USER_STATUSES as readonly string[]).includes(raw);
}
