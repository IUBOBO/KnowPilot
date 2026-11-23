import { patrolOverdueLabel, type PatrolTask } from '@knowpilot/shared';

/** 超期药丸：待处理为红色，已忽略为中性。首页和台账共用。 */
export function OverduePill({ task }: { task: PatrolTask }) {
  return (
    <span className={`pill ${task.status === 'open' ? 'err' : ''}`} style={{ marginLeft: 0 }}>
      {task.status === 'open' ? patrolOverdueLabel(task.overdueDays) : '已忽略超期'}
    </span>
  );
}
