# KnowPilot 全站视觉检查矩阵

最新主线基线为 [`0a2b73e`](https://github.com/IUBOBO/KnowPilot/commit/0a2b73e7049bd692d3412b964a822b59428db57b)，含 [UX-01 PR #46](https://github.com/IUBOBO/KnowPilot/pull/46) 和 [UX-02 PR #47](https://github.com/IUBOBO/KnowPilot/pull/47)。依据 [路由表](../../../apps/web/src/router.tsx)、对应组件、[Layout](../../../apps/web/src/Layout.tsx) 和全局、局部 CSS。路由中 `/ask` 的 element 为 null，由 Layout 持久挂载 AskPage。核对 35 个入口或状态，含旧路径、兜底、参数变体及 403。

## 浏览器基线

用实际主线构建产物、Chrome、合成账号和 API 拦截检查亮暗路由、360px 抽样、问答、检索结果和展开后的右栏；Trace 列表用补齐 counts 的合成响应复测。填充详情、列表记录及部分操作态本轮依据源码记录，留待实施时用完整合成 fixture 验收。运行期间无真实科研数据使用或模型请求。

`main.tsx` 先载入 `index.css` 再载入 `a-theme.css`。CSSOM 匹配的亮色 `:root` 顺序为 `#162026` → `#183d40`，暗色 `[data-theme="dark"]` 为 `#ebf0ef` → `#eaf2ef`。各主题的对应选择器优先级相同，后定义胜出。标题、正文和辅助信息通过 `var(--ink*)` 使用继承值。显式前景走自己的规则，例如 cite-mark 读取 `--accent-ink`，暗色检索 mark 另有局部配对。两主题中 `--ink-3` 与 `--ink-4` 均被覆盖成同值。

| 样例计算样式 | 亮色 | 暗色 |
|---|---|---|
| 页面背景 / 标题 | `#F7FAFA` / `#183D40` | `#101B1E` / `#EAF2EF` |
| 问答正文 / 已有 Markdown 加粗 | 同为 `#183D40`，14px，字重 400 / 700 | 同为 `#EAF2EF`，14px，字重 400 / 700 |
| 搜索正文 / 页和章节 | `#294D50` 15px / `#52686A` 13px | `#D6E5E1` 15px / `#A9C1C2` 13px |
| 真命中前景 / 背景 | `#6B4A10` / `#F6E3B4`，6.34:1 | `#382707` / `#E9CC87`，9.20:1 |
| 管理概览叠在错误提示上的错误徽标 | 约 5.35:1 | 约 4.27:1 |
| 搜索证据阅读器打开 | 1440px 右栏与 360px 抽屉均打开，未见整页横向溢出 | 同左 |

对比值按前景和叠合后的背景计算。问答正文与卡片对比度本身较高，当前问题也包括色相过度接近和层级不足。基线抽样不宣称全站通过验收。

## 页面及拟改范围

每行均核对全局覆盖影响。标题、`ink`、`dim`、`lead` 和公共表单消费覆盖值。引用和状态有独立前景或叠色，另需在实际背景验收。候选修改皆在 `apps/web/src` 下，组件列给出实际文件。

| 路由 | 组件 | 当前样式与问题 | 责任及拟改方式 | 验收 |
|---|---|---|---|---|
| /login | [LoginPage](../../../apps/web/src/pages/LoginPage.tsx) | auth-heading、field 继承全局色，错误有独立 notice | UX-03 · 仅全局，保留登录 DOM | 亮暗/360px 下标题、标签、错误、密码切换和焦点清楚 |
| / | [HomePage](../../../apps/web/src/pages/HomePage.tsx) | home-intro、workbench-label/hint，状态卡叠色，待办计数与说明接近 | UX-05 · 首页局部层级 | 辨识待办数字、状态和近期入口 |
| /ask | [AskPage](../../../apps/web/src/pages/AskPage.tsx) | 正文 14px，加粗继承正文色，cite-mark 为品牌色，动态块另有 CSS | UX-04 · pages/ask 的正文、来源、动态块与两份 CSS | 章节、段落、表格代码公式、引用和复核确认均可辨识 |
| /asks | [AsksPage](../../../apps/web/src/pages/AsksPage.tsx) | ask-history-preview、ask-meta、ask-history-sources 同处紧凑列表 | UX-04 · 问答历史局部样式 | 区分问题、摘要、时间和来源跳转 |
| /me/usage | [UsagePage](../../../apps/web/src/pages/UsagePage.tsx) | usage-metrics、dim、usage-cache，计量值和缓存说明密集 | UX-05 · 局部数值和标签样式 | 请求、Token、费用与缓存单位可辨 |
| /chunk/:chunkId | [ChunkPage](../../../apps/web/src/pages/ChunkPage.tsx) | chunk-target 整块 warn-soft，hit-path 为品牌色，正文 14px | UX-04 · 片段局部样式，选中上下文与真实命中分开 | 页节、当前块、历史及真实命中易辨，定位不变 |
| /search | [SearchPage](../../../apps/web/src/pages/SearchPage.tsx) | 正文已是 15px/1.8，位置用 ink-3，暗色 mark 有独立配对 | UX-04 · SearchDocuments.tsx、search.css 接冻结 Token；SearchPage 兼容复验 | 卡片、真实命中、展开收起、范围、选择、分页与原文联动均保留 |
| /docs | [DocumentsPage](../../../apps/web/src/pages/DocumentsPage.tsx) | docs-table-scroll、doc-title、dim；资料名、类型、索引与时间聚在同一行 | UX-05 · 资料表格和元信息 | 长文件名可读，索引状态、材料筛选和原入口正常 |
| /submissions | [SubmissionsPage](../../../apps/web/src/pages/SubmissionsPage.tsx) | sub-record-facts、状态/提醒采用多套字重色彩，日期及轮次与正文并列 | UX-05 · 投稿记录及其局部样式 | 论文、关键状态、日期、轮次和操作清楚，保留密度 |
| /journals | [JournalsPage](../../../apps/web/src/pages/JournalsPage.tsx) | journal-search-form、journal-item/rank-row 混用公共与分区配色 | UX-05 · 期刊表格、字段值和补录详情 | 期刊名、年份、JCR/中科院与缺失提示清楚 |
| /people | [PeoplePage](../../../apps/web/src/pages/PeoplePage.tsx) | people-table-scroll、table、mono 和 dim，姓名、编号和操作并排 | UX-05 · 人员表格、PersonPicker 专项样式 | 姓名突出，编号与操作可读，筛选、权限保留 |
| /patents | [PatentsPage](../../../apps/web/src/pages/PatentsPage.tsx) | patent-card、patent-stage、milestones 叠合状态色，编号与事件密集 | UX-05 · 专利记录、里程碑 | 名称、当前阶段和历史事件清楚，权限不变 |
| /theses | [ThesesPage](../../../apps/web/src/pages/ThesesPage.tsx) | thesis-card、grade/restricted 和事件多套字重 | UX-05 · 论文记录与详情 | 长题名、方向及状态可读，受限信息边界保留 |
| /imports | [LedgerImportsPage](../../../apps/web/src/pages/LedgerImportsPage.tsx) | ledger-upload/export-card、field、dim；模板、草稿和错误列表易混 | UX-05 · 导入预览、字段与错误详情 | 模板、错误位置、预览值及确认入口清楚 |
| /datasets | [CodePage](../../../apps/web/src/pages/CodePage.tsx) | roots-summary、asset-root-path、asset-meta 和 mono，长路径/文件名与状态混排 | UX-05 · 数据集列表、路径和详情 | 路径可换行或复制，名称与登记状态清晰 |
| /datasets/upload | [UploadPage](../../../apps/web/src/pages/UploadPage.tsx) | drop-zone、upload-dest、upload-register、notice；路径、进度和待续传混排 | UX-05 · 上传进度、文件项与错误 | 长名不挤掉操作，进度、成功和错误有文字 |
| /datasets/organize 与 /datasets/organize/:assetId | [OrganizePage](../../../apps/web/src/pages/OrganizePage.tsx) | chat-role、plan-summary/rules、preview-facts/problem，角色、阶段和风险分散 | UX-04 · OrganizePage 及局部样式 | 选数据集、用户/Agent、计划、预览、风险和确认分开 |
| /knowledge | [KnowledgePage](../../../apps/web/src/pages/KnowledgePage.tsx) | kb-entry-title/meta、kb-hint、正文、来源和状态粒度不一 | UX-04 · KnowledgePage、DraftEditor、DiscoveryPanel 局部样式 | 正式正文、条件、来源、草稿与发现分开，权限及工作流保留 |
| /knowledge/notes | [ResearchNotesPage](../../../apps/web/src/pages/ResearchNotesPage.tsx) | notes.css 双栏，关联问答/来源混用 dim，编辑/阅读节奏需区分 | UX-04 · ResearchNotesPage、notes.css | 编辑、关联问答、来源及失效提示清楚，窄屏与导出正常 |
| /admin | [AdminHomePage](../../../apps/web/src/pages/AdminHomePage.tsx) | admin-overview-grid、notice 和 pill；暗色错误徽标叠色实测低于 4.5:1 | UX-05 · 概览局部优先级，公共状态由 03 校准 | 概览、错误、提示和入口可扫读 |
| /admin/users | [UsersPage](../../../apps/web/src/pages/UsersPage.tsx) | users-filter-row、table、mono 和 pill，账号、角色、状态同密度 | UX-05 · 用户表格与详情 | 角色及状态有文字，搜索、权限和长账号保持可读 |
| /admin/review | [KnowledgeReviewPage](../../../apps/web/src/pages/KnowledgeReviewPage.tsx) | review-queue/detail、kb-conflict 复用知识色，新旧正文同类容器 | UX-04 · 知识审核局部 CSS | 新旧、来源、版本、冲突原因与裁决分别可辨，窄屏单栏 |
| /admin/usage | [AdminUsagePage](../../../apps/web/src/pages/AdminUsagePage.tsx) | admin-table-scroll、table/mono，预算、费用和 Token 密集 | UX-05 · 后台用量指标及表格 | 关键值、单位、预算和时间对齐，授权不变 |
| /admin/patrol | [PatrolPage](../../../apps/web/src/pages/PatrolPage.tsx) | patrol-summary、table、notice 与 soft 背景，规则/任务和严重性分散 | UX-05 · 巡检摘要、任务行与状态 | 规则、严重性、时间、任务操作可读，状态不靠颜色独传 |
| /admin/config | [ConfigPage](../../../apps/web/src/pages/ConfigPage.tsx) | field、dim、mono、notice；来源、覆盖、长地址和结果混排 | UX-05 · 配置标签、值及结果 | 密钥遮蔽，URL/错误可读，不发起真实模型验收 |
| /admin/feedback | [AdminFeedbackPage](../../../apps/web/src/pages/AdminFeedbackPage.tsx) | admin-table-scroll、tabs、table、mono，评级、正文和请求 ID 层级不一 | UX-05 · 反馈表格与备注 | 长反馈和附带信息可读，筛选及权限保留 |
| /admin/traces | [AdminTracePage](../../../apps/web/src/pages/AdminTracePage.tsx) | admin-table-scroll、field、table、mono，Run ID 和结果、时间同密度 | UX-05 · Trace 列表局部 CSS | 结果和关键指标可扫读，筛选及详情链接保留 |
| /admin/traces/:runId | [AdminTracePage（详情导出）](../../../apps/web/src/pages/AdminTracePage.tsx) | 同模块详情，卡片、mono、步骤和警告，长参数/请求 ID 与数字密集 | UX-05 · Trace 详情局部 CSS | 步骤和指标可区分，长值局部滚动，脱敏边界不变 |
| 无权限（如成员访问 /admin/users） | [ForbiddenPage](../../../apps/web/src/pages/ForbiddenPage.tsx) | pill.err、lead、dim，告警及返回入口已有结构 | UX-03 · 仅全局，保留守卫和页面 | 403、返回动作及辅助文字可读，后台内容仍受守卫 |
| /experience、/sop、/rules | router.tsx → DocumentsPage | 无独立界面或 CSS | 无局部改动，按 /docs 验收 | 原材料筛选保留 |
| /capture | router.tsx → KnowledgePage | 无独立界面 | 无局部改动，按 /knowledge 验收 | 仍进知识沉淀 |
| 未匹配路径 | router.tsx → HomePage | 通用回退，无独立界面 | 无局部改动 | 返回首页并保持权限边界 |

## 公共与嵌入组件

| 组件 | 样式来源与范围 | 验收 |
|---|---|---|
| Layout、PageTitle、ThemeToggle | 03 校准 index.css/a-theme.css 的标题、导航和焦点。保留绿色品牌控件，路由仅核对 | 亮暗、键盘、选中态和快捷操作正常 |
| EmptyState、Skeleton、ErrorNotice、Toast | 03 核对全局状态、背景及公共样式。布局无需统一重写 | 空/载入/错误/成功可分，重试和可访问状态正常 |
| Modal、ConfirmDialog | 03 消费通用标题/值/说明/动作区样式，保持所有现有关闭和确认行为 | Tab、Esc、遮罩、焦点归还、UX-01 忙碌保护正常 |
| EvidenceViewer、PdfPreview | 04 的 evidence-viewer.css 和 pdf-preview.css，区分摘录、位置、选中和确证命中 | 桌面右栏、抽屉、全屏、翻页/缩放、权限及降级正常 |
| DraftEditor、DiscoveryPanel | 04 保持嵌入位置，通过局部标题、正文、状态和来源样式改善扫读 | 编辑、发现与人工审核入口正常 |
| PersonPicker、RecordEdits、LedgerDeleteDialog | 05 使用局部样式区分选项、字段、值和审计，公共 Modal 样式只消费 | 搜索、键盘、确认及失败恢复不变 |

## 实施后的记录

逐行登记实际变更、视口、样例和验收状态。代表图选择问答、带右栏的检索、知识审核或整理、投稿台账、管理概览或 Trace。对照须使用同数据、同回答、同视口与同主题。其余页面保留矩阵记录。UX-04 与 UX-05 合并后在实际主线执行一次视觉一致性复查。
