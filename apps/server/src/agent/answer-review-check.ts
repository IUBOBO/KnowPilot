import assert from 'node:assert/strict';
import { type AssistantMessage } from '@earendil-works/pi-ai';
import { answerPreview, AppError, segmentForIndex, type AuthUser } from '@knowpilot/shared';
import { askRecordScope } from '../auth/scope.ts';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { insertRunTrace } from '../trace/repo.ts';
import { reviewAnswer } from './answer-review.ts';
import { createLabModels } from './models.ts';
import { withAskRecordSources } from './record-sources.ts';
import { insertAskRecord, listAskRecords } from './records.ts';

const { db } = openDb(':memory:');
const user: AuthUser = { id: 'owner', username: 'test', displayName: '测试', role: 'member', groupId: null };
const timestamp = '2026-11-18T00:00:00.000Z';
const source = '同一条件下，方法在A数据集的准确率提高了两个百分点。';
const answer = 'A数据集的准确率提高了两个百分点 [E1]。部署的准确率未知。A数据集的准确率下降了两个百分点 [E1]。本文发表于2022年。';
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 };

try {
  db.prepare(`INSERT INTO users (id,username,display_name,password_hash,role,created_at,updated_at)
    VALUES (?,?,?,'unused','member',?,?)`).run(user.id, user.username, user.displayName, timestamp, timestamp);
  for (const [id, title, material] of [
    ['target', '基准论文', 'paper'], ['other', '仅命中的论文', 'paper'], ['note', '由知识条目正文生成的标题', 'knowledge'],
  ] as const) {
    db.prepare('INSERT INTO documents (id,title,material,content_hash,created_at) VALUES (?,?,?,?,?)')
      .run(id, title, material, id, timestamp);
    db.prepare(`INSERT INTO doc_chunks (id,doc_id,ordinal,text,text_seg,page,section_path,token_count)
      VALUES (?,?,?,?,?,?,?,?)`).run(id + '-chunk', id, 0, source, segmentForIndex(source), 1, '["实验"]', source.length);
  }
  insertAskRecord(db, {
    runId: 'run', question: '准确率？', askedAt: timestamp, userId: user.id, consentConfirmed: true,
    outcome: 'ok', citationCount: 1, gapCount: 0, rounds: 1, durationMs: 80, usage, warnings: [],
    answerPreview: answerPreview(`## 结论\n**A 数据集准确率提高了两个百分点** [E1]。\n\n${answer}`),
  });
  insertRunTrace(db, {
    userId: user.id, askedAt: timestamp, recordedAt: timestamp,
    finalization: {
      runId: 'run', outcome: 'ok', stopReason: 'completed', lastStage: 'assembly',
      budget: { limits: { maxQueryCalls: 3, maxToolCalls: 5, maxTokens: 1000, maxWallMs: 1000 },
        used: { queryCalls: 1, toolCalls: 2, tokens: 10, elapsedMs: 80 } },
      model: 'deepseek/deepseek-flash', promptHash: 'fake', toolCalls: [], recordEvidence: [],
      retrievalHits: [
        { chunkId: 'other-chunk', score: 1, rank: 0 }, { chunkId: 'target-chunk', score: 1, rank: 1 },
        { chunkId: 'note-chunk', score: 0.9, rank: 2 },
      ],
      citationMap: [{ id: 'E1', chunkId: 'target-chunk', recordId: null }], evidenceCount: 2, contextChars: 20,
      usage, warnings: [], errors: [], deliveryStatus: 'verified', claimChecks: [], route: 'simple',
      plan: { coverage: 'sufficient', coverageRatio: 1, subgoals: [] }, rewriteRounds: 0, rewriteEvents: [],
      turn: 1, durationMs: 80,
    },
  });

  const config = { ...loadConfig(), deepseekApiKey: 'fixture' };
  const models = createLabModels();
  let calls = 0;
  models.completeSimple = async (model, context): Promise<AssistantMessage> => {
    calls += 1;
    const payload = JSON.parse(String(context.messages[0]?.content));
    assert.deepEqual(payload.evidence, [{ id: 'E1', text: source }]);
    const cited = [{ citation_id: 'E1', quote: source }];
    return {
      role: 'assistant', provider: model.provider, api: model.api, model: model.id, timestamp: Date.now(),
      stopReason: 'toolUse',
      usage: { input: 20, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 40,
        cost: { total: 0.002, input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0 } },
      content: [{ type: 'toolCall', id: 'review', name: 'submit_review', arguments: {
        claims: [
          { statement: 'A数据集的准确率提高了两个百分点', verdict: 'supported', reason: '原文报告相同的数值与范围。', evidence: cited },
          { statement: '部署的准确率未知', verdict: 'insufficient', reason: '来源没有部署数据。', evidence: [] },
          { statement: 'A数据集的准确率下降了两个百分点', verdict: 'contradicted', reason: '原文报告提高。', evidence: cited },
          { statement: '本文发表于2022年', verdict: 'supported', reason: '错误摘录', evidence: [{ citation_id: 'E1', quote: '论文明确报告发布于2022年。' }] },
        ],
      } }],
    };
  };
  const signal = new AbortController().signal;
  await assert.rejects(reviewAnswer({ db, config, models }, { runId: 'run', answer, user: { ...user, id: 'other' }, signal }), (error) => {
    return error instanceof AppError && error.code === 'not_found';
  });
  assert.equal(calls, 0);

  const result = await reviewAnswer({ db, config, models }, { runId: 'run', answer, user, signal });
  assert.equal(calls, 1);
  assert.deepEqual(result.claims.map((item) => item.verdict), ['supported', 'insufficient', 'contradicted']);
  assert.equal(result.claims[2]!.evidence[0]!.quote, source);
  assert.equal(result.costUsd, 0.002);
  assert.deepEqual(db.prepare('SELECT purpose, cost_usd FROM usage_events').get(), Object.assign(Object.create(null), { purpose: 'verify', cost_usd: 0.002 }));

  const history = withAskRecordSources(db, listAskRecords(db, 20, askRecordScope(user)), user);
  assert.deepEqual(history[0]?.sources?.map((item) => item.title), ['基准论文']);
  assert.deepEqual(history[0]?.otherSources.map((item) => item.title), ['仅命中的论文', '知识条目']);
  assert.equal(history[0]?.answerPreview, 'A 数据集准确率提高了两个百分点。');
  const mentor: AuthUser = { ...user, id: 'mentor', role: 'mentor' };
  const mentorHistory = withAskRecordSources(db, listAskRecords(db, 20, askRecordScope(mentor)), mentor);
  assert.equal(mentorHistory[0]?.answerPreview, null);
  assert.equal(answerPreview('| 项目 | 状态 |\n| --- | --- |\n| 论文 A [E1] | 已投稿 |'), '项目 论文 A，状态 已投稿');
  assert.equal(answerPreview('长'.repeat(101)), `${'长'.repeat(100)}…`);
  console.log('问答复核及历史摘要回归通过。');
} finally {
  db.close();
}
