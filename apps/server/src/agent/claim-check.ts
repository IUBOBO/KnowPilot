/**
 * Claim→Evidence 校验的断言脚本：`npm run verify-claims -w @knowpilot/server`（零模型）。
 *
 * 【它先复现的旧行为】在 V1/V2 之前，`[E1]` 只证明"编号存在"。一句
 * 「所有论文查重率都低于 10% [E1]」可以拿到完全合法的引用、零告警，
 * 而 E1 里可能写着"博士 < 10%、硕士 < 15%"。这里先断言旧校验确实放行，
 * 再断言新的 Claim 层把它降为 `review_required` —— 否则这次改造只是在
 * 演示一个没人能复现的问题。
 *
 * 【校准集的口径，必须如实写】脚本里有一组 AI 起草的期望标签，
 * 用来观察规则层的**误拒 / 误放**。它们**不是人工标注**，不能当权威准确率；
 * 这里只把它当成"改阈值时必须一起看的表"，并把数字打印出来。
 */
import { emptyClaimVerification, type ClaimVerdict, type Material } from '@knowpilot/shared';
import { verifyAnswer } from './citations.ts';
import { annotateRemovedQuoteClaims, splitClaims, verifyClaims } from './claim-verifier.ts';
import type { Evidence } from './evidence.ts';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${name}${detail === '' ? '' : ` —— ${detail}`}`);
}

function doc(id: string, text: string): Evidence {
  return {
    kind: 'document',
    id,
    chunkId: `c-${id}`,
    documentId: `d-${id}`,
    documentTitle: '测试制度',
    material: 'rule' as Material,
    page: null,
    sectionPath: [],
    text,
    originalChars: text.length,
    sourceVersion: '1',
    score: 0.9,
  };
}

function record(id: string, label: string, value: string): Evidence {
  return {
    kind: 'record',
    id,
    recordType: 'M-SUBMIT',
    recordId: 'sub-1',
    recordTitle: '测试投稿',
    queryTime: '2026-10-17T00:00:00.000Z',
    recordUpdatedAt: null,
    fields: [{ label, value }],
    originalChars: `${label}：${value}`.length,
    sourceVersion: '2026-10-17T00:00:00.000Z',
  };
}

const POOL = new Map<string, Evidence>([
  [
    'E1',
    doc(
      'E1',
      [
        '博士论文查重率低于10%。',
        '硕士论文查重率低于15%。',
        '查重结果以学校图书馆系统为准。',
      ].join('\n'),
    ),
  ],
  [
    'E2',
    doc(
      'E2',
      '样品应置于-80℃冰箱保存，避免反复冻融。解冻后不得再次冻存。',
    ),
  ],
  ['E3', record('E3', '状态', '外审')],
]);

function verdictsOf(answer: string): ClaimVerdict[] {
  return verifyClaims(answer, POOL).claims.map((c) => c.verdict);
}

function firstVerdict(answer: string): ClaimVerdict | undefined {
  return verdictsOf(answer)[0];
}

// ── 1. Claim 切分 ─────────────────────────────────────────────────
console.log('Claim 切分：句子边界、证据号、过程说明');

{
  const claims = splitClaims(
    [
      '博士论文查重率低于10% [E1]。',
      '我检索了资料，并查了台账。',
      '硕士论文查重率低于15% [E1][E3]。',
      '未找到依据：关于火星报销。',
      '建议换个关键词再试。',
    ].join('\n'),
  );
  check('只保留事实句（过程说明/拒答/建议不计数）', claims.length === 2, `实际 ${claims.length}`);
  check('第一句证据号提取正确', claims[0]?.evidenceIds.join(',') === 'E1', claims[0]?.evidenceIds.join(','));
  check(
    '多个证据号去重且保序',
    claims[1]?.evidenceIds.join(',') === 'E1,E3',
    claims[1]?.evidenceIds.join(','),
  );
  check('切出来的句子保留原文（含标记）', claims[0]?.text.includes('[E1]') === true);
  check('单独一行的 [E1] 不会被当成 Claim', splitClaims('结论。[E1]\n[E2] 另一句。').every((c) => c.text.replace(/\[E\d+\]/gu, '').trim().length > 0));

  // 出处说明 / 澄清句不进入 Claim 统计：它们不是可核对的"主张"。
  const provenance = splitClaims('这条规定出自《测试制度》第 13 页附则 [E1]。');
  check('出处说明句被跳过', provenance.length === 0, `实际 ${provenance.length}`);
  const clarification = splitClaims('不过这一条只说明了后果，具体以 <15% 为准 [E1]。');
  check('澄清句被跳过', clarification.length === 0, `实际 ${clarification.length}`);
  const needExplain = splitClaims('需要说明的是：细则只给出了一个数值口径，没有区分不同系统 [E1]。');
  check('"需要说明"类澄清句被跳过', needExplain.length === 0, `实际 ${needExplain.length}`);
  const dateNote = splitClaims('需要注意：该细则落款时间为 2026 年 6 月 30 日，属学院层面的规定 [E1]。');
  check('"落款时间"类边界说明被跳过', dateNote.length === 0, `实际 ${dateNote.length}`);
  const aboveProvenance = splitClaims('上述要求出自该细则（落款时间 2026 年 6 月 30 日）[E1]，属学院层面的制度规定。');
  check('"上述要求出自…"类出处说明被跳过', aboveProvenance.length === 0, `实际 ${aboveProvenance.length}`);

  // "我校…" 是事实主张，不能因为以"我"开头就被当成过程说明漏掉。
  const ourSchool = splitClaims('我校的硕士论文查重率要求更严格。');
  check('"我校…"不被当成过程说明跳过', ourSchool.length === 1, `实际 ${ourSchool.length}`);
  check(
    '没有引用的"我校…"判 insufficient，而不是消失',
    firstVerdict('我校的硕士论文查重率要求更严格。') === 'insufficient',
    String(firstVerdict('我校的硕士论文查重率要求更严格。')),
  );
}

console.log('列表序号：不是结论里的数值');

{
  // "2." 是分点编号，原文里不会有这个"2"；剥掉后句子仍可按内容核对。
  check(
    '以列表序号开头的句子不会因序号被判数值缺失',
    firstVerdict('2. 博士论文查重率低于10% [E1]。') === 'supported',
    String(firstVerdict('2. 博士论文查重率低于10% [E1]。')),
  );
  check(
    '日期里的年/月/日分量不参与数值检查',
    firstVerdict('博士论文查重率低于10%，细则落款时间为 2026 年 6 月 30 日 [E1]。') === 'supported',
    String(firstVerdict('博士论文查重率低于10%，细则落款时间为 2026 年 6 月 30 日 [E1]。')),
  );
}

// ── 2. 四档判定 ───────────────────────────────────────────────────
console.log('判定：supported / contradicted / insufficient / review_required');

{
  const supported = '博士论文查重率低于10% [E1]。';
  check('原文原句 + 合法引用 → supported', firstVerdict(supported) === 'supported', String(firstVerdict(supported)));
  check('没有任何引用 → insufficient', firstVerdict('博士论文查重率低于10%。') === 'insufficient', String(firstVerdict('博士论文查重率低于10%。')));
  check('数值在证据里不存在 → insufficient', firstVerdict('博士论文查重率低于20% [E1]。') === 'insufficient', String(firstVerdict('博士论文查重率低于20% [E1]。')));
  check(
    '同指标数值不一致 → contradicted',
    firstVerdict('硕士论文查重率低于10% [E1]。') === 'contradicted',
    String(firstVerdict('硕士论文查重率低于10% [E1]。')),
  );
  check(
    '全称/范围表述未被原文直接支持 → review_required（不是 supported）',
    firstVerdict('所有论文查重率都低于10% [E1]。') === 'review_required',
    String(firstVerdict('所有论文查重率都低于10% [E1]。')),
  );
  check(
    '泛化指标 + 原文有多个取值 → review_required（不是 supported）',
    firstVerdict('查重率低于10% [E1]。') === 'review_required',
    String(firstVerdict('查重率低于10% [E1]。')),
  );
  check(
    '写清了适用对象（博士）→ 不受多取值影响',
    firstVerdict('博士论文查重率低于10% [E1]。') === 'supported',
    String(firstVerdict('博士论文查重率低于10% [E1]。')),
  );
  check(
    '否定表述无法由规则确认 → review_required',
    firstVerdict('样品不应该在-80℃保存 [E2]。') !== 'supported',
    String(firstVerdict('样品不应该在-80℃保存 [E2]。')),
  );
  check(
    '记录字段：结论与记录值不同 → 不是 supported',
    firstVerdict('这篇稿子的状态是已录用 [E3]。') !== 'supported',
    String(firstVerdict('这篇稿子的状态是已录用 [E3]。')),
  );
}

// ── 3. span 可回读 ───────────────────────────────────────────────
console.log('span：start/end/quote 必须能回到证据原文');

{
  const result = verifyClaims('博士论文查重率低于10% [E1]。', POOL);
  const spans = result.claims[0]?.spans ?? [];
  check('supported 结论带至少一条 span', spans.length > 0);
  const span = spans[0];
  const text = POOL.get(span?.evidenceId ?? '')?.kind === 'document' ? (POOL.get(span?.evidenceId ?? '') as Extract<Evidence, { kind: 'document' }>).text : '';
  check(
    'span 的 quote 就是证据里 start..end 的原文',
    span !== undefined && text.slice(span.start, span.end) === span.quote,
    span === undefined ? '（无 span）' : `${span.start}..${span.end}`,
  );
  check('span 指向的是真正包含结论数值的那一句', span?.quote.includes('博士论文查重率低于10%') === true, span?.quote);
}

// ── 3.5 同段引用继承（常见写作习惯）────────────────────────────────
console.log('引用继承：同段下一句的引用可以覆盖前一句，跨空行不可以');

{
  const sameParagraph = '博士论文查重率低于10%；硕士论文查重率低于15% [E1]。';
  const inherited = verifyClaims(sameParagraph, POOL);
  check(
    '同段前一句从下一句继承引用 → 不再判"没有引用"',
    inherited.claims[0]?.verdict !== 'insufficient',
    String(inherited.claims[0]?.verdict),
  );
  check(
    '继承来的证据仍要过数值/重合度检查（不是无条件放行）',
    inherited.claims[0]?.verdict === 'supported',
    String(inherited.claims[0]?.verdict),
  );

  const crossParagraph = '博士论文查重率低于10%。\n\n硕士论文查重率低于15% [E1]。';
  const cross = verifyClaims(crossParagraph, POOL);
  check(
    '跨空行不继承 → 前一句仍是 insufficient',
    cross.claims[0]?.verdict === 'insufficient',
    String(cross.claims[0]?.verdict),
  );
}

// ── 4. 总账状态 ───────────────────────────────────────────────────
console.log('总账：verified / partial / unverified / not_checked');

{
  check('全部 supported → verified', verifyClaims('博士论文查重率低于10% [E1]。', POOL).status === 'verified');
  check(
    '一条 supported + 一条 insufficient → partial',
    verifyClaims('博士论文查重率低于10% [E1]。\n火星报销标准是100元。', POOL).status === 'partial',
  );
  check(
    '只有 contradicted → unverified',
    verifyClaims('硕士论文查重率低于10% [E1]。', POOL).status === 'unverified',
  );
  check(
    '纯拒答 → verified（拒答本身是正确的）',
    verifyClaims('未找到依据：资料中没有这项制度。', POOL).status === 'verified',
  );
  check(
    '空白正文 → not_checked',
    verifyClaims('   ', POOL).status === 'not_checked',
  );
  // 空总账 helper 也要能用（超时/失败路径）。
  check(
    'emptyClaimVerification 的形状完整',
    emptyClaimVerification('not_checked').counts.supported === 0 &&
      emptyClaimVerification('not_checked').claims.length === 0,
  );
}

// ── 5. 复现旧行为：合法引用 ≠ 结论被支持 ─────────────────────────
console.log('复现：合法引用编号 + 过度泛化结论');

{
  const answer = '所有论文查重率都低于10% [E1]。';
  const old = verifyAnswer(answer, new Map(POOL));
  check('旧校验：引用合法（1 条）', old.citations.length === 1, `引用 ${old.citations.length}`);
  check('旧校验：零告警（它看不出结论被过度泛化）', old.warnings.length === 0, old.warnings.join('；'));
  const verification = verifyClaims(old.answer, new Map(POOL));
  check(
    '新校验：同一句不再被当成 supported',
    verification.claims[0]?.verdict !== 'supported',
    String(verification.claims[0]?.verdict),
  );
  check('新校验：总账不是 verified', verification.status !== 'verified', verification.status);
  check(
    '新校验：给出可核对的原因',
    (verification.claims[0]?.reasons.length ?? 0) > 0,
    (verification.claims[0]?.reasons ?? []).join('；'),
  );
}

// ── 6. 假引用：先剔除，再判 insufficient ─────────────────────────
console.log('假引用：verifyAnswer 剔除后，Claim 层不会把空引用算成支持');

{
  const old = verifyAnswer('博士论文查重率低于10% [E9]。', new Map(POOL));
  // 会有两条告警：编造出处 + "没有引用也没承认缺依据"（后者是既有的 GC-08 防线）。
  check(
    '假编号被剔除，且留下编造出处告警',
    old.citations.length === 0 && old.warnings.some((w) => w.includes('不存在的证据')),
    old.warnings.join('；'),
  );
  const verification = verifyClaims(old.answer, new Map(POOL));
  check('剔除标记后的结论 → insufficient', verification.claims[0]?.verdict === 'insufficient', String(verification.claims[0]?.verdict));
}

// ── 7. 校准表（AI 起草，不是人工标注）────────────────────────────
{
  const original = '博士论文查重率低于10% [E1]。该制度允许现金支付。';
  const verified = verifyAnswer(original, POOL, { requireQuotes: true });
  const result = annotateRemovedQuoteClaims(
    original,
    verifyClaims(verified.answer, POOL),
    verified.removedQuoteIds,
  );
  check('摘录剔除后，本句依据不足标明连带原因',
    result.claims[0]?.reasons.some((reason) => reason.includes('[E1]') && reason.includes('摘录未通过')) === true);
  check('原本无引用的其他句子不归因于摘录剔除',
    result.claims[1]?.reasons.every((reason) => !reason.includes('摘录未通过')) === true);
}

console.log('校准表：误拒 / 误放（标签由 AI 起草，仅用于阈值回归，不是权威准确率）');

{
  const calibration: readonly { answer: string; expected: 'supported' | 'not_supported'; note: string }[] = [
    { answer: '博士论文查重率低于10% [E1]。', expected: 'supported', note: '原文原句' },
    { answer: '博士论文查重率低于10%，这一点有制度依据 [E1]。', expected: 'supported', note: '原句 + 轻微补充' },
    { answer: '样品应置于-80℃冰箱保存 [E2]。', expected: 'supported', note: '原文原句（含符号）' },
    { answer: '论文查重率有明确要求 [E1]。', expected: 'not_supported', note: '泛化、没有具体数值/出处细节' },
    { answer: '查重率低于10% [E1]。', expected: 'not_supported', note: '泛化指标 + 原文有多个取值' },
    { answer: '所有论文查重率都低于10% [E1]。', expected: 'not_supported', note: '过度泛化' },
    { answer: '硕士论文查重率低于10% [E1]。', expected: 'not_supported', note: '同指标数值矛盾' },
    { answer: '博士论文查重率低于20% [E1]。', expected: 'not_supported', note: '数值不存在' },
    { answer: '这篇稿子的状态是已录用 [E3]。', expected: 'not_supported', note: '记录值与结论不一致' },
    { answer: '博士论文查重率低于10%。', expected: 'not_supported', note: '没有引用' },
    { answer: '未经证实的说法是博士论文查重率低于10% [E1]。', expected: 'not_supported', note: '带"未经证实"限定，不能算支持' },
  ];

  let shouldSupport = 0;
  let supported = 0;
  let falseReject = 0;
  let shouldNot = 0;
  let falsePass = 0;
  for (const item of calibration) {
    const verdict = firstVerdict(item.answer);
    if (item.expected === 'supported') {
      shouldSupport += 1;
      if (verdict === 'supported') supported += 1;
      else falseReject += 1;
    } else {
      shouldNot += 1;
      if (verdict === 'supported') falsePass += 1;
    }
  }
  console.log(
    `    · 期望支持 ${shouldSupport} 条 → 规则判支持 ${supported} 条（误拒 ${falseReject}）`,
  );
  console.log(
    `    · 期望不支持 ${shouldNot} 条 → 规则判支持 ${falsePass} 条（误放 ${falsePass}）`,
  );
  check('高风险样例零误放（过度泛化/矛盾/无引用不得判 supported）', falsePass === 0, `误放 ${falsePass}`);
  // 误拒是规则层保守的代价，本轮**不要求为 0**；但必须打印出来，不能藏。
  check('校准表覆盖了正反两类', shouldSupport > 0 && shouldNot > 0);
}

// ── 汇总 ──────────────────────────────────────────────────────────
console.log('');
if (failed > 0) {
  console.error(`${failed} 项断言失败（通过 ${passed} 项）。`);
  process.exitCode = 1;
} else {
  console.log(`Claim 校验断言全部通过（${passed} 项）。`);
}
