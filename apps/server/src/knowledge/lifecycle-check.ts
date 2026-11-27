import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AuthUser, ConfirmKnowledgeGroupResponse, KnowledgeEntry, KnowledgeReviewQueueResponse, ResolveKnowledgeResponse, Role, KnowledgeDraftSource,
} from '@knowpilot/shared';
import { createLabModels } from '../agent/models.ts';
import { createApp } from '../app.ts';
import { createSession, SESSION_COOKIE } from '../auth/session.ts';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { createResearchNote } from '../research-notes/repo.ts';
import type { ConflictCheck } from './conflict.ts';
import { checkDraftPublication } from './discovery-review.ts';
import { createKnowledgeDrafts } from './drafts.ts';
import { findById, markConflicted, markRejected } from './repo.ts';

const root = mkdtempSync(join(tmpdir(), 'knowpilot-lifecycle-'));
const dbPath = join(root, 'fixture.sqlite');
const { db, migration } = openDb(dbPath);
const config = { ...loadConfig(), repoRoot: root, dbPath, uploadDir: join(root, 'uploads'), dataRoot: join(root, 'datasets'),
  deepseekApiKey: undefined, modelBaseUrl: undefined, embedModelDir: join(root, 'offline'), ocrEnabled: false, codeRoots: [] };
const models = createLabModels();
const deps = { db,config,models };
const app = createApp({ ...deps, schemaVersion: migration.toVersion, startedAt: Date.now() });
const now = new Date();
function user(id: string, role: Role) {
  db.prepare(`INSERT INTO users (id,username,display_name,password_hash,role,created_at,updated_at)
    VALUES (?,?,?,'fixture-hash',?,?,?)`).run(id,id,id,role,now.toISOString(),now.toISOString());
  return { id, username:id, displayName:id, role, groupId:null } satisfies AuthUser;
}
const author = user('g4-lifecycle-author','member');
const reviewer = user('g4-lifecycle-reviewer','mentor');
const other = user('g4-lifecycle-other','member');
function request(path: string, viewer: AuthUser, body?: object) {
  const token = createSession(db,{ userId:viewer.id,now,idleDays:1,maxDays:1,ip:null,userAgent:null }).token;
  const headers = new Headers({cookie:SESSION_COOKIE+'='+token});
  if (body === undefined) return app.request(path,{headers});
  headers.set('content-type','application/json');
  return app.request(path,{method:'POST',headers,body:JSON.stringify(body)});
}
const formal = (term: string) => db.prepare('SELECT count(*) AS n FROM doc_chunks_fts WHERE doc_chunks_fts MATCH ?').get(term)?.n;
const get = (entry: KnowledgeEntry) => {
  const stored = findById(db, entry.id);
  assert(stored);
  return stored;
};
async function create(text: string, actor = author, source?: KnowledgeDraftSource) {
  const out = await createKnowledgeDrafts(deps,actor,{text,source,consentConfirmed:true},undefined,async (_,input)=>({
    runId:'mock',drafts:[{kind:'fact',content:input.text,evidence:input.text,claim:'experience'}],
  }));
  const entry = out.entries[0];
  assert(entry);
  return { groupId:out.groupId,entry,actor };
}
async function confirm(draft: Awaited<ReturnType<typeof create>>) {
  const response = await request('/api/v1/knowledge/groups/'+draft.groupId+'/confirm',draft.actor,{consentConfirmed:true});
  assert.equal(response.status,200);
  return (await response.json() as ConfirmKnowledgeGroupResponse).results[0];
}
function resolve(entry: KnowledgeEntry, resolution: string, actor = reviewer, mergedContent?: string) {
  return request('/api/v1/knowledge/'+entry.id+'/resolve',actor,{resolution,...(mergedContent===undefined?{}:{mergedContent})});
}
const base = [
  '主题：合成审查', '项目：合成台账', '条件：模拟常温', '版本：v1', '时间：模拟日期',
  '结论：允许继续标定', '第一项合成检查 g4baselineproof。',
].join('\n');
const baseline = await create(base);
assert.equal(formal('g4baselineproof'),0);
assert.equal((await confirm(baseline))?.outcome,'active');
assert(Number(formal('g4baselineproof'))>0);
const priorDecision = { kind:'supersede', by:reviewer.id, at:now.toISOString(), supersededEntryId:'older-audit-fixture' };
db.prepare("UPDATE knowledge_entries SET note=json_set(note,'$.resolution',json(?)) WHERE id=?")
  .run(JSON.stringify(priorDecision),baseline.entry.id);
const duplicate = await create(base,other);
assert.equal((await create(base,other)).groupId,duplicate.groupId);
assert.match((await confirm(duplicate))!.message,/完全重复/u);
assert.equal(get(duplicate.entry).status,'proposed');
assert.equal(Number(formal('g4baselineproof')),1);

const supplement = await create(base+'\n第二项合成检查 g4supplementproof。');
assert.equal((await confirm(supplement))?.outcome,'conflicted');
assert.equal(get(supplement.entry).note?.lifecycle?.kind,'supplement');
assert.equal(formal('g4supplementproof'),0);
assert.equal(get(baseline.entry).status,'active');
assert.equal((await resolve(supplement.entry,'merge',author,'没有审核权限的输入。')).status,403);
assert.equal((await resolve(supplement.entry,'merge')).status,400);
const newest = db.prepare(`INSERT INTO knowledge_entries
  (id,kind,status,content,source_type,observed_at,created_by,group_id)
  VALUES(?,'fact','active','仅供列表分页的合成行。','manual','2099-01-01',?,?)`);
for (let i=0;i<201;i++) newest.run('recent-fixture-'+i,author.id,'recent-fixture-group-'+i);
const list = await request('/api/v1/knowledge?limit=200',reviewer);
assert.equal((await list.json() as { items: KnowledgeEntry[] }).items.some((entry)=>entry.id===baseline.entry.id),false);
const queue = await request('/api/v1/knowledge/review',reviewer);
assert.equal(queue.status,200);
const queueBody = await queue.json() as KnowledgeReviewQueueResponse;
const queued = queueBody.items.find((item)=>item.id===supplement.entry.id)!;
assert.equal(queueBody.neighbors?.find((item)=>item.id===baseline.entry.id)?.content,base);
assert.equal(queued.note?.lifecycle?.targetContext.version,'v1');
assert.equal(queued.note?.lifecycle?.incomingContext.conditions,'模拟常温');
assert.equal(queued.note?.draftSource,undefined);

assert.equal((await resolve(supplement.entry,'merge',reviewer,base.replace('主题：合成审查','主题：合成审查  '))).status,409);
const merged = base.replace('第一项合成检查 g4baselineproof。','人工合并两项检查 g4mergedproof。');
const beforeFiles = readdirSync(config.uploadDir).sort();
db.exec(`CREATE TEMP TRIGGER g4_fail_supersede BEFORE UPDATE ON knowledge_entries
  WHEN NEW.status='superseded' BEGIN SELECT RAISE(ABORT, 'fixture lifecycle write failure'); END`);
try {
  const failed = await resolve(supplement.entry,'merge',reviewer,merged);
  assert.equal(failed.status,500);
  assert.equal(get(baseline.entry).status,'active');
  assert.equal(get(supplement.entry).status,'conflicted');
  assert.equal(formal('g4mergedproof'),0);
  assert.deepEqual(readdirSync(config.uploadDir).sort(),beforeFiles);
} finally { db.exec('DROP TRIGGER g4_fail_supersede'); }
const delayedReviewer = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
assert.equal(findById(delayedReviewer,supplement.entry.id)?.status,'conflicted');
const approvedMerge = await resolve(supplement.entry,'merge',reviewer,merged);
assert.equal(markRejected(delayedReviewer,supplement.entry.id,null,'conflicted'),false);
delayedReviewer.close();
assert.equal(approvedMerge.status,200,await approvedMerge.clone().text());
const mergeResult = await approvedMerge.json() as ResolveKnowledgeResponse;
assert.equal(mergeResult.entry.content,merged);
assert.equal(mergeResult.entry.note?.lifecycle?.mode,'merge');
assert.equal(mergeResult.supersededEntryId,baseline.entry.id);
assert.equal(get(baseline.entry).content,base);
assert.deepEqual(get(baseline.entry).note?.resolution,priorDecision);
assert.equal(get(baseline.entry).note?.replacement?.entryId,supplement.entry.id);
assert.equal(mergeResult.entry.note?.draftDetails?.claim,'reviewed_merge');
const download = await request('/api/v1/documents/'+mergeResult.entry.documentId+'/file',other);
assert.equal(download.status,200);
const content = await download.text();
assert.match(content,/内容性质：审核者合并/u);
assert.doesNotMatch(content,/内容性质：用户经验/u);
assert.equal(get(baseline.entry).status,'superseded');
assert.equal(formal('g4baselineproof'),0);
assert(Number(formal('g4mergedproof'))>0);
console.log('PASS new and duplicate, queued supplement, authorization and transactional merge rollback/retry');

const versionText = merged.replace('v1','v2').replace('g4mergedproof','g4versionproof');
const version = await create(versionText);
assert.equal((await confirm(version))?.outcome,'conflicted');
assert.equal(get(version.entry).note?.lifecycle?.kind,'version');
const targetDoc = get(supplement.entry).documentId!;
db.prepare('UPDATE documents SET index_version=index_version+1 WHERE id=?').run(targetDoc);
const stale = await resolve(version.entry,'supersede');
assert.equal(stale.status,409);
assert.equal(formal('g4versionproof'),0);
assert(Number(formal('g4mergedproof'))>0);
assert.match(await stale.text(),/先驳回/u);
assert.equal((await resolve(version.entry,'reject')).status,200);
const replay = await request('/api/v1/knowledge/'+version.entry.id+'/resubmit',author,{});
assert.equal(replay.status,200);
const refreshed = (await replay.json() as {entry:KnowledgeEntry}).entry;
assert.equal((await confirm({groupId:refreshed.groupId,entry:refreshed,actor:author}))?.outcome,'conflicted');
assert.equal((await resolve(refreshed,'supersede')).status,200);
assert.equal(get(refreshed).note?.lifecycle?.mode,'update');
assert.equal(get(supplement.entry).status,'superseded');
assert.equal(formal('g4mergedproof'),0);
assert(Number(formal('g4versionproof'))>0);

const conflicting = await create(versionText.replace('允许继续标定','不允许继续标定').replace('g4versionproof','g4conflictproof'));
assert.equal((await confirm(conflicting))?.outcome,'conflicted');
assert.equal(get(conflicting.entry).note?.lifecycle?.kind,'conflict');
assert.equal(formal('g4conflictproof'),0);
assert.equal((await resolve(conflicting.entry,'reject')).status,200);
assert.equal(get(conflicting.entry).note?.lifecycle?.mode,'reject');
assert(Number(formal('g4versionproof'))>0);
const incomplete = await create(versionText.replace('时间：模拟日期\n','').replace('g4versionproof','g4missingproof'));
assert.match((await confirm(incomplete))!.message,/缺少/u);
assert.equal(formal('g4missingproof'),0);
const ambiguous = await create(versionText.replace('条件：模拟常温','条件：模拟常温\n条件：其他实验温度')
  .replace('允许继续标定','不允许继续标定').replace('g4versionproof','g4ambiguousproof'));
assert.equal((await confirm(ambiguous))?.outcome,'skipped');
assert.equal(get(ambiguous.entry).status,'proposed');
assert.equal(formal('g4ambiguousproof'),0);
const independent = await create(versionText.replace('模拟常温','第二种条件').replace('允许继续标定','不允许继续标定')
  .replace('g4versionproof','g4independentproof'));
assert.equal((await confirm(independent))?.outcome,'active');
assert(Number(formal('g4independentproof'))>0);
const secretTime = '私有时间标记secretfixturetime';
const noteBody = versionText.replace('版本：v2','版本：v9').replace('时间：模拟日期','时间：'+secretTime);
const original = createResearchNote(db,author.id,{title:'合成撤权审核',body:noteBody,tags:[],runs:[]});
const privateReview = await create(noteBody,author,{kind:'note',id:original.id,revision:original.revision});
assert.equal((await confirm(privateReview))?.outcome,'conflicted');
assert.equal(get(privateReview.entry).note?.lifecycle?.incomingContext.time,secretTime);
db.prepare('UPDATE research_notes SET revision=revision+1 WHERE id=?').run(original.id);
const revokedQueue = await request('/api/v1/knowledge/review',reviewer);
const revokedBody = await revokedQueue.text();
assert.match(revokedBody,/来源已失效/u);
assert(!revokedBody.includes(secretTime));
assert.equal((await resolve(privateReview.entry,'supersede')).status,409);
assert.equal((await request('/api/v1/knowledge/'+refreshed.id+'/withdraw',author,{reason:'合成撤回验证'})).status,200);
assert.equal(get(refreshed).status,'withdrawn');
assert.equal(formal('g4versionproof'),0);
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
console.log('PASS version update, stale target recovery, privacy redaction, conflict rejection, insufficient evidence, different conditions and withdrawal');

const legacy = await create(base.replace('合成审查','旧版结构化草稿').replace('合成台账','旧版单独项目'));
db.prepare("UPDATE knowledge_entries SET note=json_remove(note,'$.lifecycleVersion') WHERE id=?").run(legacy.entry.id);
assert.match((await confirm(legacy))!.message,/未做冲突检测/u);
const plain = await create('实验室流程要求样品经过复核后才能进入下一阶段，复核负责人需要记录复核结果。');
assert.equal((await confirm(plain))?.outcome,'active');
const plainConflict = await create('实验室流程要求样品无需经过复核就能进入下一阶段，复核负责人无需记录复核结果。');
assert.match((await confirm(plainConflict))!.message,/缺少/u);
assert.equal(get(plainConflict.entry).status,'proposed');
const vectorOnly = await create('采用另一整套合成说明描述完全不同的术语向量用例 vectoronlyfixture。');
const vectorCheck: ConflictCheck = { kind:'conflict', conflict:{
  model:'synthetic-vector', score:0.99, threshold:0.7, neighborEntryId:refreshed.id,
  neighborDocumentId:get(refreshed).documentId!, neighborExcerpt:'合成相似摘要',
} };
await assert.rejects(checkDraftPublication(db,config,author,get(vectorOnly.entry),async () => vectorCheck),
  /缺少可核对的依据/u);
assert.equal(get(vectorOnly.entry).status,'proposed');
assert.equal(formal('vectoronlyfixture'),0);
markConflicted(db,vectorOnly.entry.id,{ ...get(vectorOnly.entry).note, conflict:vectorCheck.conflict });
assert.equal((await resolve(vectorOnly.entry,'supersede')).status,409);
assert.equal(get(vectorOnly.entry).status,'conflicted');
assert.equal(get(refreshed).status,'withdrawn');
assert.equal(formal('vectoronlyfixture'),0);
assert.equal((await resolve(vectorOnly.entry,'reject')).status,200);
console.log('PASS legacy confirmation, ambiguous conditions and vector-only candidates stay private, unversioned replacement is denied');
db.close();
