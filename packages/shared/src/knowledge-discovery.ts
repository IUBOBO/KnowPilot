import type { KnowledgeDraftSource } from './knowledge.ts';

export const KNOWLEDGE_DISCOVERY_LABELS = {
  new: '新增',
  duplicate: '完全重复',
  supplement: '补充',
  version: '版本变化',
  conflict: '冲突',
  insufficient: '证据不足',
} as const;

export type KnowledgeDiscoveryKind = keyof typeof KNOWLEDGE_DISCOVERY_LABELS;

export interface KnowledgeDiscoveryContext {
  topic?: string;
  project?: string;
  version?: string;
  time?: string;
  conditions?: string;
}

export interface KnowledgeDiscoveryMatch {
  kind: KnowledgeDiscoveryKind;
  reason: string;
  score: number;
  neighbor: { id: string; revision: string; excerpt: string; context: KnowledgeDiscoveryContext } | null;
  context: KnowledgeDiscoveryContext;
}

export interface KnowledgeSuggestion extends KnowledgeDiscoveryMatch {
  id: string;
  createdAt: string;
  source: Exclude<KnowledgeDraftSource, { kind: 'manual' }>;
  excerpt: string;
}

export interface KnowledgeDiscoveryResponse {
  enabled: boolean;
  items: readonly KnowledgeSuggestion[];
}

export interface KnowledgeLifecycleReview {
  kind: 'supplement' | 'version' | 'conflict';
  targetId: string;
  targetRevision: string;
  targetContext: KnowledgeDiscoveryContext;
  incomingContext: KnowledgeDiscoveryContext;
  mode: 'merge' | 'update' | 'admit' | 'reject' | 'pending';
}
