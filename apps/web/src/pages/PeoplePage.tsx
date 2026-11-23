import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useFocusTarget } from '../use-focus-target.ts';
import {
  PERSON_STATUSES,
  PERSON_STATUS_LABELS,
  type CreatePersonResponse,
  type ListPeopleResponse,
  type ListUsersResponse,
  type ManagedUser,
  type Person,
  type PersonStatus,
  type UpdatePersonResponse,
} from '@knowpilot/shared';
import { apiGet, apiPatch, apiPost, isAbort, toApiError, type ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Modal } from '../components/Modal.tsx';
import { SkeletonTable } from '../components/Skeleton.tsx';
import { NavGlyph } from '../nav-icons.tsx';

/**
 * 人员主档（投稿台账信息优化 · 第二步）。
 *
 * 所有登录角色均可查看学号；服务端仍返回 `studentNoVisible`，用于区分
 * 未录入学号和权限不足。绑定的人员记录由服务端标记 `isSelf`。
 */
export function PeoplePage() {
  const { can } = useAuth();
  const canManage = can('people.manage');
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';

  const [state, setState] = useState<ListPeopleResponse | null>(null);
  useFocusTarget('person-', state !== null);
  const [error, setError] = useState<ApiError | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Person | null>(null);
  const [users, setUsers] = useState<readonly ManagedUser[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await apiGet<ListPeopleResponse>(
        `/api/v1/people?limit=200${q.trim() === '' ? '' : `&q=${encodeURIComponent(q.trim())}`}`,
        signal,
      );
      setState(res);
      setError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setError(toApiError(err));
    }
  }, [q]);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  // 只有能管人才需要账号候选；成员看不到绑定下拉。
  useEffect(() => {
    if (!canManage) return;
    const ac = new AbortController();
    apiGet<ListUsersResponse>('/api/v1/users', ac.signal)
      .then((res) => setUsers(res.items))
      .catch((err: unknown) => {
        if (!isAbort(err)) setUsers([]);
      });
    return () => ac.abort();
  }, [canManage]);

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = new URLSearchParams(params);
    const value = String(new FormData(event.currentTarget).get('q') ?? '').trim();
    if (value === '') next.delete('q');
    else next.set('q', value);
    setParams(next);
  }

  function onSaved(person: Person, created: boolean) {
    setShowCreate(false);
    setEditing(null);
    setNotice(
      created
        ? `已新建人员「${person.name}」。`
        : `已保存「${person.name}」的人员记录。`,
    );
    void load();
  }

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <div className="page-title">
            <span className="page-title-icon">
              <NavGlyph name="users" size={20} />
            </span>
            <h1>人员主档</h1>
          </div>
          <p className="lead">登录成员可查看人员姓名、学号、课题组和状态。</p>
        </div>
        <div className="page-head-actions">
          <button type="button" className="link-btn" onClick={() => void load()}>
            刷新
          </button>
          {canManage && (
            <button type="button" className="btn-primary" onClick={() => setShowCreate(true)}>
              + 新建人员
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <form className="form-row" onSubmit={onSearch}>
          <label className="field" style={{ flex: '1 1 320px' }}>
            <span>搜索</span>
            <input
              name="q"
              type="text"
              defaultValue={q}
              placeholder="按姓名或学号搜索"
            />
          </label>
          <button type="submit">搜索</button>
          {q !== '' && (
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete('q');
                setParams(next);
              }}
            >
              清除
            </button>
          )}
        </form>

        {notice !== null && (
          <div className="notice ok" style={{ marginTop: 12 }}>
            <p className="notice-body" style={{ margin: 0 }}>{notice}</p>
          </div>
        )}

        {error !== null && <ErrorNotice error={error} onRetry={() => void load()} />}
        {state === null && error === null && <SkeletonTable rows={4} cols={canManage ? 7 : 5} />}

        {state !== null && state.items.length === 0 && (
          <EmptyState
            icon="users"
            action={
              canManage ? (
                <button type="button" className="link-btn" onClick={() => setShowCreate(true)}>
                  新建第一条人员记录
                </button>
              ) : undefined
            }
          >
            {q.trim() === ''
              ? '还没有人员记录。管理员可以把课题组人员录入进来。'
              : `没有找到匹配「${q.trim()}」的人员。`}
          </EmptyState>
        )}

        {state !== null && state.items.length > 0 && (
          <>
            <div className="people-table-scroll">
            <table className="table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th style={{ width: 180 }}>姓名</th>
                  <th style={{ width: 95 }}>年级 ↑</th>
                  <th style={{ width: 150 }}>学号</th>
                  <th>课题组</th>
                  <th style={{ width: 100 }}>状态</th>
                  {canManage && <th style={{ width: 180 }}>登录账号</th>}
                  {canManage && <th style={{ width: 90 }}>操作</th>}
                </tr>
              </thead>
              <tbody>
                {state.items.map((p) => (
                  <tr key={p.id} id={`person-${p.id}`}>
                    <td>
                      <span className="person-name">{p.name}</span>
                      {p.isSelf && <span className="pill" style={{ marginLeft: 6 }}>你</span>}
                    </td>
                    <td>
                      {p.grade === null
                        ? <span className="dim">未记录</span>
                        : <span className="person-grade">{p.grade}级</span>}
                    </td>
                    <td className="mono">
                      {p.studentNoVisible ? p.studentNo ?? '—' : <span className="dim">受限</span>}
                    </td>
                    <td>{p.groupId === null ? <span className="dim">—</span> : <span className="person-group">{p.groupId}</span>}</td>
                    <td>
                      <span className={p.status === 'active' ? 'pill ok' : 'pill'}>
                        {PERSON_STATUS_LABELS[p.status]}
                      </span>
                    </td>
                    {canManage && (
                      <td className="dim">
                        {p.linkedUsername === null ? '未绑定' : `@${p.linkedUsername}`}
                      </td>
                    )}
                    {canManage && (
                      <td>
                        <button type="button" className="link-btn" onClick={() => setEditing(p)}>
                          编辑
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <p className="dim" style={{ fontSize: '0.75rem', margin: '10px 0 0' }}>
              共 {state.total} 人
              {q.trim() !== '' && `，匹配 ${state.matched} 人`}
              {state.matched > state.items.length && '（只显示前 200 条）'}。
              按年级从小到大排列，无法从学号识别年级的记录排在末尾。学号按原样以文本保存；未录入显示「—」。
            </p>
          </>
        )}
      </div>

      {canManage && (
        <>
          <PersonModal
            open={showCreate}
            person={null}
            users={users ?? []}
            onClose={() => setShowCreate(false)}
            onSaved={onSaved}
          />
          <PersonModal
            open={editing !== null}
            person={editing}
            users={users ?? []}
            onClose={() => setEditing(null)}
            onSaved={onSaved}
          />
        </>
      )}
    </>
  );
}

function PersonModal({
  open,
  person,
  users,
  onClose,
  onSaved,
}: {
  open: boolean;
  person: Person | null;
  users: readonly ManagedUser[];
  onClose: () => void;
  onSaved: (person: Person, created: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name') ?? '').trim();
    if (name === '') {
      setFormError('姓名不能为空。');
      return;
    }
    const studentNo = String(data.get('studentNo') ?? '').trim();
    const groupId = String(data.get('groupId') ?? '').trim();
    const status = String(data.get('status') ?? 'active') as PersonStatus;
    const userId = String(data.get('userId') ?? '').trim();
    const note = String(data.get('note') ?? '').trim();

    setFormError(null);
    setError(null);
    setBusy(true);
    try {
      if (person === null) {
        const res = await apiPost<CreatePersonResponse>('/api/v1/people', {
          name,
          ...(studentNo !== '' ? { studentNo } : {}),
          ...(groupId !== '' ? { groupId } : {}),
          status,
          ...(userId !== '' ? { userId } : {}),
          ...(note !== '' ? { note } : {}),
        });
        onSaved(res.person, true);
      } else {
        const res = await apiPatch<UpdatePersonResponse>(
          `/api/v1/people/${encodeURIComponent(person.id)}`,
          {
            name,
            // 空串 = 清空（服务端把空串归一成 null）。
            studentNo: studentNo === '' ? null : studentNo,
            groupId: groupId === '' ? null : groupId,
            status,
            userId: userId === '' ? null : userId,
            note: note === '' ? null : note,
          },
        );
        onSaved(res.person, false);
      }
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  const title = person === null ? '新建人员' : `编辑人员「${person.name}」`;

  return (
    <Modal
      open={open}
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <button type="button" className="link-btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" form="person-form" className="btn-primary" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <form id="person-form" className="form-row" onSubmit={(e) => void onSubmit(e)}>
        <label className="field" style={{ flex: '1 1 200px' }}>
          <span>姓名</span>
          <input name="name" type="text" defaultValue={person?.name ?? ''} placeholder="重名允许存在" />
        </label>
        <label className="field">
          <span>学号（可留空）</span>
          <input
            name="studentNo"
            type="text"
            defaultValue={person?.studentNo ?? ''}
            placeholder="按原样保存，保留前导零"
          />
        </label>
        <label className="field">
          <span>课题组（可留空）</span>
          <input name="groupId" type="text" defaultValue={person?.groupId ?? ''} />
        </label>
        <label className="field">
          <span>状态</span>
          <select name="status" defaultValue={person?.status ?? 'active'}>
            {PERSON_STATUSES.map((s) => (
              <option key={s} value={s}>{PERSON_STATUS_LABELS[s]}</option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: '1 1 220px' }}>
          <span>绑定登录账号（可留空）</span>
          <select name="userId" defaultValue={person?.linkedUserId ?? ''}>
            <option value="">不绑定</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}（{u.username}）
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: '1 1 100%' }}>
          <span>备注（可留空）</span>
          <input name="note" type="text" defaultValue={person?.note ?? ''} />
        </label>
        <p className="dim" style={{ flexBasis: '100%', margin: 0, fontSize: '0.8125rem' }}>
          学号按文本保存，不做数字转换；重名不会被自动合并。账号绑定必须由管理员在这里确认，
          不会按姓名自动匹配。
        </p>
      </form>
      {formError !== null && (
        <div className="notice err"><p className="notice-body">{formError}</p></div>
      )}
      {error !== null && <ErrorNotice error={error} onRetry={() => setError(null)} />}
    </Modal>
  );
}
