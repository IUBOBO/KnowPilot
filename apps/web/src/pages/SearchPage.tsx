import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  QUICK_SEARCH_KINDS, QUICK_SEARCH_LABELS,
  type QuickSearchKind, type QuickSearchResponse, type SearchResponse,
} from '@knowpilot/shared';
import { apiGet, toApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { PageTitle } from '../components/PageTitle.tsx';
import { fmtDateTime } from '../format.ts';
import { searchHitHref } from '../search-links.ts';

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q')?.trim() ?? '';
  const filter = QUICK_SEARCH_KINDS.find((kind) => kind === params.get('kind')) ?? 'all';
  const allowDocuments = useAuth().can('knowledge.read');
  const [results, setResults] = useState<{ records: QuickSearchResponse['items']; passages: SearchResponse['hits']; errors: string[] } | null>(null);

  useEffect(() => {
    setResults(null);
    if (query === '') return;
    const request = new AbortController();
    const q = encodeURIComponent(query);
    const kind = filter === 'all' ? '' : `&kind=${filter}`;
    void Promise.allSettled([
      apiGet<QuickSearchResponse>(`/api/v1/quick-search?q=${q}${kind}&limit=100`, request.signal),
      allowDocuments && (filter === 'all' || filter === 'document')
        ? apiGet<SearchResponse>(`/api/v1/search?q=${q}&mode=keyword&limit=30`, request.signal)
        : Promise.resolve(null),
    ]).then(([records, passages]) => {
      if (request.signal.aborted) return;
      setResults({
        records: records.status === 'fulfilled' ? records.value.items : [],
        passages: passages.status === 'fulfilled' ? passages.value?.hits ?? [] : [],
        errors: [records, passages].flatMap((result) => result.status === 'rejected'
          ? [toApiError(result.reason).body.error.message] : []),
      });
    });
    return () => request.abort();
  }, [allowDocuments, filter, query]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    const value = String(data.get('q') ?? '').trim();
    const kind = String(data.get('kind') ?? 'all');
    if (value) next.set('q', value);
    if (kind !== 'all') next.set('kind', kind);
    setParams(next);
  }

  const kinds: readonly QuickSearchKind[] = QUICK_SEARCH_KINDS;
  return <>
    <div className="page-head"><PageTitle icon="search">统一检索</PageTitle></div>
    <div className="card">
      <form className="form-row" key={params.toString()} onSubmit={search}>
        <label className="field" style={{ flex: '1 1 260px' }}>
          <span>关键词</span>
          <input name="q" type="search" defaultValue={query} maxLength={100} placeholder="姓名、成果名称、编号或文档关键词" />
        </label>
        <label className="field"><span>范围</span>
          <select name="kind" defaultValue={filter}>
            <option value="all">全部</option>
            {kinds.map((kind) => <option key={kind} value={kind}>{QUICK_SEARCH_LABELS[kind]}</option>)}
          </select>
        </label>
        <button type="submit" className="btn-primary">搜索</button>
      </form>
    </div>
    {query !== '' && results === null && <p role="status">正在检索…</p>}
    {results?.errors.map((error, index) => <p key={index} role="alert">{error}</p>)}
    {results !== null && results.errors.length === 0 && results.records.length === 0 && results.passages.length === 0
      && <p className="dim" role="status">未找到匹配记录或文档片段。</p>}
    {kinds.map((kind) => {
      const hits = results?.records.filter((item) => item.kind === kind) ?? [];
      if (hits.length === 0) return null;
      return <section className="card" key={kind}>
        <h2>{QUICK_SEARCH_LABELS[kind]}</h2>
        <ul className="sub-list">{hits.map((hit) => <li className="sub-item" key={hit.id}>
          <Link className="hit-title" to={searchHitHref(hit)}>{hit.title}</Link>
          {hit.detail && <span className="dim"> · {hit.detail}</span>}
          {hit.updatedAt && <div className="dim">更新于 <time dateTime={hit.updatedAt}>{fmtDateTime(hit.updatedAt)}</time></div>}
        </li>)}</ul>
        {hits.length === 100 && <p className="dim">已显示前 100 条，请细化关键词。</p>}
      </section>;
    })}
    {results && results.passages.length > 0 && <section className="card">
      <h2>文档正文</h2>
      <ul className="sub-list">{results.passages.map((hit) => <li className="sub-item" key={hit.chunkId}>
        <Link className="hit-title" to={`/chunk/${encodeURIComponent(hit.chunkId)}`}>{hit.documentTitle}</Link>
        <p>{hit.segments.map((segment, index) => segment.hit
          ? <mark key={index}>{segment.text}</mark> : segment.text)}</p>
      </li>)}</ul>
    </section>}
  </>;
}
