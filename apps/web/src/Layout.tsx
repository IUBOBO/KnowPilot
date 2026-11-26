import { Fragment, lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import type { Permission } from '@knowpilot/shared';
import { useTheme } from './theme.ts';
import { NavIcon, type NavIconName } from './nav-icons.tsx';
import { CommandPalette, type PalettePage } from './components/CommandPalette.tsx';
import { RecentRail } from './components/RecentRail.tsx';
import { ADMIN_ENTRY_PERMISSIONS, roleLabel, useAuth } from './auth.tsx';
import { toApiError } from './api.ts';
import type { AskActivity } from './ask-session.ts';

const AskPage = lazy(() => import('./pages/AskPage.tsx').then((m) => ({ default: m.AskPage })));
const ASK_ACTIVITY_LABELS = { running: '查询中', answered: '有新回答', failed: '查询未完成' } as const;

interface NavEntry {
  to: string;
  label: string;
  icon: NavIconName;
  end?: boolean;
  /**
   * 看到这一项需要的权限点。**缺省 = 所有登录用户都能看到**。
   *
   * ⚠️ 过滤导航只是**便利**，不是边界：真正的边界在服务端的权限闸门
   * （auth/routes.ts 的 ROUTE_PERMISSIONS）。藏起入口唯一的作用是别让用户
   * 一路点进去撞 403；但它挡不住任何人直接输地址 —— 那正是服务端要管的。
   */
  permission?: Permission;
  /**
   * 持有其中任意一个即可见。给"管理概览"这种没有单一权限点的入口用。
   * 与 `permission` 同时给时以本字段为准。
   */
  anyOf?: readonly Permission[];
}

/**
 * 侧栏的一组。`title` 为空串时**不可折叠**、也不显示标题 —— 用得着它的只有
 * "首页"这种单独一项、标题纯属多余的组。
 */
interface NavGroup {
  title: string;
  items: readonly NavEntry[];
}

/** 折叠状态存哪儿。与主题同一个惯例：带版本号的键，读写都包 try。 */
const NAV_COLLAPSE_KEY = 'knowpilot.nav.collapsed.v1';

/**
 * 【为什么默认是"全部展开"，而不是记住上次之后就默认折叠】
 *   默认折叠的话，新用户看到的侧栏上那些组**一个字都不显示**，等于把功能藏了；
 *   而折叠是用户自己点出来的选择，第一次打开没有这个选择，就该按"全都看得见"来。
 */
function readCollapsed(): readonly string[] {
  try {
    const raw = localStorage.getItem(NAV_COLLAPSE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    // localStorage 在隐私模式 / 禁用 Cookie 时会**抛异常**而不是返回 null（见 theme.ts）。
    return [];
  }
}

function writeCollapsed(titles: readonly string[]): void {
  try {
    localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify(titles));
  } catch {
    // 存不下不影响这一次：展开/折叠照样生效，只是下次打开回到默认（全展开）。
  }
}

/**
 * 这一项是不是"当前这一页"。
 *
 * 【为什么不直接用 NavLink 的 isActive】那是渲染时的回调，拿不到外面来；
 *   而这里要判断的是"**组**里有没有当前页"，得在渲染 NavLink 之前就知道。
 *   判据与 NavLink 保持一致：`end` 只认全等，否则认前缀（`/datasets` 带了
 *   `end`，所以停在 `/datasets/upload` 时它不算当前页 —— 与它自己不亮是同一回事）。
 */
function matchesPath(item: NavEntry, pathname: string): boolean {
  if (item.end === true) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/**
 * 这一项在不在当前用户的导航里。
 *
 * 【为什么抽出来】⌘K 面板与侧栏必须给出**同一份**页面清单。两处各写一遍
 * 权限判断，某天一侧加了新权限点、另一侧忘了，面板就会把人送进 403 ——
 * 而侧栏看起来完全正常。
 */
function canSeeNavItem(item: NavEntry, can: (permission: Permission) => boolean): boolean {
  if (item.anyOf !== undefined) return item.anyOf.some((p) => can(p));
  if (item.permission !== undefined) return can(item.permission);
  return true;
}

/** 面板里的页面清单：与侧栏同一套过滤，组标题为空时记作「常用」。 */
function palettePages(
  groups: readonly NavGroup[],
  can: (permission: Permission) => boolean,
): PalettePage[] {
  return groups.flatMap((group) =>
    group.items
      .filter((item) => canSeeNavItem(item, can))
      .map((item) => ({
        to: item.to,
        label: item.label,
        group: group.title === '' ? '常用' : group.title,
      })),
  );
}

/**
 * 用户端导航。
 *
 * 【为什么分小标题，而不是继续平铺】原先 15 项一字排开、只有「用户端」一个
 *   标题，四类材料还各自占一条（`/docs` `/experience` `/sop` `/rules` 其实是
 *   同一个组件锁死不同类型），第五类「知识点」反倒没有入口。分组之后，
 *   材料类型不再是导航的一级概念，而是「知识库」页内的标签页。
 * 问答 → 记录 → 知识库对应提问、回看和浏览材料。
 */
const USER_NAV: readonly NavGroup[] = [
  { title: '', items: [{ to: '/', label: '首页', icon: 'home', end: true }] },
  {
    title: '知识与问答',
    items: [
      { to: '/ask', label: '知识问答', icon: 'ask' },
      { to: '/asks', label: '问答记录', icon: 'history' },
      // 论文 / 知识点 / 经验与解题 / 流程与技术 / 实验室制度 全在这一页，
      // 用页面顶部的标签页切换（见 DocumentsPage 的清单与 router 的重定向）。
      { to: '/docs', label: '知识库', icon: 'docs' },
      { to: '/search', label: '统一检索', icon: 'search' },
      // 紧跟在知识库之后：读进去（知识库）与写回来（知识沉淀）是同一件事的两头，
      // 而沉淀出来的知识确认之后就落在知识库里。图标用 capture（收件盘）——
      // 它一直画好了没人用，语义正合"把散落的事收进来"。
      { to: '/knowledge', label: '知识沉淀', icon: 'capture' },
    ],
  },
  {
    title: '投稿与期刊',
    items: [
      { to: '/submissions', label: '投稿台账', icon: 'submissions' },
      // 紧跟在投稿台账之后：台账里那行"X 刊 3 区"点进来就是这儿，
      // 而台账上"分区未收录"的刊也正是在这一页补录。
      { to: '/journals', label: '期刊分区库', icon: 'journals' },
    ],
  },
  {
    title: '人员与成果',
    items: [
      { to: '/people', label: '人员主档', icon: 'users' },
      { to: '/patents', label: '专利', icon: 'patents' },
      { to: '/theses', label: '大论文', icon: 'theses' },
      { to: '/imports', label: 'Excel 导入', icon: 'imports' },
    ],
  },
  {
    title: '数据集',
    items: [
      { to: '/datasets', label: '数据集管理', icon: 'datasets', end: true },
      { to: '/datasets/upload', label: '数据集上传', icon: 'upload' },
      // 不加 end：正在整理某一个数据集（/datasets/organize/<id>）时，这一项也该亮着 ——
      // 它和"上传"是同一层的入口，不是它下面的一级。不加 end 就自然覆盖了子路径。
      { to: '/datasets/organize', label: '数据集整理', icon: 'organize' },
    ],
  },
  // 不放管理端：它查的是**自己**的用量，人人都该看到，
  // 和管理端那张全库用量表不是一回事。
  { title: '个人', items: [{ to: '/me/usage', label: '我的用量', icon: 'usage' }] },
];

const ADMIN_NAV: readonly NavGroup[] = [
  {
    title: '',
    items: [
      // 概览页对**任一**管理能力的人开放，所以用 anyOf —— 与路由守卫
      // 用的是同一个 ADMIN_ENTRY_PERMISSIONS，两边不会漂移。
      { to: '/admin', label: '管理概览', icon: 'admin', end: true, anyOf: ADMIN_ENTRY_PERMISSIONS },
      { to: '/admin/users', label: '用户与权限', icon: 'users', permission: 'users.manage' },
      // 知识审核用的是 knowledge.review，导师也有 —— 于是导师**第一次**会看到
      // 「管理端」这个组标题（在这之前他的 ADMIN_NAV 整组被筛空、连标题都不显示）。
      // 这是规格的必然结果（导师就是审核人），不是权限开错了。
      // ⚠️ 千万不要把 knowledge.review 加进 auth.tsx 的 ADMIN_ENTRY_PERMISSIONS：
      //    那是 /admin 概览页的 anyOf，加进去等于把整个管理端开放给导师。
      { to: '/admin/review', label: '知识审核', icon: 'capture', permission: 'knowledge.review' },
      { to: '/admin/usage', label: '用量与预算', icon: 'usage', permission: 'usage.read.all' },
      { to: '/admin/patrol', label: '巡检', icon: 'patrol', permission: 'patrol.manage' },
      // 反馈放在配置之前：它是"日常要看的东西"，配置是"偶尔改一次的东西"。
      { to: '/admin/feedback', label: '回答反馈', icon: 'feedback', permission: 'feedback.manage' },
      // Trace 紧跟反馈：两者都是"这次问答到底怎么样"的复盘入口 ——
      // 反馈看用户的判断，Trace 看系统自己的过程。
      { to: '/admin/traces', label: '运行 Trace', icon: 'trace', permission: 'trace.read.all' },
      { to: '/admin/config', label: '系统配置', icon: 'config', permission: 'system.config' },
    ],
  },
];

/** 组头的那个小箭头：收起时朝右，展开时转 90° 朝下。 */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={open ? 'nav-chevron open' : 'nav-chevron'}
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

function NavSection({
  title,
  groups,
  can,
  collapsed,
  onToggleGroup,
  askActivity = 'idle',
}: {
  title: string;
  groups: readonly NavGroup[];
  can: (permission: Permission) => boolean;
  collapsed: readonly string[];
  onToggleGroup: (groupTitle: string) => void;
  askActivity?: AskActivity;
}) {
  const { pathname } = useLocation();

  const visibleGroups = groups
    .map((group) => ({
      title: group.title,
      items: group.items.filter((item) => canSeeNavItem(item, can)),
    }))
    .filter((group) => group.items.length > 0);

  // 一项都不剩时连标题也不显示 —— 让成员看到一个空的「管理端」分组，
  // 只会让人以为系统坏了或者自己被降权了。整个组被权限筛空时同理。
  if (visibleGroups.length === 0) return null;

  return (
    <>
      {title !== '' && <div className="nav-group-title">{title}</div>}
      {visibleGroups.map((group) => {
        const open = !collapsed.includes(group.title);
        // 组里有没有"当前这一页"。
        // 【为什么组头也要标出来】组一旦被折叠，组里的项就都不渲染了 ——
        //   这时候侧栏上**没有任何东西**说明你在哪一页。所以组头自己顶上：
        //   只要组里有当前页，组头就带主色（哪怕它是收着的），
        //   一眼能看出"我在这组里"，也知道该把哪一组点开。
        const holdsCurrent = group.items.some((item) => matchesPath(item, pathname));
        const nested = group.title !== '';

        return (
          <Fragment key={group.title}>
            {nested && (
              <button
                type="button"
                className={holdsCurrent ? 'nav-group-toggle active' : 'nav-group-toggle'}
                aria-expanded={open}
                title={group.title}
                onClick={() => onToggleGroup(group.title)}
              >
                <Chevron open={open} />
                {group.title}
              </button>
            )}
            {open &&
              group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  title={item.label}
                  end={item.end === true}
                  className={({ isActive }) =>
                    `nav-item${nested ? ' nested' : ''}${isActive ? ' active' : ''}`
                  }
                >
                  <NavIcon name={item.icon} />
                  {item.label}
                  {item.to === '/ask' && askActivity !== 'idle' && (
                    <span className="nav-ask-status" role="status">{ASK_ACTIVITY_LABELS[askActivity]}</span>
                  )}
                </NavLink>
              ))}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * 顶栏里的当前用户。
 *
 * 【为什么退出按钮失败时要说出来，而不是照样清空】本地清空而后端会话还在的话，
 *   下一次整页刷新会把人变回登录态 —— "登出了又自己登回来"这种表现
 *   比直接报一句错难查得多。所以失败时保留登录态、把错误显示出来。
 */
function CurrentUser() {
  const { user, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user === null) return null;

  async function onLogout() {
    setBusy(true);
    setError(null);
    try {
      await logout();
    } catch (err) {
      setError(toApiError(err).body.error.message);
    } finally {
      setBusy(false);
    }
  }

  // 头像里那个字：取显示名的第一个字符。`[...str]` 而不是 `str[0]` ——
  // 显示名可能以 emoji 或别的代理对字符开头，按 UTF-16 码元切会切出半个字符。
  const initial = [...user.displayName][0] ?? '?';

  return (
    <div className="sidebar-user">
      <span className="user-avatar" aria-hidden="true">{initial}</span>
      <span className="sidebar-user-text">
        <span className="sidebar-user-name" title={`${user.displayName}（${user.username}）`}>
          {user.displayName}
        </span>
        <span className="sidebar-user-role">{roleLabel(user.role)}</span>
      </span>
      {/* 纯图标按钮：文字标题收进 title/aria-label（见 index.css 那条取舍说明）。
          退出中禁用自己，避免连点两次 —— 第二次会拿到一个已经被删掉的会话。 */}
      <button
        type="button"
        className="icon-btn"
        onClick={() => void onLogout()}
        disabled={busy}
        title={busy ? '退出中…' : '退出登录'}
        aria-label={busy ? '退出中' : '退出登录'}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
          <path d="M10 17l-5-5 5-5M5 12h10" />
        </svg>
      </button>
      {error !== null && <p className="sidebar-user-err">{error}</p>}
    </div>
  );
}

/**
 * 主题切换按钮。
 *
 * 图标画的是"点下去会变成什么样"（暗色时显示太阳），而不是当前状态 ——
 * 按钮上写当前状态的话，用户得先看懂它是状态还是开关才知道点不点得。
 *
 * 【2026-10-16 起收成纯图标】原先它占侧栏底部一整行、带「暗色主题」四个字。
 * 收进用户行右侧之后放不下文字，语义改由 `title` 与 `aria-label` 承担
 * （两者都给：title 给鼠标用户，aria-label 给读屏）。
 */
function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? '亮色' : '暗色';

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={toggle}
      aria-label={`切换到${next}主题`}
      title={`切换到${next}主题`}
    >
      {theme === 'dark' ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}

export function Layout() {
  const { can, user } = useAuth();
  const { pathname } = useLocation();
  const showAsk = pathname === '/ask' || pathname === '/ask/';
  const [askVisited, setAskVisited] = useState(showAsk);
  const [askActivity, setAskActivity] = useState<AskActivity>('idle');
  useEffect(() => {
    if (showAsk) setAskVisited(true);
  }, [showAsk]);
  useEffect(() => {
    if (showAsk && (askActivity === 'answered' || askActivity === 'failed')) setAskActivity('idle');
  }, [askActivity, showAsk]);
  const visibleAskActivity = showAsk && askActivity !== 'running' ? 'idle' : askActivity;

  /**
   * 右栏（最近入库）在**所有用户端页面**出现，管理端除外。
   *
   * 2026-10-18 用户明确要求"随时随地看到最近谁入库的"，取代原先的白名单
   * （首页 / 知识库）。管理端仍有自己的任务密度，不塞资料栏。
   *
   * 【为什么判断写成"等于或以其开头"】`/admin` 下还有 users/review/usage 等子路径，
   * 只比相等会让子页面上右栏忽然冒出来 —— 那种"点进去就变样"是最难查的界面回归。
   */
  const isAdminPath = pathname === '/admin' || pathname.startsWith('/admin/');
  const showRail = !isAdminPath && pathname !== '/knowledge/notes';
  const railTitle = can('ledger.deletions.read') ? '最近消息' : '最近入库';
  const [railOpen, setRailOpen] = useState(false);
  const railToggleRef = useRef<HTMLButtonElement>(null);
  const closeRail = () => {
    setRailOpen(false);
    railToggleRef.current?.focus();
  };
  const currentPage = pathname === '/'
    ? '今天的工作台'
    : pathname === '/knowledge/notes' ? '研究笔记'
    : pathname.startsWith('/chunk/')
      ? '原文片段'
    : pathname.startsWith('/admin/traces/')
      ? 'Trace 详情'
      : [...USER_NAV, ...ADMIN_NAV]
          .flatMap((group) => group.items)
          .filter((item) => matchesPath(item, pathname))
          .sort((a, b) => b.to.length - a.to.length)[0]?.label ?? '首页';

  useEffect(() => setRailOpen(false), [pathname]);
  useEffect(() => {
    if (!railOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setRailOpen(false);
        railToggleRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab') return;
      const rail = document.getElementById('recent-rail');
      const focusables = [...(rail?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]') ?? [])]
        .filter((element) => getComputedStyle(element).display !== 'none');
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [railOpen]);

  /**
   * 折叠状态放在这里（而不是两个 NavSection 各存一份）：
   * 它是**一个** localStorage 键，两个组件各自持有就会各写各的、互相覆盖。
   * 一处持有、往下传，就不存在这个可能。
   */
  const [collapsed, setCollapsed] = useState<readonly string[]>(readCollapsed);

  function toggleGroup(groupTitle: string) {
    setCollapsed((prev) => {
      const next = prev.includes(groupTitle)
        ? prev.filter((t) => t !== groupTitle)
        : [...prev, groupTitle];
      writeCollapsed(next);
      return next;
    });
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand-row">
          {/* alt="" 是刻意的：图标紧挨着品牌名，名字已经把信息说完了，
              再让读屏软件念一遍只是噪音（与导航图标同一处理）。 */}
          <img className="brand-logo" src="/brand-mark.svg" alt="" width={40} height={40} />
          <div>
            {/* 用 div 而不是 h1：页面正文里已经有一个 h1（页面标题），
                侧栏的品牌名再占一个，一个页面就有两个一级标题，
                屏幕阅读器按标题跳转时会在两处都停一下。 */}
            <div className="brand">KnowPilot</div>
            <p className="brand-sub">让研究知识，持续生长</p>
          </div>
        </div>
        <NavSection
          title=""
          groups={USER_NAV}
          can={can}
          collapsed={collapsed}
          onToggleGroup={toggleGroup}
          askActivity={visibleAskActivity}
        />
        <NavSection
          title="管理端"
          groups={ADMIN_NAV}
          can={can}
          collapsed={collapsed}
          onToggleGroup={toggleGroup}
        />
      </aside>
      {/* 主区与右栏打包在 .content 里，由它统一限宽并居中 ——
          直接把右栏放在 .layout 下的话，主区限宽后多出来的宽度会全堆在最右边，
          右栏反而被推到贴着屏幕边缘，离内容很远。 */}
      <div className="app-shell">
        <header className="app-topbar">
          <div className="topbar-breadcrumb" aria-label="当前位置">
            {pathname !== '/' && <span>首页 <span aria-hidden="true">›</span> </span>}
            <strong>{currentPage}</strong>
          </div>
          <div className="topbar-actions">
            {!showAsk && visibleAskActivity !== 'idle' && (
              <Link to="/ask" className="topbar-ask-status">问答：{ASK_ACTIVITY_LABELS[visibleAskActivity]}</Link>
            )}
            <CommandPalette pages={palettePages([...USER_NAV, ...ADMIN_NAV], can)} />
            {showRail && (
              <button
                type="button"
                className="rail-toggle"
                data-short-label={can('ledger.deletions.read') ? '消息' : '入库'}
                ref={railToggleRef}
                aria-controls="recent-rail"
                aria-expanded={railOpen}
                onClick={() => setRailOpen((open) => !open)}
              >
                {railTitle}
              </button>
            )}
            <ThemeToggle />
            <CurrentUser />
          </div>
        </header>
        <div className={`content${showRail ? '' : ' content-no-rail'}${railOpen ? ' rail-open' : ''}`}>
          <main className="main" data-route={pathname}>
            {(askVisited || showAsk) && user !== null && (
              <div className="ask-page-slot" hidden={!showAsk}>
                <Suspense fallback={<p className="dim" role="status">正在加载问答…</p>}>
                  <AskPage key={`${user.id}:${user.role}`} active={showAsk}
                    scope={`${user.id}:${user.role}`} onActivity={setAskActivity} />
                </Suspense>
              </div>
            )}
            {!showAsk && <Suspense fallback={<p className="dim" role="status">正在加载界面…</p>}><Outlet /></Suspense>}
          </main>
          {showRail && <RecentRail overlayOpen={railOpen} onClose={closeRail} />}
          {showRail && railOpen && (
            <button
              type="button"
              className="rail-backdrop"
              aria-label={`关闭${railTitle}`}
              onClick={closeRail}
            />
          )}
        </div>
      </div>
    </div>
  );
}
