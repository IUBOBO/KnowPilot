/**
 * 登录失败限流。内存里的滑动窗口，不落库。
 *
 * 【为什么必须存在，而且必须在算哈希之前】一次 scrypt 校验约 50–100ms，
 *   且它跑在 libuv 线程池里 —— 不限流的话，攻击者用几百个并发就能把
 *   线程池占满，此时**所有**请求（包括完全无关的检索）一起变慢。
 *   不限流的登录接口不只是"能被撞库"，它本身就是一个廉价的 CPU DoS 放大器。
 *
 * 【为什么不落库、不跨进程】单进程单实验室的部署，重启即清是可接受的：
 *   这里要挡的是脚本化的持续尝试，而不是需要长期记忆的攻击者状态。
 *   真要多进程部署，需要的是共享存储（Redis 之类）而不是再加一张表 ——
 *   届时把 store 抽出来换掉即可，判定逻辑不变。
 *
 * 【为什么不做"永久锁定账号"】攻击者只要对着某个用户名连续输错，就能
 *   把一个真实用户永久锁在门外（而且他还不知道自己被当成了攻击目标）。
 *   所以只用**短窗口**：挡得住爆破，且最坏情况下受害者等 15 分钟就能进来。
 */
import { AppError } from '@knowpilot/shared';

const WINDOW_MS = 15 * 60_000;

/** 同一 IP 的失败上限。同一个办公室共用出口 IP 时，这个数要有余量。 */
const PER_IP_MAX = 10;
/** 同一 IP 针对同一个用户名的失败上限。正常人手滑不会超过 5 次。 */
const PER_IP_USER_MAX = 5;
/** 全局失败上限。挡的是"换着 IP 撞同一批弱口令"的分布式尝试。 */
const GLOBAL_MAX = 100;

interface Bucket {
  /** 失败时刻（毫秒），升序追加 */
  hits: number[];
}

/**
 * 一个窗口计数器。键是自己拼的字符串，语义由调用方决定。
 *
 * 【为什么存时间戳数组而不是"次数 + 首次时刻"】固定窗口（到点整体清零）
 *   有个经典毛病：在窗口边界两侧各打一轮，短时间内的实际次数是上限的两倍。
 *   滑动窗口没有这个缝，代价只是数组里多几个数字。
 */
class BucketStore {
  private readonly buckets = new Map<string, Bucket>();

  /** 记一次失败。 */
  record(key: string, nowMs: number): void {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) {
      this.buckets.set(key, { hits: [nowMs] });
      return;
    }
    bucket.hits.push(nowMs);
  }

  /**
   * 还在窗口内的失败次数，以及最早那次失败的时刻。
   *
   * 顺手把过期的丢掉 —— 一个键只在有请求打过来时才会被访问，所以清理
   * 放在这里是最自然的：**不需要定时器**，也不会无限增长（长期没人试的
   * 键最终会在下一次访问时把自己清空）。
   *
   * 一并返回最早的那次：限流命中时"还要等多久"就等于"最早那次何时滑出窗口"，
   * 而不是固定值 —— 否则被挡的人会看到剩余时间一直是满的。
   */
  status(key: string, nowMs: number): { count: number; oldestMs: number } {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) return { count: 0, oldestMs: 0 };
    const cutoff = nowMs - WINDOW_MS;
    const fresh = bucket.hits.filter((t) => t > cutoff);
    if (fresh.length === 0) {
      this.buckets.delete(key);
      return { count: 0, oldestMs: 0 };
    }
    bucket.hits = fresh;
    return { count: fresh.length, oldestMs: fresh[0] as number };
  }

  /** 这一轮通过了，把该键的历史清掉。 */
  clear(key: string): void {
    this.buckets.delete(key);
  }
}

export interface RateLimitHit {
  /** 还需要等多少毫秒才能重试 */
  retryAfterMs: number;
  /** 哪一档拦下的，只用于日志（不回给客户端 —— 别告诉攻击者他撞到了哪条线） */
  scope: 'ip' | 'ip+user' | 'global';
}

/**
 * 登录失败的限流器。**每次登录尝试都要调 `check`，失败后调 `recordFailure`。**
 *
 * `nowMs` 由调用方传入（而不是内部 `Date.now()`）：测试里要能把时钟拨快
 * 去验证窗口过期，写死当前时间的话就只能靠 sleep 来测，那种测试既慢又不稳。
 */
export class LoginRateLimiter {
  private readonly ip = new BucketStore();
  private readonly ipUser = new BucketStore();
  private readonly global = new BucketStore();

  /**
   * 现在还能不能试。命中任一条线就抛 `rate_limited`。
   *
   * 【为什么抛 AppError 而不是返回 boolean】调用方拿到 boolean 还得自己
   *   构造错误、还得记得带上 retryAfterMs；漏一处就是一个"看起来成功、
   *   其实什么都没做"的分支。抛出去的路由层由 onError 统一翻成 429。
   */
  check(ip: string, username: string, nowMs: number): void {
    const hit = this.hit(ip, username, nowMs);
    if (hit !== null) {
      throw new AppError('rate_limited', '登录尝试过于频繁，请稍后再试。', {
        httpStatus: 429,
        retryDelayMs: hit.retryAfterMs,
      });
    }
  }

  private hit(ip: string, username: string, nowMs: number): RateLimitHit | null {
    const buckets: Array<[string, BucketStore, number, RateLimitHit['scope']]> = [
      [ip, this.ip, PER_IP_MAX, 'ip'],
      [`${ip}\u0000${username}`, this.ipUser, PER_IP_USER_MAX, 'ip+user'],
      ['*', this.global, GLOBAL_MAX, 'global'],
    ];
    for (const [key, store, max, scope] of buckets) {
      const { count, oldestMs } = store.status(key, nowMs);
      if (count >= max) {
        // 最早那次滑出窗口时就能再试。至少 1 秒，免得回一个"0 秒后重试"
        // 而客户端立刻重试又立刻被挡，看起来像坏了。
        const retryAfterMs = Math.max(oldestMs + WINDOW_MS - nowMs, 1_000);
        return { retryAfterMs, scope };
      }
    }
    return null;
  }

  /**
   * 记一次失败。三档一起记 —— 每一档挡的是不同形态的攻击，
   * 只在命中时才记某一档的话，那档就永远涨不上去。
   */
  recordFailure(ip: string, username: string, nowMs: number): void {
    this.ip.record(ip, nowMs);
    this.ipUser.record(`${ip}\u0000${username}`, nowMs);
    this.global.record('*', nowMs);
  }

  /**
   * 登录成功：清掉这个 IP 与这个用户名的失败记录。
   *
   * 【为什么不清全局】全局那档统计的是"整个服务最近被撞了多少次"，
   *   一个人登录成功并不能说明攻击停了。清了等于给攻击者一个重置按钮：
   *   他自己有个能登进去的账号，就能靠它把全局计数反复归零。
   */
  recordSuccess(ip: string, username: string): void {
    this.ip.clear(ip);
    this.ipUser.clear(`${ip}\u0000${username}`);
  }
}
