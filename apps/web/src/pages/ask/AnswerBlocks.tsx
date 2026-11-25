import { formatSectionPath, type AskResponse, type Citation, type OpenEvidence } from '@knowpilot/shared';
import { isAnswerBlocks, type AnswerBlock } from '@knowpilot/shared/answer-blocks';
import { AnswerBody } from './AnswerMarkdown.tsx';
import { renderAnswerCitations, type CitationOpenContext } from './AnswerSources.tsx';
import { fmtQueryTime } from '../../format.ts';
import './answer-blocks.css';

const headings = {
  markdown: '补充说明', summary: '摘要', documents: '相关文档', papers: '论文资料',
  comparison: '指标对比', chart: '指标图表', records: '相关记录', timeline: '记录时间线',
  evidence: '核对依据', steps: '参考步骤',
} as const;

interface SourceProps {
  citations: ReadonlyMap<string, Citation>;
  citationOpen?: CitationOpenContext;
}

function SourceMark({ id, citations, citationOpen }: SourceProps & { id: string }) {
  return <>{renderAnswerCitations(`[${id}]`, citations, citationOpen)}</>;
}

function titleOf(cite: Citation): string {
  return cite.sourceType === 'record' ? cite.recordTitle : cite.documentTitle;
}

function MetricBlock({ block, source }: {
  block: Extract<AnswerBlock, { kind: 'chart' | 'comparison' }>;
  source: SourceProps;
}) {
  const numbers = block.points.map((point) => Number(point.value));
  const lower = Math.min(0, ...numbers);
  const maxValue = Math.max(0, ...numbers);
  const upper = block.unit === '%' && lower === 0 && maxValue <= 100 ? 100 : maxValue;
  return (
    <>
      <p className="dim answer-block-context">
        {block.metric} · {block.dataset} · {block.setting} · {block.protocol}
      </p>
      {block.kind === 'chart' ? (
        <ul className="answer-block-chart">
          {block.points.map((point) => {
            const citation = source.citations.get(point.evidenceId)!;
            const title = titleOf(citation);
            return (
              <li key={point.evidenceId}>
                <span>{title} <SourceMark id={point.evidenceId} {...source} /></span>
                {lower < upper && <meter min={lower} max={upper} value={Number(point.value)}
                  aria-label={`${title} ${block.metric}`} />}
                <span>{point.value} {block.unit}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="answer-block-table" tabIndex={0} role="region" aria-label="指标对比表">
          <table>
            <thead><tr><th scope="col">资料</th><th scope="col">{block.metric}（{block.unit}）</th></tr></thead>
            <tbody>
              {block.points.map((point) => (
                <tr key={point.evidenceId}>
                  <th scope="row">
                    {titleOf(source.citations.get(point.evidenceId)!)} <SourceMark id={point.evidenceId} {...source} />
                  </th>
                  <td>{point.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function SourcesBlock({ block, source }: {
  block: Extract<AnswerBlock, { evidenceIds: string[] }>;
  source: SourceProps;
}) {
  if (block.kind === 'summary' || block.kind === 'markdown') {
    return (
      <>
        <AnswerBody text={block.text} byId={source.citations}
          {...(source.citationOpen === undefined ? {} : { citationOpen: source.citationOpen })} />
        <div className="answer-block-marks">{block.evidenceIds.map((id) => <SourceMark key={id} id={id} {...source} />)}</div>
      </>
    );
  }

  const List = block.kind === 'steps' || block.kind === 'timeline' ? 'ol' : 'ul';
  return (
    <List className="answer-block-list">
      {block.evidenceIds.map((id) => {
        const cite = source.citations.get(id)!;
        return (
          <li key={id}>
            <strong>{titleOf(cite)}</strong> <SourceMark id={id} {...source} />
            {cite.sourceType === 'document' ? (
              <>
                <p className="dim answer-block-context">
                  {cite.page === null ? '无页码' : `第 ${cite.page} 页`}
                  {cite.sectionPath.length > 0 && ` · ${formatSectionPath(cite.sectionPath)}`}
                </p>
                <p>{(cite.quote ?? cite.excerpt).slice(0, 240)}{(cite.quote ?? cite.excerpt).length > 240 ? '…' : ''}</p>
              </>
            ) : (
              <>
                <p className="dim answer-block-context">
                  {cite.recordUpdatedAt === null ? '无更新日期' : `更新于 ${fmtQueryTime(cite.recordUpdatedAt)}`}
                  {' · 查询于 '}{fmtQueryTime(cite.queryTime)}
                </p>
                <dl>{cite.fields.map(({ label, value }, index) => (
                  <div key={index}><dt>{label}</dt><dd>{value}</dd></div>
                ))}</dl>
              </>
            )}
          </li>
        );
      })}
    </List>
  );
}

export default function AnswerBlocks({ response, onOpenEvidence }: { response: AskResponse; onOpenEvidence?: OpenEvidence }) {
  const { blocks, citations } = response.answer;
  if (blocks === undefined) return null;
  if (!isAnswerBlocks(blocks)) return <p className="dim">部分组件不可用，请查看正文。</p>;

  const byId = new Map(citations.map((citation) => [citation.id, citation]));
  const source: SourceProps = { citations: byId,
    ...(onOpenEvidence === undefined ? {} : { citationOpen: { runId: response.runId, onOpenEvidence } }) };
  return (
    <div className="answer-blocks">
      {blocks.items.map((block, index) => {
        const ids = 'points' in block ? block.points.map((point) => point.evidenceId)
          : 'evidenceIds' in block ? block.evidenceIds : [];
        if (block.kind === 'fallback' || ids.some((id) => !byId.has(id))) {
          const different = block.kind === 'fallback' && block.reason === 'incomparable';
          return (
            <p className="dim" key={index}>
              {different ? '资料的指标、数据集、单位、实验设置或统计口径不同，已省略比较。' : '部分组件的依据无法核对，请查看正文。'}
            </p>
          );
        }
        return (
          <section className="answer-block" key={index}>
            <h3>{headings[block.kind]}</h3>
            {'points' in block ? <MetricBlock block={block} source={source} /> : <SourcesBlock block={block} source={source} />}
          </section>
        );
      })}
    </div>
  );
}
