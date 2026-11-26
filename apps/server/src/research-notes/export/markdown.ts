type BodyKind = 'prose' | 'fence' | 'code' | 'math';
type Mapper = (text: string) => string;
const identity: Mapper = (text) => text;

function escapedAt(text: string, offset: number): boolean {
  let preceding = offset;
  while (preceding > 0 && text[preceding - 1] === '\\') preceding -= 1;
  return (offset - preceding) % 2 !== 0;
}

function codeEnd(line: string, start: number, marker: string): number | null {
  const ticks = /\x60+/gu;
  ticks.lastIndex = start + marker.length;
  for (const candidate of line.matchAll(ticks)) {
    if (candidate[0] === marker) return candidate.index + marker.length;
  }
  return null;
}

export function mapNoteInline(line: string, prose: Mapper, literal: Mapper = identity): string {
  const markers = /\x60+|\\\([^\r\n]+?\\\)|(?<!\$)\$(?![\s$])[^$\r\n]+?(?<!\s)\$(?![\d$])/gu;
  let end = 0;
  let output = '';
  for (const token of line.matchAll(markers)) {
    const { index } = token;
    if (index < end || escapedAt(line, index)) continue;
    const marker = token[0];
    const code = marker.startsWith('\x60');
    const stop = code ? codeEnd(line, index, marker) : index + marker.length;
    if (stop === null) continue;
    output += prose(line.slice(end, index)) + literal(line.slice(index, stop));
    end = stop;
  }
  return output + prose(line.slice(end));
}

export function bodyKinds(lines: readonly string[], topLevelFencesOnly = false): BodyKind[] {
  const kinds: BodyKind[] = [];
  const closes = new Map<string, number>();
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i]!.trimEnd();
    for (const end of ['$$', '\\]']) if (text.endsWith(end)) closes.set(end, i);
  }
  let fence: string | null = null;
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/u.exec(line);
    if (fence !== null) {
      if (marker !== null && marker[1]!.startsWith(fence) && marker[2]!.trim() === '') {
        fence = null;
        kinds.push('fence');
      } else kinds.push('code');
      i += 1;
      continue;
    }
    // CommonMark disallows backticks in the info string of a backtick fence.
    if (marker !== null && (!topLevelFencesOnly || !line.startsWith(' ')) &&
        (!marker[1]!.startsWith('\x60') || !marker[2]!.includes('\x60'))) {
      fence = marker[1]!;
      kinds.push('fence');
      i += 1;
      continue;
    }
    const math = /^\s*(\$\$|\\\[)(.*)$/u.exec(line);
    const close = math?.[1] === '$$' ? '$$' : '\\]';
    if (math !== null && (math[2]!.trimEnd().endsWith(close) || (closes.get(close) ?? -1) > i)) {
      kinds.push('math');
      i += 1;
      if (!math[2]!.trimEnd().endsWith(close)) {
        while (i < lines.length) {
          kinds.push('math');
          if (lines[i++]!.trimEnd().endsWith(close)) break;
        }
      }
      continue;
    }
    kinds.push('prose');
    i += 1;
  }
  return kinds;
}

export function sanitizeNoteMarkdown(value: string, escapeText: Mapper): string {
  const parts = value.split(/(\r\n|\r|\n)/u);
  // Dedenting can end an unclosed fence in a Markdown list. Only explicit
  // column-zero fences make the rest of their block unambiguously literal.
  const kinds = bodyKinds(parts.filter((_, index) => index % 2 === 0), true);
  const inactiveHtml = (text: string) => text.replace(/<(?=[!?]|\/?[a-z][\w:-]*(?:\s+[^<>]*?)?\/?>)/giu, '&lt;');
  const sanitizeMath = (text: string) => inactiveHtml(text).replace(/!\[/gu, '！[');
  const sanitizeProse = (text: string) => text.replace(
    /!\[([^\]\r\n]*)\](?:\([^)\r\n]*\)|\[[^\]\r\n]*\])|!\[|<(?=[a-z!/?])/giu,
    (match, alt: string | undefined) => alt === undefined
      ? (match === '<' ? '&lt;' : '！[')
      : '（图表：' + escapeText(alt || '未提供说明') + '）',
  );
  let output = '';
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const kind = kinds[index / 2];
    if (kind === 'math') {
      const start = index;
      while (kinds[(index + 2) / 2] === 'math') index += 2;
      output += sanitizeMath(parts.slice(start, index + 1).join(''));
    } else output += kind === 'prose'
      ? mapNoteInline(part, sanitizeProse, sanitizeMath)
      : part;
  }
  return output;
}

function cellsOf(line: string): string[] | null {
  const text = line.trim();
  const points = [...text.matchAll(/\|/gu)].map(({ index }) => index).filter((index) => !escapedAt(text, index));
  if (points.length === 0) return null;
  const cells: string[] = [];
  let start = 0;
  for (const end of points) {
    if (end !== 0) cells.push(text.slice(start, end));
    start = end + 1;
  }
  if (start < text.length) cells.push(text.slice(start));
  return cells.map((value) => value.trim().replace(/\\\|/gu, '|'));
}

export function readNoteTable(lines: readonly string[], kinds: readonly BodyKind[], start: number) {
  if (kinds[start + 1] !== 'prose') return null;
  const headers = cellsOf(lines[start]!);
  const divider = cellsOf(lines[start + 1]!);
  if (headers === null || divider?.length !== headers.length ||
      !divider.every((cell) => /^:?-+:?$/u.test(cell))) return null;
  const rows: string[][] = [];
  let end = start + 2;
  for (; kinds[end] === 'prose'; end += 1) {
    const line = lines[end]!;
    if (/^\s*(?:#{1,6}\s|[-+*]\s|>)/u.test(line)) break;
    const cells = cellsOf(line);
    if (cells === null) break;
    const row = headers.map((_, index) => cells[index] ?? '');
    if (cells.length > headers.length) row[row.length - 1] = cells.slice(headers.length - 1).join(' | ');
    rows.push(row);
  }
  return { headers, rows, end };
}
