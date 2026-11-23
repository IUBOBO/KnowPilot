import { useCallback, useEffect, useState } from 'react';
import { PageTitle } from '../components/PageTitle.tsx';
import { Link } from 'react-router-dom';
import {
  MATERIAL_LABELS,
  type AdminActivityItem,
  type AdminDocStats,
  type AdminOverviewResponse,
  type AdminUserStats,
  type Permission,
} from '@knowpilot/shared';
import { apiGet, isAbort, toApiError, type ApiError } from '../api.ts';
import { roleLabel } from '../auth.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SkeletonLines, SkeletonList } from '../components/Skeleton.tsx';
import { SystemHealth } from '../components/SystemHealth.tsx';
import { fmtDateTime } from '../format.ts';
import { OUTCOME_LABELS, outcomeTone } from '../outcome.ts';

/**
 * 管理概览。这一页面向"**持有任意一项管理能力的人**"，不是一个具体岗位。
 *
 * 【为什么每块自己判空，而不是整页一起 403】
 *   用户与角色要 `users.manage`、最近问答要 `askRecord.read.all`、文档统计
 *   要 `knowledge.read` —— 三块的敏感度不同，而能打开这一页的人是四类人的并集
 *   （`ADMIN_ENTRY_PERMISSIONS`）。所以服务端按块授权、看不到的块发 `null`，
 *   这里就只判空。**前端不再自己判一遍权限**：同一规则两份实现迟早不一致
 *   （4B 踩过：侧栏与守卫各判一次，结果菜单里看得见、点进去 403）。
 *
 * 【为什么看不到时要明说是"没权限"】"没有数据"和"没权限看"在界面上都是空，
 *   而它们对用户的意义完全不同 —— 前者要去录数据，后者要去找管理员要权限。
 *   把空着的地方留白，人会以为是系统坏了。
 */
export function AdminHomePage() {
  return (
    <>
      <PageTitle icon="admin">管理概览</PageTitle>
      {/* 原导语在解释"为什么看不到的块显示成锁而不是空" —— 那是实现说明。
          真发生的时候，`LockedCard` 自己会点名缺哪个权限点，比这里预解释一遍有用。 */}
      <p className="lead">系统账号、知识库索引与近期问答运行总览。</p>

      <AdminStats />
      <SystemHealth />
    </>
  );
}

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; data: AdminOverviewResponse }
  | { kind: 'error'; error: ApiError };

function AdminStats() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ kind: 'loading' });
    try {
      const data = await apiGet<AdminOverviewResponse>('/api/v1/admin/overview', signal);
      setState({ kind: 'ok', data });
    } catch (err) {
      if (isAbort(err)) return;
      setState({ kind: 'error', error: toApiError(err) });
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  if (state.kind === 'loading') {
    // 三张卡的形状（两行文字 / 两行文字 / 一个列表）按 UsersCard、DocsCard、
    // RecentAsksCard 的真实结构给 —— 概览页的骨架如果画成一张大卡，
    // 内容到达时整页要重排一次，而这一页的要求正是"一屏能看完"。
    return (
      <>
        <div className="admin-overview-grid">
          <div className="card">
            <h2>用户与角色</h2>
            <SkeletonLines rows={2} />
          </div>
          <div className="card">
            <h2>文档与索引</h2>
            <SkeletonLines rows={2} />
          </div>
        </div>
        <div className="card">
          <h2>最近问答</h2>
          <SkeletonList rows={4} />
        </div>
      </>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="card">
        <ErrorNotice error={state.error} onRetry={() => void load()} />
      </div>
    );
  }

  const { users, documents, recentAsks, generatedAt } = state.data;

  return (
    <>
      <div className="admin-overview-grid">
        <UsersCard stats={users} />
        <DocsCard stats={documents} />
      </div>
      <RecentAsksCard items={recentAsks} />

      {/* 时点必须写出来：没有时点的统计数字，没法判断它说的是"刚才"还是"昨天"。 */}
      <p className="dim" style={{ fontSize: '0.75rem' }}>
        这些数字生成于 {fmtDateTime(generatedAt)}（每次打开这一页都重新统计，不是缓存）。
      </p>
    </>
  );
}

/** 没权限的那一块。明说原因，别让人以为系统坏了。 */
function LockedCard({ title, permission }: { title: string; permission: Permission }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <p className="dim" style={{ margin: 0 }}>
        你的角色看不到这一块：需要权限点 <code className="mono">{permission}</code>。
        服务端没有把它发下来 —— 不是显示出了问题。权限由管理员在「用户与权限」里调整。
      </p>
    </div>
  );
}

function UsersCard({ stats }: { stats: AdminUserStats | null }) {
  if (stats === null) return <LockedCard title="用户与角色" permission="users.manage" />;

  return (
    <div className="card">
      <h2>
        用户与角色
        <span className="card-actions">
          <Link className="link-btn" to="/admin/users">用户与权限</Link>
        </span>
      </h2>

      {stats.total === 0 ? (
        <EmptyState
          icon="users"
          action={<Link className="link-btn" to="/admin/users">去建第一个账号</Link>}
        >
          还没有任何账号。第一个管理员来自 <code className="mono">.env</code> 里的
          KNOWPILOT_ADMIN_USER / KNOWPILOT_ADMIN_PASSWORD，只在库为空时创建一次。
        </EmptyState>
      ) : (
        <>
          {/* KPI 网格（「界面整理-new」§六.5）：原先是一句流水账
              「共 5 个账号：启用 5、禁用 0。」—— 数字要在一串汉字里找。
              抽成三格之后一眼可读，等宽数字（tabular-nums）对齐。 */}
          <div className="stat-grid">
            <div className="stat-cell">
              <div className="stat-label">账号总数</div>
              <div className="stat-value">
                {stats.total}
                <span className="stat-unit">个</span>
              </div>
            </div>
            <div className="stat-cell">
              <div className="stat-label">启用</div>
              <div className="stat-value">
                {stats.active}
                <span className="stat-unit">个</span>
              </div>
            </div>
            <div className="stat-cell">
              <div className="stat-label">禁用</div>
              <div className="stat-value" style={stats.disabled > 0 ? undefined : { color: 'var(--ink-4)' }}>
                {stats.disabled}
                <span className="stat-unit">个</span>
              </div>
            </div>
          </div>
          <p style={{ margin: '12px 0 0' }}>
            {stats.byRole.map((r) => (
              <span key={r.role} className="pill" style={{ marginRight: 8 }}>
                {roleLabel(r.role)} {r.count}
              </span>
            ))}
          </p>
        </>
      )}
    </div>
  );
}

function DocsCard({ stats }: { stats: AdminDocStats | null }) {
  if (stats === null) return <LockedCard title="文档与索引" permission="knowledge.read" />;

  return (
    <div className="card">
      <h2>
        文档与索引
        <span className="card-actions">
          <Link className="link-btn" to="/docs">材料列表</Link>
        </span>
      </h2>

      {stats.total === 0 ? (
        <EmptyState
          icon="docs"
          action={<Link className="link-btn" to="/docs">去知识库上传</Link>}
        >
          知识库里还没有材料。传上来的 PDF、DOCX、MD 或 TXT 会被切块、算出向量，
          之后知识问答才有资料可查。
        </EmptyState>
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat-cell">
              <div className="stat-label">材料</div>
              <div className="stat-value">
                {stats.total}
                <span className="stat-unit">份</span>
              </div>
            </div>
            <div className="stat-cell">
              <div className="stat-label">可检索块</div>
              <div className="stat-value">
                {stats.chunks}
                <span className="stat-unit">块</span>
              </div>
            </div>
            <div className="stat-cell">
              <div className="stat-label">已算向量</div>
              <div className="stat-value">
                {stats.embedded}
                <span className="stat-unit">块</span>
              </div>
            </div>
          </div>
          <p className="dim" style={{ margin: '12px 0 0' }}>
            {stats.byMaterial
              .map((m) => `${MATERIAL_LABELS[m.material]} ${m.count}`)
              .join(' · ')}
          </p>
        </>
      )}

      {/* 欠账只在"真有欠账"时出现。为 0 时显示一条绿的反而会稀释掉真正要看的信号。 */}
      {stats.missingEmbeddings > 0 && (
        <div className="notice warn" style={{ marginTop: 12 }}>
          <p className="notice-title">有 {stats.missingEmbeddings} 块没有向量</p>
          <p style={{ marginBottom: 0 }}>
            这些块只有关键词检索能命中，语义检索会漏掉它们。到
            <Link to="/docs">材料列表</Link>里对相关文档「重建索引」补上。
          </p>
        </div>
      )}
    </div>
  );
}

function RecentAsksCard({ items }: { items: readonly AdminActivityItem[] | null }) {
  if (items === null) return <LockedCard title="最近问答" permission="askRecord.read.all" />;

  return (
    <div className="card">
      <h2>
        最近问答
        <span className="card-actions">
          <Link className="link-btn" to="/asks">全部记录</Link>
        </span>
      </h2>

      {items.length === 0 ? (
        <EmptyState
          icon="history"
          action={<Link className="link-btn" to="/ask">去提一个问题</Link>}
        >
          还没有任何问答记录。全库只要有人问过一次，这条时间线上就会出现它的
          结果、用时与被引用的条数。
        </EmptyState>
      ) : (
        // 用首页那种两行一条的紧凑列表，而不是「问答记录」页那种三行的卡片：
        // 这一页是**概览**，五条大卡片会把下面的「系统状态」挤到一屏之外，
        // 而概览的第一要求是"一屏能看完"。要细节有 /asks 那一页。
        <ul className="sub-list">
          {items.map((a) => (
            <li key={a.runId} className="sub-item">
              <p className="sub-meta" style={{ margin: '0 0 4px' }}>
                <span className={`pill ${outcomeTone(a.outcome)}`}>{OUTCOME_LABELS[a.outcome]}</span>
                {' · '}
                {fmtDateTime(a.askedAt)}
                {' · '}
                {/* 「没有归属」不等于「匿名」：阶段 1–3 根本没有登录这回事，
                    那时产生的记录不属于任何人。这两件事在界面上不能混成一句。 */}
                {a.asker !== null ? a.asker : <span className="dim">无归属（阶段 1–3 的历史记录）</span>}
              </p>
              <span className="sub-title">{a.question}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
