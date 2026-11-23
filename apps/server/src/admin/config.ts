/**
 * 系统配置（大模型接口）的读写（阶段 4C 单元 ③，2026-10-12 由「联网搜索」改造而来）。
 *
 * 【为什么读要单独做一份，而不是把 `system_config` 的行走出来】
 *   因为那张表存的是"**改过什么**"，而管理员想知道的是"**现在是什么**"。
 *   两者在正常情况下就不一样：`.env` 里配了 key、表里一行没有 —— 表是空的，
 *   而模型完全可用。只回显表里的行，页面会把"可用"显示成"什么都没配"。
 *   所以对外一次给两块：`items`（表里的行，供编辑）与 `model`（生效值 + 每项来源）。
 *
 * 【为什么密钥一个字节都不出门】无论是表里的行还是生效值，`api_key` 只以
 *   "填了没填"的形式出现。掩码不是按"哪个键该掩"写死的，而是**按键名的形状**判
 *   （见 `isSecretKey`）：`model.api_key` 自动命中；以后加一项
 *   `patrol.webhook_secret` 也一样 —— 靠"记得来加一条白名单"的掩码，迟早会漏。
 *
 * 【为什么写是 PATCH 语义（只传要改的项）】与本项目其它更新接口一致
 *   （`PATCH /api/v1/users/:id`、`PATCH /api/v1/code-assets/:id`）。
 *   对配置页尤其要紧：apiKey 那一类东西**不能靠"把原值再发一遍"来保持不变**，
 *   "没填"必须有一个不与"清空"混淆的表达 —— 那就是"这个键根本不出现"。
 */
import {
  AppError,
  MODEL_CONFIG_KEYS,
  type TestModelConnectionRequest,
  type SystemConfigEntry,
  type SystemConfigResponse,
} from '@knowpilot/shared';
import type { MutableModels } from '@earendil-works/pi-ai';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { modelStatus } from '../agent/model-config.ts';

/** 键名像不像一个秘密。宁可多掩（把非密的值也标成"已设置"），不可少掩。 */
const SECRET_KEY_PATTERN = /(api[_-]?key|secret|token|password|passwd)/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

interface ConfigRow {
  key: string;
  value: string;
  updated_at: string;
  updated_by_name: string | null;
}

/**
 * 表里全部配置行。`updated_by` 走 LEFT JOIN 取显示名。
 *
 * 【为什么这里不会出现"名字查不到"的第三种情况】`updated_by` 有外键指向 `users`，
 *   而账号只会被**停用**、从不删除（见 `/admin/users` 的禁用语义），所以要么
 *   NULL（命令行 / CI 写的），要么一定能连上人。于是 `updatedByName === null`
 *   只有一种解释，界面可以放心地说"不是网页改的"。
 */
function readRows(db: Db): ConfigRow[] {
  return db
    .prepare(
      `SELECT sc.key, sc.value, sc.updated_at, u.display_name AS updated_by_name
         FROM system_config sc
         LEFT JOIN users u ON u.id = sc.updated_by
        ORDER BY sc.key`,
    )
    .all() as unknown as ConfigRow[];
}

export function systemConfigView(
  db: Db,
  cfg: AppConfig,
  models: MutableModels,
): SystemConfigResponse {
  const items: SystemConfigEntry[] = readRows(db).map((row) => {
    const secret = isSecretKey(row.key);
    return {
      key: row.key,
      // 密钥不回显：`value` 恒为 null，想知道"填没填"看 isSet。
      value: secret ? null : row.value,
      isSet: row.value.trim() !== '',
      updatedAt: row.updated_at,
      updatedByName: row.updated_by_name,
    };
  });

  return { items, model: modelStatus(db, cfg, models) };
}

/** 一条待写入的配置。 */
interface ConfigWrite {
  key: string;
  value: string;
}

/** 请求体里允许出现的字段。出现别的名字一律拒绝（见下面注释）。 */
const ALLOWED_FIELDS = ['baseUrl', 'chat', 'reasoner', 'apiKey'] as const;

function readTextField(body: Record<string, unknown>, field: string): string | undefined {
  const raw = body[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new AppError('invalid_argument', `${field} 必须是字符串。`);
  }
  return raw.trim();
}

/**
 * 校验接口地址。返回规范化后的地址。
 *
 * 【为什么必须拒绝 userinfo】`https://user:pass@host/v1` 这种形状里带凭据，
 *   它会被原样存进配置、也可能被原样塞进请求。这个接口是"出站目标由管理员决定"的
 *   一处入口，能少一个可藏东西的地方就少一个。
 *
 * 【为什么只允许 http/https】其它协议（`file:`、`ftp:`）不是模型接口的形态，
 *   放行只会多几种"填错了却存进去了"的方式。
 */
function validateBaseUrl(field: string, raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError(
      'invalid_argument',
      `${field} 不是一个合法的地址：「${raw}」。要带协议，例如 https://api.deepseek.com`,
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AppError('invalid_argument', `${field} 只支持 http/https，收到「${parsed.protocol}」。`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new AppError('invalid_argument', `${field} 里不能带用户名或密码（不要写成 https://user:pass@…）。`);
  }
  return raw;
}

/**
 * 校验一把 API key。
 *
 * 【为什么只做形状校验、不查库不联网】"这串东西是不是一把真 key"只有上游知道；
 *   保存时联网去验，会让保存变成一个几秒的请求、还会因为上游抖动而存不进去。
 *   要验的话另有「测试连接」按钮。这里只拦两个"粘错了"的常见形状：
 *   中间带空白（连带复制了文档里的别的字）、短得不像一把完整的 key。
 */
function validateApiKey(raw: string): string {
  if (/\s/.test(raw)) {
    throw new AppError('invalid_argument', 'API key 中间不应有空白字符，看起来是复制时多带了内容。');
  }
  if (raw.length < 8) {
    throw new AppError('invalid_argument', 'API key 太短了，看起来不像一把完整的 key。');
  }
  return raw;
}

/**
 * 把请求体解析成一串待写入的项。**不碰数据库**，纯校验。
 *
 * 【为什么遇到不认识的字段要报错，而不是忽略】静默忽略意味着：前端把字段名写错了
 *   （`api_key` vs `apiKey`），保存接口返回 200，页面显示"已保存"，而配置一个字没变。
 *   这种错最难查 —— 它需要有人去翻数据库才发现。报错则当场就看见。
 */
export function parseSystemConfigUpdate(body: Record<string, unknown>): ConfigWrite[] {
  for (const key of Object.keys(body)) {
    if (!(ALLOWED_FIELDS as readonly string[]).includes(key)) {
      throw new AppError(
        'invalid_argument',
        `不认识的配置项「${key}」。可改的是：${ALLOWED_FIELDS.join('、')}。`,
      );
    }
  }

  const writes: ConfigWrite[] = [];

  const baseUrl = readTextField(body, 'baseUrl');
  if (baseUrl !== undefined && baseUrl !== '') {
    writes.push({ key: MODEL_CONFIG_KEYS.baseUrl, value: validateBaseUrl('接口地址', baseUrl) });
  } else if (baseUrl === '') {
    writes.push({ key: MODEL_CONFIG_KEYS.baseUrl, value: '' });
  }

  // 两个模型名只做去空白，**不限定在 pi-ai 目录里**：项目允许把接口地址指向第三方
  // 中转站，中转站的模型名往往与目录不同（比如官方叫 deepseek-chat）。
  // 目录外的名字会在运行时按模板克隆元数据（见 agent/models.ts），页面上会提示"按估算"。
  const chat = readTextField(body, 'chat');
  if (chat !== undefined) {
    writes.push({ key: MODEL_CONFIG_KEYS.chat, value: chat });
  }

  const reasoner = readTextField(body, 'reasoner');
  if (reasoner !== undefined) {
    writes.push({ key: MODEL_CONFIG_KEYS.reasoner, value: reasoner });
  }

  const apiKey = readTextField(body, 'apiKey');
  if (apiKey !== undefined && apiKey !== '') {
    writes.push({ key: MODEL_CONFIG_KEYS.apiKey, value: validateApiKey(apiKey) });
  } else if (apiKey === '') {
    writes.push({ key: MODEL_CONFIG_KEYS.apiKey, value: '' });
  }

  // 什么都不改也是合法请求（空数组）：与 `PATCH /api/v1/users/:id` 同一个口径 ——
  // 客户端"每次把全部字段回传一遍"是常见写法，值没变也算回传，为它回一个 400
  // 等于逼客户端自己去比较一遍，而它本来就在比较（配置页就是靠比较算补丁的）。
  return writes;
}

/**
 * 解析「测试连接」的请求体。与保存接口同一套字段校验（地址、key 的形状），
 * 这样"保存能过、测试报 400"这种自相矛盾的情况不会出现。
 *
 * 三样都是可选的：缺哪样就用生效值兜底 —— 否则"填了还没保存就点测试"会测到旧值，
 * 而密钥框永远为空，会误报"没有 key"。
 */
export function parseTestConnectionRequest(body: Record<string, unknown>): TestModelConnectionRequest {
  const allowed = ['baseUrl', 'chatModel', 'apiKey'] as const;
  for (const key of Object.keys(body)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new AppError('invalid_argument', `不认识的字段「${key}」。可传的是：${allowed.join('、')}。`);
    }
  }

  const out: {
    baseUrl?: string;
    chatModel?: string;
    apiKey?: string;
  } = {};

  const baseUrl = readTextField(body, 'baseUrl');
  if (baseUrl !== undefined && baseUrl !== '') out.baseUrl = validateBaseUrl('接口地址', baseUrl);

  const chatModel = readTextField(body, 'chatModel');
  if (chatModel !== undefined && chatModel !== '') out.chatModel = chatModel;

  const apiKey = readTextField(body, 'apiKey');
  if (apiKey !== undefined && apiKey !== '') out.apiKey = validateApiKey(apiKey);

  return out;
}

/**
 * 落库并回读。写入走一个事务：这几项是**一次保存**，不该出现"地址改成了中转站、
 *   key 还是旧的那把"这种半截状态 —— 那会让模型直接不可用。
 *
 * 【校验全部在事务之前】`parseSystemConfigUpdate` 已经跑完了（调用方先调它），
 *   所以这里失败的只可能是数据库层面的错，回滚就够了。
 */
export function applySystemConfigUpdate(
  db: Db,
  cfg: AppConfig,
  models: MutableModels,
  writes: readonly ConfigWrite[],
  actorId: string,
  now: Date,
): SystemConfigResponse {
  if (writes.length === 0) return systemConfigView(db, cfg, models);

  const stmt = db.prepare(
    `INSERT INTO system_config (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  );
  const at = now.toISOString();

  db.exec('BEGIN');
  try {
    for (const w of writes) stmt.run(w.key, w.value, at, actorId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // 回读而不是在内存里拼：生效值的计算逻辑只有 `modelStatus` 一处，
  // 让"保存后界面显示的"与"下次读到的"共用同一条路径，不会各说各话。
  return systemConfigView(db, cfg, models);
}
