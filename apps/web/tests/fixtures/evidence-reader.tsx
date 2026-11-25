import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type Citation, type DocumentCitation, type EvidenceOpenRequest, type RecordCitation } from '@knowpilot/shared';
import { answerEvidenceSources, type EvidenceReaderSources } from '../../src/components/evidence/evidence-reader.ts';
import { EvidenceViewer, useEvidenceViewer } from '../../src/components/evidence/EvidenceViewer.tsx';
import '../../src/index.css';
import '../../src/a-theme.css';

function documentCitation(chunkId: string, n: number, quote: string, sourceVersion = '2'): DocumentCitation {
  return {
    id: `E${n}`, sourceType: 'document', excerpt: '缓存来源不得显示', originalChars: 20, sourceVersion,
    documentId: 'fixture-doc', documentTitle: '缓存标题不得显示', material: 'sop', page: 2,
    sectionPath: ['合成章节'], chunkId, quote, score: 1,
  };
}
const record: RecordCitation = {
  id: 'E5', sourceType: 'record', excerpt: '缓存记录不得显示', originalChars: 20,
  sourceVersion: '2026-01-01T00:00:00Z', recordType: 'M-SUBMIT', recordId: 'fixture-record',
  recordTitle: '缓存记录不得显示', queryTime: '2026-01-01T00:00:00Z',
  recordUpdatedAt: '2026-01-01T00:00:00Z', fields: [{ label: '状态', value: '缓存状态不得显示' }],
};
const citations: readonly Citation[] = [
  documentCitation('fresh', 1, '唯一摘录'),
  documentCitation('archive', 2, '历史摘录', '1'),
  documentCitation('ambiguous', 3, '重复摘录'),
  documentCitation('denied', 4, '不可显示'),
  record,
  documentCitation('missing', 6, '不可显示'),
  documentCitation('slow', 7, '慢响应内容'),
  documentCitation('signed-out', 8, '不可显示'),
  documentCitation('version-mismatch', 9, '唯一摘录'),
  { ...record, id: 'E10', recordType: 'M-CODE', recordId: 'fixture-asset' },
  { ...record, id: 'E11', recordType: 'M-JOURNAL', recordId: 'fixture-journal' },
  { ...record, id: 'E12', recordType: 'M-JOURNAL', recordId: 'fixture-journal:2021:JCR:合成:维度',
    sourceVersion: '2021 JCR 合成:维度' },
  { ...record, id: 'E13', recordType: 'M-JOURNAL', recordId: 'fixture-journal:2021:JCR:合成:维度',
    sourceVersion: '2020 JCR 合成:维度' },
];
const answerSources = answerEvidenceSources('fixture-run', citations);
const searchSources: EvidenceReaderSources = [{ request: { version: 1, locator: {
  kind: 'document', documentId: 'fixture-doc', chunkId: 'fresh', sourceVersion: '2',
} } }];

const names = [
  '打开当前片段', '打开历史片段', '打开重复摘录', '打开无权限片段',
  '打开台账记录', '打开失效片段', '打开慢速片段', '打开登录失效片段', '打开版本变化片段',
  '打开数据集证据', '打开旧期刊入口', '打开期刊分区证据', '打开期间不符的证据',
];

function Fixture() {
  const [search, setSearch] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [legacy, setLegacy] = useState<string | null>(null);
  const sources = search ? searchSources : answerSources;
  const viewer = useEvidenceViewer(sources, search ? 'search' : 'answer');
  function tryUnissued() {
    const request = answerSources[0]?.request;
    if (request === undefined) throw Error('fixture');
    const other: EvidenceOpenRequest = { ...request, citation: { runId: 'other-run', citationId: 'E1' } };
    setRejected(!viewer.onOpenEvidence(other));
  }
  return <main style={{ margin: '1rem auto', padding: '1rem', maxWidth: '92rem' }}>
    <h1>证据阅读器合成测试</h1>
    <p aria-label="活动页面">{search ? '检索结果' : '智能问答'}</p>
    <button type="button" onClick={() => setSearch(!search)}>{search ? '返回问答' : '切换检索结果'}</button>
    <EvidenceViewer reader={viewer.reader}>
      <section className="card" style={{ minHeight: '150vh', padding: '1rem' }} aria-label="会话或搜索结果">
        <label>未发送的追问 <input defaultValue="" /></label>
        <details open>
          <summary>合成来源</summary>
          {sources.map(({ request }, index) => <p key={index}>
            <button type="button" onClick={() => {
              if (!viewer.onOpenEvidence(request)) setLegacy(names[index] ?? null);
            }}>
              {search ? '打开检索片段' : names[index]}
            </button>
          </p>)}
          <button type="button" onClick={tryUnissued}>尝试其他会话的引用</button>
          {rejected && <p role="status">未接受该引用</p>}
          {legacy !== null && <p role="status">{legacy}保留原入口</p>}
        </details>
      </section>
    </EvidenceViewer>
  </main>;
}

const root = document.getElementById('fixture-root');
if (root === null) throw Error('Fixture root not found');
createRoot(root).render(<Fixture />);
