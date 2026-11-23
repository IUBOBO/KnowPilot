/**
 * 行级可见范围：把"这个人能看到哪些行"变成一个能直接拼进 SQL 的谓词。
 *
 * 【为什么必须落在 SQL 层，而不是查出来再筛】
 *   检索后再筛有两个绕不开的问题：
 *   1. `LIMIT` 的语义会变。先取 50 行再筛掉 30 行，用户看到的是"只有 20 条"，
 *      而库里明明有 200 条他能看的 —— 看起来像数据丢了。
 *   2. 只要有一条代码路径忘了筛，它就是一个越权口子，而"忘了筛"不会有任何症状。
 *   放进 WHERE 之后，过滤是**查询本身的一部分**：拿不到的行根本没进内存，
 *   也不可能被后续任何一处忘记处理。
 *
 * 【判据：owner IS NULL = 公共历史数据】
 *   阶段 1–3 全程没有登录，那段时间产生的记录（投稿、问答、数据集）
 *   归属列全是 NULL。它们不属于任何人，就按"公共历史数据"处理 ——
 *   所有登录用户可见。这与"不强行把历史数据洗成某个人的"是同一条决定
 *   （见 plan 决定 2）：洗了就是在编造"谁提交的"，而那正是审计最不该出错的地方。
 */
import { hasPermission, type AuthUser } from '@knowpilot/shared';

export interface RowScope {
  /** 当前用户 id。走到 repo 的调用一定已经过了路由闸门，所以不是 null */
  userId: string;
  /** 能看到全部记录（含他人的、公共的） */
  canReadAll: boolean;
  /**
   * 能看到本组的记录。
   *
   * 【为什么"我的组是 NULL"要当成"与所有人同组"】`users.group_id` 现在全是
   *   NULL —— 阶段 1–3 没有登录，也就没有人被分过组。若照字面实现
   *   `group_id = 我的组`，导师看到的台账就只剩自己那几条，界面看起来像
   *   "大家的记录不见了"，而实际原因是他没被分组。
   *   单实验室本来就只有"一个还没起名字的组"，所以 NULL 视为同组：
   *   行为与阶段 1–3 连续。4C 给用户分配 group_id 之后，谓词自然收窄，
   *   这段 SQL 一个字都不用改。
   */
  canReadGroup: boolean;
  /** 我的组；null = 未分组（见上） */
  groupId: string | null;
}

/**
 * 归属列的表达形式。写成联合类型而不是任意字符串：
 * 这段 SQL 是拼出来的，而拼接必然要防注入。约束它的取值只有这几种，
 * 就没有"某天有人把用户输入传进来"这条路。
 */
export type OwnerColumn = 's.user_id' | 'user_id' | 'created_by';

/**
 * 拼出可见性谓词，附带对应的绑定值。
 *
 * 参数顺序与 SQL 里 `?` 的出现顺序严格一致：canReadAll、userId、
 * canReadGroup、groupId、groupId。
 */
export function scopePredicate(
  column: OwnerColumn,
  scope: RowScope,
): { sql: string; params: readonly (string | number | null)[] } {
  const sql =
    `(? = 1` +
    ` OR ${column} IS NULL` +
    ` OR ${column} = ?` +
    ` OR (? = 1 AND (? IS NULL OR ${column} IN (SELECT id FROM users WHERE group_id = ?))))`;
  return {
    sql,
    params: [
      scope.canReadAll ? 1 : 0,
      scope.userId,
      scope.canReadGroup ? 1 : 0,
      scope.groupId,
      scope.groupId,
    ],
  };
}

/**
 * 没有身份时用的范围：**除了公共历史数据，什么都看不到**。
 *
 * 【什么时候会走到这里】HTTP 路由的闸门已经把未登录挡在外面了，所以
 *   正常请求永远拿不到它。它服务于两类调用：验证脚本直接调 repo / runAsk
 *   （不经过 HTTP），以及将来可能出现的后台任务。
 *
 *   `userId` 用一个空的字符串而不是 null：它是"匹配不到任何一行"的哨兵值
 *   （真实 id 是 UUID，不可能是空串）。这样 SQL 里不需要额外分支 ——
 *   分支越多，越容易在某条路径上退化成"不过滤"。
 */
export const PUBLIC_ONLY_SCOPE: RowScope = {
  userId: '',
  canReadAll: false,
  canReadGroup: false,
  groupId: null,
};

/**
 * 看全部。
 *
 * ⚠️ **只能用于"已经在库文件所在的机器上、直接开库"的运维入口**
 * （`usage-cli.ts` 对账、验证脚本）。它的前提是"能做这件事的人本来就能
 * 用 sqlite3 把整张表读出来"，所以这里不放行也拦不住谁。
 *
 * 它**绝不能出现在请求路径上**。给请求用的范围一律由
 * `submissionScope` / `askRecordScope` 从角色的权限推导 ——
 * 那两个函数的返回值里，canReadAll 只可能来自一条明确的权限授予。
 */
export const OPERATOR_SCOPE: RowScope = {
  userId: '',
  canReadAll: true,
  canReadGroup: false,
  groupId: null,
};

/** 投稿台账的可见范围。所有登录角色均获 submission.read.all；无身份仍只见公共历史行。 */
export function submissionScope(user: AuthUser | null): RowScope {
  if (user === null) return PUBLIC_ONLY_SCOPE;
  return {
    userId: user.id,
    canReadAll: hasPermission(user.role, 'submission.read.all'),
    canReadGroup: hasPermission(user.role, 'submission.read.group'),
    groupId: user.groupId,
  };
}

/**
 * 问答记录的可见范围。**没有"本组"这一档** —— 提问原文不脱敏，
 * 本组仍是一群同事，看见彼此的提问原文不是当初要的粒度（用户 2026-10-11
 * 拍板 own + all）。所以 canReadGroup 恒为 false。
 */
export function askRecordScope(user: AuthUser | null): RowScope {
  if (user === null) return PUBLIC_ONLY_SCOPE;
  return {
    userId: user.id,
    canReadAll: hasPermission(user.role, 'askRecord.read.all'),
    canReadGroup: false,
    groupId: null,
  };
}

/**
 * 知识条目的可见范围。
 *
 * 【为什么判据是 `knowledge.review` 而不是另造"读全部"权限】在这个模块里，
 *   "能看到全部人的条目"这件事的**唯一实际用途**就是审核（导师要在
 *   `/admin/review` 看到成员的待确认草案与冲突条目）。导师本就有 review 权限，
 *   所以直接拿它当"看全部"的判据，不新造一个配了却没人用的点。
 *   普通成员只看得到自己提交的，看不见别人的草稿 —— 那既没必要也不该被看到。
 *
 * 【没有"本组"档】知识条目的粒度是"个人提交的一条"，按课题组切没有意义，
 *   所以 canReadGroup 恒 false。
 */
export function knowledgeScope(user: AuthUser | null): RowScope {
  if (user === null) return PUBLIC_ONLY_SCOPE;
  return {
    userId: user.id,
    canReadAll: hasPermission(user.role, 'knowledge.review'),
    canReadGroup: false,
    groupId: null,
  };
}

/**
 * 分片上传会话的可见范围（`upload_sessions`）。
 *
 * 【为什么这一档判据是"是不是管理员"，而不是某个权限点】
 *   上面那条"canReadAll 只可能来自一条明确的权限授予"的纪律，在这里**有意破例**：
 *   会话不是知识资产，它是一次**进行中的搬运**（谁往哪个目录搬什么，搬到了几成）。
 *   真实使用它的人只有两种 —— 搬东西的那个人自己，和要把这台机器管明白的管理员。
 *   为它新造一个 `upload.read.all` 权限点，结果是多出一个"配了却没人会去用"的点，
 *   而管理员本来就在 `assertCanWriteAsset` 那一类地方按 `role === 'admin'` 特判
 *   （同一个判据，同一处代码风格）。
 *
 * 【为什么"本组"这一档是关的】同一次搬运的可见性不该按部门切 —— 组里的同事
 *   看到你在往哪搬、搬到几成，既帮不上忙，也不该知道。所以 canReadGroup 恒 false。
 */
export function uploadScope(user: AuthUser | null): RowScope {
  if (user === null) return PUBLIC_ONLY_SCOPE;
  return {
    userId: user.id,
    canReadAll: user.role === 'admin',
    canReadGroup: false,
    groupId: null,
  };
}
