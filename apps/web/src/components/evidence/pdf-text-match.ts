import { isCjk } from '@knowpilot/shared';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

interface Character {
  item: number;
  start: number;
  end: number;
}

type ItemRange = Character;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const latinWord = /[\p{Script=Latin}\p{Number}]/u;

function cjkBoundary(codePoint: number | undefined) {
  return codePoint !== undefined &&
    (isCjk(codePoint) || (codePoint >= 0x3000 && codePoint <= 0x303f) || (codePoint >= 0xff00 && codePoint <= 0xffef));
}

function horizontal(item: TextItem) {
  const [a, b, c, d, x, y] = item.transform;
  return item.dir === 'ltr' && [a, b, c, d, x, y, item.width].every(Number.isFinite)
    && a > 0 && d > 0 && item.width > 0 && Math.abs(b) < 0.01 && Math.abs(c) < 0.01;
}

/** Preserve the PDF's order. Only join neighboring runs whose positions support that order. */
function collect(items: readonly TextItem[], removeWrapHyphen: boolean) {
  const chars: string[] = [];
  const positions: (Character | null)[] = [];
  let last: TextItem | undefined;
  let left = 0;
  let explicitBreak = false;
  let explicitSpace = false;

  function add(char: string, position: Character | null) {
    if (char === ' ' && (chars.length === 0 || chars.at(-1) === ' ')) return;
    chars.push(char);
    positions.push(position);
  }

  for (const [index, item] of items.entries()) {
    if (!item.str.trim()) {
      explicitBreak ||= item.hasEOL;
      explicitSpace ||= item.str.length > 0;
      continue;
    }
    const text = item.str.normalize('NFKC').replaceAll('\u00ad', '');
    const [, , , height, x, y] = item.transform;
    const [, , , lastHeight, lastX, lastY] = last?.transform ?? item.transform;
    const down = lastY - y;
    const gap = x - (lastX + (last?.width ?? 0));
    const compatible = last !== undefined && horizontal(last) && horizontal(item)
      && Math.abs(height - lastHeight) <= height * 0.18;
    const sameLine = compatible && !explicitBreak && Math.abs(down) <= height * 0.18
      && gap >= -height * 0.25 && gap <= height * 0.55;
    const wrappedLine = compatible && down >= height * 0.75 && down <= height * 1.6
      && Math.abs(x - left) <= height * 0.7;

    if (!sameLine) left = x;
    // Follow the indexer's CJK line-joining rule once the layout confirms a continued line.
    const trimmed = item.str.trimStart();
    const joinedCjk = wrappedLine && (
      cjkBoundary(Array.from(last?.str.trimEnd() ?? '').at(-1)?.codePointAt(0)) || cjkBoundary(trimmed.codePointAt(0))
    );
    if (joinedCjk) {
      if (chars.at(-1) === ' ') {
        chars.pop();
        positions.pop();
      }
    } else if (wrappedLine && chars.at(-1) === '-' && latinWord.test(chars.at(-2) ?? '') && latinWord.test(text[0] ?? '')) {
      if (removeWrapHyphen) {
        chars.pop();
        positions.pop();
      }
    } else if (wrappedLine || (sameLine && (explicitSpace || gap > height * 0.17))) {
      add(' ', null);
    } else if (!sameLine && last !== undefined) {
      add('\0', null);
    }

    const leadingSpaces = joinedCjk ? item.str.length - trimmed.length : 0;
    for (const { segment, index: start } of graphemes.segment(item.str)) {
      if (start < leadingSpaces) continue;
      const normalized = segment.normalize('NFKC').replaceAll('\u00ad', '').replace(/\s+/gu, ' ');
      const position = { item: index, start, end: start + segment.length };
      for (const char of normalized.split('')) add(char, position);
    }
    last = item;
    explicitBreak = item.hasEOL;
    explicitSpace = false;
  }

  return { text: chars.join(''), positions };
}

type TextMatch = { kind: 'matched'; ranges: readonly ItemRange[] }
  | { kind: 'no-text' | 'ambiguous' | 'unmatched' };

/** Match within the cited physical page, without fuzzy or neighboring-page guesses. */
export function matchPdfText(items: readonly TextItem[], quote: string): TextMatch {
  const target = quote.normalize('NFKC').replaceAll('\u00ad', '').replace(/\s+/gu, ' ').trim();
  if (items.every((item) => !item.str.trim())) return { kind: 'no-text' };
  if (target === '' || target.includes('\0') || target.length > 12_000 || items.length > 5_000
      || items.reduce((size, item) => size + item.str.length, 0) > 180_000) return { kind: 'unmatched' };

  let found: { first: Character; last: Character; ranges: ItemRange[] } | undefined;
  for (const dehyphenate of [false, true]) {
    const { text, positions } = collect(items, dehyphenate);
    for (let start = text.indexOf(target); start !== -1; start = text.indexOf(target, start + 1)) {
      const finish = start + target.length;
      const first = positions[start];
      const last = positions[finish - 1];
      if (first == null || last == null || first === positions[start - 1] || last === positions[finish]) continue;
      if ((latinWord.test(target[0] ?? '') && latinWord.test(text[start - 1] ?? ''))
        || (latinWord.test(target.at(-1) ?? '') && latinWord.test(text[finish] ?? ''))) continue;

      if (found !== undefined) {
        if (found.first.item !== first.item || found.first.start !== first.start
          || found.last.item !== last.item || found.last.end !== last.end) return { kind: 'ambiguous' };
        continue;
      }

      const ranges: ItemRange[] = [];
      for (const position of positions.slice(start, finish)) {
        if (position == null) continue;
        const previous = ranges.at(-1);
        if (previous?.item === position.item) previous.end = position.end;
        else ranges.push({ ...position });
      }
      found = { first, last, ranges };
    }
  }

  return found !== undefined && found.ranges.every(({ item }) => horizontal(items[item]!))
    ? { kind: 'matched', ranges: found.ranges }
    : { kind: 'unmatched' };
}
