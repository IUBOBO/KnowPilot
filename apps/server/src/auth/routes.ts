/**
 * 「路由 → 需要什么」的唯一事实来源，以及启动时的覆盖自检。
 *
 * 【为什么要有这张表，而不是在每个路由上写一行中间件】
 *   写 `app.get(path, requirePermission('x'), handler)` 的话，"这条路由要什么"
 *   是散在 2000 行里的 35 处。漏写一处不会报错，只会**静默放行** ——
 *   而那正是设计文档里"权限边界必须在服务层强制"要防的事，且漏掉的那条
 *   往往是后加的、最不引人注意的写接口。
 *
 *   集中成一张表之后，规则变成一个可以整体检查的对象：接口在
 *   `verifyRouteCoverage` 里对着 app.routes 逐条核对，**没登记的路由会让
 *   服务起不来**（而不是悄悄放行）。"忘了加权限"从运行时漏洞变成了启动期错误。
 *
 * 【为什么规则是字符串而不是枚举】
 *   `'public' | 'authenticated' | Permission` —— 权限点本身是带点的字符串，
 *   永远不会等于前两个字面量，所以这个联合类型不会有歧义，读起来也最省事。
 */
import type { Permission } from '@knowpilot/shared';

export type RouteRule = 'public' | 'authenticated' | Permission;

export interface RoutePermission {
  method: string;
  path: string;
  rule: RouteRule;
}

/**
 * 全部 `/api/v1/*` 路由的权限登记表。
 *
 * 顺序与 app.ts 里的注册顺序一致，便于对着看。
 */
export const ROUTE_PERMISSIONS: readonly RoutePermission[] = [
  // ── 认证 ──────────────────────────────────────────────────
  // 登录必须公开（还没有会话），但要限流 —— 限流在 handler 里做，
  // 不属于"需要什么身份"这一类。
  { method: 'POST', path: '/api/v1/auth/login', rule: 'public' },
  { method: 'POST', path: '/api/v1/auth/logout', rule: 'authenticated' },
  { method: 'GET', path: '/api/v1/auth/me', rule: 'authenticated' },

  // ── 「我的」（阶段 4B）─────────────────────────────────────
  // 两个接口都只返回**自己**的行（严格 `user_id = 我`），所以最弱的
  // `authenticated` 就是对的权限 —— 行级过滤已经由 repo 函数保证，
  // 这里再叠一层权限点只会多一个要同步的地方。
  // 用量仍登记 `usage.read.own`：它是阶段 6 用量治理的同一个权限点，
  // 现在就把它用起来，免得 4C/6 再改一遍。
  { method: 'GET', path: '/api/v1/me/overview', rule: 'authenticated' },
  { method: 'GET', path: '/api/v1/me/usage', rule: 'usage.read.own' },

  // ── 管理端概览（阶段 4C）───────────────────────────────────
  // 登记 `authenticated` 是刻意的：这一页是几块敏感度不同的数据拼起来的，
  // 而放行它的是 `ADMIN_ENTRY_PERMISSIONS`（任意一个即可）—— 这张表里没有
  // anyOf 这一档，硬挑一个权限点登记就会把只持有另一项的人挡在外面。
  // 边界改为落在**每块数据各自的权限点**上，没有的那块返回 null 且不查
  // （见 admin/repo.ts 的 AdminOverviewScope）：拿不到的数据不会进内存。
  { method: 'GET', path: '/api/v1/admin/overview', rule: 'authenticated' },

  // ── 账号管理（阶段 4C 单元 ②）──────────────────────────────
  // 四个接口都是 `users.manage`，也就是只有 admin 有。没有更细的分档：
  // "能看账号列表"与"能改账号"在本项目里不是两件事 —— 列表里全是用户名与
  // 角色，看见它的唯一用处就是去改，为此再拆一个 `users.read` 只是多一个
  // 要同步的地方。列表自身**不含**任何凭据（见 shared/users.ts）。
  { method: 'GET', path: '/api/v1/users', rule: 'users.manage' },
  { method: 'POST', path: '/api/v1/users', rule: 'users.manage' },
  { method: 'PATCH', path: '/api/v1/users/:id', rule: 'users.manage' },
  // 重置口令。与 PATCH 分开是因为它有一个 PATCH 没有的副作用：
  // **必须踢掉那个人的全部会话**（会话里不带口令，不踢则旧 token 照样能用）。
  { method: 'POST', path: '/api/v1/users/:id/password', rule: 'users.manage' },
  // ── 系统配置（阶段 4C 单元 ③）──────────────────────────────
  // 【★ 这里原来是 `authenticated`，且注释写着"配置里不含密钥明文" —— 那句话
  //   与代码不符】当时的 GET 把 `system_config` 的 `value` **原样**行出来，
  //   而表里存的正是搜索服务的 API key 明文（命令行 `set-config` 写进去的那把）。
  //   也就是说：任何登录成员都能拿到它。注释描述的是一个**没有实现的属性**，
  //   而它是靠"读的人相信注释"来生效的 —— 这类"注释担保的安全性质"必须当作
  //   未实现来对待，并且要有代码去兑现（现在是按键名掩码，见 admin/config.ts）。
  //   规则同时收紧到 `system.config`：这一页读完能做的事就是改它。
  { method: 'GET', path: '/api/v1/system-config', rule: 'system.config' },
  { method: 'PATCH', path: '/api/v1/system-config', rule: 'system.config' },
  // 测试连接同样只给 admin：它能指定任意外站地址让服务端去打（见 app.ts 的注释）。
  { method: 'POST', path: '/api/v1/system-config/test-connection', rule: 'system.config' },

  // ── 文档（阶段 1）──────────────────────────────────────────
  { method: 'POST', path: '/api/v1/documents', rule: 'material.upload' },
  { method: 'GET', path: '/api/v1/documents', rule: 'knowledge.read' },
  { method: 'POST', path: '/api/v1/documents/:id/reindex', rule: 'material.manage' },

  // ── 检索与原文（阶段 1/2）──────────────────────────────────
  { method: 'GET', path: '/api/v1/search', rule: 'knowledge.read' },
  // ⌘K 命令面板（O10）。登记最弱的 `authenticated` 是刻意的：它把三类
  // 敏感度不同的结果拼在一个响应里，而这张表没有 anyOf 这一档。边界改为
  // 落在 handler 内**每一类各自的读权限**上（见 app.ts 的 quick-search），
  // 拿不到权限的那一类不会进内存，也不会出现在响应里。
  { method: 'GET', path: '/api/v1/quick-search', rule: 'authenticated' },
  { method: 'GET', path: '/api/v1/chunks/:chunkId', rule: 'knowledge.read' },
  // 下载原件：阶段 4 之前是"能打开页面的人都能凭 id 把原件完整下载走"。
  // 现在至少要求登录 + 读知识库的权限。未发表边界本期不做（见 plan 决定 2）。
  { method: 'GET', path: '/api/v1/documents/:id/file', rule: 'knowledge.read' },

  // ── 问答（阶段 2）──────────────────────────────────────────
  { method: 'POST', path: '/api/v1/ask', rule: 'chat.use' },
  { method: 'POST', path: '/api/v1/ask/stream', rule: 'chat.use' },
  // 可续跑任务（S7/X1b）：归属校验在 handler 里（别人的任务一律 404）。
  { method: 'GET', path: '/api/v1/agent-tasks/:taskId', rule: 'chat.use' },
  { method: 'POST', path: '/api/v1/agent-tasks/:taskId/resume', rule: 'chat.use' },
  // 提问原文不脱敏，所以可见范围要收：own 是底限，read.all 由行级过滤决定看多少。
  { method: 'GET', path: '/api/v1/ask-records', rule: 'askRecord.read.own' },
  { method: 'POST', path: '/api/v1/ask-records/:runId/review', rule: 'chat.use' },
  // 回答反馈（O5）：写只要 `chat.use` —— 能给自己的运行打分是提问能力的一部分。
  // 归属校验在 handler 里（别人的运行与不存在的运行一律 404）。
  { method: 'POST', path: '/api/v1/ask-records/:runId/feedback', rule: 'chat.use' },

  // ── 投稿台账（阶段 3 单元 ②）───────────────────────────────
  { method: 'GET', path: '/api/v1/submissions', rule: 'submission.read.all' },
  { method: 'POST', path: '/api/v1/submissions', rule: 'submission.write.own' },
  { method: 'PATCH', path: '/api/v1/submissions/:id', rule: 'submission.write.own' },
  { method: 'POST', path: '/api/v1/submissions/:id/status', rule: 'submission.write.own' },
  { method: 'DELETE', path: '/api/v1/submissions/:id', rule: 'authenticated' },
  { method: 'GET', path: '/api/v1/people', rule: 'people.read' },
  { method: 'GET', path: '/api/v1/people/:id', rule: 'people.read' },
  { method: 'POST', path: '/api/v1/people', rule: 'people.manage' },
  { method: 'PATCH', path: '/api/v1/people/:id', rule: 'people.manage' },
  { method: 'GET', path: '/api/v1/patents', rule: 'patent.read.all' },
  { method: 'GET', path: '/api/v1/patents/:id', rule: 'patent.read.all' },
  { method: 'POST', path: '/api/v1/patents', rule: 'patent.write.own' },
  { method: 'PATCH', path: '/api/v1/patents/:id', rule: 'patent.write.own' },
  { method: 'DELETE', path: '/api/v1/patents/:id', rule: 'authenticated' },
  { method: 'GET', path: '/api/v1/theses', rule: 'thesis.read' },
  { method: 'GET', path: '/api/v1/theses/:id', rule: 'thesis.read' },
  { method: 'POST', path: '/api/v1/theses', rule: 'authenticated' },
  { method: 'PATCH', path: '/api/v1/theses/:id', rule: 'authenticated' },
  { method: 'DELETE', path: '/api/v1/theses/:id', rule: 'authenticated' },
  { method: 'GET', path: '/api/v1/ledger-deletions', rule: 'ledger.deletions.read' },
  { method: 'POST', path: '/api/v1/ledger-deletions/:id/restore', rule: 'ledger.delete.all' },
  { method: 'GET', path: '/api/v1/ledger-imports', rule: 'authenticated' },
  { method: 'POST', path: '/api/v1/ledger-imports', rule: 'authenticated' },
  { method: 'GET', path: '/api/v1/ledger-imports/:id', rule: 'authenticated' },
  { method: 'PATCH', path: '/api/v1/ledger-imports/:id/rows/:rowId', rule: 'authenticated' },
  { method: 'POST', path: '/api/v1/ledger-imports/:id/rows/:rowId/import', rule: 'authenticated' },
  { method: 'POST', path: '/api/v1/ledger-imports/:id/import-ready', rule: 'authenticated' },
  { method: 'GET', path: '/api/v1/ledger-exports/template', rule: 'authenticated' },
  { method: 'GET', path: '/api/v1/ledger-exports/example', rule: 'authenticated' },
  { method: 'POST', path: '/api/v1/ledger-exports/data', rule: 'authenticated' },
  { method: 'GET', path: '/api/v1/submissions/:id/rounds', rule: 'submission.read.all' },
  { method: 'POST', path: '/api/v1/submissions/:id/rounds', rule: 'submission.write.own' },

  // ── 期刊分区库（阶段 3 增补 C）─────────────────────────────
  { method: 'GET', path: '/api/v1/journals', rule: 'journal.read' },
  { method: 'GET', path: '/api/v1/journals/:id/rankings/evidence', rule: 'journal.read' },
  // 新增：补录缺失的刊与分区，所有登录成员都能做（用户原话"支持用户自己添加"）
  { method: 'POST', path: '/api/v1/journals', rule: 'journal.add' },
  { method: 'POST', path: '/api/v1/journals/:id/rankings', rule: 'journal.add' },
  // 订正与删除：动的是已经有人在依赖的公共数据，收敛到 admin/mentor
  { method: 'PATCH', path: '/api/v1/journals/:id', rule: 'journal.manage' },
  { method: 'PATCH', path: '/api/v1/journals/:id/rankings/:rankingId', rule: 'journal.manage' },
  { method: 'DELETE', path: '/api/v1/journals/:id/rankings/:rankingId', rule: 'journal.manage' },

  // ── 代码与数据集（阶段 3 单元 ③ 与增补 B）──────────────────
  // 读是团队共享的：数据集登记本来就是为了让大家知道"数据在哪"，
  // 所以列表与详情**不按归属过滤**。归属只决定能不能改。
  { method: 'GET', path: '/api/v1/code-assets', rule: 'code.read' },
  { method: 'GET', path: '/api/v1/code-assets/:id/evidence', rule: 'code.read' },
  { method: 'POST', path: '/api/v1/code-assets', rule: 'code.register' },
  { method: 'POST', path: '/api/v1/code-assets/check', rule: 'code.register' },
  { method: 'POST', path: '/api/v1/code-assets/:id/check', rule: 'code.register' },
  { method: 'PATCH', path: '/api/v1/code-assets/:id', rule: 'code.write' },
  { method: 'DELETE', path: '/api/v1/code-assets/:id', rule: 'code.write' },
  { method: 'GET', path: '/api/v1/code-assets/:id/organize-plans', rule: 'code.read' },
  // 整理会在数据集目录里真实地移动文件，是本项目风险最高的写动作
  { method: 'POST', path: '/api/v1/code-assets/:id/organize', rule: 'code.write' },
  { method: 'POST', path: '/api/v1/code-assets/:id/organize/preview', rule: 'code.write' },
  { method: 'POST', path: '/api/v1/code-assets/:id/organize/execute', rule: 'code.write' },
  // 撤销同样是真实移动：与执行同一档权限
  { method: 'POST', path: '/api/v1/code-assets/:id/organize-plans/:planId/undo', rule: 'code.write' },

  // ── 分片上传（阶段 3 单元 ③）───────────────────────────────
  // 上传的目标是数据集目录，所以与"登记数据集"同一档权限。
  { method: 'GET', path: '/api/v1/uploads', rule: 'code.register' },
  { method: 'POST', path: '/api/v1/uploads', rule: 'code.register' },
  { method: 'GET', path: '/api/v1/uploads/:id', rule: 'code.register' },
  { method: 'PUT', path: '/api/v1/uploads/:id/chunks/:index', rule: 'code.register' },
  { method: 'POST', path: '/api/v1/uploads/:id/complete', rule: 'code.register' },
  { method: 'DELETE', path: '/api/v1/uploads/:id', rule: 'code.register' },

  // ── 知识沉淀（阶段 5）──────────────────────────────────────
  // 【静态段写在动态段前面】`/api/v1/knowledge/review` 与 `/api/v1/knowledge/:id/...`
  //   段数不同（3 vs 4），本不会互相遮蔽；但把静态段写在前面是本仓库的既有习惯
  //   （见 app.ts「全部核对必须写在前面」那句），照做免得后人以为漏了。
  //
  // 读：行级范围在 SQL 里收口（knowledgeScope —— 有 review 的看全部，否则只看
  // 自己提交的），所以这里登记最弱的 knowledge.read 即可。
  { method: 'GET', path: '/api/v1/knowledge', rule: 'knowledge.read' },
  // 生成草案：会调模型，是写动作（落一行 group），用 submit。
  { method: 'POST', path: '/api/v1/knowledge/drafts', rule: 'knowledge.submit' },
  // 审核队列：只有 review 者进得来（队列里是**所有人**的待确认/冲突条目）。
  { method: 'GET', path: '/api/v1/knowledge/review', rule: 'knowledge.review' },
  // 确认整组：提交人（owner）或有 review 权限的人都可，owner 判在 handler 里。
  { method: 'POST', path: '/api/v1/knowledge/groups/:groupId/confirm', rule: 'knowledge.submit' },
  // 驳回单条：同上，owner-or-review 判在 handler 里。
  { method: 'POST', path: '/api/v1/knowledge/:id/reject', rule: 'knowledge.submit' },
  // 撤回一条已生效的知识：同上，owner-or-review 判在 handler 里。
  { method: 'POST', path: '/api/v1/knowledge/:id/withdraw', rule: 'knowledge.submit' },
  // 重新提交一条已驳回/已撤回的知识：同上，owner-or-review 判在 handler 里。
  { method: 'POST', path: '/api/v1/knowledge/:id/resubmit', rule: 'knowledge.submit' },
  // 裁决冲突：只有 review 者能对别人的冲突条目下裁决。
  { method: 'POST', path: '/api/v1/knowledge/:id/resolve', rule: 'knowledge.review' },

  // ── 巡检（阶段 6）──────────────────────────────────────────
  // 规则与"立即巡检"归 `patrol.manage`：它们动的是全实验室共用的判定规则，
  // 成员没有规则可配、也没有替所有人跑巡检的职责。
  { method: 'GET', path: '/api/v1/patrol/rules', rule: 'patrol.manage' },
  { method: 'PATCH', path: '/api/v1/patrol/rules', rule: 'patrol.manage' },
  { method: 'POST', path: '/api/v1/patrol/run', rule: 'patrol.manage' },
  // 待办列表与忽略登记 `authenticated`：成员要看**自己的**待办。
  // 可见性由 repo 里的 SQL 谓词收口（有 patrol.manage 看全部，否则只看严格
  // 属于自己的），所以这里最弱的 authenticated 就是对的权限 —— 与 /me/* 同理，
  // 行级过滤已经保证了边界，再叠一个权限点只会多一个要同步的地方。
  { method: 'GET', path: '/api/v1/patrol/tasks', rule: 'authenticated' },
  { method: 'POST', path: '/api/v1/patrol/tasks/:id/dismiss', rule: 'authenticated' },

  // ── 用量治理（阶段 6）──────────────────────────────────────
  // 全实验室的花费与每个人的用量，归 `usage.read.all`（与成员自己的
  // `/me/usage` 的 `usage.read.own` 是两个权限点："我的账"与"所有人的账"）。
  { method: 'GET', path: '/api/v1/admin/usage', rule: 'usage.read.all' },

  // ── 回答反馈（O5，管理端）──────────────────────────────────
  // 列表与导出是**别人**的赞踩与提问原文，和问答记录同档收在 admin 一侧。
  // 导出会写 `feedback_exports` 审计行，所以是 POST 不是 GET。
  { method: 'GET', path: '/api/v1/admin/feedback', rule: 'feedback.manage' },
  { method: 'POST', path: '/api/v1/admin/feedback/:runId/export', rule: 'feedback.manage' },

  // ── 运行 Trace（O7，管理端只读）────────────────────────────
  // 单独一个权限点，只给 admin：Trace 是运维视角的诊断数据（预算、工具查询词、
  // 提示词哈希），不是"能看问答记录"的延伸。普通成员在两处都进不来 ——
  // 路由守卫与服务端闸门用的是同一个权限点。
  { method: 'GET', path: '/api/v1/admin/traces', rule: 'trace.read.all' },
  { method: 'GET', path: '/api/v1/admin/traces/:runId', rule: 'trace.read.all' },
];

const LOOKUP: ReadonlyMap<string, RouteRule> = new Map(
  ROUTE_PERMISSIONS.map((r) => [`${r.method} ${r.path}`, r.rule]),
);

/**
 * 查这条路由要什么。返回 undefined 表示**未登记** —— 调用方必须按"拒绝"处理，
 * 不能当作"放行"。
 */
export function ruleFor(method: string, path: string): RouteRule | undefined {
  return LOOKUP.get(`${method} ${path}`);
}

/**
 * 启动自检：app.routes 里每一条 `/api/v1/*` 的真实处理函数，都必须在表里。
 *
 * 抛错而不是打日志：日志会被淹没，而这是"服务带着一个没有权限校验的接口
 * 上线了"这种级别的错误 —— 起不来才是正确的反应。
 *
 * 中间件（`app.use`，method 为 ALL、path 以 `*` 结尾）不参与检查：
 * 它们不是可被访问的端点。
 */
export function verifyRouteCoverage(
  routes: readonly { method: string; path: string }[],
): void {
  const missing: string[] = [];
  for (const route of routes) {
    if (!route.path.startsWith('/api/v1')) continue;
    if (route.path.endsWith('*')) continue;
    if (ruleFor(route.method, route.path) === undefined) {
      missing.push(`${route.method} ${route.path}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      '以下接口没有登记权限规则，拒绝启动（否则它们会对任何人开放）：\n  ' +
        missing.join('\n  ') +
        '\n请把它们加进 apps/server/src/auth/routes.ts 的 ROUTE_PERMISSIONS。',
    );
  }
}
