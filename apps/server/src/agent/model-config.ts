/**
 * 大模型接口设置的解析：**`system_config` 表优先，`.env` 兜底，再落内置默认**。
 *
 * 【为什么读的时候要顺手做一次表查询，而不是像别的配置一样启动时读一次】
 *   因为它的设计意图就是"管理端改一下立刻生效、不重启服务"。启动时读一次会让
 *   这个意图落空 —— 用户在管理端填好了 key，却因为没重启而一直"模型不可用"，
 *   而界面上没有任何线索指向"要重启"。一次主键查询是微秒级，随每次 run 读没有代价。
 *
 * 【为什么配置不全时不抛错，而是回一个 available=false】没配 key = 这个部署还不能
 *   调模型，是**合法状态**。真正要调的时候（`requireModelSettings`）才给明确的"未配置"文案。
 *
 * 【为什么解析要能说出"每一项是从哪来的"】管理端配置页要回答的第一个问题不是
 *   "表里写了什么"，而是"**为什么现在这样**"：表里空空、模型却可用，是因为 `.env`
 *   里有；表里写着一个地址、实际用的是另一个，那是没保存成功或被 CLI 覆盖过。
 *   只说值不说来源，管理员就只能靠猜。所以每一项都带一个 `xxxSource`。
 */
import type {
  ConfigSecretSource,
  ConfigSource,
  EffectiveModelSettings,
  ModelCatalogEntry,
} from '@knowpilot/shared';
import { AppError, MODEL_CONFIG_KEYS } from '@knowpilot/shared';
import type { MutableModels } from '@earendil-works/pi-ai';
import type { Db } from '../db/index.ts';
import type { AppConfig } from '../config.ts';
import { DEEPSEEK, DEFAULT_BASE_URL, DEFAULT_CHAT_MODEL, DEFAULT_REASONER_MODEL } from './models.ts';

/**
 * 解析结果 = 生效值 + 每项的来源。**只有服务端能见到 `apiKey`**，
 * 对外一律走 `modelStatus()`（那个类型里根本没有这个字段）。
 */
export interface ResolvedModelSettings {
  available: boolean;
  baseUrl: string;
  chatModel: string;
  reasonerModel: string;
  baseUrlSource: ConfigSource;
  chatModelSource: ConfigSource;
  reasonerModelSource: ConfigSource;
  apiKeySource: ConfigSecretSource;
  /** 内部使用。**不要把它放进任何响应体** —— 对外有 `EffectiveModelSettings` 这道投影。 */
  apiKey: string | null;
}

interface Picked {
  value: string | undefined;
  source: ConfigSecretSource;
}

/**
 * 三档取值：表里的非空值 → `.env` 的非空值 → 没有。
 *
 * `''` 与"没有"要分开：表里写空串是**显式清空**（取值回落到 `.env`），
 * 它跟"表里压根没有这一行"在结果上一样，在 `source` 上也说得通（都落到下一档）。
 */
function pickValue(table: Map<string, string>, key: string, fallback: string | undefined): Picked {
  const dbValue = table.get(key)?.trim();
  if (dbValue !== undefined && dbValue !== '') return { value: dbValue, source: 'table' };
  const envValue = fallback?.trim();
  if (envValue !== undefined && envValue !== '') return { value: envValue, source: 'env' };
  return { value: undefined, source: 'none' };
}

/** 一次性把 `system_config` 读成 Map。每次 run 一次，避免四次要四个查询。 */
export function readConfigTable(db: Db): Map<string, string> {
  const rows = db
    .prepare('SELECT key, value FROM system_config')
    .all() as unknown as { key: string; value: string }[];
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** 三档取值 + 内置默认兜底。来源为 `default` 表示前面两档都没有。 */
function pickWithDefault(
  table: Map<string, string>,
  key: string,
  envValue: string | undefined,
  builtinDefault: string,
): { value: string; source: ConfigSource } {
  const picked = pickValue(table, key, envValue);
  if (picked.value === undefined) return { value: builtinDefault, source: 'default' };
  return { value: picked.value, source: picked.source as ConfigSource };
}

/**
 * 解析当前生效的大模型接口设置（含来源）。**任何情况下都返回一个对象**，
 * "能不能用"看 `available` —— 管理端要显示"为什么不可用"，那也需要值本身。
 */
export function resolveModelSettings(
  db: Db,
  cfg: AppConfig,
  table = readConfigTable(db),
): ResolvedModelSettings {
  const baseUrlPick = pickWithDefault(table, MODEL_CONFIG_KEYS.baseUrl, cfg.modelBaseUrl, DEFAULT_BASE_URL);
  const chatPick = pickWithDefault(table, MODEL_CONFIG_KEYS.chat, cfg.modelChat, DEFAULT_CHAT_MODEL);
  const reasonerPick = pickWithDefault(
    table,
    MODEL_CONFIG_KEYS.reasoner,
    cfg.modelReasoner,
    DEFAULT_REASONER_MODEL,
  );
  const apiKeyPick = pickValue(table, MODEL_CONFIG_KEYS.apiKey, cfg.deepseekApiKey);

  return {
    available: apiKeyPick.value !== undefined,
    baseUrl: baseUrlPick.value,
    chatModel: chatPick.value,
    reasonerModel: reasonerPick.value,
    baseUrlSource: baseUrlPick.source,
    chatModelSource: chatPick.source,
    reasonerModelSource: reasonerPick.source,
    apiKeySource: apiKeyPick.value === undefined ? 'none' : (apiKeyPick.source as ConfigSource),
    apiKey: apiKeyPick.value ?? null,
  };
}

/**
 * 解析结果缺席（没配 key）时的报错。**由调用方在 run 开始处调用**，
 * 这样"没配"是在提问/整理**开始前**就说清楚，而不是让 Agent 跑到一半才炸。
 */
export function requireModelSettings(db: Db, cfg: AppConfig): ResolvedModelSettings {
  const resolved = resolveModelSettings(db, cfg);
  if (!resolved.available) {
    throw new AppError(
      'invalid_argument',
      '尚未配置大模型 API key。请在管理端「系统设置」里填写，' +
        '或在项目根目录 .env 里配置 DEEPSEEK_API_KEY 后重启。（申请地址：https://platform.deepseek.com）',
    );
  }
  return resolved;
}

/** pi-ai 目录里的模型，供管理端下拉。 */
export function catalogEntries(models: MutableModels): ModelCatalogEntry[] {
  return models.getModels(DEEPSEEK).map((m) => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }));
}

/**
 * 对外（管理端页面）的模型设置：**逐字段挑出来构造，不用展开语法**。
 *
 * 【为什么不 `{ ...resolved }` 再把 apiKey 删掉】那是"先有泄漏、后打补丁"：
 *   以后往 `ResolvedModelSettings` 加一个内部字段（比如重试次数），展开语法会
 *   **自动把它也带出去**，而没人会想起来回来看这一行。逐字段构造的默认是"不外传"，
 *   新增字段要泄漏必须显式写一行 —— 这是两种相反的错误代价。
 */
export function modelStatus(db: Db, cfg: AppConfig, models: MutableModels): EffectiveModelSettings {
  const r = resolveModelSettings(db, cfg);
  const catalog = catalogEntries(models);
  const inCatalog = (id: string): boolean => catalog.some((m) => m.id === id);
  return {
    available: r.available,
    baseUrl: r.baseUrl,
    chatModel: r.chatModel,
    reasonerModel: r.reasonerModel,
    baseUrlSource: r.baseUrlSource,
    chatModelSource: r.chatModelSource,
    reasonerModelSource: r.reasonerModelSource,
    apiKeySource: r.apiKeySource,
    chatInCatalog: inCatalog(r.chatModel),
    reasonerInCatalog: inCatalog(r.reasonerModel),
    catalog,
  };
}
