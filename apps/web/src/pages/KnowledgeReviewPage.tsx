import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageTitle } from '../components/PageTitle.tsx';
import {
  KNOWLEDGE_KIND_LABELS,
  KNOWLEDGE_RESOLUTION_LABELS,
  type KnowledgeEntry,
  type KnowledgeResolution,
  type KnowledgeReviewQueueResponse,
  type ListKnowledgeEntriesResponse,
  type ResolveKnowledgeResponse,
} from '@knowpilot/shared';
import { Link } from 'react-router-dom';
import { apiGet, apiPost, isAbort, toApiError, type ApiError } from '../api.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SkeletonList } from '../components/Skeleton.tsx';
import { useToast } from '../components/Toast.tsx';
import { fmtDateTime } from '../format.ts';

/**
 * 知识审核（管理端）。**只做一件事：裁决冲突**。
 *
 * 【为什么冲突要人来裁决，而不是自动挑一条】向量相似度只会说"这两条很像"，
 *   不会说"该留哪条"。两条高度相似的知识可能是：
 *     · 同一条知识的两种说法（留新的、撤旧的 —— 这是「取代已有」）；
 *     · 补充关系（旧的讲 A、新的讲 A 和 B，两条都该留 —— 「允许并存」）；
 *     · 纯重复（谁都不用动）。
 *   三者的向量分数几乎一样，**只有人能分**。所以这一页的任务是把"像"变成
 *   一个明确的决定，而不是把决定伪装成一个分数。
 *
 * 【为什么这里不再有「待确认」区】`proposed` 是作者**还没按确认**的草案 ——
 *   那是他没提交的东西，摊给审核者等于替他做决定。所以队列只收 `conflicted`
 *   （它是作者按过「确认整组」、撞上已有知识之后才产生的，属于已提交）。
 *   于是"代确认整组"这个动作也跟着去掉了：没有待确认的东西可代确认。
 *
 * 【为什么要额外拉一次全部条目】冲突项里带的邻居只有一段 120 字摘要，
 *   而"撤不撤旧的"必须看到它到底写了什么才能决定。所以并发拉一次
 *   `GET /knowledge`（审核者的可见范围就是全部非草案条目），用 id 取回邻居的
 *   完整正文与可跳转的块。取不到时退回摘要并**明说这是摘要** —— 不假装那是全文。
 */
export function KnowledgeReviewPage() {
  const toast = useToast();

  const [queue, setQueue] = useState<KnowledgeReviewQueueResponse | null>(null);
  /** 全部条目，用来把冲突项里的邻居 id 还原成完整正文。 */
  const [all, setAll] = useState<readonly KnowledgeEntry[]>([]);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      // 两个请求并发：它们互不依赖，串行只是白等一个往返。
      const [review, list] = await Promise.all([
        apiGet<KnowledgeReviewQueueResponse>('/api/v1/knowledge/review', signal),
        apiGet<ListKnowledgeEntriesResponse>('/api/v1/knowledge?limit=200', signal),
      ]);
      setQueue(review);
      setAll(list.items);
      setListError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setListError(toApiError(err));
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const byId = useMemo(() => new Map(all.map((e) => [e.id, e])), [all]);

  const conflicts = queue?.items ?? [];
  const selected = conflicts.find((entry) => entry.id === selectedId) ?? conflicts[0] ?? null;

  async function run() {
    if (pending === null) return;
    setBusy(true);
    setDialogError(null);
    try {
      await apiPost<ResolveKnowledgeResponse>(
        `/api/v1/knowledge/${encodeURIComponent(pending.entry.id)}/resolve`,
        { resolution: pending.resolution },
      );
      toast.ok(`已裁决：${KNOWLEDGE_RESOLUTION_LABELS[pending.resolution]}。`);
      setPending(null);
      await load();
    } catch (err) {
      // 弹窗**不关**：错了要让人看见原因，并且还停在同一个决定上，
      // 不必重走一遍"找到那条 → 再点一次"。
      setDialogError(toApiError(err).body.error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle icon="capture">知识审核</PageTitle>
      <p className="lead">裁决与现有知识库内容高度相似或存在冲突的新增条目。</p>

      {/* 【2026-10-17：这块常驻黄框删掉了】它原先每天横在这里，写着"阈值是估的、
          未经实测校准、详见 docs/亮点与踩坑.md" —— 那是一段**工程内部备注**，
          贴在用户界面上只会让人以为系统不可信，而且它挡在队列前面。
          真实的现状（阈值是多少）收进页头一枚安静的徽标（见下），
          调参的人需要的那些话留在代码与 `docs/` 里，不在这里。
          判断标准很简单：**这句话是说给用户听的，还是说给开发者听的？** */}

      {/* 真实现状留一枚安静徽标：它是**事实**（队列按什么阈值判的），不是警告。
          调参的人一眼能看到当天生效的值，普通用户也不会被一段免责声明拦住。 */}
      {queue !== null && (
        <p style={{ margin: '0 0 14px' }}>
          <span className="pill">冲突阈值 ≥ {String(queue.threshold)}</span>
        </p>
      )}

      {listError !== null && <ErrorNotice error={listError} onRetry={() => void load()} />}
      {queue === null && listError === null && <SkeletonList rows={3} />}

      {queue !== null && conflicts.length === 0 && (
        <div className="card">
          <EmptyState icon="capture">
            队列是空的。提交人在「知识沉淀」里确认一条知识、并且它撞上了库里已有的知识时，
            那一条才会落到这里；没撞上的会直接进索引，不经过这一页。
          </EmptyState>
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="review-layout">
          <div className="card review-queue">
            <h2>待裁决冲突（{conflicts.length}）
              <span className="card-actions"><button type="button" className="link-btn" onClick={() => void load()}>刷新</button></span>
            </h2>
            <ul>
              {conflicts.map((entry) => (
                <li key={entry.id}>
                  <button type="button" className={selected?.id === entry.id ? 'review-queue-item active' : 'review-queue-item'}
                    aria-current={selected?.id === entry.id ? 'true' : undefined} onClick={() => setSelectedId(entry.id)}>
                    <strong>{entry.title}</strong>
                    <span>{entry.createdByName ?? '未记录提交人'} · {fmtDateTime(entry.observedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="card review-detail">
            <h2>冲突详情</h2>
            {selected !== null && <ul className="kb-entries">
              <ConflictRow
                key={selected.id}
                entry={selected}
                neighbor={selected.neighbor === null ? null : (byId.get(selected.neighbor.entryId) ?? null)}
                onPick={(resolution) => {
                  setDialogError(null);
                  setPending({ kind: 'resolve', entry: selected, resolution });
                }}
              />
            </ul>}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={pending === null ? '' : `${KNOWLEDGE_RESOLUTION_LABELS[pending.resolution]}？`}
        confirmLabel={pending === null ? '' : KNOWLEDGE_RESOLUTION_LABELS[pending.resolution]}
        busyLabel="处理中…"
        cancelLabel="取消"
        busy={busy}
        danger={pending !== null && pending.resolution !== 'admit'}
        onConfirm={() => void run()}
        onCancel={() => setPending(null)}
      >
        {pending !== null && <p>{dialogBody(pending.resolution)}</p>}
        {pending !== null && <p className="dim kb-reject-title">{pending.entry.title}</p>}
        {dialogError !== null && (
          <div className="notice err">
            <p className="notice-body" style={{ margin: 0 }}>{dialogError}</p>
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}

type Pending = { kind: 'resolve'; entry: KnowledgeEntry; resolution: KnowledgeResolution };

/**
 * 三种裁决各自的后果。**必须写清"那条会怎么样"** —— 三个按钮的名字都只有
 * 四个字，而"取代已有"会真的删掉另一条知识。点下去之前就要看到这件事。
 */
function dialogBody(resolution: KnowledgeResolution): string {
  if (resolution === 'admit') {
    return '这条会正常入库。已有的那条不动 —— 检索时两条都会出现。两条说的是同一件事时，这会让检索结果里出现两条近似的内容。';
  }
  if (resolution === 'supersede') {
    return '这条会入库，同时已有的那条会从索引里撤下：它的状态变成「已被取代」，那份文档会被删除，从此检索不到。这个过程不可撤销。';
  }
  return '这条落「已驳回」，不进索引；已有的那条不动。';
}

/**
 * 一条冲突及其对手。
 *
 * 【为什么把两条并排摆出来】这页要回答的问题只有一个："哪一条该留"。
 *   分数只说明它们像，答案在正文里 —— 所以两条正文必须同时在眼前，
 *   而不是让裁决的人自己在两个页面之间来回翻。
 */
function ConflictRow({
  entry,
  neighbor,
  onPick,
}: {
  entry: KnowledgeEntry;
  neighbor: KnowledgeEntry | null;
  onPick: (resolution: KnowledgeResolution) => void;
}) {
  const conflict = entry.note?.conflict;
  const excerpt = entry.neighbor?.excerpt ?? '';

  return (
    <li className="kb-entry kb-entry-conflicted kb-review-row">
      <div className="kb-entry-head">
        <span className="kb-kind">{KNOWLEDGE_KIND_LABELS[entry.kind]}</span>
        <span className="kb-entry-title">{entry.title}</span>
        <span className="pill warn">冲突待裁决</span>
      </div>

      <p className="kb-entry-meta">
        提交人 {entry.createdByName ?? <span className="dim">未记录</span>}
        {' · '}
        {fmtDateTime(entry.observedAt)}
        {conflict !== undefined && (
          <>
            {' · '}
            相似度 <b>{conflict.score.toFixed(3)}</b>（阈值 {conflict.threshold}，{conflict.model}）
          </>
        )}
      </p>

      {/* 新条目：完整正文。 */}
      <div className="kb-conflict">
        <p className="kb-conflict-head">待裁决的这条（新提交）</p>
        <p className="kb-conflict-body">{entry.content}</p>
      </div>

      {/* 对手：拿得到完整条目就显示全文并可跳到原文；拿不到就退回摘要并说明。 */}
      <div className="kb-conflict">
        <p className="kb-conflict-head">撞上的这条（已生效）</p>
        {neighbor === null ? (
          <>
            <p className="kb-conflict-body">{excerpt}</p>
            <p className="dim kb-hint">
              这是入队时留下的 120 字摘要 —— 那一条不在最近 200 条里，取不到全文。
              裁决前请先去「知识库」确认它写的是什么。
            </p>
          </>
        ) : (
          <>
            <p className="kb-conflict-body">{neighbor.content}</p>
            <p className="dim kb-hint">
              {neighbor.title}
              {neighbor.firstChunkId !== null && (
                <>
                  {' · '}
                  <Link className="side-link" to={`/chunk/${neighbor.firstChunkId}`}>
                    查看入库的原文 →
                  </Link>
                </>
              )}
            </p>
          </>
        )}
      </div>

      <div className="kb-actions">
        {/* 「取代已有」拿不到对手就点不动：服务端也会拒（见 app.ts 的 resolve），
            但在这里就先说清，别让人点一个必然报错的按钮。 */}
        <button type="button" className="link-btn" onClick={() => onPick('admit')}>
          {KNOWLEDGE_RESOLUTION_LABELS.admit}
        </button>
        <button
          type="button"
          className="link-btn"
          disabled={conflict === undefined}
          onClick={() => onPick('supersede')}
        >
          {KNOWLEDGE_RESOLUTION_LABELS.supersede}
        </button>
        <button type="button" className="link-btn" onClick={() => onPick('reject')}>
          {KNOWLEDGE_RESOLUTION_LABELS.reject}
        </button>
        <span className="dim kb-hint">
          允许并存 = 两条都留；取代已有 = 撤下旧的（不可撤销）；驳回本条 = 新的不要。
        </span>
      </div>
    </li>
  );
}
