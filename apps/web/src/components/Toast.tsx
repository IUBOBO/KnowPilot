import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * 轻提示（toast）—— 一件"做完了"的事，一闪而过就够。
 *
 * 【为什么只有 ok / warn 两种，没有 err】
 *   错误**必须持久留在页面上**，而且要带请求 ID（用户报问题时能对上服务端日志），
 *   这两件事 toast 都做不到 —— 它会自己消失，也放不下请求 ID。
 *   所以错误一律走 `ErrorNotice`。这里干脆不提供 err 这一档：
 *   **入口不存在，就不会有人顺手用错**。
 *   warn 那一档的用途很窄，是"成功了但结果要留意"（例如上传成功、解析出 0 块）。
 *
 * 【为什么要自己写，不用库】与图标同一条理由：一共几十行，为它引一个依赖
 *   （连同 tree-shaking、版本升级、与既有 CSS 变量的协调）不划算。
 *
 * 【为什么 Provider 挂在路由外面】页面（在路由里面）要能调 `useToast()`，
 *   Provider 就必须是路由的祖先。它自身不依赖会话，所以也不吃 AuthProvider 的状态。
 */

/** 自动消失时间。规格要求 ≥ 4s —— warn 再多给一点，因为它带着"要留意"的内容。 */
const AUTO_DISMISS_MS = { ok: 4000, warn: 7000 } as const;

/** 同屏最多几条。超了从最旧的一条开始挤掉：堆到第四第五条时，用户已经不看第一行了。 */
const MAX_ON_SCREEN = 3;

type ToastKind = 'ok' | 'warn';
type ToastItem = { id: number; kind: ToastKind; text: string };

type ToastApi = {
  ok: (text: string) => void;
  warn: (text: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/** 小图标与导航图标同一套画法（24 格描边、圆头圆角），只是尺寸更小。 */
const GLYPHS: Record<ToastKind, ReactNode> = {
  ok: <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />,
  warn: (
    <>
      <path d="M12 4.5 21 20H3z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.6h.01" />
    </>
  ),
};

function Glyph({ kind }: { kind: ToastKind }) {
  return (
    <svg
      className="toast-glyph"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[kind]}
    </svg>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  /** 定时器句柄。放在 ref 里而不是 state：它不该触发重渲染，也不该进依赖数组。 */
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const handle = timers.current.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string) => {
      const id = nextId.current;
      nextId.current += 1;
      setItems((prev) => {
        const next = [...prev, { id, kind, text }];
        // 挤掉最旧的那条时，它的定时器也要一并撤掉 —— 否则它到点后还会再跑一次
        // dismiss（虽然只会空转），而且句柄会一直留在 Map 里。
        while (next.length > MAX_ON_SCREEN) {
          const dropped = next.shift();
          if (dropped !== undefined) {
            const handle = timers.current.get(dropped.id);
            if (handle !== undefined) {
              clearTimeout(handle);
              timers.current.delete(dropped.id);
            }
          }
        }
        return next;
      });
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS[kind]),
      );
    },
    [dismiss],
  );

  // 卸载时收掉所有定时器。开发模式下 StrictMode 会把 effect 跑两遍，
  // 这里只清定时器、不重建，所以跑两遍也是安全的。
  useEffect(
    () => () => {
      for (const handle of timers.current.values()) clearTimeout(handle);
      timers.current.clear();
    },
    [],
  );

  const api = useMemo<ToastApi>(
    () => ({ ok: (text: string) => push('ok', text), warn: (text: string) => push('warn', text) }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* role="status" 隐含 aria-live="polite"：容器**一直存在**（只是常常为空），
          这样新增的子节点才会被读屏软件播报 —— 容器若跟着提示一起挂载，
          第一条提示就播不出来。 */}
      <div className="toast-wrap" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.kind}`}>
            <Glyph kind={item.kind} />
            <p className="toast-text">{item.text}</p>
            <button
              type="button"
              className="toast-close"
              onClick={() => dismiss(item.id)}
              aria-label="关闭这条提示"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M6 6 18 18M18 6 6 18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) {
    // 直接抛而不是给一个空实现：静默失效会让人以为"点了没反应"是产品缺陷，
    // 而这里其实是漏挂了 Provider。
    throw new Error('useToast 必须在 ToastProvider 里使用（见 main.tsx）');
  }
  return api;
}
