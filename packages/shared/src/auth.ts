/**
 * 认证与权限的契约（阶段 4）。
 *
 * 【为什么权限点必须定义在 shared，而不是服务端】
 *   服务端要拿它做**强制校验**，前端要拿它做**菜单与路由的显隐**。
 *   如果各写一份，两边迟早会漂移：前端以为某人能进，后端已经不放行了
 *   （用户看到 403 却不知道为什么），或者反过来 —— 前端把入口藏了，
 *   后端其实还开着（真出了事才发现边界是假的）。
 *   定义一次、两边 import，是唯一能让"界面上的边界"与"服务层的边界"
 *   说的是同一件事的办法。
 *
 *   注意前端**不能** import 服务端代码，所以这里必须是 pure 类型 + 常量，
 *   不含任何 node 内置模块。
 */

/** 角色只有三个。设计决策：单应用 + 路由区 + 权限点，不拆两个前端工程。 */
export type Role = 'admin' | 'mentor' | 'member';

export const ROLES: readonly Role[] = ['admin', 'mentor', 'member'] as const;

/**
 * 权限点全集。
 *
 * 前 16 项来自设计文档 04 §3.2；其余是各阶段收口时补的
 * （见下方各自的注释）。
 */
export const PERMISSIONS = [
  'chat.use',
  'knowledge.read',
  'knowledge.submit',
  'knowledge.review',

  'submission.read.own',
  'submission.read.group',
  'submission.read.all',
  'submission.write.own',
  'submission.write.all',
  /** 误录投稿的整条删除，独立于编辑权，仅管理员持有。 */
  'ledger.delete.all',
  'ledger.deletions.read',

  'material.upload',
  /** 删除文档、重建索引 */
  'material.manage',

  /** 看人员主档的姓名、课题组、状态。 */
  'people.read',
  /** 看完整学号。当前所有登录角色持有此权限。 */
  'people.read.sensitive',
  /** 新建/订正人员记录、绑定或解绑登录账号。仅管理员。 */
  'people.manage',

  /** 专利台账：登录用户可查看和新建，编辑按录入人或角色授权。 */
  'patent.read.own',
  'patent.read.all',
  'patent.write.own',
  'patent.write.all',

  /** 大论文：所有登录用户可查看档案和成绩。 */
  'thesis.read',
  'thesis.read.grade',
  'thesis.manage',

  /** 看数据集列表与详情。阶段 4 之前是"能打开页面就能看"，现在要有名字。 */
  'code.read',
  /** 登记数据集（新增一条登记，不改任何已有数据） */
  'code.register',
  /**
   * 改 / 删 / 整理数据集。
   *
   * 【为什么"登记"与"改删"要分开】整理会在数据集目录里真实地移动文件
   * （阶段 3 增补 B），删除直接抹掉一条登记。这两件事的风险比"加一条记录"
   * 高一个量级，不该共用一个权限点 —— 共用了就没法只给登记、不给改删。
   */
  'code.write',

  /** 查期刊分区库 */
  'journal.read',
  /**
   * **新增**一本刊、补一条分区。
   *
   * 【为什么给所有人】分区库是公共的静态事实，但它**一定不全** ——
   * 未收录的刊要有人能当场补上，否则用户查到"未收录"就只能干等管理员。
   * 用户的原始诉求就是"支持用户自己添加分区内容"。
   */
  'journal.add',
  /**
   * **订正 / 删除**已有的期刊与分区。
   *
   * 【为什么这一档要收窄】分区库当前有 818 刊 / 1683 条导入数据，
   * 是所有人共用的判据。人人可改等于这批数据随时可能被改歪，而且
   * 改歪了没人能说清是哪次改的。新增只影响"缺的那一块"，订正删改则
   * 动到已经有人在依赖的数据上 —— 这两件事的风险不对称，所以权限也拆开。
   */
  'journal.manage',

  /**
   * 读问答记录（提问原文不脱敏，是用户明确的选择）。
   *
   * 【为什么单独两个点，而不是复用 usage.read.*】用量是 token 与费用，
   * 问答记录是**提问的原文**。前者是数字，后者是内容，能看数字不等于
   * 该看别人问了什么。
   */
  'askRecord.read.own',
  'askRecord.read.all',

  'patrol.manage',
  'usage.read.own',
  'usage.read.all',
  'users.manage',
  'system.config',
  /**
   * 看回答反馈的汇总列表、导出评测草稿。
   *
   * 【为什么只有管理员】列表里是**别人**的赞踩与自由文字，导出还会把提问原文
   * 变成一份文件。它比用量数字敏感，和问答记录同档收在 admin 一侧。
   * 写反馈本身不需要它 —— 任何能提问的人都能给自己的运行打分（`chat.use`）。
   */
  'feedback.manage',
  /**
   * 看管理端运行 Trace（O7）。
   *
   * 【为什么单独一个权限点，而不是复用 askRecord.read.all】Trace 里除了提问原文，
   *   还有预算用量、工具查询词与内部诊断字段；这些是**运维**视角的数据，不是
   *   "能看问答记录"的延伸。导师持有 askRecord.read.all 是为了看本组问了什么，
   *   不该顺带看到全实验室的运行细节。只给 admin。
   */
  'trace.read.all',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * 角色 → 权限的映射（权限模板）。
 *
 * 【为什么是"角色少、权限可叠加"而不是角色继承树】
 *   10 余人的规模，五个角色的继承树带来的复杂度远大于它解决的问题。
 *   三个模板 + 一张权限表，改权限是改一行数据，不是改一段类层次。
 */
const ADMIN_FULL: readonly Permission[] = PERMISSIONS;

const MENTOR_GROUP: readonly Permission[] = [
  'chat.use',
  'knowledge.read',
  'knowledge.submit',
  'knowledge.review',
  'submission.read.own',
  'submission.read.group',
  'submission.read.all',
  'submission.write.own',
  'submission.write.all',
  'ledger.deletions.read',
  'material.upload',
  'code.read',
  'code.register',
  'code.write',
  'journal.read',
  'journal.add',
  'journal.manage',
  'askRecord.read.own',
  'askRecord.read.all',
  'usage.read.own',
  'people.read',
  'people.read.sensitive',
  'patent.read.own',
  'patent.read.all',
  'patent.write.own',
  'patent.write.all',
  'thesis.read',
  'thesis.read.grade',
  'thesis.manage',
];

const MEMBER_BASIC: readonly Permission[] = [
  'chat.use',
  'knowledge.read',
  'knowledge.submit',
  'submission.read.own',
  'submission.read.all',
  'submission.write.own',
  /**
   * 【与设计文档 04 §3.2 的差异，刻意为之】文档的 member_basic 列表里
   * 没有 material.upload，但需求 1（论文与知识点文档上传）的提交主体
   * 正是研究生。照文档执行的话，上传页对研究生直接不可用 —— 那不是
   * "权限收紧了"，而是把主要功能关掉了。故补上。
   */
  'material.upload',
  'code.read',
  'code.register',
  'code.write',
  'journal.read',
  'journal.add',
  'askRecord.read.own',
  'usage.read.own',
  'people.read',
  'people.read.sensitive',
  'patent.read.own',
  'patent.read.all',
  'patent.write.own',
  'thesis.read',
  'thesis.read.grade',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: ADMIN_FULL,
  mentor: MENTOR_GROUP,
  member: MEMBER_BASIC,
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsOf(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

/**
 * 当前登录用户。**不含 password_hash** —— 它会出现在 /api/v1/auth/me 的
 * 响应里，任何哈希都不该离开服务端。
 */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  /**
   * 课题组。设计文档里"导师看本组投稿"要靠它，但当前部署所有人都没有组
   * （恒为 null），见 submissions/repo.ts 的可见性谓词注释。
   */
  groupId: string | null;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  user: AuthUser;
  /** 会话的绝对过期时刻（ISO 8601）。界面可以据此提示"登录已过期"。 */
  expiresAt: string;
}

export interface MeResponse {
  user: AuthUser;
  /**
   * 这个角色实际持有的权限点。
   * 前端拿它决定导航项显隐；**服务端不依赖它做校验**（服务端自己算，
   * 不信客户端送来的任何东西）。
   */
  permissions: readonly Permission[];
}

export interface LogoutResponse {
  /** 是否真的删掉了一个会话。false 表示请求本来就没带有效的会话。 */
  loggedOut: boolean;
}
