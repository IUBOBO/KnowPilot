/**
 * 路径判定。放在这里是因为它有**两处调用方**，而它们必须给出同一个答案。
 */
import { isAbsolute, relative } from 'node:path';

/**
 * 候选路径是否落在某个目录内部（含目录本身）。
 *
 * 两处用它：下载原件时拦住越界读取（阶段 2），以及数据集巡检时判断
 * "这条路径归哪个允许根目录管"（阶段 3 单元 ③）。
 *
 * 【为什么不各写一份】两处实现早晚会在某个边界情形上分叉 —— 尾随分隔符、
 * Windows 的盘符大小写、`..` 走到别的盘符 —— 而那种分歧表现成
 * "同一条路径在一处被拒、在另一处被放行"，安全上正好是最不该出错的方向，
 * 排查时又完全没有线索（两边单看都对）。
 *
 * 判据落在 `relative` 上而不是字符串前缀：前缀比较会让
 * `/data/datasets-old` 被当成 `/data/datasets` 的子目录 —— 它是能读到的，
 * 而白名单的本意是"只准碰这一个目录"。
 */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  // 空 rel = 就是 root 本身；以 .. 开头或本身就是绝对路径 = 越界
  // （跨盘符时 relative 会直接返回候选的绝对路径）。
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
