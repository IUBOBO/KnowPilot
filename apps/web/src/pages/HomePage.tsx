import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MATERIAL_LABELS,
  type AskRecord,
  type DocumentSummary,
  type MeKnowledgeSummary,
  type MeOverviewResponse,
  type MePendingSummary,
} from '@knowpilot/shared';
import { apiGet, isAbort, toApiError, type ApiError } from '../api.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SkeletonList } from '../components/Skeleton.tsx';
import { SystemHealth } from '../components/SystemHealth.tsx';
import { fmtDate, fmtDateTime, fmtDuration } from '../format.ts';

/**
 * 首页 = 今日工作台（O14）。
 *
 * 【三块回答三个不同的问题】
 *   · 待我处理：现在有没有事要我做？—— 超期投稿、待确认草案、未完成上传。
 *   · 最近问答：我刚才问过什么？—— 严格 `user_id = 我`。
 *   · 知识库概况：这个库现在有多少东西？—— 全库共享的统计。
 *
 * 【为什么不把三份列表都平铺出来】旧首页是"最近提交记录 + 我的动态"，
 *   一屏里塞的都是"我做过什么"，但真正需要动作的事情反而要点进各自的页面才看得到。
 *   工作台先回答"有没有事"，点进去才看是哪几件。
 *
 * 【为什么走一个专用接口】现成的列表回答的是"我能看到什么"——文档是全库共享的、
 *   投稿台账按可见范围过滤、问答记录对导师是全部。把它们拼起来当"我的"，
 *   会把公共历史数据算进某一个名字下面。概览问的是"我做过什么"，
 *   严格按 `user_id = 我`，两个问题不能共用一个查询。
 *
 * 【为什么不缓存】单实验室量级、几条 LIMIT 5 的查询是瞬时的；
 *   缓存只是引入"什么时候该失效"这个新问题。
 */
export function HomePage() {
  return (
    <>
      <div className="home-intro">
        <span className="home-intro-mark" aria-hidden="true">✳</span>
        <div>
          <h1>今天的工作台</h1>
          <p className="lead">从问题到知识，从阅读到写作，查看今天需要处理的事。</p>
        </div>
      </div>

      <MyOverview />
      <SystemHealth />
    </>
  );
}

type OverviewState =
  | { kind: 'loading' }
  | { kind: 'ok'; data: MeOverviewResponse }
  | { kind: 'error'; error: ApiError };

function MyOverview() {
  const [state, setState] = useState<OverviewState>({ kind: 'loading' });

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiGet<MeOverviewResponse>('/api/v1/me/overview', signal);
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
    // 骨架照着**最终页面的样子**搭：三张卡，标题照常显示，只把数据区换成骨架。
    // 标题来自常量、不来自接口，加载期间显示它不但不撒谎，还能让整页高度
    // 一次到位 —— 内容到达时只有数据区在换，页面不会往下撑一截。
    return (
      <div className="home-overview">
        <div className="card home-workbench">
          <h2>待我处理</h2>
          <SkeletonList rows={3} />
        </div>
        <div className="card home-recent-asks">
          <h2>最近问答</h2>
          <SkeletonList rows={3} />
        </div>
        <div className="card home-knowledge">
          <h2>知识库概况</h2>
          <SkeletonList rows={3} />
        </div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="card">
        <ErrorNotice error={state.error} onRetry={() => void load()} />
      </div>
    );
  }

  const { documents, askRecords, pending, knowledge } = state.data;

  return (
    <div className="home-overview">
      <WorkbenchCard pending={pending} />
      <RecentAsksCard records={askRecords} />
      <KnowledgeCard documents={documents} knowledge={knowledge} />
    </div>
  );
}

function WorkbenchCard({ pending }: { pending: MePendingSummary }) {
  const items = [
    {
      key: 'overdue',
      label: '超期投稿',
      hint: '超过各自阈值、还没处理的稿件',
      count: pending.overdueSubmissions,
      unit: '篇',
      to: '/submissions?filter=overdue',
    },
    {
      key: 'knowledge',
      label: '待确认的知识草案',
      hint: '你提交、还没确认入库的条目',
      count: pending.proposedKnowledge,
      unit: '条',
      to: '/knowledge',
    },
    {
      key: 'upload',
      label: '未完成的上传',
      hint: '还没传完的数据集文件',
      count: pending.unfinishedUploads,
      unit: '个',
      to: '/datasets/upload',
    },
  ] as const;

  // 只有"三项都拿得到且都是 0"才能说"今天没有需要处理的事"。
  // 有拿不到的那一项时继续列行、写「无权查看」——"没有事"与"不许看"不能混成一句。
  const allClear = items.every((item) => item.count === 0);

  return (
    <div className="card home-workbench">
      <h2>待我处理</h2>
      {allClear ? (
        <EmptyState icon="home" illustration="all-clear">
          今天没有需要处理的事。新的超期、草案与未完成上传会出现在这里。
        </EmptyState>
      ) : (
        <ul className="workbench-list">
          {items.map((item) => {
            const main = (
              <span className="workbench-main">
                <span className="workbench-label">{item.label}</span>
                <span className="workbench-hint">{item.hint}</span>
              </span>
            );
            const tail =
              item.count === null ? (
                <span className="workbench-none">无权查看</span>
              ) : item.count === 0 ? (
                <span className="workbench-none">0 {item.unit}</span>
              ) : (
                <span className="workbench-count">
                  {item.count}
                  <span className="unit">{item.unit}</span>
                </span>
              );
            return (
              <li key={item.key}>
                {item.count !== null && item.count > 0 ? (
                  <Link className="workbench-item" to={item.to}>
                    {main}
                    {tail}
                  </Link>
                ) : (
                  <div className="workbench-item">
                    {main}
                    {tail}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RecentAsksCard({ records }: { records: readonly AskRecord[] }) {
  return (
    <div className="card home-recent-asks">
      <h2>
        最近问答
        <span className="card-actions">
          <Link className="link-btn" to="/asks">问答记录</Link>
        </span>
      </h2>
      {records.length === 0 ? (
        <EmptyState
          icon="ask"
          action={<Link className="link-btn" to="/ask">去提第一个问题</Link>}
        >
          你还没有提过问题。在「知识问答」里就着库里的材料问一句，
          回答会带着引用与出处。
        </EmptyState>
      ) : (
        <ul className="sub-list">
          {records.map((r) => (
            <li key={r.runId} className="sub-item">
              <AskLine record={r} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function KnowledgeCard({
  documents,
  knowledge,
}: {
  documents: readonly DocumentSummary[];
  knowledge: MeKnowledgeSummary | null;
}) {
  const coverage =
    knowledge === null || knowledge.chunks === 0
      ? null
      : Math.round((knowledge.embedded / knowledge.chunks) * 100);

  return (
    <div className="card home-knowledge">
      <h2>
        知识库概况
        <span className="card-actions">
          <Link className="link-btn" to="/docs">知识库</Link>
        </span>
      </h2>

      {knowledge === null ? (
        <p className="dim" style={{ margin: 0 }}>
          当前账号没有查看知识库的权限。
        </p>
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat-cell">
              <div className="stat-label">材料</div>
              <div className="stat-value">
                {knowledge.documents}
                <span className="stat-unit">份</span>
              </div>
            </div>
            <div className="stat-cell">
              <div className="stat-label">可检索块</div>
              <div className="stat-value">
                {knowledge.chunks}
                <span className="stat-unit">块</span>
              </div>
            </div>
            <div className="stat-cell">
              <div className="stat-label">向量覆盖</div>
              <div className="stat-value">
                {coverage ?? 0}
                <span className="stat-unit">%</span>
              </div>
            </div>
          </div>
          {knowledge.chunks > knowledge.embedded && (
            <p className="dim" style={{ margin: '8px 0 0', fontSize: '0.75rem' }}>
              还有 {knowledge.chunks - knowledge.embedded} 个块没有算出向量，语义检索会缺这一部分。
            </p>
          )}
        </>
      )}

      <h3 className="home-sub">我最近上传</h3>
      {documents.length === 0 ? (
        <EmptyState
          icon="docs"
          action={<Link className="link-btn" to="/docs">去知识库上传</Link>}
        >
          你还没有上传过资料。上传入口在「知识库」页的「上传文档」里。
        </EmptyState>
      ) : (
        <ul className="sub-list">
          {documents.map((doc) => (
            <li key={doc.id} className="sub-item">
              <DocLine doc={doc} />
            </li>
          ))}
        </ul>
      )}

      <p className="dim" style={{ fontSize: '0.75rem', margin: '14px 0 0' }}>
        概况统计的是<b>全库共享</b>的知识库；「我最近上传」只列你自己的资料。
      </p>
    </div>
  );
}

function DocLine({ doc }: { doc: DocumentSummary }) {
  const meta = (
    <>
      <span className="rail-material">{MATERIAL_LABELS[doc.material]}</span>
      {' · '}
      {fmtDate(doc.createdAt)}
      {doc.chunkCount === 0 && <span className="sub-unverified"> · 没有可检索的内容</span>}
    </>
  );

  // 首个块 id 为空 = 解析没产出内容（扫描件之类）。做成不可点而不是跳空页面。
  if (doc.firstChunkId === null) {
    return (
      <>
        <p className="sub-meta" style={{ margin: '0 0 4px' }}>{meta}</p>
        <span className="sub-title">{doc.title}</span>
      </>
    );
  }
  return (
    <>
      <p className="sub-meta" style={{ margin: '0 0 4px' }}>{meta}</p>
      <Link className="sub-title" to={`/chunk/${doc.firstChunkId}`}>{doc.title}</Link>
    </>
  );
}

function AskLine({ record }: { record: AskRecord }) {
  return (
    <>
      <p className="sub-meta" style={{ margin: '0 0 4px' }}>
        {fmtDateTime(record.askedAt)} · {record.deliveryStatus === 'partial' ? '需核对 · ' : ''}引用 {record.citationCount} 条 · 耗时{' '}
        {fmtDuration(record.durationMs)}
      </p>
      <span className="sub-title">{record.question}</span>
    </>
  );
}
