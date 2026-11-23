/** Same-snapshot, read-only replay of human-reviewed references. No chat-model calls. */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embeddingModelKey, loadConfig } from '../config.ts';
import { searchDocuments } from '../documents/search.ts';
import { createRetrieveTool, type RetrieveDetails } from '../agent/tools.ts';
import { EvidencePool } from '../agent/evidence.ts';

interface Reference { documentId:string;contentHash:string;page:number|null;text:string }
interface ReviewedCase { id:string;question:string;status:string;evidence:Reference[];review:{answer:number;evidence:number;needsContext?:boolean} }
const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const args=new Map<string,string>();
for(let i=2;i<process.argv.length;i+=2){
 const key=process.argv[i],value=process.argv[i+1];
 if(!key || !['--cases','--report','--baseline'].includes(key) || !value) throw Error('参数：--cases <reviewed-cases.json> --report <新报告.json> [--baseline <旧报告.json>]');
 args.set(key,value);
}
const casesPath=args.get('--cases'),reportPath=args.get('--report');
if(!casesPath || !reportPath)throw Error('必须指定 --cases 和 --report，避免覆盖既有基线。');
const input=JSON.parse(readFileSync(resolve(repoRoot,casesPath),'utf8')) as {kind:string;snapshot:string;cases:ReviewedCase[]};
if(input.kind!=='knowpilot-human-reviewed-rag-cases' || !/^[a-f0-9]{64}$/u.test(input.snapshot))throw Error('不是本项目已审核的用例文件。');
const cfg={...loadConfig(),rerankEnabled:false};
const db=new DatabaseSync(cfg.dbPath,{readOnly:true});
const results=[];
let snapshot='';
try{
 db.exec('BEGIN');
 const docs=db.prepare('SELECT id,title,content_hash,index_version FROM documents ORDER BY title').all() as {id:string;title:string;content_hash:string;index_version:number}[];
 const chunks=db.prepare('SELECT id,doc_id,ordinal,page,section_path,text FROM doc_chunks ORDER BY doc_id,ordinal').all() as {id:string;doc_id:string;ordinal:number;page:number|null;section_path:string|null;text:string}[];
 snapshot=createHash('sha256').update(JSON.stringify({docs:docs.map(d=>[d.id,d.content_hash,d.index_version]),chunks})).digest('hex');
 if(snapshot!==input.snapshot)throw Error('资料或索引快照已变化，不能直接与本批人工标记比较。请冻结对应快照或重新确认来源。');
 const vectors=db.prepare('SELECT COUNT(*) AS n FROM chunk_embeddings WHERE model=?').get(embeddingModelKey(cfg)) as {n:number};
 const fts=db.prepare('SELECT COUNT(*) AS n FROM doc_chunks c JOIN doc_chunks_fts_docsize f ON f.id=c.rowid').get() as {n:number};
 if(vectors.n!==chunks.length || fts.n!==chunks.length)throw Error('向量或FTS覆盖不完整，不能作为同配置混合检索基线。');
 const cases=input.cases.filter(c=>c.status==='approved_evidence');
 if(cases.length===0 || new Set(cases.map(c=>c.id)).size!==cases.length)throw Error('无已审核原文用例或题号重复。');
 for(const c of cases){
  if(c.review?.answer!==0 || c.review?.evidence!==0 || c.review?.needsContext || !c.evidence.length)throw Error(c.id+' 状态与人工标记不一致');
  const refs=new Set<string>();
  for(const e of c.evidence){
   if(typeof e.text!=='string' || e.text.replace(/\s/gu,'').length<8)throw Error(c.id+' 引文为空或不足8字');
   const doc=docs.find(d=>d.id===e.documentId && d.content_hash===e.contentHash);
   if(!doc)throw Error(c.id+' 原文版本不符');
   const mapped=chunks.filter(x=>x.doc_id===doc.id && x.page===e.page && x.text.includes(e.text));
   if(mapped.length===0)throw Error(c.id+' 已审核引文无法定位');
   mapped.forEach(x=>refs.add(x.id));
  }
  if(refs.size===0)throw Error(c.id+' 缺少已审核原文');
  const start=performance.now();
  const found=await searchDocuments(db,cfg,{query:c.question,mode:'hybrid',limit:30});
  if(found.mode!=='hybrid')throw Error(c.id+' 实际检索已降级，不能混入本基线');
  const hits=found.hits.map(h=>({chunkId:h.chunkId,documentId:h.documentId,title:h.documentTitle,page:h.page,sectionPath:h.sectionPath}));
  const searchMs=performance.now()-start;
  const docsWithReference=new Set(c.evidence.map(e=>e.documentId));
  const first=hits.findIndex(h=>refs.has(h.chunkId))+1;
  const pool=new EvidencePool();
  const tool=createRetrieveTool({db,config:cfg,pool});
  const toolStarted=performance.now();
  const output=await tool.execute('reviewed-'+c.id,{query:c.question,mode:'hybrid',limit:8});
  const details=output.details as RetrieveDetails;
  const shownChunkIds=details.evidenceIds.flatMap(id=>{const e=pool.get(id);return e?.kind==='document'?[e.chunkId]:[];});
  if((details.renderedChars??0)>8000)throw Error(c.id+' 超过工具上下文预算');
  results.push({id:c.id,question:c.question,ms:searchMs,toolMs:performance.now()-toolStarted,referenceChunkIds:[...refs],
   documentHitAt8:hits.slice(0,8).some(h=>docsWithReference.has(h.documentId)),referenceHitAt8:first>0&&first<=8,
   referenceHitAt30:first>0,firstReferenceRank:first||null,referenceMrrAt8:first>0&&first<=8?1/first:0,
   shownReferenceHit:shownChunkIds.some(id=>refs.has(id)),shownChunkIds,sectionEvidenceChunkIds:details.sectionEvidenceChunkIds??[],
   renderedChars:details.renderedChars??0,hits,notice:found.notice??null});
 }
 db.exec('COMMIT');
}finally{db.close();}
const summary={cases:results.length,documentHitAt8:results.filter(c=>c.documentHitAt8).length,
 referenceHitAt8:results.filter(c=>c.referenceHitAt8).length,referenceHitAt30:results.filter(c=>c.referenceHitAt30).length,
 referenceMrrAt8:results.reduce((s,c)=>s+c.referenceMrrAt8,0)/results.length,
 shownReferenceHit:results.filter(c=>c.shownReferenceHit).length,
 maxRenderedChars:Math.max(...results.map(c=>c.renderedChars))};
const baseline=args.get('--baseline')?JSON.parse(readFileSync(resolve(repoRoot,args.get('--baseline')!),'utf8')) as {snapshot:string;cases:{id:string;firstReferenceRank:number|null}[];summary:unknown}:null;
if(baseline && baseline.snapshot!==snapshot)throw Error('比较报告的快照不一致');
const comparison=baseline?{before:baseline.summary,after:summary,cases:results.map(c=>({id:c.id,beforeRank:baseline.cases.find(b=>b.id===c.id)?.firstReferenceRank??null,afterRank:c.firstReferenceRank}))}:null;
const sourceHash=createHash('sha256');
for(const path of ['documents/search.ts','documents/retrieval-policy.ts','agent/tools.ts','agent/prompt.ts'])sourceHash.update(path).update(readFileSync(resolve(repoRoot,'apps/server/src',path)));
const report={kind:'knowpilot-reviewed-reference-baseline',createdAt:new Date().toISOString(),snapshot,sourceFingerprint:sourceHash.digest('hex'),
 config:{mode:'hybrid',rerankEnabled:false,embedModelId:cfg.embedModelId,embedDtype:cfg.embedDtype},
 metricScope:'已审核参考定位覆盖；未穷举等价出处，不代表完整Recall或回答准确率；AI起草经单用户复核，非盲测集',summary,comparison,cases:results};
const destination=resolve(repoRoot,reportPath);
if(destination===resolve(repoRoot,casesPath) || (args.get('--baseline') && destination===resolve(repoRoot,args.get('--baseline')!)))throw Error('报告不能覆盖用例或旧基线');
mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,JSON.stringify(report,null,2));
console.log(JSON.stringify(summary));
