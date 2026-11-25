import { lazy, Suspense, type ReactNode } from 'react';
import { evidenceMarker, extractEvidenceIds, readAnswerTable, type Citation } from '@knowpilot/shared';
import { formatAnswerQueryTimes } from '../../format.ts';
import { renderAnswerCitations } from './AnswerSources.tsx';

const MathFormula = lazy(() => import('./MathFormula.tsx'));
const MAX_FORMULA_LENGTH = 4000;
const DETAILS_HEADING = /^##[ \t]+详细说明[ \t]*[：:]?[ \t]*$/u;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const DISPLAY_OPEN = /^\s*(\$\$|\\\[)(.*)$/u;
const INLINE_TOKEN = /\\(?<escaped>[*`\\$])|(?<ticks>`+)(?<code>[^`\r\n]+)\k<ticks>|\\\((?<paren>.+?)\\\)|(?<!\$)\$(?![\s$])(?<dollar>[^$\r\n]+?)(?<!\s)\$(?![\d$])|\*\*(?<strong>[^\r\n]+?)\*\*|(?<!\*)\*(?<emphasis>[^*\s][^*\r\n]*?)\*(?!\*)/gu;

function readFence(lines: readonly string[], start: number) {
  const opening = CODE_FENCE.exec(lines[start] ?? '');
  if (opening === null) return null;
  const marker = opening[1]!;
  let end = start + 1;
  for (; end < lines.length; end += 1) {
    const closing = CODE_FENCE.exec(lines[end]!);
    if (closing !== null && closing[1]!.startsWith(marker) && closing[2]!.trim() === '') break;
  }
  return { code: lines.slice(start + 1, end).join('\n'), end: end + 1 };
}

function readDisplayMath(lines: readonly string[], start: number) {
  const opening = DISPLAY_OPEN.exec(lines[start] ?? '');
  if (opening === null) return null;
  const closing = opening[1] === '$$' ? '$$' : '\\]';
  const body = [opening[2]!];
  let length = opening[2]!.length;
  for (let end = start; end < lines.length && length <= MAX_FORMULA_LENGTH; end += 1) {
    const text = body.at(-1)!.trimEnd();
    if (text.endsWith(closing)) {
      body[body.length - 1] = text.slice(0, -closing.length);
      const source = body.join('\n').trim();
      return source === '' ? null : { source, end: end + 1 };
    }
    const next = lines[end + 1];
    if (next !== undefined) {
      body.push(next);
      length += next.length + 1;
    }
  }
  return null;
}

function AnswerMath({ source, display = false }: { source: string; display?: boolean }) {
  const formula = source.length > MAX_FORMULA_LENGTH
    ? <code>{source}</code>
    : <Suspense fallback={<code>{source}</code>}><MathFormula source={source} display={display} /></Suspense>;
  return display
    ? <div className="ask-answer-math-display" role="region" aria-label="回答公式" tabIndex={0}>{formula}</div>
    : formula;
}

export function FinalAnswerBody({ text, byId }: { text: string; byId: ReadonlyMap<string, Citation> }) {
  const lines = text.split(/\r?\n/u);
  let detailAt = -1;
  for (let i = 0; i < lines.length;) {
    const code = readFence(lines, i);
    const math = code === null ? readDisplayMath(lines, i) : null;
    const block = code ?? math;
    if (block !== null) {
      i = block.end;
      continue;
    }
    if (DETAILS_HEADING.test(lines[i]!)) {
      detailAt = i;
      break;
    }
    i += 1;
  }
  if (detailAt <= 0) return <AnswerBody text={text} byId={byId} />;

  const details = lines.slice(detailAt + 1).join('\n').trim();
  return (
    <>
      <AnswerBody text={lines.slice(0, detailAt).join('\n')} byId={byId} />
      {details !== '' && (
        <details className="answer-notes">
          <summary>详细说明</summary>
          <AnswerBody text={details} byId={byId} />
        </details>
      )}
    </>
  );
}

export function AnswerBody({ text, byId }: { text: string; byId: ReadonlyMap<string, Citation> }) {
  const lines = text.split(/\r?\n/u);
  const blocks: ReactNode[] = [];
  let start = 0;

  function addProse(end: number) {
    const prose = lines.slice(start, end).join('\n').trim();
    if (prose) blocks.push(<p className="answer-body" key={start}>{renderAnswerInline(prose, byId)}</p>);
  }

  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    const fence = readFence(lines, i);
    const math = fence === null ? readDisplayMath(lines, i) : null;
    if (fence !== null) {
      addProse(i);
      blocks.push(
        <pre className="ask-answer-code" key={i} tabIndex={0} role="region" aria-label="回答代码"><code>{fence.code}</code></pre>,
      );
      i = start = fence.end;
      continue;
    }
    if (math !== null) {
      addProse(i);
      blocks.push(<AnswerMath key={i} source={math.source} display />);
      i = start = math.end;
      continue;
    }

    const table = readAnswerTable(lines, i);
    const heading = /^ {0,3}#{1,6}\s+(\S.*)$/u.exec(line);
    const item = answerListItem(line);
    if (table !== null) {
      addProse(i);
      blocks.push(
        <div className="ask-table-scroll" key={'table-' + i} tabIndex={0} role="region" aria-label="回答表格">
          <table className="ask-answer-table" style={{ minWidth: table.headers.length * 7.5 + 'rem' }}>
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
  for (const token of text.matchAll(INLINE_TOKEN)) {
    const start = token.index;
    if (start > end) nodes.push(<span key={end}>{renderAnswerCitations(formatAnswerQueryTimes(text.slice(end, start)), byId)}</span>);
    const { escaped, code, paren, dollar, strong, emphasis } = token.groups!;
    const formula = paren ?? dollar;
    if (escaped !== undefined) nodes.push(<span key={start}>{escaped}</span>);
    else if (code !== undefined) nodes.push(<code key={start}>{code}</code>);
    else if (formula !== undefined) nodes.push(<AnswerMath key={start} source={formula} />);
    else if (strong !== undefined) {
      const bold = strong.trim();
      nodes.push(bold ? <strong key={start}>{renderAnswerInline(bold, byId)}</strong> : <span key={start}>{token[0]}</span>);
    } else if (emphasis !== undefined) {
      nodes.push(<em key={start}>{renderAnswerInline(emphasis, byId)}</em>);
    }
    end = start + token[0].length;
  }
  if (end < text.length) nodes.push(<span key={end}>{renderAnswerCitations(formatAnswerQueryTimes(text.slice(end)), byId)}</span>);
  return nodes;
}
