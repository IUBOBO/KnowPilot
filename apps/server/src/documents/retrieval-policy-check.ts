/** Isolated regressions for document targeting, boilerplate and citable continuations. */
import { segmentForIndex, type SearchHit } from '@knowpilot/shared';
import { openDb } from '../db/index.ts';
import { loadConfig } from '../config.ts';
import { createRetrievalPolicy } from './retrieval-policy.ts';
import { expandSectionEvidence, searchDocuments } from './search.ts';
import { createRetrieveTool, type RetrieveDetails } from '../agent/tools.ts';
import { EvidencePool } from '../agent/evidence.ts';
import { buildSystemPrompt } from '../agent/prompt.ts';
const {db}=openDb(':memory:'); const cfg={...loadConfig(),embedModelDir:'__policy_test_no_model__'};
let passed=0,failed=0;
function check(name:string,ok:boolean){console.log(`${ok?'✓':'✗'} ${name}`);if(ok)passed++;else failed++;}
function doc(id:string,title:string,material='paper'){
 db.prepare('INSERT INTO documents(id,title,material,content_hash,created_at) VALUES(?,?,?,?,?)').run(id,title,material,id,'2026-01-01');
}
function chunk(id:string,docId:string,ordinal:number,text:string,path:string[]=[],page:number|null=null){
 db.prepare('INSERT INTO doc_chunks(id,doc_id,ordinal,text,text_seg,page,section_path,token_count) VALUES(?,?,?,?,?,?,?,?)').run(id,docId,ordinal,text,segmentForIndex(text),page,JSON.stringify(path),text.length);
}
function hit(id:string,docId:string):SearchHit{return {chunkId:id,documentId:docId,documentTitle:docId,material:'paper',page:null,sectionPath:[],segments:[],score:0.01};}
doc('title','边缘检测手册');
for(let i=0;i<20;i++)chunk('heading-'+i,'title',i,'边缘检测手册',['边缘检测手册'],i+1);
chunk('body','title',20,'边缘检测用于寻找图像中的强度变化与对象轮廓。',['基础知识'],21);
const titles=await searchDocuments(db,cfg,{query:'边缘检测是什么？',mode:'keyword',limit:8});
check('正文不被大量重复纯标题挤出前列',titles.hits[0]?.chunkId==='body');
check('过滤在候选截断前完成',titles.hits.every(h=>!h.chunkId.startsWith('heading-')));
const titleLookup=await searchDocuments(db,cfg,{query:'边缘检测手册',mode:'keyword',limit:8});
check('按文档名搜索仍返回该文档正文',titleLookup.hits.some(h=>h.chunkId==='body'));
doc('only-title','实验记录索引');chunk('only-title-0','only-title',0,'实验记录索引');
check('只有标题的文档仍保留检索入口',createRetrievalPolicy(db,'实验记录索引').scope.has('only-title-0'));
doc('original','Encoder and Decoder Design');
chunk('alias','original',0,'Our proposed model, ModelX+, adds a decoder to ModelX.');
chunk('method','original',1,'3 Methods\nThe model uses convolution and a decoder.',['3 Methods']);
doc('comparison','其他模型对比');chunk('comparison-0','comparison',0,'We compare our results with ModelX+ and other methods.');
const aliasPolicy=createRetrievalPolicy(db,'ModelX+增加了什么？');
check('通过明确自称定位原论文',aliasPolicy.preferredDocuments.join()==='original');
check('正文提及不能成为模型自称别名',!aliasPolicy.scope.has('comparison-0'));
check('加号版本不错误匹配基础型号',createRetrievalPolicy(db,'ModelX用了什么？').preferredDocuments.length===0);
doc('plus-title','ModelY+');chunk('plus-title-0','plus-title',0,'ModelY+ is a network.');
check('文档标题同样保留加号型号边界',createRetrievalPolicy(db,'ModelY用了什么？').preferredDocuments.length===0);
doc('short-name','Alpha');chunk('short-name-0','short-name',0,'Alpha has a decoder.');
check('英文标题不匹配较长单词的子串',createRetrievalPolicy(db,'Alphabet是什么？').preferredDocuments.length===0);
check('比较类问题保留多文档范围',createRetrievalPolicy(db,'比较ModelX+与其他方法').scope.has('comparison-0'));
check('未知论文名不限制到任意文档',createRetrievalPolicy(db,'《不存在的研究》用了什么方法？').preferredDocuments.length===0);
check('材料过滤先于别名定位',!createRetrievalPolicy(db,'ModelX+增加了什么？','rule').scope.has('alias'));
const scoped=await searchDocuments(db,cfg,{query:'ModelX+增加了什么方法？',mode:'keyword',limit:8});
check('目标论文的模型章节可通过受限词扩展召回',scoped.hits.some(h=>h.chunkId==='method'));
doc('duplicate','An ambiguous model');chunk('duplicate-0','duplicate',0,'Our proposed model, ModelX+, handles a different task.');
check('重名别名不擅自选择一篇论文',createRetrievalPolicy(db,'ModelX+增加了什么？').preferredDocuments.length===0);
doc('front','某期刊稿件');chunk('front-0','front',0,'基金项目：AB2026。\n收稿日期：\n通信联系人，E-mail: a@example.com');
chunk('front-1','front',1,'本文提出一种编码解码方法，采用独立边界分支。',['1 方法']);
check('基金与作者头部在方法问题中降权',createRetrievalPolicy(db,'某期刊稿件用了什么方法？').weight('front-0')<0.2);
check('作者问题仍可查询文献信息',createRetrievalPolicy(db,'某期刊稿件的作者邮箱是什么？').weight('front-0')>0.5);
doc('weight','权重实验');chunk('anchor','weight',0,'2.3 损失权重实验\n不同损失权重需要比较。',['2.3 损失权重']);
chunk('table','weight',1,'| 权重 | 准确率 |\n| --- | --- |\n| 0.6 | 0.91 |',['2.3 损失权重']);
chunk('conclusion','weight',2,'综合比较后，掩膜损失权重与边界损失权重分别为0.6和0.4。',['2.3 损失权重']);
chunk('next-section','weight',3,'其他实验的权重分别为0.1和0.9。',['2.4 其他']);
const expanded=expandSectionEvidence(db,[hit('anchor','weight')],'损失权重最终是多少？');
check('同节的表格与结论作为独立片段补齐',expanded.some(h=>h.chunkId==='table')&&expanded.some(h=>h.chunkId==='conclusion'));
check('同章节补齐不跨边界',!expanded.some(h=>h.chunkId==='next-section'));
check('补齐保留独立引用ID',new Set(expanded.map(h=>h.chunkId)).size===expanded.length);
const expandedAgain=expandSectionEvidence(db,[hit('anchor','weight'),hit('table','weight')],'损失权重最终是多少？');
check('原命中与补齐片段不重复',expandedAgain.filter(h=>h.chunkId==='table').length===1);
doc('unknown','未知章节');chunk('unknown-0','unknown',0,'损失权重的具体定义在本段。');chunk('unknown-1','unknown',1,'损失权重分别为0.4和0.6。');
check('无页码无章节时不把相邻关系当同节',expandSectionEvidence(db,[hit('unknown-0','unknown')],'损失权重是多少？').length===1);
doc('gap','缺块章节');chunk('gap-0','gap',0,'损失权重的说明。',['实验']);chunk('gap-9','gap',9,'损失权重分别为0.6和0.4。',['实验']);
check('序号不连续时不制造假连续上下文',expandSectionEvidence(db,[hit('gap-0','gap')],'损失权重是多少？').length===1);
const pool=new EvidencePool();const tool=createRetrieveTool({db,config:cfg,pool});
const response=await tool.execute('section-check',{query:'《权重实验》的损失权重是多少？',mode:'keyword',limit:1});
const details=response.details as RetrieveDetails;
const evidenceIds=details.evidenceIds.map(id=>pool.get(id)).filter(Boolean).map(ev=>ev?.kind==='document'?ev.chunkId:'');
check('工具实际展示同章节补齐的独立证据',evidenceIds.includes('conclusion')&&evidenceIds.includes('table'));
check('只将实际展示的补齐ID写入诊断',details.sectionEvidenceChunkIds?.every(id=>evidenceIds.includes(id))===true);
check('补齐仍遵守单次上下文预算',(details.renderedChars??Infinity)<=8000);
check('写作问题要求解释已有组成部分并保留来源边界',buildSystemPrompt({today:'2026-10-24',question:'摘要应该怎么写？'}).includes('不凭常识补成通用指南'));
check('普通查询不额外注入写作指引',!buildSystemPrompt({today:'2026-10-24',question:'损失权重是多少？'}).includes('### 解释与步骤的完整性'));
db.close();console.log(`\n检索策略回归：${passed} 通过，${failed} 失败`);if(failed)process.exitCode=1;
