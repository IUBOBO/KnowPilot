import type { ApiError } from '../api.ts';

/**
 * 统一的错误展示块。
 *
 * 三件事必须一起出现，缺一件都会让用户或维护者多绕一圈：
 *   · 标题 + 说明：用户知道发生了什么、下一步该做什么
 *   · 请求 ID：用户报问题时能对上服务端日志里那一条
 *   · 可重试时给按钮，不可重试时明确说"重试无用"——
 *     不给按钮会让人反复点，而不说清楚会让人一直等
 */
export function ErrorNotice({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const { code, title, message, retryable, retryDelayMs, requestId } = error.body.error;

  return (
    <div className="notice err">
      <p className="notice-title">
        <span className="pill err">{title}</span> <span className="mono dim">code = {code}</span>
      </p>
      <p className="notice-body">{message}</p>
      <p className="notice-foot">
        可重试：{retryable ? '是' : '否'}
        {retryDelayMs !== undefined ? `（建议 ${retryDelayMs}ms 后）` : ''}
        {retryable && onRetry !== undefined && (
          <>
            {' '}
            <button type="button" onClick={onRetry}>重试</button>
          </>
        )}
        {' · '}
        <span className="mono">请求 ID：{requestId}</span>
      </p>
    </div>
  );
}
