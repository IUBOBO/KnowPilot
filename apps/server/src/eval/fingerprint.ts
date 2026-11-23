/**
 * 运行指纹：把"这一轮结果是在什么环境下、跑哪一版源码、用哪个模型"记下来。
 *
 * 【为什么评测报告必须有指纹】
 *   03 号 §4 的"可比条件"要的是：同用例集版本 + 同数据快照 + 同环境。
 *   语料快照（`dataSnapshot`）只覆盖了其中一项。剩下两项 —— 源码版本与运行环境 ——
 *   不记下来的话，两份报告的数字不一样时，读的人无法判断是"改动生效了"
 *   还是"换了机器 / 换了模型 / 换了 node"。而这类差异**不会让任何断言变红**，
 *   它只是让结论悄悄失去意义。
 *
 * 【为什么是"源码树内容哈希"而不是 git commit SHA】
 *   本仓库**没有版本控制**（根目录无 `.git`，`git rev-parse` 直接报
 *   "not a git repository"）。00 号总计划要求记"源码 SHA"，那在本项目里落不了地。
 *   退而求其次：对 `apps/server/src/**` 与 `packages/shared/src/**` 的**文件内容**
 *   逐个取 sha256 再汇总。它同样满足"源码一改指纹就变"，只是**不表达历史**
 *   （改回来指纹就回去了）。这一点在报告里如实写明，不含糊成"commit"。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 参与源码指纹的目录（相对仓库根）。只收这两个 —— 它们就是评测判定的全部依据。 */
const FINGERPRINT_DIRS = ['apps/server/src', 'packages/shared/src'] as const;

export interface EnvFingerprint {
  node: string;
  platform: string;
  arch: string;
  /** 生效的模型名与接口地址来源（不记 key，**也不记 key 是否存在**以外的任何东西） */
  modelChat: string;
  modelReasoner: string;
  baseUrlSource: string;
  /**
   * 本轮实际生效的实验开关。没有这两个字段时，同样是"源码相同、快照相同"的
   * 两份报告，只能靠文件名或命令历史区分是 A 组还是 B 组 —— 那不算可复现。
   */
  rewriteEnabled: boolean;
  rerankEnabled: boolean;
  /**
   * 本轮实际用到的 system prompt 哈希。取自**第一条 Trace**（没跑实机时为 null）。
   *
   * 【为什么不在这里现拼一次 prompt 求哈希】prompt 里注入了"今天几号"，
   *   现拼会让指纹**每天都变**，而"今天几号"本来就不是需要追踪的变量。
   *   Trace 里那个哈希是真实用过的那一份，更准也更省。
   */
  promptHash: string | null;
  dataSnapshot: string;
  sourceFingerprint: string;
  /** 参与指纹的文件数。用来区分"源一样"与"压根没扫到文件"（后者会是个空哈希）。 */
  sourceFiles: number;
  /** 版本控制状态。本项目恒为 "none"，如实写出来。 */
  vcs: string;
  startedAt: string;
}

/**
 * 对指定目录树的内容取指纹：按相对路径排序后，把 `相对路径 \0 内容` 逐条喂进 sha256。
 *
 * 【为什么路径要排序】`readdirSync` 的顺序依赖文件系统，同一份代码在两次运行里
 *   可能给出不同顺序 → 哈希不同 → 指纹说了谎。排序把它变成确定的。
 * 【为什么路径也要进哈希】否则"两份文件互换内容"这种改动算不出差异。
 */
export function sourceFingerprint(repoRoot: string): { hash: string; files: number } {
  const entries: string[] = [];
  for (const dir of FINGERPRINT_DIRS) {
    collectFiles(join(repoRoot, dir), entries);
  }
  entries.sort();
  const hash = createHash('sha256');
  for (const abs of entries) {
    hash.update(relative(repoRoot, abs).split(sep).join('/'), 'utf8');
    hash.update('\u0000', 'utf8');
    hash.update(readFileSync(abs));
    hash.update('\u0000', 'utf8');
  }
  return { hash: hash.digest('hex').slice(0, 16), files: entries.length };
}

/** 递归收集文件（跳过目录）。不用 `readdirSync` 的 recursive 选项：它的返回形状
 *  跨 node 版本变过（`path` → `parentPath`），而这里只要一份绝对路径清单。 */
function collectFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
}

export interface FingerprintInput {
  repoRoot: string;
  modelChat: string;
  modelReasoner: string;
  baseUrlSource: string;
  rewriteEnabled: boolean;
  rerankEnabled: boolean;
  dataSnapshot: string;
  promptHash: string | null;
  startedAt: string;
}

export function buildEnvFingerprint(input: FingerprintInput): EnvFingerprint {
  const src = sourceFingerprint(input.repoRoot);
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    modelChat: input.modelChat,
    modelReasoner: input.modelReasoner,
    baseUrlSource: input.baseUrlSource,
    rewriteEnabled: input.rewriteEnabled,
    rerankEnabled: input.rerankEnabled,
    promptHash: input.promptHash,
    dataSnapshot: input.dataSnapshot,
    sourceFingerprint: src.hash,
    sourceFiles: src.files,
    vcs: existsSync(join(input.repoRoot, '.git')) ? 'git' : 'none（本仓库无版本控制，指纹取源码树内容哈希）',
    startedAt: input.startedAt,
  };
}
