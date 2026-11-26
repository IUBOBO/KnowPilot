import type { Answer } from '@knowpilot/shared';

export function answerNoteSections(answer: Answer) {
  return [
    { title: '还缺哪些信息', items: answer.evidenceGaps },
    { title: '本次回答的边界', items: answer.limits },
    { title: '需要注意的地方', items: answer.confidenceNotes },
    { title: '资料之间互相矛盾之处', items: answer.conflicts },
  ].filter(({ items }) => items.length > 0);
}
