/**
 * 管理端概览的契约（阶段 4C）。
 *
 * 【为什么"看不到"要表示成 `null`，而不是省掉这个字段】
 *   同一个 `/admin` 概览会被三类人打开：只管用户的、只看活跃的、只管配置的
 *   （侧栏与路由守卫用的都是 `ADMIN_ENTRY_PERMISSIONS` 这个"任意一个即可"的集合）。
 *   某个人具体该看到哪几块，**由服务端按权限算**。用 `null` 表达"你没这个权限"，
 *   前端就只需要判空 —— 如果改成前端自己再判一遍权限，同一条规则就有了两份实现，
 *   而它们迟早会不一致（那正是 4B 踩过的坑：侧栏与守卫各判一次，结果一个看得见、
 *   一个进不去）。
 *
 * 【为什么不用"整个接口要么全给要么 403"】
 *   那会让"只持有 patrol.manage 的人"打不开一页他明明在侧栏看得见的概览。
 *   概览本来就是**几块不同敏感度的数据的拼盘**，按块授权才符合它的形状。
 */
import type { AskOutcome } from './answer.ts';
import type { Role } from './auth.ts';
import type { Material } from './documents.ts';
import type { MyUsageTotals } from './me.ts';

export interface AdminUserStats {
  total: number;
  active: number;
  disabled: number;
  /** 按角色分组的计数。只列出实际有人担任的角色 */
  byRole: readonly { role: Role; count: number }[];
}

export interface AdminDocStats {
  total: number;
  byMaterial: readonly { material: Material; count: number }[];
  /** 切片总数（检索的最小单位） */
  chunks: number;
  /** 已算出向量、能被语义检索到的切片数 */
  embedded: number;
  /**
   * 有切片但没向量的切片数。**大于 0 就说明索引没跑完** ——
   * 那些切片只有关键词检索能命中，语义检索会漏掉它们。
   *
   * 【为什么用"没算向量"而不是 documents.status】`documents.status` 只有
   *   ready 一档（解析失败是在 `upload.ts` 就拒掉的），它答不了"向量算完没有"。
   *   真正能回答这个问题的是 `chunk_embeddings` 里有没有对应的行。
   */
  missingEmbeddings: number;
}

export interface AdminActivityItem {
  runId: string;
  askedAt: string;
  /**
   * 提问人的显示名。**`null` 表示"这条没有归属"，即阶段 1–3 的公共历史记录**，
   * 不是"匿名提问" —— 那时还没有登录这回事，界面上必须把这两件事分开说。
   */
  asker: string | null;
  outcome: AskOutcome;
  /** 问题原文。不脱敏，也不截断（截断由界面按宽度做） */
  question: string;
}

export interface AdminOverviewResponse {
  /** 需要 `users.manage`；否则为 null */
  users: AdminUserStats | null;
  /** 需要 `knowledge.read`；否则为 null */
  documents: AdminDocStats | null;
  /** 最近若干条问答。需要 `askRecord.read.all`；否则为 null */
  recentAsks: readonly AdminActivityItem[] | null;
  /** 生成时刻，让界面能说清"这个数字是什么时候的" */
  generatedAt: string;
}

/**
 * 用量报表里的一个分组（按人或按日）。
 *
 * 【为什么给 `key` 又给 `label`】`key` 是判据（userId / 'YYYY-MM-DD'），
 *   `label` 是给人看的（显示名 / 本地日期）。只给 label 的话，
 *   界面想按 key 排个序、或者把两天的桶对上，就得反过来去解析 label。
 */
export interface UsageBucket {
  key: string;
  label: string;
  totals: MyUsageTotals;
  /**
   * 这一桶是"没有归属"的调用（阶段 1–3，`usage_events.user_id` 为 NULL）。
   * 界面据此把它单独说明，而不是混进"按人"里当成一个叫"未记录"的人。
   */
  isUnattributed?: boolean;
}

/**
 * GET /api/v1/admin/usage 的响应体（阶段 6，需求 7）。
 *
 * 【统计口径必须跟着数字一起出去】`since` 为 null 表示"全部历史"。
 *   一个不写时间范围的费用数字，用户没法判断它说的是"这个月"还是"有史以来"——
 *   而这直接决定他会不会据此去要预算。
 *
 * 【为什么 byDay 按**本地日**分桶】见 usage/repo.ts 的 `dayOf`：
 *   用 `substr(created_at,1,10)` 分的是 UTC 日，东八区凌晨 0–8 点的调用
 *   会被归到前一天。同一个坑在 RecentRail 的归月上已经踩过一次。
 */
export interface AdminUsageResponse {
  total: MyUsageTotals;
  /** 合计的起始时刻；null = 全部历史 */
  since: string | null;
  /** 按人分组，用量多的在前 */
  byUser: readonly UsageBucket[];
  /** 按本地日分组，最近的在前面 */
  byDay: readonly UsageBucket[];
  /**
   * 配额（03 号 §7 的 A 类成本边界）。本阶段**只读展示**，不阻断任何请求。
   * `configured` 为 false 时界面如实写"未设配额"—— 而不是显示 0，
   * 那会被读成"配额是 0、即将用完"。
   */
  quota: {
    configured: boolean;
  };
}
