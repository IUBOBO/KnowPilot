/**
 * 系统配置契约（阶段 4C 单元 ③）。
 *
 * 【为什么键名要放在 shared】`system_config` 是一张 key-value 表，键名是字符串 ——
 *   而它有三个读者：服务端解析配置、管理端页面写配置、命令行 `set-config`。
 *   三处各写一遍字面量 'model.base_url'，拼错一个字母不会报错，只会
 *   **静默写进一行没人读的配置**。放进 shared 之后，拼错就是编译错误。
 *
 * 【2026-10-12 从「联网搜索」改成「大模型接口」】这一页原来配的是联网搜索 provider，
 *   而那项能力没有可用的 API、整体下线了。现在它配的是**整个系统调模型时用的
 *   key / 接口地址 / 两个模型名** —— 有了接口地址，就能指向第三方中转站，
 *   不必把地址写死在代码里。分区来源词表里的 `web_search` 是**数据标签**、
 *   不是这一页的配置，它随历史数据一起保留（见 submissions.ts）。
 */

/** `system_config` 里大模型接口的那几个键。 */
export const MODEL_CONFIG_KEYS = {
  apiKey: 'model.api_key',
  baseUrl: 'model.base_url',
  chat: 'model.chat',
  reasoner: 'model.reasoner',
} as const;

/** 一个值是从哪儿来的。 */
export type ConfigSource = 'table' | 'env' | 'default';
/** 密钥多一种来源：哪里都没有。 */
export type ConfigSecretSource = ConfigSource | 'none';

/** 目录里的一个模型。管理端用它渲染下拉，也用它判断手填的名字在不在目录里。 */
export interface ModelCatalogEntry {
  /** pi-ai 目录里的模型 ID（也是发给上游的 `model` 字段） */
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
}

/**
 * 当前**生效**的大模型接口设置。
 *
 * 【为什么要有这一块，而不是只把表里的行返回来】配置是"**表优先、`.env` 兜底**"的，
 *   所以"表里没有这一行"与"这一项没配"是**两件事**：`.env` 里填了 key 的时候，
 *   管理端页面上那一行是空的，模型却完全可用。只返回表里的行，管理员会看到
 *   一个和事实相反的界面（"都没配"），然后去补一份本来就有的配置。
 *   这里把"生效值 + 每一项的来源"一起给他，界面才说得清"为什么它是可用的"。
 *
 * 【为什么不含 apiKey】它不是"回显时不显示"，而是**这个类型里根本没有这个字段** ——
 *   将来谁想顺手把解析结果整个 `c.json()` 出去，也带不走密钥。
 *
 * 【`*InCatalog` 是为什么】模型名允许手填（换中转站时上游的模型名可能不同），
 *   手填的名字不在 pi-ai 目录里时，上下文窗口 / 输出上限 / 费用只能**按模板估算**。
 *   这两个布尔就是让界面能如实说出这件事，而不是假装元数据准确。
 */
export interface EffectiveModelSettings {
  /** 有 key 就算可用（接口地址与两个模型名都有兜底值）。 */
  available: boolean;
  baseUrl: string;
  chatModel: string;
  reasonerModel: string;
  baseUrlSource: ConfigSource;
  chatModelSource: ConfigSource;
  reasonerModelSource: ConfigSource;
  apiKeySource: ConfigSecretSource;
  chatInCatalog: boolean;
  reasonerInCatalog: boolean;
  /** pi-ai 目录里的模型，给管理端的下拉用。 */
  catalog: readonly ModelCatalogEntry[];
}

/**
 * 管理端看到的一行配置。
 *
 * 【`value` 为什么可以是 null】两种含义靠 `isSet` 区分，不能只看 `value`：
 *   · 密钥（`model.api_key`）**永不回显**，`value` 恒为 null、`isSet` 表示填没填；
 *   · 其余项 `value` 是表里的原文（空串 = 显式清空过，取值回落到 `.env` / 默认）。
 *   只判 `value === null` 当"没配"用，会在密钥那一行得出相反的结论。
 */
export interface SystemConfigEntry {
  key: string;
  value: string | null;
  isSet: boolean;
  updatedAt: string | null;
  /**
   * 改这一项的人的显示名。`null` 表示"不是网页改的"——
   * 命令行 `set-config` 与 CI 都没有用户，它们写的行 `updated_by` 就是空的。
   * 界面**不能**把这两种情况显示成同一句话（"没人改过" ≠ "命令行改的"）。
   */
  updatedByName: string | null;
}

export interface SystemConfigResponse {
  items: readonly SystemConfigEntry[];
  model: EffectiveModelSettings;
}

/**
 * 改配置。**只传要改的项**，不出现的键一律不动。
 *
 * 三档语义（与 `UpdateUserRequest` 一致）：
 *   · 不出现 → 不动（这也是"页面上没碰密钥"的表达方式：密钥框留空 = 不发这个键）；
 *   · 空串 → **清空这一项**（写空串，取值回落到 `.env` / 内置默认值）；
 *   · `baseUrl` 必须是合法的 http(s) 地址（会真的发请求过去）；
 *     `chat` / `reasoner` **只 trim、不限名单** —— 第三方中转站的模型名不在
 *     pi-ai 目录里是正常的，不拦，只在界面上如实提示元数据按模板估算。
 *
 * 【为什么是"清空"而不是"删掉那一行"】与命令行 `set-config` 同一个口径：
 *   两种写法（删行 / 写空串）会让"这一项被谁清过、什么时候清的"丢掉一半信息，
 *   而留一行空值还能显示"上一次是谁把它清掉的"。
 */
export interface UpdateSystemConfigRequest {
  baseUrl?: string;
  chat?: string;
  reasoner?: string;
  apiKey?: string;
}

/**
 * 「测试连接」的请求。
 *
 * 【为什么允许传值覆盖已保存的配置】两种口径都不能单独用：
 *   · 只测已保存值 → 用户"填了还没保存就点测试"，测到的是旧值，按钮在最需要它的
 *     那一刻失效；
 *   · 只测表单值 → 已保存的密钥**不回显**，表单里那个框永远是空的，
 *     会误报"没配置 key"。
 *   所以逐字段「表单给了就用表单的，没给就用当前生效值」。
 */
export interface TestModelConnectionRequest {
  baseUrl?: string;
  chatModel?: string;
  apiKey?: string;
}

/**
 * 测试连接的结论。**逐档分而不是"成功/失败"两档**：
 *   「地址不通」与「key 不对」与「key 对但没这个模型」在排查时是三件事，
 *   混成一个"失败"等于把用户丢回"自己猜"。
 */
export type TestConnectionKind =
  /** 通了：地址可达，key 被上游接受。 */
  | 'ok'
  /** 鉴权失败（401/403）：key 不对，或这把 key 没有该模型的权限。 */
  | 'auth'
  /** 地址通了但路径不对（404）：多半是接口地址该不该带 `/v1` 没搞对。 */
  | 'not_found'
  /** 地址不通：域名解析失败 / 连接被拒 / 不可达。 */
  | 'unreachable'
  /** 地址不通：连上了却迟迟没有响应，超过时限。 */
  | 'timeout'
  /** 地址与 key 都通，但被上游限流（429）——这其实证明"通了"。 */
  | 'rate_limited'
  /** 上游故障（5xx）：地址与 key 可能都对，是对方服务的问题。 */
  | 'upstream'
  /** 地址通了，但返回的不是模型接口的响应（HTML 错误页 / 反代配置问题）。 */
  | 'bad_response'
  /** 还没有可用的 key：表单没填，表里与 `.env` 里也没有。 */
  | 'not_configured';

export interface TestModelConnectionResponse {
  kind: TestConnectionKind;
  /** `kind === 'ok'` 的等价写法，前端不必自己枚举。 */
  ok: boolean;
  /** 上游返回的 HTTP 状态码；连接层就失败时为 null。 */
  httpStatus: number | null;
  /** 中文人话结论，直接显示给用户。 */
  message: string;
  /** 本次实际测的接口地址与模型名（**非密钥**），让用户看清测的是什么。 */
  baseUrl: string;
  chatModel: string;
  chatInCatalog: boolean;
  /** 两个模型名只在本地对着目录校验，不发请求（省一次调用）。 */
  reasonerModel: string;
  reasonerInCatalog: boolean;
  elapsedMs: number;
}
