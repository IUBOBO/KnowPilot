/**
 * 单元 ① 的验证入口：`npm run ask -w @knowpilot/server -- "问题"`
 *
 * 为什么先做命令行再接界面：
 *   "问答到底能不能用"取决于三件与界面无关的事 —— 模型会不会检索、
 *   会不会编引用、会不会在没依据时说没有。这三件事在命令行里各是一行输出，
 *   在界面上则要先怀疑样式、再怀疑渲染、最后才怀疑模型。
 *   命令行跑通了，界面就只剩"把已有字段画出来"。
 */
import { RECORD_TYPE_LABELS } from '@knowpilot/shared';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { runAsk, type AskFinalization } from './ask-run.ts';
import { createLabModels } from './models.ts';

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(' ').trim();
  if (question === '') {
    console.error('用法：npm run ask -w @knowpilot/server -- "你的问题"');
    process.exitCode = 1;
    return;
  }

  const cfg = loadConfig();
  const { db } = openDb(cfg.dbPath);
  const models = createLabModels();

  console.log(`问题：${question}`);
  console.log('─'.repeat(70));

  try {
    const started = Date.now();
    let finalization: AskFinalization | undefined;
    const res = await runAsk(
      { db, config: cfg, models },
      // 命令行入口视同"使用者已知情"：是开发者本人在自己的机器上跑，
      // 出网的内容他自己看得见。界面那条路才需要勾选确认。
      //
      // `user: null` 是有意的：命令行没有登录身份，因而台账工具按
      // "看不到任何人的私有记录"处理（`submissionScope(null)`），
      // 只剩归属为 NULL 的公共历史数据。给它一个假身份会让这条路径
      // 看起来"有权限"，而权限从哪来的无从追究。
      { question, consentConfirmed: true, user: null },
      {
        onEvent: (e) => {
          if (e.type === 'status') console.log(`  … ${e.message}`);
          if (e.type === 'evidence') {
            console.log(`  … 新增 ${e.added} 条证据（累计 ${e.total} 条）`);
          }
        },
        onFinalize: (f) => {
          finalization = f;
        },
      },
    );

    const { answer } = res;
    console.log('');
    console.log(answer.answer);
    console.log('');

    if (answer.citations.length > 0) {
      console.log('引用：');
      for (const c of answer.citations) {
        // 两类引用能回去的地方不同，分开打印 —— 台账引用没有页码与块号。
        // 硬用同一行格式会打印出一串 undefined，反而看不出它引的是什么。
        if (c.sourceType === 'record') {
          console.log(`  [${c.id}] 【${RECORD_TYPE_LABELS[c.recordType]}】${c.recordTitle}`);
          console.log(`        record=${c.recordType}:${c.recordId} 查询于 ${c.queryTime}`);
          for (const f of c.fields) console.log(`        ${f.label}：${f.value}`);
          continue;
        }
        const where = [c.page === null ? '无页码' : `第 ${c.page} 页`, c.sectionPath.join(' > ')]
          .filter((s) => s !== '')
          .join(' · ');
        console.log(`  [${c.id}] 《${c.documentTitle}》 ${where}`);
        console.log(`        chunk=${c.chunkId} score=${c.score.toFixed(4)}`);
      }
    } else {
      console.log('引用：无');
    }

    printList('依据缺口', answer.evidenceGaps);
    printList('限制', answer.limits);
    printList('置信度说明', answer.confidenceNotes);
    printList('冲突', answer.conflicts);
    printList('警告', answer.warnings);

    // V1/V2：逐句校验结果。命令行入口是开发者排查"为什么这句被判待核对"的地方，
    // 所以这里把原句、判定、原因和证据号都打印出来（界面同理）。
    console.log(
      `交付状态：${res.delivery.status}` +
        `（supported ${answer.verification.counts.supported} · contradicted ${answer.verification.counts.contradicted}` +
        ` · insufficient ${answer.verification.counts.insufficient} · review_required ${answer.verification.counts.review_required}）`,
    );
    console.log(
      `证据上下文：${res.delivery.contextChars} 字符（池内 ${res.delivery.evidenceCount} 条）`,
    );
    if (finalization !== undefined) {
      console.log(
        `路由：${finalization.route} · 子目标覆盖 ${(finalization.plan.coverageRatio * 100).toFixed(0)}%` +
          `（${finalization.plan.coverage}）· 改写轮次 ${finalization.rewriteRounds}`,
      );
      for (const subgoal of finalization.plan.subgoals) {
        console.log(`  ${subgoal.id} [${subgoal.kind}] ${subgoal.status} · ${subgoal.evidenceCount} 条`);
      }
      for (const event of finalization.rewriteEvents) {
        console.log(
          `  改写 ${event.round}：${event.gapReason}，缺 ${event.missingSubgoalIds.join('、') || '无'}，` +
            `查询 ${event.queries.map((q) => q.text).join(' | ') || '（空）'}，` +
            `补证 ${event.evidenceIdsAdded.length} 条，${event.coverageBefore} → ${event.coverageAfter}（${event.stoppedReason}）`,
        );
      }
    }
    for (const claim of answer.verification.claims) {
      console.log(`  [${claim.claimId}] ${claim.verdict}：${claim.text}`);
      if (claim.reasons.length > 0) console.log(`        ${claim.reasons.join('；')}`);
      if (claim.evidenceIds.length > 0) console.log(`        证据：${claim.evidenceIds.join('、')}`);
    }

    console.log('─'.repeat(70));
    console.log(
      `runId=${res.runId} 轮次=${answer.rounds} 耗时=${answer.durationMs}ms` +
        `（本进程总耗时 ${Date.now() - started}ms）`,
    );
    console.log(
      `用量：输入 ${answer.usage.inputTokens} / 输出 ${answer.usage.outputTokens}` +
        ` / 缓存读 ${answer.usage.cacheReadTokens} / 缓存写 ${answer.usage.cacheWriteTokens} tokens` +
        `，费用 $${answer.usage.costUsd.toFixed(6)}`,
    );
  } finally {
    db.close();
  }
}

function printList(title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  console.log(`${title}：`);
  for (const item of items) console.log(`  · ${item}`);
}

main().catch((err: unknown) => {
  console.error('\n失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
