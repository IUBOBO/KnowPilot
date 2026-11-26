import type { FormEvent, RefObject } from 'react';
import { ASK_HISTORY_LIMIT } from '@knowpilot/shared';
import type { AskTabTurn } from '../../ask-session.ts';

interface AskComposerProps {
  question: string;
  questionInputRef: RefObject<HTMLInputElement | null>;
  consent: boolean;
  loading: boolean;
  scopeReady?: boolean;
  isFollowUp: boolean;
  showSuggestions: boolean;
  suggestions: readonly string[];
  onQuestionChange: (question: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onStop: () => void;
}

export function AskComposer({
  question, questionInputRef, consent, loading, scopeReady = true, isFollowUp, showSuggestions, suggestions,
  onQuestionChange, onSubmit, onStop,
}: AskComposerProps) {
  return (
    <div className="card">
      <form className="ask-form" onSubmit={onSubmit}>
        <label className="field">
          <span>{isFollowUp ? '继续追问' : '你的问题'}</span>
          <input
            ref={questionInputRef}
            type="text"
            value={question}
            placeholder={isFollowUp ? '输入下一条问题' : '例如：硕士论文查重率要求是多少？'}
            onChange={(e) => onQuestionChange(e.target.value)}
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
          <button key="stop" type="button" onClick={onStop}>
            停止
          </button>
        ) : (
          // 未勾选时**把原因写在按钮上**，而不是在下面补一句灰字
          //（「界面整理-new」§三：能写在控件上的话就别另起一行说）。
          <button
            key="ask"
            type="submit"
            disabled={!consent || !scopeReady || question.trim() === ''}
          >
            {consent ? (isFollowUp ? '追问' : '提问') : '请先勾选上方云端确认'}
          </button>
        )}
      </form>

      {/* 首屏的推荐问题：只在"还没问过任何东西"时出现。
          点一下**只填入输入框、不自动发送** —— 自动发送会让人在没看清问题、
          也没确认云端同意的情况下就把内容发出去。 */}
      {showSuggestions && suggestions.length > 0 && (
        <div className="suggest">
          <p className="suggest-title">试试这样问</p>
          <div className="suggest-list">
            {suggestions.map((q) => (
              <button
                key={q}
                type="button"
                className="suggest-chip"
                onClick={() => {
                  onQuestionChange(q);
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
  );
}

export function AskHistory({ turns, selectedRunId, loading, onSelect, onClear }: {
  turns: readonly AskTabTurn[];
  selectedRunId: string | undefined;
  loading: boolean;
  onSelect: (turn: AskTabTurn) => void;
  onClear: () => void;
}) {
  if (turns.length === 0) return null;
  return (
    <details className="answer-notes">
      <summary>问答历史（{turns.length}/{ASK_HISTORY_LIMIT} 轮）</summary>
      <ul className="ask-recent-turns">
        {turns.toReversed().map((turn) => (
          <li key={turn.response.runId}>
            <button type="button" className="link-btn" disabled={loading}
              aria-current={selectedRunId === turn.response.runId ? 'true' : undefined}
              onClick={() => onSelect(turn)}>
              {turn.question}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="link-btn" disabled={loading} onClick={onClear}>
        清除上文
      </button>
    </details>
  );
}
