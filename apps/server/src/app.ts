/**
 * HTTP 应用组装。只负责"接线"，不含业务逻辑。
 */
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import type { MutableModels } from '@earendil-works/pi-ai';
import {
  AppError,
  ASK_OUTCOMES,
  FEEDBACK_DOWN_REASONS,
  FEEDBACK_NOTE_MAX_CHARS,
  FEEDBACK_REASON_LABELS,
  hasPermission,
  isKnowledgeResubmittable,
  JOURNAL_SYSTEMS,
  KNOWLEDGE_RESOLUTIONS,
  KNOWLEDGE_STATUSES,
  KNOWLEDGE_STATUS_LABELS,
  MATERIAL_LABELS,
  MATERIALS,
  MIN_PASSWORD_LENGTH,
  PATROL_SUBJECT_STATUSES,
  PATENT_FILTERS,
  permissionsOf,
  ROLES,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  RETRIEVAL_RECORD_TYPES,
  type RecordRetrievalHit,
  type RecordRetrievalScope,
  SEARCH_MODES,
  SUBMISSION_STATUSES,
  SUBMISSION_STATUS_LABELS,
  USER_STATUSES,
  type AbortUploadResponse,
  type AddRankingResponse,
  type AdminTraceDetail,
  type AdminUsageResponse,
  type AgentTaskView,
  type ApiErrorBody,
  type AuthUser,
  type MeResponse,
  type MeOverviewResponse,
  type MeUsageResponse,
  type MyUsageTotals,
  type LoginResponse,
  type LogoutResponse,
  type AssetCheckResult,
  ASK_HISTORY_ANSWER_CHARS,
  ASK_HISTORY_LIMIT,
  ASK_HISTORY_QUESTION_CHARS,
  parseAskDocumentIds,
  parseAskDocumentScope,
  type AskDocumentScopeV1,
  type AskHistoryTurn,
  type AskOutcome,
  type AskResponse,
  type AskStreamEvent,
  type CheckCodeAssetResponse,
  type CheckCodeAssetsResponse,
  type ChunkContextResponse,
  type CodeAsset,
  type CompleteUploadResponse,
  type ConfirmKnowledgeGroupResponse,
  type CreateUploadResponse,
  type CreateUserResponse,
  type ErrorCode,
  type ExportFeedbackDraftResponse,
  type FeedbackCaseDraft,
  type FeedbackDownReason,
  type FeedbackRating,
  type GetUploadResponse,
  type HealthResponse,
  type IngestReport,
  type JournalSystem,
  type KnowledgeResolution,
  type KnowledgeReviewQueueResponse,
  type KnowledgeStatus,
  type ListAdminFeedbackResponse,
  type ListAdminTracesResponse,
  type ListAskRecordsResponse,
  type ListCodeAssetsResponse,
  type ListDocumentsResponse,
  type ListJournalsResponse,
  type ListKnowledgeEntriesResponse,
  type ListOrganizePlansResponse,
  type ListUploadsResponse,
  type ListSubmissionRoundsResponse,
  type ListSubmissionsResponse,
  type ListPeopleResponse,
  type CreatePersonResponse,
  type UpdatePersonResponse,
  type ListPatentsResponse,
  type PatentFilter,
  type CreatePatentResponse,
  type UpdatePatentResponse,
  type ListThesesResponse,
  type CreateThesisResponse,
  type UpdateThesisResponse,
  type ListLedgerBatchesResponse,
  type LedgerBatchDetailResponse,
  type UploadLedgerBatchResponse,
  type UpdateLedgerRowResponse,
  type ImportLedgerRowResponse,
  type ImportReadyResponse,
  LEDGER_IMPORT_TARGETS,
  type LedgerImportTarget,
  PERSON_STATUSES,
  PERSON_STATUS_LABELS,
  DATASET_PROFILE_LABELS,
  QUICK_SEARCH_KINDS,
  PATENT_FILTER_LABELS,
  type DatasetProfile,
  type PersonStatus,
  type ListUsersResponse,
  type Material,
  type OrganizeExecuteResponse,
  type OrganizeGenerateResponse,
  type OrganizeMessage,
  type OrganizePlan,
  type OrganizePreviewResponse,
  type OrganizeRule,
  type OrganizeUndoResponse,
  type PatrolRuleUpdate,
  type PatrolRulesResponse,
  type PatrolRunSummary,
  type PatrolSubjectStatus,
  type PatrolTasksResponse,
  type DismissPatrolTaskResponse,
  type PutChunkResponse,
  type QuickSearchHit,
  type QuickSearchResponse,
  type ReindexDocumentResponse,
  type RejectKnowledgeResponse,
  type ResolveKnowledgeResponse,
  type ResubmitKnowledgeResponse,
  type ResetPasswordResponse,
  type Role,
  type SearchMode,
  type SearchResponse,
  type CreateCodeAssetResponse,
  type CreateJournalResponse,
  type CreateSubmissionResponse,
  type CreateSubmissionRoundResponse,
  type CreateUploadRequest,
  type DeleteCodeAssetResponse,
  type DeleteRankingResponse,
  type SubmissionStatus,
  type SubmitFeedbackResponse,
  type SystemConfigResponse,
  type TestModelConnectionResponse,
  type UpdateCodeAssetRequest,
  type UpdateCodeAssetResponse,
  type UpdateJournalResponse,
  type UpdateRankingResponse,
  type UpdateSubmissionRequest,
  type UpdateSubmissionResponse,
  type UpdateSubmissionStatusResponse,
  type UpdateUserRequest,
  type UpdateUserResponse,
  type UploadDocumentResponse,
  type UserStatus,
  type WithdrawKnowledgeResponse,
} from '@knowpilot/shared';
import { adminOverview } from './admin/repo.ts';
import { deleteLedgerRecord, listLedgerDeletions, restoreLedgerRecord } from './ledger/deletions.ts';
import {
  buildDataWorkbook,
  buildExampleWorkbook,
  buildTemplateWorkbook,
} from './ledger/export.ts';
import {
  createBatch as createLedgerBatch,
  getBatch as getLedgerBatch,
  importReady as importLedgerReady,
  importRow as importLedgerRow,
  listBatches as listLedgerBatches,
  updateRow as updateLedgerRow,
  type ImportViewer,
} from './ledger/service.ts';
import {
  getThesis,
  insertThesis,
  listTheses,
  updateThesis,
  type ThesisPatch,
  type ThesisViewer,
} from './theses/repo.ts';
import {
  canWritePatent,
  createPatent,
  getPatent,
  getPatentFor,
  listPatents,
  listPatentPage,
  updatePatent,
  type PatentPatch,
  type PatentScope,
} from './patents/repo.ts';
import {
  findPersonByStudentNo,
  findPersonByUserId,
  getPerson,
  insertPerson,
  isUniqueConstraintError,
  listPeople,
  updatePerson,
  type PersonViewer,
} from './people/repo.ts';
import { knowledgeSummary, pendingForUser } from './me/repo.ts';
import {
  applySystemConfigUpdate,
  parseSystemConfigUpdate,
  parseTestConnectionRequest,
  systemConfigView,
} from './admin/config.ts';
import { rankingFields, rankingRecordId } from './agent/journal-tool.ts';
import { testModelConnection } from './agent/test-connection.ts';
import {
  AskAbortedError,
  runAsk,
  type AskFinalization,
  type AskResumeState,
} from './agent/ask-run.ts';
import { resolveAskScopeDocuments } from './agent/document-scope.ts';
import { listAskRecords, listAskRecordsByUser } from './agent/records.ts';
import { withAskRecordSources } from './agent/record-sources.ts';
import { ASK_REVIEW_MAX_CHARS, reviewAnswer } from './agent/answer-review.ts';
import { getRunTrace, insertRunTrace, listRunTraces } from './trace/repo.ts';
import {
  feedbackCounts,
  findAskRecordOwner,
  getAdminFeedback,
  insertFeedbackExport,
  listAdminFeedback,
  upsertFeedback,
} from './feedback/repo.ts';
import {
  claimResume,
  expireStaleTasks,
  finishTask,
  getLatestCheckpoint,
  getTask,
  isResumeAvailable,
  parseCheckpoint,
} from './agent/task-store.ts';
import {
  listUsageByLocalDay,
  sumUsageByUser,
  sumUsageForUser,
  sumUsageTotal,
  type UsageTotals,
} from './usage/repo.ts';
import { getDummyHash, verifyPassword } from './auth/password.ts';
import { LoginRateLimiter } from './auth/rate-limit.ts';
import { ruleFor, verifyRouteCoverage } from './auth/routes.ts';
import { askRecordScope, knowledgeScope, submissionScope, uploadScope } from './auth/scope.ts';
import { noteRevision, parseCreateNote, parseUpdateNote } from './research-notes/input.ts';
import { createResearchNote, deleteResearchNote, listResearchNotes, readResearchNote, updateResearchNote } from './research-notes/repo.ts';
import { presentResearchNote, readResearchNoteDocument, readResearchNoteRecord } from './research-notes/service.ts';
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  deleteUserSessions,
  resolveSession,
  TOUCH_INTERVAL_MS,
  // 别名：uploads/repo.ts 里也有一个同名的 touchSession（上传会话的续期），
  // 两者的参数含义完全不同（token 哈希 vs 上传会话 id）。同名不同义的两个
  // 函数放在同一个文件里，改错一个不会有编译错误 —— 只会让上传的会话
  // 永远不续期，或者把登录会话的过期时间写成一个上传 id。
  touchSession as touchLoginSession,
} from './auth/session.ts';
import {
  findByUsername,
  findUserById,
  insertUser,
  listUsers,
  normalizeUsername,
  setPassword,
  toAuthUser,
  toManagedUser,
  updateUser,
} from './auth/users.ts';
import { checkAsset, probeRoots } from './code/check.ts';
import {
  deleteCodeAsset,
  findCodeAssetByLocation,
  getCodeAsset,
  getCodeAssetEvidence,
  getCodeAssetOwner,
  insertCodeAsset,
  listCodeAssets,
  saveCheckResults,
  searchCodeAssets,
  updateCodeAsset,
} from './code/repo.ts';
import { embeddingModelKey, type AppConfig } from './config.ts';
import type { Db } from './db/index.ts';
import { isInside } from './paths.ts';
import { ingestDocument } from './documents/ingest.ts';
import { admitEntry } from './knowledge/admit.ts';
import { detectConflict } from './knowledge/conflict.ts';
import {
  assertKnowledgeDraftReady, assertKnowledgeDraftSource, createKnowledgeDrafts, editKnowledgeDraft, presentKnowledgeEntry,
  withKnowledgeDraftMutation,
} from './knowledge/drafts.ts';
import {
  findById as findEntry,
  insertResubmission,
  listByGroup,
  listReviewQueue,
  listVisible,
  markConflicted,
  markRejected,
  markSuperseded,
  markWithdrawn,
} from './knowledge/repo.ts';
import { withdrawDocumentIfUnreferenced } from './knowledge/withdraw.ts';
import { executePlan } from './organize/execute.ts';
import { expandRules } from './organize/preview.ts';
import { listPlans } from './organize/repo.ts';
import { runOrganize } from './organize/run.ts';
import { undoPlan } from './organize/undo.ts';
import {
  getChunkContext,
  getDocumentFile,
  getDocumentSummary,
  listDocuments,
  listDocumentsByUploader,
  searchDocumentTitles,
  type DocumentFileRow,
} from './documents/repo.ts';
import { retrieveDocumentPage, retrieveDocumentsV1, retrieveRecordsV1 } from './retrieval/service.ts';
import { uploadDocument } from './documents/upload.ts';
import {
  countJournals,
  createSubmission,
  createSubmissionRound,
  deleteManualRanking,
  getJournalById,
  getRankingByPeriod,
  getSubmission,
  getSubmissionFor,
  insertManualRanking,
  listRankings,
  listSubmissionRounds,
  listSubmissions,
  listSubmissionsByUser,
  searchJournals,
  searchSubmissions,
  updateJournal,
  updateManualRanking,
  updateSubmissionDetails,
  updateSubmissionStatus,
  upsertJournal,
} from './submissions/repo.ts';
import { countUserQuotas, dismissTask, listRules, listTasks, listTasksByOwner, updateRule, type PatrolViewer } from './patrol/repo.ts';
import { reconcile } from './patrol/scan.ts';
import {
  assertEnoughSpace,
  parseFileName,
  parseTargetDir,
  resolveStoredFile,
  resolveTargetDir,
  sessionKey,
} from './uploads/layout.ts';
import {
  getSession,
  insertSession,
  listSessions,
  markAborted,
  markCompleted,
  reopenSession,
  toSession,
  touchSession,
} from './uploads/repo.ts';
import {
  assembleAndPlace,
  discardChunks,
  expectedChunkBytes,
  listReceived,
  putChunk,
} from './uploads/store.ts';

export const SERVICE_NAME = 'knowpilot-server';
export const SERVICE_VERSION = '0.1.0';

export interface AppDeps {
  db: Db;
  config: AppConfig;
  schemaVersion: number;
  /** 进程启动时刻（毫秒），用于算 uptime */
  startedAt: number;
  /**
   * 进程级共享的模型集合。
   * 由 index.ts 建一次后传进来，不在每个请求里重建 —— 重建本身不贵，
   * 但会让每次调用都重新解析 provider 配置与 API Key，且让"进程内到底有几套
   * 鉴权状态"变得说不清。
   */
  models: MutableModels;
}

type Env = {
  Variables: {
    requestId: string;
    /**
     * 当前登录用户；未登录为 null。
     *
     * 【为什么"未登录"是一个正常的取值，而不是"这个变量不该存在"】
     *   登录页、`/health` 都要在**没有会话**的情况下正常响应。让中间件在
     *   解析不出来时抛 401 的话，未登录的人连登录页都打不开。
     *   所以这里如实存 null，"要不要拦"由下一层按路由决定。
     */
    user: AuthUser | null;
  };
};

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  // 向量模型标识在整个进程生命周期内不变，算一次即可。
  // 它要传给所有读写 documents 的函数 —— 摘要里要显示"这份文档有多少块建了向量"，
  // 而向量是按模型区分的，不传就无法判断该不该算数。
  const model = embeddingModelKey(deps.config);

  // ── 请求 ID ────────────────────────────────────────────────
  // 每个请求一个 ID，同时写进响应头和日志。
  // 用户报"我搜不出来"时，让他把 ID 发过来，就能在日志里定位那一整条链路。
  // 没有它排查只能靠时间戳猜，多用户并发时基本无解。
  app.use('*', async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming !== undefined && incoming !== '' ? incoming : randomUUID();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    const started = Date.now();
    await next();
    const ms = Date.now() - started;
    console.log(
      `[${requestId}] ${c.req.method} ${c.req.path} -> ${c.res.status} ${ms}ms`,
    );
  });

  // ── 会话解析 ───────────────────────────────────────────────
  //
  // 【为什么不抛 401，而是把 user 存成 null】登录页与 /health 必须在
  //   没有会话时也能正常响应。真正"要不要拦"的判断在下一个中间件里，
  //   按路由决定 —— 这一层只回答"现在是谁"，回答不出来就是"没有人"。
  //
  // 覆盖 `*` 而不是 `/api/v1/*`：/health 也走一遍，这样"当前是谁"
  // 在整条链路上的语义是统一的，将来要给 /health 加"只有管理员能看
  // 详细版本"时不必再插一层。
  app.use('*', async (c, next) => {
    const raw = getCookie(c, SESSION_COOKIE);
    const now = new Date();

    const resolved =
      raw === undefined || raw === ''
        ? null
        : resolveSession(deps.db, raw, now, deps.config.sessionIdleDays);

    c.set('user', resolved?.user ?? null);

    // 续期：只在"距上次活动超过 5 分钟"时才写库。
    // 一次页面加载会打十几个接口，每个都 UPDATE 一行的代价见 session.ts 的注释。
    if (resolved !== null && now.getTime() - new Date(resolved.lastSeenAt).getTime() > TOUCH_INTERVAL_MS) {
      touchLoginSession(deps.db, resolved.tokenHash, now);
    }

    await next();
  });

  // ── 权限闸门（默认拒绝）─────────────────────────────────────
  //
  // 【为什么是"查表 + 默认拒绝"，而不是"在每个路由上加一个中间件"】
  //   见 auth/routes.ts 顶部。一句话：散在 35 处的话，漏掉一处不会报错，
  //   只会静默放行 —— 而漏掉的往往是后加的、最不引人注意的写接口。
  //
  // 【⚠️ 别用 c.req.routePath！这一处是会静默失效的】
  //   直觉写法是 `ruleFor(c.req.method, c.req.routePath)`。**在中间件里它不是
  //   处理函数的模板，而是中间件自己的**（`/api/v1/*`）。于是每条路由都会
  //   落进"没匹配到 handler、放行"那条分支 —— 闸门变成一句空话，
  //   而且**没有任何症状**：接口照常工作，只是谁都进得来。
  //   这个错误在 4A 收尾时被 verify-auth 抓到（匿名 GET /api/v1/submissions 回了 200）。
  //
  //   正确的是 `c.req.matchedRoutes`：它是本次请求匹配到的全部路由，
  //   **最后一条就是那个处理函数**（前面是中间件）。实测：
  //     匹配到 handler  → ['ALL /api/v1/*', 'GET /api/v1/submissions']
  //     没有 handler    → ['ALL /api/v1/*']   ← 只有中间件自己
  //   后者要放行给 notFound —— 否则"访问一个不存在的接口"会变成 403，
  //   而 403 会让调用方以为"这个接口存在，只是我没权限"，去查权限。
  app.use('/api/v1/*', async (c, next) => {
    const matched = c.req.matchedRoutes;
    const target = matched[matched.length - 1];
    if (target === undefined || target.method === 'ALL') {
      await next();
      return;
    }

    const rule = ruleFor(target.method, target.path);
    if (rule === undefined) {
      // 正常情况下到不了这里：verifyRouteCoverage 已经让这种服务起不来。
      // 留这一手是因为运行期的路由表可能与启动时不同（动态注册），
      // 而这一处的正确反应永远是"拒绝"，不是"放行"。
      throw new AppError(
        'permission_denied',
        '这个接口没有登记权限规则，为安全起见拒绝访问。请把请求 ID 提供给管理员。',
      );
    }

    if (rule === 'public') {
      await next();
      return;
    }

    const user = c.get('user');
    if (user === null) {
      throw new AppError('unauthenticated', '请先登录。');
    }
    if (rule !== 'authenticated' && !hasPermission(user.role, rule)) {
      throw new AppError(
        'permission_denied',
        `当前账号（${user.role}）没有执行这个操作的权限。`,
      );
    }

    await next();
  });

  // 登录失败的限流器。**每个 app 实例一个** —— 验证脚本各自建临时 app，
  // 互相之间不会把对方的计数带过来。
  const loginLimiter = new LoginRateLimiter();

  // ── 认证 ───────────────────────────────────────────────────
  //
  // 【为什么登录是 POST 而不是 GET】它要改服务端状态（建一行 auth_sessions），
  //   而 GET 是"可以随便重放、会被预取、会进浏览器历史"的语义。
  //   把建会话放进 GET，浏览器的一次预取就能让人莫名其妙地登录。
  app.post('/api/v1/auth/login', async (c) => {
    const raw = await readJsonBody(c);
    const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const username = typeof body['username'] === 'string' ? body['username'] : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    if (username.trim() === '' || password === '') {
      throw new AppError('invalid_argument', '请填写用户名与口令。');
    }

    // 客户端 IP。**优先取真实连接地址**（见 clientIp）：
    // x-forwarded-for 是客户端可以随便写的头，拿它当限流键，攻击者
    // 每换一个假 IP 就重置一次计数 —— 那等于没有限流。
    // 只有在拿不到连接信息时（`app.request` 这种不过网络的调用）才退回它。
    const ip = clientIp(c);
    const nowMs = Date.now();
    const now = new Date(nowMs);

    // 限流在**算哈希之前**。一次 scrypt 50–100ms 且跑在线程池里，
    // 不限流的话登录接口本身就是一个廉价的 CPU DoS 放大器。
    loginLimiter.check(ip, username.trim().toLowerCase(), nowMs);

    const row = findByUsername(deps.db, username);
    // 【为什么用户不存在也要算一次哈希】见 password.ts 里 getDummyHash 的注释：
    // 直接 return 会让"用户不存在"比"密码错"快两个数量级，攻击者靠响应
    // 时间就能把用户名枚举出来。这里用同一个出口，两条路径耗时相当。
    const stored = row?.password_hash ?? (await getDummyHash());
    const ok = await verifyPassword(password, stored);

    // 状态码与文案对"用户不存在 / 密码错 / 账号被禁用"**完全一致**：
    // 任何差异都是一条"这个用户名存在"的线索。
    if (row === undefined || !ok || row.status !== 'active') {
      loginLimiter.recordFailure(ip, username.trim().toLowerCase(), nowMs);
      throw new AppError('unauthenticated', '用户名或口令不正确。');
    }

    loginLimiter.recordSuccess(ip, username.trim().toLowerCase());

    const { token, expiresAt } = createSession(deps.db, {
      userId: row.id,
      now,
      idleDays: deps.config.sessionIdleDays,
      maxDays: deps.config.sessionMaxDays,
      ip,
      userAgent: c.req.header('user-agent') ?? null,
    });

    // 【httpOnly】前端不读它（也不需要读）：一条能被 JS 读到的会话 token，
    //   等于把"XSS 能做什么"从"改页面"升级成"拿到完整账号"。
    // 【sameSite: Lax】挡跨站 POST —— 本项目的状态变更全是 POST/PATCH/DELETE。
    // 【secure 由配置决定】dev 是 http，带上它的后果是浏览器**静默丢弃**，
    //   表现为"登录返回 200 但下一个请求仍是 401"。见 config.ts 的注释。
    setCookie(c, SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: deps.config.cookieSecure,
      // 秒。与 expires_at（绝对上限）同一个时刻，两者不该有两个答案。
      maxAge: Math.max(1, Math.floor((new Date(expiresAt).getTime() - nowMs) / 1000)),
    });

    const user = toAuthUser(row);
    return c.json({ user, expiresAt } satisfies LoginResponse);
  });

  /**
   * 登出。**幂等**：没带 cookie、或者 cookie 早已失效，一律返回
   * `{ loggedOut: false }` 而不是 401。
   *
   * 【为什么是 200 而不是 401】登出要的是"现在我这边已经没有会话了"这个
   *   结果。已经满足了这个结果还回一个错误，只会让前端多写一段
   *   "其实这次失败不用管"的特殊分支 —— 而那种分支最后总会有人删掉它。
   */
  app.post('/api/v1/auth/logout', (c) => {
    const raw = getCookie(c, SESSION_COOKIE);
    const loggedOut = raw !== undefined && raw !== '' ? deleteSession(deps.db, raw) : false;
    // 无条件清 cookie：库里删没删掉是一回事，浏览器手里那份必须没了。
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ loggedOut } satisfies LogoutResponse);
  });

  /**
   * 当前登录用户与他的权限点。
   *
   * 【为什么把权限点一起返回】前端据此决定显示哪些入口。**这不是安全边界**
   *   （真正的边界在服务端的闸门上），它只是让界面不要摆出按了必然失败的按钮。
   *   所以可以放心把它交给浏览器 —— 它泄露的只是"我这个角色能做什么"，
   *   而那本来就是这个人自己知道的事。
   */
  app.get('/api/v1/auth/me', (c) => {
    const user = c.get('user');
    if (user === null) {
      // 走到这里说明闸门放行了但 user 是 null —— 只可能是本路由被误标成了
      // `public`。如实报 401，而不是编一个假用户出来。
      throw new AppError('unauthenticated', '请先登录。');
    }
    return c.json({ user, permissions: permissionsOf(user.role) } satisfies MeResponse);
  });

  // ── 「我的」（阶段 4B）─────────────────────────────────────
  //
  // 【为什么口径与各自的列表页不同】这里问的是"我做过什么"，一律严格按
  //   `user_id = 我` 过滤；而 `/submissions`（我能看到什么）与 `/documents`
  //   （全库共享资料）用的是另一套口径。混用会让首页把公共历史数据算成
  //   某人的动态。三个专用 repo 函数各自负责一件事。
  //
  // 【为什么是实时聚合而不是缓存】单实验室几十人、几千行的量级，
  //   三条 LIMIT 5 的查询是瞬时的；缓存只会引入"什么时候该失效"这个新问题。
  const ME_LIMIT = 5;

  app.get('/api/v1/me/overview', (c) => {
    const user = c.get('user');
    if (user === null) {
      // 闸门给了 `authenticated`，正常到不了这里。如实报 401，不编一个用户出来。
      throw new AppError('unauthenticated', '请先登录。');
    }
    const body: MeOverviewResponse = {
      submissions: listSubmissionsByUser(deps.db, user.id, ME_LIMIT),
      documents: listDocumentsByUploader(deps.db, user.id, ME_LIMIT, model),
      askRecords: listAskRecordsByUser(deps.db, user.id, ME_LIMIT),
      // 阶段 6：挂在我投稿上的待办。严格 `owner_id = 我`，含 open 与 dismissed
      // （首页要能显示"这条我忽略过了"，否则用户会以为没点成功）。上限同 ME_LIMIT。
      patrolTasks: listTasksByOwner(deps.db, user.id, ME_LIMIT),
      // O14：首页「今日工作台」。后两项跟着权限点走 —— 没有权限时 repo 不查、
      // 返回 null，界面如实说明"无权查看"，不用 0 冒充"没有待办"。
      pending: pendingForUser(deps.db, user.id, {
        canSubmitKnowledge: hasPermission(user.role, 'knowledge.submit'),
        canUpload: hasPermission(user.role, 'material.upload'),
      }),
      knowledge: hasPermission(user.role, 'knowledge.read')
        ? knowledgeSummary(deps.db, model)
        : null,
    };
    return c.json(body);
  });

  /**
   * 我的用量合计。
   *
   * 【本期不细分时间范围】只给"全部历史"一个合计，并把 `since: null` 如实
   *   带回，让界面写明"统计自上线以来"。按天/按月的分组留给阶段 6 的用量治理
   *   —— 那需要先和用户定"按什么粒度看"，现在猜一个只会做出没人看的图表。
   */
  app.get('/api/v1/me/usage', (c) => {
    const user = c.get('user');
    if (user === null) {
      throw new AppError('unauthenticated', '请先登录。');
    }
    const totals = sumUsageForUser(deps.db, user.id);
    const body: MeUsageResponse = {
      totals: {
        calls: totals.calls,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheRead,
        cacheWriteTokens: totals.cacheCreation,
        costUsd: totals.costUsd,
      },
      since: null,
    };
    return c.json(body);
  });

  // ── 管理端概览（阶段 4C）───────────────────────────────────
  //
  // 【为什么闸门只登记 `authenticated`，而不是某一个权限点】
  //   这一页是"几块敏感度不同的数据拼起来的"，而侧栏与路由守卫放行它用的是
  //   `ADMIN_ENTRY_PERMISSIONS` 这个"任意一个即可"的集合（前端 auth.tsx）。
  //   路由表里没有 anyOf 这一档，硬挑其中一个登记都是错的 —— 比如将来只持有
  //   `patrol.manage` 的巡检员会被 403，而他明明在侧栏看得见这一页。
  //   所以闸门只要求登录，真正的边界落在下面三块各自的权限上：
  //   没有的那块**返回 null，而且在 repo 里根本不查**（不是查出来再丢掉）。
  app.get('/api/v1/admin/overview', (c) => {
    const user = c.get('user');
    if (user === null) {
      // 闸门给了 `authenticated`，正常到不了这里。如实报 401，不编一个用户出来。
      throw new AppError('unauthenticated', '请先登录。');
    }
    const body = adminOverview(
      deps.db,
      model,
      {
        canReadDocuments: hasPermission(user.role, 'knowledge.read'),
        canManageUsers: hasPermission(user.role, 'users.manage'),
        canReadActivity: hasPermission(user.role, 'askRecord.read.all'),
      },
      new Date(),
    );
    return c.json(body);
  });

  // ── 账号管理（阶段 4C 单元 ②）───────────────────────────────
  //
  // 【★ 一条贯穿这四个接口的规则：不许把自己锁在门外】
  //   `users.manage` 只有 admin 有，所以"谁在操作"必然是一个管理员。
  //   于是"最后一个管理员把自己降级或禁用"是**唯一**能把所有人永久关在
  //   管理端之外的操作（改完就没人再有 users.manage，连改回来都做不到，
  //   只能去改库）。这一条在下面两处拦：PATCH 里改自己的 role / status。
  //   不禁用别人的理由在 shared/users.ts 里：三人以上时那是正常操作。
  app.get('/api/v1/users', (c) => {
    return c.json({ items: listUsers(deps.db) } satisfies ListUsersResponse);
  });

  app.post('/api/v1/users', async (c) => {
    const body = await readJsonObject(c);
    const username = readUsername(body['username']);
    const password = readPassword(body['password']);
    const role = readRole(body['role']);

    // 唯一性先查一次，给出人话的报错；唯一索引是最后一道保险，
    // 它的报错（UNIQUE constraint failed）不适合直接给用户看。
    if (findByUsername(deps.db, username) !== undefined) {
      throw new AppError(
        'invalid_argument',
        `用户名「${normalizeUsername(username)}」已经被占用（用户名不区分大小写）。`,
        { httpStatus: 409 },
      );
    }

    const displayName = typeof body['displayName'] === 'string' ? body['displayName'].trim() : '';

    const id = await insertUser(
      deps.db,
      username,
      {
        password,
        role,
        // 空显示名不发出去：insertUser 会用规范化后的用户名兜底，
        // 两个地方各判一次"空串等于没填"会漂移。
        ...(displayName !== '' ? { displayName } : {}),
        // 课题组只在**显式给了**这个键时才写（省略 = 用默认的 NULL，
        // 给了空串 = 清空，两者对 insertUser 都是 NULL，但语义不同，
        // 由读入这一层判一次，别让下层去猜）。
        ...(body['groupId'] !== undefined ? { groupId: readOptionalText(body['groupId']) } : {}),
      },
      new Date(),
    );

    const created = findUserById(deps.db, id);
    if (created === undefined) {
      throw new AppError('internal', '账号建出来了却读不到，请把请求 ID 报给管理员。');
    }
    return c.json({ user: toManagedUser(created) } satisfies CreateUserResponse, 201);
  });

  app.patch('/api/v1/users/:id', async (c) => {
    const id = c.req.param('id');
    const actor = c.get('user');
    const body = await readJsonObject(c);

    const target = findUserById(deps.db, id);
    if (target === undefined) {
      throw new AppError('not_found', '没有这个账号。');
    }

    // 只把**出现过**的字段放进 patch（不出现 = 不动）。
    const patch: UpdateUserRequest = {};
    if (body['username'] !== undefined) {
      const username = normalizeUsername(readUsername(body['username']));
      // 与建号同一条人话报错。唯一索引是最后一道保险，但它的报错不适合给用户看。
      if (username !== target.username && findByUsername(deps.db, username) !== undefined) {
        throw new AppError(
          'invalid_argument',
          `用户名「${username}」已经被占用（用户名不区分大小写）。`,
          { httpStatus: 409 },
        );
      }
      patch.username = username;
      // 建号时没单独填显示名的人，显示名就是当时的用户名（见 insertUser 的兜底）。
      // 这种人改名时把显示名一起带过去，否则表格里会出现"用户名变了、显示名还是旧名"
      // 的一行，看起来像没改干净。已经单独设过显示名的保持不动。
      if (patch.displayName === undefined && target.display_name === target.username) {
        patch.displayName = username;
      }
    }
    if (body['displayName'] !== undefined) {
      const displayName = readRequiredText(body['displayName'], '显示名');
      patch.displayName = displayName;
    }
    if (body['role'] !== undefined) {
      patch.role = readRole(body['role']);
    }
    if (body['groupId'] !== undefined) {
      patch.groupId = readOptionalText(body['groupId']);
    }
    if (body['status'] !== undefined) {
      patch.status = readUserStatus(body['status']);
    }

    // ★ 不许把自己锁在门外。两条都只针对"改自己"，见本节顶部。
    if (actor !== null && actor.id === id) {
      if (patch.status === 'disabled') {
        throw new AppError(
          'invalid_argument',
          '不能禁用自己的账号 —— 禁用之后没有人能再进管理端把它改回来。请让另一位管理员来做。',
        );
      }
      if (patch.role !== undefined && patch.role !== 'admin') {
        throw new AppError(
          'invalid_argument',
          '不能把自己的角色降下来 —— 降完就没有人再有「用户与权限」这项权限了。请让另一位管理员来做。',
        );
      }
    }

    let updated;
    try {
      updated = updateUser(deps.db, id, patch, new Date());
    } catch (err) {
      // 两个管理员同时改成同一个名字时，预检查都会通过，最后靠唯一索引挡住。
      // 把 SQLite 的英文约束错误翻成人话，而不是冒成 500。
      if (
        patch.username !== undefined &&
        err instanceof Error &&
        /UNIQUE constraint failed: users\.username/u.test(err.message)
      ) {
        throw new AppError(
          'invalid_argument',
          `用户名「${patch.username}」已经被占用（用户名不区分大小写）。`,
          { httpStatus: 409 },
        );
      }
      throw err;
    }
    if (updated === undefined) {
      throw new AppError('not_found', '没有这个账号。');
    }

    // 禁用要当场踢掉他的会话（管理员的意图就是"立刻切断"）。
    // 改角色**不踢** —— 角色是每个请求现从库里 JOIN 出来的，
    // 下一次请求就是新角色，踢掉只会让人莫名其妙掉线（见 shared/users.ts）。
    let sessionsRevoked = 0;
    if (patch.status === 'disabled') {
      sessionsRevoked = deleteUserSessions(deps.db, id);
    }

    return c.json({ user: updated, sessionsRevoked } satisfies UpdateUserResponse);
  });

  app.post('/api/v1/users/:id/password', async (c) => {
    const id = c.req.param('id');
    const target = findUserById(deps.db, id);
    if (target === undefined) {
      throw new AppError('not_found', '没有这个账号。');
    }
    const body = await readJsonObject(c);
    const password = readPassword(body['password']);

    await setPassword(deps.db, id, password, new Date());

    // ★ 改密码必须踢掉这个人的全部会话：会话里不带密码，不踢的话
    //   他手里（或攻击者手里）的旧 token 照样能用到过期为止，
    //   "重置了密码"就成了一件没发生的事。
    const sessionsRevoked = deleteUserSessions(deps.db, id);

    return c.json({
      username: target.username,
      sessionsRevoked,
    } satisfies ResetPasswordResponse);
  });

  // ── 健康检查 ───────────────────────────────────────────────
  app.get('/health', (c) => {
    const body: HealthResponse = {
      ok: true,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      schemaVersion: deps.schemaVersion,
      uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000),
      time: new Date().toISOString(),
    };
    return c.json(body);
  });

  // ── 系统配置（阶段 4C 单元 ③）──────────────────────────────
  // 读写都归 `system.config`（只有 admin 有）：这一页描述的是整台服务调大模型的方式
  // （接口地址、两个模型名、API key），读完能做的事就是改它 ——
  // 不需要像概览那样按块分权。
  //
  // 【读为什么不再回显表里的值】见 admin/config.ts 的模块注释：它把"改过什么"
  // 与"现在生效的是什么"分成两块返回，且**按键名形状掩码**，密钥永不出门。
  app.get('/api/v1/system-config', (c) => {
    return c.json(systemConfigView(deps.db, deps.config, deps.models) satisfies SystemConfigResponse);
  });

  // 改配置。PATCH 语义：只传要改的项，不出现的键一律不动
  // （密钥框留空 = 不发 apiKey 这个键，与"清空"是两件事）。
  app.patch('/api/v1/system-config', async (c) => {
    const body = await readJsonObject(c);
    const writes = parseSystemConfigUpdate(body);

    // 闸门已经要求 `system.config`，这里 user 必定存在。仍然显式判一次：
    // 将来若把这条路由的规则放松成 `authenticated`，缺少这一步的后果是
    // "配置被改了，但 `updated_by` 是空的"—— 界面会把它显示成"命令行改的"，
    // 于是"谁改的"永久失真，而且没有任何报错。宁可 500。
    const actor = c.get('user');
    if (actor === null) {
      throw new AppError('internal', '当前请求没有登录用户，无法记录配置修改人。');
    }
    return c.json(
      applySystemConfigUpdate(
        deps.db,
        deps.config,
        deps.models,
        writes,
        actor.id,
        new Date(),
      ) satisfies SystemConfigResponse,
    );
  });

  // 「测试连接」：往配置里的接口地址发一次极小的真实请求（maxTokens: 4），
  // 如实报告"通了 / 401 / 地址不通"。它**会真的花钱**，且打的是管理员自己付费的端点。
  //
  // 【为什么是 POST 而不是 GET】它带请求体（可传"还没保存的"那份值），也因为它
  //   有副作用（花掉一次调用）。GET 会被浏览器与中间层预取/重放，语义不成立。
  //
  // 【为什么权限跟保存一样是 system.config】这个接口能指定任意外站地址并让服务端
  //   去打它 —— 那是"出站目标由调用方决定"的能力。只给 admin，且地址要过
  //   http/https + 拒绝 userinfo 两道校验（见 parseTestConnectionRequest）。
  app.post('/api/v1/system-config/test-connection', async (c) => {
    const body = await readJsonObject(c);
    const input = parseTestConnectionRequest(body);
    return c.json(
      (await testModelConnection(
        { db: deps.db, config: deps.config, models: deps.models },
        input,
      )) satisfies TestModelConnectionResponse,
    );
  });

  // ── 文档上传（阶段 1）──────────────────────────────────────
  // 上传是幂等的：内容相同的文件重复上传返回已有记录，不报错。
  //
  // 归属与确认人都在这里落库（阶段 4 收口的两件欠账）：
  // 走的是上传者本人 —— 闸门已经要求 `material.upload`，所以 user 不会是 null。
  app.post('/api/v1/documents', async (c) => {
    let form: Record<string, string | File>;
    try {
      form = await c.req.parseBody();
    } catch (err) {
      throw new AppError(
        'invalid_argument',
        '无法解析上传数据。请用 multipart/form-data 提交，字段名 file。',
        { cause: err },
      );
    }

    const file = form['file'];
    if (file === undefined || typeof file === 'string') {
      throw new AppError(
        'invalid_argument',
        '请求里没有文件。请用 multipart/form-data 提交，文件字段名为 file。',
      );
    }

    const material = form['material'];
    if (typeof material !== 'string' || material === '') {
      throw new AppError(
        'invalid_argument',
        `缺少 material 字段。可用：${MATERIALS.join('、')}`,
      );
    }

    // ── 云端告知的勾选确认（约束 4）────────────────────────────
    // 与 /ask 同一口径：闸门必须由接口层自己拦。只在界面上禁用按钮是不够的 ——
    // 脚本、curl、将来的第三方客户端都会绕过界面，而约束 4 要求的是
    // "确认后才可入库"，不是"界面上确认后才可入库"。
    //
    // 位置刻意放在 uploadDocument 之前：确认没勾就不该落盘、不该建库，
    // 而不是先存下来再报错（那样"没同意也进来了"）。
    //
    // multipart 里所有字段都是字符串，所以比的是字面量 'true'。
    if (form['consentConfirmed'] !== 'true') {
      throw new AppError(
        'invalid_argument',
        '上传前需要确认已知悉「文档内容会进入实验室知识库，且在问答时检索命中的片段会发送至云端模型」。' +
          '请在表单里带上 consentConfirmed=true。',
      );
    }

    const title = form['title'];
    const uploader = c.get('user');
    const result = await uploadDocument(deps.db, deps.config, {
      file,
      material,
      ...(typeof title === 'string' ? { title } : {}),
      uploadedBy: uploader?.id ?? null,
      // 能走到这里就说明刚才那道 consentConfirmed 闸门已经放行了 ——
      // 所以"谁确认的"就是上传者本人。这不是又一次校验，是把那次确认**记下来**。
      consentConfirmedBy: uploader?.id ?? null,
    });

    // 上传之后紧接着解析与建索引。为什么同步做而不是丢后台队列：
    //   单实验室几十人、几百份文档，一份 PDF 解析实测 1–2 秒，用户等得起；
    //   而丢队列就要处理"传完了但还没索引好"的中间态展示、失败重试、进程重启丢任务，
    //   复杂度远超收益。等到文档量大到秒级不可接受时再改。
    // 已经就绪的重复上传直接跳过，不重复解析。
    let ingest: IngestReport | null = null;
    const before = getDocumentSummary(deps.db, result.documentId, model);
    if (before !== null && before.status !== 'ready') {
      ingest = await ingestDocument(deps.db, deps.config, result.documentId);
    }

    const document = getDocumentSummary(deps.db, result.documentId, model) ?? before;
    if (document === null) {
      throw new AppError('internal', '文档刚写入却查不到，请把请求 ID 提供给管理员。');
    }

    const body: UploadDocumentResponse = { document, duplicated: result.duplicated, ingest };
    // 201 = 新建；200 = 内容已存在，复用了原记录。状态码本身就是给客户端的信号。
    return c.json(body, result.duplicated ? 200 : 201);
  });

  // ── 文档列表（阶段 1）──────────────────────────────────────
  app.get('/api/v1/documents', (c) => {
    const limit = parseLimit(c.req.query('limit'), 200, 500);
    const body: ListDocumentsResponse = {
      items: listDocuments(deps.db, limit, model, parseMaterial(c.req.query('material'))),
    };
    return c.json(body);
  });

  // ── 重新索引（阶段 1 欠账，2026-09-30 补）───────────────────
  //
  // 解析规则或切块策略改了之后，已经入库的块还是按老规则切的。
  // 它们**仍然搜得到**，只是切法过时 —— 这类静默陈旧正是这条路由要解决的问题。
  //
  // 实现上没有第二条流水线：直接复用 ingestDocument，它按 documentId 操作、
  // 先删旧块再写新块，本来就是幂等的（详见 ingest.ts 顶部注释）。
  //
  // 【为什么只做单份，不做"全部重建"接口】
  //   全部重建在前端就是连着调 N 次本接口 —— 这样每次的进度、成功与失败
  //   都是分开的：一份文件损坏不会让整批在建到它的时候中断，用户也能看到
  //   "还剩几份"。一个批处理接口要么返回一个笼统的总结果（失败了也说不清是哪份），
  //   要么就得引入后台任务与进度轮询，对一个几十份文档的库是明显过度设计。
  //
  // 【已知限制：同一份文档并发重建没有互斥】
  //   两个请求同时进来时，两次重建都会跑完，事务保证最终状态一致（后提交的赢），
  //   代价只是向量算了两遍。界面上按钮在请求期间是禁用的，单实验室场景下
  //   两个人在两秒内点同一份文档的概率可以忽略，不值得为此引入进程内的锁。
  app.post('/api/v1/documents/:id/reindex', async (c) => {
    const id = c.req.param('id');
    if (getDocumentSummary(deps.db, id, model) === null) {
      throw new AppError('not_found', '没有这份文档。');
    }

    // 与上传走同一个函数，所以失败原因（原件不在磁盘上 / 解析失败 / 提取不到文字）
    // 的文案、落库方式、状态机转移全都一致，不会出现"上传报一种、重建报另一种"。
    const ingest = await ingestDocument(deps.db, deps.config, id);

    const document = getDocumentSummary(deps.db, id, model);
    if (document === null) {
      throw new AppError('internal', '文档刚重建却查不到，请把请求 ID 提供给管理员。');
    }
    return c.json({ document, ingest } satisfies ReindexDocumentResponse);
  });

  // ── ⌘K 命令面板的短名单（O10）──────────────────────────────
  //
  // 【为什么不是全文检索接口】它要的是"能一键到达的东西"：投稿标题、
  //   数据集名、文档标题。`/api/v1/search` 回的是原文块，用户点进去看到的
  //   是一段摘录，还得自己判断该去哪一页。两者的结果形状与用途都不同。
  //
  // 【权限怎么沿用】路由只登记 `authenticated`；每一类在 handler 里
  //   **各自**检查读权限，并把同一套行级范围交给 repo（投稿走
  //   submissionScope，文档与数据集本来就是共享读）。这样某一天某个角色
  //   失去其中一项时，面板会少一类结果，而不是整页 403。
  app.get('/api/v1/quick-search', (c) => {
    const keyword = (c.req.query('q') ?? '').trim().slice(0, 100);
    if (keyword === '') {
      return c.json({ items: [] } satisfies QuickSearchResponse);
    }

    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const rawKind = c.req.query('kind');
    if (rawKind !== undefined && !(QUICK_SEARCH_KINDS as readonly string[]).includes(rawKind)) {
      throw new AppError('invalid_argument', '未知的检索范围。');
    }
    const accepts = (kind: QuickSearchHit['kind']) => rawKind === undefined || rawKind === kind;
    const perKind = parseLimit(c.req.query('limit'), 5, 100);
    const items: QuickSearchHit[] = [];
    const add = (kind: QuickSearchHit['kind'], id: string, title: string, parts: readonly (string | null | undefined)[],
      updatedAt?: string, lookup?: string) => {
      items.push({ kind, id, title, detail: parts.filter(Boolean).join(' · '), firstChunkId: null, material: null,
        ...(updatedAt === undefined ? {} : { updatedAt }), ...(lookup === undefined ? {} : { lookup }) });
    };

    if (accepts('person') && hasPermission(user.role, 'people.read')) {
      for (const person of listPeople(deps.db, { keyword, limit: perKind }, peopleViewer(user)).items) {
        add('person', person.id, person.name, [person.groupId, PERSON_STATUS_LABELS[person.status]], person.updatedAt);
      }
    }
    if (accepts('patent') && hasPermission(user.role, 'patent.read.all')) {
      const phase = PATENT_FILTERS.find((filter) => filter !== 'all' && PATENT_FILTER_LABELS[filter] === keyword);
      const page = listPatentPage(deps.db, { keyword: phase ? undefined : keyword, filter: phase ?? 'all',
        offset: 0, limit: perKind }, patentScope(user));
      for (const patent of page.items) {
        add('patent', patent.id, patent.name, [patent.patentNo, patent.applicantName], patent.updatedAt);
      }
    }
    if (accepts('thesis') && hasPermission(user.role, 'thesis.read')) {
      for (const thesis of listTheses(deps.db, { keyword, limit: perKind }, thesisViewer(user)).items) {
        add('thesis', thesis.id, thesis.title ?? `${thesis.authorName}的大论文`, [thesis.authorName, thesis.direction],
          thesis.updatedAt, thesis.title ?? thesis.authorName);
      }
    }
    if (accepts('journal') && hasPermission(user.role, 'journal.read')) {
      for (const journal of searchJournals(deps.db, { keyword, limit: perKind })) {
        add('journal', journal.id, journal.name, [journal.field]);
      }
    }
    if (accepts('submission') && hasPermission(user.role, 'submission.read.all')) {
      const status = SUBMISSION_STATUSES.find((value) => SUBMISSION_STATUS_LABELS[value] === keyword);
      for (const s of searchSubmissions(deps.db, {
        keyword: status ? undefined : keyword,
        status,
        limit: perKind,
        scope: submissionScope(user),
      })) {
        add('submission', s.id, s.title, [s.journal?.name, SUBMISSION_STATUS_LABELS[s.status]], s.updatedAt);
      }
    }

    if (accepts('dataset') && hasPermission(user.role, 'code.read')) {
      for (const a of searchCodeAssets(deps.db, { keyword, limit: perKind })) {
        add('dataset', a.id, a.name, [a.project, a.location], a.updatedAt);
      }
    }

    if (accepts('document') && hasPermission(user.role, 'knowledge.read')) {
      const material = parseMaterial(c.req.query('material'));
      const documentId = parseRetrievalId(c.req.query('documentId'));
      for (const d of searchDocumentTitles(deps.db, keyword, perKind, material, documentId)) {
        items.push({
          kind: 'document',
          id: d.id,
          title: d.title,
          detail: MATERIAL_LABELS[d.material],
          firstChunkId: d.firstChunkId,
          material: d.material,
        });
      }
    }

    return c.json({ items } satisfies QuickSearchResponse);
  });

  // ── 检索（阶段 1：关键词 / 语义 / 混合）─────────────────────
  app.get('/api/v1/search', async (c) => {
    const query = c.req.query('q') ?? '';
    const version = c.req.query('contractVersion');
    if (version === undefined) {
      const limit = parseLimit(c.req.query('limit'), SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
      const material = parseMaterial(c.req.query('material'));
      const { search } = await retrieveDocumentPage(deps.db, deps.config, {
        version: 1, query, strategy: parseMode(c.req.query('mode')), limit, offset: 0, candidateLimit: limit,
        scope: { kind: 'document', ...(material === undefined ? {} : { material }) },
      });
      return c.json(search satisfies SearchResponse);
    }

    if (version !== '1') throw new AppError('invalid_argument', '不支持的检索协议版本。');
    if (query.length > 1000) throw new AppError('invalid_argument', '检索词最多 1000 字。');
    const limit = parseRetrievalNumber(c.req.query('limit'), SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
    const offset = parseRetrievalNumber(c.req.query('offset'), 0, 0, 10_000);
    const material = parseMaterial(c.req.query('material'));
    const documentId = parseRetrievalId(c.req.query('documentId'));
    const recordId = parseRetrievalId(c.req.query('recordId'));
    const recordType = c.req.query('recordType');
    const recordFilters = {
      groupId: c.req.query('groupId'), personId: c.req.query('personId'), year: c.req.query('year'),
      status: c.req.query('status'), milestone: c.req.query('milestone'),
    };
    if (recordType !== undefined) {
      const type = RETRIEVAL_RECORD_TYPES.find((item) => item === recordType);
      const mode = c.req.query('mode');
      if (type === undefined || material !== undefined || documentId !== undefined ||
          c.req.query('candidateLimit') !== undefined || (mode !== undefined && mode !== 'structured')) {
        throw new AppError('invalid_argument', '台账类型、策略或范围不匹配。');
      }
      const user = c.get('user');
      if (user === null) throw new AppError('unauthenticated', '请先登录。');
      return c.json(retrieveRecordsV1(deps.db, {
        version: 1, query, strategy: 'structured', limit, offset,
        scope: parseRecordRetrievalScope(type, recordId, recordFilters),
      }, user));
    }

    if (recordId !== undefined || Object.values(recordFilters).some((value) => value !== undefined)) {
      throw new AppError('invalid_argument', '台账过滤必须提供台账类型。');
    }
    const candidateLimit = parseRetrievalNumber(c.req.query('candidateLimit'), SEARCH_MAX_LIMIT, 1, SEARCH_MAX_LIMIT);
    return c.json(await retrieveDocumentsV1(deps.db, deps.config, {
      version: 1, query, strategy: parseMode(c.req.query('mode')), limit, offset, candidateLimit,
      scope: { kind: 'document', ...(material === undefined ? {} : { material }),
        ...(documentId === undefined ? {} : { documentId }) },
    }));
  });

  // ── 块原文（阶段 2）────────────────────────────────────────
  // 问答的引用点进来看到的就是这个：被引块 + 同页邻居。
  app.get('/api/v1/chunks/:chunkId', (c) => {
    const context = getChunkContext(deps.db, c.req.param('chunkId'));
    if (context === null) {
      throw new AppError(
        'not_found',
        '没有这个检索块。它可能来自一份后来被重新索引或删除的文档。',
      );
    }
    c.header('Cache-Control', 'private, no-store');
    return c.json(context satisfies ChunkContextResponse);
  });

  // ── 下载原件（阶段 2）──────────────────────────────────────
  // 权限已收口（阶段 4 欠账 1）：路由要求 `knowledge.read`，未登录拿不到。
  // 【收口的程度如实说】这一条只是"从任何人可下"变成"登录用户可下"。
  //   "投稿中的稿件不该被别的成员下载"这个更细的边界**本期不做** ——
  //   它需要 documents 上有一个"未发表"的标记，而那要等材料状态设计定下来
  //   （见 plan 决定 2）。现在的行为由约束 4 的勾选确认 + 账号体系背书：
  //   能进系统的是实验室成员，不是任意一个打开浏览器的人。
  async function serveDocumentFile(c: Context<Env>, documentId: string, revalidate?: () => void) {
    const doc = getDocumentFile(deps.db, documentId);
    if (doc === null) throw new AppError('not_found', '没有这份文档。');
    if (doc.sourcePath === null || doc.sourcePath === '') {
      throw new AppError(
        'not_found',
        '这份文档没有留存原件（可能是早期入库的记录）。可以下载它的解析文本，或重新上传一次。',
      );
    }

    const abs = resolve(deps.config.repoRoot, doc.sourcePath);
    // 路径必须落在上传目录内。source_path 是我们自己写的相对路径，
    // 正常不可能越界；但这条链路是「用户给的 id → 读磁盘文件」，
    // 一旦库被手工改过就是一次任意文件读取，值得三行拦一下。
    const root = deps.config.uploadDir;
    if (!isInside(root, abs)) {
      console.error(`[${c.get('requestId')}] 原件路径越界，拒绝下载：${abs}`);
      throw new AppError('internal', '原件路径不合法，请把请求 ID 提供给管理员。');
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(abs);
    } catch (err) {
      throw new AppError(
        'not_found',
        '原件已不在磁盘上。可能是被清理过，或这份记录是从别的机器迁移过来的。',
        { cause: err },
      );
    }

    revalidate?.();
    const name = downloadName(doc);
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': contentDisposition(name),
      'Cache-Control': 'private, no-store',
      // 不加这一条，浏览器可能"聪明地"按内容猜类型：上传一个 .html
      // 就会被当成网页渲染，等于给我们自己开了个存储型 XSS。
      'X-Content-Type-Options': 'nosniff',
    });
  }

  app.get('/api/v1/documents/:id/file', (c) => serveDocumentFile(c, c.req.param('id')));

  // ── 问答（阶段 2）──────────────────────────────────────────
  // 这是阶段 0 就写好的 Agent 内核第一次接进 HTTP 层。
  // 这里是【同步等待整段回答】的版本；逐字流式是 /ask/stream（单元 ③）。
  // 两个入口共用同一段请求体校验，见 parseAskBody 的注释。

  /**
   * 终态 Trace 落库（O7）。三个问答入口（同步 / 流式 / 续跑）共用。
   *
   * 【为什么写失败只记日志】Trace 是诊断记录，不是事实来源。回答已经算出来、
   *   用户正在等，不能因为一张辅助表写不进去就把成功的问答变成 500 ——
   *   与 ask_records / usage_events 的写入口径一致。
   *
   * 【为什么 askedAt 由调用方给】它是**运行开始**时刻，不是落库时刻；
   *   和 ask_records.asked_at 同源，两张表才能按时间对齐。
   */
  function traceSink(userId: string | null, askedAt: string) {
    return (finalization: AskFinalization): void => {
      try {
        insertRunTrace(deps.db, {
          finalization,
          userId,
          askedAt,
          recordedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error(
          `[${finalization.runId}] 运行 Trace 落库失败（不影响本次回答）：`,
          err,
        );
      }
    };
  }

  app.post('/api/v1/ask/document-scope', async (c) => {
    const value = await readJsonBody(c);
    const body = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
    const ids = body.version === 1 ? parseAskDocumentIds(body.documentIds) : undefined;
    if (ids === undefined) throw new AppError('invalid_argument', '资料选择格式无效。');
    c.header('Cache-Control', 'private, no-store');
    return c.json({ items: resolveAskScopeDocuments(deps.db, c.get('user'), ids) });
  });

  app.post('/api/v1/ask', async (c) => {
    const { question, history, documentScope } = await readAskBody(c);
    const askedAt = new Date().toISOString();

    const result = await runAsk(
      { db: deps.db, config: deps.config, models: deps.models },
      {
        question,
        history,
        ...(documentScope === undefined ? {} : { documentScope }),
        consentConfirmed: true,
        requestId: c.get('requestId'),
        user: c.get('user'),
      },
      { onFinalize: traceSink(c.get('user')?.id ?? null, askedAt) },
    );
    return c.json(result satisfies AskResponse);
  });

  // ── 问答：流式 ─────────────────────────────────────────────
  //
  // 【为什么是 SSE 而不是 WebSocket】
  //   这里是**单向**的：服务端推，客户端只听。WebSocket 的双向能力用不上，
  //   却要付出"不走普通 HTTP"的代价 —— 多一个握手、多一套连接生命周期管理、
  //   多一个依赖，Vite 开发代理还得单独配。SSE 就是普通 HTTP 响应，
  //   能被代理、能用 curl 调、断线重连语义由浏览器管。
  //
  // 【为什么失败也发一条事件，而不是直接断开】
  //   连接断了，前端只知道"没了"：是模型报错？超时？还是网线被拔？
  //   把失败的 `ApiErrorBody` 先推出去再关，前端才能把原因显示给人看。
  app.post('/api/v1/ask/stream', async (c) => {
    // 请求体校验必须在进入流之前完成。一旦 streamSSE 返回，响应头就已经是
    // 200 + text/event-stream 了，那时再发现参数不对也改不了状态码 ——
    // 只能变成一个"先 200 再在流里报参数错"的怪东西。
    const { question, history, documentScope } = await readAskBody(c);

    return streamSSE(c, async (stream) => {
      const requestId = c.get('requestId');
      // 运行开始时刻：Trace 与 ask_records 用同一个值对齐。
      const askedAt = new Date().toISOString();
      // 浏览器关页面 / 点停止 / 网络掉 → 中止这次 run。
      // 不中止的话，模型会继续把剩下的 token 全烧完，而没有任何人在看。
      const ac = new AbortController();
      stream.onAbort(() => {
        ac.abort();
      });

      // 写入串行化。
      //
      // 为什么不能直接 `await write()` 了事：事件是由 Agent 的回调**同步**推出来的，
      // 而回调不是 async 的（pi-agent 的事件订阅不该被一次网络写入阻塞）。
      // 所以只能 fire-and-forget，但必须保证顺序 —— 正文乱序就是乱码。
      // 一个 promise 链让写入排队，先到的先写。
      //
      // 每一环自己兜住异常：客户端走了之后 writeSSE 会抛，
      // 让它冒出来的话，后面所有排队的事件都会连带失败（甚至变成未处理的 rejection）。
      let chain: Promise<void> = Promise.resolve();
      const send = (event: AskStreamEvent): void => {
        chain = chain
          .then(async () => {
            if (stream.aborted || stream.closed) return;
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          })
          .catch(() => {
            // 客户端断开是常态（关页面），不是错误，不值得记日志刷屏。
          });
      };

      try {
        const response = await runAsk(
          { db: deps.db, config: deps.config, models: deps.models },
          { question, history, ...(documentScope === undefined ? {} : { documentScope }),
            consentConfirmed: true, requestId, user: c.get('user') },
          {
            onEvent: send,
            signal: ac.signal,
            onFinalize: traceSink(c.get('user')?.id ?? null, askedAt),
          },
        );
        // 终态事件由**交付状态**决定，不是"跑完了就是 done"：
        //   verified → 全部 Claim 通过规则校验；
        //   partial  → 有未通过/待核对的结论，不能冒充已验证；
        //   interrupted → 超时，未完成。
        // 前端只把 verified_final 当"已校验的最终回答"。
        const terminal =
          response.delivery.status === 'verified'
            ? ('verified_final' as const)
            : response.delivery.status === 'interrupted'
              ? ('interrupted' as const)
              : ('partial' as const);
        send({ type: terminal, response });
      } catch (err) {
        // 对方已经走了，写什么都送不到；AskAbortedError 也正是"对方走了"这件事本身。
        if (stream.aborted || stream.closed || err instanceof AskAbortedError) {
          await chain;
          return;
        }
        // 走和其它接口同一个 describe/TITLES，错误码与文案不会两处漂移。
        const { code, title, message, retryable, retryDelayMs } = describe(err);
        // 注意这里**不打印堆栈以外的东西**：错误的堆栈只进服务端日志（下面那行），
        // 推给浏览器的只有 description 这几个字段 —— 与 onError 的口径一致。
        console.error(`[${requestId}] 流式问答失败 code=${code}`, err);
        send({
          type: 'failed',
          error: {
            error: {
              code,
              title,
              message,
              retryable,
              requestId,
              ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
            },
          },
        });
      }
      // 把队列里剩下的事件写完再让响应结束。
      // 不等的话，终态事件可能还没落盘连接就关了 —— 前端会看到一个
      // "流得好好的、结尾突然没了"的回答。
      await chain;
    });
  });

  // ── 可续跑 Agent 任务（V3 / S7 X1b）────────────────────────
  //
  // 归属是唯一读路径：别人的 taskId 一律 404（与"不存在"共用答复，不确认它存在）。
  // GET 只返回状态/覆盖/检查点版本；Resume 才真正重新执行，且必须显式 POST。
  function taskViewOf(taskId: string, ownerId: string): AgentTaskView | null {
    const now = new Date().toISOString();
    expireStaleTasks(deps.db, now);
    const task = getTask(deps.db, taskId);
    if (task === undefined || task.owner_id !== ownerId) return null;
    const checkpoint = getLatestCheckpoint(deps.db, taskId);
    let coverage = 'unknown';
    let coverageRatio = 0;
    let evidenceCount = 0;
    let rewriteRounds = 0;
    if (checkpoint !== undefined) {
      const parsed = parseCheckpoint(checkpoint);
      coverage = parsed.plan.coverage;
      coverageRatio = parsed.plan.coverageRatio;
      evidenceCount = parsed.evidence.documents.length;
      rewriteRounds = parsed.rewriteRounds;
    }
    return {
      taskId: task.id,
      question: task.question,
      status: task.status,
      stopReason: checkpoint?.stop_reason ?? null,
      resumeAvailable: isResumeAvailable(task, now),
      evidenceCount,
      checkpointVersion: task.last_checkpoint_version,
      coverage,
      coverageRatio,
      rewriteRounds,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      expiresAt: task.expires_at,
    };
  }

  app.get('/api/v1/agent-tasks/:taskId', (c) => {
    const user = c.get('user');
    // 闸门要求 chat.use，理论上必有 user；显式判一次，免得规则日后放宽。
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const view = taskViewOf(c.req.param('taskId'), user.id);
    if (view === null) throw new AppError('not_found', '没有这个任务，或它不属于当前账号。');
    return c.json(view satisfies AgentTaskView);
  });

  app.post('/api/v1/agent-tasks/:taskId/resume', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const taskId = c.req.param('taskId');
    const attemptId = randomUUID();
    const claimed = claimResume(deps.db, {
      taskId,
      ownerId: user.id,
      attemptId,
      now: new Date().toISOString(),
    });
    if (!claimed.ok) {
      if (claimed.reason === 'not_found') {
        throw new AppError('not_found', '没有这个任务，或它不属于当前账号。');
      }
      if (claimed.reason === 'expired') {
        throw new AppError('invalid_argument', '任务已过期，不能再继续。', { httpStatus: 410 });
      }
      if (claimed.reason === 'busy') {
        throw new AppError('invalid_argument', '这个任务正在另一个运行中，请等它结束。', {
          httpStatus: 409,
        });
      }
      throw new AppError(
        'invalid_argument',
        `任务当前状态是 ${claimed.status ?? 'unknown'}，不能继续。`,
        { httpStatus: 409 },
      );
    }

    const checkpoint = getLatestCheckpoint(deps.db, taskId);
    if (checkpoint === undefined) {
      finishTask(deps.db, {
        taskId,
        attemptId,
        now: new Date().toISOString(),
        status: 'failed',
        attemptState: 'exception',
        stopReason: 'exception',
        cumulative: { queryCalls: 0, toolCalls: 0, tokens: 0, costUsd: 0 },
      });
      throw new AppError('invalid_argument', '任务没有可用检查点，不能继续。', {
        httpStatus: 409,
      });
    }
    const parsed = parseCheckpoint(checkpoint);
    const resume: AskResumeState = {
      ...(parsed.plan.documentScope === undefined ? {} : { documentScope: parsed.plan.documentScope }),
      coverage: parsed.plan.coverage,
      coverageRatio: parsed.plan.coverageRatio,
      subgoals: parsed.plan.subgoals,
      documents: parsed.evidence.documents,
      records: parsed.evidence.records,
      pendingStepIds: parsed.pendingStepIds,
      queryHistory: parsed.queryHistory,
      rewriteRounds: parsed.rewriteRounds,
      rewriteEvents: parsed.rewriteEvents,
      cumulative: parsed.cumulative,
      stopReason: parsed.stopReason,
    };

    return streamSSE(c, async (stream) => {
      const requestId = c.get('requestId');
      // 续跑也是一次独立运行：Trace 行按这次 attempt 的 runId 单独记。
      const askedAt = new Date().toISOString();
      const ac = new AbortController();
      stream.onAbort(() => ac.abort());
      let chain: Promise<void> = Promise.resolve();
      const send = (event: AskStreamEvent): void => {
        chain = chain
          .then(async () => {
            if (stream.aborted || stream.closed) return;
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          })
          .catch(() => {});
      };

      try {
        const response = await runAsk(
          { db: deps.db, config: deps.config, models: deps.models },
          {
            question: claimed.task.question,
            consentConfirmed: true,
            requestId,
            user,
            task: { taskId, attemptId, resume },
          },
          {
            onEvent: send,
            signal: ac.signal,
            onFinalize: traceSink(user.id, askedAt),
          },
        );
        const terminal =
          response.delivery.status === 'verified'
            ? ('verified_final' as const)
            : response.delivery.status === 'interrupted'
              ? ('interrupted' as const)
              : ('partial' as const);
        send({ type: terminal, response });
      } catch (err) {
        if (stream.aborted || stream.closed || err instanceof AskAbortedError) {
          await chain;
          return;
        }
        // runAsk 的 finalize 通常会收尾任务；这里兜底一次，避免"claim 成功但
        // 在 runAsk 的早期配置阶段就抛错"把任务永远留在 running。
        try {
          finishTask(deps.db, {
            taskId,
            attemptId,
            now: new Date().toISOString(),
            status: 'failed',
            attemptState: 'exception',
            stopReason: 'exception',
            cumulative: resume.cumulative,
          });
        } catch {
          /* 任务可能已由 runAsk 收尾；忽略 */
        }
        const { code, title, message, retryable, retryDelayMs } = describe(err);
        console.error(`[${requestId}] 续跑问答失败 code=${code}`, err);
        send({
          type: 'failed',
          error: {
            error: {
              code,
              title,
              message,
              retryable,
              requestId,
              ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
            },
          },
        });
      }
      await chain;
    });
  });

  // ── 问答记录（阶段 2）──────────────────────────────────────
  // 只读，用于追溯"谁在什么时候问了什么、勾没勾确认"。
  // 权限已收口（阶段 4 欠账 2）：路由要求 `askRecord.read.own`，
  // 行级范围是 own + all —— 成员看自己的，导师与管理员看全部
  // （用户 2026-10-11 拍板）。提问原文不脱敏，所以这一档必须收在 SQL 里。
  function noteOwner(c: Context<Env>) {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    c.header('Cache-Control', 'private, no-store');
    return user;
  }

  app.get('/api/v1/research-notes', (c) => {
    const owner = noteOwner(c);
    const query = c.req.query('q')?.trim() ?? '';
    if (query.length > 160) throw new AppError('invalid_argument', '查找词不能超过 160 字。');
    const offset = parseRetrievalNumber(c.req.query('offset'), 0, 0, 100_000);
    return c.json(listResearchNotes(deps.db, owner.id, query, 40, offset));
  });

  app.post('/api/v1/research-notes', async (c) => {
    const owner = noteOwner(c);
    const input = parseCreateNote(await readJsonBody(c));
    return c.json(presentResearchNote(deps.db, owner, createResearchNote(deps.db, owner.id, input)), 201);
  });

  app.get('/api/v1/research-notes/:id', (c) => {
    const owner = noteOwner(c);
    return c.json(presentResearchNote(deps.db, owner, readResearchNote(deps.db, owner.id, c.req.param('id'))));
  });

  app.patch('/api/v1/research-notes/:id', async (c) => {
    const owner = noteOwner(c);
    const input = parseUpdateNote(await readJsonBody(c));
    return c.json(presentResearchNote(deps.db, owner, updateResearchNote(deps.db, owner.id, c.req.param('id'), input)));
  });

  app.get('/api/v1/research-notes/:id/runs/:runId/sources/:citationId', (c) => {
    const owner = noteOwner(c);
    return c.json(readResearchNoteDocument(deps.db, owner, c.req.param('id'), c.req.param('runId'), c.req.param('citationId')));
  });

  app.get('/api/v1/research-notes/:id/runs/:runId/sources/:citationId/record', (c) => {
    const owner = noteOwner(c);
    return c.json(readResearchNoteRecord(deps.db, owner, c.req.param('id'), c.req.param('runId'), c.req.param('citationId')));
  });

  app.get('/api/v1/research-notes/:id/runs/:runId/sources/:citationId/file', (c) => {
    const owner = noteOwner(c);
    function authorizedDocumentId() {
      const context = readResearchNoteDocument(deps.db, owner, c.req.param('id'), c.req.param('runId'), c.req.param('citationId'));
      if (context.archivedIndexVersion !== undefined) throw new AppError('not_found', '此历史引用仅保留原文片段。');
      return context.document.id;
    }
    return serveDocumentFile(c, authorizedDocumentId(), authorizedDocumentId);
  });

  app.delete('/api/v1/research-notes/:id', (c) => {
    const owner = noteOwner(c);
    deleteResearchNote(deps.db, owner.id, c.req.param('id'), noteRevision(c.req.query('revision')));
    return c.json({ deleted: true });
  });

  app.get('/api/v1/ask-records', (c) => {
    const limit = parseLimit(c.req.query('limit'), 20, 200);
    const offset = parseOffset(c.req.query('offset'));
    const keyword = (c.req.query('q') ?? '').trim().slice(0, 300);
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const items = listAskRecords(deps.db, limit + 1, askRecordScope(user), offset, keyword);
    const result: ListAskRecordsResponse = {
      items: withAskRecordSources(deps.db, items.slice(0, limit), user),
      hasMore: items.length > limit,
    };
    return c.json(result);
  });

  app.post('/api/v1/ask-records/:runId/review', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const runId = c.req.param('runId');
    if (findAskRecordOwner(deps.db, runId) !== user.id) throw new AppError('not_found', '没有找到这次问答。');
    const raw = await readJsonObject(c);
    const answer = raw['answer'];
    if (raw['consentConfirmed'] !== true || typeof answer !== 'string' ||
        answer.trim() === '' || answer.length > ASK_REVIEW_MAX_CHARS) {
      throw new AppError('invalid_argument', '请确认云端处理授权，并提交可复核的回答正文。');
    }
    return c.json(await reviewAnswer(deps, { runId, answer, user, signal: c.req.raw.signal }));
  });

  // ── 回答反馈（O5）───────────────────────────────────────────
  //
  // 【为什么只允许给自己的运行打分】run_id 出现在界面上（回答头部截了 8 位），
  //   但完整 id 不该成为"给别人的回答打分"的入口。归属不匹配与不存在都回 404 ——
  //   两者必须不可区分，否则这个接口就成了"某次问答是否存在"的探测器。
  //
  // 【为什么赞时清空 reasons / note】改投是覆盖，不是叠加。先踩后赞若把
  //   "答案不对"留在行里，管理端的统计会把一次满意的回答也算进问题里。
  app.post('/api/v1/ask-records/:runId/feedback', async (c) => {
    const runId = c.req.param('runId');
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');

    if (findAskRecordOwner(deps.db, runId) !== user.id) {
      throw new AppError('not_found', '没有找到这次问答，或它不属于当前账号。');
    }

    const raw = await readJsonObject(c);
    const rating = parseFeedbackRating(raw['rating']);
    const review = rating === 'down';
    const feedback = upsertFeedback(
      deps.db,
      {
        runId,
        userId: user.id,
        rating,
        reasons: review ? parseFeedbackReasons(raw['reasons']) : [],
        note: review ? parseFeedbackNote(raw['note']) : null,
      },
      new Date().toISOString(),
    );
    return c.json({ feedback } satisfies SubmitFeedbackResponse);
  });

  // ── 投稿台账（阶段 3 单元 ②）───────────────────────────────
  //
  // 【为什么这是普通接口，而不是 Agent 工具】「我投的 X 现在什么状态」
  //   是一条确定性的 SQL 查询，不需要模型参与（02 号 §2.1 的 T4：纯查询，无 Agent）。
  //   单元 ④ 会把它包成 Agent 能调的工具，但那时调的是**下面这几个函数**，
  //   不会另写一条查询路径 —— 两条路径早晚会给出不同的答案。
  //
  // 所有登录角色均可读全部投稿记录；写仍是 `submission.write.own` +
  // owner-or-write.all。首页「我的动态」继续只汇总自己的记录。
  app.get('/api/v1/submissions', (c) => {
    const limit = parseLimit(c.req.query('limit'), 200, 500);
    const body: ListSubmissionsResponse = {
      items: listSubmissions(deps.db, limit, submissionScope(c.get('user'))),
    };
    return c.json(body);
  });

  app.post('/api/v1/submissions', async (c) => {
    const input = await readSubmissionBody(c);
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    if (input.submitterPersonId !== null && getPerson(deps.db, input.submitterPersonId, peopleViewer(user)) === null) {
      throw new AppError('invalid_argument', '关联的投稿人不存在。');
    }
    const now = new Date().toISOString();

    // 事务在 repo 里（找/建期刊 + 写主表 + 写时间线第一格，见 createSubmission）。
    const { id, journalCreated } = createSubmission(
      deps.db,
      {
        title: input.title,
        algorithmAbbr: input.algorithmAbbr,
        submitterName: input.submitterName,
        submitterPersonId: input.submitterPersonId,
        journalName: input.journalName,
        journalField: input.journalField,
        status: input.status,
        submittedAt: input.submittedAt,
        submittedOn: input.submittedOn,
        statusSince: input.statusSince,
        submissionNumber: input.submissionNumber,
        notes: input.notes,
        userId: c.get('user')?.id ?? null,
      },
      now,
    );

    const submission = getSubmission(deps.db, id);
    if (submission === null) {
      throw new AppError('internal', '投稿记录刚写入却查不到，请把请求 ID 提供给管理员。');
    }
    // 201 = 建档。台账没有"重复提交"的概念：同一篇稿子投两个刊是两件事，
    // 所以这里不像上传那样有 200/201 之分。
    return c.json({ submission, journalCreated } satisfies CreateSubmissionResponse, 201);
  });

  // 资料订正与状态流转分开：名称、期刊、日期、编号可以补改，状态变更仍写时间线。
  app.patch('/api/v1/submissions/:id', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const body = await readJsonObject(c);
    const id = c.req.param('id');
    const before = getSubmission(deps.db, id);
    if (before === null) throw new AppError('not_found', '没有这条投稿记录。');
    const canWriteAll = hasPermission(user.role, 'submission.write.all');
    if (!canWriteAll && before.submittedById !== user.id) {
      throw new AppError('permission_denied', '只能编辑自己录入的投稿。');
    }
    if (body['status'] !== undefined) {
      throw new AppError('invalid_argument', '状态变更请使用“改状态”，以保留流转时间线。');
    }
    const expectedRevision = readExpectedRevision(body['expectedRevision']);
    const patch: Omit<UpdateSubmissionRequest, 'expectedRevision'> = {};
    if (body['title'] !== undefined) patch.title = readRequiredText(body['title'], '稿件标题');
    for (const key of ['algorithmAbbr', 'submitterName', 'journalName', 'journalField', 'submissionNumber', 'notes'] as const) {
      if (body[key] === undefined) continue;
      if (body[key] !== null && typeof body[key] !== 'string') {
        throw new AppError('invalid_argument', `${key} 必须是文本或 null。`);
      }
      patch[key] = optionalText(body[key]) ?? null;
    }
    if (body['submitterPersonId'] !== undefined) {
      const personId = optionalPatchText(body, 'submitterPersonId') ?? null;
      if (personId !== null && getPerson(deps.db, personId, peopleViewer(user)) === null) {
        throw new AppError('invalid_argument', '关联的投稿人不存在。');
      }
      patch.submitterPersonId = personId;
    }
    for (const key of ['submittedOn', 'statusSince'] as const) {
      if (body[key] === undefined) continue;
      if (body[key] !== null && typeof body[key] !== 'string') {
        throw new AppError('invalid_argument', `${key} 必须是日期文本或 null。`);
      }
      patch[key] = readDateField(body[key], key);
    }
    if (patch.journalField !== undefined && patch.journalName === undefined) {
      throw new AppError('invalid_argument', '填写期刊领域时，请同时填写期刊名称。');
    }
    if (before.status === 'preparing' && patch.submittedOn !== undefined && patch.submittedOn !== null) {
      throw new AppError('invalid_argument', '准备中的稿件还没有投稿日期；请先改变状态。');
    }
    const result = updateSubmissionDetails(
      deps.db, id, patch, new Date().toISOString(),
      { userId: user.id, canWriteAll },
      expectedRevision,
    );
    if (result === null) throw new AppError('not_found', '没有这条投稿记录。');
    return c.json(result satisfies UpdateSubmissionResponse);
  });

  app.post('/api/v1/submissions/:id/status', async (c) => {
    const raw = await readJsonObject(c);
    const status = parseSubmissionStatus(raw['status']);
    const note = typeof raw['note'] === 'string' && raw['note'].trim() !== '' ? raw['note'].trim() : null;
    const statusSinceRaw = optionalText(raw['statusSince']);
    const statusSince = statusSinceRaw === undefined ? null : parseDateOnly(statusSinceRaw, 'statusSince');

    const id = c.req.param('id');
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const before = getSubmission(deps.db, id);
    if (before === null) throw new AppError('not_found', '没有这条投稿记录。');
    if (!hasPermission(user.role, 'submission.write.all') && before.submittedById !== user.id) {
      throw new AppError('permission_denied', '只能编辑自己录入的投稿。');
    }
    // 状态没变就拒绝，而不是静默地写一条空变更。
    // 时间线是这条记录**为什么**变成现在这样的证据，塞进去一串
    // "外审 → 外审"会把真正的那几次变更淹掉，而界面看上去一切正常。
    if (before.status === status) {
      throw new AppError(
        'invalid_argument',
        `这条记录已经是「${status}」了，没有需要变更的状态。`,
      );
    }

    // repo 再按 owner 或 write.all 守住写入，防止其他调用路径绕过上述校验。
    const submission = updateSubmissionStatus(
      deps.db,
      id,
      status,
      statusSince,
      note,
      new Date().toISOString(),
      { userId: user.id, canWriteAll: hasPermission(user.role, 'submission.write.all') },
    );
    if (submission === null) throw new AppError('not_found', '没有这条投稿记录。');
    return c.json({ submission } satisfies UpdateSubmissionStatusResponse);
  });

  // 一篇稿件的投稿轮次同样对所有登录用户开放读取；不存在仍返回 404。
  app.get('/api/v1/submissions/:id/rounds', (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const id = c.req.param('id');
    if (getSubmissionFor(deps.db, id, submissionScope(user)) === null) {
      throw new AppError('not_found', '没有这条投稿记录。');
    }
    return c.json({ items: listSubmissionRounds(deps.db, id) } satisfies ListSubmissionRoundsResponse);
  });

  // 拒稿后转投另一刊：在同一篇稿件上新增一轮。能看见不等于能写，
  // 判据与服务端改状态一致：owner 或 submission.write.all。
  app.post('/api/v1/submissions/:id/rounds', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const input = await readRoundBody(c);
    const id = c.req.param('id');
    const before = getSubmissionFor(deps.db, id, submissionScope(user));
    if (before === null) throw new AppError('not_found', '没有这条投稿记录。');
    if (
      !hasPermission(user.role, 'submission.write.all') &&
      before.submittedById !== user.id
    ) {
      throw new AppError('permission_denied', '只能编辑自己录入的投稿。');
    }

    const { round, journalCreated } = createSubmissionRound(
      deps.db,
      id,
      {
        ...input,
        userId: user.id,
      },
      new Date().toISOString(),
    );
    const submission = getSubmission(deps.db, id);
    if (submission === null) {
      throw new AppError('internal', '投稿轮次刚写入却查不到，请把请求 ID 提供给管理员。');
    }
    return c.json({ round, submission, journalCreated } satisfies CreateSubmissionRoundResponse, 201);
  });

  for (const [path, kind] of [['submissions', 'submission'], ['patents', 'patent'], ['theses', 'thesis']] as const) {
    app.delete(`/api/v1/${path}/:id`, (c) => {
      const user = c.get('user');
      if (user === null) throw new AppError('unauthenticated', '请先登录。');
      const deleted = deleteLedgerRecord(deps.db, kind, c.req.param('id'), user, new Date().toISOString());
      return c.json({ deleted });
    });
  }

  app.get('/api/v1/ledger-deletions', (c) => {
    const before = c.req.query('before');
    return c.json(listLedgerDeletions(deps.db, parseLimit(c.req.query('limit'), 8, 50), before === undefined ? null : parseOffset(before)));
  });

  app.post('/api/v1/ledger-deletions/:id/restore', (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const restoredAt = new Date().toISOString();
    restoreLedgerRecord(deps.db, c.req.param('id'), user.id, restoredAt);
    return c.json({ restoredAt });
  });

  // ── 人员主档（投稿台账信息优化 · 第二步）────────────────────
  //
  // 所有登录角色都持有 people.read.sensitive，可查看完整学号；repo 仍按权限
  // 过滤返回值。绑定账号只有 people.manage 才可查看和修改。
  app.get('/api/v1/people', (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const limit = parseLimit(c.req.query('limit'), 200, 500);
    const result = listPeople(
      deps.db,
      { keyword: c.req.query('q'), limit },
      peopleViewer(user),
    );
    return c.json(result satisfies ListPeopleResponse);
  });

  app.get('/api/v1/people/:id', (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const person = getPerson(deps.db, c.req.param('id'), peopleViewer(user));
    if (person === null) throw new AppError('not_found', '没有这条人员记录。');
    return c.json({ person } satisfies CreatePersonResponse);
  });

  app.post('/api/v1/people', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const body = await readJsonObject(c);
    const name = readRequiredText(body['name'], '姓名');
    const studentNo = optionalText(body['studentNo']) ?? null;
    const groupId = optionalText(body['groupId']) ?? null;
    const status = body['status'] === undefined ? 'active' : readPersonStatus(body['status']);
    const userId = optionalText(body['userId']) ?? null;
    const note = optionalText(body['note']) ?? null;

    if (studentNo !== null) {
      const holder = findPersonByStudentNo(deps.db, studentNo);
      if (holder !== null) {
        throw new AppError('invalid_argument', `学号「${studentNo}」已经被另一条人员记录占用。`, {
          httpStatus: 409,
        });
      }
    }
    assertUserBindable(deps.db, userId, null);

    let id: string;
    try {
      id = insertPerson(
        deps.db,
        { name, studentNo, groupId, status, userId, note, createdBy: user.id },
        new Date().toISOString(),
      );
    } catch (err) {
      throw personConstraintError(err);
    }
    const person = getPerson(deps.db, id, peopleViewer(user));
    if (person === null) {
      throw new AppError('internal', '人员记录刚写入却查不到，请把请求 ID 提供给管理员。');
    }
    return c.json({ person } satisfies CreatePersonResponse, 201);
  });

  app.patch('/api/v1/people/:id', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const id = c.req.param('id');
    const current = getPerson(deps.db, id, peopleViewer(user));
    if (current === null) throw new AppError('not_found', '没有这条人员记录。');

    const body = await readJsonObject(c);
    const patch: {
      name?: string;
      studentNo?: string | null;
      groupId?: string | null;
      status?: PersonStatus;
      userId?: string | null;
      note?: string | null;
    } = {};
    if (body['name'] !== undefined) patch.name = readRequiredText(body['name'], '姓名');
    if (body['studentNo'] !== undefined) patch.studentNo = optionalText(body['studentNo']) ?? null;
    if (body['groupId'] !== undefined) patch.groupId = optionalText(body['groupId']) ?? null;
    if (body['status'] !== undefined) patch.status = readPersonStatus(body['status']);
    if (body['userId'] !== undefined) patch.userId = optionalText(body['userId']) ?? null;
    if (body['note'] !== undefined) patch.note = optionalText(body['note']) ?? null;

    if (patch.studentNo !== undefined && patch.studentNo !== null) {
      const holder = findPersonByStudentNo(deps.db, patch.studentNo);
      if (holder !== null && holder.id !== id) {
        throw new AppError(
          'invalid_argument',
          `学号「${patch.studentNo}」已经被另一条人员记录占用。`,
          { httpStatus: 409 },
        );
      }
    }
    if (patch.userId !== undefined) assertUserBindable(deps.db, patch.userId, id);

    try {
      updatePerson(deps.db, id, patch, new Date().toISOString());
    } catch (err) {
      throw personConstraintError(err);
    }
    const person = getPerson(deps.db, id, peopleViewer(user));
    if (person === null) throw new AppError('not_found', '没有这条人员记录。');
    return c.json({ person } satisfies UpdatePersonResponse);
  });

  // ── 专利台账（投稿台账信息优化 · 第三步）──────────────────
  //
  // 专利向登录成员开放读取，录入人、导师和管理员可以编辑。
  // 专利号、申请人、日期都允许为空，空就是未知。
  app.get('/api/v1/patents', (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const limit = parseLimit(c.req.query('limit'), 200, 500);
    const rawFilter = c.req.query('filter') ?? 'all';
    if (!(PATENT_FILTERS as readonly string[]).includes(rawFilter)) {
      throw new AppError('invalid_argument', '未知的专利筛选条件。');
    }
    return c.json(listPatentPage(deps.db, {
      keyword: c.req.query('q'), limit, offset: parseOffset(c.req.query('offset')),
      filter: rawFilter as PatentFilter,
    }, patentScope(user)) satisfies ListPatentsResponse);
  });

  app.get('/api/v1/patents/:id', (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const patent = getPatentFor(deps.db, c.req.param('id'), patentScope(user));
    if (patent === null) throw new AppError('not_found', '没有这条专利记录。');
    return c.json({ patent } satisfies CreatePatentResponse);
  });

  app.post('/api/v1/patents', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const body = await readJsonObject(c);
    const name = readRequiredText(body['name'], '专利名称');
    const patentNo = optionalText(body['patentNo']) ?? null;
    let applicantName = optionalText(body['applicantName']) ?? null;
    const applicantPersonId = optionalText(body['applicantPersonId']) ?? null;
    const firstSubmittedOn = readDateField(body['firstSubmittedOn'], 'firstSubmittedOn');
    const substantiveExamOn = readDateField(body['substantiveExamOn'], 'substantiveExamOn');
    const publishedOn = readDateField(body['publishedOn'], 'publishedOn');
    const grantedOn = readDateField(body['grantedOn'], 'grantedOn');
    const notes = optionalText(body['notes']) ?? null;

    if (applicantPersonId !== null) {
      const person = getPerson(deps.db, applicantPersonId, peopleViewer(user));
      if (person === null) throw new AppError('invalid_argument', '关联的人员记录不存在。');
      // 申请人姓名保留原表快照；没填时用人员主档姓名兜底。
      applicantName ??= person.name;
    }
    validatePatentDates(firstSubmittedOn, substantiveExamOn, publishedOn);

    const id = createPatent(
      deps.db,
      {
        name,
        patentNo,
        applicantName,
        applicantPersonId,
        firstSubmittedOn,
        substantiveExamOn,
        publishedOn,
        grantedOn,
        notes,
        ownerUserId: user.id,
        createdBy: user.id,
      },
      new Date().toISOString(),
    );
    const patent = getPatent(deps.db, id);
    if (patent === null) {
      throw new AppError('internal', '专利记录刚写入却查不到，请把请求 ID 提供给管理员。');
    }
    return c.json({ patent } satisfies CreatePatentResponse, 201);
  });

  app.patch('/api/v1/patents/:id', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const body = await readJsonObject(c);
    const current = getPatentFor(deps.db, c.req.param('id'), patentScope(user));
    if (current === null) throw new AppError('not_found', '没有这条专利记录。');
    if (!canWritePatent(current, writePatentActor(user))) {
      throw new AppError('permission_denied', '只能编辑自己录入的专利。');
    }

    const expectedRevision = readExpectedRevision(body['expectedRevision']);
    const patch: PatentPatch = {};
    if (body['name'] !== undefined) patch.name = readRequiredText(body['name'], '专利名称');
    if (body['patentNo'] !== undefined) patch.patentNo = optionalText(body['patentNo']) ?? null;
    if (body['applicantName'] !== undefined) {
      patch.applicantName = optionalText(body['applicantName']) ?? null;
    }
    if (body['applicantPersonId'] !== undefined) {
      const personId = optionalText(body['applicantPersonId']) ?? null;
      if (personId !== null) {
        const person = getPerson(deps.db, personId, peopleViewer(user));
        if (person === null) throw new AppError('invalid_argument', '关联的人员记录不存在。');
        if (patch.applicantName === undefined) patch.applicantName = person.name;
      }
      patch.applicantPersonId = personId;
    }
    if (body['firstSubmittedOn'] !== undefined) {
      patch.firstSubmittedOn = readDateField(body['firstSubmittedOn'], 'firstSubmittedOn');
    }
    if (body['substantiveExamOn'] !== undefined) {
      patch.substantiveExamOn = readDateField(body['substantiveExamOn'], 'substantiveExamOn');
    }
    if (body['publishedOn'] !== undefined) {
      patch.publishedOn = readDateField(body['publishedOn'], 'publishedOn');
    }
    if (body['grantedOn'] !== undefined) patch.grantedOn = readDateField(body['grantedOn'], 'grantedOn');
    if (body['notes'] !== undefined) patch.notes = optionalText(body['notes']) ?? null;

    validatePatentDates(
      patch.firstSubmittedOn === undefined ? current.firstSubmittedOn : patch.firstSubmittedOn,
      patch.substantiveExamOn === undefined ? current.substantiveExamOn : patch.substantiveExamOn,
      patch.publishedOn === undefined ? current.publishedOn : patch.publishedOn,
    );

    const patent = updatePatent(deps.db, current.id, patch, new Date().toISOString(), user.id, expectedRevision);
    if (patent === null) throw new AppError('not_found', '没有这条专利记录。');
    return c.json({ patent } satisfies UpdatePatentResponse);
  });

  // ── 大论文（投稿台账信息优化 · 第三步）────────────────────
  //
  // 登录成员可查看成绩，作者本人、导师和管理员可填写成绩。
  app.get('/api/v1/theses', (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const limit = parseLimit(c.req.query('limit'), 200, 500);
    return c.json(
      listTheses(deps.db, { keyword: c.req.query('q'), limit, offset: parseOffset(c.req.query('offset')) }, thesisViewer(user)) satisfies ListThesesResponse,
    );
  });

  app.get('/api/v1/theses/:id', (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const thesis = getThesis(deps.db, c.req.param('id'), thesisViewer(user));
    if (thesis === null) throw new AppError('not_found', '没有这条大论文记录。');
    return c.json({ thesis } satisfies CreateThesisResponse);
  });

  app.post('/api/v1/theses', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const body = await readJsonObject(c);
    const personId = optionalText(body['personId']) ?? null;
    let authorName = optionalText(body['authorName']) ?? null;
    let isAuthor = false;
    if (personId !== null) {
      const person = getPerson(deps.db, personId, peopleViewer(user));
      if (person === null) throw new AppError('invalid_argument', '关联的人员记录不存在。');
      authorName ??= person.name;
      isAuthor = person.isSelf;
    }
    if (authorName === null) {
      throw new AppError('invalid_argument', '请填写作者姓名，或关联一条人员记录。');
    }
    const direction = optionalText(body['direction']) ?? null;
    const title = optionalText(body['title']) ?? null;
    const grade = optionalText(body['grade']) ?? null;
    if (grade !== null && !isAuthor && !hasPermission(user.role, 'thesis.manage')) {
      throw new AppError('permission_denied', '仅论文作者本人、导师和管理员可以填写成绩。');
    }
    const notes = optionalText(body['notes']) ?? null;

    const id = insertThesis(
      deps.db,
      { personId, authorName, direction, title, grade, notes, createdBy: user.id },
      new Date().toISOString(),
    );
    const thesis = getThesis(deps.db, id, thesisViewer(user));
    if (thesis === null) {
      throw new AppError('internal', '大论文记录刚写入却查不到，请把请求 ID 提供给管理员。');
    }
    return c.json({ thesis } satisfies CreateThesisResponse, 201);
  });

  app.patch('/api/v1/theses/:id', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const body = await readJsonObject(c);
    const current = getThesis(deps.db, c.req.param('id'), thesisViewer(user));
    if (current === null) throw new AppError('not_found', '没有这条大论文记录。');

    const expectedRevision = readExpectedRevision(body['expectedRevision']);
    const canManageAll = hasPermission(user.role, 'thesis.manage');
    const canEditDetails = canManageAll || current.createdById === user.id;
    const hasDetails = ['personId', 'authorName', 'direction', 'title', 'notes'].some((key) => body[key] !== undefined);
    if (!canEditDetails && (hasDetails || !current.isSelf || body['grade'] === undefined)) {
      throw new AppError('permission_denied', '只能编辑自己录入的大论文资料。');
    }
    let isAuthor = current.isSelf;
    const patch: ThesisPatch = {};
    if (body['personId'] !== undefined) {
      const personId = optionalText(body['personId']) ?? null;
      if (personId !== current.personId) {
        if (current.grade !== null && !canManageAll) {
          throw new AppError('permission_denied', '已有成绩的论文由导师或管理员更换关联作者。');
        }
        const person = personId === null ? null : getPerson(deps.db, personId, peopleViewer(user));
        if (personId !== null && person === null) throw new AppError('invalid_argument', '关联的人员记录不存在。');
        isAuthor = person?.isSelf ?? false;
        patch.personId = personId;
      }
    }
    if (body['authorName'] !== undefined) {
      patch.authorName = readRequiredText(body['authorName'], '作者姓名');
    }
    if (body['direction'] !== undefined) patch.direction = optionalText(body['direction']) ?? null;
    if (body['title'] !== undefined) patch.title = optionalText(body['title']) ?? null;
    if (body['grade'] !== undefined) {
      if (!isAuthor && !canManageAll) {
        throw new AppError('permission_denied', '仅论文作者本人、导师和管理员可以填写或修改成绩。');
      }
      patch.grade = optionalText(body['grade']) ?? null;
    }
    if (body['notes'] !== undefined) patch.notes = optionalText(body['notes']) ?? null;

    const thesis = updateThesis(deps.db, current.id, patch, new Date().toISOString(), user.id, expectedRevision);
    if (thesis === null) throw new AppError('not_found', '没有这条大论文记录。');
    return c.json({ thesis: getThesis(deps.db, current.id, thesisViewer(user)) ?? thesis } satisfies UpdateThesisResponse);
  });

  // ── Excel 台账导入（投稿台账信息优化 · 第四步）────────────
  //
  // 上传只生成草稿，不写业务表；草稿只属于上传者（管理员可看全部）。
  // 闸门只要求登录，行级归属由 service 判断。
  app.get('/api/v1/ledger-imports', (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const limit = parseLimit(c.req.query('limit'), 50, 200);
    return c.json({ items: listLedgerBatches(deps.db, importViewer(user), limit) } satisfies ListLedgerBatchesResponse);
  });

  app.post('/api/v1/ledger-imports', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    let form: Record<string, string | File>;
    try {
      form = await c.req.parseBody();
    } catch (err) {
      throw new AppError('invalid_argument', '无法解析上传数据，请用 multipart/form-data，字段名 file。', { cause: err });
    }
    const file = form['file'];
    if (file === undefined || typeof file === 'string') {
      throw new AppError('invalid_argument', '请求里没有文件。请用 multipart/form-data，字段名 file。');
    }
    if (!/\.xlsx$/iu.test(file.name)) {
      throw new AppError('invalid_argument', '本期只支持 .xlsx 工作簿。');
    }
    if (file.size > 20 * 1024 * 1024) {
      throw new AppError('invalid_argument', '工作簿超过 20 MB，请拆分后再上传。');
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await createLedgerBatch(
      deps.db,
      join(deps.config.repoRoot, 'data', 'ledger-imports'),
      { buffer, fileName: file.name },
      user.id,
      new Date().toISOString(),
    );
    return c.json(result satisfies UploadLedgerBatchResponse, 201);
  });

  app.get('/api/v1/ledger-imports/:id', (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    return c.json(
      getLedgerBatch(deps.db, c.req.param('id'), importViewer(user)) satisfies LedgerBatchDetailResponse,
    );
  });

  app.patch('/api/v1/ledger-imports/:id/rows/:rowId', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const body = await readJsonObject(c);
    const rawNormalized = body['normalized'];
    let normalized: Record<string, string | null> | undefined;
    if (rawNormalized !== undefined) {
      if (typeof rawNormalized !== 'object' || rawNormalized === null || Array.isArray(rawNormalized)) {
        throw new AppError('invalid_argument', 'normalized 必须是对象。');
      }
      normalized = {};
      for (const [k, v] of Object.entries(rawNormalized as Record<string, unknown>)) {
        if (v !== null && typeof v !== 'string') {
          throw new AppError('invalid_argument', 'normalized 的每个值必须是字符串或 null。');
        }
        normalized[k] = v;
      }
    }
    const skip = body['skip'];
    if (skip !== undefined && typeof skip !== 'boolean') {
      throw new AppError('invalid_argument', 'skip 必须是布尔值。');
    }
    return c.json(
      updateLedgerRow(
        deps.db,
        c.req.param('id'),
        c.req.param('rowId'),
        { ...(normalized === undefined ? {} : { normalized }), ...(skip === true ? { skip: true } : {}) },
        importViewer(user),
        new Date().toISOString(),
      ) satisfies UpdateLedgerRowResponse,
    );
  });

  app.post('/api/v1/ledger-imports/:id/rows/:rowId/import', (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    return c.json(
      importLedgerRow(
        deps.db,
        c.req.param('id'),
        c.req.param('rowId'),
        importViewer(user),
        new Date().toISOString(),
      ) satisfies ImportLedgerRowResponse,
    );
  });

  app.post('/api/v1/ledger-imports/:id/import-ready', (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    return c.json(
      importLedgerReady(deps.db, c.req.param('id'), importViewer(user), new Date().toISOString()) satisfies ImportReadyResponse,
    );
  });

  // ── 台账导出（投稿台账信息优化 · 第五步）────────────────────
  //
  // 模板与示例是固定内容；真实数据按当前可见范围生成，并写审计。
  app.get('/api/v1/ledger-exports/template', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    return xlsxResponse(c, await buildTemplateWorkbook(), 'KnowPilot台账模板.xlsx');
  });

  app.get('/api/v1/ledger-exports/example', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    return xlsxResponse(c, await buildExampleWorkbook(), 'KnowPilot台账示例-禁止导入.xlsx');
  });

  app.post('/api/v1/ledger-exports/data', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const body = await readJsonObject(c);
    const keywordRaw = optionalText(body['keyword']);
    const keyword = keywordRaw ?? null;

    let targets: LedgerImportTarget[] = [...LEDGER_IMPORT_TARGETS];
    const rawTargets = body['targets'];
    if (rawTargets !== undefined) {
      if (!Array.isArray(rawTargets) || rawTargets.some((t) => typeof t !== 'string')) {
        throw new AppError('invalid_argument', 'targets 必须是字符串数组。');
      }
      const invalid = rawTargets.filter((t) => !(LEDGER_IMPORT_TARGETS as readonly string[]).includes(t));
      if (invalid.length > 0) {
        throw new AppError('invalid_argument', `不认识的导出类型：${invalid.join('、')}。`);
      }
      targets = rawTargets.length === 0 ? [] : (rawTargets as LedgerImportTarget[]);
    }

    const role = user.role;
    const canReadAllPatents = hasPermission(role, 'patent.read.all');

    const submissions = searchSubmissions(deps.db, {
      keyword: keyword ?? undefined,
      status: undefined,
      limit: 1000,
      scope: submissionScope(user),
    });
    const patents = listPatents(
      deps.db,
      { keyword: keyword ?? undefined, limit: 1000 },
      { userId: user.id, canReadAll: canReadAllPatents },
    );
    const people = listPeople(
      deps.db,
      { keyword: keyword ?? undefined, limit: 1000 },
      peopleViewer(user),
    ).items;
    const theses = listTheses(
      deps.db,
      { keyword: keyword ?? undefined, limit: 1000 },
      thesisViewer(user),
    ).items;
    const scopeLabel =
      role === 'admin'
        ? '管理员：全库'
        : role === 'mentor'
          ? '导师：全库（当前部署无课题组数据）'
          : '成员：人员与成果、投稿台账共享；学号与大论文成绩可见';
    const now = new Date();
    const built = await buildDataWorkbook({
      submissions,
      patents,
      people,
      theses,
      scopeLabel,
      keyword,
      now,
      targets,
    });

    dbAuditExport(deps.db, user.id, scopeLabel, { keyword, targets }, built.counts, now.toISOString());

    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
      now.getDate(),
    ).padStart(2, '0')}`;
    return xlsxResponse(c, built.buffer, `KnowPilot台账导出-${stamp}.xlsx`);
  });

  // ── 期刊分区库（阶段 3 增补 C）──────────────────────────────
  //
  // 【为什么是单独一页，而不是并进投稿台账】台账回答的是"我投的这篇稿现在
  //   到哪一步了"——那是**我的**动态记录；分区库回答的是"这本刊是几区"——
  //   那是**公共的**静态事实。并进同一张列表，用户就得在"我关心的稿子"里
  //   翻找"一本我没投过的刊"。
  //
  // 【它为什么还兼着"补录"的职责】本地那份分区表只覆盖计算机与遥感两个
  //   方向（见 submissions/seed/）；别的学科、别的年份都要靠用户自己补。
  //   所以这里不只有读接口 —— 没有写接口的话，"支持用户自己添加分区内容"
  //   这条需求就落不了地。
  //
  // 写权限已收口（阶段 4 欠账 6），**拆成三档**（用户 2026-10-11 拍板）：
  //   读 = journal.read；新增 = journal.add（全员——补录缺失的刊本来就是
  //   用户提的需求）；订正/删除 = journal.manage（admin/mentor——动的是
  //   已经有人在依赖的公共数据）。判定在 auth/routes.ts 的声明表里，不在这里。
  app.get('/api/v1/journals', (c) => {
    const keyword = optionalText(c.req.query('q'));
    const limit = parseLimit(c.req.query('limit'), 50, 200);
    const items = searchJournals(deps.db, { keyword, limit }).map((journal) => ({
      ...journal,
      rankings: listRankings(deps.db, journal.id, 50),
    }));
    // total 是**全库**的刊数（不受搜索词影响），matched 是**本次搜索**命中的
    // 真实条数（不受 limit 影响）。两个数分开给：界面要说"命中 137 本、
    // 这里显示前 50"，只有 total 的话它会把被截断的列表当成全部。
    const body: ListJournalsResponse = {
      items,
      total: countJournals(deps.db),
      matched: countJournals(deps.db, keyword),
    };
    return c.json(body);
  });

  app.get('/api/v1/journals/:id/rankings/evidence', (c) => {
    const journalId = c.req.param('id');
    const year = c.req.query('year') ?? '';
    const system = c.req.query('system');
    const category = c.req.query('category');
    if (!/^[1-9]\d{3}$/u.test(year) || !system || category === undefined) {
      throw new AppError('invalid_argument', '分区证据需要完整的年份、体系和维度。');
    }
    const journal = getJournalById(deps.db, journalId);
    const ranking = getRankingByPeriod(deps.db, journalId, Number(year), system, category);
    if (journal === null || ranking === null) throw new AppError('not_found', '没有这条分区记录。');
    c.header('Cache-Control', 'no-store');
    return c.json({
      kind: 'record', recordType: 'M-JOURNAL', recordId: rankingRecordId(journal.id, ranking),
      sourceVersion: [year, system, category].filter(Boolean).join(' '),
      recordTitle: journal.name, recordUpdatedAt: null, queryTime: new Date().toISOString(),
      excerpt: '', fields: rankingFields(ranking, journal.name), matchedBy: ['structured'],
    } satisfies RecordRetrievalHit);
  });

  // 订正一本刊的 ISSN / 领域。与上面那个 POST 的区别写在契约里
  // （`UpdateJournalRequest`）：那个只补空，这个要覆盖。
  // 权限是 `journal.manage`（见上面那张三档说明）。
  app.patch('/api/v1/journals/:id', async (c) => {
    const id = c.req.param('id');
    const current = getJournalById(deps.db, id);
    if (current === null) throw new AppError('not_found', '没有这本期刊。');

    const body = await readJsonObject(c);
    // 字段缺省 = 不动它；传了空串 = 清空（界面上的"删掉这个值"）。
    // 这个三态（缺省 / 有值 / 空串）正是 optionalText 给出的：
    // 它把"未提供、非字符串、去空白后为空"都归一成 undefined —— 所以
    // 这里必须先用 `in` 判断字段**在不在**，再决定要不要采纳它的值。
    const abbr = 'abbr' in body ? (optionalText(body['abbr']) ?? null) : current.abbr;
    const issn = 'issn' in body ? (optionalText(body['issn']) ?? null) : current.issn;
    const field = 'field' in body ? (optionalText(body['field']) ?? null) : current.field;
    const website = 'website' in body ? (optionalWebsite(body['website']) ?? null) : current.website;

    const journal = updateJournal(deps.db, id, { abbr, issn, field, website });
    if (journal === null) throw new AppError('internal', '期刊刚更新却查不到，请把请求 ID 提供给管理员。');
    return c.json({ journal } satisfies UpdateJournalResponse);
  });

  app.post('/api/v1/journals', async (c) => {
    const body = await readJsonObject(c);
    const name = optionalText(body['name']);
    if (name === undefined) {
      throw new AppError('invalid_argument', '缺少 name 字段。新建期刊必须有刊名。');
    }
    const { id, created } = upsertJournal(
      deps.db,
      {
        name,
        abbr: optionalText(body['abbr']) ?? null,
        issn: optionalText(body['issn']) ?? null,
        field: optionalText(body['field']) ?? null,
        website: optionalWebsite(body['website']) ?? null,
      },
      new Date().toISOString(),
    );
    const journal = getJournalById(deps.db, id);
    if (journal === null) {
      throw new AppError('internal', '期刊刚写入却查不到，请把请求 ID 提供给管理员。');
    }
    // 201 = 这次建了本新的；200 = 复用了已有记录（界面据 created 提示）。
    return c.json({ journal, created } satisfies CreateJournalResponse, created ? 201 : 200);
  });

  app.post('/api/v1/journals/:id/rankings', async (c) => {
    const journalId = c.req.param('id');
    if (getJournalById(deps.db, journalId) === null) {
      throw new AppError('not_found', '没有这本期刊。');
    }

    const body = await readJsonObject(c);
    const year = parseRankingYear(body['year']);
    const system = parseJournalSystem(body['system']);
    const rank = optionalText(body['rank']);
    if (rank === undefined) {
      throw new AppError('invalid_argument', '缺少 rank 字段。分区必须有档位，例如「1区」「Q1」。');
    }

    const ranking = insertManualRanking(
      deps.db,
      {
        journalId,
        year,
        system,
        // 维度可空：JCR 只有一套 Category，用户不填时不编一个学科名出来。
        category: optionalText(body['category']) ?? '',
        rank,
        top: body['top'] === true,
        note: optionalText(body['note']) ?? null,
        sourceUrl: optionalText(body['sourceUrl']) ?? null,
      },
      new Date().toISOString(),
    );
    return c.json({ ranking } satisfies AddRankingResponse, 201);
  });

  app.delete('/api/v1/journals/:id/rankings/:rankingId', (c) => {
    const journalId = c.req.param('id');
    if (getJournalById(deps.db, journalId) === null) {
      throw new AppError('not_found', '没有这本期刊。');
    }
    // repo 里只删 source='manual' 的行：导入的那份靠重新导入订正、
    // 联网抓的靠重新抓。放开删除的话，这个按钮会变成"把权威数据删掉"。
    if (!deleteManualRanking(deps.db, journalId, c.req.param('rankingId'))) {
      throw new AppError(
        'not_found',
        '没有这条分区记录，或者它不是人工录入的 —— 导入与联网得到的分区不能在这里删。',
      );
    }
    return c.json({ deleted: true } satisfies DeleteRankingResponse);
  });

  // 订正一条人工录入的分区。**四个字段整条替换**（形状同新增）——
  // 分区总共就这么几个字段，界面手里有整行，逐字段合并只会多出
  // "传了 null 是清空还是不改"这种要解释的输入。
  app.patch('/api/v1/journals/:id/rankings/:rankingId', async (c) => {
    const journalId = c.req.param('id');
    if (getJournalById(deps.db, journalId) === null) {
      throw new AppError('not_found', '没有这本期刊。');
    }

    const body = await readJsonObject(c);
    const year = parseRankingYear(body['year']);
    const system = parseJournalSystem(body['system']);
    const rank = optionalText(body['rank']);
    if (rank === undefined) {
      throw new AppError('invalid_argument', '缺少 rank 字段。分区必须有档位，例如「1区」「Q1」。');
    }

    const result = updateManualRanking(
      deps.db,
      journalId,
      c.req.param('rankingId'),
      {
        year,
        system,
        category: optionalText(body['category']) ?? '',
        rank,
        top: body['top'] === true,
        note: optionalText(body['note']) ?? null,
        sourceUrl: optionalText(body['sourceUrl']) ?? null,
      },
      new Date().toISOString(),
    );

    if (result.outcome === 'not_found') {
      throw new AppError(
        'not_found',
        '没有这条分区记录，或者它不是人工录入的 —— 导入与联网得到的分区不能在这里订正。',
      );
    }
    // 409 而不是 400：请求本身没问题，是它撞上了库里已有的另一条。
    // 用户要做的事也不同 —— 不是改请求，是先决定那两条怎么办。
    if (result.outcome === 'conflict') {
      throw new AppError(
        'invalid_argument',
        '这本刊在这个「年份 + 体系 + 维度」下已经有一条分区了。要改成它，请先删掉那一条。',
        { httpStatus: 409 },
      );
    }
    return c.json({ ranking: result.ranking } satisfies UpdateRankingResponse);
  });

  // ── 代码与数据集（阶段 3 单元 ③）────────────────────────────
  //
  // 【这个页面的作用是"还指得对不对"】文档进了库，"原件在哪"就不重要了；
  //   代码与数据集永远留在文件系统上，库里存的只是一个指路牌。指路牌会失效：
  //   目录被挪走、盘掉线、那台机器关机。所以这里的核心是一个**探测**动作，
  //   而不是一张静态清单（需求 5 的「路径有效性巡检」）。
  //
  // 【探测范围的唯一开关是配置里的允许根目录，不是每行一个主机名】
  //   部署位置还没定，同一份记录会先在一台机器上被看到、再换到另一台上。
  //   用主机名逐行标注等于要求用户提前想清楚最终部署在哪；用白名单则只是
  //   换一个 .env：落到哪台机器，就配那台机器看得见的目录，别的如实报"无法核对"。
  //
  // 读权限已收口（阶段 4 欠账 5 的读侧）：需要 `code.read`。
  //
  app.get('/api/v1/code-assets/:id/evidence', (c) => {
    const evidence = getCodeAssetEvidence(deps.db, c.req.param('id'));
    if (evidence === null) throw new AppError('not_found', '没有这条数据集记录。');
    c.header('Cache-Control', 'no-store');
    return c.json(evidence);
  });

  // 【列表为什么不按登记人过滤】数据集登记的目的就是"让全实验室知道数据在哪" ——
  //   按人筛等于把共享资源变成私有清单，那正是这个模块要解决的问题的反面。
  //   归属只决定**能不能改**（见下面的 assertCanWriteAsset）。
  /**
   * 数据集**写入侧**的前置校验：这条记录存在，且这个人改得动它。
   *
   * 【规则】admin 全权；其余人只能动自己登记的。归属为 NULL 的历史记录
   *   （阶段 1–3 那几条）同样只归 admin —— 理由与投稿台账一致：让任何成员
   *   都能动一条"没有主人"的记录，等于给了它一条没人能解释的改写路径。
   *
   * 【为什么用 admin 而不是"再开一个 code.write.all 权限点"】权限点越多，
   *   角色模板与界面显隐的组合就越多；而"管理员"在这里的语义是明确的、
   *   不会有人误解的。真需要"某个非管理员能改所有人的数据集"时再加点也不迟。
   *
   * 不改动的写操作**不要**调它：核对（check）只更新 last_check_result，
   * 那是任何人点一下都能刷新的客观探测结果，不是谁的编辑内容。
   */
  function assertCanWriteAsset(id: string, user: AuthUser | null): void {
    const owner = getCodeAssetOwner(deps.db, id);
    if (owner === null) throw new AppError('not_found', '没有这条记录。');
    if (user !== null && user.role === 'admin') return;
    if (user !== null && owner.createdBy !== null && owner.createdBy === user.id) return;
    // 与"记录不存在"用同一个状态码：不然 403 就等于确认"这条记录存在，
    // 只是不归你"。列表本来就是人人可读的，所以泄露的不是存在性本身，
    // 而是"哪一条是你登记的" —— 那同样不该由一次删除尝试来回答。
    throw new AppError('not_found', '没有这条记录。');
  }

  app.get('/api/v1/code-assets', (c) => {
    const limit = parseLimit(c.req.query('limit'), 500, 1000);
    const body: ListCodeAssetsResponse = {
      items: listCodeAssets(deps.db, limit),
      // 根目录的可见性是**现探**的，不入库：它是"这台机器此刻"的属性，
      // 存下来必然过期，而过期的"看不到"会让用户去修一个不存在的问题。
      // 把探出来的结果一并返回，是为了让一屏"无法核对"当场就能被解释。
      roots: probeRoots(deps.config.codeRoots),
    };
    return c.json(body);
  });

  app.post('/api/v1/code-assets', async (c) => {
    const input = await readCodeAssetBody(c);
    if (input.documentationId && (!hasPermission(c.get('user')!.role, 'knowledge.read')
      || getDocumentSummary(deps.db, input.documentationId, model) === null)) {
      throw new AppError('invalid_argument', '关联的说明文档不存在或不可见。');
    }

    // 登记顺手核对一次，用户不用再点一下才知道本机看不看得到。
    // 结果是四态之一，所以"看不到"也照样能登记成功 —— 它是信息，不是失败。
    const probe = checkAsset(input.location, input.host, probeRoots(deps.config.codeRoots));
    const now = new Date().toISOString();
    const id = insertCodeAsset(
      deps.db,
      {
        ...input,
        lastCheckResult: probe.result,
        // 登记人决定"以后谁能改它"。这里传 null 的后果是这条记录对所有人可改，
        // 所以宁可留一句断言式的注释，也不让读代码的人以为 null 是正常值。
        createdBy: c.get('user')?.id ?? null,
      },
      now,
    );

    const asset = getCodeAsset(deps.db, id);
    if (asset === null) {
      throw new AppError('internal', '记录刚写入却查不到，请把请求 ID 提供给管理员。');
    }
    return c.json({ asset, reason: probe.reason } satisfies CreateCodeAssetResponse, 201);
  });

  // 这两条的路径长度不同（3 段 vs 4 段），不会互相抢占。
  // 但「全部核对」必须写在前面：先写 :id 那条的话，将来若有人再加一条
  // 两段的 POST 路由就会与它撞车，而那种冲突出错时表现为"调错了接口"，
  // 从错误信息里看不出来。
  app.post('/api/v1/code-assets/check', (c) => {
    const roots = probeRoots(deps.config.codeRoots);
    const assets = listCodeAssets(deps.db, 1000);

    const probes = assets.map((asset) => ({
      id: asset.id,
      ...checkAsset(asset.location, asset.host, roots),
    }));

    const summary: Record<AssetCheckResult, number> = {
      unchecked: 0,
      exists: 0,
      missing: 0,
      unreachable: 0,
    };
    for (const p of probes) summary[p.result] += 1;

    const now = new Date().toISOString();
    saveCheckResults(deps.db, probes, now);

    // 写回之后**重新读一遍**，而不是拿上面那份 asset 拼上结果直接返回：
    // 界面显示的必须是库里真实的样子。拼的话，"界面上已更新、库里其实没写进去"
    // 这种分叉要等到下次打开页面才暴露，而那时已经没人记得是哪一次核对出的问题。
    const reasons = new Map(probes.map((p) => [p.id, p.reason]));
    const items = listCodeAssets(deps.db, 1000).map((asset) => ({
      asset,
      reason: reasons.get(asset.id) ?? '（本次核对没有覆盖到这条记录，请再点一次）',
    }));

    return c.json({ summary, items } satisfies CheckCodeAssetsResponse);
  });

  app.post('/api/v1/code-assets/:id/check', (c) => {
    const id = c.req.param('id');
    const before = getCodeAsset(deps.db, id);
    if (before === null) throw new AppError('not_found', '没有这条记录。');

    const probe = checkAsset(before.location, before.host, probeRoots(deps.config.codeRoots));
    const now = new Date().toISOString();
    saveCheckResults(deps.db, [{ id, result: probe.result }], now);

    const asset = getCodeAsset(deps.db, id);
    if (asset === null) {
      throw new AppError('internal', '核对结果刚写回却查不到这条记录，请把请求 ID 提供给管理员。');
    }
    return c.json({ checked: { asset, reason: probe.reason } } satisfies CheckCodeAssetResponse);
  });

  /**
   * 修改一条记录。
   *
   * 改了 location 或 host 就**顺手重新核对一次**：旧的存在性结论说的是另一个
   * 位置，把它留在一条新路径上，就是让一条过期的判断冒充当前事实。
   * 只改文字字段（名称、项目、怎么获取、备注）则不重核 —— 路径没变，
   * 没有理由推翻上一次的结论，此时响应里的 reason 为 null。
   */
  app.patch('/api/v1/code-assets/:id', async (c) => {
    const id = c.req.param('id');
    const before = getCodeAsset(deps.db, id);
    if (before === null) throw new AppError('not_found', '没有这条记录。');
    assertCanWriteAsset(id, c.get('user'));

    const patch = await readCodeAssetPatch(c);
    if (patch.documentationId && (!hasPermission(c.get('user')!.role, 'knowledge.read')
      || getDocumentSummary(deps.db, patch.documentationId, model) === null)) {
      throw new AppError('invalid_argument', '关联的说明文档不存在或不可见。');
    }
    const now = new Date().toISOString();
    updateCodeAsset(deps.db, id, patch, now);

    // 「有没有动过位置」要拿**改之后**的值和**改之前**的值比，而不是看请求里
    // 有没有 location —— 把路径原样回传（编辑表单就是这么做的）不该触发重核。
    const moved =
      (patch.location !== undefined && patch.location !== before.location) ||
      (patch.host !== undefined && patch.host !== before.host);

    let reason: string | null = null;
    if (moved) {
      const probe = checkAsset(
        patch.location ?? before.location,
        patch.host !== undefined ? patch.host : before.host,
        probeRoots(deps.config.codeRoots),
      );
      saveCheckResults(deps.db, [{ id, result: probe.result }], now);
      reason = probe.reason;
    }

    const asset = getCodeAsset(deps.db, id);
    if (asset === null) {
      throw new AppError('internal', '记录刚改完却查不到，请把请求 ID 提供给管理员。');
    }
    return c.json({ asset, reason } satisfies UpdateCodeAssetResponse);
  });

  /**
   * 删除一条**登记记录**。
   *
   * ⚠️ 只删库里这一行，`location` 指向的数据集一个字节都不动
   *   （见 code/repo.ts 里 deleteCodeAsset 的注释）。
   * ⚠️ 权限已收口（阶段 4 欠账 5）：`code.write` + owner-or-admin。
   *   交互上的二次确认属于界面（那是对人的护栏，不是权限）。
   */
  app.delete('/api/v1/code-assets/:id', (c) => {
    const id = c.req.param('id');
    const before = getCodeAsset(deps.db, id);
    if (before === null) throw new AppError('not_found', '没有这条记录。');
    assertCanWriteAsset(id, c.get('user'));
    deleteCodeAsset(deps.db, id);
    return c.json({
      deleted: { id: before.id, name: before.name, location: before.location },
    } satisfies DeleteCodeAssetResponse);
  });

  // ── 数据集整理（阶段 3 增补 B）──────────────────────────────
  //
  // 【这是本项目第一个会改动真实数据的模块】四条路由的分工：
  //   生成 = 只跑 Agent 拟计划（不动数据）；预览 = 服务端算"会动哪些文件"；
  //   执行 = 用户确认之后真正去移；历史 = 看这个数据集整理过几次。
  //
  // 【为什么"生成"和"执行"必须是两个完全分开的请求】
  //   让 Agent 直接动手的实现方式（给它一个 move 工具）看起来更省事，
  //   但那样"人确认"就只是一句提示词里的嘱咐。拆成两个请求之后，
  //   Agent 手里根本没有写盘的工具 —— "未经确认不会动数据"是结构保证。
  //
  // 权限已收口（阶段 4 欠账 5）：四条路由都要求 `code.write` +
  // owner-or-admin（见 assertCanWriteAsset），并且计划行里的 created_by
  // 从此填的是真正的人 —— 这条路径会真移文件，是本项目风险最高的写动作。

  /** 四条路由共用的前置校验：这条记录存在、归我管、在本机、目录真的在。 */
  function resolveDataset(
    id: string,
    user: AuthUser | null,
  ): { id: string; name: string; dir: string } {
    const asset = getCodeAsset(deps.db, id);
    if (asset === null) throw new AppError('not_found', '没有这条数据集记录。');
    assertCanWriteAsset(id, user);
    if (asset.host !== null && asset.host.trim() !== '') {
      throw new AppError(
        'invalid_argument',
        `这条记录声明它在 ${asset.host} 上，本机不碰它的目录。请到那台机器上操作。`,
      );
    }
    const st = statSync(asset.location, { throwIfNoEntry: false });
    if (st === undefined || !st.isDirectory()) {
      throw new AppError(
        'invalid_argument',
        `这个数据集的目录此刻在本机看不到：${asset.location}。整理前它必须是一个真实存在的目录。`,
      );
    }
    return { id: asset.id, name: asset.name, dir: asset.location };
  }

  app.post('/api/v1/code-assets/:id/organize', async (c) => {
    const dataset = resolveDataset(c.req.param('id'), c.get('user'));
    const body = await readJsonObject(c);

    // 与提问入口同一条闸门：内容会发往云端模型，必须显式确认。
    // 在这里拦而不是只靠界面禁用按钮 —— 脚本和 curl 都会绕过界面。
    if (body['consentConfirmed'] !== true) {
      throw new AppError(
        'invalid_argument',
        '整理对话会说及数据集内容并发送至云端模型处理，需要先确认。' +
          '请在请求体里带上 "consentConfirmed": true。',
      );
    }

    const messages = parseOrganizeMessages(body['messages']);
    const out = await runOrganize(
      { db: deps.db, config: deps.config, models: deps.models },
      {
        datasetDir: dataset.dir,
        datasetName: dataset.name,
        messages,
        requestId: c.get('requestId'),
      },
    );
    return c.json({ reply: out.reply, plan: out.plan } satisfies OrganizeGenerateResponse);
  });

  app.post('/api/v1/code-assets/:id/organize/preview', async (c) => {
    const dataset = resolveDataset(c.req.param('id'), c.get('user'));
    const body = await readJsonObject(c);
    const plan = parseOrganizePlan(body['plan']);
    const { preview } = expandRules(dataset.dir, plan);
    return c.json({ preview } satisfies OrganizePreviewResponse);
  });

  app.post('/api/v1/code-assets/:id/organize/execute', async (c) => {
    const dataset = resolveDataset(c.req.param('id'), c.get('user'));
    const body = await readJsonObject(c);

    if (body['confirmed'] !== true) {
      throw new AppError(
        'invalid_argument',
        '执行整理会移动数据集里的文件，需要先确认。请在请求体里带上 "confirmed": true。',
      );
    }

    const plan = parseOrganizePlan(body['plan']);
    const expectedMoves = parseExpectedMoves(body['expectedMoves']);

    const out = executePlan(deps.db, {
      assetId: dataset.id,
      datasetDir: dataset.dir,
      plan,
      expectedMoves,
      // 计划行是**执行时**落库的（生成阶段只跑模型，不写库），
      // 所以这里记下来的就是"真正动手的那个人"。
      createdBy: c.get('user')?.id ?? null,
    });
    return c.json(out satisfies OrganizeExecuteResponse);
  });

  app.get('/api/v1/code-assets/:id/organize-plans', (c) => {
    const id = c.req.param('id');
    const asset = getCodeAsset(deps.db, id);
    if (asset === null) throw new AppError('not_found', '没有这条数据集记录。');
    const limit = parseLimit(c.req.query('limit'), 20, 200);
    return c.json({ items: listPlans(deps.db, id, limit) } satisfies ListOrganizePlansResponse);
  });

  /**
   * 撤销一次整理：把文件从整理后的位置移回原位。
   *
   * 【为什么和 execute 一样要求 confirmed】它同样会移动真实文件；界面上的
   *   二次确认只是给人的护栏，脚本和 curl 会绕过去。
   * 【为什么还要 resolveDataset】撤销用的是计划里**冻结的** dataset_dir，
   *   但记录本身可能已经被删、目录可能已经不在了、归属也可能变了。
   *   resolveDataset 把"这条记录还归我管、本机能碰"这层先判掉；
   *   "冻结目录是否仍等于当前目录"由 undoPlan 判。
   */
  app.post('/api/v1/code-assets/:id/organize-plans/:planId/undo', async (c) => {
    const dataset = resolveDataset(c.req.param('id'), c.get('user'));
    const body = await readJsonObject(c);
    if (body['confirmed'] !== true) {
      throw new AppError(
        'invalid_argument',
        '撤销整理会移动数据集里的文件，需要先确认。请在请求体里带上 "confirmed": true。',
      );
    }
    const out = undoPlan(deps.db, {
      assetId: dataset.id,
      planId: c.req.param('planId'),
      currentDatasetDir: dataset.dir,
      undoneBy: c.get('user')?.id ?? null,
    });
    return c.json(out satisfies OrganizeUndoResponse);
  });

  // ── 数据集上传（阶段 3 单元 A）──────────────────────────────
  //
  // 【为什么是分片，而不是一个 multipart POST】数据集是 GB 级：一次 POST
  //   要么网关超时、要么把整个文件读进内存、要么传了二十分钟断在 90%
  //   只能从零重来。分片让每一片都是独立的小请求，断了从缺口接着传。
  //
  // 【会话 id 是派生的，不是随机的】见 shared/uploads.ts 顶部：随机 id 意味着
  //   "同一个文件重传"会开出第二个会话，两批分片就会被拼成一份文件，
  //   而拼出来的东西**大小完全正常**，没有任何症状。
  //
  // 【这条路上有一处用户可控的路径】请求体里的 targetDir 决定文件往哪写。
  //   所以路径的解析与校验全部集中在 uploads/layout.ts，这里只调它 ——
  //   别处不许自己 join 出一个路径来。
  //
  // 【为什么不像 /documents 那样要求 consentConfirmed】
  //   勾选确认管的是"内容出不出实验室"（约束 4）。数据集不上传云端、不进知识库、
  //   不会被检索或送进模型 —— 它只是从本地搬到服务器的一块数据。
  //   给它加一道同意闸门会让人以为"数据集也会外发"，反而是错的信息。
  /**
   * 这次上传会话归不归当前用户。
   *
   * 【为什么非要有这一道】会话 id 由**文件自身的特征**派生（见 shared/uploads.ts），
   *   所以它算得出来、不是秘密 —— 没有这一道的话，"接着传别人的半截上传"、
   *   "把别人传了一半的文件拼完落位"、"放弃掉别人正在传的任务"都不需要任何身份。
   *   （这一点在 migrations v16 里记着，那时这张表还是全局的。）
   *
   * 【为什么 admin 放行】管理员要能替人收尾：人走了、或者一个传了一半的会话
   *   占着空间没人管，清理的责任落在他身上。与 code_assets 的 owner-or-admin
   *   同一条口径（见 assertCanWriteAsset）。
   *
   * 【为什么 NULL 归属放行】阶段 3 建这张表时还没有登录，那批会话没有归属可记。
   *   按"NULL = 公共历史数据"处理（见 auth/scope.ts 顶部），不做"洗成某个人的"。
   */
  function canUseSession(row: { createdBy: string | null }, user: AuthUser | null): boolean {
    if (user === null) return false;
    if (user.role === 'admin') return true;
    return row.createdBy === null || row.createdBy === user.id;
  }

  /**
   * 还没传完的会话。**刷新页面之后靠这一条把"服务器上还躺着什么"还给界面。**
   *
   * 只列 `pending`，不接受 `status` 查询参数：已完成的会话不是"待办"，它对应的
   * 文件已经在数据集目录里、也在「数据集管理」里查得到；把它混进这个列表，
   * 界面就得再解释一遍"哪些是还能接着传的"，而那正是这个接口要回答的唯一问题。
   */
  app.get('/api/v1/uploads', (c) => {
    const limit = parseLimit(c.req.query('limit'), 50, 200);
    const items = listSessions(deps.db, 'pending', limit, uploadScope(c.get('user'))).map((row) => {
      const { received, receivedBytes } = listReceived(deps.config, row);
      return toSession(row, received, receivedBytes);
    });
    return c.json({
      items,
      // 绝对路径由服务端给：客户端不知道 DATA_ROOT 配在哪，也不该自己拼一个
      // "看起来对"的路径显示给用户 —— 那是最容易在换部署环境后变成谎话的东西。
      dataRoot: deps.config.dataRoot,
      maxBytes: deps.config.uploadMaxBytes,
    } satisfies ListUploadsResponse);
  });

  app.post('/api/v1/uploads', async (c) => {
    const input = await readUploadCreateBody(c);

    if (input.totalBytes > deps.config.uploadMaxBytes) {
      throw new AppError(
        'invalid_argument',
        `这个文件 ${gb(input.totalBytes)}，超过单次上传上限 ${gb(deps.config.uploadMaxBytes)}。` +
          `上限由 .env 的 UPLOAD_MAX_BYTES 控制，需要的话请让管理员调高。`,
      );
    }

    const targetDir = parseTargetDir(input.targetDir);
    const fileName = parseFileName(input.fileName);
    const dir = resolveTargetDir(deps.config, targetDir);

    const chunkSize = deps.config.uploadChunkSize;
    const chunkCount = Math.ceil(input.totalBytes / chunkSize);
    const id = sessionKey({
      targetDir,
      fileName,
      totalBytes: input.totalBytes,
      lastModifiedMs: input.lastModifiedMs,
    });

    const now = new Date().toISOString();
    let row = getSession(deps.db, id);
    let created = false;

    // 别人的会话不能接管。id 是算出来的，所以这里不是"猜中了一个秘密"，
    // 而是两个人在传**同一个文件** —— 那也是一条真实存在的正常情况
    // （同组的同事往同一个数据集目录传同一份数据）。
    // 409 而不是 404：这种事要说清"文件已经有人在建会话了"，让人知道
    // 该做什么（请对方完成或放弃，或找管理员），而不是一句"没有这个会话"
    // 让他在页面上反复重试。ErrorCode 词表里没有 conflict，靠 httpStatus 指定。
    if (row !== null && !canUseSession(row, c.get('user'))) {
      throw new AppError(
        'invalid_argument',
        '这个文件已经有一个由别人发起的上传会话。会话 id 由文件特征派生，' +
          '所以同一个文件只能有一个在途会话 —— 请让对方完成或放弃它，或者请管理员处理。',
        { httpStatus: 409 },
      );
    }

    if (row === null) {
      insertSession(deps.db, {
        id,
        targetDir,
        fileName,
        totalBytes: input.totalBytes,
        chunkSize,
        chunkCount,
        createdBy: c.get('user')?.id ?? null,
        createdAt: now,
        updatedAt: now,
      });
      row = getSession(deps.db, id);
      if (row === null) throw new AppError('internal', '上传会话刚写入却查不到，请把请求 ID 提供给管理员。');
      created = true;
    } else if (row.status === 'aborted') {
      // 上一次放弃了（或被启动时的清理回收了），同一个文件重传一遍即可。
      reopenSession(deps.db, id, now);
      row = getSession(deps.db, id) ?? row;
    }
    // status === 'completed'：文件已经在这个位置了。什么都不做，把会话原样
    // 返回 —— session.status 与 storedPath 就是答案，前端据此显示"已经传过"。

    const { received, receivedBytes } = listReceived(deps.config, row);

    // 空间检查在建会话时做，**不等到写第一片才发现**。
    // 只检查"还需要多少"，不是整个文件大小：续传时已经落盘的那些片
    // 早就占了空间，按总量再要一遍会把一个传到 90% 的大文件误判成放不下。
    if (row.status === 'pending') {
      assertEnoughSpace(dir, row.totalBytes - receivedBytes);
    }

    // 200 = 接上一次接着传；201 = 新建（或这次才发现早就完成了）。
    const resumed = !created && row.status === 'pending';
    return c.json(
      { session: toSession(row, received, receivedBytes), resumed } satisfies CreateUploadResponse,
      resumed ? 200 : 201,
    );
  });

  // 查一个会话的进度。**刷新页面之后靠这个接口接着传** ——
  // 会话 id 是文件特征算出来的，客户端只要还记得那个文件（哪怕是重新拖进来的
  // 同一个文件），就能算出同一个 id 并问到这里已经收到了哪些片。
  app.get('/api/v1/uploads/:id', (c) => {
    const row = getSession(deps.db, c.req.param('id'));
    // "不是你的"与"不存在"共用同一个答复，理由同 assertCanWriteAsset：
    // 403 等于确认"这个会话存在，只是不归你"，而那本身就是一次信息泄露。
    if (row === null || !canUseSession(row, c.get('user'))) {
      throw new AppError(
        'not_found',
        '没有这个上传会话。它可能已经被放弃，或者从未创建过（请先 POST /api/v1/uploads 建会话）。',
      );
    }
    const { received, receivedBytes } = listReceived(deps.config, row);
    return c.json({ session: toSession(row, received, receivedBytes) } satisfies GetUploadResponse);
  });

  /**
   * 收一片。
   *
   * 请求体是**裸字节**（`application/octet-stream`），不是 multipart ——
   * 一片 8 MB，套一层 multipart 要多一次编码与解析，而这里没有别的字段要带。
   * 每片自己算得出确切长度，所以也不需要 multipart 来分界。
   */
  app.put('/api/v1/uploads/:id/chunks/:index', async (c) => {
    const id = c.req.param('id');
    const row = getSession(deps.db, id);
    if (row === null || !canUseSession(row, c.get('user'))) {
      throw new AppError('not_found', '没有这个上传会话。');
    }
    if (row.status !== 'pending') {
      throw new AppError(
        'invalid_argument',
        `这个会话的状态是「${row.status}」，不再接收分片。` +
          `要重传请对同一个文件重新发起上传。`,
      );
    }

    const rawIndex = c.req.param('index');
    if (!/^\d{1,9}$/u.test(rawIndex)) {
      throw new AppError('invalid_argument', `分片序号必须是数字，收到 "${rawIndex}"。`);
    }
    const index = Number.parseInt(rawIndex, 10);
    // 这一句顺带做了范围校验（越界会抛）。先算出来，才能在下面对比长度。
    const expected = expectedChunkBytes(row, index);

    // 先看声明的长度，再读正文。
    // 【为什么要多这一句】不先看的话，一个声称要传 8 MB 却发了 10 GB 的请求
    // 会先把 10 GB 读进内存，然后才因为我们"发现长度不对"而丢掉 ——
    // 拒绝一个坏请求的成本，不该是一次内存耗尽。
    const declared = c.req.header('content-length');
    if (declared !== undefined) {
      const n = Number(declared);
      if (!Number.isSafeInteger(n) || n !== expected) {
        throw new AppError(
          'invalid_argument',
          `第 ${index} 片声明了 ${declared} 字节，按这次上传的约定应当是 ${expected} 字节。` +
            `客户端不要自己决定分片边界，请用建会话时服务端返回的 chunkSize。`,
        );
      }
    }

    const bytes = Buffer.from(await c.req.arrayBuffer());
    // 实际长度再校验一次：Content-Length 可以缺省（分块传输），也可以撒谎。
    putChunk(deps.config, row, index, bytes);

    touchSession(deps.db, id, new Date().toISOString());
    const { received, receivedBytes } = listReceived(deps.config, row);
    return c.json({ received, receivedBytes } satisfies PutChunkResponse);
  });

  /**
   * 拼装落位。
   *
   * 这一条是**幂等**的：客户端在收到应答之前断了网、重试一次，不该把整份文件
   * 重新拼一遍（那是几十 GB 的读写）。已经 completed 的会话直接返回上次的结果。
   */
  app.post('/api/v1/uploads/:id/complete', async (c) => {
    const id = c.req.param('id');
    const row = getSession(deps.db, id);
    if (row === null || !canUseSession(row, c.get('user'))) {
      throw new AppError('not_found', '没有这个上传会话。');
    }
    if (row.status === 'aborted') {
      throw new AppError(
        'invalid_argument',
        '这个上传已经被放弃（或是太久没动被清理了）。同一个文件重新发起一次上传即可。',
      );
    }

    const body = await readOptionalJsonObject(c);
    // 默认登记：传完就登记，这个数据集才进得了「路径巡检」的射程，
    // Agent 也才查得到它；否则就是一堆"传上去了、此后没人知道它在哪"的文件。
    const register = body['register'] !== false;

    const dir = resolveTargetDir(deps.config, row.targetDir);
    let storedRel: string;
    let sha256: string;

    if (row.status === 'completed' && row.storedPath !== null && row.sha256 !== null) {
      storedRel = row.storedPath;
      sha256 = row.sha256;
    } else {
      const placed = await assembleAndPlace(deps.config, row, dir);
      storedRel = placed.storedPath;
      sha256 = placed.sha256;

      if (!markCompleted(deps.db, id, storedRel, sha256, new Date().toISOString())) {
        // 另一个 complete 抢先落库了（同一个文件被同时提交了两次）。
        // 以**先写进库的那一份**为准：先落库的才是它记下来的事实。
        // 我们刚放下的那份会成为重复文件，如实记一条日志，不悄悄吞掉。
        const winner = getSession(deps.db, id);
        console.error(
          `[${c.get('requestId')}] 同一会话并发完成 id=${id}，` +
            `以先落库的为准 ${winner?.storedPath ?? '(读不到)'}`,
        );
        storedRel = winner?.storedPath ?? storedRel;
        sha256 = winner?.sha256 ?? sha256;
      }
    }

    // byteSize 恒等于 totalBytes：assembleAndPlace 会把长度不对的结果直接丢掉，
    // 走得到这里就说明长度对上了。所以不必再 stat 一次磁盘。
    const byteSize = row.totalBytes;

    let asset: CodeAsset | null = null;
    let reason: string | null = null;
    let assetCreated = false;

    if (register) {
      // 登记的是**目标目录**，不是那个压缩包：计划的下一步很可能就是把包解开、
      // 文件散进这个目录，而压缩包本身删不删由用户决定。目录才是数据集。
      const existing = findCodeAssetByLocation(deps.db, dir);
      if (existing !== null) {
        // 同一个目录传第二个文件是常规操作，不该堆出第二条记录。
        // 这里**不重新核对**：位置没变，沿用上一次的结论 —— 与 PATCH 的
        // 「改位置或改机器才重核」同一条规则。
        asset = existing;
      } else {
        const probe = checkAsset(dir, null, probeRoots(deps.config.codeRoots));
        const now = new Date().toISOString();
        const assetId = insertCodeAsset(
          deps.db,
          {
            name: lastSegment(row.targetDir),
            location: dir,
            project: null,
            host: null,
            accessNote: null,
            // 把"这一份是怎么来的"留在备注里，界面上看得见，可追溯。
            notes: `由数据集上传落位：${row.fileName} → ${storedRel}（${gb(byteSize)}）`,
            lastCheckResult: probe.result,
            // 上传者就是这条记录的登记人 —— 这条记录是上传的副产品，
            // 不该因为"不是从登记表单建的"就变成一条谁都改得动的孤儿。
            createdBy: c.get('user')?.id ?? null,
          },
          now,
        );
        asset = getCodeAsset(deps.db, assetId);
        reason = probe.reason;
        assetCreated = true;
      }
    }

    const fresh = getSession(deps.db, id) ?? row;
    const { received, receivedBytes } = listReceived(deps.config, fresh);

    return c.json({
      session: toSession(fresh, received, receivedBytes),
      storedPath: resolveStoredFile(deps.config, storedRel),
      byteSize,
      sha256,
      asset,
      reason,
      assetCreated,
    } satisfies CompleteUploadResponse);
  });

  /**
   * 放弃一次上传：丢掉已经收到的分片。
   *
   * ⚠️ 已经完成的上传**拒绝**这条路。文件已经落位在数据集目录里了，
   *   而"删数据集"不在这个工具的能力范围内（见 code/repo.ts 的 deleteCodeAsset）。
   *   一个叫 abort 的接口顺手把几十 GB 的数据删了，是那种"点错了才发现"的事故。
   */
  app.delete('/api/v1/uploads/:id', (c) => {
    const id = c.req.param('id');
    const row = getSession(deps.db, id);
    if (row === null || !canUseSession(row, c.get('user'))) {
      throw new AppError('not_found', '没有这个上传会话。');
    }

    if (row.status === 'completed') {
      throw new AppError(
        'invalid_argument',
        '这次上传已经完成、文件已经落在服务器的数据集目录里了，放弃它不会删除那份文件。' +
          '要清理请直接在数据集目录里处理。',
      );
    }

    const discarded = discardChunks(deps.config, id);
    markAborted(deps.db, id, new Date().toISOString());
    return c.json({
      aborted: { id, fileName: row.fileName, discardedChunks: discarded },
    } satisfies AbortUploadResponse);
  });

  // ── 知识沉淀（阶段 5）──────────────────────────────────────
  //
  // 【为什么草案落 knowledge_entries、而不直接落 documents】见 migrations v17
  //   顶部：documents 是"进了索引的东西"的名册，凡是进去的都会被检索到，而安全
  //   卡点 GC-12 要求草案**未确认前检索不到**。所以草案先待在索引之外的表里，
  //   确认时才物化成一份 documents（那是后面的单元）。
  app.post('/api/v1/knowledge/drafts', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    c.header('Cache-Control', 'private, no-store');
    const result = await createKnowledgeDrafts(deps, user, await readJsonObject(c), c.get('requestId'));
    return c.json(result, 201);
  });

  app.patch('/api/v1/knowledge/:id/draft', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    c.header('Cache-Control', 'private, no-store');
    const body = await readJsonObject(c);
    const entry = editKnowledgeDraft(deps.db, user, c.req.param('id'), body);
    return c.json({ entry });
  });

  app.get('/api/v1/knowledge', (c) => {
    c.header('Cache-Control', 'private, no-store');
    const limit = parseLimit(c.req.query('limit'), 50, 200);
    const status = parseKnowledgeStatus(c.req.query('status'));
    const user = c.get('user');
    // canReview 只用来多给"非 proposed"的条目 —— **未确认的草案只对作者本人可见**
    // （见 listVisible 的说明）。它不影响 knowledgeScope 那层"能读全部"的判据。
    const canReview = user !== null && hasPermission(user.role, 'knowledge.review');
    return c.json({
      items: listVisible(deps.db, limit, knowledgeScope(user), status, canReview)
        .map((entry) => presentKnowledgeEntry(entry, user, deps.db)),
    } satisfies ListKnowledgeEntriesResponse);
  });

  // 确认整组。**逐条处理、逐条如实汇报**（照 organize/execute.ts 的部分失败姿态）：
  // 一组里某条撞上冲突或已被处理，不该让整组回滚 —— 用户会以为什么都没成。
  app.post('/api/v1/knowledge/groups/:groupId/confirm', async (c) => {
    const body = await readJsonObject(c);
    if (body['consentConfirmed'] !== true) {
      throw new AppError(
        'invalid_argument',
        '确认后这条知识会进入知识库、可以被全组检索到，需要先确认。' +
          '请在请求体里带上 "consentConfirmed": true。',
      );
    }
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');

    const groupId = c.req.param('groupId');
    const canReview = hasPermission(user.role, 'knowledge.review');
    const all = listByGroup(deps.db, groupId);

    // 【为什么不是"自己的条目筛出来、其他人的跳过"】那样做的话，一个成员对别人的
    //   groupId 会收到 200 + 一串 skipped，等于**确认了这个批次号存在**。
    //   所以不可见的整组一律按"不存在"处理（404），与 code-assets 的
    //   assertCanWriteAsset 是同一条不泄露存在性的做法。
    const visible = all.filter((e) => e.createdById === user.id || (canReview && e.note?.draftSource === undefined));
    if (visible.length === 0) {
      throw new AppError('not_found', '没有这一组待确认的知识草案。');
    }

    const results: { entryId: string; outcome: 'active' | 'conflicted' | 'skipped'; message: string }[] = [];
    for (const candidate of visible) {
      try {
        await withKnowledgeDraftMutation(deps.db, candidate.id, async () => {
          const entry = findEntry(deps.db, candidate.id);
          if (entry === null || entry.status !== 'proposed') {
            const message = entry === null ? '这条草稿已不存在。'
              : `这条已经是「${KNOWLEDGE_STATUS_LABELS[entry.status]}」，不用再确认。`;
            results.push({ entryId: candidate.id, outcome: 'skipped', message });
            return;
          }
          assertKnowledgeDraftReady(deps.db, entry);
          const check = await detectConflict(deps.db, deps.config, entry);
          assertKnowledgeDraftReady(deps.db, entry);
          if (check.kind === 'conflict') {
            const note = { ...entry.note, conflict: check.conflict };
            if (entry.note?.draftSource === undefined) {
              markConflicted(deps.db, entry.id, note);
            } else {
              deps.db.exec('BEGIN IMMEDIATE');
              try {
                assertKnowledgeDraftReady(deps.db, entry);
                markConflicted(deps.db, entry.id, note);
                deps.db.exec('COMMIT');
              } catch (error) {
                deps.db.exec('ROLLBACK');
                throw error;
              }
            }
            results.push({
              entryId: entry.id,
              outcome: 'conflicted',
              message: `与一条已有知识相似度 ${check.conflict.score.toFixed(3)}（阈值 ${check.conflict.threshold}），已挂起等待裁决，没有入库。`,
            });
            return;
          }
          const note = check.kind === 'skipped' ? { ...entry.note, reason: check.reason } : entry.note;
          const admitted = await admitEntry(deps.db, deps.config, {
            entry,
            actor: { id: user.id },
            note,
            ...(entry.note?.draftSource === undefined ? {} : {
              revalidate: () => assertKnowledgeDraftReady(deps.db, entry),
            }),
          });
          results.push({
            entryId: entry.id,
            outcome: 'active',
            message: (admitted.duplicated
              ? '已确认。库中已有一份内容完全相同的文档，这条复用了它 —— 检索到的是同一份。'
              : '已确认并入库，现在检索得到了。') +
              (check.kind === 'skipped' ? `（注意：${check.reason}）` : ''),
          });
        });
      } catch (err) {
        const reason = err instanceof AppError ? err.message : '入库时发生未预期的错误';
        console.error(`[${c.get('requestId')}] 知识条目 ${candidate.id} 入库失败：`, err);
        results.push({ entryId: candidate.id, outcome: 'skipped', message: `这条没能入库：${reason}` });
      }
    }

    return c.json({ results } satisfies ConfirmKnowledgeGroupResponse);
  });

  // 审核队列只显示主动提交的冲突条目。响应带上当前阈值 ——
  // 界面必须说清"≥ 多少会挂起"，否则用户不知道一条为什么被拦下。
  app.get('/api/v1/knowledge/review', (c) => {
    c.header('Cache-Control', 'private, no-store');
    const limit = parseLimit(c.req.query('limit'), 100, 500);
    return c.json({
      items: listReviewQueue(deps.db, limit).map((entry) => presentKnowledgeEntry(entry, c.get('user'), deps.db)),
      threshold: deps.config.knowledgeConflictThreshold,
    } satisfies KnowledgeReviewQueueResponse);
  });

  // 驳回单条草案。**终态、保留行**（见 shared/knowledge.ts 的状态机说明）：
  // "这条被谁驳回过"只有这里能留下记录，物理删行就把这条线索彻底抹掉了。
  app.post('/api/v1/knowledge/:id/reject', async (c) => {
    const body = await readJsonObject(c);
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');

    const id = c.req.param('id');
    const entry = findEntry(deps.db, id);
    const canReview = hasPermission(user.role, 'knowledge.review');
    if (entry === null || (entry.createdById !== user.id && (!canReview || entry.note?.draftSource !== undefined))) {
      throw new AppError('not_found', '没有这条知识条目。');
    }
    return withKnowledgeDraftMutation(deps.db, id, async () => {
      if (entry.status !== 'proposed') {
        throw new AppError(
          'invalid_argument',
          `这条已经是「${KNOWLEDGE_STATUS_LABELS[entry.status]}」，不能再驳回。`,
        );
      }

      const reason = readOptionalReason(body['reason'], '驳回原因');
      markRejected(deps.db, id, reason === null ? entry.note : { ...entry.note, reason });
      const after = findEntry(deps.db, id);
      if (after === null) throw new AppError('internal', '驳回后回读失败。');
      return c.json({ entry: presentKnowledgeEntry(after, user, deps.db) } satisfies RejectKnowledgeResponse);
    });
  });

  // 重新提交：把一条已驳回 / 已撤回的知识，作为一条**新草案**提回来。
  //
  // 【为什么产出一条新行，而不是把原行改回 proposed】原行是"这条被谁驳回过 /
  //   谁撤回过"的唯一留痕（见 shared/knowledge.ts 的状态机说明），原地复活等于
  //   把它抹掉。所以新 id、新批次号，原行一个字节都不动。
  app.post('/api/v1/knowledge/:id/resubmit', async (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');

    const source = findEntry(deps.db, c.req.param('id'));
    const canReview = hasPermission(user.role, 'knowledge.review');
    // 不存在与不可见回同一个 404（同驳回）：不让人拿状态码探"这条存不存在"。
    if (source === null || (source.createdById !== user.id && (!canReview || source.note?.draftSource !== undefined))) {
      throw new AppError('not_found', '没有这条知识条目。');
    }
    if (!isKnowledgeResubmittable(source.status)) {
      throw new AppError(
        'invalid_argument',
        `这条现在是「${KNOWLEDGE_STATUS_LABELS[source.status]}」，` +
          `只有已驳回或已撤回的条目可以重新提交。`,
      );
    }

    assertKnowledgeDraftSource(deps.db, source);
    const id = randomUUID();
    insertResubmission(deps.db, {
      id,
      kind: source.kind,
      content: source.content,
      observedAt: new Date().toISOString(),
      groupId: randomUUID(),
      createdBy: user.id,
      sourceEntryId: source.id,
      source,
    });
    const after = findEntry(deps.db, id);
    if (after === null) throw new AppError('internal', '重新提交后回读失败。');
    return c.json({ entry: presentKnowledgeEntry(after, user, deps.db) } satisfies ResubmitKnowledgeResponse);
  });

  // 撤回一条已生效的知识：把它从索引里撤下。**不可撤销**（要恢复只能重新提交）。
  //
  // 【顺序：先撤索引、再改状态】与 supersede 一致。反过来的中间态是"状态说撤回
  //   了、内容还搜得到"，比"文档没了、状态还没改"糟得多。
  app.post('/api/v1/knowledge/:id/withdraw', async (c) => {
    const body = await readJsonObject(c);
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');

    const id = c.req.param('id');
    const entry = findEntry(deps.db, id);
    const canReview = hasPermission(user.role, 'knowledge.review');
    if (entry === null || (entry.createdById !== user.id &&
        (!canReview || (entry.note?.draftSource !== undefined && entry.note.draftSubmitted !== true)))) {
      throw new AppError('not_found', '没有这条知识条目。');
    }
    if (entry.status !== 'active') {
      throw new AppError(
        'invalid_argument',
        `这条现在是「${KNOWLEDGE_STATUS_LABELS[entry.status]}」，只有已生效的条目可以撤回。`,
      );
    }

    const reason = readOptionalReason(body['reason'], '撤回原因');
    const now = new Date().toISOString();
    // 有引用者就不删（两条一字不差的知识共用一份文档）。为 false 时界面要说实话：
    // 这条已撤回，但相同内容还被另一条已生效的知识引用，索引没有撤下。
    const documentRemoved =
      entry.documentId !== null &&
      withdrawDocumentIfUnreferenced(deps.db, entry.documentId, entry.id) > 0;
    markWithdrawn(deps.db, id, {
      ...(entry.note ?? {}),
      withdrawn: { by: user.id, at: now, ...(reason === null ? {} : { reason }) },
    });
    const after = findEntry(deps.db, id);
    if (after === null) throw new AppError('internal', '撤回后回读失败。');
    return c.json({ entry: presentKnowledgeEntry(after, user, deps.db), documentRemoved } satisfies WithdrawKnowledgeResponse);
  });

  // 裁决冲突。三种选择，见 shared 的 KNOWLEDGE_RESOLUTION_LABELS。
  //
  // 【为什么只有 review 者能调】这条路由的闸门是 knowledge.review。冲突是
  //   "两条知识打架"，它影响的是全组的检索结果，不该由提交人自己决定。
  app.post('/api/v1/knowledge/:id/resolve', async (c) => {
    const body = await readJsonObject(c);
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');

    const id = c.req.param('id');
    const resolution = readResolution(body['resolution']);
    const entry = findEntry(deps.db, id);
    if (entry === null || (entry.note?.draftSource !== undefined && entry.note.draftSubmitted !== true &&
        entry.createdById !== user.id)) {
      throw new AppError('not_found', '没有这条知识条目。');
    }
    return withKnowledgeDraftMutation(deps.db, id, async () => {
      if (entry.status !== 'conflicted') {
        throw new AppError(
          'invalid_argument',
          `这条现在是「${KNOWLEDGE_STATUS_LABELS[entry.status]}」，只有「冲突待裁决」的条目需要裁决。`,
        );
      }

      const now = new Date().toISOString();
      const conflict = entry.note?.conflict;

      // ── 驳回本条：最省事的一条。新条落终态，旧条一个字节都不动。 ──
      if (resolution === 'reject') {
        markRejected(deps.db, id, {
          ...(entry.note ?? {}),
          resolution: { kind: 'reject', by: user.id, at: now },
        });
        const after = findEntry(deps.db, id);
        if (after === null) throw new AppError('internal', '裁决后回读失败。');
        return c.json({ entry: presentKnowledgeEntry(after, user, deps.db), supersededEntryId: null } satisfies ResolveKnowledgeResponse);
      }

      // 「取代已有」必须有明确的取代对象。拿不到邻居（note 坏了、或邻居已被删）
      // 就不能假装能做到 —— 静默降级成"允许并存"会让用户以为旧的已经被撤下了。
      if (resolution === 'supersede' && conflict === undefined) {
        throw new AppError(
          'invalid_argument',
          '这条记录里没有冲突对象，无法「取代已有」。请改用「允许并存」或「驳回本条」。',
        );
      }

      const note = {
        ...(entry.note ?? {}),
        resolution: {
          kind: resolution,
          by: user.id,
          at: now,
          ...(resolution === 'supersede' && conflict !== undefined
            ? { supersededEntryId: conflict.neighborEntryId }
            : {}),
        },
      };

      assertKnowledgeDraftReady(deps.db, entry);
      const admitted = await admitEntry(deps.db, deps.config, {
        entry,
        actor: { id: user.id },
        note,
        ...(entry.note?.draftSource === undefined ? {} : { revalidate: () => assertKnowledgeDraftReady(deps.db, entry) }),
      });

      let supersededEntryId: string | null = null;
      if (resolution === 'supersede' && conflict !== undefined) {
        const neighbor = findEntry(deps.db, conflict.neighborEntryId);
        if (neighbor !== null) {
          supersededEntryId = neighbor.id;
          // 【顺序很关键：先撤索引，再标状态】
          //   反过来的中间态是"状态说被取代了、内容还搜得到"，比"文档没了、状态还没
          //   改过来"糟得多。
          // 【为什么用带引用计数的守卫，而不是裸 DELETE】两条一字不差的知识会共用
          //   同一份文档（uploadDocument 的 content_hash 去重）；"新条与邻居同文档"
          //   只是它的一种情形，守卫一并覆盖，不再单独判断 admitted.documentId。
          if (neighbor.documentId !== null) {
            const removed = withdrawDocumentIfUnreferenced(deps.db, neighbor.documentId, neighbor.id);
            if (removed === 0) {
              // 两种可能：文档已不在表里（异常），或仍有别的已生效条目指着它（正常）。
              // 不再为后者报警 —— 共用文档是预期内的情形，不是故障。
              console.warn(
                `[${c.get('requestId')}] 取代裁决：邻居 ${neighbor.id} 的文档 ` +
                  `${neighbor.documentId} 未被撤下（已不存在，或仍有别的已生效条目引用它）。`,
              );
            }
          }
          markSuperseded(deps.db, neighbor.id, {
            ...(neighbor.note ?? {}),
            resolution: { kind: 'supersede', by: user.id, at: now, supersededEntryId: neighbor.id },
          });
        }
      }

      const after = findEntry(deps.db, id);
      if (after === null) throw new AppError('internal', '裁决后回读失败。');
      return c.json({ entry: presentKnowledgeEntry(after, user, deps.db), supersededEntryId } satisfies ResolveKnowledgeResponse);
    });
  });

  // ── 巡检（阶段 6）──────────────────────────────────────────
  //
  // 【为什么规则的读写、"立即巡检"都归 patrol.manage】它们动的是**全实验室
  //   共用**的判定规则与待办集合。成员没有规则可配，也没有"替所有人跑一次
  //   巡检"的职责；他们只会看到挂在自己投稿上的那些待办。
  //
  // 【为什么 tasks 的权限是 authenticated 而不是 patrol.manage】成员要看
  //   **自己的**待办。可见性由 repo 里的 SQL 谓词收口（有 patrol.manage 看全部，
  //   否则只看严格属于自己的），所以这里登记最弱的 authenticated 即可 ——
  //   与 /me/* 同一条思路：行级过滤已经保证了边界，再叠一个权限点只会多一个
  //   要跟着同步的地方。
  app.get('/api/v1/patrol/rules', (c) => {
    return c.json({ rules: listRules(deps.db) } satisfies PatrolRulesResponse);
  });

  // 改规则。PATCH 语义：只传要改的项，不出现的键一律不动。
  app.patch('/api/v1/patrol/rules', async (c) => {
    const body = await readJsonObject(c);
    const updates = parsePatrolRuleUpdates(body);

    const actor = c.get('user');
    if (actor === null) {
      throw new AppError('internal', '当前请求没有登录用户，无法记录规则修改人。');
    }

    const now = new Date().toISOString();
    // 多条改动一个事务：一次 PATCH 要么全生效、要么一条都不动。半生效的规则集
    // 会让"我明明把外审改成 45 天了"变成一桩谁都说不清的悬案。
    deps.db.exec('BEGIN');
    try {
      for (const u of updates) {
        const patch: { thresholdDays?: number; enabled?: boolean } = {};
        if (u.thresholdDays !== undefined) patch.thresholdDays = u.thresholdDays;
        if (u.enabled !== undefined) patch.enabled = u.enabled;
        const updated = updateRule(deps.db, u.status, patch, actor.id, now);
        if (updated === null) {
          throw new AppError('invalid_argument', `巡检规则里没有「${u.status}」这一档。`);
        }
      }
      deps.db.exec('COMMIT');
    } catch (err) {
      deps.db.exec('ROLLBACK');
      throw err;
    }
    return c.json({ rules: listRules(deps.db) } satisfies PatrolRulesResponse);
  });

  // 立即巡检一次。与定时巡检走的是**同一个** `reconcile` ——
  // 手工触发不是另一套逻辑，否则"手动跑出来的结论和自动的不一样"会没法解释。
  app.post('/api/v1/patrol/run', (c) => {
    return c.json(reconcile(deps.db, new Date()) satisfies PatrolRunSummary);
  });

  app.get('/api/v1/patrol/tasks', (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');
    const limit = parseLimit(c.req.query('limit'), 200, 500);
    return c.json({ items: listTasks(deps.db, limit, patrolViewer(user)) } satisfies PatrolTasksResponse);
  });

  // 忽略一条待办。记下忽略人与时间；**只对这一版投稿生效** ——
  // 投稿一更新、又还超期，会重新生成一条新待办（见 scan.ts 的对账规则 2/4）。
  app.post('/api/v1/patrol/tasks/:id/dismiss', async (c) => {
    const raw = await readJsonObject(c);
    const reasonRaw = raw['reason'];
    const reason =
      typeof reasonRaw === 'string' && reasonRaw.trim() !== ''
        ? reasonRaw.trim().slice(0, DISMISS_REASON_MAX_CHARS)
        : null;

    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');

    const task = dismissTask(
      deps.db,
      c.req.param('id'),
      patrolViewer(user),
      reason,
      new Date().toISOString(),
    );
    // 看不见 / 不存在 / 已消解，对外都是同一个 404 —— 不泄露"这条存在但不是你的"
    //（与 submissions 的 404 口径一致）。
    if (task === null) throw new AppError('not_found', '没有这条待办。');
    return c.json({ task } satisfies DismissPatrolTaskResponse);
  });

  // ── 用量治理（阶段 6）──────────────────────────────────────
  //
  // 【为什么权限是 usage.read.all 而不是 authenticated】这一页是**全实验室**的
  //   花费与**每个人**的用量。成员自己的账在 /me/usage（`usage.read.own`）——
  //   "我的账"与"所有人的账"是两件事，权限点也就该是两个。拿不到的那块不该
  //   靠界面藏起来，而该由闸门挡在门外。
  //
  // 【since 收的是绝对时刻，不是"最近 N 天"】省得服务端再猜一次时区。
  //   缺省 = 全部历史，并把 null 如实带回，让界面能写清统计范围。
  app.get('/api/v1/admin/usage', (c) => {
    const since = parseSince(c.req.query('since'));
    const byUser = sumUsageByUser(deps.db, since ?? undefined).map((row) => ({
      key: row.userId ?? 'unattributed',
      label: row.userId === null ? '未记录归属（阶段 1–3）' : (row.displayName ?? row.userId),
      totals: toMyUsageTotals(row.totals),
      // 只在无归属这一桶上带这个标记：界面据此把它单独说明，
      // 而不是混进"按人"里当成一个叫"未记录"的人。
      ...(row.userId === null ? { isUnattributed: true } : {}),
    }));
    const byDay = listUsageByLocalDay(deps.db, since ?? undefined).map((row) => ({
      key: row.day,
      label: row.day,
      totals: toMyUsageTotals(row.totals),
    }));
    const body: AdminUsageResponse = {
      total: toMyUsageTotals(sumUsageTotal(deps.db, since ?? undefined)),
      since,
      byUser,
      byDay,
      // 本阶段只读展示配额：配了行就是"已配置"，但**不阻断任何请求**
      // （03 号 §7 的 A 类成本边界）。没配就如实说"未设"，不显示 0。
      quota: { configured: countUserQuotas(deps.db) > 0 },
    };
    return c.json(body);
  });

  // ── 回答反馈（O5，管理端）──────────────────────────────────
  //
  // 【为什么列表要带全量计数】筛选按钮上写"踩 12 / 赞 5"。如果计数跟着筛选走，
  //   切到"赞"时"踩"会变成 0 —— 用户会以为踩的记录全没了。
  //
  // 【为什么默认不筛】进入页面先看到全部反馈，再点"只看踩"。默认只给踩的话，
  //   那些"赞"永远没人看，而它们恰恰是判断"这套问答到底有没有用"的正样本。
  app.get('/api/v1/admin/feedback', (c) => {
    const raw = c.req.query('rating');
    let rating: FeedbackRating | null = null;
    if (raw === 'up' || raw === 'down') {
      rating = raw;
    } else if (raw !== undefined && raw !== '' && raw !== 'all') {
      // 拼错筛选值不能静默退化成"全部" —— 那会让一次笔误看起来像"这一档一条都没有"。
      throw new AppError('invalid_argument', 'rating 只能是 up、down 或 all。');
    }

    const body: ListAdminFeedbackResponse = {
      items: listAdminFeedback(deps.db, rating, parseLimit(c.req.query('limit'), 200, 500)),
      counts: feedbackCounts(deps.db),
    };
    return c.json(body);
  });

  /**
   * 把一条反馈导出成**评测用例草稿**（JSON 附件由前端生成）。
   *
   * 【为什么是 POST 而不是 GET】导出会写一条审计记录（谁在什么时候导出了哪次运行）。
   *   GET 带副作用的话，浏览器预取、刷新、爬虫都会在审计里留下痕迹。
   *
   * 【为什么草稿里没有回答正文】系统从来就没存过（迁移 v6 / v20）。管理员要复现，
   *   得回到问答页用同一个问题再问一次 —— 这条说明写在 `notice` 里，随文件一起走。
   */
  app.post('/api/v1/admin/feedback/:runId/export', (c) => {
    const user = c.get('user');
    if (user === null) throw new AppError('unauthenticated', '请先登录。');

    const runId = c.req.param('runId');
    const item = getAdminFeedback(deps.db, runId);
    if (item === null) throw new AppError('not_found', '没有找到这条反馈。');

    const generatedAt = new Date().toISOString();
    insertFeedbackExport(deps.db, {
      id: randomUUID(),
      runId,
      rating: item.rating,
      exportedBy: user.id,
      exportedAt: generatedAt,
    });

    const question = item.question ?? '（原问答记录已不存在）';
    const caseId = `FB-${runId.slice(0, 8).toUpperCase()}`;
    const reasonText =
      item.rating === 'down' && item.reasons.length > 0
        ? item.reasons.map((r) => FEEDBACK_REASON_LABELS[r as FeedbackDownReason] ?? r).join('、')
        : '（未选原因）';
    const draft: FeedbackCaseDraft = {
      kind: 'knowpilot-eval-case-draft',
      generatedAt,
      exportedBy: user.displayName,
      runId,
      question: item.question,
      run: {
        askedAt: item.askedAt,
        outcome: item.outcome,
        citationCount: item.citationCount,
        gapCount: item.gapCount,
      },
      feedback: {
        rating: item.rating,
        reasons: item.reasons,
        note: item.note,
        updatedAt: item.updatedAt,
      },
      caseDraft: {
        id: caseId,
        title: question.length > 40 ? `${question.slice(0, 40)}…` : question,
        category: 'Outcome',
        kind: 'model',
        blocker: false,
        regression: false,
        scenario: `用户对一次问答打了${item.rating === 'down' ? '踩' : '赞'}（${reasonText}）。原问题见 question；需先复现该次回答，再决定这条用例要判什么。`,
        question: item.question ?? '',
        gold: [],
        checks: [],
        note: '待人工补齐：gold（金标语料标签）与 checks（判定项）必须由人填写。本文件不会自动并入评测基线。',
      },
      notice:
        '本草稿含提问原文与用户反馈，可能涉及未发表材料，请仅在本地评测环境使用。' +
        '系统不保存回答正文，复现请回到问答页用同一问题重新提问。',
    };

    return c.json({
      draft,
      fileName: `feedback-draft-${caseId}.json`,
    } satisfies ExportFeedbackDraftResponse);
  });

  // ── 运行 Trace（O7，管理端只读）────────────────────────────
  //
  // 【为什么是 admin 独有】Trace 里除了提问原文，还有工具查询词、预算、提示词
  //   哈希与内部诊断字段。它能回答"这次为什么慢/为什么空"，属于运维视角的数据；
  //   导师的 `askRecord.read.all` 是"看本组问了什么"，不该顺带看到这些。
  //
  // 【筛选缺省 = 不筛】与反馈页同一条判断：进入页面先看到全部，再按结果/人/ID
  //   收窄。拼错的 outcome 不能静默退化成"全部"—— 那会让一次笔误看起来像
  //   "这一档一条都没有"。
  app.get('/api/v1/admin/traces', (c) => {
    const rawOutcome = c.req.query('outcome');
    let outcome: AskOutcome | undefined;
    if (rawOutcome !== undefined && rawOutcome !== '' && rawOutcome !== 'all') {
      if (!ASK_OUTCOMES.includes(rawOutcome as AskOutcome)) {
        throw new AppError(
          'invalid_argument',
          `outcome 只能是 ${ASK_OUTCOMES.join(' / ')} 或 all。`,
        );
      }
      outcome = rawOutcome as AskOutcome;
    }

    const runId = (c.req.query('runId') ?? '').trim();
    const userId = (c.req.query('userId') ?? '').trim();
    const body: ListAdminTracesResponse = listRunTraces(deps.db, {
      ...(runId === '' ? {} : { runId }),
      ...(userId === '' ? {} : { userId }),
      ...(outcome === undefined ? {} : { outcome }),
      limit: parseLimit(c.req.query('limit'), 100, 500),
    });
    return c.json(body);
  });

  app.get('/api/v1/admin/traces/:runId', (c) => {
    const item = getRunTrace(deps.db, c.req.param('runId'));
    if (item === null) throw new AppError('not_found', '没有找到这次运行的 Trace。');
    return c.json(item satisfies AdminTraceDetail);
  });

  app.notFound((c) => {
    const body: ApiErrorBody = {
      error: {
        code: 'not_found',
        title: '接口不存在',
        message: `没有这个接口：${c.req.method} ${c.req.path}`,
        retryable: false,
        requestId: c.get('requestId'),
      },
    };
    return c.json(body, 404);
  });

  // ── 统一错误出口 ───────────────────────────────────────────
  app.onError((err, c) => {
    const requestId = c.get('requestId');
    const { code, httpStatus, title, message, retryable, retryDelayMs } = describe(err);

    // 完整堆栈只进服务端日志，绝不返回给客户端 ——
    // 堆栈会泄露文件路径、SQL、依赖版本，是给攻击者的免费情报。
    console.error(`[${requestId}] 未处理错误 code=${code}`, err);

    const body: ApiErrorBody = {
      error: {
        code,
        title,
        message,
        retryable,
        requestId,
        ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
      },
    };
    return c.json(body, httpStatus as 400);
  });

  // ── 启动自检：每条路由都必须登记了权限 ──────────────────────
  //
  // 【为什么放在最后、而且抛错而不是打日志】见 auth/routes.ts 顶部。
  //   放在最后是因为它要检查**全部**路由，包括上面刚注册的这些；
  //   抛错是因为"某条接口没有权限校验"是那种必须在启动时就拦下的错误 ——
  //   打一行日志会被淹没，而漏掉的多半是后加的写接口。
  verifyRouteCoverage(app.routes);

  return app;
}

const TITLES: Record<ErrorCode, string> = {
  invalid_argument: '参数有误',
  not_found: '未找到',
  permission_denied: '无权限',
  unauthenticated: '未登录',
  rate_limited: '请求过于频繁',
  upstream_unavailable: '上游服务不可用',
  context_overflow: '内容过长',
  quota_exceeded: '额度不足',
  auth_failed: '上游认证失败',
  insufficient_storage: '磁盘空间不足',
  internal: '服务内部错误',
};

/**
 * 取客户端 IP，用于登录限流。
 *
 * 【为什么优先取连接的地址，而不是先看 `x-forwarded-for`】
 *   那个头是**客户端可以随便写的**。优先信它，等于给了攻击者一个免费的
 *   限流绕过按钮：每换一个伪造值就是一个新的计数器。所以默认认直连地址
 *   （它由内核给出，伪造不了），只在拿不到连接信息时才退回请求头。
 *
 * 【已知限制】服务挂在反向代理后面时，直连地址是代理的地址，所有人
 *   共用一个计数器（10 次/15 分钟）。单实验室直连部署没有这个问题；
 *   真上了代理再决定要不要加一个"信任代理"的配置项，届时按配置决定
 *   信不信那个头 —— 而不是像现在这样无条件不信。
 *
 * 【拿不到时为什么返回 'unknown' 而不是抛】验证脚本走 `app.request`，
 *   根本没有连接信息。此时所有请求共用 'unknown' 这一个桶，
 *   限流退化成"全局一档"（而不是完全不限流）—— 测不出问题，
 *   但也没有把门敞开。
 */
function clientIp(c: Context<Env>): string {
  try {
    const address = getConnInfo(c).remote.address;
    if (address !== undefined && address !== '') return address;
  } catch {
    // 非 Node 适配器 / app.request：没有连接信息，往下走。
  }
  // ⚠️ 这一条是**可伪造**的（客户端能自己写这个头）。它只作为兜底：
  // 正常经由 @hono/node-server 收进来的请求都会在上一步返回。
  // 若将来真的部署在反向代理后面，这里需要改成"只信任代理的地址" ——
  // 但那是部署形态变了才要解决的问题，现在不假装已经解决。
  const fwd = c.req.header('x-forwarded-for');
  const first = fwd?.split(',')[0]?.trim();
  return first !== undefined && first !== '' ? first : 'unknown';
}

/**
 * 解析 limit 查询参数。非法值不报错、直接退回默认值 ——
 * limit 是"少给几条"这种无关痛痒的偏好，为 `/search?limit=abc` 返回 400
 * 只会让前端多写一段没意义的错误处理。真正的上限由 max 兜住，
 * 防止有人用 limit=999999 把整库一次性拖出来。
 */
/**
 * 解析 material 查询参数。
 *
 * 与 limit 的处理方式刻意相反：limit 非法就退回默认值（少几条无所谓），
 * material 非法必须报错。因为 material 是筛选条件 —— 默默忽略它，
 * 用户会以为"实验室制度里就是没有这条"，而真相是他拼错了参数名，
 * 于是得到一个看似正常、实则错误的答案。这类错误比报错危险得多。
 */
function parseMaterial(raw: string | undefined): Material | undefined {
  if (raw === undefined || raw === '') return undefined;
  const found = MATERIALS.find((m) => m === raw);
  if (found === undefined) {
    throw new AppError(
      'invalid_argument',
      `未知的材料类型 "${raw}"。可用：${MATERIALS.join('、')}`,
    );
  }
  return found;
}

/**
 * 解析 mode 查询参数。缺省是 hybrid。
 *
 * 与 material 同类，非法值【必须报错】，不能悄悄退回默认值：
 * mode 决定走哪条检索路径，退回了就等于用户以为在用语义检索、实际拿到的是
 * 关键词结果，而两者都会给出"看起来正常"的结果列表，用户无从察觉。
 * 这类静默的错配比一个 400 危险得多。
 */
function parseMode(raw: string | undefined): SearchMode {
  if (raw === undefined || raw === '') return 'hybrid';
  const found = SEARCH_MODES.find((m) => m === raw);
  if (found === undefined) {
    throw new AppError(
      'invalid_argument',
      `未知的检索模式 "${raw}"。可用：${SEARCH_MODES.join('、')}`,
    );
  }
  return found;
}

/**
 * 把请求体读成字符串，**顺带拒绝非法 UTF-8**。
 *
 * 【为什么不能直接用 `c.req.json()` / `c.req.text()`】按 fetch 规范，它们内部
 *   用的是 TextDecoder 的**非致命**模式：坏字节不报错，而是静默变成 U+FFFD
 *   （替换字符）。于是一段 GBK 编码的中文请求体不会被拒绝，而是变成一串
 *   "问号方块"一路入库 —— 库里因此躺过一行原文全是 U+FFFD 的问答记录
 *   （阶段 1 控制台冒烟测试发的非 UTF-8 请求体）。原始字节到那时已经找不回来，
 *   也再没法区分"用户真的敲了 U+FFFD"和"客户端编码错了"。
 *   所以在闸门处就拦：**解码失败 = 400**。
 *
 * 【为什么先 arrayBuffer 再自己解码】`c.req.json()` 没有"严格模式"这个参数，
 *   要拿到 fatal 只能自己接字节。
 *
 * 【错误文案为什么点明编码】坏字节最常见的原因是客户端在 GBK 环境下编码中文
 *   再当 JSON 发出来。只说"不是合法 JSON"会让人去查 JSON 语法，而问题在更前面一层。
 */
async function readBodyText(c: Context<Env>): Promise<string> {
  const buf = await c.req.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (err) {
    throw new AppError(
      'invalid_argument',
      '请求体不是合法的 UTF-8。请确认客户端以 UTF-8 编码发送（中文内容在 GBK 环境下尤其容易出错）。',
      { cause: err },
    );
  }
}

/**
 * 读一个 JSON 请求体（任意 JSON 值），非法 UTF-8 与非法 JSON 都算参数错误。
 *
 * 这是全应用唯一一处"从请求里取 JSON"的入口 —— 登录、提问、投稿、上传、
 * 配置都走它。写多份的话，早晚有一处漏掉"严格 UTF-8"这一档，
 * 而漏掉的那一处不会有任何症状，只会静默往库里写 U+FFFD。
 */
async function readJsonBody(c: Context<Env>): Promise<unknown> {
  const text = await readBodyText(c);
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new AppError('invalid_argument', '请求体不是合法 JSON。', { cause: err });
  }
}

/**
 * 读取并校验问答请求体。
 *
 * 为什么把这段从两个路由里提出来：`/ask` 与 `/ask/stream` 必须用**同一份**校验。
 * 勾选确认那道闸门如果只写在其中一个里，另一个就成了一扇没人看的后门 ——
 * 而"约束 4 要求确认后才可提交"这件事，恰恰是靠这道闸门落地的。
 * 两处各写一遍，早晚会有人只改了其中一处。
 */
/**
 * 解析客户端带上的会话历史。
 *
 * 【为什么截断而不是全部拒收】历史是增强项：某轮特别长（用户贴了一大段）
 *   不该让整次提问失败；截到足够理解指代的长度即可。但**形状**不对必须报错 ——
 *   把 `"history": "..."` 当成空数组静默忽略，会让客户端以为自己带上了上下文。
 */
function parseAskHistory(raw: unknown): readonly AskHistoryTurn[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new AppError('invalid_argument', 'history 必须是一个数组，元素形如 {"question": "...", "answer": "..."}。');
  }
  const turns: AskHistoryTurn[] = [];
  for (const item of raw.slice(-ASK_HISTORY_LIMIT)) {
    if (typeof item !== 'object' || item === null) {
      throw new AppError('invalid_argument', 'history 的每一项都必须是对象。');
    }
    const record = item as Record<string, unknown>;
    if (typeof record['question'] !== 'string' || typeof record['answer'] !== 'string') {
      throw new AppError('invalid_argument', 'history 的每一项都必须有字符串 question 与 answer。');
    }
    const question = record['question'].trim().slice(0, ASK_HISTORY_QUESTION_CHARS);
    const answer = record['answer'].trim().slice(0, ASK_HISTORY_ANSWER_CHARS);
    if (question === '' || answer === '') continue;
    turns.push({ question, answer });
  }
  return turns;
}

async function readAskBody(c: Context<Env>): Promise<{
  question: string;
  history: readonly AskHistoryTurn[];
  documentScope?: AskDocumentScopeV1;
}> {
  const raw = await readJsonBody(c);

  const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  const question = body['question'];
  if (typeof question !== 'string' || question.trim() === '') {
    throw new AppError(
      'invalid_argument',
      '缺少 question 字段。请提交 {"question": "你的问题", "consentConfirmed": true}。',
    );
  }

  // 勾选确认必须由接口层自己拦。只在界面上禁用按钮是不够的 ——
  // 脚本、curl、将来的第三方客户端都会绕过界面，而约束 4 要求的是
  // "确认后才可提交"，不是"界面上确认后才可提交"。
  if (body['consentConfirmed'] !== true) {
    throw new AppError(
      'invalid_argument',
      '提问前需要确认已知悉「问题与检索到的文档片段会发送至云端模型处理」。' +
        '请在请求体里带上 "consentConfirmed": true。',
    );
  }

  const rawScope = body['documentScope'];
  const documentScope = parseAskDocumentScope(rawScope);
  if (rawScope !== undefined && documentScope === undefined) {
    throw new AppError('invalid_argument', '问答资料范围格式无效，请重新选择。');
  }
  return { question, history: parseAskHistory(body['history']),
    ...(documentScope === undefined ? {} : { documentScope }) };
}

/** 一轮整理对话最多带多少条记录。超了说明客户端在灌数据，不是正常对话。 */
const ORGANIZE_MAX_MESSAGES = 40;
/** 单条消息的字符上限。够写一大段白话说明，又不至于把 prompt 撑爆。 */
const ORGANIZE_MAX_MESSAGE_CHARS = 8000;
/** 一份计划最多多少条规则。规则多到几十条已经不是"整理"了，是在写脚本。 */
const ORGANIZE_MAX_RULES = 50;

/**
 * 解析整理对话记录。
 *
 * 【为什么服务端要自己收下整段对话】见 shared/organize.ts：多轮状态不留在
 * 服务端，所以每一轮都由客户端把完整对话带上来。这意味着这里面装的是
 * **用户可控的自由文本**，长度与条数都必须封顶 —— 否则一个循环发消息的脚本
 * 能把它一路灌进模型上下文。
 */
function parseOrganizeMessages(raw: unknown): readonly OrganizeMessage[] {
  if (!Array.isArray(raw)) {
    throw new AppError('invalid_argument', 'messages 必须是一个数组。');
  }
  if (raw.length === 0) {
    throw new AppError('invalid_argument', 'messages 不能为空 —— 至少要说一句你想怎么整理。');
  }
  if (raw.length > ORGANIZE_MAX_MESSAGES) {
    throw new AppError(
      'invalid_argument',
      `一次最多带 ${ORGANIZE_MAX_MESSAGES} 条对话记录，收到 ${raw.length} 条。`,
    );
  }

  const out: OrganizeMessage[] = [];
  for (const [i, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new AppError('invalid_argument', `第 ${i + 1} 条对话记录不是一个对象。`);
    }
    const rec = item as Record<string, unknown>;
    const role = rec['role'];
    const content = rec['content'];
    if (role !== 'user' && role !== 'assistant') {
      throw new AppError(
        'invalid_argument',
        `第 ${i + 1} 条对话记录的 role 只能是 "user" 或 "assistant"。`,
      );
    }
    if (typeof content !== 'string' || content.trim() === '') {
      throw new AppError('invalid_argument', `第 ${i + 1} 条对话记录没有内容。`);
    }
    if (content.length > ORGANIZE_MAX_MESSAGE_CHARS) {
      throw new AppError(
        'invalid_argument',
        `第 ${i + 1} 条对话记录太长（${content.length} 字，上限 ${ORGANIZE_MAX_MESSAGE_CHARS}）。`,
      );
    }
    out.push({ role, content: content.trim() });
  }

  if (!out.some((m) => m.role === 'user')) {
    throw new AppError('invalid_argument', '对话记录里至少要有用户的一条消息。');
  }
  return out;
}

/**
 * 解析一份整理计划。
 *
 * 这里**只做结构校验**（字段在不在、类型对不对）。规则内容本身合不合法
 * （glob 写坏、目标目录越界）不在这里判 —— 那是 `expandRules` 的事，
 * 它会把问题写进每条规则的 `problem` 里给用户看，而不是把整份计划打成 400。
 * "一条规则写错了"和"这份计划结构都是坏的"该有不同的反馈。
 */
function parseOrganizePlan(raw: unknown): OrganizePlan {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AppError('invalid_argument', 'plan 必须是一个对象。');
  }
  const rec = raw as Record<string, unknown>;

  const summary = rec['summary'];
  if (typeof summary !== 'string' || summary.trim() === '') {
    throw new AppError('invalid_argument', 'plan.summary 不能为空 —— 要有一段话说明这份计划做什么。');
  }

  const rulesRaw = rec['rules'];
  if (!Array.isArray(rulesRaw)) {
    throw new AppError('invalid_argument', 'plan.rules 必须是一个数组。');
  }
  if (rulesRaw.length > ORGANIZE_MAX_RULES) {
    throw new AppError(
      'invalid_argument',
      `一份计划最多 ${ORGANIZE_MAX_RULES} 条规则，收到 ${rulesRaw.length} 条。`,
    );
  }

  const rules: OrganizeRule[] = rulesRaw.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new AppError('invalid_argument', `第 ${i + 1} 条规则不是一个对象。`);
    }
    const r = item as Record<string, unknown>;
    const match = r['match'];
    const toDir = r['toDir'];
    const note = r['note'];
    if (typeof match !== 'string') {
      throw new AppError('invalid_argument', `第 ${i + 1} 条规则的 match 必须是字符串。`);
    }
    if (typeof toDir !== 'string') {
      throw new AppError('invalid_argument', `第 ${i + 1} 条规则的 toDir 必须是字符串。`);
    }
    if (note !== undefined && typeof note !== 'string') {
      throw new AppError('invalid_argument', `第 ${i + 1} 条规则的 note 必须是字符串。`);
    }
    return { match, toDir, ...(note !== undefined ? { note } : {}) };
  });

  return { summary: summary.trim(), rules };
}

/**
 * 预览条数。必须是非负整数，**不猜、不取整** ——
 * 它是"用户看到的那份预览"与"实际要执行的东西"之间的对账凭据，
 * 一个被悄悄改成别的值的 expectedMoves 会让对账变成摆设。
 */
function parseExpectedMoves(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new AppError(
      'invalid_argument',
      `expectedMoves 必须是非负整数（预览里给出的条数），收到 ${JSON.stringify(raw)}。`,
    );
  }
  return raw;
}

/**
 * 读一个 JSON 对象请求体。非对象（数组、字符串、null）一律按参数错误处理。
 *
 * 单独提出来是因为投稿有两个入口要用它：建档那条取一堆字段，
 * 改状态那条只取两个。两处各写一遍"读 body + 判 JSON + 判对象"，
 * 早晚会有一处漏掉某一档，而漏掉的那一档没有症状 —— 只会变成一个 500。
 *
 * 字节那一层交给 readJsonBody（它负责严格 UTF-8 与"是不是 JSON"），
 * 这里只管"是不是一个对象"。
 */
async function readJsonObject(c: Context<Env>): Promise<Record<string, unknown>> {
  const raw = await readJsonBody(c);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AppError('invalid_argument', '请求体必须是一个 JSON 对象。');
  }
  return raw as Record<string, unknown>;
}

/** 反馈评分。只认这两档；拼错不能静默当成"赞"或"踩"。 */
function parseFeedbackRating(raw: unknown): FeedbackRating {
  if (raw === 'up' || raw === 'down') return raw;
  throw new AppError('invalid_argument', 'rating 只能是 up（赞）或 down（踩）。');
}

/**
 * 踩的预设原因。未知键一律拒绝 —— 静默丢掉的话，用户以为"提交了"，统计里却没有。
 *
 * 去重而不是报错：同一个键送两遍是客户端的实现细节，不是用户的错误。
 */
function parseFeedbackReasons(raw: unknown): FeedbackDownReason[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AppError('invalid_argument', 'reasons 必须是原因键的数组。');
  }
  const allowed = new Set<string>(FEEDBACK_DOWN_REASONS.map((r) => r.key));
  const out: FeedbackDownReason[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !allowed.has(value)) {
      throw new AppError(
        'invalid_argument',
        `不认识的反馈原因：${JSON.stringify(value)}。可选：${[...allowed].join('、')}。`,
      );
    }
    if (!out.includes(value as FeedbackDownReason)) out.push(value as FeedbackDownReason);
  }
  return out;
}

/** 踩的自由说明。空白串归一成 null，超长拒绝（上限见 shared/feedback.ts）。 */
function parseFeedbackNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new AppError('invalid_argument', 'note 必须是字符串。');
  }
  const note = raw.trim();
  if (note === '') return null;
  if (note.length > FEEDBACK_NOTE_MAX_CHARS) {
    throw new AppError(
      'invalid_argument',
      `说明太长了（${note.length} 字，上限 ${FEEDBACK_NOTE_MAX_CHARS} 字）。`,
    );
  }
  return note;
}

/** 驳回 / 撤回原因的字符上限。200 字足够说清"为什么不采纳"，又不至于让这一列无限长。 */
const REJECT_REASON_MAX_CHARS = 200;

/**
 * 可选的一段自由文本原因（驳回与撤回共用同一套上限与口径）。
 *
 * 【为什么要限长】它会进 `note` 列、并在界面上原样回显。不设上限的话，一次
 *   粘贴事故就能把整列塞满，之后这一列的每一行都要拖着它走。
 *   【为什么不是必填】驳回常常是"这条不对"这一句话的事，逼人写理由的结果是
 *   所有人都在里面敲一个"x" —— 那还不如留空，至少留空是诚实的。
 * @param label 出错信息里对这段文字的叫法（"驳回原因" / "撤回原因"）。
 */
function readOptionalReason(raw: unknown, label: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new AppError('invalid_argument', `${label}要是一段文字。`);
  }
  const reason = raw.trim();
  if (reason === '') return null;
  if (reason.length > REJECT_REASON_MAX_CHARS) {
    throw new AppError(
      'invalid_argument',
      `${label}太长了（${reason.length} 字，上限 ${REJECT_REASON_MAX_CHARS} 字）。`,
    );
  }
  return reason;
}

/** 裁决动作。只认三种，别的当参数错误 —— 猜一个默认裁决会静默改动知识库。 */
function readResolution(raw: unknown): KnowledgeResolution {
  if (typeof raw !== 'string' || !(KNOWLEDGE_RESOLUTIONS as readonly string[]).includes(raw)) {
    throw new AppError(
      'invalid_argument',
      `裁决只能是 ${KNOWLEDGE_RESOLUTIONS.join(' / ')} 之一，收到 ${JSON.stringify(raw)}。`,
    );
  }
  return raw as KnowledgeResolution;
}

/** 条目列表的 status 过滤。非法值当参数错误，**不静默忽略** —— 忽略会让用户以为筛过了。 */
function parseKnowledgeStatus(raw: string | undefined): KnowledgeStatus | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!(KNOWLEDGE_STATUSES as readonly string[]).includes(raw)) {
    throw new AppError(
      'invalid_argument',
      `status 只能是 ${KNOWLEDGE_STATUSES.join(' / ')} 之一。`,
    );
  }
  return raw as KnowledgeStatus;
}

/**
 * 账号管理那四个接口共用的输入校验。
 *
 * 【为什么集中在这几个小函数里】这四个接口对"用户名长什么样""口令多长算够"
 *   必须给**同一个答案**。各写一遍的话，最常见的结果是"新建时查了长度、
 *   重置时不查"，于是那个唯一的绕过口子正好落在改密码这条路上。
 */

/**
 * 用户名。
 *
 * 【为什么禁空白字符】用户名是登录时从记忆里敲出来的标识，中间夹一个空格
 *   意味着一串永远敲不对的字符。这里只拦空白，**不限制字符集** ——
 *   限制成 `[a-zA-Z0-9_-]` 会把中文名挡在外面，而这是中文项目，
 *   用中文当用户名是很自然的选择。大小写由 normalizeUsername 统一。
 */
function readUsername(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AppError('invalid_argument', '请填写用户名。');
  }
  const username = raw.trim();
  if (/\s/u.test(username)) {
    throw new AppError('invalid_argument', '用户名里不能有空格。');
  }
  return username;
}

function readPassword(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new AppError('invalid_argument', '请填写口令。');
  }
  if (raw.length < MIN_PASSWORD_LENGTH) {
    throw new AppError(
      'invalid_argument',
      `口令至少 ${MIN_PASSWORD_LENGTH} 位。这是管理员替别人设的口令，长度是唯一能讲清理由的规则。`,
    );
  }
  return raw;
}

function readRole(raw: unknown): Role {
  if (typeof raw !== 'string' || !(ROLES as readonly string[]).includes(raw)) {
    throw new AppError('invalid_argument', `角色只能是 ${ROLES.join(' / ')} 之一。`);
  }
  return raw as Role;
}

function readUserStatus(raw: unknown): UserStatus {
  if (typeof raw !== 'string' || !(USER_STATUSES as readonly string[]).includes(raw)) {
    throw new AppError('invalid_argument', `状态只能是 ${USER_STATUSES.join(' / ')} 之一。`);
  }
  return raw as UserStatus;
}

/** 可留空的文本字段：`null` 与空串都归成 `null`（清空），其余 trim 后原样。 */
function readOptionalText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') {
    throw new AppError('invalid_argument', '这个字段必须是字符串或 null。');
  }
  const text = raw.trim();
  return text === '' ? null : text;
}

/** 不能清空的文本字段（如显示名，列上就是 NOT NULL）。 */
function readRequiredText(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AppError('invalid_argument', `${label}不能为空。要清空请改用别的字段，或删掉这条记录。`);
  }
  return raw.trim();
}

/**
 * 允许**空请求体**的 JSON 解析。
 *
 * 只有 complete 用它：请求体是可选的（`register` 有默认值），而客户端直接
 * POST 一个不带 body 的请求是完全正常的写法 —— 不能因为"没有 body"
 * 就给一个 400。readJsonObject 对空 body 会抛，所以这里单独一条。
 *
 * 走 readBodyText 而不是 `c.req.text()`：理由同 readBodyText 顶部 ——
 * 这条路径也在往外写数据，坏字节在这里同样会静默变成 U+FFFD 存进去。
 */
async function readOptionalJsonObject(c: Context<Env>): Promise<Record<string, unknown>> {
  const text = await readBodyText(c);
  if (text.trim() === '') return {};

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AppError('invalid_argument', '请求体不是合法 JSON。', { cause: err });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AppError('invalid_argument', '请求体必须是一个 JSON 对象。');
  }
  return raw as Record<string, unknown>;
}

/**
 * 解析并校验上传会话的创建请求。
 *
 * 这里只做"字段在不在、类型对不对"，**路径本身合不合法交给 uploads/layout.ts**
 * —— 那是唯一一处做路径校验的地方（理由见那个文件的顶部）。
 */
async function readUploadCreateBody(c: Context<Env>): Promise<CreateUploadRequest> {
  const body = await readJsonObject(c);
  return {
    targetDir: parseTargetDir(body['targetDir']),
    fileName: parseFileName(body['fileName']),
    totalBytes: parseByteCount(body['totalBytes']),
    lastModifiedMs: parseEpochMs(body['lastModifiedMs']),
  };
}

/**
 * 字节数：必须是正整数，且安全整数范围内。
 *
 * 【为什么收数字而不收字符串】`file.size` 本来就是数字。容忍 "123" 这种写法
 * 会带来一个更隐蔽的问题：`Number("12abc")` 是 NaN，`parseInt("12abc")` 是 12 ——
 * 不同写法给出不同的值，而两边都"没报错"。长度算错的后果是最后一片对不上，
 * 表现为"永远传不完"。
 */
function parseByteCount(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new AppError(
      'invalid_argument',
      `totalBytes 必须是正整数（字节数），收到 ${JSON.stringify(raw)}。`,
    );
  }
  return raw;
}

/** 客户端侧的文件最后修改时间，毫秒。用来把"同名的另一份文件"区分开。 */
function parseEpochMs(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new AppError(
      'invalid_argument',
      `lastModifiedMs 必须是非负整数（毫秒时间戳），收到 ${JSON.stringify(raw)}。` +
        `浏览器里就是文件的 lastModified。`,
    );
  }
  return raw;
}

/** 目录相对路径的最后一段，用作登记时的默认名字。 */
function lastSegment(targetDir: string): string {
  const parts = targetDir.split('/');
  return parts[parts.length - 1] ?? targetDir;
}

/** 字节数 → 给人看的 GB。上传上限、空间不足的文案都靠它，别各写一遍。 */
function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * 解析并校验建档请求体。
 *
 * 与 readAskBody 同一条口径：**校验必须在服务端做一遍**，界面上的
 * 必填、下拉框只是给人看的，脚本与将来的客户端都不经过它们。
 */
async function readSubmissionBody(c: Context<Env>): Promise<{
  title: string;
  algorithmAbbr: string | null;
  submitterName: string | null;
  submitterPersonId: string | null;
  journalName: string | undefined;
  journalField: string | undefined;
  status: SubmissionStatus;
  submittedAt: string | null;
  submittedOn: string | null;
  statusSince: string | null;
  submissionNumber: string | null;
  notes: string | null;
}> {
  const body = await readJsonObject(c);

  const title = body['title'];
  if (typeof title !== 'string' || title.trim() === '') {
    throw new AppError('invalid_argument', '缺少 title 字段。投稿记录必须有稿件的标题。');
  }

  const status = parseSubmissionStatus(body['status']);

  // 空串与未提供等价：界面上的"可选"输入框提交空串是常态，
  // 把它当成"提供了空刊名"会存进一本名字为空的期刊 —— 那是一条再也
  // 无法从界面上辨认、也无法删除的垃圾数据。
  const journalName = optionalText(body['journalName']);
  const journalField = optionalText(body['journalField']);
  const notes = optionalText(body['notes']);
  const algorithmAbbr = optionalText(body['algorithmAbbr']) ?? null;
  const submitterName = optionalText(body['submitterName']) ?? null;
  const submissionNumber = optionalText(body['submissionNumber']) ?? null;

  const submittedAtRaw = optionalText(body['submittedAt']);
  let submittedAt: string | null = null;
  if (submittedAtRaw !== undefined) {
    const parsed = new Date(submittedAtRaw);
    if (Number.isNaN(parsed.getTime())) {
      throw new AppError(
        'invalid_argument',
        `submittedAt 不是合法时间："${submittedAtRaw}"。请用 ISO 8601，如 2026-10-07T13:30。`,
      );
    }
    // 统一存 UTC ISO 串。datetime-local 给的是不带时区的本地时间，
    // 原样存下来的话，库里会混着两种格式，跨时区一读就偏。
    submittedAt = parsed.toISOString();
  }

  const submittedOnRaw = optionalText(body['submittedOn']);
  const submittedOn = submittedOnRaw === undefined ? null : parseDateOnly(submittedOnRaw, 'submittedOn');
  const statusSinceRaw = optionalText(body['statusSince']);
  const statusSince = statusSinceRaw === undefined ? null : parseDateOnly(statusSinceRaw, 'statusSince');

  if (status === 'preparing' && (submittedAt !== null || submittedOn !== null)) {
    // 「准备中」= 还没投出去。允许带上投稿时间的话，会出现一条
    // "还没投、但已于某日投稿"的记录 —— 而巡检与时间线都要读这个字段。
    throw new AppError(
      'invalid_argument',
      '状态是「准备中」时不应有投稿时间：准备中表示这份稿件还没有投出去。',
    );
  }

  return {
    title: title.trim(),
    algorithmAbbr,
    submitterName,
    submitterPersonId: optionalPatchText(body, 'submitterPersonId') ?? null,
    journalName,
    journalField,
    status,
    submittedAt,
    submittedOn,
    statusSince,
    submissionNumber,
    notes: notes ?? null,
  };
}

/** 新增一轮投稿的请求体。字段口径与建档相同，只是没有 title。 */
async function readRoundBody(c: Context<Env>): Promise<{
  journalName: string | undefined;
  journalField: string | undefined;
  status: SubmissionStatus;
  submittedOn: string | null;
  statusSince: string | null;
  submissionNumber: string | null;
  notes: string | null;
}> {
  const body = await readJsonObject(c);
  const status = parseSubmissionStatus(body['status']);
  const journalName = optionalText(body['journalName']);
  const journalField = optionalText(body['journalField']);
  const notes = optionalText(body['notes']);
  const submissionNumber = optionalText(body['submissionNumber']) ?? null;
  const submittedOnRaw = optionalText(body['submittedOn']);
  const submittedOn = submittedOnRaw === undefined ? null : parseDateOnly(submittedOnRaw, 'submittedOn');
  const statusSinceRaw = optionalText(body['statusSince']);
  const statusSince = statusSinceRaw === undefined ? null : parseDateOnly(statusSinceRaw, 'statusSince');

  if (status === 'preparing' && submittedOn !== null) {
    throw new AppError(
      'invalid_argument',
      '状态是「准备中」时不应有投稿日期：准备中表示这一轮还没有投出去。',
    );
  }

  return {
    journalName,
    journalField,
    status,
    submittedOn,
    statusSince,
    submissionNumber,
    notes: notes ?? null,
  };
}

/**
 * 期刊网址只接受 http/https。空串/未提供归一成 undefined（表示不写）。
 *
 * 【为什么必须在这一层拦】这个值会原样变成前端 `<a href>`。允许 `javascript:`
 *   等于把一个可执行协议存进公共期刊库，任何人点一下都会执行。
 *   前端的 `type="url"` 只是输入提示，挡不住脚本与将来的客户端。
 */
function optionalWebsite(raw: unknown): string | undefined {
  const text = optionalText(raw);
  if (text === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new AppError('invalid_argument', `期刊网址不是合法 URL："${text}"。`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('invalid_argument', '期刊网址只支持 http / https。');
  }
  return url.toString();
}

/**
 * 只接受 `YYYY-MM-DD`，并校验它真的是日历上的一天。
 *
 * 不用 `new Date()` 兜底：`2026-02-30` 会被 JS 解析成 3 月 2 日，
 * 于是一个打错的日期会静默变成另一个日期 —— 台账里最不该出现这种事。
 */
function parseDateOnly(raw: string, field: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw.trim());
  if (m === null) {
    throw new AppError('invalid_argument', `${field} 要写成 YYYY-MM-DD，例如 2026-10-01。`);
  }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new AppError('invalid_argument', `${field} 不是一个真实存在的日期：${raw}。`);
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** 校验名称。空名不允许 —— 列表里认不出这条记录指的是什么。 */
function parseAssetName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AppError(
      'invalid_argument',
      '缺少 name 字段。至少要有个名字，否则列表里认不出这条记录指的是什么。',
    );
  }
  return raw.trim();
}

/**
 * 校验位置：必须是绝对路径，理由见 shared/code-assets.ts 里 location 的注释。
 * 这条校验在服务端做：界面上提醒一次只是顺手，拦不住脚本。
 */
function parseAssetLocation(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AppError(
      'invalid_argument',
      '缺少 location 字段。这一类记录的全部意义就是"它在哪"，没有位置就没有内容。',
    );
  }
  const trimmed = raw.trim();
  if (!isAbsolute(trimmed)) {
    throw new AppError(
      'invalid_argument',
      `location 必须是绝对路径，收到 "${trimmed}"。` +
        `相对路径的参照点是进程的工作目录，换个启动方式就指向别处。` +
        `如果这是"怎么获取"（下载地址、共享路径），请写在 accessNote 里。`,
    );
  }
  return trimmed;
}

/**
 * 解析并校验数据集登记请求体。
 *
 * 与 readSubmissionBody / readAskBody 同一条口径：**校验必须在服务端做一遍**，
 * 界面上的必填项只是给人看的，脚本和将来的客户端都不经过它们。
 */
async function readCodeAssetBody(c: Context<Env>): Promise<{
  name: string;
  location: string;
  project: string | null;
  host: string | null;
  accessNote: string | null;
  notes: string | null;
  profile: DatasetProfile;
  documentationId: string | null;
}> {
  const body = await readJsonObject(c);
  return {
    name: parseAssetName(body['name']),
    location: parseAssetLocation(body['location']),
    project: optionalText(body['project']) ?? null,
    host: optionalText(body['host']) ?? null,
    accessNote: optionalText(body['accessNote']) ?? null,
    notes: optionalText(body['notes']) ?? null,
    profile: readDatasetProfile(body['profile']),
    documentationId: optionalPatchText(body, 'documentationId') ?? null,
  };
}

/**
 * 一个可清空的可选文本字段在 PATCH 里的三种含义：
 *   undefined = 请求里没提它 → 保持原样
 *   null      = 要求清空
 *   字符串     = 设为该值（去空白后为空也算清空）
 *
 * 传了别的类型（数字、对象）**报错而不是忽略**：静默忽略一个 `project: 5`
 * 会让用户以为改成功了，而库里什么都没变 —— 与 material / status 同一条口径，
 * 「给出一个看似正常、实则错误的答案，比报错危险得多」。
 */
function optionalPatchText(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in body)) return undefined;
  const raw = body[key];
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    throw new AppError(
      'invalid_argument',
      `${key} 必须是字符串或 null（null 表示清空），收到 ${typeof raw}。`,
    );
  }
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 解析并校验修改请求体。
 *
 * 三种含义的区别（不出现 / null / 有值）见 shared 里 UpdateCodeAssetRequest。
 * `name` 与 `location` 不可清空：它们出现时就必须是合法值，传 null 直接报错 ——
 * 一条没有名字、或者不知在哪的记录留着没有任何意义。
 */
async function readCodeAssetPatch(c: Context<Env>): Promise<UpdateCodeAssetRequest> {
  const body = await readJsonObject(c);
  const patch: UpdateCodeAssetRequest = {};

  if ('name' in body) patch.name = parseAssetName(body['name']);
  if ('location' in body) patch.location = parseAssetLocation(body['location']);

  const project = optionalPatchText(body, 'project');
  if (project !== undefined) patch.project = project;
  const host = optionalPatchText(body, 'host');
  if (host !== undefined) patch.host = host;
  const accessNote = optionalPatchText(body, 'accessNote');
  if (accessNote !== undefined) patch.accessNote = accessNote;
  const notes = optionalPatchText(body, 'notes');
  if (notes !== undefined) patch.notes = notes;
  if ('profile' in body) patch.profile = readDatasetProfile(body['profile']);
  const documentationId = optionalPatchText(body, 'documentationId');
  if (documentationId !== undefined) patch.documentationId = documentationId;

  if (Object.keys(patch).length === 0) {
    throw new AppError(
      'invalid_argument',
      '请求体里没有任何要修改的字段。改东西至少要说清改哪一个。',
    );
  }
  return patch;
}

function readDatasetProfile(raw: unknown): DatasetProfile {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('invalid_argument', '数据集说明必须是字段对象。');
  }
  const values: DatasetProfile = {};
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(DATASET_PROFILE_LABELS) as (keyof DatasetProfile)[]) {
    const value = optionalPatchText(input, key);
    if (value) {
      if (value.length > 1000) throw new AppError('invalid_argument', `${DATASET_PROFILE_LABELS[key]}最多 1000 字。`);
      values[key] = value;
    }
  }
  return values;
}

/** 可选文本字段：未提供、不是字符串、或去空白后为空，都归一成 undefined。 */
function optionalText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 解析分区年份。
 *
 * 【为什么必须有这一道】不带年份的"几区"过一年就是错的，而且错得看不出来 ——
 * 用户分不清"这是去年的答案"还是"这是今年的答案"。所以宁可在这里报错，
 * 也不让它以一条无年份记录的形式进库。上限放到 2100：比"不许填未来"
 * 宽松，因为年头久了数据源可能提前发布下一年的表。
 */
function parseRankingYear(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1900 || raw > 2100) {
    throw new AppError(
      'invalid_argument',
      `year 必须是 1900 到 2100 之间的整数，收到 ${JSON.stringify(raw)}。` +
        '分区必须带年份：不带年份的"几区"过一年就说不清是哪一年了。',
    );
  }
  return raw;
}

/** 解析分区体系。与 parseSubmissionStatus 同一条口径：非法值必须报错，不静默退回。 */
function parseJournalSystem(raw: unknown): JournalSystem {
  if (typeof raw !== 'string') {
    throw new AppError('invalid_argument', `缺少 system 字段。可用：${JOURNAL_SYSTEMS.join('、')}`);
  }
  const found = JOURNAL_SYSTEMS.find((s) => s === raw);
  if (found === undefined) {
    throw new AppError(
      'invalid_argument',
      `未知的分区体系 "${raw}"。可用：${JOURNAL_SYSTEMS.join('、')}`,
    );
  }
  return found;
}

/**
 * 解析稿件状态。非法值**必须报错**，与 material / mode 同一条口径：
 * 静默退回一个默认状态的话，用户以为改成了"已发表"，实际还停在"外审"，
 * 而界面上显示的是他自己的操作结果 —— 这种错配没有任何迹象可循。
 */
function parseSubmissionStatus(raw: unknown): SubmissionStatus {
  if (typeof raw !== 'string') {
    throw new AppError(
      'invalid_argument',
      `缺少 status 字段。可用：${SUBMISSION_STATUSES.join('、')}`,
    );
  }
  const found = SUBMISSION_STATUSES.find((s) => s === raw);
  if (found === undefined) {
    throw new AppError(
      'invalid_argument',
      `未知的稿件状态 "${raw}"。可用：${SUBMISSION_STATUSES.join('、')}`,
    );
  }
  return found;
}

/**
 * 巡检视角：由角色推出"能不能看全部待办、能不能动任何一条"。
 *
 * 判据只在这里出现一次 —— 列表接口与忽略接口都从它取值，两者一旦各判一次
 * 就会分叉（4B 踩过：侧栏与守卫各判一次，结果一个看得见、一个进不去）。
 */
function patrolViewer(user: AuthUser): PatrolViewer {
  return { userId: user.id, canManageAll: hasPermission(user.role, 'patrol.manage') };
}

function importViewer(user: AuthUser): ImportViewer {
  return { userId: user.id, canManageAll: user.role === 'admin', canManageTheses: hasPermission(user.role, 'thesis.manage') };
}

function thesisViewer(user: AuthUser): ThesisViewer {
  return {
    userId: user.id,
    canReadGrade: hasPermission(user.role, 'thesis.read.grade'),
  };
}

function patentScope(user: AuthUser): PatentScope {
  return { userId: user.id, canReadAll: hasPermission(user.role, 'patent.read.all') };
}

function writePatentActor(user: AuthUser): { userId: string; canWriteAll: boolean } {
  return { userId: user.id, canWriteAll: hasPermission(user.role, 'patent.write.all') };
}

/** 可选日期：未提供 → null；给了就必须是真实存在的 YYYY-MM-DD。 */
function readExpectedRevision(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new AppError('invalid_argument', '缺少有效的编辑版本，请刷新页面后重试。');
  }
  return raw;
}

function parseOffset(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('invalid_argument', '列表偏移量必须是非负整数。');
  }
  return value;
}

function readDateField(raw: unknown, field: string): string | null {
  const text = optionalText(raw);
  return text === undefined ? null : parseDateOnly(text, field);
}

function validatePatentDates(
  firstSubmittedOn: string | null,
  substantiveExamOn: string | null,
  publishedOn: string | null,
): void {
  if (firstSubmittedOn !== null && substantiveExamOn !== null && substantiveExamOn < firstSubmittedOn) {
    throw new AppError('invalid_argument', '实审时间早于首次提交时间，请复核日期后再保存。');
  }
  if (firstSubmittedOn !== null && publishedOn !== null && publishedOn < firstSubmittedOn) {
    throw new AppError('invalid_argument', '公开时间早于首次提交时间，请复核日期后再保存。');
  }
}

function peopleViewer(user: AuthUser): PersonViewer {
  return {
    userId: user.id,
    canReadSensitive: hasPermission(user.role, 'people.read.sensitive'),
    canManage: hasPermission(user.role, 'people.manage'),
  };
}

function readPersonStatus(raw: unknown): PersonStatus {
  if (typeof raw === 'string' && (PERSON_STATUSES as readonly string[]).includes(raw)) {
    return raw as PersonStatus;
  }
  throw new AppError('invalid_argument', `人员状态只能是 ${PERSON_STATUSES.join(' / ')} 之一。`);
}

/**
 * 账号绑定必须由管理员确认，且一个账号最多绑一条人员记录。
 * 不按姓名自动匹配 —— 同名的人可能不止一个。
 */
function assertUserBindable(db: Db, userId: string | null, exceptPersonId: string | null): void {
  if (userId === null) return;
  if (findUserById(db, userId) === undefined) {
    throw new AppError('invalid_argument', '要绑定的账号不存在。');
  }
  const holder = findPersonByUserId(db, userId);
  if (holder !== null && holder.id !== exceptPersonId) {
    throw new AppError('invalid_argument', '这个账号已经绑定了另一条人员记录。', { httpStatus: 409 });
  }
}

function personConstraintError(err: unknown): AppError {
  if (isUniqueConstraintError(err)) {
    return new AppError(
      'invalid_argument',
      '学号或账号绑定与已有人员记录冲突，请先核对后重试。',
      { httpStatus: 409 },
    );
  }
  return err instanceof AppError
    ? err
    : new AppError('internal', '人员记录写入失败，请把请求 ID 提供给管理员。');
}

/** 忽略待办时填的理由上限。同 REJECT_REASON_MAX_CHARS 的理由：它会进库、回显，不设上限会被一次粘贴塞满。 */
const DISMISS_REASON_MAX_CHARS = 200;

/**
 * 解析 PATCH /patrol/rules 的请求体。
 *
 * 【为什么白名单字段、且不认识的键要报错】照 admin/config.ts 的口径：静默忽略
 *   一个拼错的键（比如把 `thresholdDays` 写成 `tresholdDays`）会让人以为改成功了，
 *   而规则纹丝不动 —— 这类"看起来生效了其实没有"的失败最难发现。宁可 400。
 *
 * `rules: []` 是允许的（一个什么都不改的幂等空操作），但每一项里的字段都得对。
 */
function parsePatrolRuleUpdates(body: Record<string, unknown>): PatrolRuleUpdate[] {
  const raw = body['rules'];
  if (!Array.isArray(raw)) {
    throw new AppError('invalid_argument', '请求体需要 rules 数组。');
  }

  const known = PATROL_SUBJECT_STATUSES as readonly string[];
  const out: PatrolRuleUpdate[] = [];

  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new AppError('invalid_argument', 'rules 里每一项都要是一个对象。');
    }
    const rec = item as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (key !== 'status' && key !== 'thresholdDays' && key !== 'enabled') {
        throw new AppError(
          'invalid_argument',
          `巡检规则不接受字段「${key}」。可用字段：status、thresholdDays、enabled。`,
        );
      }
    }

    const status = rec['status'];
    if (typeof status !== 'string' || !known.includes(status)) {
      throw new AppError(
        'invalid_argument',
        `status 必须是这几档之一：${PATROL_SUBJECT_STATUSES.join('、')}。`,
      );
    }

    const update: PatrolRuleUpdate = { status: status as PatrolSubjectStatus };

    if (rec['thresholdDays'] !== undefined) {
      const n = rec['thresholdDays'];
      // 上限 3650（约十年）：比这更长的阈值没有实际意义，多半是多打了一个 0 ——
      // 而一个 1400 天的阈值会让某档巡检实际上永久失效，且看不出是笔误。
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 3650) {
        throw new AppError('invalid_argument', 'thresholdDays 必须是 1 到 3650 之间的整数。');
      }
      update.thresholdDays = n;
    }
    if (rec['enabled'] !== undefined) {
      if (typeof rec['enabled'] !== 'boolean') {
        throw new AppError('invalid_argument', 'enabled 必须是 true 或 false。');
      }
      update.enabled = rec['enabled'];
    }

    out.push(update);
  }
  return out;
}

function parseRecordRetrievalScope(
  type: RecordRetrievalScope['recordType'],
  recordId: string | undefined,
  raw: Record<'groupId' | 'personId' | 'year' | 'status' | 'milestone', string | undefined>,
): RecordRetrievalScope {
  const groupId = parseRetrievalId(raw.groupId);
  const common = {
    kind: 'record' as const, ...(recordId === undefined ? {} : { recordId }),
    ...(groupId === undefined ? {} : { groupId }),
  };
  const personId = parseRetrievalId(raw.personId);
  const person = personId === undefined ? {} : { personId };
  const year = raw.year === undefined ? {} : { year: parseRetrievalNumber(raw.year, 1900, 1900, 2999) };
  if (type === 'M-SUBMIT' && raw.milestone === undefined) {
    const status = SUBMISSION_STATUSES.find((item) => item === raw.status);
    if (raw.status === undefined || status !== undefined) {
      return { ...common, ...person, ...year, recordType: type, ...(status === undefined ? {} : { status }) };
    }
  }
  if (type === 'M-PATENT' && raw.status === undefined) {
    const milestone = PATENT_FILTERS.find((item) => item === raw.milestone);
    if (raw.milestone === undefined || milestone !== undefined) {
      return { ...common, ...person, ...year, recordType: type, ...(milestone === undefined ? {} : { milestone }) };
    }
  }
  if (type === 'M-THESIS' && raw.status === undefined && raw.milestone === undefined && raw.year === undefined) {
    return { ...common, ...person, recordType: type };
  }
  if (type === 'M-PERSON' && raw.personId === undefined && raw.milestone === undefined && raw.year === undefined) {
    const status = PERSON_STATUSES.find((item) => item === raw.status);
    if (raw.status === undefined || status !== undefined) {
      return { ...common, recordType: type, ...(status === undefined ? {} : { status }) };
    }
  }
  throw new AppError('invalid_argument', '台账筛选值不适用于所选类型。');
}

function parseRetrievalNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new AppError('invalid_argument', '检索分页参数不在允许范围内。');
  }
  return value;
}

function parseRetrievalId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.length === 0 || raw.length > 200 || raw.trim() !== raw || /[\x00-\x1f]/u.test(raw)) {
    throw new AppError('invalid_argument', '检索范围 ID 格式无效。');
  }
  return raw;
}

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, Math.trunc(n)), max);
}

/**
 * 解析 `?since=`：ISO 8601 时间串；缺省或空串 = 全部历史（返回 null）。
 *
 * 【为什么给不出可解析的时间要 400，而不是当成"全部历史"】一次笔误（少写一位）
 *   会被静默吞掉，报表的统计范围就悄悄从"这个月"变成"有史以来"—— 而看的人
 *   以为它还是一个月。范围错了的数字比没有数字更危险。
 *
 * 归一化成 `toISOString()` 再入库比对：库里 `created_at` 存的就是这个形状，
 * 字符串比较才等价于时间比较。
 */
function parseSince(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    throw new AppError(
      'invalid_argument',
      'since 必须是 ISO 8601 时间串，例如 2026-10-01T00:00:00.000Z。',
    );
  }
  return new Date(t).toISOString();
}

/**
 * 服务端的 `UsageTotals` → 跨进程契约 `MyUsageTotals`。
 *
 * 【为什么要有这个转换，而不是让两边同名】两个名字对应同一份数据，但住在
 *   不同的边界上：`UsageTotals` 是库列的直译（`cache_read`），`MyUsageTotals`
 *   是给前端看的词（缓存**读**多少 token）。改名时两边一起改 —— 这个函数就是
 *   那个"一起改"的落点，散落着映射反而更容易漏。
 */
function toMyUsageTotals(t: UsageTotals): MyUsageTotals {
  return {
    calls: t.calls,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheRead,
    cacheWriteTokens: t.cacheCreation,
    costUsd: t.costUsd,
  };
}

/**
 * 下载时给用户看到的文件名。
 *
 * 优先用原始上传名（那才是用户认识的名字），退回到标题 + 原件扩展名 ——
 * 标题是入库时人工填的，多半不带扩展名，直接当文件名会让下载下来的东西
 * 没法双击打开。
 */
function downloadName(doc: DocumentFileRow): string {
  if (doc.fileName !== null && doc.fileName !== '') return doc.fileName;
  const ext = doc.sourcePath === null ? '' : extname(doc.sourcePath);
  return `${doc.title}${ext}`;
}

/**
 * 组装 `Content-Disposition`。
 *
 * 两段文件名必须都给：中文名只有 `filename*=UTF-8''…` 这一种写法能被正确解码，
 * 但那是 RFC 5987 的扩展语法，很老的客户端不认；只给 `filename="..."` 又必然
 * 让中文变成乱码（响应头按 latin-1 编码）。所以老写法给一份 ASCII 兜底，
 * 支持扩展语法的客户端会优先采用 `filename*`。
 *
 * 这个坑在阶段 1 已经踩过一次（curl 传中文文件名乱码），成因同类：
 * HTTP 头不是 UTF-8 的。
 */
function xlsxResponse(c: Context<Env>, buffer: Buffer, name: string) {
  return c.body(new Uint8Array(buffer), 200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Length': String(buffer.byteLength),
    'Content-Disposition': contentDisposition(name),
    'X-Content-Type-Options': 'nosniff',
  });
}

/** 真实导出审计：只记范围/条件/行数，不存导出内容。 */
function dbAuditExport(
  db: Db,
  userId: string,
  scopeLabel: string,
  filters: { keyword: string | null; targets: readonly string[] },
  counts: Record<string, number>,
  now: string,
): void {
  db.prepare(
    `INSERT INTO ledger_export_audits
       (id, exported_by, scope_json, filters_json, row_counts_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    userId,
    JSON.stringify({ label: scopeLabel }),
    JSON.stringify(filters),
    JSON.stringify(counts),
    now,
  );
}

function contentDisposition(name: string): string {
  // ASCII 兜底：非 ASCII 与引号、反斜杠都换掉，保证这一段永远合法。
  const ascii = name.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987Encode(name)}`;
}

/**
 * RFC 5987 的 `ext-value` 编码。
 *
 * 不能直接用 `encodeURIComponent`：它不转义 `! ' ( ) *`，而这四个里
 * 只有 `!` 属于 RFC 5987 的 `attr-char` 集合 —— `'` 尤其致命，
 * 它是这段语法的分隔符，文件名里有一个就会把整个头解析坏。
 */
function rfc5987Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/gu,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function describe(err: unknown): {
  code: ErrorCode;
  httpStatus: number;
  title: string;
  message: string;
  retryable: boolean;
  retryDelayMs?: number;
} {
  if (err instanceof AppError) {
    return {
      code: err.code,
      httpStatus: err.httpStatus,
      title: TITLES[err.code],
      message: err.message,
      retryable: err.retryable,
      ...(err.retryDelayMs !== undefined ? { retryDelayMs: err.retryDelayMs } : {}),
    };
  }

  // 未知异常一律归为 internal，且【标记为不可重试】。
  // 这一点反直觉但很重要：未知异常很可能是我们自己的代码 bug，
  // 自动重试只会让它再炸一次并放大副作用（比如重复写入）。
  return {
    code: 'internal',
    httpStatus: 500,
    title: TITLES.internal,
    message: '服务内部错误，请把请求 ID 提供给管理员。',
    retryable: false,
  };
}
