import type { AskProcessCounts, AskProcessEventV1, AskProcessPhase, AskProcessSource, AskProcessStep, AskProcessV1 } from '@knowpilot/shared';

type StepResult = Pick<AskProcessStep, 'candidates' | 'newEvidence' | 'actualMode' | 'lookup' | 'ranking' | 'rankedCandidates' |
  'rankingMs' | 'degraded'>;

export class AskProcessRecorder {
  private readonly steps = new Map<string, AskProcessStep>();
  private readonly seen = new Set<string>();
  private counts: AskProcessCounts = {};

  start(id: string, phase: AskProcessPhase, atMs: number, source?: AskProcessSource, supplementary = false): AskProcessEventV1 {
    const step: AskProcessStep = { order: this.steps.size, phase, atMs, state: 'running',
      ...(source === undefined ? {} : { source }), ...(supplementary ? { supplementary: true } : {}) };
    this.steps.set(id, step);
    return this.event(step);
  }

  end(id: string, durationMs: number | undefined, state: Exclude<AskProcessStep['state'], 'running'> = 'done', result?: StepResult): AskProcessEventV1 | undefined {
    const previous = this.steps.get(id);
    if (previous === undefined || previous.state !== 'running') return undefined;
    const step: AskProcessStep = { ...previous, ...result, state, ...(durationMs === undefined ? {} : { durationMs }) };
    this.steps.set(id, step);
    if (result?.candidates !== undefined) this.counts.candidates = (this.counts.candidates ?? 0) + result.candidates;
    return this.event(step);
  }

  pool(pooled: number, documents: number): void {
    this.counts.pooled = pooled;
    this.counts.documents = documents;
  }

  modelRequest(ids: Iterable<string>): void {
    for (const id of ids) this.seen.add(id);
    this.counts.modelVisible = this.seen.size;
  }

  snapshot(citations: number): AskProcessV1 {
    return { version: 1,
      steps: [...this.steps.values()].map((step) => step.state === 'running' ? { ...step, state: 'interrupted' } : step),
      counts: { ...this.counts, citations },
    };
  }

  private event(step: AskProcessStep): AskProcessEventV1 {
    return { version: 1, step, counts: { ...this.counts } };
  }
}
