import {
  AppError, NOTE_BODY_LIMIT, NOTE_RUN_LIMIT, NOTE_RUN_MODES, NOTE_TAG_CHARS, NOTE_TAG_LIMIT, NOTE_TITLE_LIMIT,
  type CreateResearchNote, type NoteRunInput, type UpdateResearchNote,
} from '@knowpilot/shared';

function invalid(): never {
  throw new AppError('invalid_argument', '笔记字段无效，或超出长度和数量上限。');
}

function object(raw: unknown, keys: readonly string[]) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid();
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) return invalid();
  return record;
}

export function noteRevision(raw: unknown) {
  const value = typeof raw === 'string' && /^[1-9]\d*$/u.test(raw) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid();
  return value;
}

function readRuns(raw: unknown): NoteRunInput[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > NOTE_RUN_LIMIT) return invalid();
  const seen = new Set<string>();
  return raw.map((item) => {
    const { runId, mode } = object(item, ['runId', 'mode']);
    const origin = NOTE_RUN_MODES.find((value) => value === mode);
    if (typeof runId !== 'string' || runId.length === 0 || runId.length > 200 ||
      runId.trim() !== runId || /[\x00-\x1f]/u.test(runId) || seen.has(runId) || origin === undefined) return invalid();
    seen.add(runId);
    return { runId, mode: origin };
  });
}

function readFields(row: Record<string, unknown>) {
  const { title, body, tags } = row;
  if (typeof title !== 'string' || title.trim() === '' || title.trim().length > NOTE_TITLE_LIMIT ||
    typeof body !== 'string' || body.length > NOTE_BODY_LIMIT || !Array.isArray(tags) || tags.length > NOTE_TAG_LIMIT) return invalid();
  const values = tags.map((tag: unknown) => {
    if (typeof tag !== 'string' || tag.trim() === '' || tag.trim().length > NOTE_TAG_CHARS || /[,，]/u.test(tag)) return invalid();
    return tag.trim();
  });
  return { title: title.trim(), body, tags: [...new Set(values)] };
}

export function parseCreateNote(raw: unknown): CreateResearchNote {
  const data = object(raw, ['title', 'body', 'tags', 'runs']);
  return { ...readFields(data), runs: readRuns(data.runs) };
}

export function parseUpdateNote(raw: unknown): UpdateResearchNote {
  const data = object(raw, ['title', 'body', 'tags', 'revision', 'appendRuns']);
  return { ...readFields(data), revision: noteRevision(data.revision), appendRuns: readRuns(data.appendRuns) };
}
