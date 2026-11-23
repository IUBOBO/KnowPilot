/**
 * 单行云端知情同意条（「界面整理-new」§三「砍 3」、§六.5）。
 *
 * 【它替换的是什么】四个高频页面（知识问答 / 知识库 / 知识沉淀 / 数据集整理）顶部
 * 那块 5–6 行的常驻琥珀警告框。那块框的毛病不是"说错了"，而是**每天都挡在那里**：
 * 哪怕用户早就勾选过（localStorage 记着），它照样占掉近 160px 的首屏，
 * 把真正的输入区推到下半屏。用久了的结果是"警告"两个字彻底失效 —— 谁也不会
 * 每天读一遍同样的话。
 *
 * 【因此这里分两态，但**两种态都在说同一件事**】
 *   · 未勾选 → 琥珀描边 + 一枚复选框：这是需要用户**做一次决定**的时刻；
 *   · 已勾选 → 中性色 + 一句状态：`已授权：……会发往 DeepSeek`。
 * 关键在于**已授权之后不许把这件事藏起来**。原先 `.notice.warn` 的注释里写着
 * "只勾一次就永久记住的话，换了台机器的人、或者看到同事屏幕的人，完全看不到
 * '内容会出网'这件事" —— 那句话说对了一半：不该藏的是**事实**，不是**警告框**。
 * 事实由这一行常驻承担，警告框只留给"还没勾"的那段时间。
 *
 * 【完整说明一个字都没删】它只是收进了「详情」后面（各页原文照搬）。
 * 砍掉的是**常驻**，不是**内容**。
 *
 * 【为什么用 🔒 之外的画法】全站没有一处 emoji（`apps/web/src` 里一个都没有），
 * 图标一律手写内联 SVG。这里也照办 —— 一枚 12px 的锁，不引图标库。
 */
import { useState, type ReactNode } from 'react';

export interface ConsentBarProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** 未勾选时那一行的短句。必须是**结论**（"这件事会出网"），不是过程说明。 */
  pending: string;
  /** 已勾选时那一行的短句 —— 说清"已授权的是哪一件事"。 */
  granted: string;
  /** 展开后的完整说明（各页原文）。 */
  children: ReactNode;
  /** 提交进行中之类的场合，禁用勾选框。 */
  disabled?: boolean;
}

/** 未勾选时那个惊叹号三角。与锁同一套尺寸与画法。 */
function WarnIcon() {
  return (
    <svg
      className="consent-icon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5 2.5 20h19L12 3.5Z" />
      <path d="M12 10v4M12 17.2v.1" />
    </svg>
  );
}

/** 一把 12px 的小锁。锁身 + 锁梁两笔，与导航图标同一套画法（24 格、描边 2）。 */
function LockIcon() {
  return (
    <svg
      className="consent-icon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function ConsentBar(props: ConsentBarProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className={props.checked ? 'consent-bar' : 'consent-bar unconfirmed'}>
        <p className="consent-line">
          {props.checked ? <LockIcon /> : <WarnIcon />}
          <span>{props.checked ? props.granted : props.pending}</span>
        </p>
        <div className="consent-actions">
          {/* 勾选框**两态都在**，不换成"取消授权"按钮。两个理由：
              ① 它是这个状态的主人 —— 取消授权就是取消勾选，多一个按钮反而要人猜"这两个是不是一回事"；
              ② 换成按钮会让 `input[type=checkbox]` 在勾选后从页面上消失，
                 而几个验证脚本靠"第一个复选框"来勾同意（组织整理那条还会**回读** checked）——
                  一个纯视觉的改进不该顺手打断它们。 */}
          <label className="consent-label">
            <input
              type="checkbox"
              checked={props.checked}
              disabled={props.disabled}
              onChange={(e) => props.onCheckedChange(e.target.checked)}
            />
            <span>我已阅读并理解</span>
          </label>
          <button
            type="button"
            className="link-btn"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '收起说明' : '详情'}
          </button>
        </div>
      </div>
      {/* 详情**常驻 DOM、只是 hidden**，而不是"展开时才渲染"。两个理由：
          ① `hidden` 的元素仍在 textContent 里 —— 组织整理那条 e2e 断言正文含
             「投稿中的稿件」，按需渲染会让它在**没展开**时变成假红；
          ② 展开/收起只是显示与否，不该带来任何重新挂载。 */}
      <div className="consent-detail" hidden={!open}>
        {props.children}
      </div>
    </>
  );
}
