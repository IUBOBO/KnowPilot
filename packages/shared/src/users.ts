/**
 * 账号管理契约（阶段 4C 单元 ②）。
 *
 * 【为什么与 auth.ts 分开】auth.ts 描述的是"**我自己**是谁、我能做什么"
 *   （登录、会话、权限点）；这一份描述的是"管理员怎么看**别人**、怎么改别人"。
 *   两者的读者与暴露面都不同：前者每个页面都要用，后者只在持有 `users.manage`
 *   的人请求时才会离开服务端。混在一起会让 auth.ts 变成什么都往里塞的地方。
 *
 * 【为什么 ManagedUser 不复用 AuthUser】AuthUser 刻意只有四个字段 ——
 *   它会出现在 `/auth/me` 的响应里，多余的东西会跟着发到**每一个浏览器**。
 *   ManagedUser 是同一个人的"管理端视图"，多出状态与两个时间戳。
 *   两者是同一份数据的两副面孔，不是同一个类型 —— 合并的话，以后新加的字段
 *   会默认对**所有登录者**可见。
 */
import type { Role } from './auth.ts';

/** 账号状态。取值与 `users.status` 列的 CHECK 约束一致。 */
export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  active: '启用',
  disabled: '禁用',
};

/**
 * 管理端看到的一个账号。
 *
 * 【绝不包含 password_hash】不是"记得别发"，而是这个类型里根本没有它 ——
 *   将来某个 handler 想顺手 `{ ...row }` 也带不出去。
 */
export interface ManagedUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  groupId: string | null;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ListUsersResponse {
  items: readonly ManagedUser[];
}

export interface CreateUserRequest {
  username: string;
  /** 省略或空串则用规范化后的用户名当显示名（同引导建号的行为）。 */
  displayName?: string;
  password: string;
  role: Role;
  /** 课题组。当前部署恒为空 —— 见 auth.ts 的 AuthUser.groupId 注释。 */
  groupId?: string | null;
}

export interface CreateUserResponse {
  user: ManagedUser;
}

/**
 * 改一个账号。**只传要改的字段**，不出现的字段一律不动。
 *
 * 三档语义与 `UpdateCodeAssetRequest` 一致，但能清空的只有 `groupId`：
 *   · 不出现 → 不动；
 *   · `groupId` 给 `null` / 空串 → 清空（回到"未分组"）；
 *   · `displayName` / `username` / `role` / `status` 给了就必须是有效值 ——
 *     它们对应 NOT NULL 且有 CHECK 的列，"清空"没有含义（显示名为空时
 *     该显示什么？状态为空是启用还是禁用？）。
 *     硬塞一个第三态只会多出一种没人能解释的行。
 */
export interface UpdateUserRequest {
  /**
   * 登录用户名（仅管理端可改）。
   *
   * 与建号同一条归一化规则：去空白、转小写、不能含空格。改名的效果是
   * **"这个账号以后用新名字登录"**，不是换一个账号 —— id、口令、归属记录
   * 都不动，已登录的会话也不受影响（会话绑的是 user_id）。
   * 旧用户名从改名那一刻起就登不进来。
   */
  username?: string;
  displayName?: string;
  role?: Role;
  groupId?: string | null;
  status?: UserStatus;
}

export interface UpdateUserResponse {
  user: ManagedUser;
  /**
   * 因为这次改动被踢掉的会话数。
   *
   * 【只有"改成禁用"才踢】改角色、改显示名、改课题组都**不踢** ——
   *   角色是每个请求现从库里读的（`resolveSession` 里 JOIN users），
   *   所以下一次请求就是新角色，而把人踢下线只会让他莫名其妙掉线。
   *   禁用则相反：管理员的意图就是"立刻切断他"。
   */
  sessionsRevoked: number;
}

export interface ResetPasswordRequest {
  password: string;
}

export interface ResetPasswordResponse {
  username: string;
  /**
   * 改密码**必须**踢掉全部会话。会话里不带密码，所以不踢的话
   * 旧 token 照样能用 —— "我刚改了密码，怎么别人还能进"。
   */
  sessionsRevoked: number;
}

/**
 * 口令的最低要求。
 *
 * 【为什么只查长度】长度是唯一"写下来还能讲清理由"的规则：复杂度规则
 *   （大小写+数字+符号）在实践里把人逼向 `Password1!` 这种比一句话口令更弱的
 *   东西，而且它们**不影响**任何一个真实攻击的成本（攻击者撞的是口令库里的
 *   常见串，不是字典序）。长度至少能挡住"123"这类。
 *
 * 【为什么是 4 而不是 8】（2026-10-13 下调）8 位在真实使用里逼出的往往不是
 *   更强的口令，而是"写在便签上""几个人共用一条"这类更难看的做法，管理员替人
 *   设口令时尤其如此。**代价要说清楚**：4 位可被在线穷举，所以这条下限**不是**
 *   面向公网的安全边界，它只在"本机 / 内网自用"这个前提下成立；系统一旦对外
 *   暴露，必须自行把下限调回去。
 *
 * 【注意它不适用于 `.env` 里的引导口令】那条路径是运维自己写在自己机器上的，
 *   而这里是**管理员替别人设口令**，两者的边界不同（见 users.ts 的
 *   ensureInitialAdmin）。引导口令的强度问题如实记在文档里，不在这里假装解决了。
 */
export const MIN_PASSWORD_LENGTH = 4;
