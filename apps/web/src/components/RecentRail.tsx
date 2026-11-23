/**
 * 右栏「最近入库」。
 *
 * 【它显示的是什么】
 *   全库最近入库的资料，**不按材料筛** —— 论文、经验、流程、制度混在同一条时间线上。
 *   理由：这一栏的用途是"看看最近有什么新东西"，而不是"找某一类东西"；
 *   按类型分类是左边导航在做的事，这里再分一次就成了两个入口做同一件事。
 *
 * 【为什么按月分组、默认只展开最近一个月】
 *   平铺的时间线在条目少时没问题，一攒几个月就变成一条长长的流水，
 *   "最近有什么新东西"这个用途反被淹掉。按月分组 + 组头可折叠之后，
 *   整栏常态就是"最近一个月的内容 + 一列月份标题"，长度不再随库里资料的多少增长。
 *   默认**只展开最近一个月**（而不是像导航那样全展开）：导航那几组是固定的十来项，
 *   月份却会一直长下去，同一条原则搬过来会变成一屏塞不下的几年。
 *   用户自己开合过之后，就按他的选择记住（见 RAIL_EXPANDED_KEY）。
 *
 * 【组头右边的数字是"本栏取到的条数"，不是库里这个月的总数】
 *   接口按条数截断（见 RAIL_FETCH_LIMIT）。这个数只在"库里资料少于这个上限"时
 *   才等于总数 —— 所以它是给"这个月有东西"一个粗细的量感，不当作精确统计。
 *
 * 【关于"谁提交的"】
 *   阶段 4 起会显示上传者的**显示名**。阶段 1–3 上传的资料 `uploaded_by`
 *   仍是 NULL（那时还没有登录），这时显示「上传者未记录」——
 *   四个字说明的是"这条记录里没有这个信息"，与"匿名上传"是两回事：
 *   后者是一个选择，前者是事实缺失。界面上不能把两者说成同一句话。
 *   历史行不强行洗成某个人，见 plan 决定 2。
 *
 * 【为什么点进的是"文档第一个块"而不是文档详情页】
 *   现在没有文档详情页。`/chunk/:chunkId` 能给出文档标题、页码、该页的块，
 *   底部还有「下载原件」，等于"打开这份文档的开头"，是眼下最接近的落点。
 *   等真做了详情页，把这里的链接换掉就行，接口不用改。
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { MATERIAL_LABELS, type DocumentSummary, type ListDocumentsResponse } from '@knowpilot/shared';
import { apiGet, isAbort, toApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { EmptyState } from './EmptyState.tsx';
import { LedgerDeletionActivity } from './LedgerDeletionActivity.tsx';
import { SkeletonRail } from './Skeleton.tsx';
import { FileTypeIcon } from './FileTypeIcon.tsx';

/**
 * 一次取多少条。
 *
 * 【为什么从 8 提到 120】按月分组要有历史才成其为分组 —— 只取 8 条的话
 *   绝大多数时候只够拼出一个月，分组等于没分。列表接口本来就是把 documents
 *   过一遍按时间倒序，取 120 条不比取 8 条贵多少，而折叠起来的月份**不渲染行**
 *   （见下面 `open &&`），DOM 里始终只有展开那一个月的内容。
 */
const RAIL_FETCH_LIMIT = 120;

/** 骨架条数与默认展开的那个月"大致一眼能看到的行数"对上，内容到达时不跳。 */
const RAIL_SKELETON_ROWS = 6;

/** 展开状态存哪儿。与导航折叠、主题同一个惯例：带版本号的键，读写都包 try。 */
const RAIL_EXPANDED_KEY = 'knowpilot.rail.expanded.v1';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

interface MonthGroup {
  /** `2026-10`，只用来做 key 与开合判据，不显示 */
  key: string;
  /** `2026 年 10 月` */
  label: string;
  items: readonly DocumentSummary[];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 归月**必须用本地时间**，不能用 `iso.slice(0, 7)`。
 *
 * `createdAt` 存的是 UTC 瞬时值（见 documents.ts）。直接切字符串取到的是 **UTC 的月**：
 * 东八区 2026-10-01 凌晨 2 点传的东西，UTC 上还是 9 月 30 日 —— 会被归进「9 月」，
 * 而用户在界面上看到的日期明明是 10 月 1 日。跨月的边界上两种算法给出不同答案，
 * 且只在月末月初那几个小时里错，属于"偶发、难复现"的那一类。
 */
function monthOf(iso: string): { key: string; label: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    const raw = iso.slice(0, 7);
    return { key: raw, label: raw };
  }
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  return { key: `${year}-${pad2(month)}`, label: `${year} 年 ${month} 月` };
}

/** 条目左侧那个方块里的两行：日号（补零，保证两位）与星期。 */
function dayOf(iso: string): { day: string; week: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { day: '--', week: '' };
  return { day: pad2(d.getDate()), week: WEEKDAYS[d.getDay()] ?? '' };
}

/** 补上具体到分钟的时间，挂在整行的 `title` 上 —— 日期块只到"哪一天"这一级。 */
function exactTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function isToday(iso: string, now: Date): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function groupByMonth(items: readonly DocumentSummary[]): readonly MonthGroup[] {
  const groups: MonthGroup[] = [];
  let current: DocumentSummary[] = [];
  let currentKey: string | null = null;
  let currentLabel = '';

  const flush = () => {
    if (currentKey !== null) groups.push({ key: currentKey, label: currentLabel, items: current });
  };

  for (const doc of items) {
    const { key, label } = monthOf(doc.createdAt);
    // items 已经是按时间倒序的，所以同一个月必然连在一起，不用 Map 归并。
    if (key !== currentKey) {
      flush();
      currentKey = key;
      currentLabel = label;
      current = [];
    }
    current.push(doc);
  }
  flush();
  return groups;
}

/** 读曾经展开过哪些月。返回 `null` 表示**用户还没选过**，此时按"只展开最近一个月"来。 */
function readExpanded(): readonly string[] | null {
  try {
    const raw = localStorage.getItem(RAIL_EXPANDED_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : null;
  } catch {
    // localStorage 在隐私模式 / 禁用 Cookie 时会**抛异常**而不是返回 null（见 theme.ts）。
    return null;
  }
}

function writeExpanded(keys: readonly string[]): void {
  try {
    localStorage.setItem(RAIL_EXPANDED_KEY, JSON.stringify(keys));
  } catch {
    // 存不下不影响这一次：开合照常生效，只是下次打开回到默认。
  }
}

/** 组头的小箭头：收起时朝右，展开时转 90° 朝下（与侧栏同一个形状）。 */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={open ? 'rail-chevron open' : 'rail-chevron'}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

export function RecentRail({ onClose, overlayOpen = false }: { onClose?: () => void; overlayOpen?: boolean }) {
  const { can } = useAuth();
  const showDeletions = can('ledger.deletions.read');
  const title = showDeletions ? '最近消息' : '最近入库';
  const closeRef = useRef<HTMLButtonElement>(null);
  const [items, setItems] = useState<readonly DocumentSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  const [expanded, setExpanded] = useState<readonly string[] | null>(readExpanded);
  const { pathname } = useLocation();

  // 依赖 pathname 与 tick。
  //   · pathname：右栏挂在 Layout 上，不随页面切换重挂载 —— 不这么做的话，
  //     传完新文档它一直显示旧的，直到手动刷新整页。
  //   · tick：回到这个标签页时再取一次（用户可能刚在另一个标签页传了东西）。
  useEffect(() => {
    const ac = new AbortController();
    apiGet<ListDocumentsResponse>(`/api/v1/documents?limit=${RAIL_FETCH_LIMIT}`, ac.signal)
      .then((res) => {
        setItems(res.items);
        setError(null);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (isAbort(err)) return;
        setError(toApiError(err).body.error.title);
        setLoaded(true);
      });
    return () => ac.abort();
  }, [pathname, tick]);

  useEffect(() => {
    const onFocus = () => setTick((n) => n + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  useEffect(() => {
    if (overlayOpen) closeRef.current?.focus();
  }, [overlayOpen]);

  const groups = groupByMonth(items);
  const newestKey = groups[0]?.key ?? null;
  // 用户没选过时：只展开最近那个月。
  const defaultOpen = newestKey === null ? [] : [newestKey];
  const openKeys = expanded ?? defaultOpen;

  function toggleMonth(key: string) {
    setExpanded((prev) => {
      const base = prev ?? defaultOpen;
      const next = base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
      writeExpanded(next);
      return next;
    });
  }

  return (
    <aside className="rail" id="recent-rail" aria-label={title} role={overlayOpen ? 'dialog' : undefined} aria-modal={overlayOpen ? true : undefined}>
      <div className="rail-heading">
        <h2 className="rail-title">{title}</h2>
        {onClose && <button ref={closeRef} type="button" className="rail-close" onClick={onClose} aria-label={`关闭${title}`}>×</button>}
      </div>
      {/* 滚动只发生在这里面：标题常驻，月份列表在它下面滚 —— 滚轮因此是这一栏
          自己的，不会把左边的正文一起带走（.rail 本身 overflow: hidden）。 */}
      <div className="rail-scroll">
        {showDeletions && <>
          <LedgerDeletionActivity canRestore={can('ledger.delete.all')} refreshKey={`${pathname}:${tick}:${overlayOpen}`} />
          <h3 className="rail-section-title">最近入库</h3>
        </>}
        {error !== null && <p className="rail-empty">{error}</p>}
        {/* 加载态是这一栏原本**完全没有**的一档：`loaded` 之前，栏里除了标题就是空的，
            比"一行灰字"更看不出在做什么。 */}
        {error === null && !loaded && <SkeletonRail rows={RAIL_SKELETON_ROWS} />}
        {error === null && loaded && items.length === 0 && (
          <EmptyState icon="docs" compact action={<Link className="link-btn" to="/docs" onClick={onClose}>去知识库传一份</Link>}>
            还没有内容入库。传上来的资料会按月份排在这里。
          </EmptyState>
        )}
        {error === null &&
          loaded &&
          groups.map((group) => {
            const open = openKeys.includes(group.key);
            return (
              <section className="rail-month" key={group.key}>
                <button
                  type="button"
                  className={open ? 'rail-month-head open' : 'rail-month-head'}
                  aria-expanded={open}
                  onClick={() => toggleMonth(group.key)}
                >
                  <Chevron open={open} />
                  <span className="rail-month-label">{group.label}</span>
                  {/* 条数是"本栏取到的"，不是全库总数（见文件头注释）。 */}
                  <span className="rail-month-count">{group.items.length}</span>
                </button>
                {open && (
                  <ul className="rail-list">
                    {group.items.map((doc) => (
                      <li key={doc.id}>
                        <RailItem doc={doc} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
      </div>
      {error === null && loaded && items.length > 0 && (
        <div className="rail-foot">
          <Link className="rail-foot-link" to="/docs" onClick={onClose}>
            全部资料 <span aria-hidden="true">→</span>
          </Link>
        </div>
      )}
    </aside>
  );
}

function RailItem({ doc }: { doc: DocumentSummary }) {
  const { day, week } = dayOf(doc.createdAt);
  const today = isToday(doc.createdAt, new Date());
  const body = (
    <>
      <span className="rail-day" aria-hidden="true">
        <span className="rail-day-num">{day}</span>
        <span className="rail-day-week">{week}</span>
      </span>
      <span className="rail-body">
        <span className="rail-doc-title"><FileTypeIcon fileName={doc.fileName} title={doc.title} />{doc.title}</span>
        <span className="rail-meta">
          <span className="rail-material">{MATERIAL_LABELS[doc.material]}</span>
          <span className="rail-by">{doc.uploadedByName ?? '上传者未记录'}</span>
        </span>
      </span>
    </>
  );

  const cls = `rail-item${today ? ' is-today' : ''}`;

  // 没有块 = 解析没产出内容（扫描件、加密文件等）。做成不可点，
  // 而不是点了跳到一个空页面 —— 后者会让人以为系统坏了。
  if (doc.firstChunkId === null) {
    return (
      <div className={`${cls} is-inert`} title={`${doc.title}\n${exactTime(doc.createdAt)}（没有可查看的内容）`}>
        {body}
      </div>
    );
  }

  return (
    <Link className={cls} to={`/chunk/${doc.firstChunkId}`} title={`${doc.title}\n${exactTime(doc.createdAt)}`}>
      {body}
    </Link>
  );
}
