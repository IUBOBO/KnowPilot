import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AskWarningNotice } from '../components/AskWarningNotice.tsx';
import {
  ASK_HISTORY_LIMIT,
  FEEDBACK_DOWN_REASONS,
  FEEDBACK_NOTE_MAX_CHARS,
  FEEDBACK_REASON_LABELS,
  MATERIAL_LABELS,
  RECORD_TYPE_LABELS,
  evidenceMarker,
  extractEvidenceIds,
  formatSectionPath,
  readAnswerTable,
  type Answer,
  type AnswerFeedback,
  type AskEvidenceReview,
  type AskHistoryTurn,
  type AskResponse,
  type AskStatusEvent,
  type AskStreamEvent,
  type Citation,
  type DocumentCitation,
  type DocumentSummary,
  type FeedbackDownReason,
  type FeedbackRating,
  type ListDocumentsResponse,
  type Material,
  type RecordCitation,
  type SubmitFeedbackResponse,
} from '@knowpilot/shared';
import { ApiError, apiGet, apiPost, apiPostSse, isAbort, toApiError } from '../api.ts';
import { ConsentBar } from '../components/ConsentBar.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Modal } from '../components/Modal.tsx';
import { NavGlyph } from '../nav-icons.tsx';
import { formatCnyFromUsd } from '../currency.ts';
import { fmtDateTime, fmtQueryTime, formatAnswerQueryTimes } from '../format.ts';
import { historyForAsk, readAskSession, writeAskSession, type AskActivity, type AskTabTurn } from '../ask-session.ts';

/**
 * 勾选确认的记住位置。
 *
 * 带版本号（`.v1`）：这段话的语义将来若要改（比如出网范围变了），
 * 旧版本记下的"已同意"就不能再算数了。改文案时把版本号加一，
 * 所有人会重新看到勾选框 —— 否则改完文案，用户那边还是"早就勾过了"。
 */
const CONSENT_KEY = 'knowpilot.ask.consent.v1';

/**
 * 引用卡片里摘录的预览长度。
 *
 * 卡片里铺满整块原文（可能上千字）会让引用列表变成一堵墙，
 * 反而看不出"这条引的是哪一句"。截断到能认出内容即可，
 * 要看全文点「查看原文」—— 那本来就是它的用途。
 */
const EXCERPT_PREVIEW = 240;

/**
 * 引用悬浮卡里的摘录长度（O9）。
 *
 * 比引用卡片更短：悬浮卡盖在正文上方，读者要的是"这句引的是哪一段"，
 * 不是把整块原文再读一遍。完整内容点编号进原文页。
 */
const CITE_POP_PREVIEW = 140;

/**
 * 流式过程中累积的一步（O9）。
 *
 * 新版 status 用 stepId 对齐开始与结束，durationMs 是服务端实测。
 * 旧服务没有结束字段时保留相邻事件估算；evidence 落在最近的检索步骤上。
 */
interface TimelineStep {
  label: string;
  stepId?: string;
  durationMs?: number;
  /** 相对本次提问开始的毫秒偏移 */
  atMs: number;
  /** 这一步新增的证据条数（没有则是 0） */
  added: number;
  /** 这一步结束后证据池的累计条数 */
}

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
export function AskPage({ active, scope, onActivity }: {
  active: boolean;
  scope: string;
  onActivity: (activity: AskActivity) => void;
}) {
  const [turns, setTurns] = useState(() => readAskSession(scope));
  const [consent, setConsent] = useState(() => localStorage.getItem(CONSENT_KEY) === '1');
  const [question, setQuestion] = useState('');
  const [currentQuestion, setCurrentQuestion] = useState(() => turns.at(-1)?.question ?? '');
  const [result, setResult] = useState<AskResponse | null>(() => turns.at(-1)?.response ?? null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [stopped, setStopped] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const restoredTurn = turns.at(-1);
  const lastRequest = useRef<{ question: string; context: readonly AskHistoryTurn[] } | null>(
    restoredTurn === undefined ? null : { question: restoredTurn.question, context: historyForAsk(turns.slice(0, -1)) },
  );
  /** 证据池累计条数。用来说明"它真的在干活"，也是检索慢时唯一的变化 */
  const [evidenceTotal, setEvidenceTotal] = useState(0);
  /** 本次运行已经发生的步骤（O9 步骤时间线）。随流式事件追加，不清空重排。 */
  const [steps, setSteps] = useState<TimelineStep[]>([]);
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
  const abortRef = useRef<AbortController | null>(null);
  /** 推荐问题点一下要落回输入框，所以输入框自己留一个 ref。 */
  const questionInputRef = useRef<HTMLInputElement>(null);
  const currentQuestionRef = useRef<HTMLHeadingElement>(null);

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
            return [...previous, { question: original, response }].slice(-ASK_HISTORY_LIMIT);
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
      setDrawerOpen(false);
      runStartedAtRef.current = performance.now();
      runEndedRef.current = false;

      const context = [...(previousContext ?? historyForAsk(turns))].slice(-ASK_HISTORY_LIMIT);
      lastRequest.current = { question: text, context };
      questionRef.current = text;

      try {
        await apiPostSse(
          '/api/v1/ask/stream',
          {
            question: text,
            consentConfirmed: true,
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
    [handleStreamEvent, onActivity, turns],
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
    if (text === '' || !consent || loading) return;
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

  function clearHistory() {
    writeAskSession(scope, []);
    setTurns([]);
  }

  function showTurn(turn: AskTabTurn) {
    setResult(turn.response);
    setCurrentQuestion(turn.question);
    setSteps([]);
    setError(null);
    setStopped(false);
    setDrawerOpen(false);
    lastRequest.current = { question: turn.question, context: historyForAsk(turns.slice(0, turns.indexOf(turn))) };
    currentQuestionRef.current?.focus({ preventScroll: true });
    currentQuestionRef.current?.scrollIntoView({ block: 'center' });
  }

  const latestTurn = turns.at(-1);
  const isFollowUp = latestTurn !== undefined;
  const byId = new Map<string, Citation>(
    (result?.answer.citations ?? []).map((c) => [c.id, c]),
  );
  const sources = result?.answer.citations ?? [];
  // 只有服务端明确说"可续跑"时才给按钮：任务可能已过期、已被别的请求接管、
  // 或本次是正常结束 —— 这些都由 resumeAvailable 表达，前端不自行推断。
  const resumeTaskId =
    result?.delivery.resumeAvailable === true ? result.delivery.taskId : undefined;

  return (
    <>
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

      <div className="card">
        <form className="ask-form" onSubmit={onSubmit}>
          <label className="field">
            <span>{isFollowUp ? '继续追问' : '你的问题'}</span>
            <input
              ref={questionInputRef}
              type="text"
              value={question}
              placeholder={isFollowUp ? '输入下一条问题' : '例如：硕士论文查重率要求是多少？'}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </label>
          {/* 两个按钮必须有各自的 key，不能被 React 当成同一个节点来回改属性。
              原因不是样式，是一个真实的坑：
                「停止」是 type=button，点它会 abort；abort 让 loading 立刻变 false，
                React 于是在**这次点击的处理函数里**就把同一个节点改成了 type=submit。
                而浏览器的默认动作（提交表单）是在事件派发**之后**才执行的，
                它读到的已经是改过的 type —— 于是"点停止"会顺带把问题重问一遍：
                多一次云端调用、多一份数据出网、多一条记录，界面上却看不出来。
              给不同的 key，React 就会换一个新节点，被点击的那个节点始终是 type=button。 */}
          {loading ? (
            // 流式期间把它变成「停止」：一等等十几秒，用户得有个出路。
            // 点了之后服务端会收到断开、把这次运行记成 aborted 并立刻停止烧 token。
            <button key="stop" type="button" onClick={stopRun}>
              停止
            </button>
          ) : (
            // 未勾选时**把原因写在按钮上**，而不是在下面补一句灰字
            //（「界面整理-new」§三：能写在控件上的话就别另起一行说）。
            <button
              key="ask"
              type="submit"
              disabled={!consent || question.trim() === ''}
            >
              {consent ? (isFollowUp ? '追问' : '提问') : '请先勾选上方云端确认'}
            </button>
          )}
        </form>

        {/* 首屏的推荐问题：只在"还没问过任何东西"时出现。
            点一下**只填入输入框、不自动发送** —— 自动发送会让人在没看清问题、
            也没确认云端同意的情况下就把内容发出去。 */}
        {result === null && turns.length === 0 && !loading && suggestions.length > 0 && (
          <div className="suggest">
            <p className="suggest-title">试试这样问</p>
            <div className="suggest-list">
              {suggestions.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="suggest-chip"
                  onClick={() => {
                    setQuestion(q);
                    questionInputRef.current?.focus();
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

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
          {evidenceTotal > 0 && <p className="ask-live-meta">已找到 {evidenceTotal} 条资料线索</p>}
          <QueryDetails steps={steps} runningSince={active ? runStartedAtRef.current : undefined} />
          {draftText.trim() !== '' && (
            <section className="ask-live-draft" aria-label="回答草稿">
              <p className="ask-draft-label">回答草稿，内容可能更新</p>
              <AnswerBody text={draftText.replace(evidenceMarker(), '')} byId={byId} />
            </section>
          )}
          {active && <p className="ask-answer-time">已用时 <LiveElapsedTime startedAt={runStartedAtRef.current} /></p>}
        </div>
      )}
      {stopped && <p className="ask-answer-note" role="status">已停止本次查询。</p>}

      {error !== null && <ErrorNotice error={error} onRetry={() => {
        const request = lastRequest.current;
        if (consent && request !== null) void ask(request.question, request.context);
      }} />}

      {result !== null && (
        <>
          <div className="card">
            <p className="hit-head"><span className="hit-title">回答</span></p>
            {/* 用户写的是一句依赖上文的追问，系统实际拿去检索的是另一句。
                把这句话摆出来：答非所问时，用户第一眼就能判断是"理解错了"，
                而不是把一句错误的回答当成资料的结论。 */}
            {result.followUpRewrite !== undefined && result.followUpRewrite.changed && (
              <p className="dim" style={{ fontSize: '0.78125rem', margin: '0 0 10px' }}>
                追问按上文理解为：<b>{result.followUpRewrite.rewritten}</b>
              </p>
            )}
            <FinalAnswerBody text={result.answer.answer} byId={byId} />
            {result.delivery.status === 'interrupted' && <p className="ask-answer-note">查询中断。可以继续查找。</p>}
            {result.delivery.status === 'partial' && result.answer.verification.counts.contradicted > 0 && (
              <p className="ask-answer-note">部分说法与资料不一致，请结合来源核对。</p>
            )}
            <p className="ask-answer-time">用时 {formatElapsed(result.answer.durationMs)}</p>
            {/* 逐条要点可直达原文；这里仍保留汇总抽屉，用于核对全部来源。 */}
            {sources.length > 0 ? (
              <p className="answer-tools">
                <button
                  ref={sourceButtonRef}
                  type="button"
                  className="link-btn"
                  onClick={() => setDrawerOpen(true)}
                >
                  来源（{sources.length}）
                </button>
              </p>
            ) : null}
            {result.answer.citations.length > 0 && (
              <AnswerEvidenceReview key={`review-${result.runId}`} response={result} consent={consent} byId={byId} />
            )}
            {/* O16：确定性出口。服务端只在"某类记录查询 0 命中"或
                "整次回答没有任何引用且列了依据缺口"时给；前端不自己推断。 */}
            {result.nextActions !== undefined && result.nextActions.length > 0 && (
              <div className="next-actions">
                <p className="next-actions-title">下一步</p>
                <div className="next-actions-list">
                  {result.nextActions.map((action) => action.kind === 'retry-query' ? (
                    <button key={action.kind} type="button" className="next-action" disabled={!consent} onClick={() => {
                      const request = lastRequest.current;
                      if (request !== null) void ask(request.question, request.context);
                    }}>
                      <span>{action.label}</span>
                      <span className="next-action-hint">{action.hint}</span>
                    </button>
                  ) : (
                    <Link key={action.kind} className="next-action" to={action.to}>
                      <span>{action.label}</span>
                      <span className="next-action-hint">{action.hint}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {/* key 换 runId 就重置：反馈属于**这一次**运行，续跑是新 run，
                上一轮的"已记录"不能跟着显示到新一轮上。 */}
            <AnswerFeedbackBar key={result.runId} runId={result.runId} />
          </div>

          {resumeTaskId !== undefined && (
            <div className="ask-resume-line">
              <span>还需要更多资料？</span>
              <button type="button" onClick={() => void resume(resumeTaskId)}>继续查找依据</button>
            </div>
          )}

          <AnswerNotes answer={result.answer} />

          <QueryDetails steps={steps} elapsedMs={result.answer.durationMs} warnings={result.answer.warnings} />

          <Modal
            open={active && drawerOpen}
            variant="drawer"
            title={`来源（${sources.length}）`}
            onClose={() => setDrawerOpen(false)}
            returnFocusTo={sourceButtonRef}
            footer={
              <button type="button" onClick={() => setDrawerOpen(false)}>
                关闭
              </button>
            }
          >
            <p className="dim drawer-lead">
              点击文中的编号，可以直接查看对应的原文或记录。
            </p>
            {sources.map((c) => (
              <CitationCard key={c.id} citation={c} />
            ))}
          </Modal>
        </>
      )}

      {turns.length > 0 && (
        <details className="answer-notes">
          <summary>问答历史（{turns.length}/{ASK_HISTORY_LIMIT} 轮）</summary>
          <ul className="ask-recent-turns">
            {turns.toReversed().map((turn) => (
              <li key={turn.response.runId}>
                <button type="button" className="link-btn" disabled={loading}
                  aria-current={result?.runId === turn.response.runId ? 'true' : undefined}
                  onClick={() => showTurn(turn)}>
                  {turn.question}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="link-btn" disabled={loading} onClick={clearHistory}>
            清除上文
          </button>
        </details>
      )}
    </>
  );
}

function FinalAnswerBody({ text, byId }: { text: string; byId: ReadonlyMap<string, Citation> }) {
  const heading = /^##[ \t]+详细说明[ \t]*[：:]?[ \t]*$/mu.exec(text);
  if (heading === null || heading.index === 0) return <AnswerBody text={text} byId={byId} />;
  const details = text.slice(heading.index + heading[0].length).trim();
  return (
    <>
      <AnswerBody text={text.slice(0, heading.index)} byId={byId} />
      {details !== '' && (
        <details className="answer-notes">
          <summary>详细说明</summary>
          <AnswerBody text={details} byId={byId} />
        </details>
      )}
    </>
  );
}

function AnswerEvidenceReview({ response, consent, byId }: {
  response: AskResponse;
  consent: boolean;
  byId: ReadonlyMap<string, Citation>;
}) {
  const [review, setReview] = useState<AskEvidenceReview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const hintId = useId();
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function submit() {
    if (!consent || active.current !== null) return;
    const ac = new AbortController();
    active.current = ac;
    setLoading(true);
    setError(null);
    try {
      const result = await apiPost<AskEvidenceReview>(
        `/api/v1/ask-records/${encodeURIComponent(response.runId)}/review`,
        { answer: response.answer.answer, consentConfirmed: true }, ac.signal,
      );
      if (!ac.signal.aborted) setReview(result);
    } catch (err) {
      if (!ac.signal.aborted && !isAbort(err)) setError(toApiError(err));
    } finally {
      active.current = null;
      if (!ac.signal.aborted) setLoading(false);
    }
  }

  return (
    <div className="answer-review">
      {review === null ? (
        <div className="answer-review-action">
          <button type="button" className="link-btn" onClick={() => void submit()} disabled={loading || !consent}
            aria-describedby={hintId} title={consent ? undefined : '请先确认云端处理授权'}>
            {loading ? '正在复核依据…' : '复核依据'}
          </button>
          <span className="answer-review-hint" id={hintId}>点击后，DeepSeek 会对照原文检查引用是否支持回答，另计 Token 用量和费用。</span>
        </div>
      ) : (
        <section aria-label="模型复核结果">
          <p className="ask-review-heading"><strong>模型复核</strong>
            <span>{review.costUsd === null ? '费用未记录' : `费用估算 ${formatCnyFromUsd(review.costUsd)}`}</span>
          </p>
          {review.unavailableSourceCount > 0 && (
            <p className="dim">有 {review.unavailableSourceCount} 个引用未纳入本次复核。</p>
          )}
          <ul>
            {review.claims.map((claim, index) => (
              <li key={index}>
                <strong>{claim.statement}</strong>{' '}
                <span className={`pill ${{ supported: 'ok', insufficient: 'warn', contradicted: 'err' }[claim.verdict]}`}>
                  {{ supported: '原文支持', insufficient: '依据不足', contradicted: '与原文冲突' }[claim.verdict]}
                </span>
                <p>{claim.reason}</p>
                {claim.evidence.map((source, sourceIndex) => (
                  <blockquote key={sourceIndex}>
                    {source.quote}{' '}{renderAnswerCitations(`[${source.citationId}]`, byId)}
                  </blockquote>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      {error !== null && <ErrorNotice error={error} />}
    </div>
  );
}

function AnswerBody({ text, byId }: { text: string; byId: ReadonlyMap<string, Citation> }) {
  const lines = formatAnswerQueryTimes(text).split('\n');
  const blocks: ReactNode[] = [];
  let start = 0;

  function addProse(end: number) {
    const prose = lines.slice(start, end).join('\n').trim();
    if (prose) blocks.push(<p className="answer-body" key={start}>{renderAnswerInline(prose, byId)}</p>);
  }

  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    const table = readAnswerTable(lines, i);
    const heading = /^ {0,3}#{1,6}\s+(\S.*)$/u.exec(line);
    const item = answerListItem(line);
    if (table !== null) {
      addProse(i);
      blocks.push(
        <div className="ask-table-scroll" key={'table-' + i} tabIndex={0} role="region" aria-label="回答表格">
          <table className="ask-answer-table">
            <thead><tr>{table.headers.map((cell, col) => <th scope="col" key={col}>{renderAnswerInline(cell, byId)}</th>)}</tr></thead>
            <tbody>
              {table.rows.map((row, index) => {
                const ids = extractEvidenceIds(row.line);
                const cells = row.cells.map((cell) => cell.replace(evidenceMarker(), '').trim());
                const coreColumn = cells.findIndex((cell, col) => cell !== '' && !/^(序号|行号|#)$/u.test(table.headers[col]!));
                const markers = ids.map((id) => `[${id}]`).join(' ');
                return (
                  <tr key={index}>
                    {cells.map((cell, col) => (
                      <td key={col}>
                        {renderAnswerInline(cell, byId)}
                        {col === Math.max(0, coreColumn) && markers !== '' && <> {renderAnswerCitations(markers, byId)}</>}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>,
      );
      i = table.end;
    } else if (item !== null) {
      addProse(i);
      const listStart = i;
      const children: ReactNode[] = [];
      for (let row: ReturnType<typeof answerListItem> = item; row !== null && row.ordered === item.ordered; row = answerListItem(lines[i] ?? '')) {
        children.push(<li key={i}>{renderAnswerInline(row.text, byId)}</li>);
        i += 1;
      }
      blocks.push(item.ordered
        ? <ol className="ask-answer-list" key={listStart} start={item.ordinal}>{children}</ol>
        : <ul className="ask-answer-list" key={listStart}>{children}</ul>);
    } else if (heading !== null) {
      addProse(i);
      blocks.push(<h3 className="ask-answer-heading" key={i}>{renderAnswerInline(heading[1]!, byId)}</h3>);
      i += 1;
    } else if (line.trim() === '') {
      addProse(i);
      i += 1;
    } else {
      i += 1;
      continue;
    }
    start = i;
  }
  addProse(lines.length);
  return <div className="ask-answer-copy">{blocks}</div>;
}

function answerListItem(line: string) {
  const match = /^ {0,3}(?:[-*+]|(\d{1,9})[.)])\s+(\S.*)$/u.exec(line);
  return match === null ? null : { ordered: match[1] !== undefined, ordinal: Number(match[1] ?? 1), text: match[2]! };
}

function renderAnswerInline(text: string, byId: ReadonlyMap<string, Citation>): ReactNode[] {
  const nodes: ReactNode[] = [];
  let end = 0;
  for (const token of text.matchAll(/\\([*`\\])|`([^`\r\n]+)`|\*\*([^\r\n]+?)\*\*|(?<!\*)\*([^*\s][^*\r\n]*?)\*(?!\*)/gu)) {
    const start = token.index;
    if (start > end) nodes.push(<span key={end}>{renderAnswerCitations(text.slice(end, start), byId)}</span>);
    if (token[1] !== undefined) nodes.push(<span key={start}>{token[1]}</span>);
    else if (token[2] !== undefined) nodes.push(<code key={start}>{token[2]}</code>);
    else if (token[3] !== undefined) {
      const bold = token[3].trim();
      nodes.push(bold ? <strong key={start}>{renderAnswerCitations(bold, byId)}</strong> : <span key={start}>{token[0]}</span>);
    } else nodes.push(<em key={start}>{renderAnswerCitations(token[4]!, byId)}</em>);
    end = start + token[0].length;
  }
  if (end < text.length) nodes.push(<span key={end}>{renderAnswerCitations(text.slice(end), byId)}</span>);
  return nodes;
}

function sourceHref(citation: Citation): string | undefined {
  if (citation.sourceType === 'document') return `/chunk/${encodeURIComponent(citation.chunkId)}`;
  const id = encodeURIComponent(citation.recordId);
  const title = encodeURIComponent(citation.recordTitle);
  switch (citation.recordType) {
    case 'M-PATENT': return `/patents?q=${title}&focus=${id}`;
    case 'M-SUBMIT': return `/submissions?focus=${id}`;
    case 'M-CODE': return `/datasets?focus=${id}`;
    case 'M-JOURNAL': return `/journals?q=${title}`;
    case 'M-THESIS': return `/theses?focus=${id}`;
    case 'M-PERSON': return `/people?q=${title}&focus=${id}`;
  }
}

function renderAnswerCitations(text: string, byId: ReadonlyMap<string, Citation>): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(evidenceMarker())) {
    const at = match.index ?? 0;
    if (at > last) nodes.push(<span key={key++}>{text.slice(last, at)}</span>);
    const cite = byId.get(`E${match[1] ?? ''}`);
    const href = cite === undefined ? undefined : sourceHref(cite);
    if (cite !== undefined && href !== undefined) {
      const title = cite.sourceType === 'document' ? cite.documentTitle : cite.recordTitle;
      nodes.push(
        <span className="cite-wrap" key={key++}>
          <Link className="cite-mark" to={href}
            aria-label={`来源 ${match[1]}：${title}`}>
            {match[1]}
          </Link>
          <CitationPopover citation={cite} />
        </span>,
      );
    } else if (cite === undefined) {
      nodes.push(<span key={key++}>{match[0]}</span>);
    }
    last = at + match[0].length;
  }
  if (last < text.length) nodes.push(<span key={key++}>{text.slice(last)}</span>);
  return nodes;
}

/**
 * 正文引用编号的悬浮卡（O9）。
 *
 * 【为什么文档引用和记录引用长得不一样】文档有"位置"（页码 + 章节）和可点开的
 * 原文页；记录引用指向的是库里此刻的一行，没有页码也没有原文页。硬套同一张卡
 * 会让记录引用出现"第 null 页"和死链 —— 与引用卡片那里分叉的理由相同。
 */
function CitationPopover({ citation }: { citation: Citation }) {
  if (citation.sourceType === 'record') {
    return (
      <span className="cite-pop" role="tooltip">
        <span className="cite-pop-title">{citation.recordTitle}</span>
        <span className="cite-pop-meta">
          {RECORD_TYPE_LABELS[citation.recordType]} · 查询于 {fmtQueryTime(citation.queryTime)}
        </span>
        <span className="cite-pop-text">
          {citation.fields.slice(0, 3).map((f) => `${f.label}：${f.value}`).join('；')}
        </span>
        <span className="cite-pop-foot">台账记录没有原文页，完整字段见「来源」。</span>
      </span>
    );
  }

  // 优先显示模型逐字摘录、且服务端核对过的那一段（O2）；没有才回落到整块摘录。
  const source = citation.quote ?? citation.excerpt;
  const truncated = source.length > CITE_POP_PREVIEW;
  const where = [
    citation.page === null ? '无页码' : `第 ${citation.page} 页`,
    citation.sectionPath.length > 0 ? formatSectionPath(citation.sectionPath) : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');

  return (
    <span className="cite-pop" role="tooltip">
      <span className="cite-pop-title">{citation.documentTitle}</span>
      <span className="cite-pop-meta">{where}</span>
      <span className="cite-pop-text">
        {truncated ? `${source.slice(0, CITE_POP_PREVIEW)}…` : source}
      </span>
      <span className="cite-pop-foot">点击编号查看原文</span>
    </span>
  );
}

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(2)} 秒`;
}

function LiveElapsedTime({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), 30);
    return () => window.clearInterval(id);
  }, []);
  return formatElapsed(Math.max(0, now - startedAt));
}

function activityLabel(event: AskStatusEvent): string {
  if (event.phase === 'understanding') return '正在理解问题';
  if (event.phase === 'generation') return '正在整理回答';
  if (event.phase === 'quote_repair' || event.phase === 'verification') return '正在整理来源';
  if (event.message.startsWith('正在查') || event.message.startsWith('正在核对数据集')) {
    return event.message.replace(/…$/u, '');
  }
  return event.phase === 'retrieval' || event.message.includes('检索') ? '正在查找资料' : '正在准备回答';
}

function QueryDetails({ steps, elapsedMs = 0, runningSince, warnings = [] }: {
  steps: readonly TimelineStep[];
  elapsedMs?: number;
  runningSince?: number | undefined;
  warnings?: readonly string[];
}) {
  if (steps.length === 0 && warnings.length === 0) return null;
  return (
    <details className="ask-query-details">
      <summary>查询过程</summary>
      {steps.length > 0 && (
        <ol className="ask-query-steps">
          {steps.map((step, i) => {
            const nextStep = steps[i + 1];
            const end = nextStep?.atMs ?? elapsedMs;
            const ms = step.durationMs ?? Math.max(0, end - step.atMs);
            return (
              <li key={step.stepId ?? i}>
                <span>{step.label.replace(/^正在/u, '')}</span>
                <span className="ask-query-duration">
                  {step.added > 0 && `找到 ${step.added} 条 · `}
                  {runningSince !== undefined && nextStep === undefined && step.durationMs === undefined
                    ? <LiveElapsedTime startedAt={runningSince + step.atMs} /> : formatElapsed(ms)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <AskWarningNotice warnings={warnings} />
    </details>
  );
}

/**
 * 回答底部的赞 / 踩（O5）。
 *
 * 【为什么点「没帮助」立刻先写一次，再展开原因】反馈的核心是那个态度 ——
 *   让用户点完还要再点一次「提交」才落库，中途关页面就什么都没留下。
 *   预设原因与文字是**补充**，在面板里保存时覆盖同一条记录（服务端 upsert）。
 *   赞没有面板：它不需要解释。
 *
 * 【为什么改投是覆盖而不是再发一条】同一运行只能有一个态度；先赞后踩若留两条，
 *   管理端的统计会把一次满意的回答也算进问题里。
 */
function AnswerFeedbackBar({ runId }: { runId: string }) {
  const [feedback, setFeedback] = useState<AnswerFeedback | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [reasons, setReasons] = useState<FeedbackDownReason[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function send(
    rating: FeedbackRating,
    chosen: readonly FeedbackDownReason[],
    text: string,
  ): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await apiPost<SubmitFeedbackResponse>(`/api/v1/ask-records/${runId}/feedback`, {
        rating,
        ...(rating === 'down'
          ? { reasons: chosen, note: text.trim() === '' ? null : text.trim() }
          : {}),
      });
      setFeedback(res.feedback);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setSaving(false);
    }
  }

  function voteUp(): void {
    setPanelOpen(false);
    void send('up', [], '');
  }

  function voteDown(): void {
    // 已经踩过就沿用已保存的原因/说明，避免"再点一次把刚写的内容清空"。
    // 预设词表之外的键（历史数据）不往面板里塞 —— 面板只能表示当前这版词表。
    const chosen =
      feedback?.rating === 'down'
        ? feedback.reasons.filter((r): r is FeedbackDownReason =>
            FEEDBACK_DOWN_REASONS.some((x) => x.key === r),
          )
        : reasons;
    const text = feedback?.rating === 'down' ? (feedback.note ?? '') : note;
    setReasons(chosen);
    setNote(text);
    setPanelOpen(true);
    void send('down', chosen, text);
  }

  function toggleReason(key: FeedbackDownReason): void {
    setReasons((prev) =>
      prev.includes(key) ? prev.filter((r) => r !== key) : [...prev, key],
    );
  }

  return (
    <>
      <div className="feedback-bar">
        <span className="feedback-question">这条回答有帮助吗？</span>
        <button
          type="button"
          className={feedback?.rating === 'up' ? 'feedback-vote active' : 'feedback-vote'}
          aria-pressed={feedback?.rating === 'up'}
          disabled={saving}
          onClick={voteUp}
        >
          有帮助
        </button>
        <button
          type="button"
          className={feedback?.rating === 'down' ? 'feedback-vote active' : 'feedback-vote'}
          aria-pressed={feedback?.rating === 'down'}
          disabled={saving}
          onClick={voteDown}
        >
          没帮助
        </button>
        {/* 改投后这一行会跟着变 —— 用户要能确认"现在生效的是哪一票"。 */}
        {feedback !== null && (
          <span className="feedback-saved">
            已记录 · {feedback.rating === 'up' ? '有帮助' : '没帮助'}
          </span>
        )}
      </div>

      {error !== null && <ErrorNotice error={error} />}

      {panelOpen && (
        <div className="feedback-panel">
          <p>哪里没帮上？（可多选，也可以只写说明）</p>
          <div className="feedback-reasons">
            {FEEDBACK_DOWN_REASONS.map((r) => (
              <button
                key={r.key}
                type="button"
                className="feedback-reason"
                aria-pressed={reasons.includes(r.key)}
                onClick={() => toggleReason(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <label className="field">
            <span>
              补充说明（选填，最多 {FEEDBACK_NOTE_MAX_CHARS} 字）
            </span>
            <textarea
              rows={2}
              maxLength={FEEDBACK_NOTE_MAX_CHARS}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：答的是另一篇论文 / 引用的段落里没有这句话"
            />
          </label>
          <p className="feedback-foot">
            <button type="button" disabled={saving} onClick={() => void send('down', reasons, note)}>
              {saving ? '正在保存…' : '保存原因'}
            </button>
            <span className="dim" style={{ fontSize: '0.8125rem' }}>
              不填也可以 —— 点「没帮助」时态度已经记下了。
            </span>
          </p>
        </div>
      )}
    </>
  );
}

/**
 * 引用卡片。按来源分两种形态。
 *
 * 【为什么必须在这里分叉，而不是让同一张卡片少显示几个字段】
 *   文档引用能点开原文那一页，台账 / 数据集引用**没有那一页** ——
 *   它指向的是库里此刻的一行记录。共用一张卡片的话，台账引用会渲染出一个
 *   缺失的标题、空的章节路径、以及一个指向 `/chunk/undefined` 的「查看原文」。
 *   那种链接点开是空白，用户会以为"这条引用是编的"，
 *   而它其实是本次回答里最可靠的一条（数据直接来自库，模型碰不到）。
 *
 * 曾经还有第三种：网页引用（联网检索）。联网搜索于 2026-10-12 整体下线，
 * 那一支与它的卡片一并删除 —— 历史回答里也不会有它（问答记录只存元数据）。
 */
function CitationCard({ citation }: { citation: Citation }) {
  if (citation.sourceType === 'record') return <RecordCitationCard citation={citation} />;
  return <DocumentCitationCard citation={citation} />;
}

function DocumentCitationCard({ citation }: { citation: DocumentCitation }) {
  const excerpt = citation.quote ?? citation.excerpt;
  const truncated = excerpt.length > EXCERPT_PREVIEW;
  return (
    <div className="card hit">
      <p className="hit-head">
        <span className="pill">{citation.id.slice(1)}</span>
        <span className="hit-title">{citation.documentTitle}</span>
        <span className="pill">{MATERIAL_LABELS[citation.material]}</span>
        {citation.page !== null && <span className="pill">第 {citation.page} 页</span>}
        <Link
          className="side-link"
          to={sourceHref(citation) ?? '/ask'}
        >
          查看原文
        </Link>
      </p>

      {citation.sectionPath.length > 0 && (
        <p className="hit-path">{formatSectionPath(citation.sectionPath)}</p>
      )}

      <p className="hit-snippet">
        {truncated ? `${excerpt.slice(0, EXCERPT_PREVIEW)}…` : excerpt}
      </p>
    </div>
  );
}

/**
 * 台账 / 数据集的引用卡片。
 *
 * 逐行列出服务端从库里取的结论字段（状态、路径、核对结果…）。
 * 底部**必须**标出查询时点：这张卡片说的是"查的那一刻"的事，
 * 不写时点，用户无法判断它有多新 —— 而"新不新"正是这类引用的全部价值。
 */
function RecordCitationCard({ citation }: { citation: RecordCitation }) {
  const href = sourceHref(citation);
  return (
    <div className="card hit">
      <p className="hit-head">
        <span className="pill">{citation.id.slice(1)}</span>
        <span className="hit-title">{citation.recordTitle}</span>
        <span className="pill">{RECORD_TYPE_LABELS[citation.recordType]}</span>

        {href !== undefined && (
          <Link
            className="side-link"
            to={href}
          >
            查看记录
          </Link>
        )}
      </p>

      {citation.fields.map((f) => (
        <p className="hit-path" key={f.label}>
          <span className="dim">{f.label}：</span>
          {f.value}
        </p>
      ))}

      {/* 「这是查询那一刻台账里的内容，不是文档摘录」那句删掉了（「界面整理-new」§三）：
          卡片上方已经写着「台账」这个来源类型与查询时点，再补一句是在替用户做阅读理解。 */}
      <p className="dim" style={{ fontSize: '0.71875rem', margin: '6px 0 0' }}>
        查询时点 {fmtQueryTime(citation.queryTime)}
        {citation.recordUpdatedAt !== null && ` · 该记录最近更新 ${fmtDateTime(citation.recordUpdatedAt)}`}
      </p>
    </div>
  );
}

/** 回答的几个"附带说明"区块。没有内容就整块不显示，不留空标题。 */
/**
 * 回答的附带说明（依据缺口 / 边界 / 注意事项 / 矛盾）。
 *
 * 【2026-10-17：四个独立提示框合并成一个折叠区】（「界面整理-new」§六.2）
 *   原先它们各自是一块 `.notice` 灰框，一次回答下面叠三四个 ——
 *   读完正文之后还要再滚过三屏"注意事项"，而其中多数时候只有一两条。
 *   合并之后：**一行摘要**常驻（带总条数），点开才展开明细。
 *
 * 【为什么"矛盾"默认展开】它是四类里唯一**可能改变结论**的一类：
 *   「资料之间互相矛盾」意味着正文里那个结论有一个同样有出处的反例，
 *   用户不点开就永远不知道。其余三类是"完备性说明"，收着更合适。
 */
function AnswerNotes({ answer }: { answer: Answer }) {
  // `hint` 只在有值时给键（本项目开了 exactOptionalPropertyTypes：
  // 显式传 `undefined` 与"这个字段不出现"是两种类型，后者才是"没有提示语"）。
  const blocks = [
    { title: '还缺哪些信息', hint: undefined as string | undefined, items: answer.evidenceGaps },
    { title: '本次回答的边界', hint: undefined as string | undefined, items: answer.limits },
    { title: '需要注意的地方', hint: undefined as string | undefined, items: answer.confidenceNotes },
    { title: '资料之间互相矛盾之处', hint: undefined as string | undefined, items: answer.conflicts },
  ].filter((b) => b.items.length > 0);
  if (blocks.length === 0) return null;

  const total = blocks.reduce((n, b) => n + b.items.length, 0);
  const conflicts = answer.conflicts.length;

  return (
    <details className="answer-notes" open={conflicts > 0}>
      <summary>
        补充说明（{total} 项）
        {conflicts > 0 && <span className="pill warn">有 {conflicts} 处资料矛盾</span>}
      </summary>
      {blocks.map((b) => (
        <AnswerList
          key={b.title}
          title={b.title}
          {...(b.hint === undefined ? {} : { hint: b.hint })}
          items={b.items}
        />
      ))}
    </details>
  );
}

function AnswerList({
  title,
  hint,
  items,
}: {
  title: string;
  hint?: string;
  items: readonly string[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="notice">
      <p className="notice-title">{title}</p>
      {hint !== undefined && <p className="notice-body">{hint}</p>}
      <ul className="notice-list">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
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
