import { evidenceMarker, type NoteRunMode } from '@knowpilot/shared';
import { mapAnswerProse } from '../ask/AnswerMarkdown.tsx';

export function noteCitationLabel(round: number, citationId: string) {
  return `第 ${round} 轮 · ${citationId}`;
}

export function qualifyNoteCitations(body: string, round: number, citationIds: readonly string[], mode: NoteRunMode): string {
  const verified = new Set(citationIds);
  const label = (id: string) => '[' + noteCitationLabel(round, id) + ']';
  if (mode === 'selection') {
    return body.replace(/\u0000(E\d+)\u0000/gu, (_, id: string) => verified.has(id) ? label(id) : '[' + id + ']');
  }
  return mapAnswerProse(body, (prose) => prose.replace(evidenceMarker(), (marker, digits: string) => {
    const id = 'E' + digits;
    return verified.has(id) ? label(id) : marker;
  }));
}

// Selection marks represent rendered badges, leaving literal [E1] text alone.
function selectionMarker(id: string) {
  return '\u0000' + id + '\u0000';
}

/** Preserve citation identities when the selection contains rendered numeric badges. */
export function selectedNoteText(selection: Selection): string {
  const range = selection.getRangeAt(0);
  if (range.collapsed) return '';
  const ancestor = range.commonAncestorContainer;
  const element = ancestor instanceof Element ? ancestor : ancestor.parentElement;
  const citation = element?.closest<HTMLElement>('.cite-mark');
  if (citation?.dataset.citationId !== undefined) return selectionMarker(citation.dataset.citationId);

  const fragment = range.cloneContents();
  const markers = fragment.querySelectorAll<HTMLElement>('.cite-mark[data-citation-id]');
  const tooltips = fragment.querySelectorAll('.cite-pop');
  if (markers.length === 0 && tooltips.length === 0) return selection.toString().trim();
  for (const tooltip of tooltips) tooltip.remove();
  for (const mark of markers) mark.replaceWith(selectionMarker(mark.dataset.citationId!));
  for (const cell of fragment.querySelectorAll('td:not(:last-child), th:not(:last-child)')) cell.append('\t');
  for (const block of fragment.querySelectorAll('p, li, tr, h1, h2, h3, h4, blockquote, pre')) block.append('\n');
  return fragment.textContent?.trim() ?? '';
}
