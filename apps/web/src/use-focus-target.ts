/**
 * 把 `?focus=<id>` 指向的那一行滚进视野并短暂描边（O10）。
 *
 * 【为什么用列表页定位而不是给每类实体造详情页】投稿与数据集都没有独立的
 * 详情页，文档的"详情"就是它的第一块原文（已有 `/chunk/:id`）。命令面板
 * 能做的、也应当做的，是把人送到**那个东西所在的地方**并指明是哪一行；
 * 为一个跳转再造三张详情页，会把一次界面优化变成三套新路由。
 *
 * 【为什么是滚动 + 描边，而不是只跳页面】一条投稿可能排在 200 行的中间。
 * 只打开列表页等于把"找那一条"的工作原样交还给用户 —— 搜索省下的时间
 * 又还回去了。
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

export function useFocusTarget(idPrefix: string, ready: boolean): void {
  const [searchParams] = useSearchParams();
  const focus = searchParams.get('focus');

  useEffect(() => {
    if (!ready || focus === null || focus === '') return;
    const el = document.getElementById(`${idPrefix}${focus}`);
    if (el === null) return;

    el.scrollIntoView({ block: 'center' });
    el.classList.add('focus-flash');
    const timer = window.setTimeout(() => el.classList.remove('focus-flash'), 2200);
    return () => {
      window.clearTimeout(timer);
      el.classList.remove('focus-flash');
    };
  }, [idPrefix, focus, ready]);
}
