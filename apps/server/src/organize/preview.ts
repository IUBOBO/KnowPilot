/**
 * 规则展开与预览。**这是整个 B 模块里唯一决定"到底会动哪些文件"的地方** ——
 * 预览用它算数字给用户看，执行也用它算清单去动手。两边共用同一个函数，
 * 是"预览即所见"能成立的前提：如果执行自己再算一遍，两处实现早晚会分叉，
 * 而分叉的表现是"用户确认的是 A，实际动的是 B"，且没有任何迹象。
 */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  AppError,
  matchesGlob,
  type OrganizePlan,
  type OrganizePreview,
  type OrganizeRule,
  type OrganizeRulePreview,
} from '@knowpilot/shared';
import { assertInsideDir, parseGlobPattern, parseRelPath } from '../uploads/layout.ts';
import { ORGANIZE_SCAN_MAX_ENTRIES, scanFiles, type ScannedFile } from './scan.ts';

/** 每条规则在预览里展示几个样例。够人核对"它挑对了没有"，又不至于刷屏。 */
const SAMPLE_LIMIT = 10;

export interface PlannedMove {
  ruleIndex: number;
  fromRel: string;
  toRel: string;
}

export interface ExpandedPlan {
  preview: OrganizePreview;
  /** 依序要移动的文件。**执行端只认这个清单**，不自己重新匹配。 */
  moves: readonly PlannedMove[];
  /** 需要新建的目录（相对根路径），去重且按字典序。 */
  mkdirs: readonly string[];
}

/**
 * 一条规则的归一形态：glob 与目标目录都已通过校验。
 *
 * `problem` 与 `parsed` 至少有一个非空 —— 要么可用，要么说清楚为什么不可用。
 */
interface NormalizedRule {
  index: number;
  raw: OrganizeRule;
  match: string | null;
  toDir: string | null;
  problem: string | null;
}

function normalizeRule(root: string, rule: OrganizeRule, index: number): NormalizedRule {
  const what = `第 ${index + 1} 条规则`;
  try {
    if (typeof rule.match !== 'string' || typeof rule.toDir !== 'string') {
      throw new AppError('invalid_argument', `${what} 的 match 与 toDir 都必须是字符串。`);
    }
    const match = parseGlobPattern(rule.match, `${what}的 match`);
    const toDir = parseRelPath(rule.toDir, `${what}的 toDir`, '数据集根');
    // 目标目录也要过一遍绝对路径判据。字符串层面 parseRelPath 已经拦了
    // 绝对路径与 `..`，这里是那道**独立**的兜底 —— 见 layout.ts 顶部。
    assertInsideDir(root, join(root, toDir), what);
    return { index, raw: rule, match, toDir, problem: null };
  } catch (err) {
    return {
      index,
      raw: rule,
      match: null,
      toDir: null,
      problem: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 一个相对路径是否落在某个目录（或目录子树）内。 */
function underDir(relPath: string, dirRel: string): boolean {
  return relPath === dirRel || relPath.startsWith(`${dirRel}/`);
}

/**
 * 把一份计划展开成可预览、可执行的清单。
 *
 * 【为什么要先排除落在目标目录子树内的候选】一个很自然的规则是
 * `**​/*.png → images`。第一次跑没问题；但**第二次**跑时，`images/` 下那些
 * 已经移好的 png 又会被 `**​/*.png` 匹配到，于是"从 images/x.png 移到
 * images/x.png"—— 规则自己咬自己。排除"已经在任何目标目录下"的候选，
 * 让规则天然是幂等的：再跑一遍不动的还是不动。
 *
 * 【为什么一个文件只会被记一次】两条规则若都匹配同一个文件（`**​/*.png` 与
 * `**​/a*.png`），它也只能被移动一次。按顺序先到先得，并给出重合警告 ——
 * 不去猜用户的意图，但要让"这里有两个规则在抢同一个文件"这件事看得见。
 */
export function expandRules(root: string, plan: OrganizePlan): ExpandedPlan {
  const { files, truncated, unreadable } = scanFiles(root);

  const normalized = plan.rules.map((rule, i) => normalizeRule(root, rule, i));

  // 目标子树：来自**所有**校验通过的规则。用它做全局排除。
  const targetDirs = [
    ...new Set(normalized.filter((r) => r.toDir !== null).map((r) => r.toDir as string)),
  ];

  function inAnyTargetDir(relPath: string): boolean {
    return targetDirs.some((dir) => underDir(relPath, dir));
  }

  const candidates: ScannedFile[] = files.filter((f) => !inAnyTargetDir(f.relPath));

  // 每条规则各自命中哪些候选（未去重）。
  const perRuleHits = normalized.map((rule) => {
    if (rule.match === null) return [] as string[];
    return candidates.filter((f) => matchesGlob(f.relPath, rule.match as string)).map((f) => f.relPath);
  });

  // 先到先得：一个文件只归第一条匹配到它的规则。
  const claimed = new Set<string>();
  const moves: PlannedMove[] = [];
  const mkdirSet = new Set<string>();
  const rulePreviews: OrganizeRulePreview[] = [];
  let overlap = 0;

  for (const rule of normalized) {
    if (rule.match === null || rule.toDir === null) {
      rulePreviews.push({
        match: rule.raw.match,
        toDir: rule.raw.toDir,
        matched: 0,
        sample: [],
        ...(rule.problem !== null ? { problem: rule.problem } : {}),
      });
      continue;
    }
    const hits = perRuleHits[rule.index] ?? [];
    const actual = hits.filter((p) => !claimed.has(p));
    overlap += hits.length - actual.length;
    for (const p of actual) {
      claimed.add(p);
      const toRel = `${rule.toDir}/${basename(p)}`;
      moves.push({ ruleIndex: rule.index, fromRel: p, toRel });
      mkdirSet.add(rule.toDir);
    }
    rulePreviews.push({
      match: rule.match,
      toDir: rule.toDir,
      matched: actual.length,
      sample: actual.slice(0, SAMPLE_LIMIT),
    });
  }

  const warnings: string[] = [];

  for (const rp of rulePreviews) {
    if (rp.problem === undefined && rp.matched === 0) {
      warnings.push(`规则「${rp.match}」没有匹配到任何文件，执行时它不会做任何事。`);
    }
  }
  if (overlap > 0) {
    warnings.push(
      `有 ${overlap} 个文件同时被多条规则匹配到。已按规则顺序归给靠前的那一条，` +
        `不会重复移动 —— 但你可能想把规则写得更明确一些。`,
    );
  }

  // 目标目录里会撞名的文件：执行时会自动改名（绝不覆盖），这里提前说一声。
  const byTarget = new Map<string, number>();
  for (const m of moves) byTarget.set(m.toRel, (byTarget.get(m.toRel) ?? 0) + 1);
  const collisions = [...byTarget.values()].filter((n) => n > 1).reduce((a, b) => a + b, 0);
  if (collisions > 0) {
    warnings.push(
      `有 ${collisions} 个文件在整理后会与同目录下另一个文件**同名**。` +
        `执行时会自动给后来者改名（例如 "a (1).png"），**不会覆盖**任何已有文件。`,
    );
  }

  // 真正会新建的目录：只列目标目录此刻还不存在的（已存在的不会被"新建"）。
  const mkdirs = [...mkdirSet].filter((dir) => !existsSync(join(root, dir))).sort();

  if (truncated) {
    warnings.push(
      `目录里的文件太多，本次扫描到了 ${ORGANIZE_SCAN_MAX_ENTRIES} 个条目就停下了 —— ` +
        `**预览可能不完整**。请先把目录拆小，或把规则范围写窄一些再试。`,
    );
  }
  if (unreadable.length > 0) {
    warnings.push(
      `有 ${unreadable.length} 个子目录读不动（权限或正在被占用），其中的文件不在本次预览里：` +
        unreadable.slice(0, 5).join('、') +
        (unreadable.length > 5 ? ' 等' : ''),
    );
  }
  if (moves.length === 0 && warnings.length === 0) {
    warnings.push('这份计划不会移动任何文件。请检查规则的匹配模式，或换个说法告诉 Agent。');
  }

  const untouched = files.filter(
    (f) => !claimed.has(f.relPath) && !inAnyTargetDir(f.relPath),
  ).length;

  const preview: OrganizePreview = {
    rules: rulePreviews,
    totalMoves: moves.length,
    createdDirs: mkdirs,
    untouched,
    warnings,
  };

  return { preview, moves, mkdirs };
}

/**
 * 一个相对路径解析成绝对路径，并过一遍越界判据。
 *
 * 执行端拼路径只走这一个口子 —— 与 `normalizeRule` 里那道判断同一份实现，
 * 所以"预览时判定合法、执行时又判定合法"不会因为两处写法不同而出现分叉。
 */
export function resolveInside(root: string, rel: string, what: string): string {
  const abs = join(root, rel);
  assertInsideDir(root, abs, what);
  return abs;
}
