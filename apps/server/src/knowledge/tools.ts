/**
 * 给知识沉淀 Agent 的工具。
 *
 * 【为什么只有这一个工具、而且只往内存里送数据】与 organize/tools.ts 同一条结构
 *   决定：Agent 能不能"自己把知识写进库"，不取决于提示词里说多少遍"不要"，而
 *   取决于**它手里根本没有那把枪**。这里没有写库、没有建文档、没有建索引 ——
 *   它唯一能做的是把一组草案交到一个内存回调里。真正的落库与入库是用户在界面上
 *   单独点的 HTTP 请求（见 app.ts 的 drafts / confirm 两个 handler）。
 */
import { StringEnum, Type, type Static } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { KNOWLEDGE_KINDS, type KnowledgeKind } from '@knowpilot/shared';

export const KNOWLEDGE_SUBMIT_ENTRIES = 'submit_entries';

/**
 * 结构化输出走工具，而不是让模型在回复正文里写 JSON 再由我们解析。
 *
 * 【为什么这条尤其重要】解析自由文本 JSON 会有一堆失败模式：模型加了注释、
 *   用了代码块、漏了个逗号 —— 每一种都要写一段容错，而且容错本身可能把
 *   "半条被截断的知识"当成完整的收下来。工具的 schema 由 `StringEnum` /
 *   `Type.String` 在**模型侧**校验，字段不合规的根本进不来，所以
 *   `kind` 一定在词表里、`content` 一定是非空字符串 —— 这些是结构保证，
 *   不是"我们期望模型会遵守"。
 */
const SubmitEntriesParams = Type.Object({
  entries: Type.Array(
    Type.Object({
      kind: StringEnum(KNOWLEDGE_KINDS, {
        description:
          '这条知识的类型：fact=事实，decision=决定，lesson=教训，open_loop=未决事项。',
      }),
      claim: Type.Optional(StringEnum(['experience', 'literature', 'inference'])),
      evidence: Type.Optional(Type.String()),
      question: Type.Optional(Type.String()),
      conclusion: Type.Optional(Type.String()),
      conditions: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      content: Type.String({
        description:
          '这条知识的中文正文，一条只讲一件事，用完整陈述句、把主语写清楚。不要写标题或序号。',
      }),
    }),
    {
      description:
        '整理出的知识条目清单。一个意思一条，宁可少拆不要拆碎；没有可沉淀的内容就传空数组。',
    },
  ),
});

export type SubmitEntriesArgs = Static<typeof SubmitEntriesParams>;

/** 一条待落库的草案（工具产出、落库前）。 */
export interface DraftInput {
  kind: KnowledgeKind;
  content: string;
  claim?: string;
  evidence?: string;
  question?: string;
  conclusion?: string;
  conditions?: string;
  tags?: readonly string[];
}

/**
 * 提交条目。
 *
 * 【注意它只往一个内存回调里送数据】不落库、不建文档 —— 与 organize 的
 *   submit_plan 完全同构。`terminate: true` 让 Agent 循环在这里干净收尾，
 *   不必猜"它说完了没有"。
 */
export function createSubmitEntriesTool(
  sink: (drafts: readonly DraftInput[]) => void,
): AgentTool<typeof SubmitEntriesParams, { entryCount: number }> {
  return {
    name: KNOWLEDGE_SUBMIT_ENTRIES,
    label: '提交知识草案',
    description:
      '把整理好的知识条目提交上去。每条含一个 kind 与一段 content。' +
      '调用它就代表这轮结束，不要再在回复正文里重复条目。',
    parameters: SubmitEntriesParams,
    execute: async (_id, params): Promise<AgentToolResult<{ entryCount: number }>> => {
      // content 去空白后为空的条目直接丢弃：模型偶尔会把占位空串塞进来，
      // 与其落一条空知识，不如少一条。
      const drafts: DraftInput[] = params.entries
        .map((entry) => ({ ...entry, content: entry.content.trim() }))
        .filter((e) => e.content !== '');
      sink(drafts);
      return {
        content: [{ type: 'text', text: `已收到 ${drafts.length} 条知识草案。` }],
        details: { entryCount: drafts.length },
        terminate: true,
      };
    },
  };
}
