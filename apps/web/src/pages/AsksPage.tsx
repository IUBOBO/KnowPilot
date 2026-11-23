import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { answerPreview, RECORD_TYPE_LABELS, type AskHistoryRecord, type AskRecordSource, type ListAskRecordsResponse } from '@knowpilot/shared';
import { apiGet, isAbort, toApiError, type ApiError } from '../api.ts';
import { readAskSession } from '../ask-session.ts';
import { useAuth } from '../auth.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { PageTitle } from '../components/PageTitle.tsx';
import { SkeletonList } from '../components/Skeleton.tsx';
import { CNY_RATE_NOTE, formatCnyFromUsd } from '../currency.ts';
import { fmtDateTime, formatAnswerQueryTimes } from '../format.ts';
import { OUTCOME_LABELS, outcomeTone } from '../outcome.ts';

const LIMIT = 20;

export function AsksPage() {
  const { user } = useAuth();
  const [data, setData] = useState<ListAskRecordsResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [search, setSearch] = useState('');
  const [request, setRequest] = useState({ page: 1, keyword: '' });
  const toolbarRef = useRef<HTMLDivElement>(null);
  const { page, keyword } = request;
  const localTurns = user === null ? [] : readAskSession(`${user.id}:${user.role}`);

  useEffect(() => {
    const ac = new AbortController();
    const url = `/api/v1/ask-records?limit=${LIMIT}&offset=${(page - 1) * LIMIT}&q=${encodeURIComponent(keyword)}`;
    apiGet<ListAskRecordsResponse>(url, ac.signal).then((response) => {
      if (!ac.signal.aborted) setData(response);
    }).catch((err: unknown) => {
      if (!ac.signal.aborted && !isAbort(err)) setError(toApiError(err));
    });
    return () => ac.abort();
  }, [request, page, keyword]);

  function load(nextPage: number, nextKeyword = keyword) {
    if (nextPage !== page) toolbarRef.current?.scrollIntoView({ block: 'start' });
    setData(null);
    setError(null);
    setRequest({ page: nextPage, keyword: nextKeyword });
  }

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    load(1, search.trim());
  }

  return (
    <>
      <PageTitle icon="history">问答记录</PageTitle>
      <div className="card ask-history-card">
        <div className="ask-history-toolbar" ref={toolbarRef}>
          <form className="ask-history-actions" role="search" onSubmit={onSearch}>
            <input type="search" aria-label="搜索历史提问" placeholder="搜索问题关键词" value={search}
              maxLength={300} onChange={(event) => setSearch(event.target.value)} />
            <button type="submit">搜索</button>
            <button type="button" className="link-btn" onClick={() => load(page)}>刷新</button>
          </form>
        </div>
        {error !== null && <ErrorNotice error={error} onRetry={() => load(page)} />}
        {data === null && error === null && <SkeletonList rows={4} />}
        {data !== null && data.items.length === 0 && (
          <EmptyState icon="history" action={keyword === '' && page === 1
            ? <Link className="link-btn" to="/ask">去提第一个问题</Link> : undefined}>
            {keyword === '' ? '这一页没有问答记录。' : '没有找到包含这个关键词的问题。'}
          </EmptyState>
        )}
        {data !== null && data.items.length > 0 && (
          <ul className="ask-list">
            {data.items.map((record) => {
              const localTurn = localTurns.find((turn) => turn.response.runId === record.runId);
              const preview = record.answerPreview ?? (localTurn === undefined ? null : answerPreview(localTurn.response.answer.answer));
              return <AskItem key={record.runId} record={record} preview={preview} />;
            })}
          </ul>
        )}
        {(page > 1 || data?.hasMore === true) && (
          <nav className="ask-history-pagination" aria-label="问答记录分页">
            <button type="button" disabled={page === 1 || data === null} onClick={() => load(page - 1)}>上一页</button>
            <span aria-live="polite">第 {page} 页</span>
            <button type="button" disabled={data?.hasMore !== true} onClick={() => load(page + 1)}>下一页</button>
          </nav>
        )}
      </div>
    </>
  );
}

function AskItem({ record, preview }: { record: AskHistoryRecord; preview: string | null }) {
  const sources = record.sources ?? null;
  return (
    <li className="ask-item">
      <div className="ask-head">
        <h3 className="ask-question">{record.question}</h3>
        {record.outcome !== 'ok' && <span className={`pill ${outcomeTone(record.outcome)}`}>{OUTCOME_LABELS[record.outcome]}</span>}
        <time className="record-date-value ask-record-date" dateTime={record.askedAt}>{fmtDateTime(record.askedAt)}</time>
      </div>
      {preview !== null && (
        <p className="ask-history-preview"><strong>答案摘要</strong> {formatAnswerQueryTimes(preview)}</p>
      )}
      <p className="ask-meta" title={CNY_RATE_NOTE}>费用估算 <strong>{formatCnyFromUsd(record.usage.costUsd)}</strong></p>
      <div className="ask-history-sources">
        <span className="dim">引用来源</span>
        {sources === null ? <span className="dim">未记录</span> : sources.length === 0
          ? <span className="dim">暂无可显示的引用</span>
          : <SourceList sources={sources} />}
      </div>
      {record.otherSources?.length > 0 && (
        <details className="ask-history-more">
          <summary>其他检索命中（{record.otherSources.length}）</summary>
          <SourceList sources={record.otherSources} />
        </details>
      )}
    </li>
  );
}

function SourceList({ sources }: { sources: readonly AskRecordSource[] }) {
  return (
    <ul className="ask-history-source-list">
      {sources.map((source, index) => {
        const id = encodeURIComponent(source.id);
        const title = encodeURIComponent(source.title);
        const url = {
          document: `/chunk/${id}`,
          'M-CODE': `/datasets?focus=${id}`,
          'M-JOURNAL': `/journals?q=${title}`,
          'M-PATENT': `/patents?q=${title}&focus=${id}`,
          'M-SUBMIT': `/submissions?focus=${id}`,
          'M-THESIS': `/theses?focus=${id}`,
          'M-PERSON': `/people?q=${title}&focus=${id}`,
        }[source.type];
        const label = source.type === 'document' ? '知识库文档' : RECORD_TYPE_LABELS[source.type];
        return (
          <li key={`${source.type}:${source.id}`}>
            <Link to={url} title={`${label} · ${source.title}`}>
              <span className="ask-history-source-number">{index + 1}</span>
              <span className="ask-history-source-title">{source.title}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
