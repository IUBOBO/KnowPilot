import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  LEDGER_IMPORT_TARGETS,
  LEDGER_ROW_STATUS_LABELS,
  LEDGER_TARGET_LABELS,
  SUBMISSION_STATUSES,
  SUBMISSION_STATUS_LABELS,
  type ImportReadyResponse,
  type ImportLedgerRowResponse,
  type LedgerBatchDetailResponse,
  type LedgerImportBatch,
  type LedgerImportRow,
  type LedgerRowStatus,
  type ListLedgerBatchesResponse,
  type ListPeopleResponse,
  type Person,
  type UpdateLedgerRowResponse,
  type UploadLedgerBatchResponse,
} from '@knowpilot/shared';
import {
  ApiError as ApiClientError,
  apiGet,
  apiPatch,
  apiPost,
  apiPostForm,
  isAbort,
  isApiErrorBody,
  toApiError,
  type ApiError,
} from '../api.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Modal } from '../components/Modal.tsx';
import { SkeletonList } from '../components/Skeleton.tsx';
import { NavGlyph } from '../nav-icons.tsx';

function statusClass(status: LedgerRowStatus): string {
  if (status === 'ready') return 'pill ok';
  if (status === 'imported') return 'pill ok';
  if (status === 'skipped') return 'pill';
  if (status === 'duplicate') return 'pill warn';
  if (status === 'invalid') return 'pill err';
  return 'pill warn';
}

function rowSummary(row: LedgerImportRow): string {
  const n = row.normalized;
  if (row.target === 'person') return `${n['name'] ?? '（无姓名）'} · 学号 ${n['studentNo'] ?? '未填'}`;
  if (row.target === 'submission') return `${n['title'] ?? '（无题目）'} · ${n['journalName'] ?? '未填期刊'}`;
  if (row.target === 'patent') return `${n['name'] ?? '（无名称）'} · ${n['patentNo'] ?? '未补专利号'}`;
  return `${n['authorName'] ?? '（无作者）'} · ${n['title'] ?? '未定题'}`;
}

/**
 * Excel 导入（投稿台账信息优化 · 第四步）。
 *
 * 上传只生成草稿；逐行确认后才写业务表。草稿只属于上传者（管理员看全部）。
 */
export function LedgerImportsPage() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('batch');
  const [batches, setBatches] = useState<readonly LedgerImportBatch[] | null>(null);
  const [detail, setDetail] = useState<LedgerBatchDetailResponse | null>(null);
  const [people, setPeople] = useState<readonly Person[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<LedgerImportRow | null>(null);
  const [confirmReady, setConfirmReady] = useState(false);
  const [importingReady, setImportingReady] = useState(false);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [exportKeyword, setExportKeyword] = useState('');
  const [exportTargets, setExportTargets] = useState<Record<string, boolean>>({
    submission: true,
    patent: true,
    person: true,
    thesis: true,
  });
  const [exporting, setExporting] = useState(false);

  const loadBatches = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await apiGet<ListLedgerBatchesResponse>('/api/v1/ledger-imports?limit=50', signal);
      setBatches(res.items);
      setError(null);
      if (selectedId === null && res.items.length > 0) {
        const next = new URLSearchParams(params);
        next.set('batch', res.items[0]?.id ?? '');
        setParams(next, { replace: true });
      }
    } catch (err) {
      if (isAbort(err)) return;
      setError(toApiError(err));
    }
  }, [params, selectedId, setParams]);

  const loadDetail = useCallback(async (id: string, signal?: AbortSignal) => {
    try {
      const res = await apiGet<LedgerBatchDetailResponse>(
        `/api/v1/ledger-imports/${encodeURIComponent(id)}`,
        signal,
      );
      setDetail(res);
      setError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setError(toApiError(err));
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void loadBatches(ac.signal);
    return () => ac.abort();
  }, [loadBatches]);

  useEffect(() => {
    const ac = new AbortController();
    apiGet<ListPeopleResponse>('/api/v1/people?limit=200', ac.signal)
      .then((res) => setPeople(res.items))
      .catch(() => setPeople([]));
    return () => ac.abort();
  }, []);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    const ac = new AbortController();
    void loadDetail(selectedId, ac.signal);
    return () => ac.abort();
  }, [selectedId, loadDetail]);

  async function onUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (file === undefined) {
      setError(toApiError(new Error('请选择 .xlsx 工作簿。')));
      return;
    }
    const form = new FormData();
    form.append('file', file);
    setUploading(true);
    setError(null);
    try {
      const res = await apiPostForm<UploadLedgerBatchResponse>('/api/v1/ledger-imports', form);
      if (fileRef.current !== null) fileRef.current.value = '';
      setNotice(`已识别 ${res.rows.length} 行，保存在草稿里；还没有写入任何业务表。`);
      setDetail({ batch: res.batch, rows: res.rows });
      const next = new URLSearchParams(params);
      next.set('batch', res.batch.id);
      setParams(next, { replace: true });
      await loadBatches();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setUploading(false);
    }
  }

  async function onExport() {
    const targets = LEDGER_IMPORT_TARGETS.filter((t) => exportTargets[t] === true);
    if (targets.length === 0) {
      setError(toApiError(new Error('请至少选择一类要导出的记录。')));
      return;
    }
    setExporting(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/ledger-exports/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(exportKeyword.trim() !== '' ? { keyword: exportKeyword.trim() } : {}),
          targets,
        }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        throw isApiErrorBody(body)
          ? new ApiClientError(body)
          : toApiError(new Error(`导出失败：HTTP ${res.status}`));
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'KnowPilot台账导出.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 与反馈导出同一处理：过早 revoke 会打断落盘。
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setNotice('已生成导出文件。导出人、范围、条件与行数已写入审计。');
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setExporting(false);
    }
  }

  async function afterRowChange(row: LedgerImportRow, message?: string) {
    if (selectedId !== null) await loadDetail(selectedId);
    await loadBatches();
    if (message !== undefined) setNotice(message);
    setEditing(null);
    return row;
  }

  async function onImportRow(row: LedgerImportRow) {
    if (selectedId === null) return;
    setBusyRow(row.id);
    setError(null);
    try {
      const res = await apiPost<ImportLedgerRowResponse>(
        `/api/v1/ledger-imports/${encodeURIComponent(selectedId)}/rows/${encodeURIComponent(row.id)}/import`,
        {},
      );
      await afterRowChange(res.row, res.row.resultMessage ?? '已处理这一行。');
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusyRow(null);
    }
  }

  async function onSkipRow(row: LedgerImportRow) {
    if (selectedId === null) return;
    setBusyRow(row.id);
    setError(null);
    try {
      const res = await apiPatch<UpdateLedgerRowResponse>(
        `/api/v1/ledger-imports/${encodeURIComponent(selectedId)}/rows/${encodeURIComponent(row.id)}`,
        { skip: true },
      );
      await afterRowChange(res.row, '已跳过这一行。');
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusyRow(null);
    }
  }

  async function onImportReady() {
    if (selectedId === null) return;
    setConfirmReady(false);
    setImportingReady(true);
    setError(null);
    try {
      const res = await apiPost<ImportReadyResponse>(
        `/api/v1/ledger-imports/${encodeURIComponent(selectedId)}/import-ready`,
        {},
      );
      const imported = res.results.filter((r) => r.status === 'imported').length;
      const left = res.results.length - imported;
      if (selectedId !== null) await loadDetail(selectedId);
      await loadBatches();
      setNotice(`批量导入完成：${imported} 行成功${left > 0 ? `，${left} 行仍需核实` : ''}。`);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setImportingReady(false);
    }
  }

  const rows = detail?.rows ?? null;
  const counts = detail?.batch.counts ?? {};
  const readyCount = counts['ready'] ?? 0;

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <div className="page-title">
            <span className="page-title-icon">
              <NavGlyph name="imports" size={30} />
            </span>
            <h1>Excel 导入</h1>
          </div>
          <p className="lead">上传四表工作簿，先看草稿，逐行确认后再写入台账。</p>
        </div>
        <div className="page-head-actions">
          <button type="button" className="link-btn" onClick={() => void loadBatches()}>
            刷新
          </button>
        </div>
      </div>

      <div className="card ledger-upload-card">
        <h2>上传工作簿</h2>
        <form className="form-row" onSubmit={(e) => void onUpload(e)}>
          <label className="field" style={{ flex: '1 1 320px' }}>
            <span>选择 .xlsx（论文 / 专利 / 个人信息 / 大论文题目）</span>
            <input ref={fileRef} type="file" accept=".xlsx" />
          </label>
          <button type="submit" className="btn-primary" disabled={uploading}>
            {uploading ? '识别中…' : '上传并识别'}
          </button>
        </form>
        <p className="dim" style={{ fontSize: '0.75rem', margin: '10px 0 0' }}>
          本机规则识别，不调用模型。原文件与草稿只对上传者可见（管理员可看全部）；
          识别不出表头或没有任何有效行时会直接报错。
        </p>
      </div>

      <div className="card ledger-export-card">
        <h2>模板与导出</h2>
        <p style={{ margin: '0 0 10px' }}>
          <a className="link-btn" href="/api/v1/ledger-exports/template">下载空白模板</a>
          {' · '}
          <a className="link-btn" href="/api/v1/ledger-exports/example">下载填写示例</a>
          <span className="dim" style={{ fontSize: '0.75rem', marginLeft: 8 }}>
            示例只用于看格式，导入入口会拒绝它。
          </span>
        </p>

        <form
          className="form-row"
          onSubmit={(e) => {
            e.preventDefault();
            void onExport();
          }}
        >
          <label className="field" style={{ flex: '1 1 260px' }}>
            <span>导出筛选（可选）</span>
            <input
              type="text"
              value={exportKeyword}
              onChange={(e) => setExportKeyword(e.target.value)}
              placeholder="按题目/名称/作者等关键词过滤"
            />
          </label>
          <div className="field" style={{ flex: '1 1 100%' }}>
            <span>导出范围</span>
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: '0.875rem' }}>
              {LEDGER_IMPORT_TARGETS.map((t) => (
                <label key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <input
                    type="checkbox"
                    checked={exportTargets[t] === true}
                    onChange={(e) =>
                      setExportTargets((prev) => ({ ...prev, [t]: e.target.checked }))
                    }
                  />
                  {LEDGER_TARGET_LABELS[t]}
                </label>
              ))}
            </span>
          </div>
          <button type="submit" className="btn-primary" disabled={exporting}>
            {exporting ? '生成中…' : '导出当前可见数据'}
          </button>
        </form>
        <p className="dim" style={{ fontSize: '0.75rem', margin: '10px 0 0' }}>
          导出范围由服务端按当前账号重新计算，不信任前端传来的“本人/全部”标记；
          登录成员可导出学号；成绩只导出导出人有权看到的值。每次真实导出都会写审计。
        </p>
      </div>

      {notice !== null && (
        <div className="notice ok"><p className="notice-body" style={{ margin: 0 }}>{notice}</p></div>
      )}
      {error !== null && <ErrorNotice error={error} onRetry={() => setError(null)} />}

      <div className="card ledger-batches-card">
        <h2>我的导入批次</h2>
        {batches === null && <SkeletonList rows={2} />}
        {batches !== null && batches.length === 0 && (
          <EmptyState icon="upload">还没有导入批次。上传一份 .xlsx 后，草稿会出现在这里。</EmptyState>
        )}
        {batches !== null && batches.length > 0 && (
          <ul className="sub-list">
            {batches.map((b) => (
              <li key={b.id} className="sub-item">
                <div className="sub-head">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      const next = new URLSearchParams(params);
                      next.set('batch', b.id);
                      setParams(next);
                    }}
                  >
                    {b.fileName}
                  </button>
                  <span className="dim">{b.createdAt.slice(0, 16).replace('T', ' ')}</span>
                </div>
                <p className="sub-meta" style={{ marginBottom: 0 }}>
                  共 {b.total} 行 · 可导入 {b.counts['ready'] ?? 0} · 待核实 {b.counts['needs_review'] ?? 0} ·
                  重复 {b.counts['duplicate'] ?? 0} · 已导入 {b.counts['imported'] ?? 0}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {detail !== null && rows !== null && (
        <div className="card ledger-detail-card">
          <h2>
            {detail.batch.fileName}
            <span className="card-actions">
              <button
                type="button"
                className="link-btn"
                disabled={importingReady || readyCount === 0}
                onClick={() => setConfirmReady(true)}
              >
                {importingReady ? '导入中…' : `导入全部可导入（${readyCount}）`}
              </button>
            </span>
          </h2>
          <p className="dim" role="status">
            已识别 {detail.batch.total} 行 · 已入库 {counts['imported'] ?? 0} · 可入库 {readyCount}
            {' · 待核实 '}{counts['needs_review'] ?? 0}{' · 疑似重复 '}{counts['duplicate'] ?? 0}
            {' · 无效 '}{counts['invalid'] ?? 0}{' · 已跳过 '}{counts['skipped'] ?? 0}
          </p>
          <p className="dim" style={{ fontSize: '0.75rem', margin: '0 0 10px' }}>
            只导入「可导入」行；待核实、重复、无效和已跳过的行不动。同一行重复点导入不会重复建记录。
          </p>
          <div className="ledger-table-scroll"><table className="table">
            <thead>
              <tr>
                <th style={{ width: 110 }}>工作表 / 行</th>
                <th style={{ width: 90 }}>类型</th>
                <th>识别内容</th>
                <th style={{ width: 90 }}>状态</th>
                <th style={{ width: 210 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="mono" style={{ fontSize: '0.75rem' }}>
                    {row.sheetName} / {row.rowNo}
                  </td>
                  <td>{LEDGER_TARGET_LABELS[row.target]}</td>
                  <td>
                    <div>{rowSummary(row)}</div>
                    {row.issues.length > 0 && (
                      <div className="dim" style={{ fontSize: '0.75rem' }}>
                        {row.issues.join('；')}
                      </div>
                    )}
                    {row.resultMessage !== null && (
                      <div className="dim" style={{ fontSize: '0.75rem' }}>{row.resultMessage}</div>
                    )}
                  </td>
                  <td>
                    <span className={statusClass(row.status)}>{LEDGER_ROW_STATUS_LABELS[row.status]}</span>
                  </td>
                  <td>
                    <span className="row-actions">
                      {row.status !== 'imported' && row.status !== 'skipped' && (
                        <>
                          <button type="button" className="link-btn" onClick={() => setEditing(row)}>
                            编辑
                          </button>
                          <button
                            type="button"
                            className="link-btn"
                            disabled={busyRow === row.id}
                            onClick={() => void onImportRow(row)}
                          >
                            {busyRow === row.id ? '导入中…' : '导入'}
                          </button>
                          <button
                            type="button"
                            className="link-btn danger"
                            disabled={busyRow === row.id}
                            onClick={() => void onSkipRow(row)}
                          >
                            跳过
                          </button>
                        </>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}

      <ConfirmDialog
        open={confirmReady}
        title={`导入全部可导入行（${readyCount} 行）？`}
        confirmLabel="确认导入"
        busyLabel="导入中…"
        cancelLabel="取消"
        busy={importingReady}
        danger={false}
        onConfirm={() => void onImportReady()}
        onCancel={() => setConfirmReady(false)}
      >
        <p style={{ marginTop: 0 }}>
          只处理当前草稿里「可导入」的行。人员会先导入，专利/大论文再按姓名匹配人员；
          待核实与重复行不会被导入，会继续留在草稿里。
        </p>
      </ConfirmDialog>

      {editing !== null && selectedId !== null && (
        <RowEditModal
          row={editing}
          people={people}
          batchId={selectedId}
          onClose={() => setEditing(null)}
          onSaved={(row, message) => void afterRowChange(row, message)}
        />
      )}
    </>
  );
}

const FIELD_DEFS: Record<string, readonly { key: string; label: string; kind?: 'date' | 'status' | 'person' }[]> = {
  person: [
    { key: 'name', label: '姓名' },
    { key: 'studentNo', label: '学号（文本）' },
  ],
  submission: [
    { key: 'title', label: '论文题目' },
    { key: 'algorithmAbbr', label: '算法缩写' },
    { key: 'journalName', label: '期刊' },
    { key: 'journalAbbr', label: '期刊缩写' },
    { key: 'submitterName', label: '投稿人' },
    { key: 'submitterPersonId', label: '关联投稿人', kind: 'person' },
    { key: 'submittedOn', label: '首次投稿日期', kind: 'date' },
    { key: 'status', label: '状态', kind: 'status' },
    { key: 'statusSince', label: '进入当前状态日期', kind: 'date' },
    { key: 'submissionNumber', label: '投稿号' },
  ],
  patent: [
    { key: 'name', label: '专利名称' },
    { key: 'patentNo', label: '专利号' },
    { key: 'applicantName', label: '申请人' },
    { key: 'personId', label: '关联人员', kind: 'person' },
    { key: 'firstSubmittedOn', label: '首次提交日期', kind: 'date' },
    { key: 'substantiveExamOn', label: '实审日期', kind: 'date' },
    { key: 'publishedOn', label: '公开日期', kind: 'date' },
    { key: 'grantedOn', label: '授权日期', kind: 'date' },
  ],
  thesis: [
    { key: 'personId', label: '关联人员', kind: 'person' },
    { key: 'authorName', label: '作者姓名' },
    { key: 'direction', label: '研究方向' },
    { key: 'title', label: '题目' },
    { key: 'grade', label: '成绩' },
  ],
};

function RowEditModal({
  row,
  people,
  batchId,
  onClose,
  onSaved,
}: {
  row: LedgerImportRow;
  people: readonly Person[];
  batchId: string;
  onClose: () => void;
  onSaved: (row: LedgerImportRow, message?: string) => void;
}) {
  const fields = FIELD_DEFS[row.target] ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const normalized: Record<string, string | null> = { ...row.normalized };
    for (const f of fields) {
      const value = String(fd.get(f.key) ?? '').trim();
      normalized[f.key] = value === '' ? null : value;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiPatch<UpdateLedgerRowResponse>(
        `/api/v1/ledger-imports/${encodeURIComponent(batchId)}/rows/${encodeURIComponent(row.id)}`,
        { normalized },
      );
      onSaved(res.row, res.row.status === 'ready' ? '已保存，这一行现在可以导入。' : '已保存，仍有问题需要核实。');
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      wide
      title={`编辑草稿：${row.sheetName} 第 ${row.rowNo} 行`}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <button type="button" className="link-btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" form="ledger-row-form" className="btn-primary" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <form id="ledger-row-form" className="form-row" onSubmit={(e) => void onSubmit(e)}>
        {fields.map((f) => (
          <label key={f.key} className="field" style={{ flex: '1 1 200px' }}>
            <span>{f.label}</span>
            {f.kind === 'status' ? (
              <select name={f.key} defaultValue={row.normalized[f.key] ?? ''}>
                <option value="">未识别</option>
                {SUBMISSION_STATUSES.map((s) => (
                  <option key={s} value={s}>{SUBMISSION_STATUS_LABELS[s]}</option>
                ))}
              </select>
            ) : f.kind === 'person' ? (
              <select name={f.key} defaultValue={row.normalized[f.key] ?? ''}>
                <option value="">不关联</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            ) : (
              <input
                name={f.key}
                type={f.kind === 'date' ? 'date' : 'text'}
                defaultValue={row.normalized[f.key] ?? ''}
              />
            )}
          </label>
        ))}
        <p className="dim" style={{ flexBasis: '100%', margin: 0, fontSize: '0.8125rem' }}>
          空白保存 = 清空该字段。必填项与日期格式在服务端再校验一次；保存只改草稿，不写业务表。
        </p>
      </form>
      {error !== null && <ErrorNotice error={error} onRetry={() => setError(null)} />}
    </Modal>
  );
}
