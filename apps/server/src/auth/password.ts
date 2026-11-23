/**
 * 口令哈希。用 Node 内置的 scrypt，不引入任何依赖。
 *
 * 【为什么是 scrypt 而不是 bcrypt / argon2】
 *   bcrypt 与 argon2 都要原生编译（node-gyp / 预编译二进制），而这台机器的
 *   部署原则里已经有一条"能免原生编译就免"（数据库选 node:sqlite 也是这个
 *   理由）。scrypt 是标准库里就有的、内存硬的 KDF，对"人选的口令"这种
 *   低熵输入完全够用。
 *
 * 【为什么用 async 版本，而不是 scryptSync】
 *   scrypt 按设计就是慢的（这正是它防穷举的方式），一次约 50–100ms。
 *   同步版本会**阻塞事件循环**这么久 —— 登录高峰期表现为所有人的请求
 *   一起卡顿，包括那些根本没在登录的人。用回调版包成 Promise，
 *   让这段时间落在 libuv 线程池里。
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * 自己包一层，而不是 `promisify(scrypt)`。
 *
 * 【为什么】`scrypt` 有两个重载（带 options 与不带），而 `promisify` 只会
 *   保留**最后一个**（三参数版本）。我们要的恰恰是带 options 的那个 ——
 *   N / r / p 是这套哈希的安全参数，必须能指定；用被 promisify 后的三参数
 *   版本传第四个参数会被类型系统拦下（而绕过它就是在静默使用默认参数，
 *   等于安全参数不由我们决定）。显式包一层，签名是什么就是什么。
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err !== null) reject(err);
      else resolve(derived);
    });
  });
}

/** 参数写进哈希串里（见下方格式），所以将来调参不影响校验旧口令。 */
const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 64;
const SALT_LEN = 16;

const PREFIX = 'scrypt';

/**
 * 编码成自描述的一行：`scrypt$N$r$p$<saltB64>$<hashB64>`。
 *
 * 【为什么要自描述】参数是安全边界的一部分，将来很可能要调高（机器变快、
 *   或某次审计要求）。如果把参数写死在代码里，那么调参的那一刻，库里
 *   所有旧口令都再也校验不过 —— 而症状是"所有人的密码突然都不对了"，
 *   且完全没有线索指向"我们改了个常数"。把参数带上，旧口令照旧能验，
 *   新口令用新参数，可以慢慢自然过渡。
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const derived = await scryptAsync(plain, salt, KEY_LEN, PARAMS);
  return [
    PREFIX,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * 定长比较。**必须先比长度**：`timingSafeEqual` 在两个 Buffer 长度不同时
 * 直接抛异常（不是返回 false），把它当成布尔函数用的人会在"攻击者传个
 * 短字符串"时得到一个 500，而不是一个"密码错"。
 */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 校验口令。任何解析不出来的存储值一律返回 false（当作"这个口令不可能对"），
 * 不抛异常 —— 校验函数抛异常会让调用方多一条必须处理的失败路径，
 * 而它唯一的正确反应本来就是"不放行"。
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6) return false;

  const [prefix, rawN, rawR, rawP, saltB64, hashB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (prefix !== PREFIX) return false;

  const N = Number.parseInt(rawN, 10);
  const r = Number.parseInt(rawR, 10);
  const p = Number.parseInt(rawP, 10);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scryptAsync(plain, salt, expected.length, { N, r, p });
  } catch {
    // 参数被改坏（比如 N 不是 2 的幂）时 scrypt 会抛。当作校验失败处理。
    return false;
  }
  return safeEqual(derived, expected);
}

/**
 * 用户名不存在时用来顶替真实哈希的"假"哈希。
 *
 * 【为什么需要它】若"用户不存在"就直接 return false，那条路径比"算一次
 *   scrypt 再比对"快两个数量级。攻击者拿一个不存在的用户名反复试，
 *   靠响应时间就能把"这个用户名存不存在"测出来（用户名枚举），
 *   然后再针对存在的那些撞密码。
 *
 *   在启动时算一次固定值：所有"用户不存在"的请求都跑到这里，
 *   与真实校验耗时相当。
 *
 *   注意它本身**不校验任何东西**，只是"用来被比较"的占位；
 *   调用方拿到 false 之后的文案必须与"密码错"完全一致。
 */
let dummyHash: string | null = null;

export async function getDummyHash(): Promise<string> {
  dummyHash ??= await hashPassword(randomBytes(32).toString('base64'));
  return dummyHash;
}
