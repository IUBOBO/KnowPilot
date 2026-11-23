import type { DocumentParsing } from '../document-parsing.ts';

export function DocumentParsingNotice({ parsing, compact = false }: {
  parsing: DocumentParsing;
  compact?: boolean;
}) {
  if (parsing.reminder === null && parsing.details.length <= (compact ? 1 : 0)) return null;
  return (
    <div className="doc-parse">
      {parsing.reminder !== null && (
        <p className={`doc-parse-reminder ${parsing.tone}`}>
          <strong>{parsing.tone === 'err' ? '失败' : '提示'}</strong>
          <span>{parsing.reminder}</span>
        </p>
      )}
      {parsing.details.length > 0 && (
        <details className="doc-parse-details">
          <summary>查看解析详情</summary>
          <dl>
            {parsing.details.map(({ label, text }) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{text}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}
