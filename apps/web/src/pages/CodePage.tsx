import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { PageTitle } from '../components/PageTitle.tsx';
import { Link } from 'react-router-dom';
import {
  ASSET_CHECK_LABELS,
  ASSET_CHECK_RESULTS,
  DATASET_PROFILE_LABELS,
  type AllowedRoot,
  type AssetCheckResult,
  type CheckCodeAssetResponse,
  type CheckCodeAssetsResponse,
  type CodeAsset,
  type CreateCodeAssetResponse,
  type DatasetProfile,
  type ListDocumentsResponse,
  type DeleteCodeAssetResponse,
  type ListCodeAssetsResponse,
  type UpdateCodeAssetRequest,
  type UpdateCodeAssetResponse,
} from '@knowpilot/shared';
import { apiDelete, apiGet, apiPatch, apiPost, isAbort, toApiError, type ApiError } from '../api.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Modal } from '../components/Modal.tsx';
import { SkeletonList } from '../components/Skeleton.tsx';
import { useToast } from '../components/Toast.tsx';
import { useFocusTarget } from '../use-focus-target.ts';
import { fmtDateTime, fmtDaysAgo, localDaysSince } from '../format.ts';

/**
 * 数据集管理。
 *
 * 【这一页和别的页面有什么不同】文档进了库，"原件在哪"就不再重要；而数据集
 * 永远留在文件系统上，库里存的只是一个**指路牌**。指路牌会失效：目录被挪走、
 * 盘掉线、那台机器关机。所以这一页的核心动作不是"看清单"，而是**核对**
 * —— 需求 5 的「路径有效性巡检」。
 *
 * 【为什么结果不是"有效/无效"两个词】见 shared/code-assets.ts 顶部：
 * 「未找到」和「无法核对」必须分开。前者要去找回来，后者什么都不用做 ——
 * 把这两件事显示成同一个值，用户就会在什么都没丢的时候被叫去救火，
 * 几次之后这页的提示就再也没人看了。
 *
 * 【编辑与删除的边界】「删除」只删这条**登记记录**，磁盘上的数据集一份都不动
 * （界面上的二次确认里也这么写着）。真实数据集往往是整个课题组的资产，
 * 一个网页按钮能删掉它才是灾难。
 *
 * 阶段 4A 起这一页要求登录（`code.read`）：路径与所在机器暴露了实验室的
 * 数据布局，不该给没登录的人看。写口按 `code.write` + "本人或管理员" 判定，
 * 登记人记在 `code_assets.created_by`（阶段 1–3 的历史行仍为 NULL，
 * 按"公共历史数据"对待）。
 */
export function CodePage() {
  const [items, setItems] = useState<readonly CodeAsset[] | null>(null);
  const [query, setQuery] = useState('');
  const [roots, setRoots] = useState<readonly AllowedRoot[]>([]);
  const [listError, setListError] = useState<ApiError | null>(null);

  const [creating, setCreating] = useState(false);
  /** 「登记一份数据集」表单是否展开（原先它常驻在列表上方，占掉首屏一大块）。 */
  const [showCreate, setShowCreate] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<ApiError | null>(null);
  const [outcome, setOutcome] = useState<CreateCodeAssetResponse | null>(null);

  /**
   * 正在处理的那一行。用 `{ id, kind }` 而不是三个各自独立的布尔：
   * 同一时刻只该有一条在动，而按钮上要写「核对中…」还是「保存中…」
   * 取决于它此刻在做什么 —— 分开三个布尔就还要再维护一条互斥规则。
   */
  const [busy, setBusy] = useState<{ id: string; kind: 'check' | 'save' | 'delete' } | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);
  const [rowError, setRowError] = useState<{ id: string; error: ApiError } | null>(null);

  /**
   * 改/删之后的一句话回执走**轻提示**（S4），不再占列表上方的一条常驻通告：
   * 它是"刚做成了"的事，看完就该退场；而列表上方的位置是留给**还要继续看**的东西的
   * （`outcome` 的核对结果、`summary` 的批量结果）。原来的 `flash` 状态因此删掉。
   */
  const toast = useToast();

  /**
   * 刚核对过的理由，按 id 存着。
   *
   * 【为什么要单独存一份】理由**不入库**（它是"这台机器此刻"的判断，
   * 换个部署位置就变，存下来必然过期），所以列表接口里没有它。
   * 但它又必须显示 —— 一屏「无法核对」没有理由是没法处理的：
   * "不在允许根目录内"要去改配置，"本机看不到根目录"则什么都不用做。
   * 于是核对接口把它带回来，这里存住，直到下一次列表刷新。
   */
  const [reasons, setReasons] = useState<ReadonlyMap<string, string>>(new Map());
  const [summary, setSummary] = useState<Record<AssetCheckResult, number> | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const locationRef = useRef<HTMLInputElement>(null);
  const projectRef = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLInputElement>(null);
  const accessNoteRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLInputElement>(null);

  const loadList = useCallback(async (signal?: AbortSignal) => {
    try {
      const body = await apiGet<ListCodeAssetsResponse>('/api/v1/code-assets', signal);
      setItems(body.items);
      setRoots(body.roots);
      // 上一次核对留下的理由只对**那一次**成立：它可能说的是"CODE_ROOTS 里
      // 没有这个根目录"，而用户也许刚改完配置重启过。刷新之后还挂着它，
      // 就会和上面刚探过的根目录面板各说各话 —— 一个页面自己跟自己矛盾，
      // 比少显示一句话糟糕得多。结论（pill）是库里存的，继续留着；
      // 解释（reason）随这一次刷新作废。
      setReasons(new Map());
      setSummary(null);
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

  // ⌘K 搜到某个数据集后带 `?focus=` 进来：列表加载完成后定位那一行。
  useFocusTarget('dataset-', items !== null);

  function rememberReasons(checked: readonly { asset: CodeAsset; reason: string }[]) {
    setReasons((prev) => {
      const next = new Map(prev);
      for (const c of checked) next.set(c.asset.id, c.reason);
      return next;
    });
  }

  /** 有任意一条在动就不能再发起新的行内操作（改和删共用这一条闸）。 */
  const rowLocked = busy !== null || checkingAll;

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const dataset = readProfileForm(form);
    const name = nameRef.current?.value.trim() ?? '';
    const location = locationRef.current?.value.trim() ?? '';

    if (name === '') {
      setFormError('请填写名称。至少要有个名字，否则列表里认不出这条指的是什么。');
      return;
    }
    if (location === '') {
      setFormError('请填写位置。这一类记录的全部意义就是「它在哪」。');
      return;
    }
    // 界面上先拦一道只是顺手：服务端一定会再拦一次（脚本不经过这里）。
    // 这里拦的是最常见的错法 —— 把相对路径或下载地址填进"位置"。
    if (!LOOKS_ABSOLUTE.test(location)) {
      setFormError(
        `「位置」要填绝对路径，例如 /srv/knowpilot/datasets/medical/amos22。` +
          `如果这是"怎么获取"（下载地址、共享链接），请填在下一行的「怎么获取」里。`,
      );
      return;
    }

    setFormError(null);
    setCreateError(null);
    setOutcome(null);
    setCreating(true);

    try {
      const result = await apiPost<CreateCodeAssetResponse>('/api/v1/code-assets', {
        name,
        location,
        profile: dataset.profile,
        ...(dataset.documentationId ? { documentationId: dataset.documentationId } : {}),
        // 空串不发出去：服务端把空串与"未提供"当同一件事（与台账同一口径），
        // 少传一个字段，契约上就少一种需要解释的输入。
        ...(trimmed(projectRef.current?.value) !== undefined
          ? { project: trimmed(projectRef.current?.value) }
          : {}),
        ...(trimmed(hostRef.current?.value) !== undefined
          ? { host: trimmed(hostRef.current?.value) }
          : {}),
        ...(trimmed(accessNoteRef.current?.value) !== undefined
          ? { accessNote: trimmed(accessNoteRef.current?.value) }
          : {}),
        ...(trimmed(notesRef.current?.value) !== undefined
          ? { notes: trimmed(notesRef.current?.value) }
          : {}),
      });
      setOutcome(result);
      form.reset();

      // 成功才清空表单。失败时保留用户填的内容 —— 让他重填一遍是那种
      // "再也不想用第二次"的体验。
      for (const ref of [nameRef, locationRef, projectRef, hostRef, accessNoteRef, notesRef]) {
        if (ref.current !== null) ref.current.value = '';
      }

      // 顺序不能反：loadList 会把上一轮的 reason 清掉（理由见 loadList 里），
      // 所以必须"先拉列表、再记这次的 reason"，否则刚登记的这条理由当场被抹掉。
      await loadList();
      rememberReasons([{ asset: result.asset, reason: result.reason }]);
    } catch (err) {
      setCreateError(toApiError(err));
    } finally {
      setCreating(false);
    }
  }

  async function onCheckOne(id: string) {
    if (rowLocked) return;
    setBusy({ id, kind: 'check' });
    setRowError(null);
    try {
      const body = await apiPost<CheckCodeAssetResponse>(
        `/api/v1/code-assets/${encodeURIComponent(id)}/check`,
        {},
      );
      await loadList();
      rememberReasons([body.checked]);
    } catch (err) {
      setRowError({ id, error: toApiError(err) });
    } finally {
      setBusy(null);
    }
  }

  async function onCheckAll() {
    if (busy !== null || checkingAll) return;
    setCheckingAll(true);
    setRowError(null);
    setSummary(null);
    try {
      const body = await apiPost<CheckCodeAssetsResponse>('/api/v1/code-assets/check', {});
      // 同样是先拉列表再记理由，顺序理由见 onCreate / loadList 里的说明。
      await loadList();
      rememberReasons(body.items);
      setSummary(body.summary);
    } catch (err) {
      setListError(toApiError(err));
    } finally {
      setCheckingAll(false);
    }
  }

  /**
   * 保存一条的修改。返回是否成功 —— 行内的编辑表单据此决定要不要退出编辑态：
   * 失败时留在编辑态，用户填的东西还在，不用重来一遍。
   */
  async function onSave(id: string, patch: UpdateCodeAssetRequest): Promise<boolean> {
    if (rowLocked) return false;
    setBusy({ id, kind: 'save' });
    setRowError(null);
    try {
      const body = await apiPatch<UpdateCodeAssetResponse>(
        `/api/v1/code-assets/${encodeURIComponent(id)}`,
        patch,
      );
      await loadList();
      // 只有改了位置或机器时后端才会重新核对并带回理由；没重核就别去动
      // 上一次的理由（那一次核对针对的是同一条路径，仍然有效）。
      if (body.reason !== null) rememberReasons([{ asset: body.asset, reason: body.reason }]);
      // 重新核对的那段理由**不放进提示**：它已经落在这行的「核对说明」里了，
      // 提示条是给出"做成了"这个信号，不是承载一屏文字的地方。
      toast.ok(
        body.reason !== null
          ? `已保存「${body.asset.name}」，并重新核对了一次。`
          : `已保存「${body.asset.name}」。`,
      );
      return true;
    } catch (err) {
      setRowError({ id, error: toApiError(err) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  /** 删除一条**登记记录**（磁盘上的数据不动）。返回值同 onSave。 */
  async function onDelete(id: string): Promise<boolean> {
    if (rowLocked) return false;
    setBusy({ id, kind: 'delete' });
    setRowError(null);
    try {
      const body = await apiDelete<DeleteCodeAssetResponse>(
        `/api/v1/code-assets/${encodeURIComponent(id)}`,
      );
      await loadList();
      toast.ok(`已删除登记「${body.deleted.name}」。磁盘上的数据没有动。`);
      return true;
    } catch (err) {
      setRowError({ id, error: toApiError(err) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  // 已经用过的项目名，给录入框做候选。它同时是**分组**的依据，
  // 所以拼成两个写法就会在列表里裂成两组。
  const projects = [
    ...new Set((items ?? []).map((a) => a.project).filter((p): p is string => p !== null)),
  ];

  const visibleItems = (items ?? []).filter((asset) => {
    const needle = query.trim().toLocaleLowerCase();
    return needle === '' || [asset.name, asset.location, asset.project ?? '', asset.notes ?? '',
      asset.accessNote ?? '', ...Object.values(asset.profile ?? {})]
      .some((value) => value.toLocaleLowerCase().includes(needle));
  });
  const groups = groupByProject(visibleItems);

  // 胶囊在两件事上要变色：一个根目录都没配（这一页给不出有用结论），
  // 或者配了但**本机一个都看不到**（多半是把开发机当成了数据服务器）。
  const rootsWarning = roots.length === 0 || roots.every((r) => !r.visible);

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <PageTitle icon="datasets">数据集管理</PageTitle>
          {/* 【为什么四种核对状态不写在这里了】原先这段导语花六行解释「存在 / 未找到 /
              无法核对 / 未核对」的差别。那些差别**逐条写在每一行的核对结果旁边**
              （`probe.reason`），用户看到某一条时的那句话，比这里一段通用说明有用得多。 */}
          <p className="lead">登记数据集与代码位置，定期核对路径是否有效。</p>
        </div>
        <div className="page-head-actions">
          {/* 「允许探测的根目录」从一张常驻大卡片降级成这里的一枚胶囊
              （「界面整理-new」§六.4）：它是**本机配置的现状**，不是这一页的内容 ——
              而原先它占着首屏第二块地方（8 行说明 + 一份清单），
              把真正的数据集列表挤到下面去了。点开才展开详情。 */}
          <details className="roots-summary">
            <summary>
              <span className={`pill ${rootsWarning ? 'warn' : ''}`}>
                探测根目录：{roots.length === 0 ? '未配置' : `${roots.filter((r) => r.visible).length} 个可见`}
              </span>
            </summary>
            <div className="roots-detail">
              <p style={{ marginTop: 0 }}>
                只有落在这些目录里的位置才会被本机核对，清单来自服务端
                <span className="mono"> .env </span>的
                <span className="mono"> CODE_ROOTS</span>。
                别的路径一律如实报「无法核对」——登记不受此限制，受限的只是探测。
              </p>
              {roots.length === 0 ? (
                <>
                  <p>
                    本机没有配置允许根目录，因此任何路径都只会得到「无法核对」，
                    包括确实存在的。这不算故障，但这一页现在给不出有用的结论。
                    要在本机启用核对，请在项目根目录的<span className="mono"> .env </span>里加一行：
                  </p>
                  <p className="mono" style={{ margin: '6px 0 0' }}>
                    CODE_ROOTS=[&quot;/srv/knowpilot/datasets&quot;]
                  </p>
                </>
              ) : (
                <ul className="asset-roots">
                  {roots.map((r) => (
                    <li key={r.path}>
                      <span className="mono asset-root-path">{r.path}</span>
                      <span className={`pill ${r.visible ? 'ok' : 'warn'}`}>
                        {r.visible ? '本机可见' : '本机看不到'}
                      </span>
                      {!r.visible && (
                        <span className="dim asset-root-hint">
                          这台机器上没有这个目录。若这是数据服务器上的位置，属正常。
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
          {/* 上传入口留在这里而不是只放侧栏：需要登记的人，往往是刚把一份数据传上来的人，
              而「上传」在另一个页面。两者相邻摆着，"传完顺手登记"才成立。 */}
          <Link to="/datasets/upload" className="btn-outline">上传文件</Link>
          <button type="button" className="btn-primary" onClick={() => setShowCreate(true)}>
            + 登记数据集
          </button>
        </div>
      </div>

      <Modal
        open={showCreate}
        wide
        title="登记一份数据集"
        onClose={() => setShowCreate(false)}
        initialFocusTo={nameRef}
        footer={
          <>
            <button type="button" className="link-btn" disabled={creating} onClick={() => setShowCreate(false)}>
              取消
            </button>
            <button type="submit" form="asset-create" className="btn-primary" disabled={creating}>
              {creating ? '登记中…' : '登记并核对'}
            </button>
          </>
        }
      >
        <form id="asset-create" className="form-row" onSubmit={(e) => void onCreate(e)}>
          <label className="field">
            <span>名称</span>
            <input ref={nameRef} type="text" placeholder="必填，如「ACDC 心脏分割」" />
          </label>

          <label className="field field-wide">
            <span>位置（绝对路径）</span>
            <input
              ref={locationRef}
              type="text"
              className="mono"
              placeholder="/srv/knowpilot/datasets/medical/amos22"
            />
          </label>

          <label className="field">
            <span>项目（可留空）</span>
            <input ref={projectRef} type="text" list="asset-projects" placeholder="列表按它分组" />
            <datalist id="asset-projects">
              {projects.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </label>

          <label className="field">
            <span>所在机器（可留空）</span>
            <input ref={hostRef} type="text" placeholder="留空 = 就是本机" />
          </label>

          <label className="field">
            <span>怎么获取（可留空）</span>
            <input ref={accessNoteRef} type="text" placeholder="如「连上服务器后直接看」" />
          </label>

          <label className="field">
            <span>备注（可留空）</span>
            <input ref={notesRef} type="text" />
          </label>
          <DatasetProfileFields />

          <p className="dim" style={{ flexBasis: '100%', margin: 0, fontSize: '0.8125rem' }}>
            「位置」与「所在机器」是两件事：位置填<b>在那台机器上</b>的绝对路径，
            机器留空就表示这台服务所在的机器。填了机器的记录本机不去探测它。
          </p>
          {/* 提交按钮在弹窗底部的动作区里（`form="asset-create"`），不在这里。 */}
        </form>

        {formError !== null && (
          <div className="notice err"><p className="notice-body">{formError}</p></div>
        )}

        {createError !== null && (
          <ErrorNotice error={createError} onRetry={() => setCreateError(null)} />
        )}
      </Modal>

      {/* 登记结果落在**页面上**（弹窗此时已经关上）—— 「存在 / 无法核对」是这条记录
          当下的事实，用户要看得见；刷新或再登记一次即被下一条覆盖。 */}
      {outcome !== null && (
        <div className="notice">
          <p className="notice-title">
            <span className={`pill ${tone(outcome.asset.lastCheckResult)}`}>
              {ASSET_CHECK_LABELS[outcome.asset.lastCheckResult]}
            </span>{' '}
            <span className="dim">{outcome.asset.name}</span>
          </p>
          <p className="notice-body" style={{ marginBottom: 0 }}>
            已登记，并顺手核对了一次：{outcome.reason}
          </p>
        </div>
      )}

      <div className="card">
        <h2>
          已登记的数据集{items !== null && `（${items.length} 条）`}
          <span className="card-actions">
            <button
              type="button"
              className="link-btn"
              disabled={checkingAll || busy !== null || (items ?? []).length === 0}
              onClick={() => void onCheckAll()}
            >
              {checkingAll ? '核对中…' : '全部核对'}
            </button>
            <button type="button" className="link-btn" disabled={checkingAll} onClick={() => void loadList()}>
              刷新
            </button>
          </span>
        </h2>

        {items !== null && items.length > 0 && (
          <label className="field dataset-search">
            <span>搜索数据集</span>
            <input type="search" value={query} placeholder="名称、项目或路径" onChange={(event) => setQuery(event.target.value)} />
          </label>
        )}

        {listError !== null && <ErrorNotice error={listError} onRetry={() => void loadList()} />}

        {summary !== null && (
          <div className={`notice ${summaryTone(summary)}`}>
            <p className="notice-title">核对完成</p>
            <p className="notice-body" style={{ marginBottom: 0 }}>
              {ASSET_CHECK_RESULTS.filter((r) => summary[r] > 0)
                .map((r) => `${ASSET_CHECK_LABELS[r]} ${summary[r]}`)
                .join(' · ') || '没有可核对的记录。'}
              {summary.missing > 0 && (
                <>
                  <br />
                  有 {summary.missing} 条确实找不到了——这些要去找回来或改掉位置。
                </>
              )}
            </p>
          </div>
        )}

        {items === null && listError === null && <SkeletonList rows={3} />}
        {items !== null && items.length === 0 && (
          /* 表单就在**同一页**的上方，所以动作是"把光标送进第一个输入框"，
             而不是再给一个指向 /datasets 的链接 —— 那会把人送回原地。
             （受控组件里 .focus() 会一并滚动到可见位置。） */
          <EmptyState
            icon="datasets"
            action={
              <button type="button" className="link-btn" onClick={() => setShowCreate(true)}>
                登记第一份数据集
              </button>
            }
          >
            还没有记录。登记的是数据集所在的目录，不是把数据搬进库里 ——
            这一行只是一块指路牌，所以目录被挪走之后要靠每行的「核对」找出来。
          </EmptyState>
        )}

        {items !== null && items.length > 0 && visibleItems.length === 0 && (
          <EmptyState icon="datasets" illustration="no-results">没有找到匹配的数据集，请调整搜索词。</EmptyState>
        )}

        {groups.map((g) => (
          <div key={g.project ?? '__none__'} className="asset-group">
            <h3 className="asset-group-head">
              {g.project ?? '未归属'}
              <span className="dim">（{g.items.length}）</span>
            </h3>
            <ul className="asset-list">
              {g.items.map((a) => (
                <AssetItem
                  key={a.id}
                  asset={a}
                  busyKind={busy !== null && busy.id === a.id ? busy.kind : null}
                  disabled={checkingAll}
                  reason={reasons.get(a.id) ?? null}
                  error={rowError !== null && rowError.id === a.id ? rowError.error : null}
                  onCheck={() => void onCheckOne(a.id)}
                  onSave={(patch) => onSave(a.id, patch)}
                  onDelete={() => onDelete(a.id)}
                  onDismissError={() => setRowError(null)}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}

function AssetItem({
  asset: a,
  busyKind,
  disabled,
  reason,
  error,
  onCheck,
  onSave,
  onDelete,
  onDismissError,
}: {
  asset: CodeAsset;
  /** 这一条此刻在做什么；null = 空闲。 */
  busyKind: 'check' | 'save' | 'delete' | null;
  disabled: boolean;
  reason: string | null;
  error: ApiError | null;
  onCheck: () => void;
  onSave: (patch: UpdateCodeAssetRequest) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onDismissError: () => void;
}) {
  // 编辑态与"等确认删除"都放在行内、由行自己管：它们只影响这一行的样子，
  // 提到页面级只会让父组件多维护两个 id 和一堆条件。行少，同时开两个编辑
  // 也没什么坏处（真正要互斥的是并发的写请求，那由页面的 busy 闸管住）。
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const busy = busyKind !== null;

  async function confirmDelete() {
    const ok = await onDelete();
    // 删成功这一行就不存在了，关不关这个状态都看不见；失败时留在确认态，
    // 用户能直接再点一次，不用重新按一遍「删除」。
    if (ok) setConfirmingDelete(false);
  }

  return (
    <li className="asset-item" id={`dataset-${a.id}`}>
      <div className="asset-head">
        <span className="asset-title">{a.name}</span>
        <span className={`pill ${tone(a.lastCheckResult)}`}>
          {ASSET_CHECK_LABELS[a.lastCheckResult]}
        </span>
      </div>

      {/* 错误提示放在编辑/展示两种形态之外：保存失败时还在编辑态，
          若把它塞进展示分支，那条错误就永远显示不出来。 */}
      {error !== null && <ErrorNotice error={error} onRetry={onDismissError} />}

      {editing ? (
        <AssetEditor
          asset={a}
          saving={busyKind === 'save'}
          disabled={busy}
          onSave={onSave}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <p className="asset-meta mono asset-path"><span className="record-field-label">路径</span> {a.location}</p>

          <p className="asset-dates">
            {a.host !== null ? <>在 <b>{a.host}</b> 上</> : '在这台服务所在的机器上'}
            {' · '}
            {a.lastCheckedAt === null ? (
              '还没核对过'
            ) : (
              <>
                最后核对：
                <span
                  className={isStaleCheck(a.lastCheckedAt) ? 'asset-freshness-stale' : undefined}
                  title={fmtDateTime(a.lastCheckedAt)}
                >
                  {fmtDaysAgo(a.lastCheckedAt)}
                </span>
              </>
            )}
            {a.accessNote !== null && a.accessNote !== '' && <> · 怎么获取：{a.accessNote}</>}
            {a.notes !== null && a.notes !== '' && <> · 备注：{a.notes}</>}
          </p>
          {DATASET_PROFILE_KEYS.some((key) => a.profile?.[key]) && <dl className="sub-record-context">
            {DATASET_PROFILE_KEYS.map((key) => a.profile?.[key] && <div key={key}>
              <dt className="sub-context-label">{DATASET_PROFILE_LABELS[key]}</dt><dd>{a.profile[key]}</dd>
            </div>)}
          </dl>}
          {a.documentationId && <Link className="link-btn" to={`/docs?focus=${encodeURIComponent(a.documentationId)}`}>打开说明文档</Link>}

          {/* 理由要说清楚"所以该做什么"。「无法核对」至少有三种成因，
              对应的动作完全相反，只给一个词，用户唯一能做的就是来问我们。 */}
          {reason !== null && <p className="asset-reason">{reason}</p>}

          {/* 行内动作统一成一组**同一层级的幽灵按钮**（「界面整理-new」§六.4）：
              原先「核对」是一颗带框的按钮，旁边三样是带下划线的文字链接，
              高低错位、看起来不像一回事。现在四样同款，只有「删除」用 danger 变体
              （平时低调灰、悬停才转珊瑚红）—— 它不该和「编辑」长得一模一样。 */}
          <div className="asset-actions">
            <div className="row-actions">
              <button type="button" className="link-btn" disabled={busy || disabled} onClick={onCheck}>
                {busyKind === 'check' ? '核对中…' : '核对'}
              </button>
              {/* 整理入口摆在每一行上：要整理的人多半是刚看这条记录的人。
                  声明在别的机器上的记录也照样给这个链接 —— 点进去那一页会明确
                  说"本机不碰它的目录"，比在这里凭空少一个按钮好解释。 */}
              <Link to={`/datasets/organize/${a.id}`} className="link-btn">整理</Link>
              <button
                type="button"
                className="link-btn"
                disabled={busy || disabled}
                onClick={() => setEditing(true)}
              >
                编辑
              </button>
              <button
                type="button"
                className="link-btn danger"
                disabled={busy || disabled}
                onClick={() => setConfirmingDelete(true)}
              >
                删除
              </button>
            </div>
          </div>

          {/* 确认弹窗在这里声明，但渲染到 body（组件内部用 portal）——
              所以它**不参与这一行的布局**，不再把下面的行推走。 */}
          <ConfirmDialog
            open={confirmingDelete}
            title="删除这条登记？"
            confirmLabel="确定删除"
            busyLabel="删除中…"
            cancelLabel="取消"
            busy={busyKind === 'delete'}
            danger
            onConfirm={() => void confirmDelete()}
            onCancel={() => setConfirmingDelete(false)}
          >
            <p>
              确定删掉这条<b>登记</b>？只会删掉这条记录，
              <b>磁盘上的数据一份都不会动</b>。删错了要重新登记一遍。
            </p>
          </ConfirmDialog>
        </>
      )}
    </li>
  );
}

const DATASET_PROFILE_KEYS = Object.keys(DATASET_PROFILE_LABELS) as (keyof DatasetProfile)[];

function readProfileForm(form: HTMLFormElement): { profile: DatasetProfile; documentationId: string | null } {
  const data = new FormData(form);
  const profile: DatasetProfile = {};
  for (const key of DATASET_PROFILE_KEYS) {
    const value = String(data.get(key) ?? '').trim();
    if (value) profile[key] = value;
  }
  return { profile, documentationId: String(data.get('documentationId') ?? '').trim() || null };
}

function DatasetProfileFields({ asset }: { asset?: CodeAsset }) {
  const [docs, setDocs] = useState<ListDocumentsResponse['items']>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void apiGet<ListDocumentsResponse>('/api/v1/documents?limit=500', controller.signal)
      .then((result) => setDocs(result.items))
      .catch((error: unknown) => { if (!isAbort(error)) setLoadFailed(true); });
    return () => controller.abort();
  }, []);
  return <>
    {DATASET_PROFILE_KEYS.map((key) => <label key={key} className="field">
      <span>{DATASET_PROFILE_LABELS[key]}</span>
      <input type="text" name={key} maxLength={1000} defaultValue={asset?.profile?.[key] ?? ''} />
    </label>)}
    <label className="field"><span>关联说明文档</span>
      <select name="documentationId" defaultValue={asset?.documentationId ?? ''}>
        <option value="">不关联</option>
        {asset?.documentationId && !docs.some((doc) => doc.id === asset.documentationId)
          && <option value={asset.documentationId}>当前关联文档</option>}
        {docs.map((doc) => <option key={doc.id} value={doc.id}>{doc.title}</option>)}
      </select>
    </label>
    {loadFailed && <p className="dim" role="status">说明文档列表暂不可用。</p>}
  </>;
}

/**
 * 就地修改一条记录的表单。
 *
 * 两个刻意的做法：
 *   1. 输入框是非受控的（`defaultValue`），保存失败时用户填的内容原样留着，
 *      不用重打一遍 —— 与登记表单"成功才清空"同一条判断。
 *   2. 六个字段**全部回传**（留空即 null）。服务端的 PATCH 按"提到了哪些字段"
 *      判断，而这里每次都是完整的一份新状态，所以界面上不存在"我只想改名字、
 *      别的都保持"这种半份请求 —— 那种请求一旦漏传一个字段就会把它悄悄清掉。
 */
function AssetEditor({
  asset,
  saving,
  disabled,
  onSave,
  onCancel,
}: {
  asset: CodeAsset;
  saving: boolean;
  disabled: boolean;
  onSave: (patch: UpdateCodeAssetRequest) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const locationRef = useRef<HTMLInputElement>(null);
  const projectRef = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLInputElement>(null);
  const accessNoteRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const dataset = readProfileForm(event.currentTarget);
    const name = nameRef.current?.value.trim() ?? '';
    const location = locationRef.current?.value.trim() ?? '';

    if (name === '') {
      setFormError('名称不能清空——列表里认不出这条指的是什么。');
      return;
    }
    if (location === '') {
      setFormError('位置不能清空——这一类记录的全部意义就是「它在哪」。');
      return;
    }
    if (!LOOKS_ABSOLUTE.test(location)) {
      setFormError('「位置」要填绝对路径。如果这是"怎么获取"，请填在「怎么获取」里。');
      return;
    }

    setFormError(null);
    const ok = await onSave({
      name,
      location,
      project: trimmedOrNull(projectRef.current?.value),
      host: trimmedOrNull(hostRef.current?.value),
      accessNote: trimmedOrNull(accessNoteRef.current?.value),
      notes: trimmedOrNull(notesRef.current?.value),
      profile: dataset.profile,
      documentationId: dataset.documentationId,
    });
    if (ok) onCancel();
  }

  return (
    <form className="form-row asset-editor" onSubmit={(e) => void submit(e)}>
      <label className="field">
        <span>名称</span>
        <input ref={nameRef} type="text" defaultValue={asset.name} />
      </label>

      <label className="field field-wide">
        <span>位置（绝对路径）</span>
        <input ref={locationRef} type="text" className="mono" defaultValue={asset.location} />
      </label>

      <label className="field">
        <span>项目（可留空）</span>
        {/* 候选列表复用登记表单那一份（datalist 按 id 全局生效），
            不在这里再定义一遍 —— 同一个 id 出现两次是无效的 HTML。 */}
        <input ref={projectRef} type="text" list="asset-projects" defaultValue={asset.project ?? ''} />
      </label>

      <label className="field">
        <span>所在机器（可留空）</span>
        <input ref={hostRef} type="text" defaultValue={asset.host ?? ''} placeholder="留空 = 就是本机" />
      </label>

      <label className="field">
        <span>怎么获取（可留空）</span>
        <input ref={accessNoteRef} type="text" defaultValue={asset.accessNote ?? ''} />
      </label>

      <label className="field">
        <span>备注（可留空）</span>
        <input ref={notesRef} type="text" defaultValue={asset.notes ?? ''} />
      </label>
      <DatasetProfileFields asset={asset} />

      <button type="submit" disabled={saving || disabled}>
        {saving ? '保存中…' : '保存'}
      </button>
      <button type="button" className="link-btn" disabled={saving} onClick={onCancel}>
        取消
      </button>

      {formError !== null && (
        <div className="notice err" style={{ flexBasis: '100%' }}>
          <p className="notice-body" style={{ marginBottom: 0 }}>{formError}</p>
        </div>
      )}
    </form>
  );
}

/**
 * 按项目分组。
 *
 * 【为什么靠"相邻合并"而不是建 Map 再分组】服务端已经按
 * 「项目（未填的排最后）→ 名称」排好序了，相邻合并只是把它画出来，
 * 顺序仍以服务端为准（列表的权威顺序不该有两处定义）。
 * 更要紧的是它的出错方式：万一排序变了、同项目不再相邻，这里会画出
 * **两个同名分组的标题**——一眼就看得见；而 Map 分组会把散开的条目悄悄
 * 并进一组，界面上一切正常，没人会发现顺序契约已经破了。
 */
function groupByProject(
  items: readonly CodeAsset[],
): readonly { project: string | null; items: readonly CodeAsset[] }[] {
  const groups: { project: string | null; items: CodeAsset[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.project === item.project) {
      last.items.push(item);
    } else {
      groups.push({ project: item.project, items: [item] });
    }
  }
  return groups;
}

/** 结果对应的 pill 配色。只有「未找到」是真的出事了，给红色。 */
function tone(result: AssetCheckResult): string {
  if (result === 'exists') return 'ok';
  if (result === 'missing') return 'err';
  if (result === 'unreachable') return 'warn';
  return '';
}

/**
 * 整批核对的提示色。
 *
 * 只有存在「未找到」时才报红。刻意**不**因为"有 N 条无法核对"就报警：
 * 在开发机上那是常态（服务器上的数据本来就看不到），天天报警的结果是
 * 这一行很快被无视，等真有一条丢了反而没人注意。
 */
function summaryTone(summary: Record<AssetCheckResult, number>): string {
  if (summary.missing > 0) return 'err';
  if (summary.unreachable > 0) return 'warn';
  return 'ok';
}

/**
 * 超过多少天没核对，就把"最后核对"的时间标成提示色。
 *
 * 30 天是**显示阈值**，不是业务规则：数据集在外部磁盘上，一个月没人看过
 * 就值得提醒一眼。真正丢没丢由核对结果（存在 / 未找到 / 无法核对）说，
 * 这里只表达"这条结论有多旧"。
 */
const DATASET_STALE_DAYS = 30;

function isStaleCheck(iso: string): boolean {
  const days = localDaysSince(iso);
  return days !== null && days > DATASET_STALE_DAYS;
}

/**
 * 客户端眼里的"看起来像绝对路径"。**只是提前给个提示，不是校验** ——
 * 真正的判据在服务端（`node:path` 的 isAbsolute，按服务端平台判断）。
 * 浏览器里没有 path 模块，也不该有一套自己的判定，否则两边早晚不一致，
 * 而"界面放行、服务端拒绝"这种分叉最难解释。
 */
const LOOKS_ABSOLUTE = /^(\/|\\\\|[A-Za-z]:[\\/])/u;

/** 去空白；空串与未提供都归成 undefined（用来"少传一个字段"）。 */
function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t === undefined || t === '' ? undefined : t;
}

/** 去空白；空串归一成 null（用来"把这个字段清空"）。 */
function trimmedOrNull(value: string | undefined): string | null {
  const t = value?.trim();
  return t === undefined || t === '' ? null : t;
}
