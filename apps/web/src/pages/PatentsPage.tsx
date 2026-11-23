import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  PATENT_EVENT_LABELS,
  PATENT_FILTERS,
  PATENT_FILTER_LABELS,
  type CreatePatentResponse,
  type ListPatentsResponse,
  type ListPeopleResponse,
  type Patent,
  type PatentFilter,
  type Person,
  type UpdatePatentResponse,
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
import { useFocusTarget } from '../use-focus-target.ts';

function parseFilter(raw: string | null): PatentFilter {
  return (PATENT_FILTERS as readonly string[]).includes(raw ?? '') ? (raw as PatentFilter) : 'all';
}

function patentStage(p: Patent): { label: string; tone: string } {
  if (p.grantedOn) return { label: '已授权', tone: 'published' };
  if (p.publishedOn !== null) return { label: '已公开', tone: 'published' };
  if (p.substantiveExamOn !== null) return { label: '实质审查中', tone: 'review' };
  if (p.firstSubmittedOn !== null) return { label: '已提交申请', tone: 'filed' };
  return { label: '日期待核实', tone: 'unknown' };
}

/**
 * 专利台账（投稿台账信息优化 · 第三步）。
 *
 * 专利的“实审/公开”是事件，不是论文的 8 档状态。
 */
export function PatentsPage() {
  const { can, user } = useAuth();
  const [params, setParams] = useSearchParams();
  const filter = parseFilter(params.get('filter'));
  const q = params.get('q') ?? '';

  const [state, setState] = useState<ListPatentsResponse | null>(null);
  useFocusTarget('patent-', state !== null);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestKey = `${q}\u0000${filter}`;
  const requestKeyRef = useRef(requestKey);
  requestKeyRef.current = requestKey;
  const [error, setError] = useState<ApiError | null>(null);
  const [people, setPeople] = useState<readonly Person[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Patent | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await apiGet<ListPatentsResponse>(
        `/api/v1/patents?limit=200&filter=${filter}${q.trim() === '' ? '' : `&q=${encodeURIComponent(q.trim())}`}`,
        signal,
      );
      if (signal?.aborted) return;
      setState(res);
      setError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setError(toApiError(err));
    }
  }, [q, filter]);

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
    const key = requestKey;
    try {
      const res = await apiGet<ListPatentsResponse>(
        `/api/v1/patents?limit=200&offset=${state.items.length}&filter=${filter}${q.trim() === '' ? '' : `&q=${encodeURIComponent(q.trim())}`}`,
      );
      if (requestKeyRef.current !== key) return;
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

  function setFilter(next: PatentFilter) {
    const sp = new URLSearchParams(params);
    if (next === 'all') sp.delete('filter');
    else sp.set('filter', next);
    setParams(sp);
  }

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const sp = new URLSearchParams(params);
    const value = String(new FormData(event.currentTarget).get('q') ?? '').trim();
    if (value === '') sp.delete('q');
    else sp.set('q', value);
    setParams(sp);
  }

  function onSaved(patent: Patent, created: boolean) {
    setShowCreate(false);
    setEditing(null);
    setNotice(created ? `已登记「${patent.name}」。` : `已保存「${patent.name}」。`);
    void load();
  }

  const items = state?.items ?? null;
  const counts = state?.counts ?? null;
  const visible = items;
  const canWriteAll = can('patent.write.all');

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <div className="page-title">
            <span className="page-title-icon">
              <NavGlyph name="patents" size={30} />
            </span>
            <h1>专利</h1>
          </div>
          <p className="lead">查询专利登记信息与申请进度。录入人、导师和管理员可以补充或订正资料。</p>
        </div>
        <div className="page-head-actions">
          <button type="button" className="link-btn" onClick={() => void load()}>
            刷新
          </button>
          <button type="button" className="btn-primary" onClick={() => setShowCreate(true)}>
            + 登记专利
          </button>
        </div>
      </div>

      <nav className="tabs patent-filter-tabs" aria-label="按专利阶段筛选">
        {PATENT_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={filter === f ? 'tab active' : 'tab'}
            aria-current={filter === f ? 'page' : undefined}
            onClick={() => setFilter(f)}
          >
            {PATENT_FILTER_LABELS[f]}
            {counts !== null && <span className="tab-count">{counts[f]}</span>}
          </button>
        ))}
      </nav>

      <div className="card record-ledger patent-ledger">
        <form className="form-row" onSubmit={onSearch} style={{ marginBottom: 12 }}>
          <label className="field" style={{ flex: '1 1 320px' }}>
            <span>搜索</span>
            <input key={q} name="q" type="text" defaultValue={q} placeholder="专利名称、专利号、申请人" />
          </label>
          <button type="submit">搜索</button>
          {q !== '' && (
            <button type="button" className="link-btn" onClick={() => {
              const sp = new URLSearchParams(params);
              sp.delete('q');
              setParams(sp);
            }}>
              清除
            </button>
          )}
        </form>

        {notice !== null && (
          <div className="notice ok"><p className="notice-body" style={{ margin: 0 }}>{notice}</p></div>
        )}
        {error !== null && <ErrorNotice error={error} onRetry={() => void load()} />}
        {items === null && error === null && <SkeletonList rows={3} />}

        {items !== null && items.length === 0 && (
          <EmptyState
            icon="patents"
            action={
              <button type="button" className="link-btn" onClick={() => setShowCreate(true)}>
                登记第一件专利
              </button>
            }
          >
            {q.trim() === ''
              ? '还没有专利记录。专利与论文投稿分开管理，一件申请一条记录。'
              : `没有找到匹配「${q.trim()}」的专利。`}
          </EmptyState>
        )}

        {visible !== null && items !== null && items.length > 0 && visible.length === 0 && (
          <EmptyState
            icon="patents"
            action={
              <button type="button" className="link-btn" onClick={() => setFilter('all')}>
                查看全部专利
              </button>
            }
          >
            「{PATENT_FILTER_LABELS[filter]}」这一档下没有专利。换一档看看，或者查看全部。
          </EmptyState>
        )}

        {visible !== null && visible.length > 0 && (
          <ul className="sub-list patent-list">
            {visible.map((p) => {
              const stage = patentStage(p);
              const recordedByMe = user !== null && p.createdById === user.id;
              return (
                <li key={p.id} className="sub-item patent-card" id={`patent-${p.id}`}>
                  <div className="patent-card-top">
                    <div className="patent-card-identity">
                      <h2 className="patent-card-title">{p.name}</h2>
                      <p className="patent-applicant"><span>申请人</span><strong>{p.applicantName ?? p.applicantPersonName ?? '未记录'}</strong></p>
                    </div>
                    <div className="patent-card-actions">
                      <span className={`patent-stage ${stage.tone}`}>{stage.label}</span>
                      {(recordedByMe || canWriteAll) && <button type="button" className="patent-edit" onClick={() => setEditing(p)} aria-label={`编辑专利「${p.name}」`}>编辑</button>}
                      {(recordedByMe || can('ledger.delete.all')) && <button type="button" className="sub-record-delete"
                        aria-label={`删除专利「${p.name}」`} onClick={() => setDeleteTarget({ id: p.id, title: p.name })}>删除</button>}
                    </div>
                  </div>

                  <div className="patent-card-main">
                    <div className="patent-card-secondary">
                      <p className="patent-number"><span>专利号</span><strong className="mono">{p.patentNo ?? '未补录'}</strong></p>
                      <p className="patent-registrant"><span>录入人</span><strong>{p.createdByName ?? '未记录'}</strong></p>
                    </div>
                    <ol className="patent-milestones" aria-label="专利申请进度">
                      {([
                        ['提交申请', p.firstSubmittedOn],
                        ['实质审查', p.substantiveExamOn],
                        ['申请公开', p.publishedOn],
                        ['专利授权', p.grantedOn ?? null],
                      ] as const).map(([label, date]) => (
                        <li key={label} className={date === null ? 'is-missing' : 'is-recorded'}>
                          <span className="patent-milestone-dot" aria-hidden="true" />
                          <span className="patent-milestone-copy"><strong>{label}</strong>{date === null
                            ? <span className="record-date-value">日期未录入</span>
                            : <time className="record-date-value" dateTime={date}>{date}</time>}</span>
                        </li>
                      ))}
                    </ol>
                  </div>

                  {p.notes !== null && p.notes !== '' && <p className="patent-card-note"><span>备注</span>{p.notes}</p>}
                  <RecordEdits edits={p.edits} />
                  {p.events.length > 0 && (
                    <details className="patent-events">
                      <summary>专利进度与登记历史 <span>{p.events.length} 条</span></summary>
                      <ol>
                        {p.events.map((e) => (
                          <li key={e.id}>
                            <div><strong>{PATENT_EVENT_LABELS[e.kind]}</strong>{e.occurredOn !== null && <time className="patent-event-date" dateTime={e.occurredOn}>{e.occurredOn}</time>}{e.note !== null && e.note !== '' && <p>{e.note}</p>}</div>
                            <span className="patent-event-actor">录入于 <time dateTime={e.recordedAt}>{fmtDateTime(e.recordedAt)}</time>{e.recordedByName !== null && <> · {e.recordedByName}</>}</span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {state !== null && state.matched > 0 && (
          <p className="dim record-list-progress">
            已显示 {state.items.length} / {state.matched} 条匹配记录（全库 {state.total} 条）。
            {state.items.length < state.matched && (
              <button type="button" className="btn-outline" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? '加载中…' : '加载更多'}
              </button>
            )}
          </p>
        )}
      </div>

      <LedgerDeleteDialog kind="patent" target={deleteTarget} onCancel={() => setDeleteTarget(null)} onDeleted={(title) => {
        setDeleteTarget(null);
        setNotice(`已删除专利「${title}」。`);
        void load();
      }} />
      <PatentModal
        key={showCreate ? 'create-open' : 'create-closed'}
        open={showCreate}
        patent={null}
        people={people}
        onClose={() => setShowCreate(false)}
        onSaved={onSaved}
        onReload={() => void load()}
      />
      <PatentModal
        key={editing?.id ?? 'edit-closed'}
        open={editing !== null}
        patent={editing}
        people={people}
        onClose={() => setEditing(null)}
        onSaved={onSaved}
        onReload={() => void load()}
      />
    </>
  );
}

function PatentModal({
  open,
  patent,
  people,
  onClose,
  onSaved,
  onReload,
}: {
  open: boolean;
  patent: Patent | null;
  people: readonly Person[];
  onClose: () => void;
  onSaved: (patent: Patent, created: boolean) => void;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name') ?? '').trim();
    if (name === '') {
      setFormError('专利名称不能为空。');
      return;
    }
    const patentNo = String(data.get('patentNo') ?? '').trim();
    const applicantName = String(data.get('applicantName') ?? '').trim();
    const applicantPersonId = String(data.get('applicantPersonId') ?? '').trim();
    const firstSubmittedOn = String(data.get('firstSubmittedOn') ?? '').trim();
    const substantiveExamOn = String(data.get('substantiveExamOn') ?? '').trim();
    const publishedOn = String(data.get('publishedOn') ?? '').trim();
    const grantedOn = String(data.get('grantedOn') ?? '').trim();
    const notes = String(data.get('notes') ?? '').trim();

    if (firstSubmittedOn !== '' && substantiveExamOn !== '' && substantiveExamOn < firstSubmittedOn) {
      setFormError('实审时间早于首次提交时间，请复核日期。');
      return;
    }
    if (firstSubmittedOn !== '' && publishedOn !== '' && publishedOn < firstSubmittedOn) {
      setFormError('公开时间早于首次提交时间，请复核日期。');
      return;
    }

    setFormError(null);
    setError(null);
    setBusy(true);
    try {
      if (patent === null) {
        const res = await apiPost<CreatePatentResponse>('/api/v1/patents', {
          name,
          ...(patentNo !== '' ? { patentNo } : {}),
          ...(applicantName !== '' ? { applicantName } : {}),
          ...(applicantPersonId !== '' ? { applicantPersonId } : {}),
          ...(firstSubmittedOn !== '' ? { firstSubmittedOn } : {}),
          ...(substantiveExamOn !== '' ? { substantiveExamOn } : {}),
          ...(publishedOn !== '' ? { publishedOn } : {}),
          ...(grantedOn !== '' ? { grantedOn } : {}),
          ...(notes !== '' ? { notes } : {}),
        });
        onSaved(res.patent, true);
      } else {
        const res = await apiPatch<UpdatePatentResponse>(
          `/api/v1/patents/${encodeURIComponent(patent.id)}`,
          {
            expectedRevision: patent.revision,
            name,
            patentNo: patentNo === '' ? null : patentNo,
            applicantName: applicantName === '' ? null : applicantName,
            applicantPersonId: applicantPersonId === '' ? null : applicantPersonId,
            firstSubmittedOn: firstSubmittedOn === '' ? null : firstSubmittedOn,
            substantiveExamOn: substantiveExamOn === '' ? null : substantiveExamOn,
            publishedOn: publishedOn === '' ? null : publishedOn,
            grantedOn: grantedOn || null,
            notes: notes === '' ? null : notes,
          },
        );
        onSaved(res.patent, false);
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
      title={patent === null ? '登记一件专利' : `编辑专利「${patent.name}」`}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <button type="button" className="link-btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" form="patent-form" className="btn-primary" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <form id="patent-form" className="form-row" onSubmit={(e) => void onSubmit(e)}>
        <label className="field" style={{ flex: '1 1 100%' }}>
          <span>专利名称</span>
          <input name="name" type="text" defaultValue={patent?.name ?? ''} placeholder="必填" />
        </label>
        <label className="field">
          <span>专利号（可留空）</span>
          <input name="patentNo" type="text" defaultValue={patent?.patentNo ?? ''} placeholder="按官方编号原样填写" />
        </label>
        <label className="field">
          <span>申请人姓名（可留空）</span>
          <input name="applicantName" type="text" defaultValue={patent?.applicantName ?? ''} placeholder="原表姓名" />
        </label>
        <PersonPicker name="applicantPersonId" people={people} initialId={patent?.applicantPersonId ?? ''} initialName={patent?.applicantPersonName ?? null} />
        <label className="field">
          <span>申请提交日期（可留空）</span>
          <input name="firstSubmittedOn" type="date" defaultValue={patent?.firstSubmittedOn ?? ''} />
        </label>
        <label className="field">
          <span>实质审查日期（可留空）</span>
          <input name="substantiveExamOn" type="date" defaultValue={patent?.substantiveExamOn ?? ''} />
        </label>
        <label className="field">
          <span>申请公开日期（可留空）</span>
          <input name="publishedOn" type="date" defaultValue={patent?.publishedOn ?? ''} />
        </label>
        <label className="field"><span>授权日期（可留空）</span>
          <input name="grantedOn" type="date" defaultValue={patent?.grantedOn ?? ''} />
        </label>
        <label className="field" style={{ flex: '1 1 100%' }}>
          <span>备注（可留空）</span>
          <input name="notes" type="text" defaultValue={patent?.notes ?? ''} />
        </label>
        <p className="dim" style={{ flexBasis: '100%', margin: 0, fontSize: '0.8125rem' }}>
          “尚未公开”和“公开日期未知”是两件事：留空表示未知。实审/公开早于首次提交时，
          服务端会要求复核，不会静默改日期。
        </p>
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
