/** 问答警告按成因分组；原始服务端文字保留在展开区，便于逐条核对。 */
export function AskWarningNotice({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  const citation = warnings.filter((w) =>
    w.includes('没有提供可核对的摘录') ||
    w.includes('摘录与原文不符') ||
    w.includes('不存在的证据') ||
    w.includes('没有任何可核对的引用'),
  );
  const claims = warnings.filter((w) =>
    w.includes('条结论') &&
    (w.includes('依据不足') || w.includes('待核对') || w.includes('矛盾')),
  );
  const other = warnings.filter((w) => !citation.includes(w) && !claims.includes(w));
  const clean = (text: string) => text.replace(/\*\*/gu, '').replace(/`/gu, '');

  return (
    <div className="notice warn ask-warning-summary">
      <p className="notice-title">本次回答有 {warnings.length} 条校验提示</p>
      {citation.length > 0 && (
        <p className="notice-body">
          <b>引用核对：</b>{citation.length} 条提示。引用缺少有效摘录时会被剔除，正文里的相关结论需要重新核对原文。
        </p>
      )}
      {claims.length > 0 && (
        <p className="notice-body">
          <b>结论校验：</b>{claims.length} 类提示。
          {citation.length > 0 && '其中的“依据不足”可能受上述引用剔除影响；其余仍需单独核对。'}
        </p>
      )}
      {other.length > 0 && <p className="notice-body"><b>其他提醒：</b>{other.length} 条。</p>}
      <details>
        <summary>展开全部 {warnings.length} 条原始提示</summary>
        <ul className="notice-list">
          {warnings.map((warning, index) => <li key={index}>{clean(warning)}</li>)}
        </ul>
      </details>
    </div>
  );
}
