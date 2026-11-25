import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

export const ANSWER_BLOCK_VERSION = 1;
export const MAX_ANSWER_BLOCKS = 8;

const EvidenceId = Type.String({ pattern: '^E[1-9][0-9]{0,7}$' });
const EvidenceIds = Type.Array(EvidenceId, { minItems: 1, maxItems: 10, uniqueItems: true });
const Label = Type.String({ minLength: 1, maxLength: 80 });
const BlockText = Type.String({ minLength: 1, maxLength: 2000 });
const NumberText = Type.String({ pattern: '^-?[0-9]{1,8}(\\.[0-9]{1,8})?$' });

const MetricContext = {
  metric: Label,
  dataset: Label,
  unit: Label,
  setting: Label,
  protocol: Label,
};

const MetricInput = Type.Object({
  ...MetricContext,
  evidence_id: EvidenceId,
  value: NumberText,
  quote: Type.String({ minLength: 8, maxLength: 600 }),
}, { additionalProperties: false });

const ModelTextBlock = <const Kind extends string>(kind: Kind) => Type.Object({
  kind: Type.Literal(kind), text: BlockText, evidence_ids: EvidenceIds,
}, { additionalProperties: false });

const ModelSourcesBlock = <const Kind extends string>(kind: Kind) => Type.Object({
  kind: Type.Literal(kind), evidence_ids: EvidenceIds,
}, { additionalProperties: false });

const ModelMetricBlock = <const Kind extends string>(kind: Kind) => Type.Object({
  kind: Type.Literal(kind), points: Type.Array(MetricInput, { minItems: 2, maxItems: 8 }),
}, { additionalProperties: false });

export const ModelAnswerBlockSchema = Type.Union([
  ModelTextBlock('markdown'), ModelTextBlock('summary'),
  ModelSourcesBlock('documents'), ModelSourcesBlock('papers'),
  ModelMetricBlock('comparison'), ModelMetricBlock('chart'),
  ModelSourcesBlock('records'), ModelSourcesBlock('timeline'),
  ModelSourcesBlock('evidence'), ModelSourcesBlock('steps'),
]);

export type ModelAnswerBlock = Static<typeof ModelAnswerBlockSchema>;

const TextBlock = <const Kind extends string>(kind: Kind) => Type.Object({
  kind: Type.Literal(kind), text: BlockText, evidenceIds: EvidenceIds,
}, { additionalProperties: false });

const SourcesBlock = <const Kind extends string>(kind: Kind) => Type.Object({
  kind: Type.Literal(kind), evidenceIds: EvidenceIds,
}, { additionalProperties: false });

const MetricBlock = <const Kind extends string>(kind: Kind) => Type.Object({
  kind: Type.Literal(kind),
  ...MetricContext,
  points: Type.Array(Type.Object({
    evidenceId: EvidenceId, value: NumberText,
  }, { additionalProperties: false }), { minItems: 2, maxItems: 8 }),
}, { additionalProperties: false });

export const AnswerBlockSchema = Type.Union([
  TextBlock('markdown'), TextBlock('summary'),
  SourcesBlock('documents'), SourcesBlock('papers'),
  MetricBlock('comparison'), MetricBlock('chart'),
  SourcesBlock('records'), SourcesBlock('timeline'),
  SourcesBlock('evidence'), SourcesBlock('steps'),
  Type.Object({
    kind: Type.Literal('fallback'),
    reason: Type.Union([Type.Literal('unverified'), Type.Literal('incomparable')]),
  }, { additionalProperties: false }),
]);

export const AnswerBlocksSchema = Type.Object({
  version: Type.Literal(ANSWER_BLOCK_VERSION),
  items: Type.Array(AnswerBlockSchema, { minItems: 1, maxItems: MAX_ANSWER_BLOCKS }),
}, { additionalProperties: false });

export type AnswerBlock = Static<typeof AnswerBlockSchema>;
export type AnswerBlocks = Static<typeof AnswerBlocksSchema>;

export function isModelAnswerBlock(value: unknown): value is ModelAnswerBlock {
  return Value.Check(ModelAnswerBlockSchema, value);
}

export function isAnswerBlocks(value: unknown): value is AnswerBlocks {
  return Value.Check(AnswerBlocksSchema, value);
}
