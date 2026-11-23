interface AnswerTableRow {
  line: string;
  cells: readonly string[];
}

function cellsOf(line: string): string[] | null {
  const text = line.trim();
  if (!text.startsWith('|') || !text.endsWith('|')) return null;
  const cells = text.slice(1, -1).split(/(?<!\\)\|/u);
  return cells.length > 1 ? cells.map((cell) => cell.trim().replace(/\\\|/gu, '|')) : null;
}

export function readAnswerTable(lines: readonly string[], start: number): {
  headers: readonly string[];
  rows: readonly AnswerTableRow[];
  end: number;
} | null {
  const headers = cellsOf(lines[start] ?? '');
  const separator = cellsOf(lines[start + 1] ?? '');
  if (headers === null || separator?.length !== headers.length ||
      !separator.every((cell) => /^:?-{3,}:?$/u.test(cell)) ||
      headers.some((cell) => !cell || cell.length > 40 || /\[E\d+\]/u.test(cell))) return null;
  let end = start + 2;
  const rows: AnswerTableRow[] = [];
  for (; end < lines.length; end += 1) {
    const line = lines[end]!.trim();
    const cells = cellsOf(line);
    if (cells?.length !== headers.length) break;
    rows.push({ line, cells });
  }
  return rows.length > 0 ? { headers, rows, end } : null;
}
