import type { EvidenceLocator } from './search.ts';

export const NOTE_TITLE_LIMIT = 160;
export const NOTE_BODY_LIMIT = 32_000;
export const NOTE_TAG_LIMIT = 12;
export const NOTE_TAG_CHARS = 32;
export const NOTE_RUN_LIMIT = 20;

export const NOTE_RUN_MODES = ['answer', 'selection', 'reference'] as const;
export type NoteRunMode = (typeof NOTE_RUN_MODES)[number];

export interface NoteRunInput {
  runId: string;
  mode: NoteRunMode;
}

export interface CreateResearchNote {
  title: string;
  body: string;
  tags: readonly string[];
  runs?: readonly NoteRunInput[];
}

export interface UpdateResearchNote {
  revision: number;
  title: string;
  body: string;
  tags: readonly string[];
  appendRuns?: readonly NoteRunInput[];
}

export interface ResearchNoteSummary {
  id: string;
  title: string;
  tags: readonly string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface NoteSourceRef {
  citationId: string;
}

export type NoteSource = NoteSourceRef & (
  | { status: 'available'; locator: EvidenceLocator; title: string }
  | { status: 'changed' | 'unavailable' }
);

export interface NoteRun extends NoteRunInput {
  question?: string;
  sources: readonly NoteSource[];
}

export interface ResearchNote extends ResearchNoteSummary {
  body: string;
  runs: readonly NoteRun[];
}
