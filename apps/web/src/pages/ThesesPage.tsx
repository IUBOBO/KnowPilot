import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useFocusTarget } from '../use-focus-target.ts';
import {
  type CreateThesisResponse,
  type ListPeopleResponse,
  type ListThesesResponse,
  type Person,
  type Thesis,
  type UpdateThesisResponse,
} from '@knowpilot/shared';
import { apiGet, apiPatch, apiPost, isAbort, toApiError, type ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { LedgerDeleteDialog } from '../components/LedgerDeleteDialog.tsx';
import { Modal } from '../components/Modal.tsx';
import { RecordEdits } from '../components/RecordEdits.tsx';
import { PersonPicker } from '../components/PersonPicker.tsx';
import { SkeletonList } from '../components/Skeleton.tsx';
import { fmtDateTime } from '../format.ts';
import { LEDGER_RESTORED_EVENT } from '../ledger-events.ts';
import { NavGlyph } from '../nav-icons.tsx';

/**
 * 大论文（学位论文）台账。
 *
 * 登录成员可查看档案。成绩允许已绑定的作者本人补录。
 */
export function ThesesPage() {
  const { can, user } = useAuth();
  const canManage = can('thesis.manage');
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';

  const [state, setState] = useState<ListThesesResponse | null>(null);
  useFocusTarget('thesis-', state !== null);
  const [loadingMore, setLoadingMore] = useState(false);
  const queryRef = useRef(q);
  queryRef.current = q;
  const [error, setError] = useState<ApiError | null>(null);
  const [people, setPeople] = useState<readonly Person[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Thesis | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await apiGet<ListThesesResponse>(
        `/api/v1/theses?limit=200${q.trim() === '' ? '' : `&q=${encodeURIComponent(q.trim())}`}`,
        signal,
      );
      if (signal?.aborted) return;
      setState(res);
      setError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setError(toApiError(err));
    }
  }, [q]);

  useEffect(() => {
    const ac = new AbortController();
    setState(null);
    const refresh = () => void load(ac.signal);
    refresh();
    window.addEventListener(LEDGER_RESTORED_EVENT, refresh);
    return () => {
      ac.abort();
      window.removeEventListener(LEDGER_RESTORED_EVENT, refresh);
    };
  }, [load]);

  async function loadMore() {
    if (state === null || loadingMore || state.items.length >= state.matched) return;
    setLoadingMore(true);
    const query = q;
    try {
      const res = await apiGet<ListThesesResponse>(
        `/api/v1/theses?limit=200&offset=${state.items.length}${q.trim() === '' ? '' : `&q=${encodeURIComponent(q.trim())}`}`,
      );
      if (queryRef.current !== query) return;
      setState((previous) => previous === null ? res : { ...res, items: [...previous.items, ...res.items] });
      setError(null);
    } catch (err) {
      if (!isAbort(err)) setError(toApiError(err));
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    const ac = new AbortController();
    apiGet<ListPeopleResponse>('/api/v1/people?limit=200', ac.signal)
      .then((res) => setPeople(res.items))
      .catch(() => setPeople([]));
    return () => ac.abort();
  }, []);

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const sp = new URLSearchParams(params);
    const value = String(new FormData(event.currentTarget).get('q') ?? '').trim();
    if (value === '') sp.delete('q');
    else sp.set('q', value);
    setParams(sp);
  }

  function onSaved(thesis: Thesis, created: boolean) {
    setShowCreate(false);
    setEditing(null);
    setNotice(created ? `已新增大论文「${thesis.authorName}」。` : `已保存「${thesis.authorName}」的大论文信息。`);
    void load();
  }

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <div className="page-title">
            <span className="page-title-icon">
              <NavGlyph name="theses" size={30} />
            </span>
            <h1>大论文</h1>
          </div>
          <p className="lead">登录成员可查看学位论文档案和成绩。已关联的论文作者可以补填或订正自己的成绩。</p>
        </div>
        <div className="page-head-actions">
          <button type="button" className="link-btn" onClick={() => void load()}>
            刷新
          </button>
          <button type="button" className="btn-primary" onClick={() => setShowCreate(true)}>
            + 新增大论文
          </button>
        </div>
      </div>

      <div className="card record-ledger thesis-ledger">
        <form className="form-row" onSubmit={onSearch}>
          <label className="field" style={{ flex: '1 1 320px' }}>
            <span>搜索</span>
            <input key={q} name="q" type="text" defaultValue={q} placeholder="作者、研究方向、题目" />
          </label>
          <button type="submit">搜索</button>
          {q !== '' && (
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                const sp = new URLSearchParams(params);
                sp.delete('q');
                setParams(sp);
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
        {state === null && error === null && <SkeletonList rows={3} />}

        {state !== null && state.items.length === 0 && (
          <EmptyState
            icon="theses"
            action={
              <button type="button" className="link-btn" onClick={() => setShowCreate(true)}>
                新增第一条大论文记录
              </button>
            }
          >
            {q.trim() === ''
              ? '还没有大论文记录。题目可以暂缺，定稿后再补，变更会留历史。'
              : `没有找到匹配「${q.trim()}」的大论文。`}
          </EmptyState>
        )}

        {state !== null && state.items.length > 0 && (
          <>
            <ul className="sub-list thesis-list">
              {state.items.map((t) => {
                const recordedByMe = user !== null && t.createdById === user.id;
                const canEditDetails = recordedByMe || canManage;
                return (
                <li key={t.id} className="sub-item thesis-card" id={`thesis-${t.id}`}>
                  <div className="thesis-card-head">
                    <span className="thesis-card-mark" aria-hidden="true"><NavGlyph name="theses" size={23} /></span>
                    <div className="thesis-card-identity">
                      <h2 className="thesis-card-title">{t.title ?? '题目未定'}</h2>
                      <div className="thesis-card-meta">
                        <p><span>作者</span><strong>{t.authorName}</strong>{t.isSelf && <span className="thesis-self">你</span>}</p>
                        <p><span>研究方向</span><strong>{t.direction ?? '未填写'}</strong></p>
                        <p><span>录入人</span><strong>{t.createdByName ?? '未记录'}</strong></p>
                      </div>
                    </div>
                    <div className="thesis-card-actions">
                      <span className={`thesis-grade ${!t.gradeVisible ? 'restricted' : t.grade === null ? 'missing' : 'available'}`}>
                        {t.gradeVisible ? (t.grade === null ? '成绩未录入' : `成绩 ${t.grade}`) : '成绩受限'}
                      </span>
                      {(canEditDetails || t.isSelf) && <button type="button" className="thesis-edit" onClick={() => setEditing(t)}>
                        {canEditDetails ? '编辑' : '编辑成绩'}
                      </button>}
                      {(recordedByMe || can('ledger.delete.all')) && <button type="button" className="sub-record-delete"
                        aria-label={`删除「${t.authorName}」的大论文`}
                        onClick={() => setDeleteTarget({ id: t.id, title: t.title ?? `${t.authorName}的大论文` })}>删除</button>}
                    </div>
                  </div>
                  {t.notes !== null && t.notes !== '' && <p className="thesis-card-note"><span>备注</span>{t.notes}</p>}
                  {t.titleHistory.length > 0 && (
                    <details className="thesis-changes">
                      <summary>题目变更 <span>{t.titleHistory.length} 次</span></summary>
                      <ol>
                        {t.titleHistory.map((h) => (
                          <li key={h.id}>
                            <div className="thesis-change-titles"><span><small>原题目</small>{h.oldTitle ?? '未定题'}</span><span className="thesis-change-arrow" aria-hidden="true">→</span><strong><small>新题目</small>{h.newTitle ?? '已清空'}</strong></div>
                            <p><time dateTime={h.changedAt}>{fmtDateTime(h.changedAt)}</time>{h.changedByName !== null && <> · {h.changedByName}</>}</p>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                  <RecordEdits edits={t.edits} />
                  <p className="thesis-card-updated">最近更新 <time dateTime={t.updatedAt}>{fmtDateTime(t.updatedAt)}</time></p>
                </li>
                );
              })}
            </ul>
            <p className="dim" style={{ fontSize: '0.75rem', margin: '10px 0 0' }}>
              已显示 {state.items.length} / {state.matched} 条匹配记录（全库 {state.total} 条）。
              {state.items.length < state.matched && (
                <button type="button" className="btn-outline" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? '加载中…' : '加载更多'}
                </button>
              )}
            </p>
          </>
        )}
      </div>

      <LedgerDeleteDialog kind="thesis" target={deleteTarget} onCancel={() => setDeleteTarget(null)} onDeleted={(title) => {
        setDeleteTarget(null);
        setNotice(`已删除「${title}」。`);
        void load();
      }} />
          <ThesisModal
            key={showCreate ? 'create-open' : 'create-closed'}
            open={showCreate}
            thesis={null}
            canEditDetails
            canManage={canManage}
            people={people}
            onClose={() => setShowCreate(false)}
            onSaved={onSaved}
            onReload={() => void load()}
          />
          <ThesisModal
            key={editing?.id ?? 'edit-closed'}
            open={editing !== null}
            thesis={editing}
            canEditDetails={canManage || (user !== null && editing?.createdById === user.id)}
            canManage={canManage}
            people={people}
            onClose={() => setEditing(null)}
            onSaved={onSaved}
            onReload={() => void load()}
          />
    </>
  );
}

function ThesisModal({
  open,
  thesis,
  canEditDetails,
  canManage,
  people,
  onClose,
  onSaved,
  onReload,
}: {
  open: boolean;
  thesis: Thesis | null;
  canEditDetails: boolean;
  canManage: boolean;
  people: readonly Person[];
  onClose: () => void;
  onSaved: (thesis: Thesis, created: boolean) => void;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [isAuthor, setIsAuthor] = useState(thesis?.isSelf ?? false);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const canEditGrade = canManage || isAuthor;
  const canChangePerson = canManage || thesis === null || thesis.grade === null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const personId = String(data.get('personId') ?? '').trim();
    const authorName = String(data.get('authorName') ?? '').trim();
    const direction = String(data.get('direction') ?? '').trim();
    const title = String(data.get('title') ?? '').trim();
    const grade = String(data.get('grade') ?? '').trim();
    const notes = String(data.get('notes') ?? '').trim();

    const resolvedAuthorName = authorName || people.find((person) => person.id === personId)?.name || '';
    if (canEditDetails && resolvedAuthorName === '') {
      setFormError('请填写作者姓名，或选择一条人员记录。');
      return;
    }

    setFormError(null);
    setError(null);
    setBusy(true);
    try {
      if (thesis === null) {
        const res = await apiPost<CreateThesisResponse>('/api/v1/theses', {
          ...(personId !== '' ? { personId } : {}),
          authorName: resolvedAuthorName,
          ...(direction !== '' ? { direction } : {}),
          ...(title !== '' ? { title } : {}),
          ...(grade !== '' ? { grade } : {}),
          ...(notes !== '' ? { notes } : {}),
        });
        onSaved(res.thesis, true);
      } else {
        const res = await apiPatch<UpdateThesisResponse>(
          `/api/v1/theses/${encodeURIComponent(thesis.id)}`,
          {
            expectedRevision: thesis.revision,
            ...(canEditDetails ? {
              ...(canChangePerson ? { personId: personId || null } : {}),
              authorName: resolvedAuthorName,
              direction: direction || null,
              title: title || null,
              notes: notes || null,
            } : {}),
            ...(canEditGrade ? { grade: grade || null } : {}),
          },
        );
        onSaved(res.thesis, false);
      }
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
      title={thesis === null ? '新增大论文' : canEditDetails ? `编辑「${thesis.authorName}」的大论文` : '编辑大论文成绩'}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <button type="button" className="link-btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" form="thesis-form" className="btn-primary" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <form id="thesis-form" className="form-row" onSubmit={(e) => void onSubmit(e)}>
        {canEditDetails && <>
        {canChangePerson
          ? <PersonPicker name="personId" people={people} initialId={thesis?.personId ?? ''}
              initialName={thesis?.personName ?? null} onSelect={(person) => setIsAuthor(person?.isSelf ?? false)} />
          : <p className="dim">关联作者为{thesis?.personName ?? thesis?.authorName}。已有成绩的论文由导师或管理员调整关联作者。</p>}
        <label className="field">
          <span>作者姓名（可留空）</span>
          <input name="authorName" type="text" defaultValue={thesis?.authorName ?? ''} placeholder="关联人员时可不填" />
        </label>
        <label className="field">
          <span>研究方向（可留空）</span>
          <input name="direction" type="text" defaultValue={thesis?.direction ?? ''} />
        </label>
        <label className="field" style={{ flex: '1 1 100%' }}>
          <span>题目（可留空，表示尚未定题）</span>
          <input name="title" type="text" defaultValue={thesis?.title ?? ''} />
        </label>
        <label className="field" style={{ flex: '1 1 100%' }}>
          <span>备注（可留空）</span>
          <input name="notes" type="text" defaultValue={thesis?.notes ?? ''} />
        </label>
        </>}
        {canEditGrade && <label className="field">
          <span>成绩（可留空）</span>
          <input name="grade" type="text" defaultValue={thesis?.grade ?? ''} placeholder="按学校实际口径填写" />
        </label>}
      </form>
      {formError !== null && (
        <div className="notice err"><p className="notice-body">{formError}</p></div>
      )}
      {error !== null && <ErrorNotice error={error} onRetry={() => setError(null)} />}
      {error?.body.error.message.includes('已被其他人更新') && (
        <button type="button" className="btn-outline" onClick={() => { onClose(); onReload(); }}>
          关闭并加载最新资料
        </button>
      )}
    </Modal>
  );
}
