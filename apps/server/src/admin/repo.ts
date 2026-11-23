/**
 * 管理端概览的聚合查询（阶段 4C）。
 *
 * 【为什么把权限当成入参传进来，而不是在这里读当前用户】
 *   这里只管"取数"，不管"谁在问"。权限由调用方（handler）从角色算出来，
 *   与本模块用不着 auth 依赖 —— 这与 `auth/scope.ts` 的 `scopePredicate`
 *   是同一条分工：**算范围的人一个地方，用范围的人各自一处**。
 *
 * 【为什么没权限的那两块是整个"不查"，而不是查出来再丢掉】
 *   查出来再丢掉，就等于"敏感数据已经在内存里走了一趟"，而只要有一条
 *   调用方忘了丢，它就会漏出去 —— 而这种错误没有任何症状。
 *   不查，就没有可漏的东西。
 */
import type {
  AdminActivityItem,
  AdminDocStats,
  AdminOverviewResponse,
  AdminUserStats,
  AskOutcome,
  Material,
  Role,
} from '@knowpilot/shared';
import type { Db } from '../db/index.ts';

/** 概览只给最近几条活跃。要看得更多有「问答记录」页（那里是分页列表）。 */
const RECENT_ASK_LIMIT = 5;

export interface AdminOverviewScope {
  /** 看文档与索引统计（对应 `knowledge.read`） */
  canReadDocuments: boolean;
  /** 看用户数与角色分布（对应 `users.manage`） */
  canManageUsers: boolean;
  /** 看最近问答里的人（对应 `askRecord.read.all`） */
  canReadActivity: boolean;
}

/**
 * @param model 嵌入模型标识（如 `bge-m3-q8`）。用于判断"哪些切片算已经索引好"——
 *   换模型后旧向量属于另一个模型，不该被算成已索引（见 `chunk_embeddings.model` 注释）。
 */
export function adminOverview(
  db: Db,
  model: string,
  scope: AdminOverviewScope,
  now: Date,
): AdminOverviewResponse {
  return {
    users: scope.canManageUsers ? userStats(db) : null,
    documents: scope.canReadDocuments ? docStats(db, model) : null,
    recentAsks: scope.canReadActivity ? recentAsks(db) : null,
    generatedAt: now.toISOString(),
  };
}

interface UserCountRow {
  role: Role;
  status: string;
  n: number;
}

function userStats(db: Db): AdminUserStats {
  const rows = db
    .prepare('SELECT role, status, COUNT(*) AS n FROM users GROUP BY role, status')
    .all() as unknown as UserCountRow[];

  const byRole = new Map<Role, number>();
  let active = 0;
  let total = 0;
  for (const row of rows) {
    byRole.set(row.role, (byRole.get(row.role) ?? 0) + row.n);
    total += row.n;
    if (row.status === 'active') active += row.n;
  }

  return {
    total,
    active,
    // status 上是有 CHECK 约束的（active/disabled），所以"不是 active"就只能是 disabled。
    // 用减法而不是再累加一次，是为了让 total = active + disabled 这条恒等式不依赖代码写对。
    disabled: total - active,
    byRole: [...byRole].map(([role, count]) => ({ role, count })),
  };
}

interface MaterialCountRow {
  material: Material;
  n: number;
}

function docStats(db: Db, model: string): AdminDocStats {
  const byMaterial = db
    .prepare('SELECT material, COUNT(*) AS n FROM documents GROUP BY material ORDER BY material')
    .all() as unknown as MaterialCountRow[];

  const chunks = (db.prepare('SELECT COUNT(*) AS n FROM doc_chunks').get() as unknown as { n: number }).n;
  const embedded = (
    db
      .prepare('SELECT COUNT(DISTINCT chunk_id) AS n FROM chunk_embeddings WHERE model = ?')
      .get(model) as unknown as { n: number }
  ).n;

  return {
    total: byMaterial.reduce((sum, r) => sum + r.n, 0),
    byMaterial: byMaterial.map((r) => ({ material: r.material, count: r.n })),
    chunks,
    embedded,
    // 理论上 embedded ⊆ chunks，不会为负；真出现负数说明库被人手工改过，
    // 与其显示一个负数，不如夹到 0 —— 这里要传达的是"有没有欠账"，不是精确账目。
    missingEmbeddings: Math.max(0, chunks - embedded),
  };
}

interface RecentAskRow {
  run_id: string;
  question: string;
  asked_at: string;
  outcome: string;
  asker: string | null;
}

function recentAsks(db: Db): AdminActivityItem[] {
  // LEFT JOIN 而不是 INNER JOIN：`user_id IS NULL` 的行是阶段 1–3 的公共历史记录，
  // 它们没有提问人，但**必须出现在列表里**（它们同样是"最近有人用过系统"的证据）。
  // 用 INNER JOIN 会把它们静默丢掉，界面上看起来像"那段时间没人提问"。
  const rows = db
    .prepare(
      `SELECT r.run_id, r.question, r.asked_at, r.outcome, u.display_name AS asker
       FROM ask_records r
       LEFT JOIN users u ON u.id = r.user_id
       ORDER BY r.asked_at DESC
       LIMIT ?`,
    )
    .all(RECENT_ASK_LIMIT) as unknown as RecentAskRow[];

  return rows.map((row) => ({
    runId: row.run_id,
    askedAt: row.asked_at,
    asker: row.asker,
    outcome: row.outcome as AskOutcome,
    question: row.question,
  }));
}
