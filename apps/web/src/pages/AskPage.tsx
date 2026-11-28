import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ASK_HISTORY_LIMIT,
  evidenceMarker,
  type AskHistoryTurn,
  type AskResponse,
  type AskStreamEvent,
  type AskProcessV1,
  type Citation,
  type DocumentSummary,
  type ListDocumentsResponse,
  type Material,
  type OpenEvidence,
} from '@knowpilot/shared';
import { ApiError, apiGet, apiPostSse, isAbort, toApiError } from '../api.ts';
import { ConsentBar } from '../components/ConsentBar.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { EvidenceViewer, useEvidenceViewer } from '../components/evidence/EvidenceViewer.tsx';
import { answerEvidenceSources } from '../components/evidence/evidence-reader.ts';
import { NavGlyph } from '../nav-icons.tsx';
import { useAuth } from '../auth.tsx';
import { historyForAsk, readAskSession, writeAskSession, type AskActivity, type AskTabTurn, type SearchContext } from '../ask-session.ts';
import { AnswerBody } from './ask/AnswerMarkdown.tsx';
import { AnswerSources, sourceHref } from './ask/AnswerSources.tsx';
import { AnswerNotes, AskAnswer } from './ask/AskAnswer.tsx';
import { AskComposer, AskHistory } from './ask/AskConversation.tsx';
import { activityLabel, appendProcess, LiveElapsedTime, QueryDetails, type AskProcessProps, type TimelineStep } from './ask/AskProcess.tsx';
import { AskWorkspace } from './ask/AskWorkspace.tsx';
import { searchContextLink, useAskDocumentScope } from './ask/useAskDocumentScope.ts';
import './ask/ask.css';

/**
 * 勾选确认的记住位置。
 *
 * 带版本号（`.v1`）：这段话的语义将来若要改（比如出网范围变了），
 * 旧版本记下的"已同意"就不能再算数了。改文案时把版本号加一，
 * 所有人会重新看到勾选框 —— 否则改完文案，用户那边还是"早就勾过了"。
 */
const CONSENT_KEY = 'knowpilot.ask.consent.v1';
const NO_DRAFT_CITATIONS: ReadonlyMap<string, Citation> = new Map();

/**
 * 知识问答页。
 *
 * 【为什么这是阶段 2 的核心界面】
 *   阶段 1 的检索要求用户自己想到关键词；这一页让用户直接问问题，
 *   系统自己去查。代价是答案由模型组织，所以**回答里的每一句都必须能点回原文**
 *   —— 引用卡片和正文里的 [E1] 链接就是这条承诺的落点。
 *   实验室的答案（学位要求、查重率、投稿流程）答错是要出事的，
 *   用户必须能自己翻开原文核对。
 */
export interface AskPageSlots {
  renderAnswerBlocks?: (props: { response: AskResponse; onOpenEvidence: OpenEvidence }) => ReactNode;
  renderProcess?: (props: AskProcessProps) => ReactNode;
  renderEvidenceReader?: (props: { citations: readonly Citation[] }) => ReactNode;
}

export function AskPage({ active, scope, onActivity, slots }: {
  active: boolean;
  scope: string;
  onActivity: (activity: AskActivity) => void;
  slots?: AskPageSlots;
}) {
  const { user } = useAuth();
  const [turns, setTurns] = useState(() => readAskSession(scope));
  const [consent, setConsent] = useState(() => localStorage.getItem(CONSENT_KEY) === '1');
  const [question, setQuestion] = useState('');
  const documentSelection = useAskDocumentScope(active, scope, user?.id, setQuestion);
  const researchThread = documentSelection.origin?.researchThread;
  const relevantTurns = useMemo(() => turns.filter((turn) => turn.searchContext?.researchThread === researchThread), [turns, researchThread]);
  const restoredTurn = relevantTurns.at(-1);
  const [currentQuestion, setCurrentQuestion] = useState(() => restoredTurn?.question ?? '');
  const [result, setResult] = useState<AskResponse | null>(() => restoredTurn?.response ?? null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [stopped, setStopped] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const lastRequest = useRef<{ question: string; context: readonly AskHistoryTurn[] } | null>(
    restoredTurn === undefined ? null : { question: restoredTurn.question, context: historyForAsk(relevantTurns.slice(0, -1)) },
  );
  /** 证据池累计条数。用来说明"它真的在干活"，也是检索慢时唯一的变化 */
  const [evidenceTotal, setEvidenceTotal] = useState(0);
  /** 本次运行已经发生的步骤（O9 步骤时间线）。随流式事件追加，不清空重排。 */
  const [steps, setSteps] = useState<TimelineStep[]>([]);
  const [process, setProcess] = useState<AskProcessV1>();
  /** 本次提问的起始时刻（performance.now），用于把事件换算成相对偏移 */
  const runStartedAtRef = useRef(0);
  /**
   * 本次运行是否已经收到终态。
   *
   * 终态事件到达与流结束之间可能有延迟，流结束时据此保留答复状态。
   */
  const runEndedRef = useRef(false);
  /** 来源抽屉（O9）。点回答底部的「来源」打开，Esc / 遮罩 / 关闭按钮都能关。 */
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** 抽屉关闭后焦点回这里 —— 不依赖"打开时谁碰巧有焦点"。 */
  const sourceButtonRef = useRef<HTMLButtonElement>(null);
  /** 本次提问的原文；终态事件到达时用它追加一轮历史。`null` = 续跑，不追加。 */
  const questionRef = useRef<string | null>(null);
  const searchContextRef = useRef(restoredTurn?.searchContext);
  const abortRef = useRef<AbortController | null>(null);
  /** 推荐问题点一下要落回输入框，所以输入框自己留一个 ref。 */
  const questionInputRef = useRef<HTMLInputElement>(null);
  const currentQuestionRef = useRef<HTMLHeadingElement>(null);
  const previousThread = useRef(researchThread);

  useEffect(() => {
    if (previousThread.current === researchThread) return;
    previousThread.current = researchThread;
    if (abortRef.current !== null) {
      abortRef.current.abort();
      abortRef.current = null;
      onActivity('idle');
    }
    questionRef.current = null;
    const turn = relevantTurns.at(-1);
    searchContextRef.current = turn?.searchContext;
    lastRequest.current = turn === undefined ? null : {
      question: turn.question, context: historyForAsk(relevantTurns.slice(0, -1)),
    };
    setCurrentQuestion(turn?.question ?? '');
    setResult(turn?.response ?? null);
    setLoading(false);
    setDraftText('');
    setProgress(null);
    setEvidenceTotal(0);
    setError(null);
    setStopped(false);
    setSteps([]);
    setProcess(undefined);
    setDrawerOpen(false);
  }, [researchThread, relevantTurns, onActivity]);

  useEffect(() => writeAskSession(scope, turns), [scope, turns]);
  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);
  useEffect(() => {
    if (!active) setDrawerOpen(false);
  }, [active]);

  /**
   * 推荐问题（O15）：最近入库文档 → 模板化问题，**不调模型**。
   *
   * 取不到就留空、不显示这一块 —— 它是进入问答的引子，不是主功能；
   * 为它弹一条错误提示只会让人在还没提问前先看到一次故障。
   */
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  useEffect(() => {
    const ac = new AbortController();
    apiGet<ListDocumentsResponse>('/api/v1/documents?limit=8', ac.signal)
      .then((res) => setSuggestions(buildSuggestions(res.items)))
      .catch((err: unknown) => {
        if (isAbort(err)) return;
        setSuggestions([]);
      });
    return () => ac.abort();
  }, []);

  /** 问答与续跑共用同一套事件渲染：两条链路的 SSE 事件形状完全一致。 */
  const handleStreamEvent = useCallback((event: AskStreamEvent) => {
    switch (event.type) {
      case 'status':
        if (event.state !== 'end') setProgress(activityLabel(event));
        if (event.process?.version === 1 && event.process.step !== undefined && event.process.counts !== undefined) {
          const observation = event.process;
          setProcess((previous) => appendProcess(previous, observation));
          return;
        }
        setSteps((prev) => {
          if (event.state === 'end' && event.stepId !== undefined) {
            return prev.map((step) => step.stepId === event.stepId
              ? { ...step, ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }) }
              : step);
          }
          return [...prev, {
            label: activityLabel(event),
            ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
            atMs: event.atMs ?? performance.now() - runStartedAtRef.current,
            added: 0,
          }];
        });
        return;
      case 'evidence':
        // total 是累计值，直接覆盖。自己 += 的话，一旦漏收一帧
        // （比如某个 status 帧之后），数字就永久偏了。
        setEvidenceTotal(event.total);
        // 证据事件紧跟在某次查询工具结束之后 —— 归到最近一步，
        // 而不是新起一步（它没有自己的"开始"时刻）。
        setSteps((prev) => {
          if (prev.length === 0) return prev;
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last !== undefined) {
            next[next.length - 1] = {
              ...last,
              added: last.added + event.added,
            };
          }
          return next;
        });
        return;
      case 'draft_delta':
        setDraftText((previous) => previous + event.text);
        setProgress('正在生成回答');
        return;
      case 'draft_reset':
        setDraftText('');
        return;
      // 三种终态共用一套渲染；具体怎么提示由 `response.delivery.status` 决定。
      case 'verified_final':
      case 'partial':
      case 'interrupted': {
        runEndedRef.current = true;
        setDraftText('');
        setResult(event.response);
        const asked = questionRef.current;
        questionRef.current = null;
        if (event.type !== 'interrupted') {
          const response = event.response;
          const resumedQuestion = lastRequest.current?.question;
          setTurns((previous) => {
            const taskId = response.delivery.taskId;
            const existing = asked === null && taskId !== undefined
              ? previous.find((turn) => turn.response.delivery.taskId === taskId)
              : undefined;
            if (existing !== undefined) {
              return previous.map((turn) => turn === existing ? { ...turn, response } : turn);
            }
            const original = asked ?? resumedQuestion;
            if (original === undefined) return previous;
            const searchContext = searchContextRef.current;
            return [...previous, { question: original, response,
              ...(searchContext === undefined ? {} : { searchContext }) }].slice(-ASK_HISTORY_LIMIT);
          });
        }
        onActivity(event.type === 'interrupted' ? 'failed' : 'answered');
        return;
      }
      case 'failed':
        // 服务端已经把原因推过来了，与走普通接口时是同一个错误体，
        // 因此这里可以直接造一个 ApiError 交给 ErrorNotice 渲染。
        runEndedRef.current = true;
        setDraftText('');
        setError(new ApiError(event.error));
        onActivity('failed');
        return;
    }
  }, [onActivity]);

  const ask = useCallback(
    async (text: string, previousContext?: readonly AskHistoryTurn[]) => {
      if (!documentSelection.ready) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setCurrentQuestion(text);
      setLoading(true);
      onActivity('running');
      setError(null);
      setResult(null);
      setDraftText('');
      setStopped(false);
      setProgress(null);
      setEvidenceTotal(0);
      setSteps([]);
      setProcess(undefined);
      setDrawerOpen(false);
      runStartedAtRef.current = performance.now();
      runEndedRef.current = false;

      const context = [...(previousContext ?? historyForAsk(relevantTurns))].slice(-ASK_HISTORY_LIMIT);
      lastRequest.current = { question: text, context };
      questionRef.current = text;
      searchContextRef.current = documentSelection.origin;

      try {
        await apiPostSse(
          '/api/v1/ask/stream',
          {
            question: text,
            consentConfirmed: true,
            ...(documentSelection.documentScope === undefined ? {} : { documentScope: documentSelection.documentScope }),
            ...(context.length > 0 ? { history: context } : {}),
          },
          (event) => {
            if (abortRef.current === ac) handleStreamEvent(event);
          },
          ac.signal,
        );
      } catch (err) {
        // 用户点「停止」不算错误：他要的就是停。报错会在界面上留下一句
        // 他无法理解的失败提示，而他刚刚做的恰恰是一件完全正常的事。
        if (isAbort(err) || abortRef.current !== ac) return;
        runEndedRef.current = true;
        setError(toApiError(err));
        onActivity('failed');
      } finally {
        if (abortRef.current !== ac) return;
        abortRef.current = null;
        setLoading(false);
        setDraftText('');
        setProgress(null);
        if (!runEndedRef.current) onActivity('idle');
        // 中止/报错不会来终态事件；把这次的问题标记清掉，避免误导下一次运行。
        questionRef.current = null;
      }
    },
    [documentSelection.ready, documentSelection.documentScope, documentSelection.origin, handleStreamEvent, onActivity, relevantTurns],
  );

  /**
   * 继续一次被中断的调查（S7/X1b）。
   *
   * 不再提交问题文本：问题与已完成的步骤都在服务端检查点里，页面刷新后
   * 仍能续跑。必须由用户显式点击 —— 断线不等于"我愿意再花一次钱"。
   */
  const resume = useCallback(
    async (taskId: string) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setLoading(true);
      onActivity('running');
      setError(null);
      setResult(null);
      setDraftText('');
      setStopped(false);
      setProgress(null);
      setEvidenceTotal(0);
      setSteps([]);
      setProcess(undefined);
      setDrawerOpen(false);
      runStartedAtRef.current = performance.now();
      runEndedRef.current = false;

      // 续跑不是新的一轮：终态到达时不得往对话历史里再追加一条。
      questionRef.current = null;

      try {
        await apiPostSse(
          `/api/v1/agent-tasks/${encodeURIComponent(taskId)}/resume`,
          {},
          (event) => {
            if (abortRef.current === ac) handleStreamEvent(event);
          },
          ac.signal,
        );
      } catch (err) {
        if (isAbort(err) || abortRef.current !== ac) return;
        runEndedRef.current = true;
        setError(toApiError(err));
        onActivity('failed');
      } finally {
        if (abortRef.current !== ac) return;
        abortRef.current = null;
        setLoading(false);
        setDraftText('');
        setProgress(null);
        if (!runEndedRef.current) onActivity('idle');
      }
    },
    [handleStreamEvent, onActivity],
  );

  function stopRun() {
    abortRef.current?.abort();
    setStopped(true);
    setDraftText('');
    setLoading(false);
    onActivity('idle');
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = question.trim();
    if (text === '' || !consent || loading || !documentSelection.ready) return;
    setQuestion('');
    void ask(text);
  }

  function onConsentChange(checked: boolean) {
    setConsent(checked);
    // 只记"同意"，不记"取消"。取消勾选时清掉记录，下次进来仍需重新确认 ——
    // 记住了"他拒绝过"没有任何用处，而那会让下次的默认状态变得难以解释。
    if (checked) localStorage.setItem(CONSENT_KEY, '1');
    else localStorage.removeItem(CONSENT_KEY);
  }

  const closeReader = useCallback(() => setDrawerOpen(false), []);

  function retryLastRequest() {
    const request = lastRequest.current;
    if (consent && documentSelection.ready && request !== null &&
      searchContextRef.current?.researchThread === researchThread) {
      void ask(request.question, request.context);
    }
  }

  function clearHistory() {
    setTurns((previous) => previous.filter((turn) => turn.searchContext?.researchThread !== researchThread));
  }

  function showTurn(turn: AskTabTurn) {
    setResult(turn.response);
    setCurrentQuestion(turn.question);
    setSteps([]);
    setProcess(undefined);
    setError(null);
    setStopped(false);
    setDrawerOpen(false);
    const match = relevantTurns.indexOf(turn);
    searchContextRef.current = turn.searchContext;
    lastRequest.current = match < 0 ? null : { question: turn.question, context: historyForAsk(relevantTurns.slice(0, match)) };
    currentQuestionRef.current?.focus({ preventScroll: true });
    currentQuestionRef.current?.scrollIntoView({ block: 'center' });
  }

  const latestTurn = relevantTurns.at(-1);
  const visibleTurn = turns.find((turn) => turn.response.runId === result?.runId);
  const resultOrigin = visibleTurn === undefined ? searchContextRef.current : visibleTurn.searchContext;
  const answerSearch = resultOrigin ?? { query: result?.followUpRewrite?.rewritten ?? currentQuestion };
  const isFollowUp = relevantTurns.length > 0;
  const resumedDocuments = result?.documentScope?.documents;
  const currentDocuments = documentSelection.documentScope?.documents;
  const canResumeInScope = documentSelection.ready &&
    resultOrigin?.researchThread === researchThread &&
    (resumedDocuments === undefined
    ? currentDocuments === undefined
    : resumedDocuments.length === currentDocuments?.length &&
      resumedDocuments.every((doc) => currentDocuments.some((item) => item.id === doc.id && item.version === doc.version)));

  const byId = new Map<string, Citation>(
    (result?.answer.citations ?? []).map((c) => [c.id, c]),
  );
  const sources = result?.answer.citations ?? [];
  const catalog = useMemo(
    () => !active || result === null ? [] : answerEvidenceSources(result.runId, result.answer.citations, sourceHref),
    [active, result],
  );
  const evidence = useEvidenceViewer(catalog, JSON.stringify([active, scope, result?.runId]));
  const openEvidence: OpenEvidence = (request) => {
    if (!evidence.onOpenEvidence(request)) return false;
    setDrawerOpen(false);
    return true;
  };
  const readerOpen = active && drawerOpen && sources.length > 0;
  function toggleSources() {
    evidence.reader?.onClose();
    setDrawerOpen((open) => !open);
  }
  // 只有服务端明确说"可续跑"时才给按钮：任务可能已过期、已被别的请求接管、
  // 或本次是正常结束 —— 这些都由 resumeAvailable 表达，前端不自行推断。
  const resumeTaskId =
    result?.delivery.resumeAvailable === true ? result.delivery.taskId : undefined;

  const processProps: AskProcessProps = result === null
    ? { steps, process, runningSince: active && loading ? runStartedAtRef.current : undefined,
        endState: stopped ? 'cancelled' : error === null ? undefined : 'failed' }
    : { steps, process: result.process, elapsedMs: result.answer.durationMs, warnings: result.answer.warnings,
        showUnavailable: true };

  return (
    <EvidenceViewer reader={evidence.reader}><AskWorkspace reader={{
      open: readerOpen,
      title: `来源（${sources.length}）`,
      onClose: closeReader,
      triggerRef: sourceButtonRef,
      children: readerOpen
        ? (slots?.renderEvidenceReader === undefined
          ? <AnswerSources citations={sources} {...(result === null ? {} : {
              citationOpen: { runId: result.runId, onOpenEvidence: (request) => {
                if (!evidence.openFrom(request, sourceButtonRef.current)) return false;
                setDrawerOpen(false);
                return true;
              } },
            })} />
          : slots.renderEvidenceReader({ citations: sources }))
        : null,
    }}>
      <div className="page-head">
        <div className="page-head-main">
          <div className="page-title"><span className="page-title-icon"><NavGlyph name="ask" size={32} /></span><h1>知识问答</h1></div>
          <p className="lead">问组内资料、成果或投稿进展。</p>
        </div>
      </div>

      {/* 常驻告知：不论勾没勾过都显示 —— 只勾一次就永久记住的话，
          换了台机器的人、或者看到同事屏幕的人，完全看不到"内容会出网"这件事。
          但**勾过之后收成一行**（原先那块 6 行的黄框天天挡在这里，用一周就没人读了）。 */}
      <ConsentBar
        checked={consent}
        onCheckedChange={onConsentChange}
        pending="提问内容与命中的文档片段会发往云端模型"
        granted="已授权：提问内容与命中片段会发往 DeepSeek 处理"
      >
        <p style={{ margin: 0 }}>
          你的问题与系统检索命中的文档片段会发送至 <b>DeepSeek</b> 处理，即离开实验室内部网络。
          <br />
          若问题涉及<b>投稿中的稿件</b>，请注意期刊的保密要求；已发表论文与公开制度无此风险。
        </p>
      </ConsentBar>

      {documentSelection.kind !== 'all' && (
        <section className="card ask-scope" aria-label="问答资料范围">
          <h2>仅检索所选资料</h2>
          {documentSelection.pending && <p role="status">正在核对资料范围…</p>}
          {!documentSelection.pending && !documentSelection.ready && (
            <p role="alert">选定资料不可用或版本已变化。请移除失效资料、重新选择，或主动改为全库检索。</p>
          )}
          {documentSelection.selectedIds.length > 0 && <ul>
            {documentSelection.selectedIds.map((id, index) => {
              const title = documentSelection.items.get(id)?.title ?? `资料 ${index + 1}`;
              return <li key={id}><span>{title}</span>{' '}
                <button type="button" disabled={loading} onClick={() => documentSelection.remove(id)} aria-label={`移除${title}`}>移除</button>
              </li>;
            })}
          </ul>}
          <Link {...searchContextLink(documentSelection.origin ?? { query: '' }, user?.id)}>返回检索选资料</Link>{' '}
          <button type="button" disabled={loading} onClick={documentSelection.clear}>改为全库检索</button>
        </section>
      )}

      <AskComposer
        question={question} questionInputRef={questionInputRef} consent={consent} loading={loading}
        scopeReady={documentSelection.ready}
        isFollowUp={isFollowUp} showSuggestions={result === null && turns.length === 0 && !loading}
        suggestions={suggestions} onQuestionChange={setQuestion} onSubmit={onSubmit} onStop={stopRun}
      />

      {currentQuestion !== '' && (
        <div className="ask-current-head">
          <h2 ref={currentQuestionRef} tabIndex={-1}>{currentQuestion}</h2>
          {result !== null && latestTurn !== undefined && turns.some((turn) => turn.response.runId === result.runId) &&
            result.runId !== latestTurn.response.runId && (
              <button type="button" className="link-btn" onClick={() => showTurn(latestTurn)}>返回最新问答</button>
            )}
        </div>
      )}
      {loading && result === null && error === null && !stopped && (
        <div className="card ask-live" aria-label="回答进度">
          <div className="ask-live-head">
            <span className="ask-live-dot" aria-hidden="true" />
            <span role="status">{progress ?? '正在开始查询'}</span>
          </div>
          {process === undefined && evidenceTotal > 0 && <p className="ask-live-meta">已找到 {evidenceTotal} 条资料线索</p>}
          {slots?.renderProcess === undefined ? <QueryDetails {...processProps} /> : slots.renderProcess(processProps)}
          {draftText.trim() !== '' && (
            <section className="ask-live-draft" aria-label="回答草稿">
              <p className="ask-draft-label">回答草稿，内容可能更新</p>
              <AnswerBody text={draftText.replace(evidenceMarker(), '')} byId={NO_DRAFT_CITATIONS} />
            </section>
          )}
          {active && <p className="ask-answer-time">已用时 <LiveElapsedTime startedAt={runStartedAtRef.current} /></p>}
        </div>
      )}
      {stopped && <p className="ask-answer-note" role="status">已停止本次查询。</p>}

      {error !== null && <ErrorNotice error={error} onRetry={retryLastRequest} />}
      {result === null && (stopped || error !== null) &&
        (slots?.renderProcess === undefined ? <QueryDetails {...processProps} /> : slots.renderProcess(processProps))}

      {result !== null && (
        <>
          <AskAnswer
            result={result}
            onOpenEvidence={openEvidence}
            byId={byId}
            consent={consent}
            reviewActive={active}
            sourceCount={sources.length}
            readerOpen={readerOpen}
            sourceButtonRef={sourceButtonRef}
            onToggleReader={toggleSources}
            onRetry={retryLastRequest}
            documentSearchLink={(id) => searchContextLink(answerSearch, user?.id, id)}
            blocks={slots?.renderAnswerBlocks?.({ response: result, onOpenEvidence: openEvidence })}
          />

          {resumeTaskId !== undefined && !canResumeInScope && (
            <p className="ask-answer-note">原任务的检索范围与当前不同。请切回原范围，或用当前范围重新提问。</p>
          )}
          {resumeTaskId !== undefined && canResumeInScope && (
            <div className="ask-resume-line">
              <span>还需要更多资料？</span>
              <button type="button" onClick={() => void resume(resumeTaskId)}>继续查找依据</button>
            </div>
          )}

          <AnswerNotes answer={result.answer} />

          {slots?.renderProcess === undefined ? <QueryDetails {...processProps} /> : slots.renderProcess(processProps)}

        </>
      )}

      <AskHistory turns={relevantTurns} selectedRunId={result?.runId} loading={loading} onSelect={showTurn} onClear={clearHistory} />
    </AskWorkspace></EvidenceViewer>
  );
}

/**
 * 推荐问题的模板（O15）。
 *
 * 【为什么按材料类型分，而不是一句通用问法】问一篇论文「用了什么方法」、
 * 问一条制度「有哪些必须遵守的要求」，都直接指向那类文档里最值得核对的事实；
 * 通用问法（「这份文档讲了什么」）会把用户带回"读一遍原文"，
 * 比空着还费时间。
 *
 * 【为什么不用模型生成】推荐问题只是进入问答的引子，不该在用户还没提问前
 * 就产生一次云端调用与一份内容出网。模板由标题与类型拼出来，零成本、可预期；
 * 标题本身是用户自己的材料，不额外泄露。
 */
const SUGGESTION_TEMPLATES: Record<Material, (title: string) => string> = {
  paper: (t) => `《${t}》用了什么方法？`,
  knowledge: (t) => `「${t}」具体指什么？`,
  experience: (t) => `《${t}》总结了哪些经验？`,
  sop: (t) => `《${t}》的关键步骤是什么？`,
  rule: (t) => `《${t}》有哪些必须遵守的要求？`,
};

/** 最多 4 条；跳过没有可检索块的文档（解析没产出内容，问了也答不了）。 */
function buildSuggestions(docs: readonly DocumentSummary[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const doc of docs) {
    if (out.length >= 4) break;
    if (doc.chunkCount === 0) continue;
    // 24 字：药丸在一行内放得下；标题只用来"认出是哪一份"，不需要读全。
    const short = doc.title.length > 24 ? `${doc.title.slice(0, 24)}…` : doc.title;
    const q = SUGGESTION_TEMPLATES[doc.material](short);
    if (seen.has(q)) continue;
    seen.add(q);
    out.push(q);
  }
  return out;
}
