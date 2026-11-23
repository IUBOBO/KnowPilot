/**
 * 数据集目录的扫描快照。
 *
 * 【为什么每次现扫，不留缓存】与 A1 的"磁盘是唯一事实来源"同一条口径。
 * 目录内容随时会变（刚传完一个压缩包、别人手工放了几张图），一份缓存下来的
 * 清单会在"预览说 120 个、执行动了 121 个"的时候让两边都显得没错 ——
 * 而那种不一致恰恰是整理模块最需要避免的。扫一遍的成本是几次 readdir，
 * 相比"移动错了东西"，这个代价可以忽略。
 */
import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { ORGANIZE_MAX_DEPTH } from '@knowpilot/shared';

export interface ScannedFile {
  /** 相对数据集根的 POSIX 路径。 */
  relPath: string;
  size: number;
}

export interface ScanResult {
  files: readonly ScannedFile[];
  /** 条目数撞到上限、扫描被截断了。预览要如实说，不能假装扫全了。 */
  truncated: boolean;
  /** 读不动的子目录（相对根路径）。不中断整次扫描，但要在预览里说出来。 */
  unreadable: readonly string[];
}

/**
 * 单次扫描的条目数上限。防的是"一个畸形/超大数据集把进程拖死"：
 * 几十万条目已经远超任何合理整理场景，撞到就停下并如实标记截断。
 */
export const ORGANIZE_SCAN_MAX_ENTRIES = 200_000;

/**
 * 递归列出一棵目录树里的**普通文件**。
 *
 * 三条边界，每一条都对应一种会被忽略的坏情况：
 *   · **符号链接一律跳过**（`isSymbolicLink()`）。数据集里一条指向父目录的
 *     软链就是一次无限递归 —— 不是"扫得慢"，是直接把进程转死。
 *     跳过意味着"透过软链看到的东西"不在清单里，这是有意的：整理只会移动
 *     真实文件，而软链本身不动。
 *   · **深度封顶** `ORGANIZE_MAX_DEPTH`：解压出来的压缩包常常嵌好几层。
 *   · **条目数封顶** `MAX_ENTRIES`：见上。
 *
 * 只有普通文件会进 `files`；目录不在其中（目录会被"有文件落进去"隐式建出来，
 * 不需要单独搬）。读不动的子目录记进 `unreadable` 而不是抛错 ——
 * 一个权限不对的子目录不该让整个数据集的整理功能失效。
 */
export function scanFiles(root: string, maxDepth = ORGANIZE_MAX_DEPTH): ScanResult {
  const files: ScannedFile[] = [];
  const unreadable: string[] = [];
  let truncated = false;

  function walk(dirAbs: string, relDir: string, depth: number): void {
    if (truncated) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      unreadable.push(relDir === '' ? '.' : relDir);
      return;
    }

    // 排序让预览与执行看到的顺序一致 —— 顺序随文件系统调用而变的话，
    // 两次预览的"前 10 个样例"可能不同，用户会以为东西被人动过。
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (truncated) return;
      if (files.length >= ORGANIZE_SCAN_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth + 1 > maxDepth) continue;
        walk(join(dirAbs, entry.name), rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue; // 管道、设备节点……一概不是我们要搬的东西
      const abs = join(dirAbs, entry.name);
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        // 读不到大小（竞态：刚被删/刚被改）。仍然列出来 —— 它确实在那里，
        // 大小只是附带的展示信息，为它丢掉一个真实文件不划算。
        size = 0;
      }
      files.push({ relPath: rel, size });
    }
  }

  walk(root, '', 0);
  return { files, truncated, unreadable };
}
