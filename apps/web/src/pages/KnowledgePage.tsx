import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { PageTitle } from '../components/PageTitle.tsx';
import { DiscoveryPanel } from './knowledge/DiscoveryPanel.tsx';
import {
  KNOWLEDGE_KIND_LABELS,
  KNOWLEDGE_MAX_INPUT_CHARS,
  KNOWLEDGE_MIN_INPUT_CHARS,
  KNOWLEDGE_STATUS_LABELS,
  type ConfirmKnowledgeGroupResponse,
  type CreateKnowledgeDraftsResponse,
  type KnowledgeEntry,
  type ListKnowledgeEntriesResponse,
  type RejectKnowledgeResponse,
  type ResubmitKnowledgeResponse,
  type WithdrawKnowledgeResponse,
} from '@knowpilot/shared';
import { Link } from 'react-router-dom';
import { apiGet, apiPost, isAbort, toApiError, type ApiError } from '../api.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ConsentBar } from '../components/ConsentBar.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SkeletonList } from '../components/Skeleton.tsx';
import { useToast } from '../components/Toast.tsx';
import { useAuth } from '../auth.tsx';
import { fmtDateTime } from '../format.ts';
import { DraftEditor, DraftProvenance } from './knowledge/DraftEditor.tsx';
import { groupByBatch, knowledgeStatusTone } from '../knowledge-view.ts';

const CONSENT_KEY = 'knowpilot.knowledge.consent.v1';

/**
 * 知识沉淀。把一句白话整理成结构化草案，**确认之后**才进索引。
 *
 * 【这一页存在的意义全在"确认"那一步】草案由模型拟，模型会编 —— 所以草案先落
 *   `proposed`、待在索引之外（GC-12：未确认的知识检索不到），由人看过再点确认，
 *   那时才物化成一份真正的知识库文档。页面上「待确认」这个状态不是在排队等某个
 *   后台任务，它就是在等你点。
 *
 * 【为什么按批次分组，而不是一个平铺列表】一次输入产出的若干条是**一起被看、
 *   一起被确认**的（确认接口本身以组为单位）。平铺的话，两条来自不同输入的
 *   同类知识会挨在一起，用户分不清哪几条是刚才那一批。
 *
 * 【为什么别人的条目可能出现在这里】可见性由服务端在 SQL 里收口
 *   （见 knowledge/repo.ts 的 listVisible）：成员看得到自己的，外加**归属为
 *   NULL 的公共历史条目**；导师/管理员看得到**非草案**的全部。所以这一页不假设
 *   "列出来的都是我的" —— 每一条都写清提交人，点不动的那条也会说明为什么。
 *
 * 【为什么导师也看不到别人的 `proposed`】草案是作者还没决定要不要的东西，
 *   摊给审核者等于替他做决定。审核者要看的是已提交的 `conflicted`（在知识审核页）。
 */
export function KnowledgePage() {
  const { user, can } = useAuth();
  const toast = useToast();

  const [items, setItems] = useState<readonly KnowledgeEntry[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'proposed' | 'active' | 'conflicted' | 'other'>('all');
  const [listQuery, setListQuery] = useState('');
  const [listError, setListError] = useState<ApiError | null>(null);

  const [text, setText] = useState('');
  const [consent, setConsent] = useState(() => localStorage.getItem(CONSENT_KEY) === '1');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<ApiError | null>(null);

  /** 正在确认的批次。用 groupId 而不是布尔值：同一次只该有一组在动。 */
  const [busyGroup, setBusyGroup] = useState<string | null>(null);
  /** 确认整组的逐条回执。客户端只留最近一次的，重载列表时清掉 ——
   *  条目本身的新状态已经在列表里了，回执只是"刚才那一下各自成了什么"。 */
  const [confirmOutcome, setConfirmOutcome] = useState<{
    groupId: string;
    results: ConfirmKnowledgeGroupResponse['results'];
  } | null>(null);

  const [rejecting, setRejecting] = useState<KnowledgeEntry | null>(null);
  const [reason, setReason] = useState('');
  const [rejectBusy, setRejectBusy] = useState(false);
  const [rejectError, setRejectError] = useState<string | null>(null);

  const [withdrawing, setWithdrawing] = useState<KnowledgeEntry | null>(null);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  /** 正在重新提交的条目 id（同一次只该有一条在动）。 */
  const [resubmittingId, setResubmittingId] = useState<string | null>(null);

  const textRef = useRef<HTMLTextAreaElement>(null);

  const loadList = useCallback(async (signal?: AbortSignal) => {
    try {
      const body = await apiGet<ListKnowledgeEntriesResponse>('/api/v1/knowledge', signal);
      setItems(body.items);
      setListError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setListError(toApiError(err));
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void loadList(ac.signal);
    return () => ac.abort();
  }, [loadList]);

  const canReview = can('knowledge.review');
  const me = user?.id ?? null;

  /**
   * 这一条我动不动得。
   *
   * 【判据与服务端同一条】服务端的确认/驳回都是"`created_by` 是我，或者我有
   *   `knowledge.review`"（见 app.ts 的 confirm handler 与 reject handler）。
   *   前端算这一遍只是决定按钮显不显示、以及**为什么**动不了 ——
   *   真正的边界在服务端，藏了不等于拦住了。
   *
   * 【为什么还要单独判 `createdById !== null`】归属为 NULL 的公共历史条目
   *   既不是"我提交的"，也没有提交人可问 —— 它只有审核者能处理。写成
   *   `createdById === me` 的话，`me` 为 null 时它会被算成"我的"，而服务端
   *   会 404。两边的判据必须逐字一致。
   */
  function canActOn(entry: KnowledgeEntry): boolean {
    return canReview || (entry.createdById !== null && entry.createdById === me);
  }

  const visibleItems = useMemo(() => (items ?? []).filter((entry) => {
    const statusMatches = statusFilter === 'all' || (statusFilter === 'other'
      ? !['proposed', 'active', 'conflicted'].includes(entry.status)
      : entry.status === statusFilter);
    const query = listQuery.trim().toLocaleLowerCase();
    return statusMatches && (query === '' || `${entry.title} ${entry.content}`.toLocaleLowerCase().includes(query));
  }), [items, statusFilter, listQuery]);
  const groups = useMemo(() => groupByBatch(visibleItems), [visibleItems]);

  function onConsentChange(checked: boolean) {
    setConsent(checked);
    // 与提问页/上传页同一个惯例：勾过就记住，免得每来一次都要重勾。
    if (checked) localStorage.setItem(CONSENT_KEY, '1');
    else localStorage.removeItem(CONSENT_KEY);
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = text.trim();
    if (body.length < KNOWLEDGE_MIN_INPUT_CHARS) {
      setFormError(`内容太短，至少 ${KNOWLEDGE_MIN_INPUT_CHARS} 个字 —— 太短没法整理成一条知识，请说得具体一些。`);
      return;
    }
    if (body.length > KNOWLEDGE_MAX_INPUT_CHARS) {
      setFormError(
        `内容太长（${body.length} 字，上限 ${KNOWLEDGE_MAX_INPUT_CHARS} 字）。` +
          '要沉淀长文档请走「知识库」上传那份文件；这个入口适合一段口述。',
      );
      return;
    }

    setFormError(null);
    setCreateError(null);
    setCreating(true);
    try {
      const result = await apiPost<CreateKnowledgeDraftsResponse>('/api/v1/knowledge/drafts', {
        text: body,
        consentConfirmed: true,
      });
      // 成功才清空输入。失败时保留原文 —— 让用户重打一遍是那种
      // "再也不想用第二次"的体验。
      setText('');
      setConfirmOutcome(null);
      await loadList();
      toast.ok(
        result.entries.length === 0
          ? '这段内容里没有整理出可沉淀的知识条目。'
          : `已整理出 ${result.entries.length} 条草案 —— 确认之前它们检索不到。`,
      );
    } catch (err) {
      setCreateError(toApiError(err));
    } finally {
      setCreating(false);
    }
  }

  async function onConfirmGroup(groupId: string) {
    if (busyGroup !== null) return;
    setBusyGroup(groupId);
    try {
      const body = await apiPost<ConfirmKnowledgeGroupResponse>(
        `/api/v1/knowledge/groups/${encodeURIComponent(groupId)}/confirm`,
        { consentConfirmed: true },
      );
      setConfirmOutcome({ groupId, results: body.results });
      await loadList();
    } catch (err) {
      // 整组的失败（404 / 网络）在这里说；单条的失败由回执逐条说。
      toast.warn(toApiError(err).body.error.message);
    } finally {
      setBusyGroup(null);
    }
  }

  async function onRejectConfirm() {
    if (rejecting === null) return;
    setRejectBusy(true);
    setRejectError(null);
    const trimmed = reason.trim();
    try {
      await apiPost<RejectKnowledgeResponse>(
        `/api/v1/knowledge/${encodeURIComponent(rejecting.id)}/reject`,
        // 空串不发出去：服务端把空串与"未提供"当同一件事，
        // 但少传一个字段，契约上少一种需要解释的输入。
        trimmed === '' ? {} : { reason: trimmed },
      );
      setRejecting(null);
      setReason('');
      toast.ok('已驳回。这条不会进索引，记录会留着以备回看。');
      await loadList();
    } catch (err) {
      setRejectError(toApiError(err).body.error.message);
    } finally {
      setRejectBusy(false);
    }
  }

  /**
   * 撤回一条已生效的知识。**不可撤销** —— 要恢复只能重新提交。
   *
   * 【为什么把 `documentRemoved === false` 单独说一句】那种情况是"这条撤回了，
   *   但相同内容还被另一条已生效的知识引用着，索引没有撤下"。如果不说，
   *   用户会以为内容已经搜不到了，而实际上还搜得到 —— 这是最不该含糊的一处。
   */
  async function onWithdrawConfirm() {
    if (withdrawing === null) return;
    setWithdrawBusy(true);
    setWithdrawError(null);
    const trimmedReason = withdrawReason.trim();
    try {
      const body = await apiPost<WithdrawKnowledgeResponse>(
        `/api/v1/knowledge/${encodeURIComponent(withdrawing.id)}/withdraw`,
        trimmedReason === '' ? {} : { reason: trimmedReason },
      );
      setWithdrawing(null);
      setWithdrawReason('');
      toast.ok(
        body.documentRemoved
          ? '已撤回，内容不再被检索到。'
          : '已撤回。但相同内容还被另一条已生效的知识引用，索引暂时没有撤下。',
      );
      await loadList();
    } catch (err) {
      setWithdrawError(toApiError(err).body.error.message);
    } finally {
      setWithdrawBusy(false);
    }
  }

  /** 重新提交一条已驳回 / 已撤回的知识：产出一条新的待确认草案，原行不动。 */
  async function onResubmit(entry: KnowledgeEntry) {
    if (resubmittingId !== null) return;
    setResubmittingId(entry.id);
    try {
      await apiPost<ResubmitKnowledgeResponse>(
        `/api/v1/knowledge/${encodeURIComponent(entry.id)}/resubmit`,
        {},
      );
      toast.ok('已重新提交为一条待确认草案 —— 确认之前检索不到。');
      await loadList();
    } catch (err) {
      toast.warn(toApiError(err).body.error.message);
    } finally {
      setResubmittingId(null);
    }
  }

  const trimmed = text.trim();
  const tooLong = trimmed.length > KNOWLEDGE_MAX_INPUT_CHARS;

  return (
    <>
      <div className="page-head">
        <PageTitle icon="capture">知识沉淀</PageTitle>
        <DiscoveryPanel />
        <Link to="/knowledge/notes">研究笔记</Link>
      </div>
      <p className="lead">输入口述或零散经验，AI 提炼成草案，确认后入库。</p>

      {/* 常驻告知：不论勾没勾过都显示。只勾一次就永久记住的话，
          换了台机器的人、或者看到同事屏幕的人，完全看不到"这段内容会出网"。

          文案刻意分三步写清"哪一步出网"：生成草案那一步**真的会出网**（白话
          整段进云端模型），确认入库那一步**在本地**（切块与向量化都是本地
          ONNX），而入库之后它就和别的文档一样，会在别人提问时被检索到、
          命中的片段跟着出网。写成一件事会让人以为"确认也会把内容送出去"，
          或者反过来以为"只是整理一下、不会出网"。 */}
      <ConsentBar
        checked={consent}
        onCheckedChange={onConsentChange}
        pending="生成草案时，这段内容会发往云端模型"
        granted="已授权：草案生成会发往 DeepSeek（确认入库在本地）"
      >
        <p style={{ margin: 0 }}>
          你写的这段白话会发送至 <b>DeepSeek</b> 整理成草案，即离开实验室内部网络。
          <br />
          <b>确认入库这一步在本地完成</b>（切块与向量化用的都是本机模型），不再出网；
          但入库之后它就成为知识库的一部分，别人在「知识问答」里提问时，
          命中的片段会随检索结果一起发送至云端模型。
          <br />
          若内容涉及<b>投稿中的稿件</b>，请注意期刊的保密要求；已发表论文与公开制度无此风险。
        </p>
      </ConsentBar>

      <div className="card">
        <h2>记一条知识</h2>

        <form className="kb-form" onSubmit={(e) => void onCreate(e)}>
          <label className="field">
            <span>要沉淀的内容</span>
            <textarea
              ref={textRef}
              value={text}
              rows={4}
              placeholder="例如：本组的 A100 只有 8 卡，超过 8 卡的训练任务要提前在群里排队。"
              onChange={(e) => setText(e.target.value)}
            />
          </label>

          <p className={tooLong ? 'kb-char-count err-text' : 'kb-char-count'}>
            {trimmed.length} / {KNOWLEDGE_MAX_INPUT_CHARS} 字
          </p>

          <div className="kb-form-foot">
            <button type="submit" disabled={creating || !consent || trimmed.length < KNOWLEDGE_MIN_INPUT_CHARS}>
              {creating ? '整理中…' : '生成草案'}
            </button>
            <span className="dim kb-hint">
              {KNOWLEDGE_MIN_INPUT_CHARS}–{KNOWLEDGE_MAX_INPUT_CHARS} 字。
              它可能整理出多条，也可能一条都整理不出（这段内容里没有可沉淀的东西）。
            </span>
          </div>
        </form>

        {formError !== null && (
          <div className="notice err">
            <p className="notice-body" style={{ margin: 0 }}>{formError}</p>
          </div>
        )}
        {createError !== null && <ErrorNotice error={createError} onRetry={() => setCreateError(null)} />}
        {!consent && (
          <p className="dim kb-hint">勾选上方确认后才能生成草案。</p>
        )}
      </div>

      <div className="card">
        <h2>
          {canReview ? '全部知识条目' : '我的知识条目'}
          {items !== null && `（${items.length} 条）`}
          <span className="card-actions">
            <button type="button" className="link-btn" onClick={() => void loadList()}>
              刷新
            </button>
          </span>
        </h2>

        {items !== null && items.length > 0 && (
          <div className="kb-list-controls">
            <div className="tabs" role="group" aria-label="筛选知识状态">
              {([
                ['all', '全部'], ['proposed', '待确认'], ['active', '已生效'],
                ['conflicted', '存在冲突'], ['other', '其他状态'],
              ] as const).map(([key, label]) => (
                <button key={key} type="button" className={statusFilter === key ? 'tab active' : 'tab'}
                  aria-pressed={statusFilter === key} onClick={() => setStatusFilter(key)}>
                  {label}
                  <span className="tab-count">{key === 'all' ? items.length : items.filter((entry) => key === 'other'
                    ? !['proposed', 'active', 'conflicted'].includes(entry.status) : entry.status === key).length}</span>
                </button>
              ))}
            </div>
            <label className="field kb-list-search">
              <span>搜索条目</span>
              <input type="search" value={listQuery} placeholder="标题或内容" onChange={(event) => setListQuery(event.target.value)} />
            </label>
          </div>
        )}

        {listError !== null && <ErrorNotice error={listError} onRetry={() => void loadList()} />}
        {items === null && listError === null && <SkeletonList rows={3} />}
        {items !== null && items.length === 0 && (
          <EmptyState
            icon="capture"
            action={
              <button type="button" className="link-btn" onClick={() => textRef.current?.focus()}>
                去上面的输入框写第一句
              </button>
            }
          >
            还没有知识条目。用上面的输入框写一句白话，它整理出的草案会出现在这里 ——
            <b>要等你点过确认，它才会进索引</b>，所以刚生成就搜不到是正常的。
          </EmptyState>
        )}

        {items !== null && items.length > 0 && visibleItems.length === 0 && (
          <EmptyState icon="capture" illustration="no-results">当前条件下没有知识条目，请调整状态或搜索词。</EmptyState>
        )}

        {items !== null && visibleItems.length > 0 && (
          <div className="kb-groups">
            {groups.map((g) => (
              <Batch
                key={g.groupId}
                entries={g.entries}
                consent={consent}
                busy={busyGroup === g.groupId}
                outcome={confirmOutcome !== null && confirmOutcome.groupId === g.groupId ? confirmOutcome.results : null}
                canActOn={canActOn}
                canEdit={(entry) => entry.createdById !== null && entry.createdById === me}
                onEditSaved={loadList}
                onConfirm={() => void onConfirmGroup(g.groupId)}
                onReject={(entry) => {
                  setRejectError(null);
                  setReason('');
                  setRejecting(entry);
                }}
                onWithdraw={(entry) => {
                  setWithdrawError(null);
                  setWithdrawReason('');
                  setWithdrawing(entry);
                }}
                onResubmit={(entry) => void onResubmit(entry)}
                resubmittingId={resubmittingId}
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={rejecting !== null}
        title="驳回这条草案？"
        confirmLabel="驳回"
        busyLabel="驳回中…"
        cancelLabel="取消"
        busy={rejectBusy}
        danger
        onConfirm={() => void onRejectConfirm()}
        onCancel={() => setRejecting(null)}
      >
        <p>
          驳回后这条知识<b>不会进索引</b>，状态落成「已驳回」，也不会再出现在待确认里。
          记录会留着（谁在什么时候驳回过它是唯一的留痕）；
          如果只是要改一版，可以用同一条上的
          <b>「重新提交」</b>把它作为一条新草案提回来，不必重打一遍。
        </p>
        {rejecting !== null && <p className="dim kb-reject-title">{rejecting.title}</p>}
        <label className="field">
          <span>驳回原因（可留空）</span>
          <input
            type="text"
            value={reason}
            maxLength={200}
            placeholder="例如：说法不准确，我重新写一版"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {rejectError !== null && (
          <div className="notice err">
            <p className="notice-body" style={{ margin: 0 }}>{rejectError}</p>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={withdrawing !== null}
        title="撤回这条已生效的知识？"
        confirmLabel="撤回"
        busyLabel="撤回中…"
        cancelLabel="取消"
        busy={withdrawBusy}
        danger
        onConfirm={() => void onWithdrawConfirm()}
        onCancel={() => setWithdrawing(null)}
      >
        <p>
          撤回后这条知识<b>立刻不再被检索到</b>（它对应的那份文档会从索引里撤下）。
          这是一条<b>不可撤销</b>的操作 —— 要把它放回去，只能用同一条上的
          <b>「重新提交」</b>重新走一遍确认。
        </p>
        <p className="dim">
          如果相同内容还有另一条已生效的知识在引用，索引不会撤下（撤了会把那条也弄丢）；
          那一步的结果会在撤回后如实告诉你。
        </p>
        {withdrawing !== null && <p className="dim kb-reject-title">{withdrawing.title}</p>}
        <label className="field">
          <span>撤回原因（可留空）</span>
          <input
            type="text"
            value={withdrawReason}
            maxLength={200}
            placeholder="例如：口径变了，这条不再适用"
            onChange={(e) => setWithdrawReason(e.target.value)}
          />
        </label>
        {withdrawError !== null && (
          <div className="notice err">
            <p className="notice-body" style={{ margin: 0 }}>{withdrawError}</p>
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}

/**
 * 一批草案（同一次输入产出的那几条）。
 *
 * 「确认整组」放在组头上，而不是每条一个：确认接口本身以组为单位，
 * 而用户心里的一次动作也是"这一批我看过了"。逐条处理的结果由回执逐条说清。
 */
function Batch({
  entries,
  consent,
  busy,
  outcome,
  canActOn,
  canEdit,
  onEditSaved,
  onConfirm,
  onReject,
  onWithdraw,
  onResubmit,
  resubmittingId,
}: {
  entries: readonly KnowledgeEntry[];
  consent: boolean;
  busy: boolean;
  outcome: ConfirmKnowledgeGroupResponse['results'] | null;
  canActOn: (entry: KnowledgeEntry) => boolean;
  canEdit: (entry: KnowledgeEntry) => boolean;
  onEditSaved: () => Promise<void>;
  onConfirm: () => void;
  onReject: (entry: KnowledgeEntry) => void;
  onWithdraw: (entry: KnowledgeEntry) => void;
  onResubmit: (entry: KnowledgeEntry) => void;
  resubmittingId: string | null;
}) {
  const first = entries[0];
  // 有得确认才显示按钮。全都处理过之后按钮自己消失 —— 留一个点了没反应的
  // 按钮，比没有按钮更让人怀疑。
  const actionable = entries.filter((e) => e.status === 'proposed' && canActOn(e));

  return (
    <div className="kb-group">
      <div className="kb-group-head">
        <span className="kb-group-time mono">{first === undefined ? '' : fmtDateTime(first.observedAt)}</span>
        <span className="dim">这一批 {entries.length} 条</span>
        {actionable.length > 0 && (
          <span className="kb-group-actions">
            <button type="button" className="link-btn" disabled={busy || !consent} onClick={onConfirm}>
              {busy ? '处理中…' : `确认整组（${actionable.length} 条）`}
            </button>
          </span>
        )}
      </div>

      {actionable.length > 0 && !consent && (
        <p className="dim kb-hint">勾选上方的确认后才能确认入库。</p>
      )}

      <ul className="kb-entries">
        {entries.map((entry) => (
          <EntryRow
            key={entry.id}
            entry={entry}
            canAct={canActOn(entry)}
            canEdit={canEdit(entry)}
            onEditSaved={onEditSaved}
            onReject={() => onReject(entry)}
            onWithdraw={() => onWithdraw(entry)}
            onResubmit={() => onResubmit(entry)}
            resubmitting={resubmittingId === entry.id}
          />
        ))}
      </ul>

      {outcome !== null && <ConfirmOutcome results={outcome} />}
    </div>
  );
}

function EntryRow({
  entry,
  canAct,
  canEdit,
  onEditSaved,
  onReject,
  onWithdraw,
  onResubmit,
  resubmitting,
}: {
  entry: KnowledgeEntry;
  canAct: boolean;
  canEdit: boolean;
  onEditSaved: () => Promise<void>;
  onReject: () => void;
  onWithdraw: () => void;
  onResubmit: () => void;
  resubmitting: boolean;
}) {
  const conflict = entry.note?.conflict;
  const reason = entry.note?.reason;
  const withdrawn = entry.note?.withdrawn;
  const resubmittedFrom = entry.note?.resubmittedFrom;

  return (
    <li className={`kb-entry kb-entry-${entry.status}`}>
      <div className="kb-entry-head">
        {/* kind 是受控词表里的四类之一，用一个小标签固定在最左 ——
            它决定了这条知识该怎么被采信（"决定"和"未决事项"的分量完全不同）。 */}
        <span className="kb-kind">{KNOWLEDGE_KIND_LABELS[entry.kind]}</span>
        <span className="kb-entry-title">{entry.title}</span>
        <span className={`pill ${knowledgeStatusTone(entry.status)}`}>{KNOWLEDGE_STATUS_LABELS[entry.status]}</span>
      </div>

      <p className="kb-entry-body">{entry.content}</p>
      <DraftProvenance entry={entry} />
      {entry.status === 'proposed' && canEdit && <DraftEditor entry={entry} onSaved={onEditSaved} />}

      <p className="kb-entry-meta">
        <span className="record-field-label">提交人</span> <span className="record-person-value">{entry.createdByName ?? '未记录'}</span>
        {' · '}
        <span className="record-date-value">{fmtDateTime(entry.observedAt)}</span>
        {entry.confirmedByName !== null && (
          <>
            {' · '}
            <span className="record-person-value">{entry.confirmedByName}</span> 确认
            {entry.confirmedAt !== null && <> 于 <span className="record-date-value">{fmtDateTime(entry.confirmedAt)}</span></>}
          </>
        )}
      </p>

      {entry.status === 'conflicted' && entry.neighbor !== null && (
        <div className="kb-conflict">
          <p className="kb-conflict-head">
            与一条已有知识相似度 <b>{entry.neighbor.score.toFixed(3)}</b>
            {conflict !== undefined && <>（阈值 {conflict.threshold}）</>}
          </p>
          <p className="kb-conflict-body">{entry.neighbor.excerpt}</p>
          <p className="dim kb-hint">
            已交给导师 / 管理员裁决 —— 在裁决之前，这条不会进索引，也不算流标。
          </p>
        </div>
      )}

      {/* 驳回原因与"这次没做冲突检测"共用 note.reason 这一格，
          但两者对用户的意思完全不同，所以分别写。 */}
      {reason !== undefined && (
        <p className="kb-note">
          {entry.status === 'deleted' ? <>驳回原因：{reason}</> : reason}
        </p>
      )}

      {/* 撤回留痕：谁在什么时候撤的（原因可留空）。 */}
      {withdrawn !== undefined && (
        <p className="kb-note">
          撤回原因：{withdrawn.reason ?? <span className="dim">未填写</span>}
          {' · '}
          {fmtDateTime(withdrawn.at)}
        </p>
      )}

      {/* 重新提交出来的那一条，说清它的来历 —— 否则用户会奇怪
          "我明明没写过这条，它怎么冒出来的"。 */}
      {resubmittedFrom !== undefined && (
        <p className="dim kb-hint">由一条已驳回 / 已撤回的知识重新提交而来。</p>
      )}

      <div className="kb-actions">
        {entry.status === 'proposed' && canAct && (
          <button type="button" className="link-btn" onClick={onReject}>
            驳回
          </button>
        )}
        {/* 动不了的不留一个点了必然 404 的按钮，而是说清**为什么动不了**：
            归属为 NULL 的历史条目没有提交人可问，只有审核者能处理。 */}
        {entry.status === 'proposed' && !canAct && (
          <span className="dim kb-hint">
            {entry.createdById === null
              ? '这条草案没有记录提交人（历史条目），只有导师或管理员能确认它。'
              : '这条草案不是你提交的，只有提交人本人或导师 / 管理员能确认它。'}
          </span>
        )}
        {/* 撤回：已生效的条目才能撤。判据与确认/驳回同一条（owner-or-review），
            动不了的照样说清为什么。 */}
        {entry.status === 'active' && canAct && (
          <button type="button" className="link-btn" onClick={onWithdraw}>
            撤回
          </button>
        )}
        {entry.status === 'active' && !canAct && (
          <span className="dim kb-hint">
            {entry.createdById === null
              ? '这条没有记录提交人（历史条目），只有导师或管理员能撤回它。'
              : '这条不是你提交的，只有提交人本人或导师 / 管理员能撤回它。'}
          </span>
        )}
        {entry.status === 'active' &&
          (entry.firstChunkId === null ? (
            <span className="dim kb-hint">已进索引，但这份文档没有切出可跳转的块。</span>
          ) : (
            <Link className="side-link" to={`/chunk/${entry.firstChunkId}`}>
              查看入库的原文 →
            </Link>
          ))}

        {/* 重新提交：已驳回 / 已撤回的条目。产出一条新草案，原行留着。 */}
        {(entry.status === 'deleted' || entry.status === 'withdrawn') && canAct && (
          <button type="button" className="link-btn" disabled={resubmitting} onClick={onResubmit}>
            {resubmitting ? '提交中…' : '重新提交'}
          </button>
        )}
        {(entry.status === 'deleted' || entry.status === 'withdrawn') && !canAct && (
          <span className="dim kb-hint">只有提交人本人或导师 / 管理员能重新提交它。</span>
        )}
      </div>
    </li>
  );
}

/** 确认整组的逐条回执。三种结局各自说清 —— 尤其是"被挂起"和"没动"。 */
function ConfirmOutcome({ results }: { results: ConfirmKnowledgeGroupResponse['results'] }) {
  const conflicted = results.filter((r) => r.outcome === 'conflicted').length;
  const active = results.filter((r) => r.outcome === 'active').length;
  const skipped = results.filter((r) => r.outcome === 'skipped').length;

  return (
    <div className={`notice ${conflicted > 0 ? 'warn' : active > 0 ? 'ok' : ''}`}>
      <p className="notice-title">
        {active > 0 && <span className="pill ok">已入库 {active}</span>}{' '}
        {conflicted > 0 && <span className="pill warn">已挂起 {conflicted}</span>}{' '}
        {skipped > 0 && <span className="pill">未处理 {skipped}</span>}
      </p>
      <ul className="notice-list">
        {results.map((r) => (
          <li key={r.entryId}>
            <span className="mono dim">{r.entryId.slice(0, 8)}</span> {r.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
