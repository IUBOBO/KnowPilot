import type { ReactNode } from 'react';
import type { Permission } from '@knowpilot/shared';
import { useAuth } from '../auth.tsx';

/**
 * 行内的权限闸门：**这个人有这个权限才渲染 children**。
 *
 * 【为什么需要一个"行内"的，而路由上那个不够】
 *   `RequireAuth` / `RequireAnyPermission`（auth.tsx）管的是**整页**：
 *   进不来就给一张 403 页。但权限不是按页切的 —— 知识库里"重建索引"、
 *   期刊库里"订正 / 删除"，都是**同一页里的某几个动作**只有管理员能做。
 *   拿不到权限的人如果照样看得见按钮，点了必然 403：他会以为系统坏了，
 *   而不是"这件事不归我做"。所以按钮本身要按权限出现。
 *
 * 【为什么不是"藏起来就算了"】藏掉之后，"我做不了这件事"与"这个功能不存在"
 *   在界面上长得一模一样。所以拿不到权限时用 `otherwise` 说一句**为什么**：
 *   "需要「材料管理」权限，请联系管理员"。看得见原因，才知道下一步找谁。
 *
 * 【这不是安全边界】只是显示逻辑。真正的边界在服务端（默认拒绝的闸门 +
 *   行级过滤），前端藏了不等于拦住了 —— 见 auth.tsx 顶部那段"两边必须
 *   说同一件事"，以及 routes.ts 的 ROUTE_PERMISSIONS。
 */
export function RequirePermission({
  permission,
  otherwise = null,
  children,
}: {
  permission: Permission;
  /** 没有这个权限时渲染什么。不给就什么都不渲染。 */
  otherwise?: ReactNode;
  children: ReactNode;
}) {
  const { can } = useAuth();
  return <>{can(permission) ? children : otherwise}</>;
}
