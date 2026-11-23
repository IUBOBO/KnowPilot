import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  MATERIAL_LABELS,
  MATERIALS,
  type DocumentSummary,
  type ListDocumentsResponse,
  type Material,
  type ReindexDocumentResponse,
  type UploadDocumentResponse,
} from '@knowpilot/shared';
import { apiGet, apiPost, apiPostForm, isAbort, toApiError, type ApiError } from '../api.ts';
import { DocumentTable, isStale } from '../components/DocumentTable.tsx';
import { DocumentParsingNotice } from '../components/DocumentParsingNotice.tsx';
import { describeDocumentParsing, describeParsingFailure, type DocumentParsing } from '../document-parsing.ts';
import { ConsentBar } from '../components/ConsentBar.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Modal } from '../components/Modal.tsx';
import { RefreshIcon } from '../components/icons.tsx';
import { SkeletonTable } from '../components/Skeleton.tsx';
import { useAuth } from '../auth.tsx';
import { RequirePermission } from '../components/RequirePermission.tsx';
import { useFocusTarget } from '../use-focus-target.ts';
import { NavGlyph } from '../nav-icons.tsx';

/** 一次重建批次的进度与结果。总数单独留着 —— 逐份把 id 从队列里摘掉的话，分母就没了。 */
interface ReindexProgress {
  total: number;
  done: number;
}

interface ReindexFailure {
  id: string;
  title: string;
  message?: string;
  parsing?: DocumentParsing;
}

interface ReindexResult {
  completed: readonly ReindexDocumentResponse[];
  failed: readonly ReindexFailure[];
}

/**
 * 上传侧云端告知的勾选确认（约束 4）。
 *
 * 【为什么不与提问侧共用同一个 key】
 *   两处的告知说的不是同一件事。提问侧出网的是"检索命中的片段"，
 *   上传侧要说清的是"这份文件会进知识库，而进库之后它就有可能在问答时被送出去"。
 *   共用 key 会让勾过其中一处的人以为另一处也确认过了。
 *
 * 【为什么带版本号】
 *   与提问侧同理：文案语义若变（出网范围、保存位置变了），旧版本记下的"已同意"
 *   不该再算数。改文案时把版本号加一。
 */
const UPLOAD_CONSENT_KEY = 'knowpilot.upload.consent.v1';

/**
 * 文档接入页：上传 + 列表。
 *
 * 上传结果会说明正文能否检索，并提醒用户哪些内容需要核对原件。
 */
export function DocumentsPage() {
  const [docs, setDocs] = useState<readonly DocumentSummary[] | null>(null);
  const [listError, setListError] = useState<ApiError | null>(null);

  /**
   * 列表按哪一类材料筛。来自**地址栏**（`?material=xxx`），不是组件 prop。
   *
   * 【为什么走地址栏】原先「文档与论文 / 经验与解题 / 流程与技术 / 实验室制度」
   *   是侧栏里四条独立入口，指向同一个组件、只是把类型锁死 —— 同一页被拆成四条，
   *   而 `MATERIALS` 里的第五类「知识点」反倒没有任何入口。
   *   合并成一页之后，筛选仍然必须能**收藏、能贴给别人、能按浏览器后退键**，
   *   所以它落在 URL 上；老地址（/sop 等）也只要跳到对应的 URL 即可（见 router.tsx）。
   */
  const [searchParams] = useSearchParams();
  const rawMaterial = searchParams.get('material');
  const listMaterial: Material | null =
    rawMaterial !== null && (MATERIALS as readonly string[]).includes(rawMaterial)
      ? (rawMaterial as Material)
      : null;

  // 上传表单里选的材料类型。与上面那个筛选是**两件事**：
  // 一个是"这份文件属于哪一类"，一个是"我现在在看哪一类"，不要合并。
  const [material, setMaterial] = useState<Material>('paper');
  const [uploading, setUploading] = useState(false);
  /** 「上传文档」弹窗是否展开（原先那张表单常驻在文档表格上方）。 */
  const [showUpload, setShowUpload] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<ApiError | null>(null);
  const [outcome, setOutcome] = useState<UploadDocumentResponse | null>(null);

  const [reindexing, setReindexing] = useState<ReindexProgress | null>(null);
  const [reindexResult, setReindexResult] = useState<ReindexResult | null>(null);

  const [consent, setConsent] = useState(
    () => localStorage.getItem(UPLOAD_CONSENT_KEY) === '1',
  );

  const fileRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  // 重建进行中的硬闸门。不能只靠 `reindexing !== null` 判断：
  // 那是渲染时的快照，而双击的两次事件之间 React 才刚把状态刷下去，
  // 第二下有可能读到还没更新的旧值，于是同一批跑两遍（向量白算一次）。
  const runningRef = useRef(false);

  // 重建索引要 `material.manage`（三个角色里只有 admin 有）。服务端本来就拦，
  // 但按钮对所有人显示的话，成员点下去只拿到一句 403 —— 界面得先说实话。
  const { can } = useAuth();
  const canReindex = can('material.manage');

  const loadList = useCallback(async (signal?: AbortSignal) => {
    try {
      // 过滤放到后端做，不在前端筛：前端筛的前提是"先取回全部再挑"，
      // 而列表本身有条数上限 —— 一旦总量超过上限，某个材料类型可能一条都取不回来，
      // 页面显示成空，却没有任何迹象说明是被截断的。
      const path =
        listMaterial !== null
          ? `/api/v1/documents?material=${listMaterial}`
          : '/api/v1/documents';
      const body = await apiGet<ListDocumentsResponse>(path, signal);
      setDocs(body.items);
      setListError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setListError(toApiError(err));
    }
  }, [listMaterial]);

  useEffect(() => {
    const ac = new AbortController();
    void loadList(ac.signal);
    return () => ac.abort();
  }, [loadList]);

  // ⌘K 搜到某份文档、而它没有可打开的块时，会带 `?material=…&focus=…`
  // 回到这一页；定位发生在对应标签页的数据加载之后。
  useFocusTarget('document-', docs !== null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (file === undefined) {
      setFormError('还没有选择文件。');
      return;
    }
    // 界面上按钮已经是禁用的，这里是第二道。禁用只是不给点，
    // 而"回车提交表单"这类路径不会经过按钮的 disabled。
    if (!consent) {
      setFormError('请先勾选下方的确认。');
      return;
    }

    setFormError(null);
    setUploadError(null);
    setOutcome(null);
    setUploading(true);

    const form = new FormData();
    form.append('file', file);
    form.append('material', material);
    // multipart 的字段都是字符串，后端按字面量 'true' 比对。
    form.append('consentConfirmed', 'true');
    const title = titleRef.current?.value.trim() ?? '';
    if (title !== '') form.append('title', title);

    try {
      setOutcome(await apiPostForm<UploadDocumentResponse>('/api/v1/documents', form));
      // 传完立刻清空输入，否则用户会怀疑"到底传上去没有"而再点一次。
      if (fileRef.current !== null) fileRef.current.value = '';
      if (titleRef.current !== null) titleRef.current.value = '';
      // 成功才关弹窗；失败**不关** —— 错误提示就在弹窗里，关掉等于让用户重选一次文件。
      setShowUpload(false);
      await loadList();
    } catch (err) {
      setUploadError(toApiError(err));
    } finally {
      setUploading(false);
    }
  }

  /**
   * 勾选状态变化。只记"同意"，不记"取消" ——
   * 与提问侧同一条判断：记住"他拒绝过"没有任何用处，
   * 而那会让下次进来时的默认状态变得难以解释。
   */
  function onConsentChange(checked: boolean) {
    setConsent(checked);
    if (checked) localStorage.setItem(UPLOAD_CONSENT_KEY, '1');
    else localStorage.removeItem(UPLOAD_CONSENT_KEY);
  }

  /**
   * 重建一批文档的索引。
   *
   * 【为什么在前端循环，而不是后端给一个"全部重建"接口】
   *   连调 N 次本接口，每次的成败都是分开的：一份文件损坏不会让整批在建到它
   *   那里时中断，用户也能看到"还剩几份"。后端一个批处理接口要么只返回笼统的
   *   总结果（失败了说不清是哪份），要么就得引入后台任务与进度轮询 ——
   *   对一个几十份文档的库是明显过度设计。
   *
   * 【为什么一份失败不 break】
   *   继续往下跑。因为失败的最常见原因是"这份的原件不在磁盘上"这种**单份**问题，
   *   让它把后面几十份一起拖死没有道理。每条失败原因单独记下来最后一起报 ——
   *   只保留最后一条的话，前面的失败会彻底消失，那正是最难排查的一类错。
   */
  async function runReindex(ids: readonly string[]) {
    if (ids.length === 0 || runningRef.current) return;
    runningRef.current = true;
    setReindexResult(null);
    setReindexing({ total: ids.length, done: 0 });

    // 标题先取下来：重建完会 loadList 刷新，到时报错时再想去查标题，
    // 列表已经是新的了，而用户需要知道"是哪一份失败了"。
    const titles = new Map((docs ?? []).map((d) => [d.id, d.title]));

    const failed: ReindexFailure[] = [];
    const completed: ReindexDocumentResponse[] = [];
    try {
      for (const id of ids) {
        try {
          const response = await apiPost<ReindexDocumentResponse>(
            `/api/v1/documents/${encodeURIComponent(id)}/reindex`,
            {},
          );
          if (response.document.status === 'ready' && response.ingest.chunkCount > 0) {
            completed.push(response);
          } else {
            failed.push({ id, title: response.document.title, parsing: describeDocumentParsing(response.document, response.ingest) });
          }
        } catch (err) {
          failed.push({
            id,
            title: titles.get(id) ?? id,
            message: describeParsingFailure(toApiError(err), 'reindex'),
          });
        }
        setReindexing((prev) => (prev === null ? null : { total: prev.total, done: prev.done + 1 }));
      }
    } finally {
      runningRef.current = false;
      setReindexing(null);
    }

    setReindexResult({ completed, failed });
    await loadList();
  }

  // 只对当前这一屏看得见的文档算。这是筛选后的列表，所以"重建过时的 N 份"
  // 指的是"这一屏里的 N 份" —— 文案里没写"全部"正是因为这一点。
  const stale = docs === null ? [] : docs.filter(isStale);
  const busy = reindexing !== null;

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <div className="page-title"><span className="page-title-icon"><NavGlyph name="docs" size={32} /></span><h1>知识库</h1></div>
          <p className="lead">管理论文、经验、流程与制度文档，上传后自动切块建索引。</p>
        </div>
        <div className="page-head-actions">
          {/* 全页**只留这一个**刷新（原先列表卡片右上角还有一个）。 */}
          <button type="button" className="link-btn" disabled={busy} onClick={() => void loadList()}>
            <RefreshIcon />
            刷新
          </button>
          <button type="button" className="btn-primary" onClick={() => setShowUpload(true)}>
            + 上传文档
          </button>
        </div>
      </div>

      {/* 材料类型标签页。合并之前，其中的四类曾是侧栏里的四条独立入口
          （第五类「知识点」反倒一个入口都没有）—— 同一份列表被拆成四条，
          看不出它们其实是一回事。标签页让"我在看哪一类"一眼可见，
          也顺手把漏掉的那一类补上。
          做成 <Link> 而不是按钮：地址要能收藏、能贴给别人、能按后退键回来。 */}
      <nav className="tabs" aria-label="按材料类型筛选">
        <Link to="/docs" className={listMaterial === null ? 'tab active' : 'tab'}>
          全部
        </Link>
        {MATERIALS.map((m) => (
          <Link
            key={m}
            to={`/docs?material=${m}`}
            className={listMaterial === m ? 'tab active' : 'tab'}
          >
            {MATERIAL_LABELS[m]}
          </Link>
        ))}
      </nav>

      {/* 上传收进弹窗（「界面整理-new」§六.4）：这一页 90% 的使用是"翻已有的文档"，
          而那张表单原先把文档表格挤到了下半屏。同意条跟着一起进来 ——
          它说的正是"上传这件事会把内容带到哪"，属于这张表单，不属于这一页。 */}
      <Modal
        open={showUpload}
        initialFocusTo={fileRef}
        wide
        title="上传文档"
        onClose={() => setShowUpload(false)}
        footer={
          <>
            <button type="button" className="link-btn" disabled={uploading} onClick={() => setShowUpload(false)}>
              取消
            </button>
            <button
              type="submit"
              form="doc-upload"
              className="btn-primary"
              disabled={uploading || !consent}
            >
              {uploading ? '上传解析中…' : '上传并建索引'}
            </button>
          </>
        }
      >
        {/* 常驻告知：不论勾没勾过都显示。
            只勾一次就永久记住的话，换了台机器的人、或者看到同事屏幕的人，
            完全看不到"这份东西会去哪"这件事。
            文案刻意不照抄提问页那一版 —— 提问时出网的是"检索命中的片段"，
            上传时要说清的是"这份文件会进知识库，而进库之后它就有可能在问答时被送出去"，
            两件事的主语不同，照抄会让人以为只有提问才出网。

            ⚠️ "上传这一步不会把内容送出去"这句话有前提：上传链路上的解析、OCR、
            切块、向量化目前**全部在本地**（BGE-M3 是本地 ONNX，OCR 也是本地 ONNX）。
            将来若在这条链路上引入任何云端调用（云端 OCR、云端摘要等），
            这句话必须改，并且 UPLOAD_CONSENT_KEY 的版本号要加一 ——
            否则用户看到的仍是"本地完成"，而实际已经出网。 */}
        <ConsentBar
          checked={consent}
          onCheckedChange={onConsentChange}
          pending="这份文件入库后，问答命中的片段会发往云端模型"
          granted="已授权：入库后命中的片段可能随问答发往 DeepSeek"
        >
          <p style={{ margin: 0 }}>
            文档保存在<b>本机</b>；解析、切块、向量化都在本地完成，上传这一步不会把内容送出去。
            <br />
            但入库之后，任何人在「知识问答」里提问时，<b>检索命中到的片段</b>会发送至云端模型（
            <b>DeepSeek</b>）处理，即离开实验室内部网络。
            <br />
            若文件是<b>投稿中的稿件</b>，或含未公开的数据与专利材料，请先确认期刊/会议的保密要求允许其内容进入本系统；已发表论文与公开制度无此顾虑。
          </p>
        </ConsentBar>

        <form id="doc-upload" className="form-row" onSubmit={(e) => void onSubmit(e)}>
          <label className="field">
            <span>材料类型</span>
            <select value={material} onChange={(e) => setMaterial(e.target.value as Material)}>
              {MATERIALS.map((m) => (
                <option key={m} value={m}>{MATERIAL_LABELS[m]}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>文件</span>
            <input ref={fileRef} type="file" accept=".pdf,.docx,.md,.txt" />
          </label>

          <label className="field">
            <span>标题（可留空）</span>
            <input ref={titleRef} type="text" placeholder="留空则用文件名" />
          </label>

          {/* 提交按钮在弹窗底部动作区（`form="doc-upload"`），不在这里。 */}
        </form>

        {/* 这几段落里的换行是**排版换行**，不是内容里的空格：JSX 会把它折成一个空格，
            中文句子中间于是多出一个空格（"50 MB。 解析到…"）。所以句子断在哪一行、
            要不要空格，得写成一行或显式用 {' '}。 */}
        <p className="dim" style={{ fontSize: '0.8125rem', margin: '10px 0 0' }}>
          支持 PDF / Word(.docx) / Markdown / 纯文本，单文件上限 50 MB。解析到建索引是同步完成的，
          一份论文通常 1–2 秒；没有文字层的扫描件会走 OCR，每页约 2 秒。
        </p>

        {formError !== null && <div className="notice err"><p className="notice-body">{formError}</p></div>}

        {uploadError !== null && (
          <div className="notice err" role="alert">
            <p className="notice-title">文档未能入库</p>
            <p className="notice-body">{describeParsingFailure(uploadError, 'upload')}</p>
          </div>
        )}
      </Modal>

      {/* 解析回执落在**页面上**（弹窗此时已经关上）—— 它说的是"这份文件被切成了多少块、
          有没有走 OCR"，是刚发生的一件事，用户要看得见。 */}
      {outcome !== null && <UploadOutcome outcome={outcome} />}

      <div className="card">
        <h2>
          已接入文档{docs !== null && `（${docs.length} 份）`}
          <span className="card-actions">
            {/* 刷新已移到页头（全页只留一个）。这里只留"重建过时的 N 份" ——
                那是**针对这批文档**的批量动作，跟着列表走才对。 */}
            {/* 拿不到权限时不是"没有这个功能"，而是"这份材料该重建、但得找人"——
                所以既要说清有几份过时，也要说清缺哪个权限。 */}
            <RequirePermission
              permission="material.manage"
              otherwise={
                stale.length > 0 ? (
                  <span className="dim" style={{ fontSize: '0.75rem' }}>
                    有 {stale.length} 份是按旧版规则切的。重建索引需要「材料管理」权限，请联系管理员。
                  </span>
                ) : null
              }
            >
              {stale.length > 0 && (
                <button
                  type="button"
                  className="link-btn"
                  disabled={busy}
                  onClick={() => void runReindex(stale.map((d) => d.id))}
                >
                  重建过时的 {stale.length} 份
                </button>
              )}
            </RequirePermission>
          </span>
        </h2>

        {listError !== null && <ErrorNotice error={listError} onRetry={() => void loadList()} />}

        {reindexing !== null && (
          <p className="dim" style={{ fontSize: '0.75rem', margin: '0 0 10px' }}>
            正在重建…（{reindexing.done} / {reindexing.total}）重建期间这些文档照常可搜，新块写好之后才整体替换。
          </p>
        )}

        {reindexResult !== null && <ReindexOutcome result={reindexResult} />}

        {/* 列数与真实表格一致：没有重建权限的人少一列「操作」，
            所以骨架也按 canReindex 给 7 或 8 列，否则表头宽度会跳一次。 */}
        {docs === null && listError === null && (
          <SkeletonTable rows={4} cols={canReindex ? 8 : 7} />
        )}
        {docs !== null && (
          <>
            <div className="docs-table-scroll"><DocumentTable
              items={docs}
              busy={busy}
              canReindex={canReindex}
              onReindex={(id) => void runReindex([id])}
              emptyAction={
                // 空态直接打开上传弹窗。弹窗初始焦点落在文件框，
                // 不自动打开系统文件选择器，保留用户的操作节奏。
                <button type="button" className="link-btn" onClick={() => setShowUpload(true)}>
                  上传第一份文档
                </button>
              }
            /></div>
            {/* 这段话解释的是「重建」这个动作的代价。拿不到权限的人没有这个动作，
                留着它只会让人以为"我能重建、只是没找到入口"。 */}
            {canReindex && docs.length > 0 && (
              <p className="dim" style={{ fontSize: '0.75rem', margin: '10px 0 0' }}>
                重建会按当前规则重新解析并切块，文档和上传时间不变。未变的原文片段保留原链接；变动片段的旧链接仍可查看历史原文，并会标明版本。
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ReindexOutcome({ result }: { result: ReindexResult }) {
  const hasFailed = result.failed.length > 0;
  const completed = result.completed.length;
  const shown = result.completed.filter(({ document, ingest }) => completed === 1 || ingest.warnings.length > 0 ||
    document.embeddedChunkCount < document.chunkCount);
  return (
    <div className={hasFailed ? 'notice warn' : 'notice ok'} role="status">
      <p className="notice-title">
        <span className={hasFailed ? 'pill warn' : 'pill ok'}>
          {hasFailed ? `${result.failed.length} 份没能重建` : '重建完成'}
        </span>{' '}
        <span className="dim">成功 {completed} 份</span>
      </p>
      {result.failed.length > 0 && (
        <ul className="notice-list">
          {result.failed.map(({ id, title, message, parsing }) => (
            <li key={id}>
              <b>{title}</b>{message !== undefined && <span>　{message}</span>}
              {parsing !== undefined && <DocumentParsingNotice parsing={parsing} />}
            </li>
          ))}
        </ul>
      )}
      {shown.length > 1 ? (
        <details className="doc-parse-details">
          <summary>查看 {shown.length} 份文档的解析结果</summary>
          {shown.map((item) => <ReindexReceipt key={item.document.id} item={item} />)}
        </details>
      ) : shown.map((item) => <ReindexReceipt key={item.document.id} item={item} />)}
    </div>
  );
}

function ReindexReceipt({ item }: { item: ReindexDocumentResponse }) {
  return (
    <div className="doc-parse-receipt">
      <strong>{item.document.title}</strong>
      <DocumentParsingNotice parsing={describeDocumentParsing(item.document, item.ingest)} />
    </div>
  );
}

function UploadOutcome({ outcome }: { outcome: UploadDocumentResponse }) {
  const { document: doc, duplicated, ingest } = outcome;
  const parsing = describeDocumentParsing(doc, ingest);
  return (
    <div className={`notice ${parsing.tone}`} role="status">
      <p className="notice-title">
        <span className={`pill ${parsing.tone}`}>{parsing.status}</span>{' '}
        <span className="dim">{doc.title}</span>
      </p>
      {duplicated && ingest === null && <p className="notice-body">已使用知识库里这份相同内容的文档。</p>}
      <DocumentParsingNotice parsing={parsing} />
    </div>
  );
}
