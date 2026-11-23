/**
 * 会话状态与路由守卫（阶段 4B）。
 *
 * 【为什么不引状态库】全应用只有这一处共享状态，一个 Context 就是它的全部。
 *   上 Zustand / Redux 要额外解释"什么该放全局、什么该留在页面里"，
 *   而这里答案很明确：只有"当前是谁"是全局的。
 *
 * 【为什么状态是三档而不是 `user: AuthUser | null`】
 *   `null` 同时要表示"还没问出来"和"问了，没登录"两件事，而这两件事
 *   在界面上的处理完全相反：前者要等（什么都不能决定），后者要跳登录页。
 *   塌成一个 null，未登录的人打开首页时守卫会在探测还没回来时就抢先跳转，
 *   而那正是本该发生的一次跳转 —— 看起来没问题，直到某天网络慢一点，
 *   已经登录的人也被弹一次登录页。
 */
import type {
  AuthUser,
  LoginResponse,
  LogoutResponse,
  MeResponse,
  Permission,
  Role,
} from '@knowpilot/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { apiGet, apiPost, isAbort } from './api.ts';
import { forgetAskSession } from './ask-session.ts';
import { ForbiddenPage } from './pages/ForbiddenPage.tsx';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  permissions: readonly Permission[];
}

interface AuthContextValue extends AuthState {
  /** 当前角色有没有这个权限点。未登录 / 还在探测时一律 false。 */
  can: (permission: Permission) => boolean;
  /** 登录。失败时抛 ApiError（用户名不存在与密码错是同一个错误，见服务端）。 */
  login: (username: string, password: string) => Promise<void>;
  /** 登出。**只有服务端确认删掉了会话才清空本地状态**，见实现里的说明。 */
  logout: () => Promise<void>;
  /**
   * 重新问一次"我是谁"。
   *
   * 【为什么需要它】管理员在 `/admin/users` 里改了自己的显示名之后，
   *   侧栏还显示旧名字 —— 那份数据是应用启动时问来的，一直缓存着。
   *   这不是"等刷新就好"的小毛病：改完名字一看没变，人的第一反应是
   *   "没保存成功"，然后再改一次。
   *
   * 【为什么失败时不改成未登录】这是一次显示名刷新，不是重新登录。
   *   请求失败就把人踢成未登录，会让正在编辑的管理员莫名其妙掉线。
   */
  refresh: () => Promise<void>;
}

const ANONYMOUS: AuthState = { status: 'anonymous', user: null, permissions: [] };

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading', user: null, permissions: [] });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        // noAuthRedirect：这里的 401 是"尚未登录"，由 RequireAuth 决定要不要
        // 跳转；让 api 层在这里抢先跳，会把"登录页 → 首页 → 又被弹回登录页"
        // 变成一个自激的循环。
        const me = await apiGet<MeResponse>('/api/v1/auth/me', controller.signal, {
          noAuthRedirect: true,
        });
        setState({ status: 'authenticated', user: me.user, permissions: me.permissions });
      } catch (err) {
        if (isAbort(err)) return;
        // 401 与"后端没起来"都落到这里。**不能停留在 loading**：
        // 那会是一个永远转圈、也永远不告诉用户哪里错了的应用。
        // 统一按未登录处理，把"后端可能没起"的解释交给登录页去显示
        // （用户在那里提交时会拿到真正的错误）。
        setState(ANONYMOUS);
      }
    })();
    return () => controller.abort();
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    // 登录响应只带回 user，不回权限列表 —— 权限的唯一事实来源是服务端的
    // 权限模板，前端再算一份就有了第二处会漂移的实现。所以紧接着问一次 /me。
    await apiPost<LoginResponse>('/api/v1/auth/login', { username, password });
    const me = await apiGet<MeResponse>('/api/v1/auth/me', undefined, { noAuthRedirect: true });
    setState({ status: 'authenticated', user: me.user, permissions: me.permissions });
  }, []);

  const logout = useCallback(async () => {
    // 清空本地状态放在请求**成功之后**：请求失败时服务端的会话还在，
    // 本地却显示"已登出"，下一次整页刷新会把人变回登录态 ——
    // 那种"登出了又自己登回来"的表现比直接报一句错难懂得多。
    // 抛出去让调用方显示错误，是这一层唯一诚实的做法。
    await apiPost<LogoutResponse>('/api/v1/auth/logout', {});
    forgetAskSession();
    setState(ANONYMOUS);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const me = await apiGet<MeResponse>('/api/v1/auth/me', undefined, { noAuthRedirect: true });
      setState({ status: 'authenticated', user: me.user, permissions: me.permissions });
    } catch {
      // 拉不到就保持现状（见接口注释）：这是一次显示名刷新，不是重新登录。
      // 这里**刻意不吞掉 401 之外的判断**：真掉线了，下一次普通请求的
      // 401 分支会把人送去登录页，那是正确的地方。
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      can: (permission) => state.permissions.includes(permission),
      login,
      logout,
      refresh,
    }),
    [state, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth 必须在 <AuthProvider> 之内使用（见 main.tsx）。');
  }
  return ctx;
}

/**
 * 「管理端」的准入条件：持有其中任意一个，就算管理侧的人。
 *
 * 【为什么是"任意一个"而不是某一个】这四个权限点对应管理端四件互不相干的事，
 *   而侧栏的「管理端」分组与 `/admin` 概览页对四种人都该出现。
 *   挑其中一个当门槛（比如 system.config）会变成假依赖：将来加了第五种
 *   管理能力，概览页的准入却被写死在一个与它无关的权限点上。
 *
 * ⚠️ 侧栏用它、路由守卫也用它 —— 必须是**同一个**列表。两处各写一份的话，
 *   会出现"菜单里看得见、点进去 403"（或者反过来，更糟：菜单看不见但地址能进）。
 */
export const ADMIN_ENTRY_PERMISSIONS: readonly Permission[] = [
  'users.manage',
  'usage.read.all',
  'patrol.manage',
  'system.config',
];

/**
 * 角色的中文名。放在这里而不是各页面各写一份 —— 侧栏与 403 页都要显示它，
 * 两处各写一份的结果是"管理员"和"管理员（admin）"这种不一致。
 */
const ROLE_LABELS: Record<Role, string> = { admin: '管理员', mentor: '导师', member: '成员' };

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role];
}

/** 探测会话期间的占位。什么都不显示会让人以为页面坏了。 */
function CheckingSession() {
  return (
    <div className="auth-gate">
      <p className="dim" style={{ margin: 0 }}>
        正在确认登录状态…
      </p>
    </div>
  );
}

/**
 * 要求已登录。包住整个用户区（Layout）。
 *
 * 【为什么把待跳转的地址放进查询串】用户点开的是一个深链接、或从收藏夹
 *   进来的，登录后应当回到那里，而不是一律回首页。
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <CheckingSession />;
  if (status === 'anonymous') {
    const next = location.pathname + location.search;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}

/**
 * 要求某个权限点。包住管理区路由。
 *
 * 【为什么无权限时显示 403 页，而不是把入口藏起来】
 *   藏起来的话，用户从别处（文档、同事给的链接、浏览器历史）走到这一页时
 *   看到的是"正常页面但不该进来"或者干脆被重定向回首页 ——
 *   两种都无法自查，只能来问开发。明确的 403 至少回答了
 *   "是权限不够，不是你操作错了"。侧栏仍然是按权限过滤的，
 *   但那是**便利**，不是边界；边界在服务端。
 */
export function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const { can } = useAuth();
  if (!can(permission)) return <ForbiddenPage needed={`权限点 ${permission}`} />;
  return <>{children}</>;
}

/**
 * 需要若干权限点里的**任意一个**。
 *
 * 【为什么需要它】「管理概览」没有单一对应的权限点 —— 它给"有任一管理能力的人"
 *   看，而不是某一件具体的事。硬给它挑一个权限点（比如 system.config）会变成
 *   一个假的依赖：将来加了第四种管理能力，概览页的准入条件却被写成与它无关。
 */
export function RequireAnyPermission({
  permissions,
  children,
}: {
  permissions: readonly Permission[];
  children: ReactNode;
}) {
  const { can } = useAuth();
  if (!permissions.some((p) => can(p))) {
    return <ForbiddenPage needed={`以下权限中的任意一个：${permissions.join(' / ')}`} />;
  }
  return <>{children}</>;
}
