import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { PageTitle } from '../components/PageTitle.tsx';
import { useSearchParams } from 'react-router-dom';
import {
  JOURNAL_SYSTEMS,
  UNVERIFIED_WEB_LABEL,
  isUnverifiedSource,
  rankingSourceLabel,
  type AddRankingResponse,
  type CreateJournalResponse,
  type DeleteRankingResponse,
  type JournalDetail,
  type JournalRanking,
  type JournalSystem,
  type ListJournalsResponse,
  type UpdateJournalResponse,
  type UpdateRankingResponse,
} from '@knowpilot/shared';
import { apiDelete, apiGet, apiPatch, apiPost, isAbort, toApiError, type ApiError } from '../api.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { RequirePermission } from '../components/RequirePermission.tsx';
import { SkeletonLines } from '../components/Skeleton.tsx';
import { useToast } from '../components/Toast.tsx';
import { useAuth } from '../auth.tsx';

/**
 * 期刊分区库。
 *
 * 【它为什么和投稿台账分成两页】台账答的是「我投的这篇稿现在到哪一步了」——
 *   那是**我的**动态记录；这一页答的是「这本刊是几区」——那是**公共的**
 *   静态事实。并成一页的话，用户得在"我关心的稿子"里翻找"一本我没投过的刊"。
 *
 * 【它为什么有写入口】库里那份分区表只覆盖计算机与遥感两个方向（见
 *   `apps/server/src/submissions/seed/`）。别的学科、别的年份、以及第三方
 *   转载里漏掉的那 14 本刊，都得靠用户自己补。所以这一页不只有搜索框 ——
 *   没有表单的话，「支持用户自己添加分区内容」这条需求就落不了地。
 *
 * 【为什么搜索是显式提交】与全文检索同一条理由：中文输入法在拼音阶段会
 *   连续触发 change，边打边搜既浪费请求，也会让结果在候选字还没选定时闪一遍。
 *
 * 【为什么每条分区都要连着年份、维度和来源一起显示】分区每年都变，同一本刊
 *   的**大类分区与遥感小类分区还可能不同**（大类 3 区、小类 4 区真出现过）。
 *   只显示一个「3区」，用户分不清是哪年、哪个维度、从哪来的 —— 三条信息缺一条,
 *   那个数字就没法用来做判断（04 号 §4「分区表硬约束」）。
 */
export function JournalsPage() {
  const newJournalRef = useRef<HTMLDetailsElement>(null);
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  /**
   * `?add=1` = 「我是来补录的」，由投稿台账那行「分区未收录 · 去期刊分区库补录」
   * 带过来。它只影响一件事：把「添加分区」默认展开。
   *
   * 【为什么要一个显式参数，而不是"搜到的刊没有分区就自动展开"】
   *   后者是个猜：用户从别处搜一本库里有分区、但他想**订正**或者补另一个
   *   年份的刊时，同一个动作会被猜错。而意图在跳转的那一刻是**已知**的，
   *   从源头带过来就不必猜。
   */
  const addIntent = params.get('add') === '1';

  // 订正 / 删除已有数据要 `journal.manage`（admin / 导师）。补录（`journal.add`）
  // 不受影响 —— 这一页的权限恰好是**两档**，而它们在界面上原来是同一个样子：
  // 拿不到 manage 的人看得见按钮、点了必然 403。见组件顶部那段说明。
  const { can } = useAuth();
  const canManage = can('journal.manage');

  const [draft, setDraft] = useState(q);
  // URL 里的词变了（含从台账那行「去期刊分区库补录」点进来）就同步到输入框 ——
  // 否则输入框显示的词和下面列表的结果对不上。
  useEffect(() => {
    setDraft(q);
  }, [q]);

  const [data, setData] = useState<ListJournalsResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  /** 增删改之后靠它把列表重新拉一遍。用一个自增数而不是另写一遍 fetch。 */
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        // 空关键词不是"不搜"而是"列出前 N 本"：一进页面就有东西可看，
        // 比一个空白页加一句"请输入关键词"有用得多。
        const path =
          q === ''
            ? '/api/v1/journals?limit=20'
            : `/api/v1/journals?q=${encodeURIComponent(q)}&limit=50`;
        const response = await apiGet<ListJournalsResponse>(path, signal);
        if (signal?.aborted) return;
        setData(response);
        setError(null);
      } catch (err) {
        if (isAbort(err)) return;
        setError(toApiError(err));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [q],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load, version]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = new URLSearchParams(params);
    const keyword = draft.trim();
    if (keyword === '') next.delete('q');
    else next.set('q', keyword);
    // 一次性的意图：用户重新搜过之后，「展开添加表单」就不再是他要的了 ——
    // 留着它会让下一个查询结果里那本刊的表单莫名其妙地自己弹开。
    next.delete('add');
    setParams(next);
  }

  // ── 新建期刊（find-or-create）────────────────────────────────
  const [newBusy, setNewBusy] = useState(false);
  const [newFormError, setNewFormError] = useState<string | null>(null);
  const [newError, setNewError] = useState<ApiError | null>(null);

  /** 「新建收录」的回执走轻提示（S4）：它是"做成了"的一句话，看完就该退场。 */
  const toast = useToast();

  async function onNewJournal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);
    const name = String(fd.get('name') ?? '').trim();
    if (name === '') {
      setNewFormError('刊名不能为空 —— 分区要挂在某一本刊上。');
      return;
    }
    const abbr = String(fd.get('abbr') ?? '').trim();
    const issn = String(fd.get('issn') ?? '').trim();
    const field = String(fd.get('field') ?? '').trim();
    const website = String(fd.get('website') ?? '').trim();

    setNewFormError(null);
    setNewError(null);
    setNewBusy(true);
    try {
      const res = await apiPost<CreateJournalResponse>('/api/v1/journals', {
        name,
        // 空串不发出去：服务端把空串与"未提供"当同一件事，少传一个字段，
        // 契约上就少一种需要解释的输入。
        ...(abbr !== '' ? { abbr } : {}),
        ...(issn !== '' ? { issn } : {}),
        ...(field !== '' ? { field } : {}),
        ...(website !== '' ? { website } : {}),
      });
      // 只留"是新建的还是本来就有"这一句 —— 至于"接着去录分区"，
      // 下面的 ?add=1 已经把表单展开了，不必再用一句会消失的字提醒。
      toast.ok(
        res.created
          ? `已新建「${res.journal.name}」，下面就能给它录分区。`
          : `「${res.journal.name}」本来就在库里（按刊名大小写不敏感匹配），已经定位到它。`,
      );
      form.reset();
      // 把搜索词换成真实刊名：用户刚建的那本立刻出现在列表里 ——
      // 否则他搜的是打错的「Nautre」，建完还是看到"没有命中"。
      const next = new URLSearchParams(params);
      next.set('q', res.journal.name);
      // 刚建完这本刊，下一步一定是给它录分区 —— 顺手把表单展开。
      next.set('add', '1');
      setParams(next);
      reload();
    } catch (err) {
      setNewError(toApiError(err));
    } finally {
      setNewBusy(false);
    }
  }

  const miss = q !== '' && data !== null && data.items.length === 0;

  return (
    <>
      <PageTitle icon="journals">期刊分区库</PageTitle>
      <p className="lead">查询中科院与 JCR 期刊分区，未收录期刊可随时补录。</p>

      <div className="card journal-search-card">
        <form className="form-row journal-search-form" onSubmit={onSubmit}>
          <label className="field" style={{ flex: '1 1 280px' }}>
            <span>查询</span>
            <input
              type="search"
              value={draft}
              placeholder="刊名（支持部分匹配）或 ISSN，例如 remote sensing / 0162-8828"
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <button type="submit" disabled={loading}>
            {loading ? '查询中…' : '查询'}
          </button>
          <button type="button" className="btn-outline" onClick={() => {
            newJournalRef.current?.setAttribute('open', '');
            newJournalRef.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
          }}>新建收录一本</button>
        </form>

        {/* 「新建」摆在查询框下面而不是页尾：用户是在"搜不到"的那一刻需要它的，
            那时他已经翻到底了。没命中时默认展开。
            key 跟着 q 走：换一次查询就重置成默认开合状态，省得用户手动收起来。 */}
        <details className="new-journal" key={q} open={miss} ref={newJournalRef}>
          <summary>库里没有这本刊？新建收录一本</summary>
          <form className="form-row" onSubmit={(e) => void onNewJournal(e)}>
            <label className="field" style={{ flex: '1 1 240px' }}>
              <span>刊名</span>
              <input name="name" type="text" defaultValue={q} placeholder="必填，按刊名大小写不敏感去重" />
            </label>
            <label className="field">
              <span>期刊缩写（可留空）</span>
              <input name="abbr" type="text" placeholder="经人工核对的简称" />
            </label>
            <label className="field">
              <span>ISSN（可留空）</span>
              <input name="issn" type="text" placeholder="如 0162-8828" />
            </label>
            <label className="field">
              <span>领域（可留空）</span>
              <input name="field" type="text" placeholder="如 计算机科学" />
            </label>
            <label className="field" style={{ flex: '1 1 240px' }}>
              <span>期刊网址 / 投稿系统（可留空）</span>
              <input name="website" type="url" placeholder="https://…" />
            </label>
            <button type="submit" disabled={newBusy}>
              {newBusy ? '新建中…' : '新建收录'}
            </button>
          </form>

          {newFormError !== null && (
            <div className="notice err"><p className="notice-body" style={{ margin: 0 }}>{newFormError}</p></div>
          )}
          {newError !== null && <ErrorNotice error={newError} onRetry={() => setNewError(null)} />}
        </details>
      </div>

      {error !== null && <ErrorNotice error={error} onRetry={() => void load()} />}

      {data !== null && (
        <p className="result-count">
          {q === ''
            ? <>按刊名排序列出前 {data.items.length} 本 · 库里共收录 <b>{data.total}</b> 本刊</>
            : data.items.length < data.matched
              ? // 被 limit 截断了就必须说出来 —— 否则用户以为"命中 50 本"就是全部，
                // 从而得出"库里没有那本刊"的结论（其实是排在 51 名往后）。
                <>「{q}」共命中 <b>{data.matched}</b> 本，这里只显示前 {data.items.length} 本 —— 加个更具体的词再查</>
              : <>「{q}」命中 <b>{data.matched}</b> 本 · 库里共收录 {data.total} 本刊</>}
        </p>
      )}

      {miss && (
        <div className="card">
          <p style={{ margin: 0 }}>
            库里没有刊名或 ISSN 含「{q}」的期刊。用上面那个「新建收录一本」把它加进来，
            再展开它的「添加分区」录入分区 —— 分区必须挂在某一本刊上。
          </p>
        </div>
      )}

      {/* 「我做不了」要说清为什么，而不是把按钮藏掉了事 —— 藏掉之后
          "没有权限"与"没有这个功能"在界面上长得一模一样。这一条同时交代
          **我能做什么**（补录），因为那才是这一页对普通成员的主要用途。 */}
      {!canManage && (
        <p className="dim" style={{ fontSize: '0.8125rem', margin: '0 0 12px' }}>
          订正、删除已有的刊与分区需要「期刊管理」权限，请联系管理员。
          补录缺失的刊与分区不受影响 —— 那是这一页对所有人开放的用法。
        </p>
      )}

      {/* 首屏加载原本什么都不显示（列表区一片空白），比"一行灰字"更看不出在做什么。
          骨架按真实结构摆：每条是一张 `.card journal-item`，与 JournalCard 同形。 */}
      {data === null && error === null && (
        <ul className="journal-list">
          {[0, 1, 2].map((i) => (
            <li className="card journal-item" key={i}>
              <SkeletonLines rows={2} />
            </li>
          ))}
        </ul>
      )}

      {data !== null && data.items.length > 0 && (
        <ul className="journal-list">
          {data.items.map((j) => (
            <JournalCard key={j.id} journal={j} openAdd={addIntent} onChanged={reload} />
          ))}
        </ul>
      )}

      <p className="dim" style={{ fontSize: '0.75rem', margin: '14px 0 0' }}>
        内置数据来自第三方转载的《中科院分区表升级版 2025》与 JCR 2025，原表在{' '}
        <a
          className="side-link"
          style={{ marginLeft: 0 }}
          href="https://github.com/hitfyd/ShowJCR"
          target="_blank"
          rel="noopener noreferrer"
        >
          github.com/hitfyd/ShowJCR ↗
        </a>
        。中科院分区表是订阅制产品，这里是按用户要求落地的一份本地副本，
        导入的数据标为「官方分区表」，你手工录入的标为「人工录入」——
        <b>两者都算有据可查</b>，标出来的意思是让你知道该找谁订正。
      </p>
    </>
  );
}

/**
 * 一本刊：刊名 + 它全部的分区 + 一个「添加分区」表单。
 *
 * 每个分区行上只有「人工录入」的那些带删除按钮。导入的那份靠重新导入订正、
 * 联网抓的靠重新抓 —— 放开删除的话，这个按钮会变成"把权威数据删掉"。
 */
function JournalCard({
  journal,
  openAdd,
  onChanged,
}: {
  journal: JournalDetail;
  /** 「添加分区」默认展开。带 `?add=1` 进来时（从台账那行「去补录」点的）为真。 */
  openAdd: boolean;
  onChanged: () => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<ApiError | null>(null);

  /** 订正 / 删除 / 添加分区的一次性回执走轻提示（S4），不再占卡片里的一条常驻通告。 */
  const toast = useToast();

  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [addError, setAddError] = useState<ApiError | null>(null);

  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<ApiError | null>(null);

  /** 正在订正哪一条人工分区（行 id）。null = 没有在改。 */
  const [editingId, setEditingId] = useState<string | null>(null);

  /**
   * 订正人工分区。
   *
   * 【为什么整条替换而不是按字段打补丁】分区一共就四个字段，表单里全都有。
   *   逐字段合并要回答"这个空框是清空还是没动"，而分区没有哪个字段是
   *   "留住原值"有意义的（备注留空就是没备注）。
   */
  async function onEditRanking(ranking: JournalRanking, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);

    const year = Number(String(fd.get('year') ?? '').trim());
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      setFormError('年份要填 1900–2100 之间的整数。');
      return;
    }
    const rank = String(fd.get('rank') ?? '').trim();
    if (rank === '') {
      setFormError('分区档位不能为空，例如「1区」「Q1」。');
      return;
    }
    const system = String(fd.get('system') ?? '');
    if (!isJournalSystem(system)) {
      setFormError('分区体系只能是「中科院」或「JCR」。');
      return;
    }

    setFormError(null);
    setRowError(null);
    setBusyId(ranking.id);
    try {
      const res = await apiPatch<UpdateRankingResponse>(
        `/api/v1/journals/${encodeURIComponent(journal.id)}/rankings/${encodeURIComponent(ranking.id)}`,
        {
          year,
          system,
          rank,
          category: String(fd.get('category') ?? '').trim(),
          top: fd.get('top') !== null,
          note: String(fd.get('note') ?? '').trim(),
          sourceUrl: String(fd.get('sourceUrl') ?? '').trim(),
        },
      );
      setEditingId(null);
      toast.ok(`已订正：${res.ranking.system} ${res.ranking.year} 年 ${res.ranking.rank}。`);
      onChanged();
    } catch (err) {
      setRowError(toApiError(err));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * 订正这本刊的 ISSN / 领域。
   *
   * 刊名**不在可改之列** —— 它是这本刊的唯一标识，分区挂在 id 上；
   * 改名是"换了一本刊"，该是一次显式的迁移而不是一个顺手改掉的文本框。
   */
  async function onEditJournal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    setEditBusy(true);
    setEditError(null);
    try {
      const res = await apiPatch<UpdateJournalResponse>(
        `/api/v1/journals/${encodeURIComponent(journal.id)}`,
        {
          // 空串 = 清空该项（契约里的三态：缺省=不动、有值=改、空串=清空）。
          abbr: String(fd.get('abbr') ?? '').trim(),
          issn: String(fd.get('issn') ?? '').trim(),
          field: String(fd.get('field') ?? '').trim(),
          website: String(fd.get('website') ?? '').trim(),
        },
      );
      toast.ok(`已订正「${res.journal.name}」的 ISSN / 领域。`);
      onChanged();
    } catch (err) {
      setEditError(toApiError(err));
    } finally {
      setEditBusy(false);
    }
  }

  async function onDelete(ranking: JournalRanking) {
    setBusyId(ranking.id);
    setRowError(null);
    try {
      await apiDelete<DeleteRankingResponse>(
        `/api/v1/journals/${encodeURIComponent(journal.id)}/rankings/${encodeURIComponent(ranking.id)}`,
      );
      setConfirmId(null);
      toast.ok(`已删除这条人工录入的分区（${ranking.year} 年 ${ranking.system} ${ranking.rank}）。`);
      onChanged();
    } catch (err) {
      setRowError(toApiError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);

    const year = Number(String(fd.get('year') ?? '').trim());
    // 前端也拦一道：服务端同样会拒，但让用户为一次必然失败的请求等一个往返，
    // 不如当场说清（理由同台账页的时间校验）。
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      setFormError('年份要填 1900–2100 之间的整数。');
      return;
    }
    const rank = String(fd.get('rank') ?? '').trim();
    if (rank === '') {
      setFormError('分区档位不能为空，例如「1区」「Q1」。');
      return;
    }
    const system = String(fd.get('system') ?? '');
    if (!isJournalSystem(system)) {
      setFormError('分区体系只能是「中科院」或「JCR」。');
      return;
    }
    const category = String(fd.get('category') ?? '').trim();
    const note = String(fd.get('note') ?? '').trim();
    const sourceUrl = String(fd.get('sourceUrl') ?? '').trim();
    // checkbox 不勾时 FormData 里根本没有这个键，勾了是 "on"。
    const top = fd.get('top') !== null;

    setFormError(null);
    setAddError(null);
    setAdding(true);
    try {
      await apiPost<AddRankingResponse>(
        `/api/v1/journals/${encodeURIComponent(journal.id)}/rankings`,
        {
          year,
          system,
          rank,
          ...(category !== '' ? { category } : {}),
          top,
          ...(note !== '' ? { note } : {}),
          ...(sourceUrl !== '' ? { sourceUrl } : {}),
        },
      );
      form.reset();
      toast.ok(`已添加：${system} ${year} 年${category === '' ? '' : `（${category}）`} ${rank}。`);
      onChanged();
    } catch (err) {
      setAddError(toApiError(err));
    } finally {
      setAdding(false);
    }
  }

  /**
   * 有导入的中科院分区但没有 JCR 分区，说明本次导入未匹配到 JCR。
   */
  const jcrMissing =
    journal.rankings.some((r) => r.source === 'official' && r.system === '中科院') &&
    !journal.rankings.some((r) => r.system === 'JCR');

  return (
    <li className="card journal-item">
      <span className="journal-cover" aria-hidden="true">{journal.name.slice(0, 1)}</span>
      <div className="journal-content">
      <p className="journal-head">
        <span className="journal-name">{journal.name}</span>
        {journal.abbr !== null && journal.abbr !== '' && (
          <span className="dim">（{journal.abbr}）</span>
        )}
        {journal.issn !== null && journal.issn !== '' && (
          <span className="dim mono journal-issn">{journal.issn}</span>
        )}
        {journal.website !== null &&
          journal.website !== '' &&
          /^https?:\/\//u.test(journal.website) && (
          <a
            className="dim"
            href={journal.website}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: '0.75rem' }}
          >
            期刊网址
          </a>
        )}
        {journal.field !== null && journal.field !== '' && (
          <span className="pill">{journal.field}</span>
        )}
        {jcrMissing && (
          <span
            className="sub-unverified"
            title="内置的那份 JCR 表里没有这本刊（按 ISSN 没能匹配到）。不是漏导，是原表就缺。"
          >
            JCR 未匹配
          </span>
        )}
      </p>

      {/* 订正 ISSN / 领域。`key` 跟着已保存的值走 —— 保存后 props 一变就重挂，
          输入框的 defaultValue 才会拿到新值（非受控输入只在挂载时读一次）。
          整块闸在 `journal.manage` 后面：它 PATCH 的是**所有人共用的**那条刊记录，
          服务端也只给 admin / 导师。 */}
      <RequirePermission permission="journal.manage">
        <details
          className="edit-journal"
          key={`${journal.abbr ?? ''}/${journal.issn ?? ''}/${journal.field ?? ''}/${journal.website ?? ''}`}
        >
          <summary>订正缩写 / ISSN / 领域 / 网址</summary>
          <form className="form-row" onSubmit={(e) => void onEditJournal(e)}>
            <label className="field">
              <span>期刊缩写</span>
              <input name="abbr" type="text" defaultValue={journal.abbr ?? ''} placeholder="经人工核对的简称" />
            </label>
            <label className="field">
              <span>ISSN</span>
              <input name="issn" type="text" defaultValue={journal.issn ?? ''} placeholder="如 0162-8828" />
            </label>
            <label className="field">
              <span>领域</span>
              <input name="field" type="text" defaultValue={journal.field ?? ''} placeholder="如 计算机科学" />
            </label>
            <label className="field" style={{ flex: '1 1 240px' }}>
              <span>期刊网址 / 投稿系统</span>
              <input name="website" type="url" defaultValue={journal.website ?? ''} placeholder="https://…" />
            </label>
            <button type="submit" disabled={editBusy}>
              {editBusy ? '保存中…' : '保存'}
            </button>
          </form>
          <p className="dim" style={{ fontSize: '0.75rem', margin: '8px 0 0' }}>
            留空并保存 = 清掉这一项。刊名不能在改 —— 它是这本刊的标识，分区都挂在它下面。
          </p>
          {editError !== null && <ErrorNotice error={editError} onRetry={() => setEditError(null)} />}
        </details>
      </RequirePermission>

      {journal.rankings.length === 0 ? (
        // 这一块在**展开的刊行内部**，宽度只有主区的一小段 —— 用 compact
        //（小图标 + 紧行距），按主区尺寸画一个大图标会把这一行撑得又高又空。
        <EmptyState icon="journals" compact>
          这本刊还没有分区记录 —— 展开下面的「添加分区」补一条。
        </EmptyState>
      ) : (
        <ul className="rank-list">
          {journal.rankings.map((r) => (
            <li className="rank-row" key={r.id}>
              {editingId === r.id ? (
                /* 订正这一条。字段顺序与「添加分区」保持一致 —— 用户刚在那张表里
                   填过一遍，两边长得一样才不用重新找。 */
                <form className="form-row rank-edit-form" onSubmit={(e) => void onEditRanking(r, e)}>
                  <label className="field">
                    <span>年份</span>
                    <input name="year" type="number" min={1900} max={2100} defaultValue={r.year} />
                  </label>
                  <label className="field">
                    <span>体系</span>
                    <select name="system" defaultValue={r.system}>
                      {JOURNAL_SYSTEMS.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field" style={{ flex: '1 1 180px' }}>
                    <span>维度（可留空）</span>
                    <input name="category" type="text" defaultValue={r.category} placeholder="如 计算机科学 / 遥感" />
                  </label>
                  <label className="field">
                    <span>分区</span>
                    <input name="rank" type="text" defaultValue={r.rank} placeholder="1区 / Q1" />
                  </label>
                  <label className="field" style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                    <input name="top" type="checkbox" defaultChecked={r.top} />
                    <span>Top 期刊</span>
                  </label>
                  <label className="field" style={{ flex: '1 1 160px' }}>
                    <span>备注（可留空）</span>
                    <input name="note" type="text" defaultValue={r.note ?? ''} placeholder="排名 4/758 或 IF 20.4" />
                  </label>
                  <label className="field" style={{ flex: '1 1 180px' }}>
                    <span>来源链接（可留空）</span>
                    <input name="sourceUrl" type="url" defaultValue={r.sourceUrl ?? ''} placeholder="https://" />
                  </label>
                  <button type="submit" disabled={busyId === r.id}>
                    {busyId === r.id ? '保存中…' : '保存'}
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    disabled={busyId === r.id}
                    onClick={() => {
                      setEditingId(null);
                      setFormError(null);
                      setRowError(null);
                    }}
                  >
                    取消
                  </button>
                </form>
              ) : (
                <>
              <span className="rank-sys">{r.system}</span>
              <span className="rank-year">{r.year} 年</span>
              {/* 维度必须显示：同一本刊的大类与小类分区可能不同档，
                  不写维度时两条记录看起来会像互相矛盾。 */}
              {r.category !== '' && <span className="pill">{r.category}</span>}
              <span className="rank-tier">{r.rank}</span>
              {r.top && <span className="sub-top">Top</span>}
              {r.note !== null && r.note !== '' && <span className="rank-note">{r.note}</span>}
              <span className="rank-source">
                {rankingSourceLabel(r.source)}
                {/* 「未经核对」看来源、不看 verified：官方分区表导进来的那条
                    verified 也是 0（没人逐条核过），但它本身就是权威数据源。 */}
                {isUnverifiedSource(r.source) && (
                  <span className="sub-unverified" title={UNVERIFIED_WEB_LABEL}>
                    {' '}· 未经核对
                  </span>
                )}
              </span>

              {r.source === 'manual' && (
                <RequirePermission permission="journal.manage">
                  <span className="rank-actions">
                  {confirmId === r.id ? (
                    <>
                      <button
                        type="button"
                        className="danger"
                        disabled={busyId === r.id}
                        onClick={() => void onDelete(r)}
                      >
                        {busyId === r.id ? '删除中…' : '确定删除'}
                      </button>
                      <button
                        type="button"
                        className="link-btn"
                        disabled={busyId === r.id}
                        onClick={() => setConfirmId(null)}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      {/* 订正与删除并排。先「编辑」后「删除」：打错字是常见的、
                          删掉整条是少见的，把常见的放前面，别让人在误点一次
                          才看清哪个是破坏性的。 */}
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => {
                          setEditingId(r.id);
                          setConfirmId(null);
                          setFormError(null);
                          setRowError(null);
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => {
                          setConfirmId(r.id);
                          setEditingId(null);
                          setRowError(null);
                        }}
                      >
                        删除
                      </button>
                    </>
                  )}
                  </span>
                </RequirePermission>
              )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {rowError !== null && <ErrorNotice error={rowError} onRetry={() => setRowError(null)} />}

      {/* open 只在"值是那样"的时候由 React 设定；用户在页面上手动开合之后
          再重渲染，值没变所以 React 不会去覆盖它 —— 手动开合能留住。 */}
      <details className="add-rank" open={openAdd}>
        <summary>添加分区</summary>
        <form className="form-row" onSubmit={(e) => void onAdd(e)}>
          <label className="field">
            <span>年份</span>
            {/* 默认今年：绝大多数补录都是补当下的这一版分区表。 */}
            <input name="year" type="number" min={1900} max={2100} defaultValue={new Date().getFullYear()} />
          </label>

          <label className="field">
            <span>体系</span>
            <select name="system" defaultValue={JOURNAL_SYSTEMS[0]}>
              {JOURNAL_SYSTEMS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>

          <label className="field" style={{ flex: '1 1 200px' }}>
            <span>维度（可留空）</span>
            <input name="category" type="text" placeholder="中科院填学科名，如 计算机科学 / 遥感" />
          </label>

          <label className="field">
            <span>分区</span>
            <input name="rank" type="text" placeholder="1区 / Q1" />
          </label>

          {/* 勾选框与文字同行的写法跟投稿确认那几处一致（AskPage / DocumentsPage）。 */}
          <label className="field" style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            <input name="top" type="checkbox" />
            <span>Top 期刊</span>
          </label>

          <label className="field" style={{ flex: '1 1 180px' }}>
            <span>备注（可留空）</span>
            <input name="note" type="text" placeholder="排名 4/758 或 IF 20.4" />
          </label>

          <label className="field" style={{ flex: '1 1 200px' }}>
            <span>来源链接（可留空）</span>
            <input name="sourceUrl" type="url" placeholder="https://" />
          </label>

          <button type="submit" disabled={adding}>
            {adding ? '添加中…' : '添加'}
          </button>
        </form>

        <p className="dim" style={{ fontSize: '0.75rem', margin: '8px 0 0' }}>
          录入的分区标为「人工录入」，与内置分区表区分开。同一个「年份 + 体系 + 维度」
          再录一次会覆盖上一条 —— 订正就是照着重录。
        </p>

        {formError !== null && (
          <div className="notice err"><p className="notice-body" style={{ margin: 0 }}>{formError}</p></div>
        )}
        {addError !== null && <ErrorNotice error={addError} onRetry={() => setAddError(null)} />}
      </details>
      </div>
    </li>
  );
}

function isJournalSystem(raw: string): raw is JournalSystem {
  return (JOURNAL_SYSTEMS as readonly string[]).includes(raw);
}
