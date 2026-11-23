/**
 * 数据集路径的核对（需求 5 的「路径有效性巡检」；01 号 §2 的 M-CODE）。
 *
 * 【本模块只做一件事，但它是这一页可信度的全部】把「是否存在」拆成
 * **探到了 / 确实没有 / 根本探不了** 三种，而不是一个布尔。
 *
 * 为什么这一步比它看起来重要：这台服务既可能跑在数据服务器上，也可能跑在
 * 某个人的开发机上（部署位置还没定）。同一个数据集，在前者那儿是
 * `/data/datasets/x`，在后者那儿这台机器压根没有这个目录。要是探测器只有
 * 一个 `exists` 布尔，开发机上跑一次巡检就会把**服务器上全部数据集报成
 * "已失效"** —— 而它们一个都没丢。那种错误没有任何报错、界面看着也很正常，
 * 正是本项目反复踩的那一类。
 *
 * 所以有三条顺序不能动的规则：
 *   ① 声明了 `host` 的记录一律不探（探了也只能得到"我这儿没有"，纯属误报）；
 *   ② 先探根、再探条目 —— 顺序反了，"整个盘没挂上"会变成"每条数据都没了"；
 *   ③ 权限不足归到"探不了"，不归到"没有"（与 usage_events 不拿 0 冒充实际值同一判断）。
 */
import { existsSync, statSync } from 'node:fs';
import type { AllowedRoot, AssetCheckResult } from '@knowpilot/shared';
import { isInside } from '../paths.ts';

export interface AssetProbe {
  result: AssetCheckResult;
  /** 为什么是这个结果。给人看、给日志看，**不入库** —— 见下方说明。 */
  reason: string;
}

/**
 * 探测每个允许根目录此刻在不在。
 *
 * 【为什么不把这个结果存进库】"本机能不能看到 /data"是**这台机器此刻**的属性，
 * 不是那条数据集的属性：换个部署位置它就变了，同一批数据在不同机器上看到的
 * 结论也不一样。存下来必然过期，而一个过期的"看不到"会让用户去修一个
 * 并不存在的问题。所以每次读列表时现探一次（`existsSync` 是纳秒级操作），
 * 库里只留每条资产自己的核对结论。
 */
export function probeRoots(roots: readonly string[]): readonly AllowedRoot[] {
  return roots.map((path) => ({ path, visible: existsSync(path) }));
}

/**
 * 核对一条资产。`roots` 必须是同一次批量核对里探好的那一份 ——
 * 每条资产各探一遍根目录既慢，又可能出现"同一批里前后结论不一致"。
 */
export function checkAsset(
  location: string,
  host: string | null,
  roots: readonly AllowedRoot[],
): AssetProbe {
  if (host !== null) {
    return {
      result: 'unreachable',
      reason: `这条声明的位置在「${host}」上，本机不去探测它。`,
    };
  }

  const root = roots.find((r) => isInside(r.path, location));
  if (root === undefined) {
    return {
      result: 'unreachable',
      reason:
        roots.length === 0
          ? '本机没有配置允许根目录（CODE_ROOTS 为空），任何路径都不去探测。'
          : `不在任何允许根目录内（${roots.map((r) => r.path).join('、')}）。`,
    };
  }
  if (!root.visible) {
    return {
      result: 'unreachable',
      reason: `本机看不到根目录 ${root.path}，因此无法判断这条还在不在。`,
    };
  }

  try {
    statSync(location);
    return { result: 'exists', reason: `本机在 ${root.path} 内探到了该路径。` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { result: 'missing', reason: '本机探过该路径，它不存在。' };
    }
    // EACCES / EPERM / ELOOP… 都属于"我没能看"而不是"它不在"。
    return {
      result: 'unreachable',
      reason: `本机无法读取该路径（${code ?? '未知错误'}），这不能说明它不存在。`,
    };
  }
}
