import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageTitle } from '../components/PageTitle.tsx';
import {
  KNOWLEDGE_DISCOVERY_LABELS,
  KNOWLEDGE_KIND_LABELS,
  KNOWLEDGE_MIN_INPUT_CHARS,
  KNOWLEDGE_MAX_INPUT_CHARS,
  KNOWLEDGE_RESOLUTION_LABELS,
  type EvidenceOpenRequest,
  type KnowledgeEntry,
  type KnowledgeResolution,
  type KnowledgeReviewSource,
  type KnowledgeReviewQueueResponse,
  type ResolveKnowledgeResponse,
} from '@knowpilot/shared';
import { Link } from 'react-router-dom';
import { apiGet, apiPost, isAbort, toApiError, type ApiError } from '../api.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { EvidenceViewer, useEvidenceViewer } from '../components/evidence/EvidenceViewer.tsx';
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
 * 审核响应按每条待审项目的目标 ID 带回现行正式正文，无需从近期记录中寻找。
 */
export function KnowledgeReviewPage() {
  const toast = useToast();

  const [queue, setQueue] = useState<KnowledgeReviewQueueResponse | null>(null);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [mergedContent, setMergedContent] = useState('');
  const [dialogError, setDialogError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const review = await apiGet<KnowledgeReviewQueueResponse>('/api/v1/knowledge/review', signal);
      setQueue(review);
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

  const byId = useMemo(() => new Map((queue?.neighbors ?? []).map((entry) => [entry.id, entry])), [queue]);

  const conflicts = queue?.items ?? [];
  const selected = conflicts.find((entry) => entry.id === selectedId) ?? conflicts[0] ?? null;

  async function run() {
    if (pending === null) return;
    setBusy(true);
    setDialogError(null);
    try {
      await apiPost<ResolveKnowledgeResponse>(
        `/api/v1/knowledge/${encodeURIComponent(pending.entry.id)}/resolve`,
        { resolution: pending.resolution, ...(pending.resolution === 'merge' ? { mergedContent } : {}) },
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
                sources={queue?.sources}
                neighbor={selected.neighbor === null ? null : (byId.get(selected.neighbor.entryId) ?? null)}
                onPick={(resolution) => {
                  setDialogError(null);
                  setMergedContent('');
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
        confirmDisabled={pending?.resolution === 'merge' && mergedContent.trim().length < KNOWLEDGE_MIN_INPUT_CHARS}
        onConfirm={() => void run()}
        onCancel={() => setPending(null)}
      >
        {pending !== null && <p>{dialogBody(pending.resolution)}</p>}
        {pending?.resolution === 'merge' && <label className="field">
          <span>已核对的合并正文</span>
          <textarea value={mergedContent} onChange={(event) => setMergedContent(event.target.value)}
            rows={9} maxLength={KNOWLEDGE_MAX_INPUT_CHARS} disabled={busy} />
        </label>}
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
  if (resolution === 'merge') return '请根据上一步对照填写合并正文。确认后会发布合并稿并从检索中撤下旧条目，历史内容仍可追溯。';
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
  sources,
  onPick,
}: {
  entry: KnowledgeEntry;
  neighbor: KnowledgeEntry | null;
  sources: KnowledgeReviewQueueResponse['sources'];
  onPick: (resolution: KnowledgeResolution) => void;
}) {
  const conflict = entry.note?.conflict;
  const lifecycle = entry.note?.lifecycle;
  const excerpt = entry.neighbor?.excerpt ?? '';

  return (
    <li className="kb-entry kb-entry-conflicted kb-review-row">
      <div className="kb-entry-head">
        <span className="kb-kind">{KNOWLEDGE_KIND_LABELS[entry.kind]}</span>
        <span className="kb-entry-title">{entry.title}</span>
        <span className="pill warn">{lifecycle === undefined ? '冲突待裁决' : KNOWLEDGE_DISCOVERY_LABELS[lifecycle.kind] + '待审核'}</span>
      </div>

      <p className="kb-entry-meta">
        提交人 {entry.createdByName ?? <span className="dim">未记录</span>}
        {' · '}
        {fmtDateTime(entry.observedAt)}
        {conflict !== undefined && lifecycle === undefined && (
          <>
            {' · '}
            相似度 <b>{conflict.score.toFixed(3)}</b>（阈值 {conflict.threshold}，{conflict.model}）
          </>
        )}
      </p>

      {/* 新条目：完整正文。 */}
      <div className="kb-conflict review-incoming">
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
              这是入队时留下的摘要。当前正式来源不可读取，请核对状态后再处理。
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

      {lifecycle !== undefined && <ReviewComparison entry={entry} neighbor={neighbor} sources={sources} />}
      <div className="kb-actions">
        {/* 「取代已有」拿不到对手就点不动：服务端也会拒（见 app.ts 的 resolve），
            但在这里就先说清，别让人点一个必然报错的按钮。 */}
        <button type="button" className="link-btn" onClick={() => onPick('admit')}>
          {KNOWLEDGE_RESOLUTION_LABELS.admit}
        </button>
        <button
          type="button"
          className="link-btn"
          disabled={conflict === undefined || (lifecycle !== undefined && neighbor === null)}
          onClick={() => onPick('supersede')}
        >
          {lifecycle === undefined ? KNOWLEDGE_RESOLUTION_LABELS.supersede : '更新旧知识'}
        </button>
        {lifecycle !== undefined && <button type="button" className="link-btn"
          disabled={neighbor === null} onClick={() => onPick('merge')}>
          {KNOWLEDGE_RESOLUTION_LABELS.merge}
        </button>}
        <button type="button" className="link-btn" onClick={() => onPick('reject')}>
          {KNOWLEDGE_RESOLUTION_LABELS.reject}
        </button>
        {lifecycle === undefined && <span className="dim kb-hint">
          允许并存 = 两条都留；取代已有 = 撤下旧的（不可撤销）；驳回本条 = 新的不要。
        </span>}
      </div>
    </li>
  );
}

const reviewFields = [
  ['topic','主题'], ['project','项目'], ['conditions','条件'], ['version','版本'], ['time','适用时间'],
] as const;
const sourceLabels = { note: '研究笔记', manual: '手动文本', upload: '上传资料', conversation: '问答来源' } as const;

function compareLines(oldText: string, newText: string) {
  const split = (value: string) => value.split('\n').map((line) => line.trim()).filter(Boolean);
  const oldLines = split(oldText);
  const newLines = split(newText);
  const columns = newLines.length + 1;
  const cells = (oldLines.length + 1) * columns;
  const added: string[] = [];
  const removed: string[] = [];
  // Use the longest common subsequence to preserve order and repeated occurrences.
  // For exceptionally long historical entries show both sequences rather than exhaust the browser.
  if (cells > 4_100_000) return { added: newLines, removed: oldLines, complete: false };
  const lengths = new Uint16Array(cells);
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      const index = i * columns + j;
      lengths[index] = oldLines[i] === newLines[j] ? lengths[index + columns + 1]! + 1
        : Math.max(lengths[index + 1]!, lengths[index + columns]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else if (lengths[(i + 1) * columns + j]! >= lengths[i * columns + j + 1]!) {
      removed.push(oldLines[i++]!);
    } else {
      added.push(newLines[j++]!);
    }
  }
  return { added: added.concat(newLines.slice(j)), removed: removed.concat(oldLines.slice(i)), complete: true };
}

function ReviewSource({ entry, source, label }: {
  entry: KnowledgeEntry; source: KnowledgeReviewSource | undefined; label: string;
}) {
  const request: EvidenceOpenRequest | undefined = source?.document === undefined ? undefined
    : { version: 1, locator: source.document.locator };
  const scope = request === undefined ? entry.id : entry.id + ':' + request.locator.sourceVersion;
  const { reader, onOpenEvidence } = useEvidenceViewer(request === undefined ? [] : [{
    request, sourcePath: '/api/v1/knowledge/review/' + encodeURIComponent(entry.id) + '/source',
    requireMatchingVersion: true,
  }], scope);
  return <div>
    <strong>{label}</strong>
    <span> {source === undefined ? '未登记可核验的来源' : source.verification === 'unavailable' ? '来源已失效或不可读取'
      : source.verification === 'matched' ? '已核对保存的来源版本' : '提交人提供的文本，未与原文匹配'}</span>
    {source?.version !== undefined && <span> · {source.kind === 'ask' ? '运行时间' : '来源版本'} {source.version}</span>}
    {source?.capturedAt !== undefined && <span> · 保存于 {fmtDateTime(source.capturedAt)}</span>}
    {source?.verification === 'matched' && (source.kind === 'note' || source.kind === 'ask') &&
      <span> · 私有原件仅作者可读</span>}
    {request !== undefined && <EvidenceViewer reader={reader}>
      <button type="button" className="link-btn" onClick={() => onOpenEvidence(request)}>
        核对原资料：{source?.document?.title}
      </button>
    </EvidenceViewer>}
  </div>;
}

function ReviewComparison({ entry, neighbor, sources }: {
  entry: KnowledgeEntry; neighbor: KnowledgeEntry | null; sources: KnowledgeReviewQueueResponse['sources'];
}) {
  const lifecycle = entry.note?.lifecycle;
  if (lifecycle === undefined) return null;
  const { added, removed, complete } = compareLines(neighbor?.content ?? '', entry.content);
  const changes = [
    { label: '新提交新增', lines: added },
    { label: '仅旧条目保留', lines: removed },
  ];
  return <details className="kb-conflict review-provenance">
    <summary>来源、版本和正文差异</summary>
    <p>新来源 {sourceLabels[entry.sourceType]} · 旧来源 {neighbor ? sourceLabels[neighbor.sourceType] : '当前不可读取'}</p>
    <ReviewSource entry={entry} source={sources?.[entry.id]} label="新来源核验" />
    {neighbor !== null && <ReviewSource entry={neighbor} source={sources?.[neighbor.id]} label="旧来源核验" />}
    <dl>{reviewFields.map(([key,label]) => <div key={key}>
      <dt>{label}</dt><dd>新 {lifecycle.incomingContext[key] ?? '未记录'} · 旧 {lifecycle.targetContext[key] ?? '未记录'}</dd>
    </div>)}</dl>
    {neighbor !== null && (complete ? changes.map(({ label, lines }) => <div key={label}>
      <strong>{label}（{lines.length} 行）</strong>
      <ul>{lines.slice(0, 8).map((line, index) => <li key={index}>{line}</li>)}</ul>
    </div>) : <p>条目过长，请对照上方完整正文核对步骤顺序和重复项。</p>)}
  </details>;
}
