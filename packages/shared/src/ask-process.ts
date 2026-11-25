import type { Material, SearchMode } from './documents.ts';

export type AskProcessPhase =
  | 'intent' | 'understanding' | 'resume' | 'retrieval' | 'generation' | 'quote_repair' | 'verification';

export type AskProcessSource = 'documents' | 'paper' | 'submissions' | 'datasets' | 'journals' | 'patents' | 'theses' | 'people';

export interface AskProcessLookup {
  requestedMode: SearchMode;
  scope: 'library' | 'document';
  material?: Material;
  limit: number;
}

export interface AskProcessStep {
  /** Display-only ordinal. A tool call ID and its arguments are never exposed here. */
  order: number;
  phase: AskProcessPhase;
  atMs: number;
  state: 'running' | 'done' | 'failed' | 'interrupted' | 'skipped';
  durationMs?: number;
  source?: AskProcessSource;
  supplementary?: true;
  /** Returned, permission-filtered candidates before model context selection, per lookup. */
  candidates?: number;
  newEvidence?: number;
  actualMode?: SearchMode;
  lookup?: AskProcessLookup;
  ranking?: 'reranked' | 'fallback';
  rankedCandidates?: number;
  rankingMs?: number;
  degraded?: true;
}

export interface AskProcessCounts {
  /** Number of candidates returned across measured lookups, with repeats. */
  candidates?: number;
  /** Unique documents represented in the evidence pool. */
  documents?: number;
  /** Unique document chunks and record entries in the pool, including restored evidence. */
  pooled?: number;
  /** Unique numbered entries present in at least one generation request context. */
  modelVisible?: number;
  /** Citation entries on the delivered, server-checked answer. */
  citations?: number;
}

export interface AskProcessEventV1 {
  version: 1;
  step: AskProcessStep;
  counts: AskProcessCounts;
}

export interface AskProcessV1 {
  version: 1;
  steps: readonly AskProcessStep[];
  counts: AskProcessCounts;
}
