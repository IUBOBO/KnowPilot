import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PageTitle } from '../components/PageTitle.tsx';
import {
  MODEL_CONFIG_KEYS,
  type ConfigSecretSource,
  type ConfigSource,
  type EffectiveModelSettings,
  type ModelCatalogEntry,
  type SystemConfigEntry,
  type SystemConfigResponse,
  type TestModelConnectionResponse,
  type UpdateSystemConfigRequest,
} from '@knowpilot/shared';
import { apiGet, apiPatch, apiPost, isAbort, toApiError, type ApiError } from '../api.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SkeletonLines, SkeletonTable } from '../components/Skeleton.tsx';
import { fmtDateTime } from '../format.ts';

/**
 * 系统配置 = 整个系统的大模型 API 接口设置（阶段 4C 单元 ③，2026-10-12 改造）。
 *
 * 【这一页要回答的第一个问题不是"表里写了什么"，而是"为什么现在是这样"】
 *   配置是**本页存的 → `.env` → 内置默认**三档兜底的。表里一行都没有、模型却
 *   完全可用，是完全正常的（`.env` 里配了 key）。所以页面把两件事分开画：
 *   上面是「当前生效 + 每一项的来源」，下面是「表里存了什么、谁什么时候存的」。
 *   只画后者的话，管理员看到一个全空页，会去把本来就有的配置再填一遍。
 *
 * 【为什么"改哪几项"靠对比算出来，而不是让用户勾"我要改这一项"】
 *   表单的初值就是服务端现在的值，提交时只发**与初值不同**的字段。这样"留空"
 *   自动有了明确含义：初值非空、现在空了 = 清掉这一项；初值本来就空、现在还是空 = 没动。
 *   让用户自己去勾选"这一项要不要提交"，等于把同一件事问两遍。
 *   ★ 唯一的例外是 API key：它的原值**永远不会回到浏览器**（服务端只回"填了没填"），
 *   没法对比，所以它单有一个「清掉已保存的 key」勾选（见下面 FormState 的注释）。
 */
export function ConfigPage() {
  const [state, setState] = useState<SystemConfigResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await apiGet<SystemConfigResponse>('/api/v1/system-config', signal);
      if (signal?.aborted) return;
      setState(response);
      setError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setError(toApiError(err));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  return (
    <>
      <PageTitle icon="config">系统配置</PageTitle>
      <p className="lead">配置大模型接口与密钥，保存后立即生效。</p>

      {error !== null && <ErrorNotice error={error} onRetry={() => void load()} />}
      {/* **两张**卡按真实结构摆出来（标题是常量，不来自接口），数据区先用骨架占位 ——
          这样整页高度一开始就是最终高度，内容到达时只有数据区换掉，页面不跳。
          骨架的表格形状要与真表一致：现在是 5 列 × 4 项（合并之后多了两列）
          —— 列数不一致的话，内容到达时表头宽度会跳一次。 */}
      {state === null && error === null && (
        <>
          <div className="card">
            <h2>大模型接口（当前生效）</h2>
            <SkeletonTable rows={4} cols={5} />
          </div>
          <div className="card">
            <h2>修改</h2>
            <SkeletonLines rows={4} />
          </div>
        </>
      )}

      {state !== null && (
        <>
          <EffectiveCard model={state.model} items={state.items} />
          <EditCard state={state} onSaved={setState} />
          {/* 「本页存过的配置」那张表已并进上面一张（见 EffectiveCard 的注释）。
              但**表里可能还有别的行**（例如联网搜索下线后遗留的 `web_search.*`）——
              它们不再被读取，却也不该从这里消失得无影无踪。有才提示，没有就不占地方。 */}
          <ExtraKeys items={state.items} />
        </>
      )}

      {loading && state !== null && (
        <p className="dim" style={{ fontSize: '0.75rem' }}>刷新中…</p>
      )}
    </>
  );
}

// ── 当前生效 ────────────────────────────────────────────────────

const SOURCE_LABELS: Record<ConfigSource, string> = {
  table: '本页设置',
  env: '.env',
  default: '内置默认',
};

const SECRET_SOURCE_LABELS: Record<ConfigSecretSource, string> = {
  ...SOURCE_LABELS,
  none: '未设置',
};

/** 来源徽标。`none`（密钥没配）用错误色 —— 它会直接让能力不可用。 */
function SourcePill({ source, secret = false }: { source: ConfigSource | ConfigSecretSource; secret?: boolean }) {
  const labels: Record<string, string> = secret ? SECRET_SOURCE_LABELS : SOURCE_LABELS;
  const label = labels[source] ?? source;
  return (
    <span className={source === 'none' ? 'pill err' : 'pill'} title={`这一项的值取自：${label}`}>
      来源：{label}
    </span>
  );
}

/** 目录外的手填模型名 → 这一小句提示。**不假装元数据是准的**。 */
function EstimateNote({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="dim" style={{ display: 'block', fontSize: '0.71875rem' }}>
      不在 pi-ai 目录里：上下文窗口 / 输出上限 / 费用按模板估算，可能不准。
    </span>
  );
}

/**
 * 「当前生效」这张表。
 *
 * 【2026-10-17：与原来那张「本页存过的配置」**合并成一张**】
 *   两张表说的是同一批配置项，只是投影不同：一张答"现在是什么、从哪一层来的"，
 *   另一张答"表里存了什么、谁什么时候存的"。管理员要同时对照着看才能回答
 *   "这一项是谁改的"，而两份投影并排放着，迟早会出现一处更新、另一处忘了改。
 *   现在一张表五列，`修改人 / 修改时间`从 `items` 里按 key 取（只有来源是
 *   `table` 的项才有 —— 来自 `.env` 与内置默认的值，这两列本来就无话可说）。
 *
 * 【为什么不是服务端合成一个类型】`items` 是"表里那一行"的原样，`model` 是
 *   "解析后的生效值"，两者的权威来源不同（前者是数据，后者是解析逻辑）。
 *   合并成一个大 DTO 会让"谁是权威"这件事从类型上消失，而这一页的全部麻烦
 *   恰恰来自这两者不一致（表里没有、`.env` 里有）。在前端做这一次 join，
 *   两个来源各自的含义都还在。
 */
function EffectiveCard({
  model,
  items,
}: {
  model: EffectiveModelSettings;
  items: readonly SystemConfigEntry[];
}) {
  const byKey = new Map(items.map((it) => [it.key, it]));
  /** 某一项在表里的那一行（没有 = 这一项不来自本页）。 */
  const rowOf = (key: string) => byKey.get(key);

  return (
    <div className="card">
      <h2>
        大模型接口（当前生效）
        <span className="card-actions">
          <span className="dim" style={{ fontSize: '0.75rem' }}>
            留空保存即回落 <span className="mono">.env</span> 或内置默认
          </span>
        </span>
      </h2>

      {/* 可用性单独一行、写在最前面：管理员来这一页最可能想知道的就是
          "到底通不通"，不该让他自己去比对地址与 key 两项再得出结论。 */}
      {model.available ? (
        <div className="notice ok">
          <p className="notice-body" style={{ margin: 0 }}>
            大模型<b>可用</b>：对话用 <span className="mono">{model.chatModel}</span>， 整理数据集用{' '}
            <span className="mono">{model.reasonerModel}</span>，请求发往{' '}
            <span className="mono">{model.baseUrl}</span>。
          </p>
        </div>
      ) : (
        <div className="notice warn">
          <p className="notice-body" style={{ margin: 0 }}>
            <b>大模型当前不可用</b>：没有 API key。提问与「整理数据集」都会在做任何事之前停下，
            并提示先来这里配置。
          </p>
          <p className="notice-foot">
            在下面填一把 key，或者让运维在 <span className="mono">.env</span> 里配{' '}
            <span className="mono">DEEPSEEK_API_KEY</span>。
          </p>
        </div>
      )}

      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 110 }}>项</th>
            <th>当前生效值</th>
            <th style={{ width: 110 }}>取自</th>
            <th style={{ width: 120 }}>最近修改人</th>
            <th style={{ width: 150 }}>修改时间</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">接口地址</th>
            <td className="mono table-value">{model.baseUrl}</td>
            <td><SourcePill source={model.baseUrlSource} /></td>
            <StoredCells source={model.baseUrlSource} row={rowOf(MODEL_CONFIG_KEYS.baseUrl)} />
          </tr>
          <tr>
            <th scope="row">对话模型</th>
            <td className="mono table-value">
              {model.chatModel}
              <EstimateNote show={!model.chatInCatalog} />
            </td>
            <td><SourcePill source={model.chatModelSource} /></td>
            <StoredCells source={model.chatModelSource} row={rowOf(MODEL_CONFIG_KEYS.chat)} />
          </tr>
          <tr>
            <th scope="row">推理模型</th>
            <td className="mono table-value">
              {model.reasonerModel}
              <EstimateNote show={!model.reasonerInCatalog} />
            </td>
            <td><SourcePill source={model.reasonerModelSource} /></td>
            <StoredCells source={model.reasonerModelSource} row={rowOf(MODEL_CONFIG_KEYS.reasoner)} />
          </tr>
          <tr>
            <th scope="row">API key</th>
            {/* 密钥**没有值可显示**，永远只说"有 / 没有"以及它是从哪儿来的。 */}
            <td className="dim">{model.apiKeySource === 'none' ? '未设置' : '已设置（不回显）'}</td>
            <td><SourcePill source={model.apiKeySource} secret /></td>
            <StoredCells source={model.apiKeySource} row={rowOf(MODEL_CONFIG_KEYS.apiKey)} />
          </tr>
        </tbody>
      </table>

      <p className="dim" style={{ fontSize: '0.75rem', margin: '10px 0 0' }}>
        密钥只以"填了没填"的形式显示 —— 任何人都看不到它的明文，包括管理员。
        想知道当前用的是哪一把，看它存在哪一层（本页 / <span className="mono">.env</span>）。
      </p>
    </div>
  );
}

// ── 修改 ────────────────────────────────────────────────────────

interface FormState {
  baseUrl: string;
  chat: string;
  reasoner: string;
  /** 新 key。**初值永远是空串** —— 原值不会回到浏览器，空 = 不改。 */
  apiKey: string;
  /** 勾上 = 把表里存的那把 key 清掉（回落到 `.env`）。只有表里存了才显示这个勾选。 */
  clearKey: boolean;
}

/** 测试连接的三态。改任何一个字段、或保存成功，都回到 `idle`。 */
type TestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; view: TestModelConnectionResponse };

function readRaw(items: readonly SystemConfigEntry[], key: string): string {
  const item = items.find((i) => i.key === key);
  // 密钥那一行的 `value` 恒为 null（服务端不回显），所以这里对密钥只有"有没有"。
  return item?.value ?? '';
}

function formFrom(state: SystemConfigResponse): FormState {
  return {
    baseUrl: readRaw(state.items, MODEL_CONFIG_KEYS.baseUrl),
    chat: readRaw(state.items, MODEL_CONFIG_KEYS.chat),
    reasoner: readRaw(state.items, MODEL_CONFIG_KEYS.reasoner),
    apiKey: '',
    clearKey: false,
  };
}

function KeySavedInTable(state: SystemConfigResponse): boolean {
  const item = state.items.find((i) => i.key === MODEL_CONFIG_KEYS.apiKey);
  return item !== undefined && item.isSet;
}

/** 测试结论 → 该用哪种颜色的提示条。 */
function testTone(view: TestModelConnectionResponse): 'ok' | 'warn' | 'err' {
  if (view.ok) return 'ok';
  return view.kind === 'not_configured' ? 'warn' : 'err';
}

function EditCard({
  state,
  onSaved,
}: {
  state: SystemConfigResponse;
  onSaved: (next: SystemConfigResponse) => void;
}) {
  const [form, setForm] = useState<FormState>(() => formFrom(state));
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 服务端的那一份也当初值用：保存成功后表单要跟着回到"新初值"，
  // 否则"没改的项"会停在旧值上，下一次提交会把它们当成改动发回去。
  const initial = formFrom(state);
  const keyInTable = KeySavedInTable(state);

  const set = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setNotice(null);
    // 用户一动手，上一条「不能这么填」就过期了；留着会让人以为新值也有问题。
    setFormError(null);
    // 也一样：字段变了，上一次的测试结论就不再对应现在填的东西。
    setTest({ kind: 'idle' });
  };

  /**
   * 有没有和初值不同的字段。**只看"变没变"，不判合法**。
   *
   * ⚠ 「有没有改动」与「改动能不能提交」必须是两件事。曾经这里图省事复用了
   *   `buildPatch()`，而它在某一项不合法时**返回一个错误字符串** —— 于是：
   *   用户填错一个值 → 按钮直接禁用 → 那条中文提示**永远显示不出来**
   *   （提示是在提交时展示的，而提交按钮点不了）。更糟的是，此时改别的项
   *   也一起被冻住 —— 而页面上没有任何解释。
   */
  function isDirty(form: FormState, initial: FormState): boolean {
    return (
      form.baseUrl !== initial.baseUrl ||
      form.chat !== initial.chat ||
      form.reasoner !== initial.reasoner ||
      // 新 key 的初值恒为空串，所以"非空"就是改动。
      form.apiKey !== '' ||
      // 初值恒为 false，勾上就是改动。
      form.clearKey
    );
  }

  /** 与初值逐项对比，只把变了的挑出来。 */
  function buildPatch(): UpdateSystemConfigRequest | string {
    const patch: UpdateSystemConfigRequest = {};

    if (form.baseUrl !== initial.baseUrl) patch.baseUrl = form.baseUrl;
    if (form.chat !== initial.chat) patch.chat = form.chat;
    if (form.reasoner !== initial.reasoner) patch.reasoner = form.reasoner;

    if (form.clearKey) {
      if (form.apiKey !== '') {
        return '「填一把新 key」与「清掉已保存的 key」只能选一个。';
      }
      patch.apiKey = '';
    } else if (form.apiKey !== '') {
      patch.apiKey = form.apiKey;
    }

    return patch;
  }

  /**
   * 「测试连接」要发的请求体：**只放非空的表单字段**，其余由服务端逐字段
   * 兜底到生效值。
   *
   * 【为什么不能直接把表单整体发过去】"填了但还没保存"时，空着的字段意味着
   *   "不改它"，服务端应当拿生效值 —— 而密钥框**永远是空的**（原值不回显），
   *   整体发过去就会变成"没有 key"，每次点测试都误报"未配置"。
   */
  function buildTestBody(): Record<string, string> {
    const body: Record<string, string> = {};
    if (form.baseUrl.trim() !== '') body['baseUrl'] = form.baseUrl;
    if (form.chat.trim() !== '') body['chatModel'] = form.chat;
    if (!form.clearKey && form.apiKey !== '') body['apiKey'] = form.apiKey;
    return body;
  }

  async function onTest() {
    setFormError(null);
    setError(null);
    setNotice(null);
    setTest({ kind: 'running' });
    try {
      const view = await apiPost<TestModelConnectionResponse>(
        '/api/v1/system-config/test-connection',
        buildTestBody(),
      );
      setTest({ kind: 'done', view });
    } catch (err) {
      setTest({ kind: 'idle' });
      setError(toApiError(err));
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const patch = buildPatch();
    if (typeof patch === 'string') {
      setFormError(patch);
      setError(null);
      return;
    }
    if (Object.keys(patch).length === 0) {
      setFormError('没有改动。');
      setError(null);
      return;
    }

    setFormError(null);
    setError(null);
    setNotice(null);
    setTest({ kind: 'idle' });
    setBusy(true);
    try {
      const next = await apiPatch<SystemConfigResponse>('/api/v1/system-config', patch);
      onSaved(next);
      setForm(formFrom(next));
      setNotice(
        `已保存：对话用 ${next.model.chatModel}，整理数据集用 ${next.model.reasonerModel}` +
          `（${next.model.available ? '可用' : '没有 key，暂不可用'}）。`,
      );
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  const dirty = isDirty(form, initial);
  const catalog: readonly ModelCatalogEntry[] = state.model.catalog;

  return (
    <div className="card">
      <h2>修改</h2>
      {/* noValidate：我们挂在 onSubmit 上的校验才是唯一口径，别让浏览器的英文气泡
          抢在前面（它对 type=number 的 min/max 会在 submit 之前拦下）。 */}
      <form className="form-row" noValidate onSubmit={(e) => void onSubmit(e)}>
        <label className="field" style={{ flex: '2 1 300px' }}>
          <span>接口地址（留空 = 用内置默认）</span>
          <input
            type="text"
            className="mono"
            value={form.baseUrl}
            placeholder={state.model.baseUrl}
            onChange={(e) => set('baseUrl', e.target.value)}
          />
        </label>

        {/* 两个模型名：原生 `<input list>` + `<datalist>` 同时满足"下拉选"与"可手填"，
            零新依赖。选项由服务端下发的 catalog 提供 —— 前端不抄一份模型名单，
            否则 pi-ai 目录变了这里就成了假的。 */}
        <label className="field" style={{ flex: '1 1 200px' }}>
          <span>对话模型（提问用）</span>
          <input
            type="text"
            className="mono"
            list="model-catalog"
            value={form.chat}
            placeholder={state.model.chatModel}
            onChange={(e) => set('chat', e.target.value)}
          />
        </label>

        <label className="field" style={{ flex: '1 1 200px' }}>
          <span>推理模型（整理数据集用）</span>
          <input
            type="text"
            className="mono"
            list="model-catalog"
            value={form.reasoner}
            placeholder={state.model.reasonerModel}
            onChange={(e) => set('reasoner', e.target.value)}
          />
        </label>

        <datalist id="model-catalog">
          {catalog.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}（上下文 {m.contextWindow.toLocaleString()} tokens）
            </option>
          ))}
        </datalist>

        <label className="field" style={{ flex: '2 1 260px' }}>
          <span>API key{keyInTable ? '（已保存，不回显）' : ''}</span>
          <input
            type="password"
            value={form.apiKey}
            placeholder={state.model.apiKeySource === 'none' ? '留空 = 不修改' : '已设置。留空 = 不修改'}
            autoComplete="off"
            disabled={form.clearKey}
            onChange={(e) => set('apiKey', e.target.value)}
          />
        </label>

        <button type="submit" disabled={busy || testing || !dirty}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy || testing}
          onClick={() => void onTest()}
        >
          {testing ? '测试中…' : '测试连接'}
        </button>
      </form>

      {keyInTable && (
        <label className="dim" style={{ display: 'block', fontSize: '0.8125rem', margin: '8px 0 0' }}>
          <input
            type="checkbox"
            checked={form.clearKey}
            onChange={(e) => set('clearKey', e.target.checked)}
          />{' '}
          清掉本页保存的 key（回落到 <span className="mono">.env</span> 里那一把；
          <span className="mono">.env</span> 里也没有就变成"不可用"）
        </label>
      )}

      {test.kind === 'done' && (
        <div className={`notice ${testTone(test.view)}`} style={{ marginTop: 10 }}>
          <p className="notice-body" style={{ margin: 0 }}>
            {test.view.message}
            {test.view.httpStatus === null ? '' : `（HTTP ${test.view.httpStatus}）`}
          </p>
          <p className="notice-foot">
            实测的是<b>对话模型</b>（<span className="mono">{test.view.chatModel}</span>）
            发往 <span className="mono">{test.view.baseUrl}</span> 的一次极小请求（4 个 token 上限），
            耗时 {test.view.elapsedMs}ms。
            {test.view.chatInCatalog ? '' : ' 这个模型名不在目录里，元数据按模板估算。'}
          </p>
        </div>
      )}
      {test.kind === 'running' && (
        <p className="dim" style={{ fontSize: '0.75rem', margin: '8px 0 0' }}>
          正在向这个地址发一次真实请求…
        </p>
      )}

      <p className="dim" style={{ fontSize: '0.75rem', margin: '8px 0 0' }}>
        只提交<b>改动过</b>的项，没碰的不会重写（所以没必要为了"保持原样"把值再填一遍）。
        把某一项清空 = 让取值回落到下一层。地址要带协议（如{' '}
        <span className="mono">https://api.deepseek.com</span>）；指向第三方中转站时，
        模型名按那家的写法填，不在上面下拉里的直接手输即可。
        <br />
        「测试连接」会向上面这个地址发一次<b>真实请求</b>，也就是会走一次你付费的调用；
        它只测对话模型。
      </p>

      {formError !== null && (
        <div className="notice err"><p className="notice-body" style={{ margin: 0 }}>{formError}</p></div>
      )}
      {error !== null && <ErrorNotice error={error} onRetry={() => setError(null)} />}
      {notice !== null && (
        <div className="notice ok"><p className="notice-body" style={{ margin: 0 }}>{notice}</p></div>
      )}
    </div>
  );
}

// ── 表里存了什么 ────────────────────────────────────────────────

/**
 * 「最近修改人 / 修改时间」两格。
 *
 * 【为什么是一对、且要一个组件】它们**同生同死**：只有这一项真的来自本页
 *   （`source === 'table'`）时才显示，其余情况两格都得说同一句"不在本页" ——
 *   分两处写就会出现"一个人有、时间没有"这种半截行。
 */
function StoredCells({
  source,
  row,
}: {
  source: ConfigSource | ConfigSecretSource;
  row: SystemConfigEntry | undefined;
}) {
  if (source !== 'table' || row === undefined) {
    return (
      <>
        <td className="dim">—</td>
        <td className="dim">—</td>
      </>
    );
  }
  return (
    <>
      {/* null 只有一种解释：不是网页改的（部署脚本 / CI 直接写库）——
          这类写入没有登录用户，`updated_by` 就留空。界面**不能**把这种情况
          显示成同一句"没人改过"（见 shared 里 `updatedByName` 的注释）。 */}
      <td>{row.updatedByName ?? <span className="dim">命令行 / 脚本</span>}</td>
      <td className="mono" style={{ fontSize: '0.71875rem' }}>
        {row.updatedAt === null ? '—' : fmtDateTime(row.updatedAt)}
      </td>
    </>
  );
}

/** 四项之外的遗留行（有才提示）。 */
function ExtraKeys({ items }: { items: readonly SystemConfigEntry[] }) {
  const known = new Set<string>(Object.values(MODEL_CONFIG_KEYS));
  const extra = items.filter((it) => !known.has(it.key));
  if (extra.length === 0) return null;

  return (
    <p className="dim" style={{ fontSize: '0.75rem' }}>
      表里还有 {extra.length} 行不属于上面四项（
      {extra.map((it) => it.key).join('、')}）—— 它们不再被任何功能读取，
      留着只为"当初配过什么"有据可查。
    </p>
  );
}
