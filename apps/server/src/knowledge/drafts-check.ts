import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, type AuthUser, type ConfirmKnowledgeGroupResponse,
  type KnowledgeDraftSource, type ListKnowledgeEntriesResponse, type Role } from '@knowpilot/shared';
import { createLabModels } from '../agent/models.ts';
import { insertAskRecord } from '../agent/records.ts';
import { createApp } from '../app.ts';
import { createSession, SESSION_COOKIE } from '../auth/session.ts';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { ingestDocument } from '../documents/ingest.ts';
import { prepareDocumentUpload, uploadDocument } from '../documents/upload.ts';
import { createResearchNote } from '../research-notes/repo.ts';
import { admitEntry } from './admit.ts';
import { assertKnowledgeDraftReady, createKnowledgeDrafts } from './drafts.ts';
import type { GenerateInput, GenerateOutput, KnowledgeDeps } from './generate.ts';
import { findById } from './repo.ts';

const root = mkdtempSync(join(tmpdir(), 'knowpilot-drafts-check-'));
const config = { ...loadConfig(), repoRoot: root, dbPath: join(root, 'test.sqlite'),
  uploadDir: join(root, 'test-uploads'), embedModelDir: join(root, 'no-embedding'), ocrEnabled: false,
  deepseekApiKey: undefined, modelBaseUrl: undefined, dataRoot: join(root, 'datasets'), codeRoots: [] };
const { db, migration } = openDb(config.dbPath);
const deps = { db, config, models: createLabModels() };
const app = createApp({ ...deps, schemaVersion: migration.toVersion, startedAt: Date.now() });
const now = new Date();

function member(id: string, role: Role = 'member'): AuthUser {
  db.prepare(`INSERT INTO users (id,username,display_name,password_hash,role,created_at,updated_at)
     VALUES (?,?,?,'offline-fixture',?,?,?)`).run(id,id,id,role,now.toISOString(),now.toISOString());
  return { id, username: id, displayName: id, role, groupId: null };
}
function cookie(user: AuthUser) {
  const { token } = createSession(db, { userId: user.id, now, idleDays: 7, maxDays: 30, ip: null, userAgent: null });
  return SESSION_COOKIE + '=' + token;
}
function request(url: string, who: string | null, body?: object, method = 'POST') {
  const headers = new Headers(who === null ? {} : { cookie: who });
  if (body === undefined) return app.request(url, { headers });
  headers.set('content-type', 'application/json');
  return app.request(url, { headers, method, body: JSON.stringify(body) });
}
let modelCalls = 0;
async function fakeGenerate(_: KnowledgeDeps, input: GenerateInput): Promise<GenerateOutput> {
  modelCalls += 1;
  const excerpt = input.text;
  return { runId: 'fake-' + String(modelCalls), drafts: [{ kind: 'fact' as const, content: excerpt,
    evidence: excerpt, claim: input.sourceKind === 'document' ? 'literature' : 'experience',
    question: '并无这条问题', tags: [excerpt.slice(0, 8), '凭空标签'] }] };
}
const owner = member('draft-author');
const outsider = member('draft-outsider');
const reviewer = member('draft-reviewer', 'admin');
const ownerCookie = cookie(owner);
const outsiderCookie = cookie(outsider);
const reviewerCookie = cookie(reviewer);
function draft(source: KnowledgeDraftSource, user = owner, generate = fakeGenerate) {
  return createKnowledgeDrafts(deps,user,{ source, consentConfirmed: true },undefined,generate);
}
function ask(id: string, text: string, citationCount = 0) {
  insertAskRecord(db, { runId: id, question: '离线测试问题', askedAt: now.toISOString(), consentConfirmed: true,
    outcome: 'ok', deliveryStatus: 'verified', citationCount, gapCount: 0, rounds: 1, durationMs: 1,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    warnings: [], answerPreview: text, userId: owner.id });
}
function confirm(groupId: string, who = ownerCookie) {
  return request('/api/v1/knowledge/groups/' + groupId + '/confirm',who,{ consentConfirmed: true });
}
async function itemList(who: string) {
  const result = await request('/api/v1/knowledge',who);
  assert.equal(result.status,200);
  return (await result.json() as ListKnowledgeEntriesResponse).items;
}

try {
  const manualText = '离线安全回归人工来源的可确认正文。';
  const askText = '离线问答选段用于验证可追溯来源。';
  const noteText = '离线笔记正文用于验证私有来源的撤权。';
  const docText = '离线资料片段用于验证上传文档索引。';
  ask('draft-ask-run',askText);
  const note = createResearchNote(db,owner.id,{
    title: '模拟笔记', body: noteText, tags: [], runs: [{ runId: 'draft-ask-run', mode: 'answer' }],
  });
  ask('draft-ask-missing-trace', noteText, 1);
  const incomplete = createResearchNote(db,owner.id,{
    title: '合成缺失追踪', body: noteText, tags: [], runs: [{ runId: 'draft-ask-missing-trace', mode: 'answer' }],
  });
  const { documentId } = await uploadDocument(db,config,{
    file: new File([docText],'offline-draft.txt',{type:'text/plain'}),
    material: 'paper', uploadedBy: owner.id, consentConfirmedBy: owner.id,
  });
  await ingestDocument(db,config,documentId);
  const chunk = db.prepare(`SELECT c.id,d.index_version FROM doc_chunks c
      JOIN documents d ON d.id=c.doc_id WHERE d.id=? LIMIT 1`).get(documentId)!;
  const manual = { kind: 'manual', text:manualText } as const;
  const answer = { kind: 'ask',id:'draft-ask-run',excerpt:askText } as const;
  const noteSource = { kind:'note',id:note.id,revision:note.revision } as const;
  const document = { kind:'document',id:documentId,chunkId:String(chunk.id),version:String(chunk.index_version) } as const;

  const beforeCalls = modelCalls;
  assert.equal((await request('/api/v1/knowledge/drafts',null,{source:noteSource,consentConfirmed:true})).status,401);
  assert.equal((await request('/api/v1/knowledge/drafts',ownerCookie,{source:noteSource})).status,400);
  assert.equal((await request('/api/v1/knowledge/drafts',reviewerCookie,{source:noteSource,consentConfirmed:true})).status,404);
  assert.equal((await request('/api/v1/knowledge/drafts',outsiderCookie,{source:answer,consentConfirmed:true})).status,404);
  await assert.rejects(draft({...document,id:'unrelated-document'}), (error) => error instanceof AppError && error.httpStatus === 404);
  await assert.rejects(draft({...noteSource,revision:99}), (error) => error instanceof AppError && error.httpStatus === 409);
  await assert.rejects(draft({kind:'note',id:incomplete.id,revision:incomplete.revision}),
    (error) => error instanceof AppError && error.httpStatus === 404);
  assert.equal(modelCalls,beforeCalls);
  console.log('PASS consent, member/admin isolation, document membership, revision and inaccessible cited note without trace');

  const generated = await Promise.all([manual,answer,noteSource,document].map((source) => draft(source)));
  for (const [index, source] of [manual,answer,noteSource,document].entries()) {
    const entry = generated[index]!.entries[0]!;
    assert.equal(entry.note?.draftSource?.kind,source.kind);
    assert.equal(entry.note?.draftSource?.by,owner.id);
    assert.equal(entry.note?.draftDetails?.question,undefined);
    assert.equal(entry.note?.draftDetails?.tags?.length,1);
  }
  assert.equal(generated[1]!.entries[0]!.note?.draftSource?.excerptVerification,'matched');
  assert.equal(generated[1]!.entries[0]!.note?.draftDetails?.claim,'inference');
  const fabricatedByClient = await draft({...answer, excerpt:'这句话由作者输入，与服务端保存的答复摘要不同。'});
  assert.equal(fabricatedByClient.entries[0]!.note?.draftSource?.excerptVerification,'submitted');
  assert.equal(fabricatedByClient.entries[0]!.note?.draftDetails?.claim,'inference');
  assert.equal((await draft(manual)).groupId,generated[0]!.groupId);
  assert.equal(modelCalls,beforeCalls+5);
  assert.equal((await itemList(outsiderCookie)).length,0);
  assert.equal((await itemList(reviewerCookie)).length,0);
  assert.equal((await confirm(generated[2]!.groupId,reviewerCookie)).status,404);
  assert.equal(db.prepare("SELECT id FROM documents WHERE material='knowledge'").all().length,0);
  console.log('PASS four origins, scoped audit evidence, honest unmatched excerpt, idempotent generation and initial GC-12');

  const snippet = '长笔记中的合成片段用于验证选段权限与版本。';
  const prefix = '合成表情🙂\r\n';
  const longNote = createResearchNote(db,owner.id,{
    title:'长笔记选段',body:prefix+snippet+'\r\n'+'填'.repeat(5000),tags:[],runs:[],
  });
  const start = prefix.replace(/\r\n?/gu,'\n').length;
  const selection = {start,end:start+snippet.length};
  const longSource = {kind:'note', id:longNote.id, revision:longNote.revision} as const;
  await assert.rejects(draft(longSource),(error)=>error instanceof AppError && error.httpStatus===400);
  await assert.rejects(draft({...longSource,selection:{start,end:9000}}),
    (error)=>error instanceof AppError && error.httpStatus===400);
  await assert.rejects(draft({...longSource,selection:{start:prefix.indexOf('🙂')+1,end:start+snippet.length}}),
    (error)=>error instanceof AppError && error.httpStatus===400);
  await assert.rejects(draft({...longSource,selection},reviewer),(error)=>error instanceof AppError && error.httpStatus===404);
  const longDraft = (await draft({...longSource,selection})).entries[0]!;
  assert.equal(longDraft.content,snippet);
  assert.equal(longDraft.note?.draftSource?.excerpt,snippet);
  assert.equal(longDraft.note?.draftSource?.kind,'note');
  assert.deepEqual(longDraft.note.draftSource.selection,selection);
  assertKnowledgeDraftReady(db,longDraft);
  db.prepare('UPDATE research_notes SET revision=revision+1 WHERE id=?').run(longNote.id);
  assert.throws(()=>assertKnowledgeDraftReady(db,longDraft),(error)=>error instanceof AppError && error.httpStatus===409);
  console.log('PASS long saved note authorized range, normalized UTF-16 offsets, wrong owner and revision');

  const falseConclusion = '该方法适用于高温连续标定';
  const negatedText = '没有证据表明' + falseConclusion + '。';
  const negatedDraft = await draft({kind:'manual',text:negatedText},owner,async ()=>({
    runId:'fake-negation', drafts:[{kind:'fact',content:falseConclusion,evidence:negatedText,claim:'experience'}],
  }));
  assert.equal(negatedDraft.entries[0]?.note?.draftDetails?.claim,'unclassified');
  const negationResult = await (await confirm(negatedDraft.groupId)).json() as ConfirmKnowledgeGroupResponse;
  assert.equal(negationResult.results[0]?.outcome,'skipped');
  console.log('PASS literal substring dropping original negation requires an author edit');

  const unsupported = await draft({kind:'manual',text:'原文没有说明任何正确百分比。'},owner,async (_,input) => ({
    runId:'fake-unsupported', drafts:[{kind:'fact',content:'实测准确率达到百分之九十九。',evidence:input.text,claim:'experience'}],
  }));
  const unsupportedId = unsupported.entries[0]!.id;
  assert.equal(unsupported.entries[0]!.note?.draftDetails?.claim,'unclassified');
  let results = await (await confirm(unsupported.groupId)).json() as ConfirmKnowledgeGroupResponse;
  assert.equal(results.results[0]?.outcome,'skipped');
  assert.equal(db.prepare("SELECT id FROM documents WHERE material='knowledge'").all().length,0);
  const updateBody = { revision:1,kind:'lesson',content:'作者核对原文后补充可确认的说明。' };
  const editUrl = '/api/v1/knowledge/' + unsupportedId + '/draft';
  assert.equal((await request(editUrl,reviewerCookie,updateBody,'PATCH')).status,404);
  assert.equal((await request(editUrl,ownerCookie,updateBody,'PATCH')).status,200);
  assert.equal((await request(editUrl,ownerCookie,updateBody,'PATCH')).status,409);
  assert.equal(findById(db,unsupportedId)?.note?.draftDetails?.claim,'edited');
  results = await (await confirm(unsupported.groupId)).json() as ConfirmKnowledgeGroupResponse;
  assert.equal(results.results[0]?.outcome,'active');
  const replays = await Promise.all([confirm(unsupported.groupId),confirm(unsupported.groupId)]);
  for (const response of replays) assert.equal((await response.json() as ConfirmKnowledgeGroupResponse).results[0]?.outcome,'skipped');
  assert.equal(db.prepare("SELECT id FROM documents WHERE material='knowledge'").all().length,1);
  assert.equal((await itemList(reviewerCookie)).find((entry)=>entry.id===unsupportedId)?.note?.draftSource,undefined);
  console.log('PASS fabricated prose blocked, owner revision conflict, manual confirmation, searchable entry dedup and origin redaction');

  const pending = generated[2]!.entries[0]!;
  for (const [action,body] of [['resolve',{ resolution:'reject' }],['withdraw',{}]] as const) {
    const nonexistent = await request('/api/v1/knowledge/unknown-draft/' + action,reviewerCookie,body);
    const privateDraft = await request('/api/v1/knowledge/' + pending.id + '/' + action,reviewerCookie,body);
    assert.equal(privateDraft.status,404);
    assert.equal(nonexistent.status,404);
    assert.equal((await privateDraft.json() as {error:{message:string}}).error.message,
      (await nonexistent.json() as {error:{message:string}}).error.message);
  }
  assert.equal((await request('/api/v1/knowledge/' + pending.id + '/reject',ownerCookie,{})).status,200);
  assert.equal((await itemList(reviewerCookie)).some((entry)=>entry.id===pending.id),false);
  const asked = generated[1]!.entries[0]!;
  db.prepare('DELETE FROM ask_records WHERE run_id=?').run('draft-ask-run');
  const revoked = (await itemList(ownerCookie)).find((entry)=>entry.id===asked.id)!;
  assert.equal(revoked.note?.draftSource,undefined);
  assert.equal(revoked.content.includes(askText),false);
  results = await (await confirm(generated[1]!.groupId)).json() as ConfirmKnowledgeGroupResponse;
  assert.equal(results.results[0]?.outcome,'skipped');
  assert.equal(findById(db,asked.id)?.status,'proposed');

  const retry = {kind:'manual',text:'模型失败后只允许真正完成的草稿落库。'} as const;
  await assert.rejects(draft(retry,owner,async()=>{ throw new Error('synthetic generation failure'); }));
  assert.equal((await draft(retry)).entries.length,1);
  const changedDuringGenerate = createResearchNote(db,owner.id,{title:'合成撤权测试',body:'生成等待期间撤回的合成笔记。',tags:[],runs:[]});
  await assert.rejects(draft({kind:'note',id:changedDuringGenerate.id,revision:1},owner,async (d,i)=>{
    db.prepare('DELETE FROM research_notes WHERE id=?').run(changedDuringGenerate.id);
    return fakeGenerate(d,i);
  }), (error) => error instanceof AppError && error.httpStatus === 404);
  assert.ok(!(await itemList(ownerCookie)).some((entry)=>entry.content.includes('生成等待期间撤回')));
  console.log('PASS private reject remains invisible, revoked source redaction, generation failure retry and in-flight revocation');

  const stagedTitle = '离线暫停发布可见性探针';
  const staged = await prepareDocumentUpload(config,{
    file: new File([stagedTitle],'paused.txt',{type:'text/plain'}),
    material:'knowledge',title:stagedTitle,uploadedBy:owner.id,consentConfirmedBy:owner.id,
  });
  const original = staged.stageOriginal();
  try {
    const paths = ['/api/v1/documents', '/api/v1/quick-search?q=' + encodeURIComponent(stagedTitle),
      '/api/v1/search?mode=keyword&q=' + encodeURIComponent(stagedTitle)];
    for (const path of paths) {
      const response = await request(path,outsiderCookie);
      assert.equal(response.status,200);
      const body = await response.json() as { items?: unknown[]; hits?: unknown[] };
      const matches = body.items ?? body.hits;
      assert.ok(Array.isArray(matches),path);
      assert.ok(!JSON.stringify(matches).includes(stagedTitle),path);
    }
    assert.equal((await request('/api/v1/documents/' + staged.id + '/file',outsiderCookie)).status,404);
    assert.equal(db.prepare('SELECT id FROM documents WHERE id=?').get(staged.id),undefined);
  } finally {
    original.dispose();
  }
  console.log('PASS paused publication hides metadata, quick title, index and direct original routes');

  const documentDraft = generated[3]!.entries[0]!;
  let validations = 0;
  await assert.rejects(admitEntry(db,config,{ entry:documentDraft,actor:{id:owner.id},note:documentDraft.note,
    revalidate: () => {
      validations += 1;
      if (validations === 2) db.prepare("UPDATE documents SET status='failed' WHERE id=?").run(documentId);
      assertKnowledgeDraftReady(db,documentDraft);
    },
  }), (error) => error instanceof AppError && error.httpStatus===404);
  assert.equal(validations,2);
  assert.equal(readdirSync(config.uploadDir).some((name)=>name.startsWith('.draft-')),false);
  assert.equal(findById(db,documentDraft.id)?.status,'proposed');
  assert.equal(db.prepare("SELECT id FROM documents WHERE material='knowledge'").all().length,1);
  assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
  const stale = generated[0]!.entries[0]!;
  const staleEdit = {revision:1,kind:'lesson',content:'另一 SQLite 写者已经更新这一段待发布内容。'};
  assert.equal((await request('/api/v1/knowledge/' + stale.id + '/draft',ownerCookie,staleEdit,'PATCH')).status,200);
  assert.throws(()=>assertKnowledgeDraftReady(db,stale),(error)=>error instanceof AppError && error.httpStatus===409);
  console.log('PASS serialized source and revision guards, unpublished document rollback and staging cleanup');

  const pendingPublication = generated[0]!.entries[0]!;
  const current = findById(db,pendingPublication.id)!;
  const quantities = () => [
    'documents', 'doc_chunks', 'doc_chunks_fts',
  ].map((table) => db.prepare('SELECT COUNT(*) AS n FROM ' + table).get()?.n);
  const beforePublication = quantities();
  const beforeFiles = readdirSync(config.uploadDir).sort();
  db.exec(`CREATE TEMP TRIGGER abort_fixture_activation
    BEFORE UPDATE ON knowledge_entries WHEN NEW.status='active'
    BEGIN SELECT RAISE(ABORT, 'fixture activation write failure'); END`);
  const publish = () => admitEntry(db,config,{
    entry:current, actor:{id:owner.id}, note:current.note, revalidate: () => assertKnowledgeDraftReady(db,current),
  });
  try {
    await assert.rejects(publish(), /fixture activation write failure/);
    assert.deepEqual(quantities(),beforePublication);
    assert.deepEqual(readdirSync(config.uploadDir).sort(),beforeFiles);
    assert.equal(findById(db,current.id)?.status,'proposed');
  } finally {
    db.exec('DROP TRIGGER abort_fixture_activation');
  }
  db.exec(`CREATE TEMP TABLE fixture_commit_parent (id TEXT PRIMARY KEY);
    CREATE TEMP TABLE fixture_commit_child (id TEXT REFERENCES fixture_commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TEMP TRIGGER abort_fixture_commit
    BEFORE UPDATE ON knowledge_entries WHEN NEW.status='active'
    BEGIN INSERT INTO fixture_commit_child VALUES ('missing-parent'); END`);
  try {
    await assert.rejects(publish(), /FOREIGN KEY constraint failed/);
    assert.deepEqual(quantities(),beforePublication);
    assert.deepEqual(readdirSync(config.uploadDir).sort(),beforeFiles);
    assert.equal(findById(db,current.id)?.status,'proposed');
  } finally {
    db.exec('DROP TRIGGER abort_fixture_commit');
  }
  const restoredPublication = await publish();
  assert.equal(findById(db,current.id)?.status,'active');
  assert.equal(quantities()[0],Number(beforePublication[0])+1);
  assert.ok(Number(quantities()[2])>Number(beforePublication[2]));
  assert.equal((await request('/api/v1/documents/' + restoredPublication.documentId + '/file',outsiderCookie)).status,200);
  console.log('PASS actual write and deferred COMMIT failures roll back doc/FTS/entry and remove staged and promoted files before retry');
} finally {
  db.close();
  rmSync(root,{recursive:true,force:true});
}
