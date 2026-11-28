import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { AskResponse, Citation, DocumentCitation, EvidenceOpenRequest } from '@knowpilot/shared';
import type { AnswerBlock } from '@knowpilot/shared/answer-blocks';
import { AuthProvider } from '../src/auth.tsx';
import { AskAnswer } from '../src/pages/ask/AskAnswer.tsx';
import '../src/index.css';
import '../src/a-theme.css';
import '../src/pages/ask/ask.css';

const moment = '2026-01-01T00:00:00Z';
const summaryLine = '该摘要用于演示合成材料。';
const sourceTable = '| 核对项 | 来源 |\n| --- | --- |\n| 阅读摘要 | 论文乙 |';
const document = (id: string, title: string, page: number, value: string): DocumentCitation => {
  const measurement = `实测结果：准确率：${value}%；数据集：合成数据集；实验设置：固定划分；统计口径：宏平均`;
  const excerpt = [measurement, id === 'E1' ? summaryLine : sourceTable].join('\n');
  return {
    id, sourceType: 'document', documentId: `document-${id}`, documentTitle: title,
    material: 'paper', page, sectionPath: ['合成评测'], chunkId: `chunk-${id}`, score: 1,
    sourceVersion: '5', excerpt, quote: excerpt, originalChars: excerpt.length,
  };
};
const citations: Citation[] = [
  document('E1', '合成论文甲', 2, '95'),
  document('E2', '合成论文乙', 4, '91'),
  {
    id: 'E3', sourceType: 'record', recordType: 'M-SUBMIT', recordId: 'fixture-record', recordTitle: '合成投稿',
    queryTime: moment, recordUpdatedAt: moment, sourceVersion: moment,
    fields: [{ label: '状态', value: '外审中' }], excerpt: '状态：外审中', originalChars: 6,
  },
];
const metric = {
  metric: '准确率', dataset: '合成数据集', unit: '%', setting: '固定划分', protocol: '宏平均',
  points: [{ evidenceId: 'E1', value: '95' }, { evidenceId: 'E2', value: '91' }],
};
const cases: { label: string; id: string; body: string; blocks?: AnswerBlock[] }[] = [
  { label: '文档查找', id: 'document', body: '定位到 **合成资料**。[E1]', blocks: [{ kind: 'documents', evidenceIds: ['E1'] }] },
  { label: '简单问答', id: 'simple', body: '合成旧文本仍可读取。[E1]' },
  { label: '多论文比较', id: 'compare', body: '这里有两个合成来源。[E1] [E2]', blocks: [
    { kind: 'papers', evidenceIds: ['E1', 'E2'] }, { kind: 'comparison', ...metric },
  ] },
  { label: '指标分析', id: 'metric', body: '合成指标如下。[E1] [E2]', blocks: [{ kind: 'chart', ...metric }] },
  { label: '投稿进展', id: 'record', body: '合成投稿处于外审。[E3]', blocks: [
    { kind: 'records', evidenceIds: ['E3'] }, { kind: 'timeline', evidenceIds: ['E3'] },
  ] },
  { label: '综合报告', id: 'mixed', body: '两篇合成资料采用同一口径。[E1] [E2]', blocks: [
    { kind: 'summary', text: summaryLine + '[E1]', evidenceIds: ['E1'] },
    { kind: 'markdown', text: sourceTable.replace('论文乙', '论文乙 [E2]'), evidenceIds: ['E2'] },
    { kind: 'chart', ...metric },
    { kind: 'evidence', evidenceIds: ['E2'] },
    { kind: 'steps', evidenceIds: ['E1'] },
    { kind: 'fallback', reason: 'incomparable' },
  ] },
];
const byId = new Map(citations.map((item) => [item.id, item]));
function Fixture() {
  const [index, setIndex] = useState(0);
  const [reader, setReader] = useState<EvidenceOpenRequest | null>(null);
  const [allowed, setAllowed] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();
  const { id, label, body, blocks } = cases[index]!;
  const response: AskResponse = {
    runId: `fixture-${id}`, question: label,
    delivery: { status: 'verified', stopReason: 'completed', evidenceCount: 3, contextChars: 30,
      verifiedClaimIds: [], unverifiedClaimIds: [] },
    answer: {
      answer: body, citations, warnings: [], evidenceGaps: [], limits: [], confidenceNotes: [], conflicts: [],
      verification: { status: 'not_checked', counts: { supported: 0, contradicted: 0, insufficient: 0, review_required: 0 }, claims: [] },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      rounds: 1, durationMs: 1,
      ...(blocks === undefined ? {} : { blocks: { version: 1, items: blocks } }),
    },
  };
  return (
    <main style={{ maxWidth: 880, margin: '24px auto', padding: '0 12px' }}>
      <h1>回答组件合成回归</h1>
      <nav aria-label="合成问题">
        {cases.map(({ label, id }, nextIndex) => (
          <button key={id} type="button" onClick={() => { setReader(null); setIndex(nextIndex); }}>{label}</button>
        ))}
      </nav>
      <AskAnswer key={id} result={response} byId={byId} consent={false}
        sourceCount={3} readerOpen={false} sourceButtonRef={triggerRef}
        onToggleReader={() => {}} onRetry={() => {}} blocks={null}
        onOpenEvidence={(request) => { setReader(request); return allowed; }} />
      <label><input type="checkbox" checked={allowed} onChange={(event) => setAllowed(event.currentTarget.checked)} />模拟阅读器接收</label>
      <pre aria-label="模拟阅读器请求">{reader === null ? '' : JSON.stringify(reader)}</pre>
      <output aria-label="当前路由">{pathname}</output>
    </main>
  );
}

createRoot(window.document.getElementById('root')!).render(<MemoryRouter><AuthProvider><Fixture /></AuthProvider></MemoryRouter>);
