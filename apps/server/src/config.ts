/**
 * 配置读取。集中在启动时一次完成，不在业务代码里到处 process.env.xxx。
 *
 * 为什么：散落的 process.env 会导致两个问题
 *   1. 拼错变量名不报错，只是静默拿到 undefined，运行时才暴露。
 *   2. 无法知道"这个服务到底需要哪些环境变量"，交接和部署时靠猜。
 * 这里读不到必需项就启动失败（fail fast），而不是等第一个请求进来才炸。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  port: number;
  /** 绝对路径 */
  dbPath: string;
  /** 绝对路径 */
  uploadDir: string;
  /** 仓库根目录，便于其它模块做路径锚定 */
  repoRoot: string;
  deepseekApiKey: string | undefined;
  /**
   * 大模型接口的 `.env` 兜底值。**实际取值以 `system_config` 表为准**（表覆盖 `.env`）。
   *
   * 【为什么两个来源必须同时存在，且表优先】
   *   表优先是因为"接口不该硬编码" —— 换中转站、换模型不该改 `.env`、
   *   更不该重启服务。`.env` 兜底是因为命令行与 CI 没有管理端页面可用，
   *   而且开发机上多数人只填 `.env` 就够了（见设置页的"来源"标注）。
   *
   * 【`modelChat` / `modelReasoner` 为什么不给默认值】默认值放在
   *   `agent/models.ts`（`DEFAULT_CHAT_MODEL` / `DEFAULT_REASONER_MODEL`），
   *   这样"来源"能如实区分"`.env` 里写的"与"内置默认" —— 在这里填一个默认值，
   *   三档取值就永远停在 `env` 这一档，页面上会显示一个没人配过的来源。
   */
  modelChat: string | undefined;
  modelReasoner: string | undefined;
  /** 模型接口地址。留空 = 用 pi-ai 目录里的默认（DeepSeek 官方地址）。 */
  modelBaseUrl: string | undefined;
  /** Embedding 模型的本地缓存根目录 */
  hfHome: string;
  /** transformers.js 的 localModelPath（本地模型根目录），模型放在其子目录下 */
  embedModelDir: string;
  /** 模型子目录名，同时也是传给 pipeline() 的模型标识 */
  embedModelId: string;
  /** ONNX 精度档位：q8 / fp16 / fp32。决定加载哪个 .onnx 文件 */
  embedDtype: 'q8' | 'fp16' | 'fp32';
  /**
   * 是否启用 Cross-Encoder 重排（V3 / R2，**实验，默认关闭**）。
   *
   * 关闭时检索行为与 R1 完全一致；打开后只在 hybrid 路径的融合结果上重排，
   * 模型不可用/超时/输入异常一律回退 RRF，并在响应 `ranking` 里标明实际模式。
   */
  rerankEnabled: boolean;
  /** Reranker 模型子目录名（与 embedding 共用一个模型根目录） */
  rerankModelId: string;
  /** Reranker 精度档位；q8 是实测可接受的默认档 */
  rerankDtype: 'q8' | 'fp16' | 'fp32';
  /** 进入重排的候选数（规格建议 20–40；超过最终 limit 才能改变排序） */
  rerankCandidateDepth: number;
  /** 单次重排的超时（毫秒）；超时回退 RRF 并如实标记 */
  rerankTimeoutMs: number;
  /** 是否对"没有文字层的页"跑 OCR（决策 6）。关掉后扫描件会入库但搜不到内容 */
  ocrEnabled: boolean;
  /**
   * 单份文档最多 OCR 多少页。
   *
   * 【为什么必须有这个上限】OCR 实测约 2 秒/页，而解析是与上传同步做的 ——
   * 没有上限的话，传一本 300 页的扫描书就是一个十分钟不返回的请求。
   * 超过上限的部分**不静默跳过**，会写进 warnings 明确告诉用户还有多少页没做。
   */
  ocrMaxPages: number;
  /**
   * 允许探测的根目录（绝对路径）。空数组 = 什么路径都不探。
   *
   * 【为什么是"白名单"而不是"每个数据集记一个主机名"】部署位置还没定，
   * 这台服务既可能跑在数据服务器上、也可能跑在某人的开发机上。用主机名
   * 挨个标注等于要求用户预先想清楚最终部署在哪，想错了就全错。换成
   * 白名单之后，判断标准变成"这条路径此刻在不在我的允许范围里"：
   * 服务在哪台机器上跑，就配那台机器的目录，别的路径一律报"无法核对"。
   * 同一个数据集登记一次，换台机器只是换个 .env，记录不用改。
   */
  codeRoots: readonly string[];
  /**
   * 数据集落地的根目录（绝对路径）。缺省 `data/datasets`，部署时可配置到数据盘。
   *
   * 【为什么和 uploadDir 分开】`uploadDir` 装的是知识库文档原件（几十 MB 级、
   * 随项目走）；数据集是 GB 级、且**本来就属于数据盘**。混在一起的话，
   * 一次数据集上传就能把项目所在的盘塞满，而那份盘上还躺着数据库。
   */
  dataRoot: string;
  /** 单个上传文件的上限。超了在建会话时就拒，不收到一半才说 */
  uploadMaxBytes: number;
  /**
   * 分片大小。由服务端定并下发给客户端（见 shared/uploads.ts 的 chunkSize）。
   * 8 MB 是权衡：太小则几万个分片、每次续传的查询与目录扫描变重；
   * 太大则单片重传的代价高，弱网下永远传不完一片。
   */
  uploadChunkSize: number;
  /** 多久没动过的未完成会话算废弃，启动时清理（天） */
  uploadSessionTtlDays: number;
  /**
   * 知识沉淀的冲突判定阈值：新知识与该条已生效知识的余弦相似度 ≥ 它，就挂起等裁决。
   *
   * 【0.76 是怎么来的（O11，2026-10-18 实测；原默认 0.82 是估的）】
   *   量法：把 10 对人工改写的"同一件事"与 10 对"明显不同的事"都渲染成
   *   知识入库时的 Markdown 形态，用默认 BGE-M3 算余弦；再拿当时库里真实的
   *   15 条生效条目两两算分，看会误报多少。
   *     · 同一件事：0.757 / 0.766 / 0.794 / 0.795 / 0.862 / 0.872 / 0.889 / 0.894 / 0.900 / 0.908
   *     · 明显不同：0.351–0.505（中位数 0.448）—— 两组之间是一条真正的空档
   *     · 真实条目：105 对里最高 0.791，>0.76 的只有 2 对（同一文档的两节 Introduction），
   *       >0.82 的 0 对
   *   阈值扫描（同一件事召回 / 不同对误报 / 真实条目挂起）：
   *     0.74 → 10/10、0/10、3 对；**0.76 → 9/10、0/10、2 对**；
   *     0.78 → 8/10、0/10、1 对；0.82 → 6/10、0/10、0 对。
   *   0.82 会漏掉 4/10 的改写；0.76 只漏 1/10，代价是每 105 对真实条目多 2 次人工看一眼。
   *   取 0.76：误报的代价是审核队列多两条（可忽略），漏报的代价是两条打架的知识都进了库
   *   （由人工裁决兜底，但前提是它得先被看见）。
   *
   * 【这不是一条永久结论】样本只有 20 对标注 + 15 条真实条目，语料一变就过时。
   *   换语料 / 换向量模型 / 换精度档位都要重新量：`npm run verify-knowledge` 会打印
   *   当前库里的两两分布（只打印、不断言），`tmp/o11-threshold-calibrate.mjs`
   *   是可复算的标注对扫描脚本。看到分布变化再改这里与 `.env.example`。
   */
  knowledgeConflictThreshold: number;
  /**
   * 巡检多久跑一次（小时）。默认 24。
   *
   * 【为什么"多久跑一次"在 `.env`，而"几天算超期"在管理端】
   *   这是两件不同的事，故意放在两个地方：
   *     · 多久跑一次是**运维节奏** —— 它取决于这台机器的负载、你希望待办
   *       多快出现，换个部署就该换，改它不该动产品规则；
   *     · 几天算超期是**产品规则** —— 它来自实验室对"待初审两周没动静"的
   *       判断（约束 3），用户要在管理端自己调，不该逼他去改 `.env` 重启服务。
   *   把两者都塞进 `.env`（或都塞进数据库）会让"改节奏"与"改规则"这两件事
   *   纠缠在一起，谁都说不清一次改动的边界。
   */
  patrolIntervalHours: number;
  /** 登录会话的空闲上限（天）。超过这么久没碰过就失效 */
  sessionIdleDays: number;
  /** 登录会话的绝对上限（天）。不管用得多勤，到点一律重登 */
  sessionMaxDays: number;
  /**
   * 会话 cookie 是否带 `Secure`。
   *
   * 【为什么默认跟着 NODE_ENV 走，而不是写死 true】`Secure` 的语义是
   * "浏览器只允许通过 https 回传这个 cookie"。开发环境是 `http://localhost:3000`，
   * 带上 `Secure` 的后果不是报错，是**浏览器静默把它丢掉** ——
   * 表现为"登录接口返回 200 并 Set-Cookie 了，但下一个请求仍是 401"，
   * 且控制台没有任何提示。这个症状能查一整天。
   *   所以默认是"生产才开"，并且启动时打印实际值（见 index.ts）。
   */
  cookieSecure: boolean;
  /**
   * 是否启用 S5 的受控 Query Rewriting（默认关闭，属实验开关）。
   *
   * 【为什么默认关闭】V3 计划要求"若无净质量提升则默认关闭并保留实验"。
   * 打开后只对 `multi_source` 路由生效，最多 1 轮、每轮最多 3 条子查询，
   * 且仍受四维预算与上下文预算约束；打开方式：`.env` 里设
   * `KNOWPILOT_REWRITE_ENABLED=1`。
   */
  rewriteEnabled?: boolean;
  /** 初始管理员用户名。仅当 users 表为空时用它建号 */
  adminUsername: string | undefined;
  /** 初始管理员口令。同上。落库后这条 .env 记录就没有第二次生效机会 */
  adminPassword: string | undefined;
}

/**
 * 向上查找仓库根目录：第一个带 `workspaces` 字段的 package.json 所在处。
 *
 * 为什么必须这么做（这不是过度设计，是踩过的坑）：
 *   原先路径按 cwd 解析，而 npm 执行 workspace 脚本时会把 cwd 切到子包目录：
 *     `npm run migrate -w @knowpilot/server` → cwd = apps/server
 *     `node apps/server/src/index.ts`     → cwd = 仓库根
 *   同一条相对路径在这两种入口下指向不同位置，于是数据库被建到了
 *   apps/server/data/ 而不是 data/ —— 迁移明明"成功"了，但从根目录
 *   连上去却报 "no such table"。
 *   锚定到仓库根之后，从哪个入口进都指向同一个文件。
 */
export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let depth = 0; depth < 10; depth += 1) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'workspaces' in parsed &&
          (parsed as { workspaces?: unknown }).workspaces !== undefined
        ) {
          return dir;
        }
      } catch {
        // package.json 损坏就继续往上找，不因一个坏文件直接崩
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `从 ${startDir} 向上找不到仓库根目录（没找到带 "workspaces" 的 package.json）。` +
      `若把项目目录整体挪过位置，请确认根 package.json 还在。`,
  );
}

/** 把配置里的相对路径锚定到仓库根；已是绝对路径则原样返回。 */
function anchor(repoRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

/**
 * 解析 CODE_ROOTS。格式是 JSON 数组，例如 `["/srv/knowpilot/datasets"]`。
 *
 * 【为什么不用分隔符列表】`:` 会被 Windows 盘符（`E:/data`）切断，
 * `;` 会被 Linux 上合法的文件名切断 —— 两种都会静默解析出半截路径。
 * 而半截路径的后果不是报错，是巡检时把**一批还在的数据报成"看不到"**，
 * 界面上一切正常，最容易查半天。JSON 数组没有歧义，Node 原生能解析，
 * 写错了还能当场报错。
 *
 * 【为什么路径要过 anchor】与 DB_PATH / UPLOAD_DIR 同一条约定：相对路径
 * 锚到仓库根，从哪个入口启动都指向同一处。绝对路径原样通过，Linux 下配的
 * `/hdd1/...` 拿到 Windows 开发机上依然原样返回 —— 而这正是我们要的：
 * 在开发机上它解析到当前盘根下的同名目录、当然不存在（见下），于是整页
 * 如实显示"本机看不到这个根目录"，而不是报一个错、更不是谎报数据丢了。
 */
function parseCodeRoots(repoRoot: string, raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `CODE_ROOTS 不是合法 JSON：${raw}\n它应该是路径数组，例如 ["/srv/knowpilot/datasets"]。`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== 'string')) {
    throw new Error(
      `CODE_ROOTS 必须是字符串数组，例如 ["/srv/knowpilot/datasets"]，收到：${raw}`,
    );
  }
  return (parsed as string[])
    .map((p) => stripTrailingSep(p.trim()))
    .filter((p) => p !== '')
    .map((p) => anchor(repoRoot, p));
}

/**
 * 去掉尾部分隔符。`/hdd1/datasets/` 与 `/hdd1/datasets` 是同一个目录，
 * 但原样留着会在界面上显示成两副样子，看着像配了两条。
 *
 * 唯一的例外是 `C:\` 这种"盘根"：砍掉尾巴就成了 `C:`，而 `C:` 在 Windows
 * 上表示"当前目录所在的盘"，是个**相对**路径，会被 anchor 锚到仓库根上去 ——
 * 白名单静默变成另一个目录，正是最不该出的错。所以原样保留。
 */
function stripTrailingSep(p: string): string {
  const s = p.replace(/[/\\]+$/, '');
  return /^[A-Za-z]:$/.test(s) ? p : s;
}

/** 去空白；空白串一律当"没配"，免得把一串空格当成一个合法的 provider 名。 */
function trimmed(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v === undefined || v === '' ? undefined : v;
}

/**
 * 模型缓存根（BGE-M3 权重所在）的取值口径。
 *
 * 【为什么单独导出】评测跑批（`eval/run.ts`）**不复用 `loadConfig()`** —— 那会把
 *   `DATA_ROOT` 锚到临时根。但**模型缓存是只读输入，不是"本轮要造的数据"**：
 *   把它也指向临时根，评测里的语义检索会因"权重不在那儿"而**静默降级成关键词检索**
 *   （只留一条"语义检索不可用"的说明），于是评测跑的**根本不是生产那套检索** ——
 *   而"跑出来的结果能不能和生产比"正是 03 号 §4 的可比条件要求成立的前提。
 *   2026-10-14 首次全量跑就是踩了这个：GC-02 只召回 1 条，查下去才发现权重被指丢了。
 */
export function defaultHfHome(repoRoot: string): string {
  return anchor(repoRoot, trimmed(process.env['HF_HOME']) ?? '.cache/huggingface');
}

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    throw new Error(`缺少必需的环境变量 ${name}。请复制 .env.example 为 .env 并填写。`);
  }
  return v.trim();
}

export function loadConfig(): AppConfig {
  const portRaw = process.env['PORT'] ?? '3000';
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT 不是合法端口：${portRaw}`);
  }

  const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

  // DEEPSEEK_API_KEY 允缺省：这样"只跑服务不问答"时不会被卡住。
  // 真正需要它的地方（agent/*）会自己检查并给出明确报错。
  const key = process.env['DEEPSEEK_API_KEY']?.trim();

  const hfHome = defaultHfHome(repoRoot);

  const dataRoot = anchor(repoRoot, trimmed(process.env['DATA_ROOT']) ?? 'data/datasets');

  const embedDtype = parseDtype(process.env['EMBED_DTYPE']);

  return {
    port,
    dbPath: anchor(repoRoot, process.env['DB_PATH'] ?? 'data/knowpilot.db'),
    uploadDir: anchor(repoRoot, process.env['UPLOAD_DIR'] ?? 'data/uploads'),
    repoRoot,
    deepseekApiKey: key !== undefined && key !== '' ? key : undefined,
    modelChat: trimmed(process.env['MODEL_CHAT']),
    modelReasoner: trimmed(process.env['MODEL_REASONER']),
    modelBaseUrl: trimmed(process.env['MODEL_BASE_URL']),
    hfHome,
    embedModelDir: join(hfHome, 'knowpilot-models'),
    embedModelId: process.env['EMBED_MODEL_ID'] ?? 'bge-m3',
    embedDtype,
    rerankEnabled: parseBool(process.env['KNOWPILOT_RERANK_ENABLED'], false),
    rerankModelId: process.env['RERANK_MODEL_ID'] ?? 'bge-reranker-base',
    rerankDtype: parseDtype(process.env['RERANK_DTYPE']),
    rerankCandidateDepth: parsePositiveInt(process.env['RERANK_CANDIDATE_DEPTH'], 30),
    rerankTimeoutMs: parsePositiveInt(process.env['RERANK_TIMEOUT_MS'], 3000),
    ocrEnabled: parseBool(process.env['OCR_ENABLED'], true),
    ocrMaxPages: parsePositiveInt(process.env['OCR_MAX_PAGES'], 50),
    codeRoots: parseCodeRoots(repoRoot, process.env['CODE_ROOTS']),
    dataRoot,
    uploadMaxBytes: parsePositiveInt(process.env['UPLOAD_MAX_BYTES'], 100 * 1024 * 1024 * 1024),
    uploadChunkSize: parsePositiveInt(process.env['UPLOAD_CHUNK_SIZE'], 8 * 1024 * 1024),
    uploadSessionTtlDays: parsePositiveInt(process.env['UPLOAD_SESSION_TTL_DAYS'], 7),
    knowledgeConflictThreshold: parseUnitFloat(
      process.env['KNOWLEDGE_CONFLICT_THRESHOLD'],
      0.76,
    ),
    patrolIntervalHours: parsePositiveInt(process.env['PATROL_INTERVAL_HOURS'], 24),
    sessionIdleDays: parsePositiveInt(process.env['SESSION_IDLE_DAYS'], 7),
    sessionMaxDays: parsePositiveInt(process.env['SESSION_MAX_DAYS'], 30),
    cookieSecure: parseBool(process.env['COOKIE_SECURE'], process.env['NODE_ENV'] === 'production'),
    // 实验开关：默认关闭；打开后只影响 multi_source 路由，且仍受全部预算约束。
    rewriteEnabled: parseBool(process.env['KNOWPILOT_REWRITE_ENABLED'], false),
    adminUsername: trimmed(process.env['KNOWPILOT_ADMIN_USER']),
    adminPassword: trimmed(process.env['KNOWPILOT_ADMIN_PASSWORD']),
  };
}

/** 环境变量里的布尔：只认 0 / 1 / true / false，别的一律报错而不是猜。 */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  throw new Error(`布尔环境变量只接受 0/1/true/false，收到 "${raw}"。`);
}

/**
 * 0–1 之间的小数（含 0 与 1）。用于相似度阈值这类"比例"。
 *
 * 【为什么必须拦下 1 以外的越界值】阈值填成 1.5 的后果不是报错，而是
 *   "**没有任何两条会被判为冲突**" —— 冲突检测静默失效，而页面上一切正常。
 *   这类"配错了却看起来在正常工作"的配置最危险，所以在启动时就拒掉。
 */
function parseUnitFloat(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`这个环境变量需要是 0 到 1 之间的小数，收到 "${raw}"。`);
  }
  return n;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`这个环境变量需要是正整数，收到 "${raw}"。`);
  }
  return n;
}

/**
 * 精度档位 → ONNX 文件名前缀。
 *
 * 这套命名（`model_quantized` / `model_fp16` / `model`）是 transformers.js
 * 内部的约定，不是我们起的名字，也不能自创 —— 写错的名字会让它去下载
 * 一个不存在的文件。下载脚本与推理端必须查同一张表，故放在这里共用。
 */
export const EMBED_ONNX_FILE: Record<AppConfig['embedDtype'], string> = {
  q8: 'model_quantized',
  fp16: 'model_fp16',
  fp32: 'model',
};

/** 模型标识，写进 chunk_embeddings.model。换模型/换精度后必须与旧向量区分开。 */
export function embeddingModelKey(cfg: AppConfig): string {
  return `${cfg.embedModelId}-${cfg.embedDtype}`;
}

/** 权重文件绝对路径。用于"模型是否已下载"的判断。 */
export function onnxPath(cfg: AppConfig): string {
  return join(cfg.embedModelDir, cfg.embedModelId, 'onnx', `${EMBED_ONNX_FILE[cfg.embedDtype]}.onnx`);
}

function parseDtype(raw: string | undefined): AppConfig['embedDtype'] {
  if (raw === undefined || raw === '' || raw === 'q8') return 'q8';
  if (raw === 'fp16' || raw === 'fp32') return raw;
  throw new Error(`EMBED_DTYPE 只支持 q8 / fp16 / fp32，收到 "${raw}"。`);
}

/**
 * 取 `.env` 里的 key，缺了就说清楚。**只给不走数据库的地方用**。
 *
 * 【为什么不能拿它当"有没有 key"的判据】它只看 `.env`。管理端把 key 写进
 *   `system_config` 表、`.env` 里没填时，它会误报"未配置" —— 而模型其实完全可用。
 *   问答与整理链路一律走 `requireModelSettings(db, cfg)`（表优先、`.env` 兜底）；
 *   只有 `agent/smoke.ts` 这类纯 `.env` 的开发探活脚本还用这里。
 */
export function requireApiKey(cfg: AppConfig): string {
  if (cfg.deepseekApiKey === undefined) {
    throw new Error(
      '未配置 DEEPSEEK_API_KEY。请在项目根目录 .env 里填写后重试。' +
        '（申请地址：https://platform.deepseek.com）',
    );
  }
  return cfg.deepseekApiKey;
}

void required;
