import type { KnowledgeDiscoveryContext, KnowledgeDiscoveryMatch } from '@knowpilot/shared';
import { draftFingerprint } from './draft-source.ts';

export const DISCOVERY_COOLDOWN_MS = 10 * 60_000;
export const DISCOVERY_DAILY_LIMIT = 6;
export const DISCOVERY_PENDING_LIMIT = 6;
export const DISCOVERY_SIMILARITY_THRESHOLD = 0.55;

interface Candidate {
  id: string;
  revision: string;
  content: string;
}

const wordSegments = new Intl.Segmenter('zh', { granularity: 'word' });
const contextFields = { 主题: 'topic', 项目: 'project', 版本: 'version', 时间: 'time', 条件: 'conditions' } as const;

export function normalizeKnowledge(value: string): string {
  // Fold fullwidth ASCII without merging scientific superscripts or unit case.
  return value.normalize('NFC').replace(/[\uFF01-\uFF5E]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/gu, ' ').trim();
}

export function discoveryFingerprint(value: string): string {
  // Fold presentation variation without concatenating distinct words or numbers.
  return draftFingerprint(normalizeKnowledge(value));
}

function parseContext(text: string) {
  const context: KnowledgeDiscoveryContext = {};
  let claim: string | undefined;
  const ambiguousFields = new Set<keyof KnowledgeDiscoveryContext | 'claim'>();
  for (const match of text.matchAll(/^\s*(?:[-*]\s+)?(主题|项目|版本|时间|条件|结论)\s*[:：]\s*([^\r\n]{1,200})$/gmu)) {
    const field = match[1]!;
    const value = normalizeKnowledge(match[2]!);
    if (value === '') continue;
    if (field === '结论') {
      if (claim !== undefined && claim !== value) ambiguousFields.add('claim');
      claim = value;
    } else {
      const key = contextFields[field as keyof typeof contextFields];
      if (context[key] !== undefined && context[key] !== value) ambiguousFields.add(key);
      context[key] = value;
    }
  }
  return { context, claim, ambiguous: ambiguousFields.size !== 0, ambiguousFields };
}

function terms(text: string): Set<string> {
  return new Set([...wordSegments.segment(normalizeKnowledge(text).toLowerCase())]
    .filter((token) => token.isWordLike)
    .map((token) => token.segment));
}

function similarities(left: Set<string>, right: Set<string>): number {
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection === 0 ? 0 : intersection / (left.size + right.size - intersection);
}

function distinct(left: ReturnType<typeof parseContext>, right: ReturnType<typeof parseContext>,
  keys: readonly (keyof KnowledgeDiscoveryContext)[]): boolean {
  return keys.some((key) => !left.ambiguousFields.has(key) && !right.ambiguousFields.has(key) &&
    left.context[key] !== undefined && right.context[key] !== undefined && left.context[key] !== right.context[key]);
}

function comparable(left: KnowledgeDiscoveryContext, right: KnowledgeDiscoveryContext): boolean {
  return (['topic', 'project', 'conditions', 'version', 'time'] as const)
    .every((key) => left[key] !== undefined && right[key] !== undefined);
}

function opposite(left: string, right: string): boolean {
  const negative = (value: string) => /^(?:不|未|无)\s*(.+)$/u.exec(value)?.[1];
  return negative(left) === right || negative(right) === left;
}

export function hasDifferentProjectOrConditions(left: string, right: string): boolean {
  return distinct(parseContext(left), parseContext(right), ['project', 'conditions']);
}

export function classifyKnowledge(content: string, candidates: readonly Candidate[]): KnowledgeDiscoveryMatch {
  const incoming = parseContext(content);
  const context = incoming.context;
  if (normalizeKnowledge(content).replace(/[^\p{L}\p{N}]/gu, '').length < 10 || incoming.ambiguous) {
    return { kind: 'insufficient', reason: '材料过短或同一字段有多个值，先补充出处与条件。', score: 0, neighbor: null, context };
  }

  const fingerprint = discoveryFingerprint(content);
  const inputTerms = terms(content);
  let best: { item: Candidate; scope: ReturnType<typeof parseContext>; score: number; rank: number; exact: boolean } | undefined;
  for (const item of candidates) {
    const scope = parseContext(item.content);
    if (distinct(incoming, scope, ['topic', 'project', 'conditions'])) continue;
    const exact = discoveryFingerprint(item.content) === fingerprint;
    const score = exact ? 1 : similarities(inputTerms, terms(item.content));
    const topic = context.topic !== undefined && context.topic === scope.context.topic;
    if (score < DISCOVERY_SIMILARITY_THRESHOLD && !topic) continue;
    const sameVersionConflict = !scope.ambiguous && comparable(context, scope.context) &&
      context.version === scope.context.version && context.time === scope.context.time &&
      incoming.claim !== undefined && scope.claim !== undefined && opposite(incoming.claim, scope.claim);
    const rank = (exact ? 5 : sameVersionConflict ? 3 : topic ? 1 : 0) + score;
    if (best === undefined || rank > best.rank || (rank === best.rank && item.id < best.item.id)) {
      best = { item, scope, score, rank, exact };
    }
  }
  if (best === undefined) return { kind: 'new', reason: '在可见的正式知识中未找到足够相似的条目。', score: 0, neighbor: null, context };

  const neighbor = {
    id: best.item.id, revision: best.item.revision, excerpt: best.item.content.slice(0, 500),
    context: best.scope.context,
  };
  const match = { score: best.score, neighbor, context };
  if (best.exact) return { ...match, kind: 'duplicate', reason: '去除排版差异后正文完全相同。' };
  const old = best.scope;
  if (old.ambiguous || !comparable(context, old.context) || !incoming.claim || !old.claim) {
    return { ...match, kind: 'insufficient', reason: '材料相似，但主题、项目、版本、时间、条件或结论不足。' };
  }
  if (context.version !== old.context.version || context.time !== old.context.time) {
    return { ...match, kind: 'version', reason: '同主题、项目和条件下，显式版本或适用时间发生变化。' };
  }
  if (opposite(incoming.claim, old.claim)) {
    return { ...match, kind: 'conflict', reason: '相同背景下存在明确相反的结论，需核对原始依据。' };
  }
  if (incoming.claim === old.claim) {
    return { ...match, kind: 'supplement', reason: '结论相同，正文包含不同细节，需人工核对可补充内容。' };
  }
  return { ...match, kind: 'insufficient', reason: '差异尚不足以判断存在明确矛盾。' };
}
