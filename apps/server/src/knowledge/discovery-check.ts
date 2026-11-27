import assert from 'node:assert/strict';
import { classifyKnowledge, discoveryFingerprint, hasDifferentProjectOrConditions } from './discovery-classifier.ts';

const entry = [
  '主题：合成标定', '项目：模拟项目', '条件：模拟常温',
  '版本：v1', '时间：模拟日期', '结论：允许继续标定', '使用合成检查步骤甲。',
].join('\n');
const candidates = [{ id: 'approved-fixture', revision: 'fixture-version', content: entry }];
const cases = [
  ['new', '合成观察内容说明了一个独立的记录主题。'],
  ['duplicate', entry.replaceAll('：', ':') + ' '],
  ['supplement', entry + '\n补充合成检查步骤乙。'],
  ['version', entry.replace('v1', 'v2')],
  ['conflict', entry.replace('允许继续标定', '不允许继续标定')],
  ['insufficient', entry.replace('允许继续标定', '推荐再次观察')],
] as const;
for (const [kind, input] of cases) {
  const result = classifyKnowledge(input, candidates);
  assert.equal(result.kind, kind);
  if (kind !== 'new') assert.equal(result.neighbor?.revision, 'fixture-version');
}
assert.equal(classifyKnowledge(entry.replace('模拟常温', '模拟高温').replace('允许', '不允许'), candidates).kind, 'new');
assert.equal(classifyKnowledge(entry.replace('模拟项目', '第二个项目').replace('允许', '不允许'), candidates).kind, 'new');
assert.equal(classifyKnowledge(entry.replace('模拟日期', '下一时段').replace('允许', '不允许'), candidates).kind, 'version');
assert.equal(classifyKnowledge(entry + '\n条件：第二个限定', candidates).kind, 'insufficient');
const oppositeCurrent = { id:'same-version', revision:'current', content:
  entry.replace('允许继续标定','不允许继续标定').replace('使用合成检查步骤甲。','另有样品质量偏差及错误记载。') };
const closerOld = { id:'other-version', revision:'other', content:entry.replace('v1','v2') };
for (const rows of [[oppositeCurrent, closerOld], [closerOld, oppositeCurrent]]) {
  const candidate = classifyKnowledge(entry, rows);
  assert.equal(candidate.kind, 'conflict');
  assert.equal(candidate.neighbor?.id, oppositeCurrent.id);
}
assert.equal(classifyKnowledge(entry, [oppositeCurrent, ...candidates, closerOld]).kind, 'duplicate');
assert.equal(hasDifferentProjectOrConditions(entry, entry.replace('模拟常温','模拟高温')), true);
assert.equal(hasDifferentProjectOrConditions(entry, entry.replace('合成标定','标定工序')), false);
assert.equal(hasDifferentProjectOrConditions(entry, entry + '\n条件：模拟高温'), false);
const differentProject = entry.replace('模拟项目','第二个项目');
assert.equal(hasDifferentProjectOrConditions(differentProject, entry + '\n结论：不允许继续标定'), true);
assert.equal(hasDifferentProjectOrConditions(differentProject, entry + '\n项目：第二个项目'), false);
assert.notEqual(discoveryFingerprint('阈值 -12'), discoveryFingerprint('阈值 +12'));
assert.equal(discoveryFingerprint('ＳＯＰ　固定值'), discoveryFingerprint('SOP 固定值'));
assert.notEqual(discoveryFingerprint('10² mol/L'), discoveryFingerprint('102 mol/L'));
assert.notEqual(discoveryFingerprint('阈值 1 Pa'), discoveryFingerprint('阈值 1 pA'));
assert.notEqual(discoveryFingerprint('阈值 1 2'), discoveryFingerprint('阈值 12'));
console.log('PASS six discovery categories, normalization, project/time/version/condition boundaries and ambiguous evidence');
