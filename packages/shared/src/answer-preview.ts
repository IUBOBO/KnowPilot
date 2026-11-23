import { evidenceMarker } from './answer.ts';
import { readAnswerTable } from './answer-table.ts';

function plainText(text: string): string {
  return text.replace(evidenceMarker(), '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/\*\*|__|`/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/ +([，。；、！？])/gu, '$1')
    .trim();
}

/** Reuse the answer's opening conclusion as the history preview. */
export function answerPreview(answer: string): string | null {
  const lines = answer.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith('|')) {
      const table = readAnswerTable(lines, i);
      const firstRow = table?.rows[0];
      if (table !== null && firstRow !== undefined) {
        return limitPreview(firstRow.cells.slice(0, 2)
          .map((cell, col) => `${plainText(table.headers[col]!)} ${plainText(cell)}`).join('，'));
      }
      continue;
    }
    if (/^(?:#|```|[-*_]{3,}$)/u.test(line)) continue;
    const conclusion = plainText(line.replace(/^(?:[-*+]|\d+[.)])\s+/u, ''));
    if (conclusion !== '') return limitPreview(conclusion);
  }
  return null;
}

function limitPreview(text: string): string {
  const chars = Array.from(text);
  return chars.length <= 100 ? text : `${chars.slice(0, 100).join('').trimEnd()}…`;
}
