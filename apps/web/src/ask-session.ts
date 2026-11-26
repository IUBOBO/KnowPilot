import {
  ASK_HISTORY_ANSWER_CHARS,
  ASK_HISTORY_LIMIT,
  ASK_HISTORY_QUESTION_CHARS,
  type AskHistoryTurn,
  type AskResponse,
  type SearchAskHandoffV1,
} from '@knowpilot/shared';

const SESSION_KEY = 'knowpilot.ask.tab.v1';

export const ASK_SCOPE_SESSION_KEY = 'knowpilot.ask.document-scope.v1';
export type SearchContext = Pick<SearchAskHandoffV1, 'query' | 'kind' | 'material' | 'documentId'> & {
  /** Scope conversation context for a note handoff without replacing tab history. */
  researchThread?: string;
  noteResearchTopic?: string;
};
export interface NoteSearchState {
  ownerId: string;
  noteResearchTopic: string;
  researchThread?: string;
  submittedQuery?: string;
}

export function readResearchThread(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9_-]{1,80}$/iu.test(value) ? value : undefined;
}

export function readNoteSearchState(value: unknown, ownerId: string | undefined): NoteSearchState | undefined {
  if (ownerId === undefined || value === null || typeof value !== 'object') return undefined;
  const state = value as Partial<NoteSearchState>;
  if (state.ownerId !== ownerId || typeof state.noteResearchTopic !== 'string') return undefined;
  const researchThread = readResearchThread(state.researchThread);
  if (state.researchThread !== undefined && researchThread === undefined) return undefined;
  return { ownerId, noteResearchTopic: state.noteResearchTopic.slice(0, 100),
    ...(researchThread === undefined ? {} : { researchThread }),
    ...(typeof state.submittedQuery === 'string' ? { submittedQuery: state.submittedQuery.trim().slice(0, 100) } : {}) };
}

export type AskActivity = 'idle' | 'running' | 'answered' | 'failed';
export interface AskTabTurn {
  question: string;
  response: AskResponse;
  searchContext?: SearchContext;
}

export function readAskSession(scope: string): AskTabTurn[] {
  try {
    const stored = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as {
      scope: string;
      turns: AskTabTurn[];
    } | null;
    if (stored?.scope !== scope || !Array.isArray(stored.turns)) return [];
    return stored.turns.filter((turn) => typeof turn?.question === 'string' &&
      typeof turn?.response?.answer?.answer === 'string' &&
      typeof turn?.response?.runId === 'string' && turn?.response?.delivery != null).slice(-ASK_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function writeAskSession(scope: string, turns: readonly AskTabTurn[]): void {
  try {
    if (turns.length === 0) sessionStorage.removeItem(SESSION_KEY);
    else sessionStorage.setItem(SESSION_KEY, JSON.stringify({ scope, turns: turns.slice(-ASK_HISTORY_LIMIT) }));
  } catch {
    // 禁用浏览器存储时，已挂载的会话仍可以跨站内页面使用。
  }
}

export function forgetAskSession(): void {
  writeAskSession('', []);
  try { sessionStorage.removeItem(ASK_SCOPE_SESSION_KEY); } catch { /* Browser storage disabled. */ }
}

export function historyForAsk(turns: readonly AskTabTurn[]): AskHistoryTurn[] {
  return turns.slice(-ASK_HISTORY_LIMIT).map(({ question, response }) => {
    const answer = response.delivery.status === 'verified' ||
        (response.answer.verification.status === 'not_checked' && response.answer.citations.length > 0 &&
          response.answer.warnings.length === 0)
      ? response.answer.answer
      : response.answer.verification.claims.filter((claim) => claim.verdict === 'supported')
          .map((claim) => claim.text).join('\n');
    return {
      question: question.slice(0, ASK_HISTORY_QUESTION_CHARS),
      answer: (answer.trim() || '这轮没有可确认的结论。').slice(0, ASK_HISTORY_ANSWER_CHARS),
    };
  });
}
