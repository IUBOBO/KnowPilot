import type { TaskRoute } from './task-router.ts';

/** A conservative first-question shortcut. Live records and ambiguous follow-ups keep the Agent route. */
export function shouldPrefetchDocuments(question: string, route: TaskRoute, hasHistory: boolean, isResume: boolean): boolean {
  const q = question.trim();
  if (route !== 'simple' || hasHistory || isResume || q.length < 5 || q.length > 200) return false;
  if (/(投稿|投过|投了|稿件|台账|分区|JCR|中科院|数据集|路径|人员|学号|专利|大论文|预算|用量|现在|目前|当前|最新|其他|其它|另一个|它的|这个|那个|这些|那些)/iu.test(q)) return false;
  return /(毕业|学位|开题|中期|答辩|查重|论文|文档|资料|规程|规范|制度|方法|模型|算法|检测|分割|摘要|引言|Introduction|DeepLab|ResNet|YOLO)/iu.test(q);
}
