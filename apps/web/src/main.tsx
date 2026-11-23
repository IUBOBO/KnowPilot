import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { AuthProvider } from './auth.tsx';
import { ToastProvider } from './components/Toast.tsx';
import { router } from './router.tsx';
import './index.css';
import './a-theme.css';

const rootEl = document.getElementById('root');
if (rootEl === null) {
  throw new Error('找不到 #root 节点，index.html 可能被改坏了');
}

createRoot(rootEl).render(
  <StrictMode>
    {/* AuthProvider 在 RouterProvider **外面**：会话状态是整棵树的根，
        而且它自己不依赖路由（守卫才依赖，守卫在路由里面渲染）。 */}
    <AuthProvider>
      {/* ToastProvider 也必须在 RouterProvider 外面 —— 页面（在路由里面）
          要能调 useToast()，所以它得是路由的祖先。它不依赖会话，
          放在 AuthProvider 内或外都行，这里放里面是为了"会话相关的一层都在上面"。 */}
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </AuthProvider>
  </StrictMode>,
);
