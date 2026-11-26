import { createRoot } from 'react-dom/client';
import { EvidenceViewer, useEvidenceViewer } from '../../src/components/evidence/EvidenceViewer.tsx';
import type { EvidenceReaderSources } from '../../src/components/evidence/evidence-reader.ts';
import { cases } from './pdf-preview-cases.mjs';
import '../../src/index.css';
import '../../src/a-theme.css';

const sources: EvidenceReaderSources = cases.map(({ id, doc, version, quote }) => ({
  request: {
    version: 1, locator: { kind: 'document', chunkId: id, documentId: doc, sourceVersion: version ?? '4' },
    ...(id.startsWith('search') ? {} : { citation: { runId: 'synthetic-answer', citationId: id } }),
  },
  ...(quote === undefined ? {} : { quote }),
}));

function Fixture() {
  const viewer = useEvidenceViewer(sources, 'pdf-fixture');
  return <main style={{ padding: '1rem', marginInline: 'auto', maxWidth: '90rem' }}>
    <h1>PDF 预览合成验收</h1>
    <EvidenceViewer reader={viewer.reader}>
      <section aria-label="合成引用列表" className="card">
        {sources.map(({ request }, index) => <button type="button" key={index} className="link-btn"
          onClick={() => viewer.onOpenEvidence(request)}>引用 {cases[index]!.id}</button>)}
      </section>
    </EvidenceViewer>
  </main>;
}

createRoot(document.querySelector('#fixture-root')!).render(<Fixture />);
