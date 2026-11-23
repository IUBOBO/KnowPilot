import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { PageTitle } from '../components/PageTitle.tsx';
import {
  type AbortUploadResponse,
  type CodeAsset,
  type CompleteUploadResponse,
  type CreateUploadResponse,
  type GetUploadResponse,
  type ListCodeAssetsResponse,
  type ListUploadsResponse,
  type PutChunkResponse,
  type UploadSession,
} from '@knowpilot/shared';
import { apiDelete, apiGet, apiPost, apiPutBlob, isAbort, toApiError, type ApiError } from '../api.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SkeletonList } from '../components/Skeleton.tsx';
import { useToast } from '../components/Toast.tsx';

/**
 * 数据集上传。
 *
 * 【这一页解决的是一件文档那套流程解决不了的事】
 *   文档走 multipart 一次 POST 完（上限 50 MB）。数据集是几十 GB：一次 POST
 *   要么网关超时、要么把整个文件读进内存、要么传了二十分钟断在 90% 只能从零再来。
 *   所以这里走分片，而且要能在断了、甚至**刷新了页面**之后接着传。
 *
 * 【续传到底靠什么成立】
 *   不靠浏览器记住任何东西 —— `File` 对象活不过一次刷新，localStorage 也只在
 *   同一台机器的同一个浏览器里有效。真正的事实是：**分片躺在服务器磁盘上**，
 *   而会话 id 由文件自身的特征（目标目录 + 文件名 + 总字节 + 最后修改时间）派生。
 *   于是把同一个文件再交一次，服务端算出同一个 id，回一句"我已经收到第 3、7、8 片"，
 *   界面从缺口接着传。这一页要做的只是把这件事说清楚、别自作聪明。
 *
 * 【为什么本页没有"已阅读并同意"的勾选】
 *   与 /docs 不同：勾选管的是"内容出不出实验室"（约束 4）。数据集不上传云端、
 *   不进知识库、不会被检索或送进模型 —— 它只是从本地搬到服务器的一块数据。
 *   给它加一道同意闸门会让人以为数据集也会外发，那是错的信息。（后端路由顶上同款注释。）
 *
 * 【已知限制，如实写在界面上】
 *   续传认的是"文件名 + 大小 + 最后修改时间"。同名同大小、且修改时间也恰好相同的
 *   两份不同文件，会被当成同一份接着传。要彻底避免得读一遍整个文件算哈希，
 *   10 GB 要几分钟，用户会以为卡死。这件事在界面上明说，不藏。
 */

/** 上次填的目标目录。只为了少打几个字，**不是**任何状态的事实来源。 */
const TARGET_KEY = 'knowpilot.upload.target.v1';

/**
 * 算速度用的滑动窗口（最近 N 片）。
 * 用"最近几片的总字节 / 总耗时"而不是两片之间的一瞬：单片的耗时受调度抖动影响大，
 * 而显示一个每秒都在 8 MB/s 和 200 MB/s 之间乱跳的数字，比不显示更让人怀疑。
 */
const SPEED_WINDOW = 8;

type Phase = 'creating' | 'uploading' | 'paused' | 'completing';

interface Progress {
  fileName: string;
  targetDir: string;
  receivedBytes: number;
  receivedCount: number;
  totalBytes: number;
  chunkCount: number;
  /** 这一次是不是接着上一次传的（来自服务端的 `resumed`） */
  resumed: boolean;
  phase: Phase;
  speedBps: number | null;
  etaMs: number | null;
}

/**
 * 一轮上传的运行态。**放在 ref 里，不放进 state** —— 分片循环每一步都要读它、
 * 写它，而 setState 是异步批处理的，循环里读到的会是上一次渲染的旧快照。
 * 真正要显示给用户的那几个数（已传字节、速度、剩余时间）再单独 setState 出去。
 */
interface Run {
  file: File;
  sessionId: string;
  chunkSize: number;
  chunkCount: number;
  totalBytes: number;
  /** 已收到的分片号，以服务端最近一次的答复为准 */
  received: Set<number>;
  /** 最近几片，用来算速度 */
  samples: { ms: number; bytes: number }[];
  paused: boolean;
  cancelled: boolean;
  /** 暂停时挂在这里，点「继续」时唤醒 */
  wake: (() => void) | null;
}

export function UploadPage() {
  const [pending, setPending] = useState<readonly UploadSession[] | null>(null);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [dataRoot, setDataRoot] = useState<string | null>(null);
  const [maxBytes, setMaxBytes] = useState<number | null>(null);
  const [assets, setAssets] = useState<readonly CodeAsset[]>([]);

  const saved = useRef(loadSavedTarget());
  const [field, setField] = useState(saved.current.field);
  const [dataset, setDataset] = useState(saved.current.dataset);

  const [progress, setProgress] = useState<Progress | null>(null);
  const [register, setRegister] = useState(true);

  /** 界面自己拦下来的问题（还没发请求），与 error（服务端的答复）分开。 */
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<CompleteUploadResponse | null>(null);

  /**
   * 「放弃」的回执走**轻提示**（S4），不再占清单顶上的一条常驻通告。
   * 上传成功那一件**不**走提示而是保留 `UploadOutcome` 面板 —— 那个面板
   * 要一口气说明落位路径、是否改名、解析情况，是"要接着读"的内容，不是一句话。
   */
  const toast = useToast();

  const [dragDepth, setDragDepth] = useState(0);
  /** 正在放弃的那一行（禁用它的按钮，避免连点两次） */
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [confirmRow, setConfirmRow] = useState<string | null>(null);

  const runRef = useRef<Run | null>(null);
  /**
   * 上一次还在跑的会话。**失败后不清空** —— 「重试」要靠它拿到那个 File
   * （File 只活在内存里，没有任何别的地方存得下它）。
   */
  const lastRef = useRef<{ file: File; sessionId: string; loop: Promise<void> } | null>(null);
  /** 点某一行的「继续」时，先记下是哪一行，等文件选择器回来再对账。 */
  const resumeRowRef = useRef<UploadSession | null>(null);

  const pickRef = useRef<HTMLInputElement>(null);
  const resumePickRef = useRef<HTMLInputElement>(null);

  const loadPending = useCallback(async (signal?: AbortSignal) => {
    try {
      const body = await apiGet<ListUploadsResponse>('/api/v1/uploads', signal);
      setPending(body.items);
      setDataRoot(showPath(body.dataRoot));
      setMaxBytes(body.maxBytes);
      setListError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setListError(toApiError(err));
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void loadPending(ac.signal);
    return () => ac.abort();
  }, [loadPending]);

  // 候选的领域 / 数据集名。**拿不到也不影响用** —— 两项本来就可以手填，
  // 所以这里失败就静默降级成"没有候选"，不摆一条错误出来吓人。
  useEffect(() => {
    const ac = new AbortController();
    apiGet<ListCodeAssetsResponse>('/api/v1/code-assets', ac.signal)
      .then((body) => setAssets(body.items))
      .catch(() => undefined);
    return () => ac.abort();
  }, []);

  /**
   * 拦住"文件掉在拖拽区外面"。浏览器默认会**导航到那个文件**，
   * 于是整页连同正在传的进度一起消失 —— 一次手滑丢掉二十分钟的传输。
   * 只 preventDefault，不接管上传：掉在区里才当作要传这个文件。
   */
  useEffect(() => {
    const stop = (event: Event) => event.preventDefault();
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  const dirIssue = validateSegment('领域', field) ?? validateSegment('数据集名', dataset);
  const targetDir = dirIssue === null ? `${field.trim()}/${dataset.trim()}` : null;

  const projects = useMemo(
    () => [...new Set(assets.map((a) => a.project).filter((p): p is string => p !== null))],
    [assets],
  );
  const names = useMemo(() => {
    const want = field.trim();
    return [...new Set(assets.filter((a) => want === '' || a.project === want).map((a) => a.name))];
  }, [assets, field]);

  const running = progress !== null;

  // ── 分片循环 ────────────────────────────────────────────────

  async function startUpload(file: File, dir: string): Promise<void> {
    if (runRef.current !== null) {
      setFormError('已经有一个文件在传了。等它传完，或者先暂停它。');
      return;
    }
    if (file.size === 0) {
      setFormError(`「${file.name}」是空文件（0 字节），没有可传的内容。`);
      return;
    }
    if (maxBytes !== null && file.size > maxBytes) {
      setFormError(
        `「${file.name}」有 ${fmtBytes(file.size)}，超过单文件上限 ${fmtBytes(maxBytes)}。` +
          `需要的话请让管理员调高 .env 里的 UPLOAD_MAX_BYTES。`,
      );
      return;
    }

    setFormError(null);
    setError(null);
    setResult(null);
    setProgress({
      fileName: file.name,
      targetDir: dir,
      receivedBytes: 0,
      receivedCount: 0,
      totalBytes: file.size,
      // 真正的分片数由服务端算（建会话后拿到），这里先填一个占位值，
      // 免得进度区在第一个请求回来之前显示成 NaN。
      chunkCount: 0,
      resumed: false,
      phase: 'creating',
      speedBps: null,
      etaMs: null,
    });

    let created: CreateUploadResponse;
    try {
      created = await apiPost<CreateUploadResponse>('/api/v1/uploads', {
        targetDir: dir,
        fileName: file.name,
        totalBytes: file.size,
        lastModifiedMs: file.lastModified,
      });
    } catch (err) {
      setProgress(null);
      setError(toApiError(err));
      return;
    }

    // 服务端认下了这两个数（分片大小由它定，客户端不许自己挑），记下来下次直接填。
    localStorage.setItem(TARGET_KEY, JSON.stringify({ field: field.trim(), dataset: dataset.trim() }));

    await runChunks(created.session, file, created.resumed);
  }

  /** 把 `session` 里"还缺哪些片"补齐，然后拼装落位。 */
  async function runChunks(session: UploadSession, file: File, resumed: boolean): Promise<void> {
    // 先把这一轮的 promise 挂到 lastRef 上再开跑：「放弃」要在叫停之后**等它
    // 真的退出**才能去删分片（见 abandonActive）。跑起来再挂就晚了 ——
    // 点放弃和第一个分片发出去之间没有 await，用户完全可能赶在挂上之前点。
    const loop = pump(session, file, resumed);
    lastRef.current = { file, sessionId: session.id, loop };
    await loop;
  }

  /** 分片循环本体。**不抛**：成败都落在这几处 setState 上，调用方无需 try。 */
  async function pump(session: UploadSession, file: File, resumed: boolean): Promise<void> {
    const run: Run = {
      file,
      sessionId: session.id,
      chunkSize: session.chunkSize,
      chunkCount: session.chunkCount,
      totalBytes: session.totalBytes,
      received: new Set(session.received),
      samples: [],
      paused: false,
      cancelled: false,
      wake: null,
    };
    runRef.current = run;

    setProgress({
      fileName: session.fileName,
      targetDir: session.targetDir,
      receivedBytes: session.receivedBytes,
      receivedCount: session.received.length,
      totalBytes: session.totalBytes,
      chunkCount: session.chunkCount,
      resumed,
      phase: 'uploading',
      speedBps: null,
      etaMs: null,
    });

    try {
      for (let index = 0; index < run.chunkCount; index += 1) {
        if (run.cancelled) return;
        if (run.received.has(index)) continue;
        await waitIfPaused(run);
        if (run.cancelled) return;

        const start = index * run.chunkSize;
        const end = Math.min(start + run.chunkSize, run.totalBytes);
        const startedAt = performance.now();
        // 一片一整次请求：顺序发，不并发。并发能把高延迟链路的吞吐拉上去，
        // 但它会让"暂停"和"失败重试"变成"此刻有 N 个请求在飞、落到哪一片说不准"。
        // 这一版最要紧的是把续传协议走对，吞吐的账留到有实测瓶颈时再算。
        const body = await apiPutBlob<PutChunkResponse>(
          `/api/v1/uploads/${run.sessionId}/chunks/${index}`,
          file.slice(start, end),
        );
        const ms = performance.now() - startedAt;

        run.received = new Set(body.received);
        pushSample(run, { ms, bytes: end - start });
        const next = {
          receivedBytes: body.receivedBytes,
          receivedCount: body.received.length,
          ...speedOf(run, run.totalBytes - body.receivedBytes),
        };
        setProgress((prev) => (prev === null ? null : { ...prev, ...next }));
      }

      setProgress((prev) => (prev === null ? null : { ...prev, phase: 'completing', speedBps: null, etaMs: null }));
      const done = await apiPost<CompleteUploadResponse>(
        `/api/v1/uploads/${run.sessionId}/complete`,
        { register },
      );
      lastRef.current = null;
      setProgress(null);
      setResult(done);
      await loadPending();
    } catch (err) {
      // 用户点了「放弃」：这一轮的任务是被取消，不是失败，不摆错误。
      if (run.cancelled) return;
      setError(toApiError(err));
      setProgress((prev) => (prev === null ? null : { ...prev, phase: 'paused', speedBps: null, etaMs: null }));
    } finally {
      runRef.current = null;
    }
  }

  /**
   * 失败之后重试。
   *
   * **先问服务端收到了哪些片，再接着传** —— 上一次失败的那一片有可能其实已经
   * 落盘了，只是答复没回到浏览器。凭本地记的那份继续传，会把一片重传，
   * 而重传虽然无害（覆盖同一个文件名），真正的问题是本地那份记录已经不可信了。
   */
  async function retry(): Promise<void> {
    const last = lastRef.current;
    if (last === null) return;
    setError(null);
    setFormError(null);
    setProgress((prev) => (prev === null ? null : { ...prev, phase: 'creating' }));
    try {
      const body = await apiGet<GetUploadResponse>(`/api/v1/uploads/${last.sessionId}`);
      await runChunks(body.session, last.file, body.session.receivedBytes > 0);
    } catch (err) {
      setProgress((prev) => (prev === null ? null : { ...prev, phase: 'paused' }));
      setError(toApiError(err));
    }
  }

  function pause(): void {
    const run = runRef.current;
    if (run === null) return;
    run.paused = true;
    setProgress((prev) => (prev === null ? null : { ...prev, phase: 'paused', speedBps: null, etaMs: null }));
  }

  function resume(): void {
    const run = runRef.current;
    if (run === null) return;
    run.paused = false;
    setProgress((prev) => (prev === null ? null : { ...prev, phase: 'uploading' }));
    const wake = run.wake;
    run.wake = null;
    if (wake !== null) wake();
  }

  /**
   * 放弃当前这一轮：先把循环叫停**并等它真的退出**，再去删服务器上的分片。
   * 反过来的话，在飞的那一片会在 `rm -rf` 之后才写进磁盘，
   * 于是留下一个属于已放弃会话的孤儿分片 —— 而它的目录再也没人认领。
   * 已经传上去的片不删（那是几十 GB 的进度），只把这次会话标成放弃。
   */
  async function abandonActive(): Promise<void> {
    const last = lastRef.current;
    if (last === null) return;
    const run = runRef.current;
    if (run !== null) {
      run.cancelled = true;
      const wake = run.wake;
      run.wake = null;
      if (wake !== null) wake();
    }
    await last.loop.catch(() => undefined);
    await discard(last.sessionId);
    lastRef.current = null;
    setProgress(null);
  }

  /** 放弃一个会话（当前这一轮或清单里的某一条），并丢掉服务器上已收到的分片。 */
  async function discard(sessionId: string): Promise<void> {
    setError(null);
    try {
      const body = await apiDelete<AbortUploadResponse>(`/api/v1/uploads/${sessionId}`);
      toast.ok(
        `已放弃「${body.aborted.fileName}」，服务器上已收到的 ${body.aborted.discardedChunks} 片已删除。`,
      );
    } catch (err) {
      setError(toApiError(err));
    } finally {
      await loadPending();
    }
  }

  /** 清单里某一条的「放弃」：二次确认之后才发请求（它会删掉服务器上的分片）。 */
  async function discardRow(row: UploadSession): Promise<void> {
    setBusyRow(row.id);
    await discard(row.id);
    setBusyRow(null);
    setConfirmRow(null);
  }

  // ── 选文件 ─────────────────────────────────────────────────

  function onPick(event: ChangeEvent<HTMLInputElement>): void {
    const input = event.target;
    const file = input.files?.[0];
    // 清空，否则"再选一次同一个文件"不会触发 change（值没变）。
    input.value = '';
    if (file === undefined) return;
    if (targetDir === null) {
      setFormError(
        `请先填好「领域」和「数据集名」——文件落到服务器的哪个目录，取决于这两项。${dirIssue ?? ''}`,
      );
      return;
    }
    void startUpload(file, targetDir);
  }

  /**
   * 清单里某一行的「继续」。
   *
   * 先在本地对一次账（文件名 + 大小），对不上就直接说清楚，**不发请求**：
   * 服务端算出的会话 id 若和这一行不同，那不是"接着传"，而是"新开了一次上传"，
   * 而用户点的是「继续」。把这个分叉摆到用户面前，比让他事后在清单里
   * 看到两条同样名字的未完成会话要好。
   */
  function onResumePick(event: ChangeEvent<HTMLInputElement>): void {
    const input = event.target;
    const file = input.files?.[0];
    const row = resumeRowRef.current;
    input.value = '';
    resumeRowRef.current = null;
    if (file === undefined || row === null) return;

    if (file.name !== row.fileName || file.size !== row.totalBytes) {
      setFormError(
        `选的文件和服务器上记的那一份对不上：服务器上是「${row.fileName}」（${fmtBytes(row.totalBytes)}），` +
          `你选的是「${file.name}」（${fmtBytes(file.size)}）。请选原来那一份。` +
          `如果你就是想传这一份新的，把它拖到上面的框里即可。`,
      );
      return;
    }
    setFormError(null);
    void startUpload(file, row.targetDir);
  }

  function resumeFromRow(row: UploadSession): void {
    if (runRef.current !== null) {
      setFormError('已经有一个文件在传了。等它传完，或者先暂停它。');
      return;
    }
    setFormError(null);
    resumeRowRef.current = row;
    resumePickRef.current?.click();
  }

  // ── 拖拽 ───────────────────────────────────────────────────

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragDepth(0);
    if (runRef.current !== null) {
      setFormError('已经有一个文件在传了。等它传完，或者先暂停它。');
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    const first = files[0];
    if (first === undefined) return;
    if (files.length > 1) {
      setFormError(
        `一次传一个，已取「${first.name}」。数据集通常是单个大压缩包，` +
          `其余 ${files.length - 1} 个请等这一个传完再传。`,
      );
    } else {
      setFormError(null);
    }
    if (targetDir === null) {
      setFormError(
        `请先填好「领域」和「数据集名」——文件落到服务器的哪个目录，取决于这两项。${dirIssue ?? ''}`,
      );
      return;
    }
    void startUpload(first, targetDir);
  }

  // ── 渲染 ───────────────────────────────────────────────────

  const changedName =
    result !== null && lastSegment(result.storedPath) !== result.session.fileName
      ? lastSegment(result.storedPath)
      : null;

  return (
    <>
      <PageTitle icon="upload">数据集上传</PageTitle>
      <p className="lead">分片上传 GB 级大文件至服务器数据集目录，支持断点续传。</p>

      <div className="card dataset-upload-target">
        <h2>选择目标数据集</h2>

        <div className="form-row">
          <label className="field">
            <span>领域</span>
            <input
              type="text"
              list="upload-projects"
              value={field}
              onChange={(e) => setField(e.target.value)}
              placeholder="如 medical"
              disabled={running}
            />
            <datalist id="upload-projects">
              {projects.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </label>

          <label className="field">
            <span>数据集名</span>
            <input
              type="text"
              list="upload-dataset-names"
              value={dataset}
              onChange={(e) => setDataset(e.target.value)}
              placeholder="如 amos22"
              disabled={running}
            />
            <datalist id="upload-dataset-names">
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </label>
        </div>

        <p className="dim mono upload-dest">
          {targetDir === null
            ? '填完这两项后，这里会显示文件的最终去处。'
            : `${dataRoot ?? '(数据集根目录)'}/${targetDir}/`}
        </p>
      </div>

      <div className="card dataset-upload-file">
        <h2>{running ? '正在上传' : '上传文件'}</h2>

        {progress === null ? (
          <>
            <div
              className={dragDepth > 0 ? 'drop-zone over' : 'drop-zone'}
              onDragEnter={(e) => {
                e.preventDefault();
                setDragDepth((d) => d + 1);
              }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
              onDrop={onDrop}
              onClick={() => pickRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  pickRef.current?.click();
                }
              }}
              role="button"
              tabIndex={0}
            >
              <p className="drop-zone-main">把文件拖到这里，或点击选择文件</p>
              <p className="drop-zone-sub">
                一次上传一个文件，选择后立即开始；GB 级文件支持断点续传。
              </p>
            </div>
            {/* 文件选择器放在拖拽区**外面**：放里面的话，程序化点它会冒泡回
                拖拽区的 onClick，又去点一次 —— 一个点不完的死循环。 */}
            <input ref={pickRef} type="file" hidden onChange={onPick} />

            <p className="dim upload-note">
              <label className="upload-register">
                <input
                  type="checkbox"
                  checked={register}
                  onChange={(e) => setRegister(e.target.checked)}
                />
                <span>
                  传完后登记进「数据集管理」（推荐）。不登记的话，这个数据集不在路径巡检的射程里，
                  Agent 也查不到它。
                </span>
              </label>
            </p>
          </>
        ) : (
          <UploadProgress
            progress={progress}
            register={register}
            broken={error !== null}
            onPause={pause}
            onResume={resume}
            onRetry={() => void retry()}
            onAbandon={() => void abandonActive()}
          />
        )}

        <p className="dim upload-note">
          续传认的是<b>文件名 + 字节数 + 最后修改时间</b>。同名、同大小、且修改时间也
          恰好相同的两份不同文件，会被当成同一份接着传——重新导出一次文件就会换掉修改时间，
          所以这需要三个都撞上。真要分辨得把整个文件读一遍算哈希，10 GB 要几分钟，
          权衡下来没做。
        </p>

        {formError !== null && (
          <div className="notice err">
            <p className="notice-body" style={{ marginBottom: 0 }}>{formError}</p>
          </div>
        )}
        {error !== null && <ErrorNotice error={error} onRetry={() => setError(null)} />}
      </div>

      {result !== null && <UploadOutcome result={result} renamedTo={changedName} />}

      <div className="card dataset-upload-pending">
        <h2>
          没传完的上传{pending !== null && pending.length > 0 && `（${pending.length}）`}
          <span className="card-actions">
            <button type="button" className="link-btn" onClick={() => void loadPending()}>
              刷新
            </button>
          </span>
        </h2>

        {listError !== null && <ErrorNotice error={listError} onRetry={() => void loadPending()} />}

        {pending === null && listError === null && <SkeletonList rows={3} />}

        {/* 这一处空态**不给下一步动作**：空着就是"没有没传完的东西"，
            是这一页最想看到的结果。塞一个按钮进去反而在暗示"还有事没做"。 */}
        {pending !== null && pending.length === 0 && (
          <EmptyState icon="upload">
            没有没传完的上传——这里空着是好事，传过的文件都已经传完了。
            清单来自服务器磁盘上真实存在的分片，换台电脑打开这一页看到的也是同一份。
          </EmptyState>
        )}

        {pending !== null && pending.length > 0 && (
          <>
            <p className="dim upload-note" style={{ marginTop: 0 }}>
              下面这些还没传完。关掉浏览器、换台电脑都不影响：分片在服务器上。
              点「继续」选中当初那份文件即可，已传的部分不会重传。
            </p>
            <ul className="upload-list">
              {pending.map((row) => (
                <li key={row.id} className="upload-row">
                  <div className="upload-head">
                    <span className="upload-title">{row.fileName}</span>
                    <span className="pill">{pct(row.receivedBytes, row.totalBytes)}</span>
                  </div>
                  <p className="upload-meta mono">{row.targetDir}/</p>
                  <p className="upload-dates">
                    {fmtBytes(row.receivedBytes)} / {fmtBytes(row.totalBytes)} ·{' '}
                    {row.received.length} / {row.chunkCount} 片 · 最后动静 {fmtSince(row.updatedAt)}
                  </p>
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{ width: `${pctWidth(row.receivedBytes, row.totalBytes)}%` }}
                    />
                  </div>

                  <div className="upload-actions">
                    <button
                      type="button"
                      disabled={running}
                      onClick={() => resumeFromRow(row)}
                    >
                      继续
                    </button>
                    <button
                      type="button"
                      className="link-btn"
                      disabled={running}
                      onClick={() => {
                        setFormError(null);
                        setConfirmRow(row.id);
                      }}
                    >
                      放弃
                    </button>

                    {/* 确认弹窗在行内声明、portal 到 body，不把这一行撑开。
                        只有 `confirmRow` 指向的那一行会真的弹出来（其余渲染 null）。 */}
                    <ConfirmDialog
                      open={confirmRow === row.id}
                      title="放弃这次上传？"
                      confirmLabel="确定放弃"
                      busyLabel="删除中…"
                      cancelLabel="取消"
                      busy={busyRow === row.id}
                      danger
                      onConfirm={() => void discardRow(row)}
                      onCancel={() => setConfirmRow(null)}
                    >
                      <p>
                        确定放弃？会把服务器上已经收到的 {row.received.length} 片删掉。
                        传上去的是<b>文件</b>——已经发布过的数据一份都不会动。
                      </p>
                    </ConfirmDialog>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {/* 这一行的文件选择器只管清单里某一行的「继续」。 */}
        <input ref={resumePickRef} type="file" hidden onChange={onResumePick} />
      </div>
    </>
  );
}

/** 上传进行中的那一块：进度条 + 这一趟的实况 + 暂停/继续/放弃。 */
function UploadProgress({
  progress,
  register,
  broken,
  onPause,
  onResume,
  onRetry,
  onAbandon,
}: {
  progress: Progress;
  register: boolean;
  /** 上一次是失败停下来的（而不是用户按的暂停） */
  broken: boolean;
  onPause: () => void;
  onResume: () => void;
  onRetry: () => void;
  onAbandon: () => void;
}) {
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const { phase } = progress;

  return (
    <div className="upload-panel">
      <div className="upload-head">
        <span className="upload-title">{progress.fileName}</span>
        {progress.resumed && <span className="pill">接着上次传</span>}
        <span className={`pill ${phaseTone(phase, broken)}`}>{phaseLabel(phase, broken)}</span>
      </div>

      <p className="upload-meta mono">{progress.targetDir}/</p>

      <div className="progress-track">
        <div
          className={phase === 'paused' ? 'progress-fill paused' : 'progress-fill'}
          style={{ width: `${pctWidth(progress.receivedBytes, progress.totalBytes)}%` }}
        />
      </div>

      <p className="upload-stats">
        <b>{pct(progress.receivedBytes, progress.totalBytes)}</b>
        <span className="dim">
          {fmtBytes(progress.receivedBytes)} / {fmtBytes(progress.totalBytes)}
        </span>
        {progress.chunkCount > 0 && (
          <span className="dim">
            {progress.receivedCount} / {progress.chunkCount} 片
          </span>
        )}
        {progress.speedBps !== null && (
          <span className="dim">{fmtSpeed(progress.speedBps)}</span>
        )}
        {/* 剩余时间只在**还在跑**的时候显示：暂停或失败时它算不出新值，
            留一个越来越不准的数字在那里，几分钟后就成了假话。 */}
        {phase === 'uploading' && progress.etaMs !== null && (
          <span className="dim">还剩 {fmtDuration(progress.etaMs)}</span>
        )}
      </p>

      {phase === 'completing' && (
        <p className="dim upload-note">
          分片都到齐了，服务端正在拼装落位（几十 GB 要读一遍、写一遍，请别关页面）。
        </p>
      )}

      <div className="upload-actions">
        {broken ? (
          <>
            <button type="button" onClick={onRetry}>
              重试
            </button>
            <button type="button" className="link-btn" onClick={() => setConfirmAbandon(true)}>
              放弃
            </button>
          </>
        ) : phase === 'paused' ? (
          <>
            <button type="button" onClick={onResume}>
              继续
            </button>
            <button type="button" className="link-btn" onClick={() => setConfirmAbandon(true)}>
              放弃
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={phase === 'completing' || phase === 'creating'}
            onClick={onPause}
          >
            {phase === 'completing' ? '落位中…' : '暂停'}
          </button>
        )}

        {/* 放弃整次传输的确认。原来是行内块，会把进度条和实况推走 ——
            而"确定要放弃的就是眼前这一条进度"这件事，弹窗比行内块更能说明白。 */}
        <ConfirmDialog
          open={confirmAbandon}
          title="放弃这次上传？"
          confirmLabel="确定放弃"
          busyLabel="删除中…"
          cancelLabel="取消"
          busy={false}
          danger
          onConfirm={onAbandon}
          onCancel={() => setConfirmAbandon(false)}
        >
          <p>
            确定放弃？会删掉服务器上已经收到的 {progress.receivedCount} 片。
            <b>已经落位的文件不会被删</b>——这里放弃的是这次传输，不是那个数据集。
          </p>
        </ConfirmDialog>
      </div>
      <span className="dim upload-hint">
        {phase === 'uploading' && '暂停会让当前这一片传完再停，服务器上的分片都留着。'}
        {broken && '刚才那一片没传成。重试会先问服务端收到了哪些片，不会重传已有的。'}
        {register && phase === 'completing' && '落位后会自动登记进「数据集管理」。'}
      </span>
    </div>
  );
}

/** 传完之后的结果。 */
function UploadOutcome({
  result,
  renamedTo,
}: {
  result: CompleteUploadResponse;
  /** 落位时因为重名被改了名（不再是原来那个文件名），改成了什么 */
  renamedTo: string | null;
}) {
  return (
    <div className="notice ok">
      <p className="notice-title">已落位</p>
      <p className="notice-body mono upload-dest">{showPath(result.storedPath)}</p>
      <p className="notice-body">
        {fmtBytes(result.byteSize)} · SHA-256 <span className="mono">{result.sha256}</span>
      </p>

      {/* 重名被改名这件事必须显眼：用户会去按原来的文件名找，然后找不到，
          而"传失败了"是他唯一能想到的解释。 */}
      {renamedTo !== null && (
        <p className="notice-body">
          ⚠️ 目标目录里已经有一个同名的文件，这一份落成了 <b className="mono">{renamedTo}</b>
          ——两份都在，没有覆盖任何东西。要是你本来想覆盖它，请手动处理一遍。
        </p>
      )}

      {result.asset !== null ? (
        <p className="notice-body" style={{ marginBottom: 0 }}>
          已登记「{result.asset.name}」
          {result.assetCreated ? '（新建的一条）' : '（这个目录本来就登记过，沿用了原来那条）'}
          。{result.reason !== null && `核对：${result.reason}`}
        </p>
      ) : (
        <p className="notice-body" style={{ marginBottom: 0 }}>
          这次没有登记进「数据集管理」。要让它进路径巡检的射程，请到那一页登记一下。
        </p>
      )}

      <p className="notice-foot">
        传上来的是<b>文件</b>。要是压缩包，解包与整理是下一步的事——传完之后这里不会自动动它。
      </p>
    </div>
  );
}

// ── 纯函数（可单独读、可单独测）───────────────────────────────

/** 暂停时把这一轮挂起，直到「继续」把它唤醒。 */
function waitIfPaused(run: Run): Promise<void> {
  if (!run.paused) return Promise.resolve();
  return new Promise<void>((resolve) => {
    run.wake = resolve;
  });
}

function pushSample(run: Run, sample: { ms: number; bytes: number }): void {
  run.samples.push(sample);
  while (run.samples.length > SPEED_WINDOW) run.samples.shift();
}

/**
 * 瞬时速度与剩余时间。
 *
 * 用最近 N 片的**总字节 / 总耗时**，而不是最后一片自己的耗时：单片的耗时
 * 受调度与磁盘刷写的抖动影响很大，最后一片算出来的速度能让剩余时间在
 * "还剩 2 分钟"和"还剩 1 小时"之间来回跳。
 */
function speedOf(run: Run, remainingBytes: number): { speedBps: number | null; etaMs: number | null } {
  let ms = 0;
  let bytes = 0;
  for (const s of run.samples) {
    ms += s.ms;
    bytes += s.bytes;
  }
  if (ms <= 0 || bytes <= 0) return { speedBps: null, etaMs: null };
  const speedBps = bytes / (ms / 1000);
  return { speedBps, etaMs: speedBps > 0 ? (remainingBytes / speedBps) * 1000 : null };
}

/**
 * 客户端眼里的"这一段路径看起来对不对"。
 *
 * **只是提前给个说法，不是校验**——真正的判据在服务端（uploads/layout.ts 的
 * assertSafeSegment）。浏览器里没有 path 模块，再写一套自己的判定，
 * 早晚会和服务端分叉，而"界面放行、服务端拒绝"这种分叉最难解释。
 */
function validateSegment(label: string, value: string): string | null {
  const v = value.trim();
  if (v === '') return `请填「${label}」。`;
  if (v === '.' || v === '..') return `「${label}」不能是「${v}」。`;
  if (/[\\/]/u.test(v)) return `「${label}」不能含斜杠——它是路径里的一段，不是一整条路径。`;
  return null;
}

/** ISO → 相对说法。上传的粒度到分钟，所以比数据集列表那边细一档。 */
function fmtSince(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '时间未知';
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let v = n / 1024;
  let idx = 0;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[idx] ?? 'TB'}`;
}

function fmtSpeed(bps: number): string {
  return `${fmtBytes(bps)}/s`;
}

function fmtDuration(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) {
    const rest = sec % 60;
    return rest === 0 ? `${min} 分` : `${min} 分 ${rest} 秒`;
  }
  const hr = Math.floor(min / 60);
  const restMin = min % 60;
  return restMin === 0 ? `${hr} 小时` : `${hr} 小时 ${restMin} 分`;
}

function pct(received: number, total: number): string {
  if (total <= 0) return '0%';
  return `${((received / total) * 100).toFixed(1)}%`;
}

/** 进度条的宽度。单独一个函数是因为它必须被夹在 0–100：并发完成时收到的字节
    有可能比总额多一点（不会真的发生，但一个 103% 的宽度会让进度条冲出卡片）。 */
function pctWidth(received: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (received / total) * 100));
}

function phaseLabel(phase: Phase, broken: boolean): string {
  if (broken) return '已中断';
  if (phase === 'creating') return '建会话中';
  if (phase === 'uploading') return '传输中';
  if (phase === 'paused') return '已暂停';
  return '落位中';
}

function phaseTone(phase: Phase, broken: boolean): string {
  if (broken) return 'err';
  if (phase === 'paused' || phase === 'creating') return 'warn';
  return '';
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/u);
  return parts[parts.length - 1] ?? path;
}

/**
 * 显示用的路径：统一成正斜杠。
 *
 * 服务端回的绝对路径在 Windows 上是反斜杠，而这一页自己拼的是正斜杠
 * （`目标目录/`），混在一起就是 `E:\...\datasets/_ui-verify/uitest/` ——
 * 能点开、能跑，但读起来像拼错了。Windows 上两种分隔符等价，统一成一种即可。
 */
function showPath(p: string): string {
  return p.replace(/\\/gu, '/');
}

function loadSavedTarget(): { field: string; dataset: string } {
  const empty = { field: '', dataset: '' };
  try {
    const raw = localStorage.getItem(TARGET_KEY);
    if (raw === null) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const { field, dataset } = parsed as Record<string, unknown>;
    return {
      field: typeof field === 'string' ? field : '',
      dataset: typeof dataset === 'string' ? dataset : '',
    };
  } catch {
    // 存坏了就当没存过。为了少打几个字而让整页打不开，是明显的亏本买卖。
    return empty;
  }
}
