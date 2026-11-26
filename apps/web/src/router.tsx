/**
 * 路由表。
 *
 * 用户区（/）与管理区（/admin/*）在同一个应用里，靠路由分区 + 权限点区分。
 * 不拆成两个前端工程的理由：共享组件、共享类型、共享构建产物，
 * 一套部署；拆开的话登录态和契约要同步两遍。
 * 真正的隔离靠的是权限点，而不是"藏起来一个入口"。
 *
 * 【三层守卫，各管一件事】
 *   · `/login` 在 Layout **之外** —— 未登录的人不该看到侧栏与导航；
 *   · `<RequireAuth>` 包住 Layout —— 其余每一页都要求已登录；
 *   · `<RequirePermission>` / `<RequireAnyPermission>` 包住管理区 ——
 *     无权限时显示 403 页，而不是把人静默弹回首页。
 */
import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { ADMIN_ENTRY_PERMISSIONS, RequireAnyPermission, RequireAuth, RequirePermission } from './auth.tsx';
import { Layout } from './Layout.tsx';
const AdminFeedbackPage = lazy(() => import('./pages/AdminFeedbackPage.tsx').then((m) => ({ default: m.AdminFeedbackPage })));
const AdminHomePage = lazy(() => import('./pages/AdminHomePage.tsx').then((m) => ({ default: m.AdminHomePage })));
const AdminTracePage = lazy(() => import('./pages/AdminTracePage.tsx').then((m) => ({ default: m.AdminTracePage })));
const AdminTraceDetailPage = lazy(() => import('./pages/AdminTracePage.tsx').then((m) => ({ default: m.AdminTraceDetailPage })));
const AsksPage = lazy(() => import('./pages/AsksPage.tsx').then((m) => ({ default: m.AsksPage })));
const ChunkPage = lazy(() => import('./pages/ChunkPage.tsx').then((m) => ({ default: m.ChunkPage })));
const CodePage = lazy(() => import('./pages/CodePage.tsx').then((m) => ({ default: m.CodePage })));
const DocumentsPage = lazy(() => import('./pages/DocumentsPage.tsx').then((m) => ({ default: m.DocumentsPage })));
const SearchPage = lazy(() => import('./pages/SearchPage.tsx').then((m) => ({ default: m.SearchPage })));
const HomePage = lazy(() => import('./pages/HomePage.tsx').then((m) => ({ default: m.HomePage })));
const JournalsPage = lazy(() => import('./pages/JournalsPage.tsx').then((m) => ({ default: m.JournalsPage })));
const KnowledgePage = lazy(() => import('./pages/KnowledgePage.tsx').then((m) => ({ default: m.KnowledgePage })));
const ResearchNotesPage = lazy(() => import('./pages/ResearchNotesPage.tsx').then((m) => ({ default: m.ResearchNotesPage })));
const KnowledgeReviewPage = lazy(() => import('./pages/KnowledgeReviewPage.tsx').then((m) => ({ default: m.KnowledgeReviewPage })));
const LoginPage = lazy(() => import('./pages/LoginPage.tsx').then((m) => ({ default: m.LoginPage })));
const OrganizePage = lazy(() => import('./pages/OrganizePage.tsx').then((m) => ({ default: m.OrganizePage })));
const AdminUsagePage = lazy(() => import('./pages/AdminUsagePage.tsx').then((m) => ({ default: m.AdminUsagePage })));
const PatrolPage = lazy(() => import('./pages/PatrolPage.tsx').then((m) => ({ default: m.PatrolPage })));
const PeoplePage = lazy(() => import('./pages/PeoplePage.tsx').then((m) => ({ default: m.PeoplePage })));
const PatentsPage = lazy(() => import('./pages/PatentsPage.tsx').then((m) => ({ default: m.PatentsPage })));
const ThesesPage = lazy(() => import('./pages/ThesesPage.tsx').then((m) => ({ default: m.ThesesPage })));
const LedgerImportsPage = lazy(() => import('./pages/LedgerImportsPage.tsx').then((m) => ({ default: m.LedgerImportsPage })));
const SubmissionsPage = lazy(() => import('./pages/SubmissionsPage.tsx').then((m) => ({ default: m.SubmissionsPage })));
const UploadPage = lazy(() => import('./pages/UploadPage.tsx').then((m) => ({ default: m.UploadPage })));
const UsagePage = lazy(() => import('./pages/UsagePage.tsx').then((m) => ({ default: m.UsagePage })));
const UsersPage = lazy(() => import('./pages/UsersPage.tsx').then((m) => ({ default: m.UsersPage })));
const ConfigPage = lazy(() => import('./pages/ConfigPage.tsx').then((m) => ({ default: m.ConfigPage })));

export const router = createBrowserRouter([
  { path: '/login', element: <Suspense fallback={<p role="status">正在加载登录页…</p>}><LoginPage /></Suspense> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <HomePage /> },

      // 用户区
      { path: 'ask', element: null },
      // 问答记录：服务端按可见范围过滤（成员看自己的、导师与管理员看全部），
      // 前端不假设"全是我的"。
      { path: 'asks', element: <AsksPage /> },
      { path: 'me/usage', element: <UsagePage /> },
      { path: 'chunk/:chunkId', element: <ChunkPage /> },
      { path: 'search', element: <SearchPage /> },
      { path: 'docs', element: <DocumentsPage /> },
      // 这三条是**旧入口的保底**。它们原先各自是一个页面组件，只是把材料类型锁死，
      // 与 /docs 的差别只有"筛哪一类"；现在材料类型改由 /docs 页内的标签页切换，
      // 所以这里只做重定向 —— 旧书签与别人贴过的链接仍然能用。
      { path: 'experience', element: <Navigate to="/docs?material=experience" replace /> },
      { path: 'sop', element: <Navigate to="/docs?material=sop" replace /> },
      { path: 'submissions', element: <SubmissionsPage /> },
      // 期刊分区库独立一页：台账回答"我投的稿到哪一步了"（我的动态记录），
      // 这一页回答"这本刊是几区"（公共的静态事实），而且它还要能让用户**补录**。
      { path: 'journals', element: <JournalsPage /> },
      {
        path: 'people',
        element: (
          <RequirePermission permission="people.read">
            <PeoplePage />
          </RequirePermission>
        ),
      },
      {
        path: 'patents',
        element: (
          <RequirePermission permission="patent.read.all">
            <PatentsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'theses',
        element: (
          <RequirePermission permission="thesis.read">
            <ThesesPage />
          </RequirePermission>
        ),
      },
      { path: 'imports', element: <LedgerImportsPage /> },
      { path: 'datasets', element: <CodePage /> },
      // 上传单独一页而不是塞进 /datasets：拖拽区 + 逐文件进度 + 未传完清单
      // 是另一套交互，混进那张列表里会被一堆条目压到看不见，
      // 而它恰恰是"这台机器上的大数据怎么进服务器"的唯一入口。
      { path: 'datasets/upload', element: <UploadPage /> },
      // 整理同样是独立一页：它是"对话 → 改规则 → 预览 → 二次确认"的一串交互，
      // 塞进列表行里没有地方放，而它又必须让人看清每一步会动什么。
      // 两条路由共用一个组件：不带 id 是选数据集，带上 id 是对它整理。
      { path: 'datasets/organize', element: <OrganizePage /> },
      { path: 'datasets/organize/:assetId', element: <OrganizePage /> },
      { path: 'rules', element: <Navigate to="/docs?material=rule" replace /> },
      // 知识沉淀：用户提交白话、看草案、确认/驳回**自己**的那些。
      // 与 /submissions 同惯例不加路由闸门 —— 进得来不等于看得到，
      // 行级可见在服务端的 SQL 里收口（见 auth/scope.ts 的 knowledgeScope）。
      { path: 'knowledge', element: <KnowledgePage /> },
      { path: 'knowledge/notes', element: <ResearchNotesPage /> },
      // 旧占位入口。地址直接敲仍然到得了知识沉淀那一页 ——
      // 阶段 3/4 期间这一条是 <PlaceholderPage>，贴过的链接与书签不该失效。
      { path: 'capture', element: <Navigate to="/knowledge" replace /> },

      // 管理区。阶段 4C 与阶段 6 已把各个入口逐个换成真页面（概览 / 用户与权限 /
      // 知识审核 / 用量与预算 / 巡检 / 系统配置）；守卫在 4B 就装上了 ——
      // 设计文档 04 §5 的验收项正是"member 访问 /admin/users 被拦截"。
      {
        path: 'admin',
        element: (
          <RequireAnyPermission permissions={ADMIN_ENTRY_PERMISSIONS}>
            <AdminHomePage />
          </RequireAnyPermission>
        ),
      },
      {
        path: 'admin/users',
        element: (
          <RequirePermission permission="users.manage">
            <UsersPage />
          </RequirePermission>
        ),
      },
      {
        path: 'admin/review',
        element: (
          <RequirePermission permission="knowledge.review">
            <KnowledgeReviewPage />
          </RequirePermission>
        ),
      },
      {
        path: 'admin/usage',
        element: (
          <RequirePermission permission="usage.read.all">
            <AdminUsagePage />
          </RequirePermission>
        ),
      },
      {
        path: 'admin/patrol',
        element: (
          <RequirePermission permission="patrol.manage">
            <PatrolPage />
          </RequirePermission>
        ),
      },
      {
        path: 'admin/config',
        element: (
          <RequirePermission permission="system.config">
            <ConfigPage />
          </RequirePermission>
        ),
      },
      {
        // O5：反馈列表只读。导出草稿也在这一页，权限同为 feedback.manage。
        path: 'admin/feedback',
        element: (
          <RequirePermission permission="feedback.manage">
            <AdminFeedbackPage />
          </RequirePermission>
        ),
      },
      {
        // O7：运行 Trace。列表与详情是两个地址，详情可以直接贴给另一个人。
        path: 'admin/traces',
        element: (
          <RequirePermission permission="trace.read.all">
            <AdminTracePage />
          </RequirePermission>
        ),
      },
      {
        path: 'admin/traces/:runId',
        element: (
          <RequirePermission permission="trace.read.all">
            <AdminTraceDetailPage />
          </RequirePermission>
        ),
      },

      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
