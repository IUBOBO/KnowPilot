import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import {
  FEEDBACK_DOWN_REASONS, FEEDBACK_NOTE_MAX_CHARS, FEEDBACK_REASON_LABELS,
  type Answer, type AnswerFeedback, type AskEvidenceReview, type AskResponse, type Citation,
  type FeedbackDownReason, type FeedbackRating, type OpenEvidence, type SubmitFeedbackResponse,
} from '@knowpilot/shared';
import { ApiError, apiPost, isAbort, toApiError } from '../../api.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { formatCnyFromUsd } from '../../currency.ts';
import { FinalAnswerBody } from './AnswerMarkdown.tsx';
import { AskNoteActions } from './AskNoteActions.tsx';
import { renderAnswerCitations, type CitationOpenContext } from './AnswerSources.tsx';
import { formatElapsed } from './AskProcess.tsx';

const AnswerBlocks = lazy(() => import('./AnswerBlocks.tsx'));

interface AskAnswerProps {
  result: AskResponse;
  byId: ReadonlyMap<string, Citation>;
  consent: boolean;
  sourceCount: number;
  readerOpen: boolean;
  sourceButtonRef: RefObject<HTMLButtonElement | null>;
  onToggleReader: () => void;
  onRetry: () => void;
  blocks: ReactNode;
  onOpenEvidence?: OpenEvidence;
  documentSearchLink?: (documentId: string) => Pick<LinkProps, 'to' | 'state'>;
}

export function AskAnswer({
  result, byId, consent, sourceCount, readerOpen, sourceButtonRef, onToggleReader, onRetry, blocks, onOpenEvidence, documentSearchLink,
}: AskAnswerProps) {
  const sources = onOpenEvidence === undefined ? {} : { citationOpen: { runId: result.runId, onOpenEvidence } };
  return (
    <article className="card ask-answer-article" aria-label="回答">
      <h2 className="ask-answer-title">回答</h2>
      {/* 用户写的是一句依赖上文的追问，系统实际拿去检索的是另一句。
          把这句话摆出来：答非所问时，用户第一眼就能判断是"理解错了"，
          而不是把一句错误的回答当成资料的结论。 */}
      {result.followUpRewrite !== undefined && result.followUpRewrite.changed && (
        <p className="dim" style={{ fontSize: '0.78125rem', margin: '0 0 10px' }}>
          追问按上文理解为：<b>{result.followUpRewrite.rewritten}</b>
        </p>
      )}
      <div className="ask-note-content">
        <FinalAnswerBody text={result.answer.answer} byId={byId} {...sources} />
        {blocks ?? (result.answer.blocks !== undefined && (
          <Suspense fallback={null}>
            <AnswerBlocks response={result} {...(onOpenEvidence === undefined ? {} : { onOpenEvidence })}
              {...(documentSearchLink === undefined ? {} : { documentSearchLink })} />
          </Suspense>
        ))}
      </div>
      {result.delivery.status === 'interrupted' && <p className="ask-answer-note">查询中断。可以继续查找。</p>}
      {result.delivery.status === 'partial' && result.answer.verification.counts.contradicted > 0 && (
        <p className="ask-answer-note">部分说法与资料不一致，请结合来源核对。</p>
      )}
      <p className="ask-answer-time">用时 {formatElapsed(result.answer.durationMs)}</p>
      <AskNoteActions key={`note-${result.runId}`} result={result} />
      {/* 逐条要点可直达原文；这里仍保留汇总抽屉，用于核对全部来源。 */}
      {sourceCount > 0 ? (
        <div className="answer-tools ask-answer-toolbar" role="group" aria-label="回答工具">
          <button
            ref={sourceButtonRef}
            aria-expanded={readerOpen}
            type="button"
            className="link-btn"
            onClick={onToggleReader}
          >
            来源（{sourceCount}）
          </button>
        </div>
      ) : null}
      {result.answer.citations.length > 0 && (
        <AnswerEvidenceReview key={`review-${result.runId}`} response={result} consent={consent} byId={byId} {...sources} />
      )}
      {/* O16：确定性出口。服务端只在"某类记录查询 0 命中"或
          "整次回答没有任何引用且列了依据缺口"时给；前端不自己推断。 */}
      {result.nextActions !== undefined && result.nextActions.length > 0 && (
        <div className="next-actions">
          <p className="next-actions-title">下一步</p>
          <div className="next-actions-list">
            {result.nextActions.map((action) => action.kind === 'retry-query' ? (
              <button key={action.kind} type="button" className="next-action" disabled={!consent} onClick={onRetry}>
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
    </article>
  );
}

function AnswerEvidenceReview({ response, consent, byId, citationOpen }: {
  citationOpen?: CitationOpenContext;
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
                    {source.quote}{' '}{renderAnswerCitations(`[${source.citationId}]`, byId, citationOpen)}
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
export function AnswerNotes({ answer }: { answer: Answer }) {
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
