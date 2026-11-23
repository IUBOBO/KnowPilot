import { useCallback, useEffect, useState } from 'react';

/**
 * 主题（亮色 / 暗色）。
 *
 * 【为什么状态挂在 <html> 上，而不是 React state 里】
 *   颜色全部是 CSS 变量，`:root` 一套、`[data-theme="dark"]` 一套。
 *   切换主题只需要改一个属性，没有任何组件需要重新渲染。
 *   放进 React state 的话，每次切换都要走一遍整棵树。
 *
 * 【为什么 CSS 里不写 @media (prefers-color-scheme)】
 *   那样写，系统偏好会盖过用户的显式选择 —— 两者在 CSS 里无法区分优先级。
 *   这里让 JS 决定"当前该是什么"，CSS 只管提供两套值，真相只有一份。
 *   代价是首屏必须由 index.html 里那段内联脚本先把属性设上，
 *   否则会先按亮色渲染再跳成暗色，闪一下。
 *
 * 【为什么 key 带版本号】
 *   与提问页的勾选确认同一个惯例：万一将来"暗色"的含义变了
 *   （比如改成高对比度主题），旧值不该继续沿用。
 */
const THEME_KEY = 'knowpilot.theme.v1';

export type Theme = 'light' | 'dark';

/** 用户没显式选过时，跟随系统。 */
function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * 读用户显式选过的主题；没选过返回 null（含义是"跟随系统"）。
 *
 * localStorage 在隐私模式 / 禁用 Cookie 时会**抛异常**而不是返回 null，
 * 所以必须包 try。否则整个应用挂在第一行。
 */
function storedTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null;
  }
}

/** 当前应该生效的主题。 */
export function currentTheme(): Theme {
  return storedTheme() ?? systemTheme();
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // 跟随系统期间，系统在应用开着的时候切了也要跟上（macOS/Windows 都有日落自动切换）。
  // 用户一旦显式选过，系统偏好就不再作数 —— 否则他的选择会被系统覆盖掉。
  useEffect(() => {
    if (storedTheme() !== null) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => setTheme(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // 存不下就只是下次进来回到跟随系统，不值得打断用户。
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
