/**
 * 骨架屏。
 *
 * 【为什么要有它】在这之前，全站 14 处加载态写的都是同一个东西 ——
 *   `<p className="dim">加载中…</p>`。它的两个问题都不是"不好看"：
 *     1. 一行灰字没有任何形状信息。界面在"还没有内容"和"内容是这一段灰字"
 *        之间是同一个观感，用户分不出"在加载"和"这页就这样"。
 *     2. 灰字很矮，真实内容很高。内容到达的瞬间整页往下撑一大截，
 *        阅读位置被打断 —— 这正是"像没做完"的那种观感。
 *   骨架屏同时解决这两件事：它**有形状**（一眼看出在等一个列表），
 *   而且**尺寸与真实内容接近**（内容出现时不跳）。
 *
 * 【形状必须对】规格里那句"形状不对的骨架比一行灰字更糟"是对的，而且理由
 *   很具体：骨架是**预期**。画一块大灰矩形去等一个三行的卡片列表，等于先
 *   承诺了一个不存在的版式，内容一到就"缩水"了，比什么都不画更晃眼。
 *   所以这里的每一个导出都严格对着一个**真实结构**做的：
 *     · SkeletonList  ← `.sub-item` / `.asset-item` / `.upload-row` / `.ask-item`
 *       （标签 + 标题行 + 一行元信息，四页共用同一组 CSS）
 *     · SkeletonTable ← `.table`（真 `<table>`，列数与行高都跟着真实表格走）
 *     · SkeletonRail  ← `.rail-item`（右栏紧凑，两行标题 + 一行小字）
 *     · SkeletonLines ← 卡片内的"标签 …… 值"若干行（系统配置的生效卡）
 *     · Skeleton      ← 一个条，上面几个都是用它拼的
 *
 * 【无障碍方案：role="status" + 视觉隐藏文案，而不是 aria-busy】
 *   两者都能用，但表达力不同：
 *     · `aria-busy="true"` 说的是"这块区域正在更新"，它**不包含任何文字**。
 *       读屏用户听到的是一片沉默，得自己推断发生了什么。而且它必须挂在一个
 *       已经存在的区域上才有意义 —— 首屏加载时那块区域还是空的，等于没说。
 *     · `role="status"` 本身就是一个隐式 `aria-live="polite"` 区域：它出现时
 *       会把它**里面的文字**播报出来。所以配一句视觉隐藏的「正在加载…」，
 *       读屏用户听到的就是一句完整的话。
 *   代价如实记下：内容到达、这个 status 区域被移除时，移除**不会被播报**。
 *   要"加载完成"也有语音提示，得给真实内容那边也加 live region —— 那是 S4
 *   交互反馈层的范围，不在这一阶段。
 *   装饰条一律 `aria-hidden="true"`：它们纯粹是形状，念出来只会是噪声。
 *
 * 【宽度为什么走类名而不是行内 style】规格禁止用行内 style 写新视觉属性。
 *   所以每一类条的宽高都写成 index.css 里的 `.sk-*` 类（`.sk-pill` /
 *   `.sk-title` / `.sk-cell` …），组件只负责挑一个类名。这样宽度是**一处定义、
 *   多处共用**的，而不是每个调用点各填一个数。
 */
import type { ReactNode } from 'react';

/** 一个装饰条。宽度由传进来的类名决定，见 index.css 的 `.sk-*`。 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`sk ${className}`.trim()} aria-hidden="true" />;
}

/**
 * 加载容器：负责"让读屏知道在加载"，形状交给 children。
 * 单独抽出来是为了让下面每个导出都不必重复那句 aria 决策。
 */
function Loading({ children }: { children: ReactNode }) {
  return (
    <div className="sk-wrap" role="status">
      <span className="sr-only">正在加载…</span>
      {children}
    </div>
  );
}

/**
 * 列表骨架：标签 + 标题行 + 元信息行。
 * 对着 `.sub-item / .asset-item / .upload-row / .ask-item` 这一族的真实结构 ——
 * 它们在 index.css 里共用同一组规则，所以一个骨架就能等它们全部。
 */
export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <Loading>
      <ul className="sk-list">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="sk-list-item">
            <span className="sk-row">
              <Skeleton className="sk-pill" />
              <Skeleton className="sk-title" />
            </span>
            <Skeleton className="sk-meta" />
          </li>
        ))}
      </ul>
    </Loading>
  );
}

/**
 * 表格骨架：用**真的** `<table class="table">`。
 *
 * 【为什么不用 div 摆成表的样子】真实表格的列宽是浏览器按内容算的，
 *   行高来自 `.table td` 的内边距。用真表格装灰条，这两样**自动与真实情况
 *   一致**（行高完全一致，列宽也接近），内容到达时纵向几乎不跳。
 *   用 div 拼的话，`.table` 那套内边距与会换行的表头都得再抄一遍，
 *   还得以后跟着改 —— 那就成了"两份要同步的规则"。
 */
export function SkeletonTable({ rows = 4, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <Loading>
      <table className="table">
        <thead>
          <tr>
            {Array.from({ length: cols }, (_, i) => (
              <th key={i}>
                <Skeleton className="sk-th" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }, (_, c) => (
                <td key={c}>
                  <Skeleton className="sk-cell" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Loading>
  );
}

/**
 * 右栏骨架：`.rail-item` 那套紧凑形状。
 *
 * 【为什么右栏单独一个】`.rail-item` 是给 300px 宽的右栏用的（标签 + 时间一行、
 *   标题最多两行、上传者一行），而 `.sub-item` 是给主区用的。两者宽度差一倍，
 *   用同一个骨架会出现"骨架比真内容矮一半"的情况 —— 右栏那点高度变化
 *   在整页里很显眼。
 *
 * 条数取 8，与 RecentRail 的 RAIL_LIMIT 一致：那正是它最多会显示几条。
 */
/**
 * 右栏「最近入库」的骨架：**照着现在那套"组头 + 日期块 + 标题"的形状摆**
 * （一条月份组头条，下面几行带左侧日期方块）。
 * 形状与真实内容差一档就会在内容到达时抖一下，抖得越明显越容易被看到。
 */
export function SkeletonRail({ rows = 8 }: { rows?: number }) {
  return (
    <Loading>
      <div className="sk-rail">
        <Skeleton className="sk-rail-month" />
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="sk-rail-item">
            <Skeleton className="sk-rail-day" />
            <span className="sk-rail-body">
              <Skeleton className="sk-rail-title" />
              <Skeleton className="sk-rail-by" />
            </span>
          </div>
        ))}
      </div>
    </Loading>
  );
}

/**
 * 卡片内的"标签 …… 值"若干行（系统配置的「当前生效」卡就是这个形状）。
 * 标签比它右边的值窄一档（`.sk-label` 34% / `.sk-value` 46%）——
 * 两条等宽排下来看着像表格，不像"标签 + 值"。
 */
export function SkeletonLines({ rows = 4 }: { rows?: number }) {
  return (
    <Loading>
      <div className="sk-lines">
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} className="sk-kv">
            <Skeleton className="sk-label" />
            <Skeleton className="sk-value" />
          </span>
        ))}
      </div>
    </Loading>
  );
}
