/**
 * 巡检的定时调度器。"定时 Workflow"里的那个定时（02 号 §2.1 的 T3）。
 *
 * 【为什么是进程内定时器，而不是 cron / 任务队列】
 *   这是单机部署。装一个 cron、或引入一个队列，代价是运维多一个要配、
 *   要监控、要在换机器时重新交代的东西 —— 而它换来的能力（分布式调度、
 *   任务持久化）在这里一条都用不上。进程内 `setInterval` 就是这台机器的
 *   全部需求。
 */
import type { Db } from '../db/index.ts';
import { reconcile } from './scan.ts';

/**
 * 启动巡检调度。返回一个 stop 函数，供优雅退出时调用。
 *
 * 【启动立刻跑一次，之后每 intervalHours 小时一次】不延后第一次：
 *   巡检是纯 SQLite 比较，零模型开销、毫秒级，没必要"错开启动高峰"。
 *   而"服务刚起来时台账里已经有超期投稿"是常态（比如机器重启过），
 *   等到下一个整点才处理会让用户以为巡检没生效。
 *
 * 【`.unref()` 是硬要求】不加它，这个 interval 会把 Node 的事件循环**钉住** ——
 *   `server.close()` 之后进程仍然不退出，`npm run dev` 里的 Ctrl-C 也杀不干净。
 *   加了之后，进程的生命周期由 HTTP server 决定，定时器只是搭便车的。
 *
 * 【失败只记日志，绝不拖垮服务】巡检出错没有任何理由让问答、检索不可用。
 *   记下错误、等下一轮 —— 而 `reconcile` 是幂等的，重跑一次不会翻倍。
 */
export function startPatrolScheduler(db: Db, intervalHours: number): () => void {
  const runOnce = (reason: string): void => {
    try {
      const summary = reconcile(db, new Date());
      if (summary.created > 0 || summary.resolved > 0) {
        console.log(
          `[巡检] ${reason}：新建 ${summary.created} 条待办，消解 ${summary.resolved} 条，当前待处理 ${summary.stillOpen} 条。`,
        );
      }
    } catch (err) {
      console.error(`[巡检] ${reason}失败（不影响其它功能，等下一轮）：`, err);
    }
  };

  runOnce('启动时巡检');
  console.log(`[巡检] 定时巡检已启动：每 ${intervalHours} 小时一次。`);

  const timer = setInterval(() => runOnce('定时巡检'), intervalHours * 60 * 60 * 1000);
  timer.unref();

  return () => clearInterval(timer);
}
