/**
 * 路径的解析与校验。**全部集中在这一个文件里** —— 上传（A）与数据集整理（B）
 * 共用同一套判据。
 *
 * 【为什么不让调用方自己 join】这条链路上有一处**用户可控的路径**：
 * 上传时请求体里的 `targetDir` 决定文件往哪写；整理时规则里的 `toDir` /
 * `match` 决定文件往哪移。只要有一处忘了校验，就是一次任意目录写入/移动 ——
 * 而"忘了校验"最常见的形态正是"每个用到它的地方各写一遍判断，其中一处漏了
 * 一个 `..`"。所以这里的规矩是：
 *   1. 校验只在这里做，别处不许自己拼路径；
 *   2. 校验完之后还要再 `isInside` 兜一次 —— 两道判据独立，
 *      字符串判定写错了，路径判定仍然拦得住。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statfsSync } from 'node:fs';
import { dirname, join, parse as parsePath, resolve, sep } from 'node:path';
import { AppError } from '@knowpilot/shared';
import type { AppConfig } from '../config.ts';
import { isInside } from '../paths.ts';

/**
 * 未完成会话的分片暂存目录名。以 `.` 开头：它不是数据，是一个正在拼装中的中间物，
 * 放在数据集根目录下要一眼能和真实数据集区分开。
 */
const INCOMING_DIR = '.incoming';

/**
 * Windows 上不允许出现在文件名里的字符。目标盘在实验室服务器上是 NTFS，
 * 所以按 Windows 的规矩拦，而不是按 Linux。
 *
 * 【为什么要在建会话时就拦，而不是等写盘失败】写盘失败发生在传完之后，
 * 报错是一句 `ENOENT`/`EINVAL` 加一个路径，用户已经白等了半小时。
 * 而名字不合法这件事，在第一秒就能判出来。
 */
const ILLEGAL_IN_NAME = /[<>:"|?*\u0000-\u001f]/u;

/**
 * glob 模式里不允许出现的字符。
 *
 * 与 ILLEGAL_IN_NAME 只差一点：`*` 与 `?` 在这里是**通配符**，必须放行。
 * 其余（`< > : " |` 与控制字符）照旧拦 —— 它们是文件系统层面就不合法的字符，
 * 不会因为出现在一个模式里就变得可以接受。
 */
const ILLEGAL_IN_GLOB = /[<>:"|\u0000-\u001f]/u;

/** Windows 保留的设备名。这些名字建得出文件，但之后各类工具都读不了它。 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu;

/**
 * 校验并归一一个**相对路径**：POSIX 形态，如 `medical/amos22`、`train/images`。
 *
 * 接受 `\` 并统一成 `/`：用户从 Windows 资源管理器复制路径过来是常态，
 * 为此报错只会让他觉得系统莫名其妙。归一之后再逐段校验，安全上不打折。
 *
 * @param what  出错信息里怎么称呼这个字段（"targetDir"、"toDir"…）
 * @param relTo 相对谁的路径，只用于把报错说清楚
 */
export function parseRelPath(raw: unknown, what: string, relTo = '数据根目录'): string {
  if (typeof raw !== 'string') {
    throw new AppError('invalid_argument', `${what} 必须是字符串，如 "medical/amos22"。`);
  }
  const normalized = raw.trim().replace(/\\+/gu, '/');
  if (normalized === '') {
    throw new AppError('invalid_argument', `${what} 不能为空。`);
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
    throw new AppError(
      'invalid_argument',
      `${what} 必须是**相对** ${relTo} 的路径，不能是绝对路径：${raw}。` +
        `绝对路径的参照点不受我们控制，而"相对哪"正是这条链路上唯一要守住的东西。`,
    );
  }

  const segments = normalized.split('/');
  for (const seg of segments) {
    assertSafeSegment(seg, what);
  }
  return segments.join('/');
}

/** 校验并归一 `targetDir`（上传落位用）。行为与改动前一致，只是走了共用的 parseRelPath。 */
export function parseTargetDir(raw: unknown): string {
  return parseRelPath(raw, 'targetDir', `${INCOMING_DIR} 所在数据根目录`);
}

/**
 * 校验并归一一个 glob 模式（整理规则里的 `match`）。
 *
 * 与 `parseRelPath` 同一条思路，只有一处不同：**`*` 与 `?` 是合法字符**。
 * 所以不能复用 assertSafeSegment —— 它按"文件名"的规矩拦这两个字符。
 * 这里单独写一遍逐段校验，把两个字符放行、其余规则（空段/`.`/`..`/绝对路径/
 * 控制字符）照旧，理由是"路径穿越的写法"和"文件名非法字符"两件事都不因
 * 它是个模式而改变。
 */
export function parseGlobPattern(raw: unknown, what: string): string {
  if (typeof raw !== 'string') {
    throw new AppError('invalid_argument', `${what} 必须是字符串（glob 模式）。`);
  }
  const normalized = raw.trim().replace(/\\+/gu, '/');
  if (normalized === '') {
    throw new AppError('invalid_argument', `${what} 不能为空。`);
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
    throw new AppError(
      'invalid_argument',
      `${what} 必须是**相对数据集根**的 glob，不能是绝对路径：${raw}`,
    );
  }

  for (const seg of normalized.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new AppError(
        'invalid_argument',
        `${what} 里有不合法的路径段 "${seg}"。空段、"." 与 ".." 都不允许 —— 它们是路径穿越的写法。`,
      );
    }
    if (ILLEGAL_IN_GLOB.test(seg)) {
      throw new AppError(
        'invalid_argument',
        `${what} 里的 "${seg}" 含有不合法字符。不能含 < > : " | 与控制字符。`,
      );
    }
    // 不含通配符的段按文件名规矩再查一遍保留名；含 `*`/`?` 的段不查 ——
    // 那种模式匹配到的通常是别的东西，不是真去建一个叫 con 的文件。
    if (!/[*?]/u.test(seg) && RESERVED_NAMES.test(seg)) {
      throw new AppError(
        'invalid_argument',
        `${what} 里的 "${seg}" 是 Windows 保留设备名。`,
      );
    }
    if (/[. ]$/u.test(seg) && !seg.endsWith('*') && !seg.endsWith('?')) {
      throw new AppError(
        'invalid_argument',
        `${what} 里的 "${seg}" 以点或空格结尾。Windows 会把它们悄悄去掉，` +
          `导致写进去的名字和读出来的不一样。`,
      );
    }
  }
  return normalized;
}

/** 校验文件名：必须是纯文件名，不含任何路径成分。 */
export function parseFileName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new AppError('invalid_argument', 'fileName 必须是字符串。');
  }
  const name = raw.trim();
  if (name === '') {
    throw new AppError('invalid_argument', 'fileName 不能为空。');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new AppError(
      'invalid_argument',
      `fileName 只能是文件名，不能带路径分隔符：${name}。目录请写在 targetDir 里。`,
    );
  }
  assertSafeSegment(name, 'fileName');
  return name;
}

function assertSafeSegment(seg: string, field: string): void {
  if (seg === '' || seg === '.' || seg === '..') {
    throw new AppError(
      'invalid_argument',
      `${field} 里有不合法的路径段 "${seg}"。空段、"." 与 ".." 都不允许 —— 它们是路径穿越的写法。`,
    );
  }
  if (ILLEGAL_IN_NAME.test(seg) || RESERVED_NAMES.test(seg)) {
    throw new AppError(
      'invalid_argument',
      `${field} 里有不合法或保留的名字 "${seg}"。不能含 < > : " | ? * 与控制字符，` +
        `也不能是 con/prn/aux/nul/com1-9/lpt1-9。`,
    );
  }
  // 结尾的点与空格在 Windows 上会被静默吃掉：写进去叫 "a." 读出来叫 "a"，
  // 于是"传上去了"和"找不到"同时成立。
  if (/[. ]$/u.test(seg)) {
    throw new AppError(
      'invalid_argument',
      `${field} 里的 "${seg}" 以点或空格结尾。Windows 会把它们悄悄去掉，` +
        `导致写进去的名字和读出来的不一样。`,
    );
  }
}

/**
 * 派生会话 id：sha256(目标目录 + 文件名 + 总字节 + 最后修改时间)。
 *
 * 【为什么是派生键而不是随机 UUID】见 shared/uploads.ts 顶部：同一个文件
 * 重传要拿到同一个 id，续传才不需要第二个接口，也不会把两份文件拼成一份。
 * 用 `\0` 分隔而不是 `+`：文件名里完全可以含 `+`，用 `+` 拼会出现
 * "两份不同的文件算出同一个键"——而这件事没有任何症状，只会静默拼错。
 */
export function sessionKey(input: {
  targetDir: string;
  fileName: string;
  totalBytes: number;
  lastModifiedMs: number;
}): string {
  return createHash('sha256')
    .update(
      [input.targetDir, input.fileName, String(input.totalBytes), String(input.lastModifiedMs)].join(
        '\0',
      ),
    )
    .digest('hex');
}

/** 目标目录的绝对路径。调用前 `targetDir` 必须已过 parseTargetDir。 */
export function resolveTargetDir(cfg: AppConfig, targetDir: string): string {
  const abs = resolve(cfg.dataRoot, targetDir);
  assertInsideDataRoot(cfg, abs, 'targetDir');
  return abs;
}

/** 最终文件的绝对路径（相对 DATA_ROOT）。 */
export function resolveStoredFile(cfg: AppConfig, storedPath: string): string {
  const abs = resolve(cfg.dataRoot, storedPath);
  assertInsideDataRoot(cfg, abs, 'storedPath');
  return abs;
}

/**
 * 兜底判据：路径必须落在 `root` 内。**这是"只在数据集自己的目录内"这条
 * 硬边界的唯一判据**（整理模块直接用它，`root` 就是该数据集的目录）。
 *
 * 前面每个路径段都逐段校验过了，这里是**第二道独立判据** ——
 * 它不依赖字符串层面的规则写对，只问"算出来的绝对路径到底在不在里面"。
 * 两道都过的成本是三行代码，而它们拦的正是最坏的那种错误。
 */
export function assertInsideDir(
  root: string,
  abs: string,
  what: string,
  rootLabel = '数据集目录',
): void {
  if (!isInside(root, abs)) {
    throw new AppError('invalid_argument', `${what} 解析后越出了${rootLabel}，已拒绝：${abs}`);
  }
}

/** `assertInsideDir` 针对 DATA_ROOT 的用法（上传链路上用）。 */
export function assertInsideDataRoot(cfg: AppConfig, abs: string, what: string): void {
  assertInsideDir(cfg.dataRoot, abs, what, '数据集根目录');
}

/**
 * 分片暂存目录：`DATA_ROOT/.incoming/<id>`。
 *
 * 【为什么不放进系统临时目录】暂存的分片可能有几十 GB，而且它和最终文件
 * 必须**在同一个文件系统上** —— complete 那一步靠 `rename` 落位，跨文件系统
 * 的 rename 会失败（要退化成"复制一大份再删"，等于把一次写入变两次）。
 */
export function incomingDir(cfg: AppConfig, id: string): string {
  // 这里再判一次 id 的形状：id 是我们自己算的 sha256，正常一定是 64 位十六进制，
  // 但它也是从 URL 参数进来的。用 `..` 当 id 就能让暂存目录跑到数据根目录外面去。
  if (!/^[0-9a-f]{64}$/u.test(id)) {
    throw new AppError('not_found', '上传会话 id 形状不对。');
  }
  return join(cfg.dataRoot, INCOMING_DIR, id);
}

/** 第 index 片分片的落盘路径。 */
export function chunkPath(dir: string, index: number): string {
  return join(dir, `${String(index).padStart(6, '0')}.part`);
}

/** 拼装时的中间文件。落位用一个 rename 完成，见 store.ts 的 assemble。 */
export function assemblingPath(dir: string): string {
  return join(dir, 'assembling.bin');
}

/**
 * 查某个目录所在磁盘的可用字节数。
 *
 * 【为什么必须先查】数据集是几十上百 GB，而实验室服务器上 `/hdd2` 已经
 * 98% 满（只剩几十 G）。不查的话，用户传了四十分钟、在 95% 处收到一句
 * "写入失败"，还得自己去找哪儿满了 —— 而这件事在第一秒就有确定答案。
 *
 * 目录可能还不存在（目标目录通常是新建的），所以往上找到第一个存在的祖先：
 * `statfs` 问的是"这个路径所在的文件系统"，不存在的路径问不了。
 */
export function freeBytes(dir: string): number {
  let probe = resolve(dir);
  for (;;) {
    if (existsSync(probe)) break;
    const parent = dirname(probe);
    if (parent === probe) break; // 到根了还不存在，交给 statfs 抛
    probe = parent;
  }
  const st = statfsSync(probe);
  return Number(st.bavail) * Number(st.bsize);
}

/**
 * 空间够不够。留 5% 余量，不是把 totalBytes 卡着边界比。
 *
 * 比 totalBytes 多出来的那部分不是"再多一点"：数据集落位之后紧接着
 * 会有切块/解压/训练产物写进同一个盘，把盘填到 100% 会让**整台机器**
 * 上别的东西一起开始报错，而那时候已经很难追到是我们传的这一个大文件。
 */
export function assertEnoughSpace(dir: string, needBytes: number): void {
  const free = freeBytes(dir);
  const required = Math.ceil(needBytes * 1.05);
  if (free < required) {
    throw new AppError(
      'insufficient_storage',
      `空间不够：这个文件 ${gb(needBytes)}，所在磁盘只剩 ${gb(free)}（需要留 5% 余量）。` +
        `请先清理该磁盘，或把 DATA_ROOT 指到别的盘。`,
    );
  }
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** 目标文件已存在时的名字，如 `data.tar.gz` → `data.tar (1).gz`。 */
export function dedupeName(fileName: string, taken: (name: string) => boolean): string {
  if (!taken(fileName)) return fileName;
  const { name, ext } = parsePath(fileName);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${name} (${i})${ext}`;
    if (!taken(candidate)) return candidate;
  }
  // 一千个同名文件还撞，说明这不是命名问题而是别的地方出了错。
  // 用随机后缀收尾而不是报错：宁可给一个丑名字，也别让用户传完的东西落地失败。
  return `${name} (${randomUUID().slice(0, 8)})${ext}`;
}

/**
 * 绝对路径相对 `root` 的 POSIX 形态（存库/展示用），跨平台一致。
 *
 * 调用前 `abs` 必须已经过 `assertInsideDir(root, …)` —— 这里只是把前缀切掉，
 * 不负责判断到底在不在里面（切成 `..` 开头会静默产出一个看着像合法相对路径
 * 的字符串，那正是最不该发生的）。
 */
export function relPosix(root: string, abs: string): string {
  const rel = resolve(abs).slice(resolve(root).length);
  return rel.split(sep).join('/').replace(/^\/+/u, '');
}

/** 落盘路径相对 DATA_ROOT 的 POSIX 形态（上传链路上用）。 */
export function toPosixRelative(cfg: AppConfig, abs: string): string {
  return relPosix(cfg.dataRoot, abs);
}
