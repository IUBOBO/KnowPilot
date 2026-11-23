/**
 * 通用弹窗容器（「界面整理-new」§五.2）。
 *
 * 【为什么要有一个通用的，而不是每处各写一个】这个容器里真正难写的是**无障碍那四项**
 *   （焦点移入 / Tab 循环 / Esc 关闭 / 关闭后把焦点还给触发按钮）——
 *   它们不会因为"这个弹窗里装的是表单还是确认文字"而变。写第二遍就等于
 *   押注两处永远不会漂移，而漂移之后没有任何断言会变红：键盘用户只是**某一天**
 *   发现焦点跑到了被盖住的列表里。所以这里抽出**一份**壳，`ConfirmDialog` 也改成用它。
 *
 * 【为什么是 Portal 到 body】弹窗挂在哪一层 DOM 下，就会被那一层的
 *   `overflow: hidden` / `transform` / `z-index` 影响 —— 而它要盖住的正是**整个页面**。
 *
 * 【为什么点遮罩关闭要判 `event.target === event.currentTarget`】
 *   鼠标从弹窗内部按下、拖到外面松开，`click` 也会落在遮罩上。不判这一条，
 *   正在填的表单会被一次拖拽清空。
 */
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  /** 弹窗主体（通常是表单本体）。 */
  children: ReactNode;
  /**
   * 底部动作区。缺省则**不渲染**动作行 —— 有些弹窗的动作在表单里
   * （提交按钮），底部再来一行会让"哪个才是主操作"分成两处。
   */
  footer?: ReactNode;
  /** 给宽表单用的一档（登记投稿有 6 个字段，默认宽度会挤成两行）。 */
  wide?: boolean;
  /**
   * 形态。`dialog`（默认）是居中的弹窗；`drawer` 从右侧滑出、贴满视口高度。
   *
   * 【为什么复用同一个壳而不是新写一个】Esc 关闭、Tab 循环、关闭后焦点归还
   * 这三件事与"弹窗长什么样"无关。问答页的「来源」抽屉如果另写一份，
   * 两份无障碍逻辑迟早会漂移，而漂移后没有任何断言会变红。
   */
  variant?: 'dialog' | 'drawer';
  /**
   * 关闭后把焦点还给谁。缺省 = 打开时拥有焦点的元素。
   *
   * 【为什么需要显式指定】抽屉可能由脚本打开（或由不是按钮的元素触发），
   * 此时 `document.activeElement` 未必是那颗触发按钮。问答页要的验收是
   * "关闭后焦点回到「来源」"，所以把按钮的 ref 直接交给壳，而不是赌
   * 打开那一刻浏览器把焦点停在哪里。
   */
  returnFocusTo?: RefObject<HTMLElement | null>;
  /** Preferred control when a form opens; defaults to the first input. */
  initialFocusTo?: RefObject<HTMLElement | null>;
}

/** 弹窗内可 Tab 到的元素。禁用中的控件要排除，否则焦点会停在点不动的东西上。 */
function focusablesIn(root: HTMLElement | null): HTMLElement[] {
  if (root === null) return [];
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide = false,
  variant = 'dialog',
  returnFocusTo,
  initialFocusTo,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  /** 打开时谁有焦点。关闭时还给它 —— 否则键盘用户被丢回页面顶部。 */
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // 焦点移进来；关闭时还回去。
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      returnFocusTo?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    // 【为什么优先给第一个**输入框**】表单一打开，用户要做的就是打字；
    // 焦点停在第一个输入上，比停在"取消"或弹窗本身省一次 Tab。
    // 找不到输入才退回第一个可聚焦元素，再退回弹窗本体（tabIndex=-1）。
    const root = dialogRef.current;
    const firstInput = root?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])');
    (initialFocusTo?.current ?? firstInput ?? focusablesIn(root)[0] ?? root)?.focus();
    return () => {
      // 触发按钮可能已经随列表一起消失了（提交成功后那个块就没了），
      // 此时 focus() 打在游离节点上是空操作 —— 可接受：提示已经给出，
      // 焦点交给浏览器去兜。不要为此改成"找下一个兄弟节点"，那会引入一串特例。
      returnFocusRef.current?.focus();
    };
  }, [open, returnFocusTo, initialFocusTo]);

  // Tab 循环 + Esc 关闭。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const list = focusablesIn(dialogRef.current);
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      // 反向 Tab 在第一项上、正向 Tab 在最后一项上时，绕回另一头。
      if (event.shiftKey && (active === first || active === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    // 捕获阶段：底下的列表里可能也有 keydown 处理，得先抢到手。
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className={variant === 'drawer' ? 'dialog-backdrop drawer-backdrop' : 'dialog-backdrop'}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={[
          'dialog',
          wide ? 'dialog-wide' : '',
          variant === 'drawer' ? 'dialog-drawer' : '',
        ]
          .filter((c) => c !== '')
          .join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        tabIndex={-1}
      >
        <h2 className="dialog-title" id={titleId}>
          {title}
        </h2>
        <div className="dialog-body">{children}</div>
        {footer !== undefined && <div className="dialog-actions">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
