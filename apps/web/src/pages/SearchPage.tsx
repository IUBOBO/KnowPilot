import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  MATERIALS, MATERIAL_LABELS, QUICK_SEARCH_KINDS, QUICK_SEARCH_LABELS,
  type EvidenceOpenRequest, type OpenEvidence, type QuickSearchHit, type QuickSearchKind,
  type QuickSearchResponse, type RecordType, type RetrievalResponseV1,
} from '@knowpilot/shared';
import { apiGet, toApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { PageTitle } from '../components/PageTitle.tsx';
import { EvidenceViewer, openEvidenceLink, useEvidenceViewer } from '../components/evidence/EvidenceViewer.tsx';
import { fmtDateTime } from '../format.ts';
import { searchHitHref } from '../search-links.ts';
import { DocumentCheckbox, passageRequest, SearchDocuments } from './search/SearchDocuments.tsx';
import { passageSearchPath, type DocumentSearchScope } from './search/search-results.ts';
import './search/search.css';

const QUICK_LIMIT = 100;
type SearchKind = QuickSearchKind | 'all';

interface SearchScope extends DocumentSearchScope {
  kind: SearchKind;
}

function searchParams({ query, kind, material, documentId }: SearchScope) {
  const next = new URLSearchParams();
  if (query) next.set('q', query);
  if (kind !== 'all') next.set('kind', kind);
  if (kind === 'all' || kind === 'document') {
    if (material !== undefined) next.set('material', material);
    if (documentId !== undefined) next.set('documentId', documentId);
  }
  return next;
}

// A journal title alone does not identify a ranking period. Keep its journal link.
const searchRecordTypes: Partial<Record<QuickSearchKind, RecordType>> = {
  person: 'M-PERSON', patent: 'M-PATENT', thesis: 'M-THESIS', submission: 'M-SUBMIT', dataset: 'M-CODE',
};

function recordRequest(hit: QuickSearchHit): EvidenceOpenRequest | undefined {
  const recordType = searchRecordTypes[hit.kind];
  if (recordType === undefined || !hit.updatedAt) return undefined;
  return { version: 1, locator: { kind: 'record', recordType, recordId: hit.id, sourceVersion: hit.updatedAt } };
}

interface SearchResults {
  records: QuickSearchResponse['items'];
  body: RetrievalResponseV1 | null;
  errors: ReturnType<typeof toApiError>['body']['error'][];
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const { can, user } = useAuth();
  const kind = QUICK_SEARCH_KINDS.find((item) => item === params.get('kind')) ?? 'all';
  const allowDocumentScope = kind === 'all' || kind === 'document';
  const rawMaterial = allowDocumentScope ? params.get('material') : null;
  const material = MATERIALS.find((item) => item === rawMaterial);
  const documentId = allowDocumentScope ? params.get('documentId') : null;
  const invalidMaterial = Boolean(rawMaterial) && material === undefined;
  const invalidDocumentId = documentId === '';
  if (invalidMaterial || invalidDocumentId) {
    const corrected = new URLSearchParams(params);
    if (invalidMaterial) corrected.delete('material');
    if (invalidDocumentId) corrected.delete('documentId');
    return <>
      <div className="page-head"><PageTitle icon="search">统一检索</PageTitle></div>
      <div className="card">
        <p className="search-error" role="alert">
          {invalidMaterial && '资料类型无效。'}
          {invalidDocumentId && '资料 ID 无效。'}
        </p>
        <Link to={{ search: corrected.toString() }}>清除无效筛选</Link>
      </div>
    </>;
  }
  const scope: SearchScope = {
    query: params.get('q')?.trim() ?? '',
    kind,
    material,
    documentId: documentId ?? undefined,
  };
  const allowDocuments = can('knowledge.read');
  const allowAsk = can('chat.use');
  const scopeKey = JSON.stringify([user?.id, user?.role, allowDocuments, allowAsk, scope]);
  return <SearchSession key={scopeKey} scope={scope} allowDocuments={allowDocuments} allowAsk={allowAsk} onSearch={setParams} />;
}

function SearchSession({ scope, allowDocuments, allowAsk, onSearch }: {
  scope: SearchScope;
  allowDocuments: boolean;
  allowAsk: boolean;
  onSearch: (params: URLSearchParams) => void;
}) {
  const { kind, query, material, documentId } = scope;
  const canSearchBody = allowDocuments && (kind === 'all' || kind === 'document');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [draftKind, setDraftKind] = useState(kind);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const passages = useMemo(() => results?.body?.hits.filter((hit) => hit.kind === 'document') ?? [], [results]);
  const catalog = useMemo(() => [
    ...passages.map((hit) => ({ request: passageRequest(hit), quote: hit.excerpt })),
    ...results?.records.flatMap((hit) => {
      const request = recordRequest(hit);
      return request === undefined ? [] : [{ request, recordHref: searchHitHref(hit) }];
    }) ?? [],
  ], [passages, results]);
  const evidence = useEvidenceViewer(catalog, String(attempt));
  const titleHits = results?.records.filter((hit) => hit.kind === 'document') ?? [];
  const records = results?.records.filter((hit) => hit.kind !== 'document') ?? [];

  useEffect(() => {
    if (query === '' || (kind === 'document' && !allowDocuments)) return;
    const request = new AbortController();
    const quickParams = new URLSearchParams({ q: query, limit: String(QUICK_LIMIT) });
    if (kind !== 'all') quickParams.set('kind', kind);
    if (canSearchBody && material !== undefined) quickParams.set('material', material);
    if (canSearchBody && documentId !== undefined) quickParams.set('documentId', documentId);
    const opts = { cache: 'no-store' } as const;
    void Promise.allSettled([
      apiGet<QuickSearchResponse>(`/api/v1/quick-search?${quickParams}`, request.signal, opts),
      canSearchBody
        ? apiGet<RetrievalResponseV1>(passageSearchPath({ query, material, documentId }), request.signal, opts)
        : Promise.resolve(null),
    ]).then(([quick, body]) => {
      if (request.signal.aborted) return;
      setResults({
        records: quick.status === 'fulfilled'
          ? quick.value.items.filter((hit) => allowDocuments || hit.kind !== 'document') : [],
        body: body.status === 'fulfilled' ? body.value : null,
        errors: [quick, body].flatMap((result) => result.status === 'rejected'
          ? [toApiError(result.reason).body.error] : []),
      });
    });
    return () => request.abort();
  }, [allowDocuments, attempt, canSearchBody, documentId, kind, material, query]);

  function retry() {
    setResults(null);
    setSelected(new Set());
    setAttempt((value) => value + 1);
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = searchParams({
      query: String(data.get('q') ?? '').trim(),
      kind: draftKind,
      material: MATERIALS.find((item) => item === data.get('material')),
      documentId,
    });
    if (next.toString() === searchParams(scope).toString()) retry();
    else onSearch(next);
  }

  function toggleDocument(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function documentScopeHref(id: string | undefined) {
    return `/search?${searchParams({ ...scope, kind: 'document', documentId: id })}`;
  }

  const documentScopeTitle = passages[0]?.documentTitle ?? titleHits[0]?.title;
  const quickEmpty = results?.errors.length === 0 && records.length === 0 && titleHits.length === 0 && passages.length === 0;
  const bodyOnly = kind === 'document' && !allowDocuments;

  return <EvidenceViewer reader={evidence.reader}>
    <div className="search-workspace">
      <div className="page-head"><PageTitle icon="search">统一检索</PageTitle></div>
      <div className="card">
        <form className="form-row search-query-form" onSubmit={search}>
          <label className="field search-field-query">
            <span>关键词</span>
            <input name="q" type="search" defaultValue={query} maxLength={100}
              placeholder="输入标题、关键词、编号或自然语言问题" />
          </label>
          <label className="field"><span>范围</span>
            <select name="kind" value={draftKind} onChange={(event) =>
              setDraftKind(QUICK_SEARCH_KINDS.find((item) => item === event.target.value) ?? 'all')}>
              <option value="all">全部</option>
              {QUICK_SEARCH_KINDS.filter((item) => allowDocuments || item !== 'document')
                .map((item) => <option key={item} value={item}>{QUICK_SEARCH_LABELS[item]}</option>)}
              {bodyOnly && <option value="document">{QUICK_SEARCH_LABELS.document}</option>}
            </select>
          </label>
          {allowDocuments && (draftKind === 'all' || draftKind === 'document') && <label className="field"><span>资料类型</span>
            <select name="material" defaultValue={material ?? ''}>
              <option value="">全部资料类型</option>
              {MATERIALS.map((item) => <option key={item} value={item}>{MATERIAL_LABELS[item]}</option>)}
            </select>
          </label>}
          <button type="submit" className="btn-primary">搜索</button>
        </form>
        {documentId !== undefined && allowDocuments && <div className="search-scope">
          <span>{documentScopeTitle === undefined ? '已限定为一份资料' : `仅检索《${documentScopeTitle}》`}</span>
          <Link to={documentScopeHref(undefined)}>清除资料范围</Link>
        </div>}
      </div>
      {bodyOnly && <p role="status" className="dim">当前账号没有文档检索权限。</p>}
      {!bodyOnly && query === '' && <p className="dim">输入关键词或自然语言问题，查找资料正文、标题及台账。</p>}
      {!bodyOnly && query !== '' && results === null && <p role="status">正在检索…</p>}
      {results?.errors.map((error, index) => <div key={index} className="search-error" role="alert">{error.message}</div>)}
      {results?.errors.some((error) => error.retryable) && <button type="button" onClick={retry}>重试检索</button>}
      {results?.body?.notice && <p role="status">{results.body.notice}</p>}
      {results?.body?.diagnostics.includes('index_unavailable') && <p role="status">此范围内有资料尚无可检索的正文。</p>}
      {results?.body?.diagnostics.includes('index_stale') && <p role="status">此范围内有资料使用较早版本的索引。</p>}
      {selected.size > 0 && <div className="search-selection">
        <strong role="status">已选 {selected.size} 份资料</strong>
        <button type="button" onClick={() => setSelected(new Set())}>清空选择</button>
        {allowAsk && <Link className="search-ask-link" to="/ask" state={searchAskHandoff(scope, selected)}>基于此资料问答</Link>}
      </div>}
      {results?.body && <SearchDocuments
        passages={passages} selected={selected} onToggle={toggleDocument} onOpen={evidence.onOpenEvidence}
        scopedSearch={documentId === undefined ? documentScopeHref : undefined}
      />}
      {quickEmpty && <p className="dim" role="status">{kind === 'document' ? '未找到匹配的资料标题。' : '未找到匹配的标题或台账。'}</p>}
      {titleHits.length > 0 && <QuickResults
        kind="document" hits={titleHits} atLimit={titleHits.length === QUICK_LIMIT}
        onOpen={evidence.onOpenEvidence} selection={{ selected, onToggle: toggleDocument }} />}
      {QUICK_SEARCH_KINDS.filter((item) => item !== 'document').map((item) => {
        const hits = records.filter((hit) => hit.kind === item);
        return hits.length === 0 ? null : <QuickResults key={item} kind={item} hits={hits}
          atLimit={hits.length === QUICK_LIMIT} onOpen={evidence.onOpenEvidence} />;
      })}
    </div>
  </EvidenceViewer>;
}

function QuickResults({ kind, hits, atLimit, onOpen, selection }: {
  kind: QuickSearchKind;
  hits: readonly QuickSearchHit[];
  atLimit: boolean;
  onOpen: OpenEvidence;
  selection?: { selected: ReadonlySet<string>; onToggle: (id: string) => void };
}) {
  return <section className="card">
    <h2>{kind === 'document' ? '资料标题快搜' : QUICK_SEARCH_LABELS[kind]}</h2>
    <ul className="sub-list">{hits.map((hit) => <li className="sub-item" key={hit.id}>
      {selection && <DocumentCheckbox id={hit.id} title={hit.title} {...selection} />}
      <Link className="hit-title" to={searchHitHref(hit)} onClick={(event) => openEvidenceLink(event, () => {
        const request = recordRequest(hit);
        return request !== undefined && onOpen(request);
      })}>{hit.title}</Link>
      {hit.detail && <span className="dim"> · {hit.detail}</span>}
      {hit.updatedAt && <div className="dim">更新于 <time dateTime={hit.updatedAt}>{fmtDateTime(hit.updatedAt)}</time></div>}
    </li>)}</ul>
    {atLimit && <p className="dim">已取快搜前 {QUICK_LIMIT} 条。可细化关键词查看更多相关结果。</p>}
  </section>;
}

/** Navigation intent for #8. The recipient must validate IDs and authorize their use. */
function searchAskHandoff({ query, kind, material, documentId }: SearchScope, selected: ReadonlySet<string>) {
  return { searchHandoff: { version: 1, query, documentIds: [...selected],
    ...(kind === 'document' ? { kind } : {}), material, documentId } };
}
