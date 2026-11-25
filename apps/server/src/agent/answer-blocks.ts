import { evidenceMarker, extractEvidenceIds, readAnswerTable, type Citation } from '@knowpilot/shared';
import {
  ANSWER_BLOCK_VERSION, MAX_ANSWER_BLOCKS, isModelAnswerBlock,
  type AnswerBlock, type AnswerBlocks, type ModelAnswerBlock,
} from '@knowpilot/shared/answer-blocks';
import { quoteMatchesEvidence } from './citations.ts';

type MetricInput = Extract<ModelAnswerBlock, { kind: 'chart' }>['points'][number];

const datasetLabels = ['数据集', 'Dataset'];
const settingLabels = ['实验设置', '设置', 'Setting', 'Settings', 'Experimental setting', 'Experimental settings'];
const protocolLabels = ['统计口径', '口径', 'Protocol', 'Statistical protocol'];
const reservedMetricLabels = new Set([
  ...datasetLabels, ...settingLabels, ...protocolLabels, '单位', '计量单位', 'Unit', 'Units',
].map(fieldKey));

function fieldKey(label: string): string {
  return label.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

const unverified: AnswerBlock = { kind: 'fallback', reason: 'unverified' };
const incomparable: AnswerBlock = { kind: 'fallback', reason: 'incomparable' };
const htmlTag = /<\/?[a-z][^>]*>|<!--/iu;
const tentativeMetric = /目标|阈值|门槛|未(?:测量|测试|实测|达到|公布|发布)|未达|假设|假想|示例|样例|预计|预期|预测|模拟|拟定|计划|设想|占位|非实测|\b(?:target|threshold|hypothetical|unmeasured|illustrative|expected|projected|simulated|goal)\b|\bnot\s+(?:measured|achieved|observed|published)\b/iu;
const measuredResult = /^(?:实测结果|实测值|实际测量结果|measured (?:results?|values?)|observed (?:results?|values?))\s*[:：][ \t]*(?=\S)/iu;
const proseMarker = /^ {0,3}(?:#{1,6}|[-*+]|[0-9]{1,9}[.)])\s+(?=\S)/u;
const numericExpression = /[\p{N}半零〇一二两兩三四五六七八九十百千万萬亿億兆壹贰貳叁參肆伍陆陸柒捌玖拾佰仟廿卅卌]|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|half|quarter|percent)\b/iu;

function sameLiteral(left: string, right: string): boolean {
  return left.trim().replace(/\s+/gu, ' ') === right.trim().replace(/\s+/gu, ' ');
}

function fullSourceLines(quote: string, excerpt: string): boolean {
  const lines = (value: string) => value.trim().split(/\r?\n/u)
    .map((line) => line.trim().replace(/[^\S\r\n]+/gu, ' ')).join('\n');
  return `\n${lines(excerpt)}\n`.includes(`\n${lines(quote)}\n`);
}

// A numeric line needs an affirmative measurement label in the literal source.
function isMeasuredQuote(quote: string, citation: Citation): boolean {
  return measuredResult.test(quote.trim()) && fullSourceLines(quote, citation.excerpt) &&
    !tentativeMetric.test(citation.excerpt);
}

// A copied quote must identify the measurement and its comparison dimensions together.
function verifiedMetric(point: MetricInput, cite: Citation | undefined): boolean {
  if (cite === undefined || reservedMetricLabels.has(fieldKey(point.metric)) ||
      !quoteMatchesEvidence(point.quote, cite.excerpt) || !isMeasuredQuote(point.quote, cite)) return false;
  if ([point.metric, point.dataset, point.unit, point.setting, point.protocol].some(
    (value) => value.trim() === '' || htmlTag.test(value),
  )) return false;

  const fields = new Map<string, Set<string>>();
  for (const segment of point.quote.trim().replace(measuredResult, '').split(/[;；\n]/u)) {
    const parts = /^\s*([^:：]+)[:：](.+)$/u.exec(segment);
    if (parts === null) continue;
    const label = fieldKey(parts[1]!);
    const values = fields.get(label) ?? new Set<string>();
    values.add(parts[2]!.trim());
    fields.set(label, values);
  }

  function matches(labels: string[], value: string): boolean {
    const entries = labels.flatMap((label) => [...(fields.get(fieldKey(label)) ?? [])]);
    return entries.length === 1 && sameLiteral(entries[0]!, value);
  }

  return (matches([point.metric.trim()], `${point.value} ${point.unit.trim()}`) ||
          matches([point.metric.trim()], `${point.value}${point.unit.trim()}`)) &&
    matches(datasetLabels, point.dataset) &&
    matches(settingLabels, point.setting) &&
    matches(protocolLabels, point.protocol);
}

function tableRowMatches(headers: readonly string[], row: string, excerpt: string): boolean {
  const lines = excerpt.split(/\r?\n/u);
  return lines.some((_, index) => {
    const table = readAnswerTable(lines, index);
    return table !== null && headers.length === table.headers.length &&
      headers.every((label, column) => sameLiteral(label, table.headers[column]!)) &&
      table.rows.some(({ line }) => sameLiteral(row, line));
  });
}

// Keep a contiguous source for each table and independently ground every displayed citation mark.
function verifiedTextSources(text: string, ids: readonly string[], citations: ReadonlyMap<string, Citation>): string[] | null {
  const lines = text.split(/\r?\n/u);
  const used = new Set<string>();
  for (let index = 0; index < lines.length;) {
    const table = readAnswerTable(lines, index);
    const end = table?.end ?? index + 1;
    const unit = lines.slice(index, end).join('\n');
    index = end;

    const unmarked = unit.replace(evidenceMarker(), '');
    const content = (table === null ? unmarked.replace(proseMarker, '') : unmarked).trim();
    const inlineIds = extractEvidenceIds(unit);
    if (content === '') {
      if (inlineIds.length > 0) return null;
      continue;
    }

    const numericLines = content.split(/\r?\n/u)
      .map((line) => table === null ? line : line.replace(/^\s*\|\s*/u, ''))
      .filter((line) => numericExpression.test(line));
    if (numericLines.some((line) => !measuredResult.test(line))) return null;

    const supportsUnit = (id: string) => {
      const citation = citations.get(id);
      return citation !== undefined && (numericLines.length === 0 || !tentativeMetric.test(citation.excerpt)) &&
        (fullSourceLines(content, citation.excerpt) || fullSourceLines(unmarked, citation.excerpt));
    };
    if (table === null && inlineIds.length > 0) {
      if (!inlineIds.every(supportsUnit)) return null;
      for (const id of inlineIds) used.add(id);
      continue;
    }

    const primaryId = ids.find(supportsUnit);
    if (primaryId === undefined) return null;
    used.add(primaryId);
    if (table === null) continue;

    for (const row of table.rows) {
      const rowText = row.line.replace(evidenceMarker(), '');
      for (const id of extractEvidenceIds(row.line)) {
        if (id === primaryId) continue;
        const citation = citations.get(id);
        if (citation === undefined || (numericExpression.test(rowText) && tentativeMetric.test(citation.excerpt)) ||
            !tableRowMatches(table.headers, rowText, citation.excerpt)) return null;
        used.add(id);
      }
    }
  }
  return used.size === 0 ? null : ids.filter((id) => used.has(id));
}

function composeBlock(raw: unknown, citations: ReadonlyMap<string, Citation>): AnswerBlock {
  if (!isModelAnswerBlock(raw)) return unverified;
  const { kind } = raw;

  if (kind === 'comparison' || kind === 'chart') {
    const first = raw.points[0]!;
    const ids = new Set(raw.points.map((point) => point.evidence_id));
    if (ids.size !== raw.points.length || !raw.points.every(
      (point) => verifiedMetric(point, citations.get(point.evidence_id)),
    )) return unverified;
    const dimensions = ['metric', 'dataset', 'unit', 'setting', 'protocol'] as const;
    if (raw.points.some((point) => dimensions.some((key) => !sameLiteral(point[key], first[key])))) {
      return incomparable;
    }
    return {
      kind, metric: first.metric.trim(), dataset: first.dataset.trim(), unit: first.unit.trim(),
      setting: first.setting.trim(), protocol: first.protocol.trim(),
      points: raw.points.map((point) => ({ evidenceId: point.evidence_id, value: point.value })),
    };
  }

  const evidenceIds = raw.evidence_ids;
  if (evidenceIds.some((id) => !citations.has(id))) return unverified;
  if (kind === 'markdown' || kind === 'summary') {
    if (raw.text.trim() === '' || htmlTag.test(raw.text) ||
        extractEvidenceIds(raw.text).some((id) => !evidenceIds.includes(id))) return unverified;
    const verified = verifiedTextSources(raw.text, evidenceIds, citations);
    return verified === null ? unverified : { kind, text: raw.text, evidenceIds: verified };
  }
  if ((kind === 'documents' || kind === 'papers') && evidenceIds.some((id) => {
    const citation = citations.get(id);
    return citation?.sourceType !== 'document' || (kind === 'papers' && citation.material !== 'paper');
  })) return unverified;
  if ((kind === 'records' || kind === 'timeline') && evidenceIds.some(
    (id) => citations.get(id)?.sourceType !== 'record',
  )) return unverified;
  return { kind, evidenceIds };
}

/** All component source IDs must already be in the server-verified answer citations. */
export function composeAnswerBlocks(raw: unknown, citations: readonly Citation[]): AnswerBlocks | undefined {
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_ANSWER_BLOCKS) {
    return { version: ANSWER_BLOCK_VERSION, items: [unverified] };
  }
  const byId = new Map(citations.map((citation) => [citation.id, citation]));
  const items = raw.map((block) => composeBlock(block, byId));
  return { version: ANSWER_BLOCK_VERSION, items };
}
