/**
 * 知识条目的展示约定：批次分组 + 状态配色。
 *
 * 【为什么提出来单独放】「知识沉淀」与「知识审核」要显示同一批条目，
 *   分组规则和配色必须一致 —— 同一条知识在两个页面上被涂成两种颜色、
 *   或者一批被切成两种分法，看的人只会觉得"这两个页面数据对不上"。
 *   这与 outcome.ts 被提出来是同一条理由。
 */
import type { KnowledgeEntry, KnowledgeStatus } from '@knowpilot/shared';

/**
 * 按批次分组，**保持服务端给的顺序**。
 *
 * 【为什么不排序】服务端按 `observed_at DESC` 返回，而同一批那几条的时间戳
 *   完全相同 —— 也就是说组内本来就没有有意义的顺序（库里没有 ordinal 列，
 *   模型输出的原始次序没有被保存）。所以"第一次遇到某个 groupId 的位置"
 *   就是这一批的位置，组内照抄列表顺序。前端一重排，同一批在今天刷新和
 *   明天刷新时就会长得不一样。
 */
export function groupByBatch(
  items: readonly KnowledgeEntry[],
): readonly { groupId: string; entries: KnowledgeEntry[] }[] {
  const order: string[] = [];
  const byGroup = new Map<string, KnowledgeEntry[]>();
  for (const entry of items) {
    const bucket = byGroup.get(entry.groupId);
    if (bucket === undefined) {
      byGroup.set(entry.groupId, [entry]);
      order.push(entry.groupId);
    } else {
      bucket.push(entry);
    }
  }
  return order.map((groupId) => ({ groupId, entries: byGroup.get(groupId) ?? [] }));
}

/**
 * 状态对应的 pill 配色。
 *
 * **不给「待确认」上警告色**：排队等确认是正常流程，涂成黄色会让整个列表
 *   一直在报警 —— 而一直在报警的东西没人看。只有"被卡住"（冲突待裁决）
 *   与"被驳回"才值得用语义色；「已生效」是唯一的完成态。
 *   「已被取代」也不上红：它是一次正常裁决的结果，不是失败。
 *   「已撤回」同理 —— 它是作者主动收回去的，不是出错。
 */
export function knowledgeStatusTone(status: KnowledgeStatus): string {
  if (status === 'active') return 'ok';
  if (status === 'conflicted') return 'warn';
  if (status === 'deleted') return 'err';
  return '';
}
