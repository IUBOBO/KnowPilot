/**
 * 空态。
 *
 * 【它解决的问题不是"不好看"，是"没说完"】之前全站 16 处空态都是一句灰字：
 *   「还没有投稿记录。」它回答不了紧接着的那个问题 —— 那我该干什么？
 *   用户停在一条死路上，只能自己去侧栏里找对应那一页。首页那段
 *   「…在「投稿台账」里记下第一篇，之后就能在这里看到它走到哪一步了」是全站
 *   唯一说到位的范本，这个组件就是把那个水准统一到其余 15 处。
 *
 * 【三件套：淡淡的图标 + 为什么是空的 + 一个可点的下一步】
 *   · 图标：空态和"加载失败"在一屏里长得太像（都是一句灰字），加一个淡图标
 *     让"这里是正常的空"和"这里出错了"一眼可分。用 `NavGlyph`（与侧栏同一套
 *     图形），所以"没有投稿记录"旁边的图标就是侧栏「投稿台账」那个 ——
 *     不用另学一次。
 *   · 说明：说的必须是**为什么空**，不是"空"这件事本身。"还没有记录"什么都没
 *     解释；"这份数据集还没整理过 —— 历史里记的是原本打算做什么、实际做了什么，
 *     所以只有真的执行过才会有记录"才是解释。多数话在下面的 `children` 里。
 *   · 下一步：一个真的能把人送出去的动作。没有它，另外两件都只是装饰。
 *
 * 【为什么 action 是 ReactNode 而不是 {to,label}】下一页可能是 `<Link>`（同站
 *   跳转），也可能是 `<button onClick>`（就地做一件事，比如展开下面的表单）。
 *   收窄成 `to` 就把后者堵死了，而"就地展开"在这几页里占了一半。
 *   代价：调用方要自己写 `RequirePermission` 之类的权限判断 —— 这是对的，
 *   空态本就不该知道权限。
 *
 * 【compact 是给谁用的】右栏（`.rail`）只有 300px 宽，期刊详情面板是表格行里
 *   展开的一块。这两处的空态用小图标 + 更紧的行距；在那里按主区尺寸画一个
 *   34px 的图标，会把整块撑得又高又空，反而更显眼。
 */
import type { ReactNode } from 'react';
import { NavGlyph, type NavIconName } from '../nav-icons.tsx';

export function EmptyState({
  icon,
  children,
  action = null,
  preview = null,
  compact = false,
  illustration,
}: {
  /** 与侧栏同一套图形（`nav-icons.tsx` 的 PATHS）。 */
  icon: NavIconName;
  /** 说清"为什么是空的"。允许内嵌 `<Link>`。 */
  children: ReactNode;
  /** 下一步。不传就只显示图标与说明 —— 但能不省就别省。 */
  action?: ReactNode;
  /** 可选的"示例"预览：让人先看到有数据时这块长什么样。 */
  preview?: ReactNode;
  compact?: boolean;
  illustration?: 'no-documents' | 'no-results' | 'all-clear' | 'no-access';
}) {
  return (
    <div className={compact ? 'empty empty-compact' : 'empty'}>
      {illustration !== undefined && !compact ? (
        <img className="empty-illustration" src={`/empty-illustrations/${illustration}.svg`} alt="" />
      ) : (
        <NavGlyph name={icon} size={compact ? 22 : 34} />
      )}
      <p className="empty-text">{children}</p>
      {preview !== null && <div className="empty-preview">{preview}</div>}
      {action !== null && <div className="empty-action">{action}</div>}
    </div>
  );
}
