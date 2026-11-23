import { type ReactNode } from 'react';
import { Modal } from './Modal.tsx';

/**
 * 不可逆动作的二次确认弹窗，替代原来行内的 `.asset-confirm`。
 *
 * 【为什么要从行内换成弹窗】行内确认会把列表**撑开**：在一条一条排着的记录里
 *   突然多出一段十几行的确认块，下面的行全被推走，`确定` 按钮出现的位置每次都不同 ——
 *   而"点错一次就少一条登记"恰恰是这里最不能出的错。弹窗把这段文字放在一个
 *   固定位置、且盖住底下的列表，视线和鼠标都不用重新找。
 *
 * 【2026-10-16：无障碍四项搬去了 `Modal`】焦点移入 / Tab 循环 / Esc 关闭 /
 *   关闭后把焦点还给触发按钮 —— 这四件事与"弹窗里装的是什么"无关。
 *   原先它们写在本文件里；`界面整理-new` 要给登记表单也用弹窗之后，
 *   再复制一份就等于押注两处永不漂移（而漂移了不会有任何断言变红，
 *   只是键盘用户某天发现焦点跑到了被盖住的列表里）。壳留在 `Modal`，
 *   这里只管"确认弹窗该长什么样"：一句说明 + 取消/确认两个动作。
 */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  busyLabel,
  cancelLabel,
  busy,
  confirmDisabled = false,
  danger,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  busyLabel: string;
  cancelLabel: string;
  busy: boolean;
  confirmDisabled?: boolean;
  danger: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      // 顺序按弹窗惯例：取消在左、确认在右。原行内确认是"确认在前"，
      // 那是列表里的排法；换到弹窗里，"右边那个是执行"是更省心的默认。
      footer={
        <>
          <button type="button" className="link-btn" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'danger' : ''}
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
