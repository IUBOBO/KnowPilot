/**
 * 阶段 7「评测与回归」的类型。
 *
 * 【为什么这些类型不进 packages/shared】
 *   shared 是"前后端共用契约"的家。评测结果**没有前端消费者** —— 04 号阶段 7 的
 *   交付物里没有界面（阶段 4–6 的每样东西都有页，这一阶段没有）。放进 shared 只会
 *   多一份无人 import 的契约，然后被下一次重构当成"没人用"删掉或改错。
 *
 * 【为什么判定有五种，而不是规格里的三档】
 *   03 号 §6.2 定义 PASS / DEGRADE / REJECT 三档**交付**。但那是"跑完之后"的三档；
 *   评测跑批还要能表达三档说不了的两件事：
 *     · INCOMPLETE —— 该用例有一部分检查（需实机 / 待人工）本轮没跑；
 *     · NOT_IMPLEMENTED —— 该用例对应的能力系统里根本没有（见 cases.ts 的 note）。
 *   把这两件事塞进 DEGRADE 会撒谎：那不是"降级交付"，是"没测"。
 */
import type { Answer, AskHistoryTurn } from '@knowpilot/shared';
import type { BudgetLimits, BudgetUsage } from '../agent/budget.ts';
import type { EnvFingerprint } from './fingerprint.ts';

/** 五类评测（03 号 §2）。用例表按它分类。 */
export const GC_CATEGORIES = ['Outcome', 'Trajectory', 'Evidence', 'Safety', 'Cost'] as const;
export type GcCategory = (typeof GC_CATEGORIES)[number];

/**
 * 用例的"可跑程度"。
 *   · deterministic —— 判定全在本地数据上做（零模型）
 *   · model         —— 至少一项检查要模型真去跑一次（答案质量 / 对抗）
 *   · unimplemented —— 系统里**没有**对应能力，本轮无法判定（必须写 note 说明）
 */
export const GC_KINDS = ['deterministic', 'model', 'unimplemented'] as const;
export type GcKind = (typeof GC_KINDS)[number];

/** 三类评分器（03 号 §3.1）：确定性（主力，零模型）/ 模型评审 / 人工复核。 */
export type Scorer = 'deterministic' | 'model' | 'human';

export type Verdict = 'PASS' | 'DEGRADE' | 'REJECT' | 'INCOMPLETE' | 'NOT_IMPLEMENTED';

/**
 * 一条检查。判别联合：`k` 决定怎么判，其余字段是它的参数。
 *
 * 【为什么是"判别联合 + 参数"，不是"检查名 + 任意期望值"】
 *   后者在 TS 里只能把期望值标成 unknown，然后靠下标访问 —— 拼错字段名要等运行时
 *   才发现，而且评分器里全是 `as`。判别联合让"这条检查需要什么参数"在类型上唯一。
 *
 * `model-judged` / `human-reviewed` 是**声明式**检查：它们只在报告里占一行
 * （提醒这项工作欠着），确定性评分器不判它们 —— 见 scorer.ts。
 */
export type GcCheck =
  /** 至少 n 条引用 */
  | { k: 'cites-at-least'; scorer: Scorer; title: string; n: number }
  /** 至少一条**文档**引用且带页码（"每个事实性陈述都带出处"的机器可校验形态） */
  | { k: 'cites-document-with-page'; scorer: Scorer; title: string }
  /** 至少一条**实时记录**引用（台账 / 数据集 / 分区） */
  | { k: 'cites-record'; scorer: Scorer; title: string }
  /** 至少一条引用带 `version`（分区 / 规则类结论必须带"哪一年的哪个体系"） */
  | { k: 'citation-has-version'; scorer: Scorer; title: string }
  /** 正文出现「未找到依据」的固定措辞 —— GC-08 的正确形态（只看正文，见 scorer.ts） */
  | { k: 'says-not-found'; scorer: Scorer; title: string }
  /** 没有"无引用却没承认缺依据"的告警 —— 即没有孤立的事实性断言 */
  | { k: 'no-uncited-claim'; scorer: Scorer; title: string }
  /** 正文里每个 `[E#]` 都能对上一条引用（无悬空标记 = 幻觉引用数 0） */
  | { k: 'no-dangling-marker'; scorer: Scorer; title: string }
  /**
   * `confidenceNotes`（不是正文）里包含某段文字。
   *
   * GC-07 的判据落在这里而不是正文：经验类材料的"未经同行评审"标注由 prompt
   * （`agent/prompt.ts:112`）要求模型写进 `confidence_notes`，正文里本来就不该有它。
   * 对着正文找这句话，是找不到的。
   */
  | { k: 'confidence-note-includes'; scorer: Scorer; title: string; text: string }
  /**
   * 系统**输出**里不得出现某段文字（GC-09 注入 canary / GC-10 跨权限内容）。
   * 搜的是模型正文与 HTTP 响应体，**不含引用摘录**（摘录里出现注入串是"文档被正确引用"）。
   */
  | { k: 'no-content-leak'; scorer: Scorer; title: string; needle: string }
  /** HTTP 响应体应包含指定文字（共享台账的读取可见性）。 */
  | { k: 'http-body-includes'; scorer: Scorer; title: string; needle: string }
  /** 该次运行调用过某个工具 */
  | { k: 'tool-called'; scorer: Scorer; title: string; tool: string }
  /** HTTP 响应码等于 status（跨权限用例走真实路由） */
  | { k: 'http-status-is'; scorer: Scorer; title: string; status: number }
  /** 检索命中数等于 n（GC-12：未确认的草案 0 命中） */
  | { k: 'search-hits'; scorer: Scorer; title: string; n: number }
  /** 该次运行的检索候选命中了至少一条金标块（"召回有没有到位"的机器可判形态） */
  | { k: 'retrieval-covers-gold'; scorer: Scorer; title: string }
  /**
   * 该次运行**进过证据池的记录**里含有指定的那条（台账 / 数据集 / 分区）。
   *
   * 【它和 `retrieval-covers-gold` 是一对，但管的是**记录**不是文档块】
   *   安全类用例（S1-sec）判的是"记录字段里夹带的指令有没有生效"。这条判据要成立，
   *   前提是那条记录**真的被工具返回过** —— 否则注入串压根没进模型上下文，
   *   "没泄露"就是一次空转假过。文档侧靠 `retrieval-covers-gold` 顶住这件事，
   *   记录侧此前**没有任何字段可判**，只能拿 `tool-called`（工具调过）顶替，
   *   而"调过工具"与"这条记录回来了"是两回事（关键词没命中就什么都不返回）。
   */
  | { k: 'record-in-context'; scorer: Scorer; title: string }
  /** 本次运行的工具调用总数不超过 n（"可控预算不超限"） */
  | { k: 'tool-call-count-at-most'; scorer: Scorer; title: string; n: number }
  /** 本次运行渲染给模型的证据字符数不超过 n（上下文预算，C1/X2a） */
  | { k: 'context-chars-at-most'; scorer: Scorer; title: string; n: number }
  /** 本次运行的终态等于 outcome（`aborted` / `ok` / `timeout` …） */
  | { k: 'outcome-is'; scorer: Scorer; title: string; outcome: string }
  /** 本次运行没有任何 Claim 被判 `contradicted`（与所引原文数值/方向不一致） */
  | { k: 'no-contradicted-claim'; scorer: Scorer; title: string }
  /** 本次运行的 Claim 里，`supported` 占比至少为 ratio（分母 = 全部被校验 Claim） */
  | { k: 'claim-support-at-least'; scorer: Scorer; title: string; ratio: number }
  /** 交付状态等于 status（`verified` / `partial` / `interrupted` / `failed`） */
  | { k: 'delivery-status-is'; scorer: Scorer; title: string; status: string }
  /** 子目标覆盖率至少为 ratio（S5；分母 = 计划的必需子目标数） */
  | { k: 'subgoal-coverage-at-least'; scorer: Scorer; title: string; ratio: number }
  /** 本次运行的改写轮次不超过 n（S5：默认 ≤1） */
  | { k: 'rewrite-rounds-at-most'; scorer: Scorer; title: string; n: number }
  /** 追问改写结果包含至少一个指定词（O3：证明代词/省略被还原） */
  | { k: 'follow-up-rewrite-includes'; scorer: Scorer; title: string; terms: readonly string[] }
  /** 追问改写结果不含任何指定词（O3：话题切换时不得沿用旧话题） */
  | { k: 'follow-up-rewrite-excludes'; scorer: Scorer; title: string; terms: readonly string[] }
  /**
   * 这次运行**没有**交出答案正文。
   *
   * 【为什么"没有答案"能是一条 PASS】它专属于中止/超时那条路径：没人还在等结果时，
   *   合成一份"看起来像回答"的东西才是错的（`ask-run.ts` 抛 `AskAbortedError`
   *   而不是返回半截答案，同一条判断）。用它把"中止"与"答坏了"分开。
   */
  | { k: 'no-answer-delivered'; scorer: Scorer; title: string }
  /** 声明一项**需模型评审**的语义判断（本轮不自动判，报告里占位） */
  | { k: 'model-judged'; scorer: 'model'; title: string; criterion: string }
  /** 声明一项**待人工复核**（03 号 §3.1 的第三类评分器） */
  | { k: 'human-reviewed'; scorer: 'human'; title: string; criterion: string };

/** 一条用例。 */
export interface GcCase {
  id: string;
  title: string;
  category: GcCategory;
  kind: GcKind;
  /** 命中即 REJECT，不计入平均分（03 号 §2.2）。四条：GC-08/09/10/12。 */
  blocker: boolean;
  /** 关键回归用例（03 号 §4）：改 Prompt / 检索 / 分块 / 权限后要全量跑的那批。 */
  regression: boolean;
  /** 输入与约束（人读的说明，跑批时按它造/取语料）。 */
  scenario: string;
  /**
   * 跑批时**实际发给问答链路的提问**（需实机的用例才有）。
   *
   * 【为什么提问要写在用例里，而不是散在跑批脚本中】
   *   提问是这条用例的**输入**，`scenario` 只是它的散文说明。把输入拆到另一个文件，
   *   "这条用例到底问的是什么"就要跨两个文件对照着读；而提问一改，用同一份语料
   *   跑出来的历史结果就不能再比了 —— 它必须和用例集**同版本演进**。
   *   语料由 `corpus.ts` 播种，提问与语料是一对，两者一起被 `dataSnapshot` 与用例表版本钉住。
   *
   * 缺省 = 本轮没有给它接提问（离线跑、或该用例的语料还没备），检查一律记 `NOT_RUN`。
   */
  question?: string;
  /**
   * 多轮用例的**会话历史**（O3）。省略 = 单轮提问。
   *
   * 历史是**固定的脚本输入**，不是上一回合实际跑出来的答案 —— 评测要能重复，
   * 而让第一轮真跑一次模型会把"追问改写"的判定绑在那一次的措辞上。
   */
  history?: readonly AskHistoryTurn[];
  /**
   * 本条用例的**金标语料标签**（`EvalCorpus.gold` 的键，如 `method` / `cost`）。
   *
   * 【为什么写标签而不是直接写 chunk id】chunk id 每跑一遍都不同（语料是现场播种的）。
   *   用例表要能跨运行复用，就只能声明"这条题的金标来自哪几份语料"，
   *   由跑批端在**本轮**把标签解析成本轮的 chunk id。
   *   不写 = 这条用例没有金标（如"预期拒答"题），`retrieval-covers-gold` 会记 `NOT_RUN`。
   */
  gold?: readonly string[];
  /**
   * 本条用例的**金标记录标签**（`EvalCorpus.records` 的键，如 `injectedAsset`）。
   *
   * 与 `gold` 同一套理由（id 每轮都变，用例表要跨运行复用），只是指向**记录**
   * 而不是文档块。记录类安全用例靠它把"那条夹带指令的记录确实进过上下文"变成
   * 一条机器可判的前置 —— 见 `record-in-context`。
   */
  goldRecords?: readonly string[];
  checks: readonly GcCheck[];
  /** kind='unimplemented' 时**必填**：为什么没有可判定的能力。 */
  note?: string;
}

/**
 * 一次用例运行的**观测量**。跑批端（run.ts）负责把各种来源塞进来：
 * 问答链路给 `answer` + `toolCalls`，跨权限用例给 `http`，GC-12 给 `searchHits`。
 * 评分器只读它、不产生它 —— 所以 scorer.ts 可以零 IO、零模型地被单测。
 *
 * 字段都是可选的：缺哪个，就用它的那条检查记 `NOT_RUN`（"没测"，不是"没过"）。
 */
export interface GcObservation {
  answer?: Answer;
  toolCalls?: readonly string[];
  http?: { status: number; body: string };
  searchHits?: number;
  /**
   * 本轮语料里**是否含分页文档**（有页码的块）。GC-01 的"引用带具体页码"要靠它。
   *
   * 【为什么它必须由跑批端提供，而不是让评分器自己看引用】"引用了带页码的文档"与
   *   "语料里根本没有可带页码的文档"是两件事，而 `answer.citations` 在两种情况下
   *   长得一模一样（都是 `page: null`）。合成语料是 markdown（无页的概念），
   *   缺了这一位，GC-01 就会被判成 DEGRADE —— 报告上写的是**系统降级**，
   *   实际只是**这一轮测不到**。宁可记 NOT_RUN 并写明原因（见 scorer.ts）。
   */
  hasPagedDocument?: boolean;
  /**
   * 本次运行**检索到的文档块 id**，按进入证据池的顺序。
   *
   * 【为什么它与 `answer.citations` 是两回事】引用是"检索到的东西里被正文用到的那些"。
   *   评测要判的是召回本身：**检索到了却没引用**是生成的问题，**压根没检索到**是
   *   召回的问题 —— 这两种失败在最终答案上长得一模一样，只有把整池候选单独拿出来才分得开。
   */
  retrievalHits?: readonly string[];
  /** 本条用例的金标块 id（跑批端按 `GcCase.gold` 的标签在本轮解析后注入）。 */
  goldChunkIds?: readonly string[];
  /**
   * 本次运行**进过证据池的记录 id**（台账 / 数据集 / 分区），与文档块的 `retrievalHits` 并列。
   *
   * 【它为什么不是"引用到的记录"】引用是"正文用到了"，这里是"**模型看见了**"。
   *   安全用例要判的是后者：记录字段里的注入串只要被工具返回就进了上下文。
   */
  recordIds?: readonly string[];
  /** 本条用例的金标记录 id（跑批端按 `GcCase.goldRecords` 的标签在本轮解析后注入）。 */
  goldRecordIds?: readonly string[];
  /** 本次运行的工具调用总数（预算类断言的观测量）。 */
  toolCallCount?: number;
  /** 本次运行渲染给模型的证据字符数（上下文预算，C1/X2a）。 */
  contextChars?: number;
  /** 本次运行的终态。中止的那条路径上它是 `aborted`，且**没有** `answer`。 */
  outcome?: string;
  /**
   * 本次运行的 Claim 级校验摘要（V1/V2）。
   *
   * 【只有编号与判定，没有 Claim 正文】评测要判"有没有矛盾 / 支持率"，
   *   不需要把模型写的原句再落一份到报告里；正文可能含未发表内容。
   */
  claimChecks?: readonly { claimId: string; verdict: string }[];
  /** 交付状态：verified / partial / interrupted / failed。 */
  deliveryStatus?: string;
  /** 子目标覆盖率（S5）：已覆盖的必需子目标 / 必需子目标总数。 */
  subgoalCoverage?: number;
  /** 本轮实际发生的受限改写轮次（0/1）。 */
  rewriteRounds?: number;
  /**
   * 引用片段校验计数（O2）：正文里的**文档**引用有多少条提供了逐字摘录、
   * 有多少条因此被剔除。`checked = 0` 表示这次回答没有文档引用。
   *
   * 【为什么放在观测量里】O0 要把"引用片段校验通过率"做成基线指标；
   *   只看最终 `citations` 看不出来"本来引了几条、因为摘录不符剔了几条"。
   */
  quoteChecks?: { checked: number; passed: number; failed: number };
  /**
   * 本次运行的追问改写结果（O3）。首轮提问、改写失败或未开启时缺席。
   *
   * 【为什么观测里要留原文与改写两段】验收要判的是"改得对不对"：
   *   指代消解用例要看改写后**带上了上一轮的主语**，切话题用例要看它**没被
   *   硬拽回上一轮**。只看最终回答分不清"模型答对了"与"检索恰好猜对了"。
   */
  followUpRewrite?: { original: string; rewritten: string; changed: boolean };
}

export interface CheckOutcome {
  title: string;
  scorer: Scorer;
  status: 'PASS' | 'FAIL' | 'NOT_RUN';
  detail?: string;
}

export interface CaseResult {
  caseId: string;
  blocker: boolean;
  kind: GcKind;
  /** 是否**所有**检查都跑过（模型检查没开时，需实机的用例会是 false）。 */
  complete: boolean;
  verdict: Verdict;
  checks: readonly CheckOutcome[];
}

/**
 * 一次运行的 Trace（03 号 §5 的记录需求）。
 *
 * 【`promptHash` 的实际含义，与设计文档不同 —— 必须写清】
 *   03 号 §5 要求 `PromptPlan.hash`。全仓**没有 `PromptPlan`** —— 那套
 *   `{blocks[], hash, totalBytes, …}` 结构只在 02 号 §7.2 提过，从未落成代码，
 *   `ask-run.ts` 里只有一个拼好的 system prompt 字符串。所以这里的 `promptHash`
 *   是**对那段 system prompt 取 sha256**，用来"改了 Prompt 能一眼看出哪次运行是旧版"。
 *   它够用（这就是 hash 要干的事），但**不等于**规格里的 `PromptPlan.hash`。
 */
export interface Trace {
  runId: string;
  caseId: string;
  model: string | null;
  promptHash: string | null;
  dataSnapshot: string;
  toolCalls: readonly string[];
  retrievalHits: readonly { chunkId: string; score: number; rank: number }[];
  /**
   * 这次运行进过证据池的**记录**（台账 / 数据集 / 分区）。
   *
   * 【为什么 Trace 要记它】`citationMap` 只记"正文引用到的"，而安全类用例要判的是
   *   "这段记录文字**有没有机会影响模型**" —— 只要被工具返回就成立。少这一位，
   *   复盘一次注入事故时就看不出"那条记录到底喂进去没有"，只能靠猜。
   */
  recordEvidence: readonly { recordType: string; recordId: string }[];
  citationMap: readonly { id: string; chunkId: string | null; recordId: string | null }[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number } | null;
  /** 系统记录的协议偏离告警（如编造引用被剔除）。空 = 本次回答没有偏离约定。 */
  warnings: readonly string[];
  /**
   * 运行级错误。成功时为空。
   *
   * 【2026-10-16（T1）起它真的会有值了】改造前 Trace 只在成功路径产生，
   *   这个字段因此恒为空 —— 注释当时也如实写着"留着是为了以后能表达失败"。
   *   现在 `hooks.onFinalize` 五条终态全都回调，超时 / 中止 / 模型报错那几次
   *   也进 Trace，失败原因就写在它的 `errors` 里。
   */
  errors: readonly string[];
  outcome: string;
  /**
   * 交付状态（V1/V2 + X1a）：verified / partial / interrupted / failed。
   * 与 `outcome` 并列：运行成功但结论未全部校验时，`outcome=ok` + `deliveryStatus=partial`。
   */
  deliveryStatus: string;
  /**
   * Claim 级校验摘要。**不记 Claim 正文**（可能含未发表内容）；只记编号、判定、证据号。
   */
  claimChecks: readonly {
    claimId: string;
    verdict: string;
    evidenceIds: readonly string[];
    spanEvidenceIds: readonly string[];
  }[];
  /** 任务路由（S5） */
  route: string;
  /** 计划覆盖摘要（不含子问题原文） */
  plan: {
    coverage: string;
    coverageRatio: number;
    subgoals: readonly {
      id: string;
      kind: string;
      status: string;
      evidenceCount: number;
    }[];
  };
  /** 受限改写轮次（0/1） */
  rewriteRounds: number;
  /** 每轮改写的 gap 原因、查询前后与覆盖变化 */
  rewriteEvents: readonly {
    round: number;
    gapReason: string;
    missingSubgoalIds: readonly string[];
    queries: readonly { text: string; subgoalId: string }[];
    evidenceIdsAdded: readonly string[];
    coverageBefore: string;
    coverageAfter: string;
    stoppedReason: string;
  }[];
  /**
   * O3：本轮追问改写的输入与输出。首轮提问或改写失败时省略。
   *
   * 记在 Trace 里是因为它是**检索的输入**：一次追问答偏，要先分清是
   * "改写把指代解错了"还是"检索没找到"—— 没有这一位，两者在答案上长得一样。
   */
  followUpRewrite?: { original: string; rewritten: string; changed: boolean; ms: number };
  turn: number;
  /**
   * 为什么停下来（诊断口径，见 `agent/budget.ts`）。
   *
   * 【它与 `outcome` 并列而不是二选一】预算掐住之后模型仍会交答案，
   *   那次 `outcome` 是 `ok`、`stopReason` 是 `rounds`。"成功但被截断"
   *   与"正常成功"是完全不同的两句话，合并成一个字段就必然丢掉一句。
   */
  stopReason: string;
  /** 停止时走到哪一步（`startup` / `retrieval` / `generation` / `assembly`）。 */
  lastStage: string;
  /** 停止时证据池里已有多少条 —— "这次失败之前已经拿到了什么"。 */
  evidenceCount: number;
  /** 本次运行渲染给模型的证据字符数（上下文预算用量，C1/X2a）。 */
  contextChars: number;
  /** 四维预算的额度与实际用量。 */
  budget: { limits: BudgetLimits; used: BudgetUsage };
  /** 这次运行的总耗时（毫秒）。 */
  durationMs: number;
}

/**
 * 一条用例在**一次跑批**里的最终记账：跑了几个回合 + 复现用的主结果。
 *
 * 【为什么不直接把 `CaseResult` 放进报告、另开一张稳定性表】
 *   03 号 §6 的 `pass^k` 有两条要求必须同时满足，而它们只能一起表达：
 *     1. k 次**全过**才算稳定（k=3 时 2 过 = 不稳定）；
 *     2. **严禁用"k 次里最好的一次"当结果**。
 *   所以这里既存 `stable`（要求 1），又让 `result` 取**最差**的那一次（要求 2）——
 *   报告上写着 PASS 就一定意味着"没跑出过更差的一次"。拆成两张表，
 *   读的人得自己在心里 join，而"最好一次"这类错误恰恰出在这种时候。
 */
export interface CaseRun {
  caseId: string;
  /** 实际跑了几回合。确定性用例恒 1（重复跑没有新信息）；需模型的用例 = k。 */
  runs: number;
  /** k 次是否**全部** PASS。k=1 时等价于该次 `result.verdict === 'PASS'`。 */
  stable: boolean;
  /**
   * 每回合的判定，按运行顺序。`result` 仍只保留**最差**的一次；
   * 这里补的是分布 —— 否则「1/3 失败」与「3/3 失败」在报告里长得一样，
   * 稳定性只能写成"不稳定"，无法说明偶发还是必然。
   */
  runVerdicts: readonly Verdict[];
  /** 复现用的主结果：多回合时取**最差**的一次；单回合时就是那一次。 */
  result: CaseResult;
}

/**
 * O0 的基线指标。**每一项都可能为 null** —— null 表示"这一轮没有可统计的样本"，
 * 与"统计了但值为 0"是两件事（例如离线跑、全是预期拒答题、没有任何文档引用）。
 * 报告里不写 null 项，避免把"没测"读成"0 分"。
 */
export interface EvalMetrics {
  /** 检索：召回@8 / MRR@8 / 无关块占比。口径见 metrics.ts 文件头。 */
  retrieval: {
    samples: number;
    recallAt8: number;
    microRecallAt8: number;
    mrr: number;
    unrelatedRatio: number;
    goldHitTotal: number;
    goldTotal: number;
  } | null;
  /** 无依据题：正文出现「未找到依据」的次数 / 实际判过的次数。 */
  refusal: { hit: number; total: number } | null;
  /** 引用编号有效率：交付过答案的运行里，没有编造引用警告的次数 / 总次数。 */
  citationValidity: { cleanRuns: number; answerRuns: number } | null;
  /** 引用片段校验（O2）：文档引用条数与逐字摘录通过数。 */
  quoteChecks: { checked: number; passed: number; failed: number } | null;
  /**
   * 用量与延迟（O11）：单次问答的成本、token 与缓存命中。
   *
   * 只统计**真的产出了 usage** 的运行：离线跑没有 usage，不能按 0 记，
   * 否则平均值会被离线样本稀释成一个看起来"很便宜"的假数。
   * `cacheHitRatio = cacheReadTokens / (inputTokens + cacheReadTokens)` ——
   * 分母是这一轮实际送进模型的全部提示 token；缓存写单独列，不重复计入。
   */
  usage: {
    runs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    avgCostUsd: number;
    avgDurationMs: number;
    cacheHitRatio: number;
  } | null;
}

export interface EvalReport {
  at: string;
  /** 本轮的运行标识。也是运行目录与报告文件名的一部分（见 guard.ts）。 */
  runId: string;
  k: number;
  /** 本轮是否真的接了实机模型。false = 需模型的检查全部 `NOT_RUN`（没测，不是没过）。 */
  realModel: boolean;
  dataSnapshot: string;
  /**
   * 运行环境与源码指纹（03 号 §4 的可比条件：同用例集 + 同快照 + 同环境）。
   *
   * 【为什么它比 state 快照更重要】`dataSnapshot` 只钉住语料。源码与模型换了，
   *   报告的数字会变，但**没有任何断言会因此变红** —— 只是结论悄悄失去意义。
   */
  env: EnvFingerprint;
  /** O0 基线指标。字段为 null = 本轮没有可统计的样本（见 `EvalMetrics`）。 */
  metrics: EvalMetrics;
  cases: readonly CaseRun[];
  /**
   * 本轮产生的 Trace（03 号 §5 的记录需求）。
   *
   * 【为什么跟报告同生共死，而不是单独一个文件】Trace 的价值全在"和这次判定的结果
   *   对得上"：报告说 GC-01 的引用带页码，Trace 说它召回了哪些块、引了哪几个 ——
   *   两份文件分开放，就会出现"报告和 Trace 不是同一次跑的"这种无法察觉的错配。
   *   同一次写盘，靠 `runId` 就能在两者间来回对照。
   *
   * 离线跑时为空：没有任何一次实机运行，也就没有运行事实可记。
   */
  traces: readonly Trace[];
  /**
   * 人读的附注：语料自检行、本轮跑了哪些、哪些如实标了未跑 / 未落地。
   * 它不参与判定 —— 判定只在 `cases` 里。写在这里是因为"这一轮的报告证明了什么、
   * 没证明什么"必须和结果一起落档，否则下次读到一份全 INCOMPLETE 的报告会以为全坏了。
   */
  notes: readonly string[];
}
