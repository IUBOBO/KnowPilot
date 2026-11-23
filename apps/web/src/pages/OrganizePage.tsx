import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { PageTitle } from '../components/PageTitle.tsx';
import { Link, useParams } from 'react-router-dom';
import {
  ASSET_CHECK_LABELS,
  type AssetCheckResult,
  type CodeAsset,
  type ListCodeAssetsResponse,
  type ListOrganizePlansResponse,
  type OrganizeExecuteResponse,
  type OrganizeGenerateResponse,
  type OrganizeMessage,
  type OrganizePlan,
  type OrganizePlanStatus,
  type OrganizePlanSummary,
  type OrganizePreview,
  type OrganizePreviewResponse,
  type OrganizeRule,
  type OrganizeUndoResponse,
} from '@knowpilot/shared';
import { apiGet, apiPost, isAbort, toApiError, type ApiError } from '../api.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ConsentBar } from '../components/ConsentBar.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SkeletonList } from '../components/Skeleton.tsx';

/**
 * 数据集整理（阶段 3 增补 B 的界面）。
 *
 * 【这一页和别的页面最根本的差别】本项目对数据集目录一直是**只读**姿态；
 * 整理是第一个会真的改动用户数据的动作。所以这一页的设计重心不是"顺手"，
 * 而是**把每一次移动都摆在人的眼皮底下**：
 *   · Agent 只拟计划 —— 它手里根本没有写盘的工具，执行是这里点的一个独立动作；
 *   · 规则可以逐条改，但改动会让预览作废，必须重新预览（数字要与执行对账）；
 *   · 执行前的二次确认，把三条底线写死在文案里：只在数据集目录内移动、
 *     不删除任何文件、重名不覆盖。
 *
 * 【三条铁律是"结构"而不是"嘱咐"】工具面上没有执行工具、路径只收相对且由
 * 服务端拼根、代码里没有任何 rm —— 这三条都在服务端（见 organize/ 与
 * shared/organize.ts 顶部）。界面上的文案与二次确认是给**人**看的护栏，
 * 不是安全边界本身；所以即使有人绕开这个页面直接调接口，边界依然成立。
 *
 * 【为什么预览必须重新问服务端】用户手工改了 glob，命中数只有服务端算得准
 * （匹配逻辑只有一份，抄到浏览器里早晚会和后端分叉）。改一次问一次，
 * 换来的正是"预览即所见"。
 */

/** 勾选确认记在这里。与提问入口同一套做法：换了机器的人、看同事屏幕的人，都得看得见。 */
const CONSENT_KEY = 'knowpilot.organize.consent.v1';

const PLAN_STATUS_LABELS: Record<OrganizePlanStatus, string> = {
  pending: '未执行',
  executed: '已执行',
  failed: '失败',
  undone: '已撤销',
};

export function OrganizePage() {
  const { assetId } = useParams<{ assetId: string }>();
  // 无 id = 先选一个数据集；有 id = 对它整理。做成同一个组件的两个形态，
  // 是因为"选数据集"只需要那张列表，不需要另起一页再说一遍这套说明。
  return assetId === undefined ? <DatasetPicker /> : <OrganizeWork assetId={assetId} />;
}

/** 从一堆登记里挑一个来整理。 */
function DatasetPicker() {
  const [items, setItems] = useState<readonly CodeAsset[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const body = await apiGet<ListCodeAssetsResponse>('/api/v1/code-assets', signal);
      setItems(body.items);
      setError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setError(toApiError(err));
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const matching = (items ?? []).filter((asset) => {
    const needle = query.trim().toLocaleLowerCase();
    return needle === '' || `${asset.name} ${asset.location} ${asset.project ?? ''}`.toLocaleLowerCase().includes(needle);
  });
  const usable = matching.filter((a) => a.host === null || a.host.trim() === '');
  const elsewhere = matching.filter((a) => a.host !== null && a.host.trim() !== '');

  return (
    <>
      <PageTitle icon="organize">数据集整理</PageTitle>
      <p className="lead">用白话描述整理规则，预览确认后才移动；不删除、不覆盖。</p>

      <div className="card">
        <h2>选择数据集</h2>
        {items !== null && items.length > 0 && (
          <label className="field organize-search">
            <span>搜索已登记的数据集</span>
            <input type="search" value={query} placeholder="名称、项目或路径" onChange={(event) => setQuery(event.target.value)} />
          </label>
        )}

        {error !== null && <ErrorNotice error={error} onRetry={() => void load()} />}
        {items === null && error === null && <SkeletonList rows={3} />}
        {items !== null && items.length === 0 && (
          <EmptyState
            icon="datasets"
            action={<Link className="link-btn" to="/datasets">去登记一份数据集</Link>}
          >
            还没有登记过数据集。先在「数据集管理」里登记一份 ——
            整理要在数据集自己的目录里动文件，所以得先有那个目录。
          </EmptyState>
        )}

        {items !== null && items.length > 0 && matching.length === 0 && (
          <EmptyState icon="organize" illustration="no-results">没有找到匹配的数据集，请调整搜索词。</EmptyState>
        )}

        {usable.length > 0 && (
          <ul className="asset-list">
            {usable.map((a) => (
              <li key={a.id} className="asset-item">
                <div className="asset-head">
                  <Link className="asset-title" to={`/datasets/organize/${a.id}`}>{a.name}</Link>
                  <span className={`pill ${tone(a.lastCheckResult)}`}>
                    {ASSET_CHECK_LABELS[a.lastCheckResult]}
                  </span>
                </div>
                <p className="asset-meta mono asset-path">{a.location}</p>
              </li>
            ))}
          </ul>
        )}

        {/* 声明在别的机器上的记录不在这里出现在可点列表里 —— 整理是"本机对
            这个目录动手"，服务端一定会拒绝（resolveDataset）。与其让人点进去
            撞一堵墙，不如在这里就说清楚它为什么点不了。 */}
        {elsewhere.length > 0 && (
          <>
            <h3 className="asset-group-head" style={{ marginTop: 16 }}>
              在别的机器上<span className="dim">（本机不碰它们的目录）</span>
            </h3>
            <ul className="asset-list">
              {elsewhere.map((a) => (
                <li key={a.id} className="asset-item">
                  <div className="asset-head">
                    <span className="asset-title dim">{a.name}</span>
                  </div>
                  <p className="asset-meta mono asset-path">{a.location}</p>
                  <p className="dim" style={{ margin: '6px 0 0', fontSize: '0.75rem' }}>
                    这条记录声明它在 <b>{a.host}</b> 上。要整理它，请在那台机器上打开这个页面。
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}

/** 对某一个数据集整理。 */
function OrganizeWork({ assetId }: { assetId: string }) {
  const [asset, setAsset] = useState<CodeAsset | null>(null);
  const [assetLoaded, setAssetLoaded] = useState(false);
  const [assetError, setAssetError] = useState<ApiError | null>(null);

  const [messages, setMessages] = useState<readonly OrganizeMessage[]>([]);
  const [input, setInput] = useState('');
  // 给下方的空态用：历史为空时把人送回来这里，而不是给一个跳去别页的链接。
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<ApiError | null>(null);
  const [consent, setConsent] = useState(() => localStorage.getItem(CONSENT_KEY) === '1');

  /** 当前的工作计划。来自 Agent 的一次提交，之后由用户逐条改。 */
  const [plan, setPlan] = useState<OrganizePlan | null>(null);
  const [preview, setPreview] = useState<OrganizePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  /**
   * 这个数据集上是否预览过至少一次。
   *
   * 【为什么单独记一个布尔】预览过之后，按钮就不该再退回「预览会动哪些文件」——
   * 用户刚改完规则，按钮却写着和第一次一模一样的字，看不出"我刚看过的那份作废了、
   * 得再看一次"，而这恰恰是"预览即所见"要求他做的那一步。
   */
  const [everPreviewed, setEverPreviewed] = useState(false);

  const [confirming, setConfirming] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [execError, setExecError] = useState<ApiError | null>(null);
  const [outcome, setOutcome] = useState<OrganizeExecuteResponse | null>(null);

  const [history, setHistory] = useState<readonly OrganizePlanSummary[] | null>(null);
  const [historyError, setHistoryError] = useState<ApiError | null>(null);

  /** 正在确认撤销的那一条历史。null = 没有弹窗。 */
  const [undoTarget, setUndoTarget] = useState<OrganizePlanSummary | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<ApiError | null>(null);
  const [undoOutcome, setUndoOutcome] = useState<OrganizeUndoResponse | null>(null);

  // 没有"按 id 取一条"的接口（列表接口才是登记的权威视图），所以拉列表再挑出
  // 这一条。顺带也就知道了它此刻登记的位置 —— 页面上要显示出来给人核对。
  const loadAsset = useCallback(async (signal?: AbortSignal) => {
    try {
      const body = await apiGet<ListCodeAssetsResponse>('/api/v1/code-assets', signal);
      setAsset(body.items.find((a) => a.id === assetId) ?? null);
      setAssetError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setAssetError(toApiError(err));
    } finally {
      setAssetLoaded(true);
    }
  }, [assetId]);

  const loadHistory = useCallback(async (signal?: AbortSignal) => {
    try {
      const body = await apiGet<ListOrganizePlansResponse>(
        `/api/v1/code-assets/${encodeURIComponent(assetId)}/organize-plans`,
        signal,
      );
      setHistory(body.items);
      setHistoryError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setHistoryError(toApiError(err));
    }
  }, [assetId]);

  useEffect(() => {
    const ac = new AbortController();
    void loadAsset(ac.signal);
    void loadHistory(ac.signal);
    return () => ac.abort();
  }, [loadAsset, loadHistory]);

  function onConsentChange(next: boolean) {
    setConsent(next);
    // 只勾一次就永久记住：这是本机的个人偏好，不是权限，没必要每次重勾。
    if (next) localStorage.setItem(CONSENT_KEY, '1');
    else localStorage.removeItem(CONSENT_KEY);
  }

  async function onSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (text === '' || drafting || !consent) return;

    const withUser: readonly OrganizeMessage[] = [...messages, { role: 'user', content: text }];
    const before = messages;
    setMessages(withUser);
    setInput('');
    setDrafting(true);
    setDraftError(null);
    setOutcome(null);

    try {
      const body = await apiPost<OrganizeGenerateResponse>(
        `/api/v1/code-assets/${encodeURIComponent(assetId)}/organize`,
        { messages: withUser, consentConfirmed: true },
      );
      setMessages([...withUser, { role: 'assistant', content: body.reply }]);
      // plan 为 null 是"它选择先问一句"，不是错误：对话照常显示，上一份还没执行完的
      // 计划原样留着（人可能只是补了一句说明，不想丢掉正在改的规则）。
      if (body.plan !== null) {
        setPlan({ summary: body.plan.summary, rules: body.plan.rules.map((r) => ({ ...r })) });
        invalidatePreview();
      }
    } catch (err) {
      // 失败就把这一轮还原：用户那条消息退回输入框。这一轮没有落任何东西
      // （服务端只在执行时才写库），留着半截对话只会让人以为"它已经看过了"。
      setMessages(before);
      setInput(text);
      setDraftError(toApiError(err));
    } finally {
      setDrafting(false);
    }
  }

  /** 规则一改，预览就作废 —— 不允许拿旧数字去执行一份新的计划。 */
  function invalidatePreview() {
    setPreview(null);
    setPreviewError(null);
    setConfirming(false);
    setExecError(null);
  }

  function updateRule(index: number, patch: Partial<Pick<OrganizeRule, 'match' | 'toDir'>>) {
    setPlan((prev) =>
      prev === null
        ? prev
        : { ...prev, rules: prev.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)) },
    );
    invalidatePreview();
  }

  function removeRule(index: number) {
    setPlan((prev) =>
      prev === null ? prev : { ...prev, rules: prev.rules.filter((_, i) => i !== index) },
    );
    invalidatePreview();
  }

  function addRule() {
    setPlan((prev) => (prev === null ? prev : { ...prev, rules: [...prev.rules, { match: '', toDir: '' }] }));
    invalidatePreview();
  }

  async function onPreview() {
    if (plan === null || previewing) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const body = await apiPost<OrganizePreviewResponse>(
        `/api/v1/code-assets/${encodeURIComponent(assetId)}/organize/preview`,
        { plan },
      );
      setPreview(body.preview);
      setEverPreviewed(true);
      setConfirming(false);
    } catch (err) {
      setPreviewError(toApiError(err));
    } finally {
      setPreviewing(false);
    }
  }

  async function onExecute() {
    if (plan === null || preview === null || executing) return;
    setExecuting(true);
    setExecError(null);
    try {
      const body = await apiPost<OrganizeExecuteResponse>(
        `/api/v1/code-assets/${encodeURIComponent(assetId)}/organize/execute`,
        // expectedMoves 就是用户眼下看到的那个数。服务端对不上会拒 —— 这是
        // "确认"这件事能成立的前提：确认的必须是同一份清单。
        { plan, expectedMoves: preview.totalMoves, confirmed: true },
      );
      setOutcome(body);
      // 执行完这份计划就用掉了：留着它只会让人以为还能再点一次。对话与历史都还在。
      setPlan(null);
      setPreview(null);
      setConfirming(false);
      void loadHistory();
    } catch (err) {
      setExecError(toApiError(err));
    } finally {
      setExecuting(false);
    }
  }

  /**
   * 撤销一次整理。
   *
   * 【为什么失败时把弹窗关掉】错误要落到页面上的 `ErrorNotice`（带请求 id），
   * 弹窗里没地方放它；关掉之后用户能看见"为什么没撤成"，而不是对着一个
   * 看起来没反应的按钮再点一次。
   */
  async function onUndo() {
    if (undoTarget === null || undoing) return;
    setUndoing(true);
    setUndoError(null);
    try {
      const body = await apiPost<OrganizeUndoResponse>(
        `/api/v1/code-assets/${encodeURIComponent(assetId)}/organize-plans/` +
          `${encodeURIComponent(undoTarget.id)}/undo`,
        { confirmed: true },
      );
      setUndoOutcome(body);
      setUndoTarget(null);
      // 历史里的状态/撤销计数由服务端说了算，重新拉一遍而不是就地改。
      void loadHistory();
    } catch (err) {
      setUndoTarget(null);
      setUndoError(toApiError(err));
    } finally {
      setUndoing(false);
    }
  }

  const busy = drafting || executing || undoing;

  if (assetError !== null) {
    return (
      <>
        <PageTitle icon="organize">数据集整理</PageTitle>
        <ErrorNotice error={assetError} onRetry={() => void loadAsset()} />
      </>
    );
  }
  // 声明在别的机器上的记录，界面在这里就停住 —— 不必让人填完一整段话再被服务端拒。
  // 「在哪台机器上」是登记记录里的一个事实，不是本机探测出来的结论，所以可以直接判。
  if (asset !== null && asset.host !== null && asset.host.trim() !== '') {
    return (
      <>
        <PageTitle icon="organize">数据集整理</PageTitle>
        <div className="notice warn">
          <p className="notice-title">这条记录在别的机器上</p>
          <p className="notice-body" style={{ marginBottom: 0 }}>
            「{asset.name}」声明它在 <b>{asset.host}</b> 上，位置是
            <span className="mono"> {asset.location} </span>。
            <br />
            整理是"本机对这个目录动手"，所以在 <b>{asset.host}</b> 上打开这一页才能整理它。
            回到 <Link to="/datasets/organize">数据集整理</Link> 换一个数据集。
          </p>
        </div>
      </>
    );
  }
  if (assetLoaded && asset === null) {
    return (
      <>
        <PageTitle icon="organize">数据集整理</PageTitle>
        <div className="notice warn">
          <p className="notice-title">没有这条数据集记录</p>
          <p className="notice-body" style={{ marginBottom: 0 }}>
            它可能已经被删除。回到 <Link to="/datasets">数据集管理</Link> 重新选一个。
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <PageTitle icon="organize">数据集整理</PageTitle>
      <p className="dim" style={{ margin: '0 0 4px' }}>
        <b>{asset?.name ?? '…'}</b>
        {asset?.project != null && asset.project !== '' && <span>（{asset.project}）</span>}
      </p>
      <p className="dim mono" style={{ margin: '0 0 12px' }}>{asset?.location ?? ''}</p>
      <p className="lead">用白话说明想怎么摆，Agent 只拟计划。</p>

      {/* 常驻告知：与提问入口同一件事实 —— 对话内容会离开这台机器。
          不因为它只是个"整理"就少说一句：Agent 要拟规则，就得先看见目录里的文件名。 */}
      <ConsentBar
        checked={consent}
        onCheckedChange={onConsentChange}
        pending="与 Agent 的对话内容与探查到的文件名会发往云端"
        granted="已授权：对话与目录文件名会发往 DeepSeek 处理"
      >
        <p style={{ margin: 0 }}>
          你和 Agent 的这段对话、以及它探查到的<b>目录名与文件名</b>（含清单文件的内容，
          如 <span className="mono">train.txt</span>）会发送至 <b>DeepSeek</b> 处理，即离开实验室内部网络。
          <br />
          若这份数据与<b>投稿中的稿件</b>有关（例如审稿人要求的补充实验），请注意期刊的保密要求；
          已发表论文与公开数据集无此风险。
        </p>
      </ConsentBar>

      <div className="card">
        <h2>
          和 Agent 说想怎么整理
          <span className="card-actions">
            <Link to="/datasets/organize" className="link-btn">换一个数据集 →</Link>
          </span>
        </h2>
        <p className="dim" style={{ fontSize: '0.8125rem', margin: '0 0 10px' }}>
          Agent 没有动手能力 —— 真正移动文件的是计划下方的执行按钮，且要你确认两次；
          只在数据集自己的目录内操作，不删除、不覆盖。
        </p>

        {messages.length === 0 && (
          <p className="dim" style={{ marginTop: 0 }}>
            例如：「把 train 下的图片都放到 train/images，标注放到 train/labels，
            根目录下散着的压缩包单独收进 archives。」
          </p>
        )}

        {messages.length > 0 && (
          <ol className="chat-log">
            {messages.map((m, i) => (
              <li key={i} className={`chat-msg ${m.role}`}>
                <span className="chat-role">{m.role === 'user' ? '你' : 'Agent'}</span>
                <div className="chat-text">{m.content}</div>
              </li>
            ))}
          </ol>
        )}

        {drafting && (
          <p className="dim chat-hint">
            Agent 正在探查目录、拟计划…（它可能要看几个子目录，通常十几秒到一分钟）
          </p>
        )}

        {draftError !== null && (
          <ErrorNotice error={draftError} onRetry={() => setDraftError(null)} />
        )}

        <form className="chat-compose" onSubmit={(e) => void onSend(e)}>
          <textarea
            ref={composerRef}
            value={input}
            rows={3}
            placeholder="用白话说明你的整理需求…"
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
          />
          <div className="chat-compose-foot">
            <button type="submit" disabled={busy || !consent || input.trim() === ''}>
              {drafting ? '思考中…' : '发送'}
            </button>
            {!consent && (
              <span className="dim" style={{ fontSize: '0.75rem' }}>勾选上方确认后才能发送。</span>
            )}
          </div>
        </form>
      </div>

      {plan !== null && (
        <div className="card">
          <h2>整理计划（可以逐条改）</h2>

          <p className="plan-summary">{plan.summary}</p>

          <ul className="plan-rules">
            {plan.rules.map((r, i) => (
              <li key={i} className="plan-rule">
                <label className="field">
                  <span>匹配（glob，相对数据集根）</span>
                  <input
                    type="text"
                    className="mono"
                    value={r.match}
                    placeholder="**/*.png"
                    onChange={(e) => updateRule(i, { match: e.target.value })}
                  />
                </label>
                <span className="plan-arrow" aria-hidden="true">→</span>
                <label className="field">
                  <span>移到（目录）</span>
                  <input
                    type="text"
                    className="mono"
                    value={r.toDir}
                    placeholder="images"
                    onChange={(e) => updateRule(i, { toDir: e.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="link-btn plan-remove"
                  onClick={() => removeRule(i)}
                >
                  删除
                </button>
                {r.note !== undefined && r.note !== '' && (
                  <p className="dim plan-rule-note">{r.note}</p>
                )}
              </li>
            ))}
          </ul>

          <div className="plan-toolbar">
            <button type="button" className="link-btn" disabled={busy} onClick={addRule}>
              + 加一条规则
            </button>
            <button type="button" disabled={previewing || busy} onClick={() => void onPreview()}>
              {previewing ? '预览中…' : everPreviewed ? '重新预览' : '预览会动哪些文件'}
            </button>
          </div>

          {previewError !== null && (
            <ErrorNotice error={previewError} onRetry={() => void onPreview()} />
          )}

          {preview === null && previewError === null && (
            <p className="dim chat-hint">
              {everPreviewed
                ? '规则改动之后，预览作废，要重新预览一次才能执行 —— 确认的必须是同一份清单。'
                : '先预览一次，看看这份计划到底会动哪些文件，再决定要不要执行。'}
            </p>
          )}

          {preview !== null && <PreviewPanel preview={preview} />}

          {preview !== null && (
            <div className="plan-execute">
              <button type="button" className="danger" disabled={busy} onClick={() => setConfirming(true)}>
                确认并执行
              </button>

              {/* 确认弹窗：这一段文字原先挤在预览清单下面，会把清单推走 ——
                  而"确认的必须是刚才看过的那一份清单"，弹窗把它盖住、
                  不改变它的位置，正好守住这条。 */}
              <ConfirmDialog
                open={confirming}
                title="执行这份整理计划？"
                confirmLabel="确定执行"
                busyLabel="执行中…"
                cancelLabel="取消"
                busy={executing}
                danger
                onConfirm={() => void onExecute()}
                onCancel={() => setConfirming(false)}
              >
                <p>
                  将移动 <b>{preview.totalMoves}</b> 个文件，如下所示。这次操作
                  <b>只在数据集目录内移动</b>、<b>不删除任何文件</b>、<b>重名不覆盖</b>
                  （撞名会自动改名）。执行之后可以在下面的整理历史里<b>一键撤销</b>
                  （只把文件移回原位，同样不删除任何东西）。
                </p>
              </ConfirmDialog>
            </div>
          )}

          {execError !== null && <ErrorNotice error={execError} onRetry={() => setExecError(null)} />}
        </div>
      )}

      {outcome !== null && <ExecuteOutcome outcome={outcome} />}

      <div className="card">
        <h2>
          整理历史
          <span className="card-actions">
            <button type="button" className="link-btn" onClick={() => void loadHistory()}>
              刷新
            </button>
          </span>
        </h2>

        {historyError !== null && <ErrorNotice error={historyError} onRetry={() => void loadHistory()} />}
        {/* 撤销结果留在页面上而不是一闪而过：跳过的那几条需要人逐条看。 */}
        {undoError !== null && <ErrorNotice error={undoError} onRetry={() => setUndoError(null)} />}
        {undoOutcome !== null && <UndoOutcome outcome={undoOutcome} />}
        {history === null && historyError === null && <SkeletonList rows={2} />}
        {history !== null && history.length === 0 && (
          /* 要说清"空是因为做过、还是因为没做"：没做过才空，不是记录丢了。
             动作是回到上方那个输入框 —— 这一页的入口就在那里，不需要跳走。 */
          <EmptyState
            icon="history"
            action={
              <button type="button" className="link-btn" onClick={() => composerRef.current?.focus()}>
                去上面说一句你的整理需求
              </button>
            }
          >
            这份数据集还没整理过。历史里记的是"原本打算做什么、实际做了什么"，
            所以只有真的执行过才会有记录。
          </EmptyState>
        )}

        {history !== null && history.length > 0 && (
          <ul className="asset-list">
            {history.map((p) => (
              <li key={p.id} className="asset-item">
                <div className="asset-head">
                  <span className={`pill ${planTone(p.status)}`}>{PLAN_STATUS_LABELS[p.status]}</span>
                  <span className="dim asset-meta">
                    计划 {p.plannedMoves} · 已移动 {p.moved}
                    {p.failedCount > 0 && <> · 失败 {p.failedCount}</>}
                  </span>
                </div>
                <p className="asset-meta">{p.summary}</p>
                <p className="asset-dates">
                  {fmtDateTime(p.createdAt)}
                  {p.executedAt !== null && <> · 执行于 {fmtDateTime(p.executedAt)}</>}
                  {p.undoneAt !== null && <> · 撤销于 {fmtDateTime(p.undoneAt)}</>}
                </p>
                {p.undoneAt !== null && (
                  <p className="asset-meta">
                    撤销：移回 {p.undoMoved}
                    {p.undoSkipped > 0 && <> · 跳过 {p.undoSkipped}</>}
                    {p.undoFailed > 0 && <> · 失败 {p.undoFailed}</>}
                  </p>
                )}
                {p.note !== null && p.note !== '' && <p className="asset-reason">{p.note}</p>}
                {p.undoNote !== null && p.undoNote !== '' && (
                  <p className="asset-reason">{p.undoNote}</p>
                )}

                {/* 能撤销的才给按钮；不能的说清为什么（判据在服务端，
                    见 repo.ts 的 undoable）。状态是「已撤销」时两个都为空，
                    这里就整行不出现 —— 没有动作可做的事不该占一行。 */}
                {(p.undoable || p.undoBlockedReason !== null) && (
                  <div className="asset-actions history-actions">
                    {p.undoable ? (
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() => {
                          setUndoOutcome(null);
                          setUndoError(null);
                          setUndoTarget(p);
                        }}
                      >
                        撤销这次整理
                      </button>
                    ) : (
                      <span className="history-locked">{p.undoBlockedReason}</span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <ConfirmDialog
          open={undoTarget !== null}
          title="撤销这次整理？"
          confirmLabel="确定撤销"
          busyLabel="撤销中…"
          cancelLabel="取消"
          busy={undoing}
          danger
          onConfirm={() => void onUndo()}
          onCancel={() => setUndoTarget(null)}
        >
          <p>
            将把这次整理移动过的 <b>{undoTarget?.moved ?? 0}</b> 个文件从整理后的位置
            <b>移回原处</b>。只做反向移动：<b>不删除任何文件</b>；原位置已经有同名文件的
            跳过；文件在整理之后被改动过的也跳过（会核对大小与修改时间）。
          </p>
        </ConfirmDialog>
      </div>
    </>
  );
}

/** 预览面板：这份计划到底会动哪些文件。 */
function PreviewPanel({ preview }: { preview: OrganizePreview }) {
  return (
    <div className="preview">
      <p className="preview-facts">
        将移动 <b>{preview.totalMoves}</b> 个文件
        {preview.createdDirs.length > 0 && <>，新建 {preview.createdDirs.length} 个目录</>}
        ，另有 {preview.untouched} 个文件不受影响。
      </p>

      {preview.createdDirs.length > 0 && (
        <p className="dim preview-dirs">
          会新建：{preview.createdDirs.map((d) => <span key={d} className="mono">{d}/ </span>)}
        </p>
      )}

      <ul className="preview-rules">
        {preview.rules.map((r, i) => (
          <li key={i} className="preview-rule">
            <p className="preview-rule-head">
              <span className="mono">{r.match}</span>
              <span className="plan-arrow" aria-hidden="true">→</span>
              <span className="mono">{r.toDir}/</span>
              <span className={`pill ${r.problem !== undefined ? 'err' : r.matched === 0 ? 'warn' : 'ok'}`}>
                {r.problem !== undefined ? '有问题' : `命中 ${r.matched}`}
              </span>
            </p>
            {r.problem !== undefined ? (
              <p className="preview-problem">{r.problem}</p>
            ) : r.sample.length > 0 ? (
              <p className="dim preview-sample mono">{r.sample.join('\n')}</p>
            ) : (
              <p className="dim preview-sample">（没有匹配到文件）</p>
            )}
          </li>
        ))}
      </ul>

      {preview.warnings.length > 0 && (
        <div className="notice warn">
          <p className="notice-title">需要注意</p>
          <ul className="notice-list" style={{ marginBottom: 0 }}>
            {preview.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * 执行结果。
 *
 * 只把**失败与跳过**逐条列出来：成功的那些动辄上百条，全列出来会把页面刷成
 * 一堵墙，而它们本来就是预期之内的。数量对不上或有失败时，这里必须显眼 ——
 * "移动了 118 / 计划 120" 这种事，含糊过去就等于谎报。
 */
function ExecuteOutcome({ outcome }: { outcome: OrganizeExecuteResponse }) {
  const problems = outcome.actions.filter((a) => a.status !== 'done');
  return (
    <div className={`notice ${outcome.failedCount > 0 ? 'warn' : 'ok'}`}>
      <p className="notice-title">
        整理完成：移动 {outcome.moved} · 跳过 {outcome.skipped}
        {outcome.failedCount > 0 && <> · 失败 {outcome.failedCount}</>}
      </p>
      {problems.length > 0 ? (
        <ul className="notice-list" style={{ marginBottom: 0 }}>
          {problems.slice(0, 20).map((a, i) => (
            <li key={i}>
              <span className={`pill ${a.status === 'failed' ? 'err' : ''}`}>
                {a.status === 'failed' ? '失败' : '跳过'}
              </span>{' '}
              <span className="mono">{a.fromPath ?? a.toPath}</span>
              {a.reason !== null && <> — {a.reason}</>}
            </li>
          ))}
          {problems.length > 20 && <li>…还有 {problems.length - 20} 条，详见服务端日志。</li>}
        </ul>
      ) : (
        <p className="notice-body" style={{ marginBottom: 0 }}>
          全部按计划完成，没有失败或跳过。这次整理已经记进下面的历史。
        </p>
      )}
    </div>
  );
}

/**
 * 撤销结果。
 *
 * 与执行结果同一种呈现：成功的那些不列（可能上百条），跳过/失败逐条列。
 * 【为什么一条都没移回时要单独说一句】服务端此时**不会**把计划标成已撤销
 * （磁盘上什么都没变）。页面若只报"跳过 N"，人会以为撤销过了 ——
 * 必须明确说清"历史里仍是已执行，处理后可以再试"。
 */
function UndoOutcome({ outcome }: { outcome: OrganizeUndoResponse }) {
  const problems = outcome.actions.filter((a) => a.status !== 'done');
  return (
    <div className={`notice ${outcome.failedCount > 0 || outcome.restored === 0 ? 'warn' : 'ok'}`}>
      <p className="notice-title">
        撤销结果：移回 {outcome.restored} · 跳过 {outcome.skipped}
        {outcome.failedCount > 0 && <> · 失败 {outcome.failedCount}</>}
      </p>
      {outcome.restored === 0 && (
        <p className="notice-body">
          没有任何文件被移回原位，所以这次整理在历史里仍是「已执行」。处理掉下面这些
          情况之后可以再撤销一次。
        </p>
      )}
      {problems.length > 0 ? (
        <ul className="notice-list" style={{ marginBottom: 0 }}>
          {problems.slice(0, 20).map((a, i) => (
            <li key={i}>
              <span className={`pill ${a.status === 'failed' ? 'err' : ''}`}>
                {a.status === 'failed' ? '失败' : '跳过'}
              </span>{' '}
              <span className="mono">{a.fromPath ?? a.toPath}</span>
              {a.reason !== null && <> — {a.reason}</>}
            </li>
          ))}
          {problems.length > 20 && <li>…还有 {problems.length - 20} 条，详见服务端日志。</li>}
        </ul>
      ) : outcome.restored > 0 ? (
        <p className="notice-body" style={{ marginBottom: 0 }}>
          全部按原样移回，没有跳过或失败。
        </p>
      ) : null}
    </div>
  );
}

/** 结果对应的 pill 配色。只有「未找到」是真的出事了，给红色（与数据集管理页同款）。 */
function tone(result: AssetCheckResult): string {
  if (result === 'exists') return 'ok';
  if (result === 'missing') return 'err';
  if (result === 'unreachable') return 'warn';
  return '';
}

function planTone(status: OrganizePlanStatus): string {
  if (status === 'executed') return 'ok';
  if (status === 'failed') return 'err';
  // 已撤销是一个正常的历史结局，用中性色；不要再给黄色警告。
  if (status === 'undone') return '';
  return 'warn';
}

/** ISO → 本地「2026-10-07 13:30」。 */
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
