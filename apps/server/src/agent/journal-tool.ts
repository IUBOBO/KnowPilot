/**
 * 期刊分区工具 `query_journal`（C-JOURNAL）—— **只查本地「期刊分区库」**。
 *
 * 【它曾经有一条联网分支，2026-10-12 随联网搜索整体下线】那时候的逻辑是
 *   "本地未收录 → 公网检索 → 抽得出年份/体系/档位就回填本地表"。联网搜索因为
 *   **没有可用的搜索 API** 被整个删掉（配置页也一并改成大模型接口设置），
 *   这里就只剩本地一条路：查不到就如实说"库里没有"，让模型提示用户去
 *   「期刊分区库」页面手工补录（提示词里写明了这条）。
 *   工具名、参数、返回形状、证据编号都没有变 —— 历史工具日志里的
 *   `query_journal` 调用依然对得上。
 *
 * 【为什么本工具是只读的】从前它有一条写路径（决策 10 的回填），
 *   而写库的字段要从**检索结果文本**里确定性解析，绝不交给模型生产 ——
 *   设计文档把"模型只能引编号、不能产出结构化结论"当作防幻觉的基石
 *   （见 shared/answer.ts 开头）。联网下线后写路径也一起没了，这条约束更容易守住。
 */
import { StringEnum, Type, type Static } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  JOURNAL_SYSTEMS,
  isUnverifiedSource,
  rankingSourceLabel,
  type CitationField,
  type JournalRanking,
  type JournalSystem,
} from '@knowpilot/shared';
import type { Db } from '../db/index.ts';
import { findJournal, listRankings } from '../submissions/repo.ts';
import { renderEvidenceForModel, type EvidencePool, type QueryDetails } from './evidence.ts';
import { UNVERIFIED_WEB_LABEL } from './prompt.ts';

export const JOURNAL_TOOL = 'query_journal';

const JournalParams = Type.Object({
  journal: Type.String({
    description: '期刊名（尽量用全称），例如「Nature Communications」。',
  }),
  issn: Type.Optional(Type.String({ description: 'ISSN（有就填，比刊名更准）。' })),
  system: Type.Optional(
    StringEnum(JOURNAL_SYSTEMS, {
      description: '分区体系。用户说了"中科院"或"JCR"时才填；没说就省略，默认按中科院查。',
    }),
  ),
  year: Type.Optional(
    Type.Number({
      minimum: 2000,
      maximum: 2100,
      description: '要查哪一年的分区。用户说了年份才填。**不要**自己把"今年"换算成具体年份的猜测值。',
    }),
  ),
});

export type JournalArgs = Static<typeof JournalParams>;

export interface JournalToolDeps {
  db: Db;
  pool: EvidencePool;
  /** 注入当前时刻，便于测试固定时间；省略则取 `new Date()`。 */
  now?: () => Date;
}

/**
 * 一条分区记录 → 引用卡片上的结论字段。**年份、体系、来源缺一不可**（决策 2）。
 *
 * 【核对状态为什么看 source 而不是 verified】官方分区表导进来的那条
 *   `verified` 也是 0（没人逐条核过），但它本身就是权威数据源。按 verified
 *   判断会给它打上"未经权威数据源核对"——一句明确的假话。判据只能是来源。
 */
export function rankingFields(r: JournalRanking, journalName: string): CitationField[] {
  const fields: CitationField[] = [
    { label: '期刊', value: journalName },
    { label: '体系', value: r.system },
    { label: '年份', value: String(r.year) },
  ];
  // 维度空串 = 这条数据没有维度信息，不显示空标签。
  if (r.category !== '') fields.push({ label: '维度', value: r.category });
  fields.push({ label: '分区', value: r.rank });
  if (r.top) fields.push({ label: 'Top 期刊', value: '是' });
  if (r.note !== null) fields.push({ label: '补充', value: r.note });
  fields.push({ label: '数据来源', value: rankingSourceLabel(r.source) });
  // 库里可能还留着**当年联网回填**的行（source = 'web_search'）：联网功能没了，
  // 但这些行还在表里、还会被查出来。它们仍然必须打上"未经核对"的标注 ——
  // 判断依据是数据来源，不是"系统现在还能不能联网"。
  if (isUnverifiedSource(r.source)) fields.push({ label: '核对状态', value: '未经权威数据源核对' });
  if (r.sourceUrl !== null) fields.push({ label: '来源链接', value: r.sourceUrl });
  fields.push({ label: '抓取时点', value: r.fetchedAt });
  return fields;
}

/** 分区记录在证据池里的身份：一条 = 一个 (刊, 年, 体系, 维度)。
 *  维度必须进 id：同一刊同一年同体系的大类与小类是**两条不同的记录**，
 *  只用前三者会让后者在证据池里顶掉前者（表现为只引用得到其中一条）。 */
export function rankingRecordId(journalId: string, r: JournalRanking): string {
  return `${journalId}:${r.year}:${r.system}:${r.category}`;
}

function addRankingEvidence(
  deps: JournalToolDeps,
  journalId: string,
  journalName: string,
  ranking: JournalRanking,
  queryTime: string,
): { id: string; isNew: boolean; rendered: string } {
  const { evidence, isNew } = deps.pool.addRecord({
    recordType: 'M-JOURNAL',
    recordId: rankingRecordId(journalId, ranking),
    recordTitle: journalName,
    queryTime,
    recordUpdatedAt: null,
    // 硬约束 3：分区引用必须带版本。形如「2025 中科院 计算机科学」——
    // 维度要带上，否则同一本刊的大类与小类两条证据看起来一模一样。
    version:
      ranking.category === ''
        ? `${ranking.year} ${ranking.system}`
        : `${ranking.year} ${ranking.system} ${ranking.category}`,
    fields: rankingFields(ranking, journalName),
  });
  return { id: evidence.id, isNew, rendered: renderEvidenceForModel(evidence) };
}

/**
 * 查期刊分区。**只查本地表**，查不到就如实说"库里没有"。
 *
 * 【为什么"库里没这本刊"和"库里有这本刊、但没有你要的那个体系/年份"必须分开说】
 *   两者对用户的意义完全不同：一个要从头补录，一个补一条维度就行。
 *   不加区分的话模型会对着一本明明收录了的刊说"未收录"，那是最让人迷惑的一种回答。
 */
export function createJournalTool(
  deps: JournalToolDeps,
): AgentTool<typeof JournalParams, QueryDetails> {
  return {
    name: JOURNAL_TOOL,
    label: '查期刊分区',
    description:
      '查一本期刊的**分区**（中科院 / JCR），数据来自本地「期刊分区库」。' +
      '本地库没收录这本刊时，如实说「未收录」，并提示用户可以在「期刊分区库」页面手工补录。' +
      '返回带证据号（[En]）的记录，含**体系、年份、维度、分区、来源**与是否核对。' +
      '回答"X 几区"这类问题时**必须用本工具**，并且结论里必须带上年份、体系与维度 —— ' +
      '不带年份的"几区"过一年就是错的；同一本刊的**大类分区与小类分区可以不同**' +
      '（例如大类 3 区、遥感小类 4 区），不说维度就成了另一件事。',
    parameters: JournalParams,
    execute: async (_toolCallId, params): Promise<AgentToolResult<QueryDetails>> => {
      const now = deps.now ?? ((): Date => new Date());
      const queryTime = now().toISOString();
      const system: JournalSystem = params.system ?? '中科院';

      const journal = findJournal(deps.db, { name: params.journal, issn: params.issn });
      const all = journal === null ? [] : listRankings(deps.db, journal.id, 20);

      // ── 本地命中：直接返回 ──────────────────────────────────
      if (journal !== null) {
        const hit = all.filter(
          (r) => r.system === system && (params.year === undefined || r.year === params.year),
        );
        if (hit.length > 0) {
          const newEvidenceIds: string[] = [];
          const evidenceIds: string[] = [];
          const rendered: string[] = [];
          for (const r of hit) {
            const e = addRankingEvidence(deps, journal.id, journal.name, r, queryTime);
            if (e.isNew) newEvidenceIds.push(e.id);
            evidenceIds.push(e.id);
            rendered.push(e.rendered);
          }
          return {
            content: [
              {
                type: 'text',
                text: [
                  `本地「期刊分区库」里查到「${journal.name}」的 ${rendered.length} 条 ${system} 分区：`,
                  '',
                  ...rendered,
                  '',
                  '以上是本地表里的记录。回答时必须带上**年份、体系与维度**' +
                    '（例如「2025 年中科院（计算机科学）1 区」）——' +
                    '同一本刊的大类分区与小类分区可以不同，不说维度就成了另一件事。',
                  hit.some((r) => isUnverifiedSource(r.source))
                    ? `其中来自**网络检索**的记录，回答里必须原样注明「${UNVERIFIED_WEB_LABEL}」。`
                    : '这些记录来自权威分区表或人工录入，可以正常引用。',
                ].join('\n'),
              },
            ],
            details: { newEvidenceIds, evidenceIds },
          };
        }
      }

      // ── 本地没有要查的那一条 ────────────────────────────────
      if (all.length > 0) {
        const have = all
          .map((r) => `${r.year} ${r.system}${r.category === '' ? '' : `（${r.category}）`} ${r.rank}`)
          .join('、');
        return {
          content: [
            {
              type: 'text',
              text:
                `本地「期刊分区库」里**有**「${journal?.name ?? params.journal}」，` +
                `但没有 ${system}${params.year === undefined ? '' : ` ${params.year} 年`} 的分区记录。\n` +
                `库里现有的是：${have}。\n` +
                '回答时**不要说"库里没收录这本刊"**——它收录了，只是没有你问的那个体系/年份。\n' +
                '如实说「库里没有该体系/年份的分区记录」，并提示用户可以在「期刊分区库」页面补录。',
            },
          ],
          details: { newEvidenceIds: [], evidenceIds: [] },
        };
      }

      return {
        content: [
          {
            type: 'text',
            text:
              `本地「期刊分区库」里没有收录「${params.journal}」。\n` +
              '如实告诉用户「库里未收录这本刊」，并提示他可以在「期刊分区库」页面手工补录。\n' +
              '**不要**凭印象说一个分区，也不要用你自己的知识补 —— 那正是本系统禁止的"用模型知识冒充查询结果"。',
          },
        ],
        details: { newEvidenceIds: [], evidenceIds: [] },
      };
    },
  };
}
