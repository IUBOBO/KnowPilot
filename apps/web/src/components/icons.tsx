/**
 * 导航之外的小图标。
 *
 * 【为什么不放进 `nav-icons.tsx`】那个文件是**导航项**的图标表（按 `NavIconName`
 *   索引、由导航数据引用），和侧栏结构绑在一起。这里的图标是页面里的动作图标
 *   （刷新、锁、警告三角），两边的消费方式不同，混在一起会让"导航图标"那一份
 *   迟早被页面图标撑成杂物间。
 *
 * 【为什么值得单开一个文件】同一个「↻ 刷新」在三四个页面里出现。各写一份 SVG：
 *   改动时要找齐所有副本（找不到的那份会与其它长得不一样，而**没有任何断言会变红**），
 *   而它偏偏是那种"看一眼就知道不一样"的东西。
 *
 * 画法与导航图标一致：24 格视图、描边 2、`currentColor`、`aria-hidden`
 * （图标是装饰，语义由按钮的文字或 aria-label 承担）。
 */
export function RefreshIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v4h-4" />
    </svg>
  );
}
