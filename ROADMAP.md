# KnowPilot V2 — 智能检索、动态问答与知识沉淀闭环

## 已确认的产品决策
- 保留「智能问答」和「知识检索」两个入口，共享检索与证据访问底座。知识检索保持快速、可筛选且无需 LLM 的路径；智能问答支持多轮上下文、任务规划和动态组件。
- 原左侧导航保留，中央问答，右侧按需展开证据阅读器。知识库下可组织资料、正式知识、研究笔记、知识沉淀，其他科研管理功能不变。
- 回答先做好中文排版与安全 Markdown；Agent 根据意图与真实证据组合文档列表、表格、图表、时间线等白名单组件。简单问题仍以自然文本回答。
- 检索过程基于真实工具事件，默认简洁、可展开，管理员可查看脱敏 Trace。仅显示实际执行，不展示虚构过程。
- 原文侧边栏统一承载片段、PDF 及记录视图。PDF 先按页定位，再做可靠文字匹配高亮；匹配不确定时明确降级。
- 研究笔记是默认私有、可编辑、可溯源的系统对象；Markdown/PDF 为导出方式。笔记与问答不自动进入公共索引。
- 知识沉淀从手动输入扩展为多入口、主动发现、去重、更新与冲突提案，保留人工确认和原有入库机制。

## 技术边界
复用现有 React、TypeScript、Hono、SQLite、Pi Agent、TypeBox、BM25/向量/RRF 与可选 reranker。以当前本地源码核对路径与实现，并与远程 `main` 对照版本差异。本路线图记录产品决策与任务入口；调度以 [Master Plan](docs/plans/v2/MASTER-PLAN.md) 和 [DAG](docs/plans/v2/DEPENDENCIES.json) 为准。暂不改换框架、引入 GraphRAG、多 Agent、独立向量库，不包含台账自动登记、训练自动化或大范围科研管理页面重构。

## 任务清单
13 个任务均已提交到 [IUBOBO/KnowPilot](https://github.com/IUBOBO/KnowPilot/issues)。下表记录实际编号、前置依赖和联调关系。

| 任务编号 | GitHub Issue | 优先级 | 主题 | 开工 / 联调或合并条件 |
|---|---|---|---|---|
| V2-01 | [#1](https://github.com/IUBOBO/KnowPilot/issues/1) | P0 | 统一检索服务与证据数据协议 | G0；无功能依赖 |
| V2-02 | [#2](https://github.com/IUBOBO/KnowPilot/issues/2) | P0 | 智能问答页面与回答排版重构 | G0；与 [#1](https://github.com/IUBOBO/KnowPilot/issues/1) 可并行 |
| V2-03 | [#3](https://github.com/IUBOBO/KnowPilot/issues/3) | P0 | Generative UI 动态回答组件体系 | G1；[#1](https://github.com/IUBOBO/KnowPilot/issues/1)、[#2](https://github.com/IUBOBO/KnowPilot/issues/2)；与 [#4](https://github.com/IUBOBO/KnowPilot/issues/4) 共冻契约，阶段性 PR 用 `Refs #3` |
| V2-04 | [#4](https://github.com/IUBOBO/KnowPilot/issues/4) | P0 | 统一证据侧边栏阅读器与引用联动 | G1；[#1](https://github.com/IUBOBO/KnowPilot/issues/1)、[#2](https://github.com/IUBOBO/KnowPilot/issues/2)；N3 与合并等待 [#3](https://github.com/IUBOBO/KnowPilot/issues/3) 契约合并回归 |
| V2-05 | [#5](https://github.com/IUBOBO/KnowPilot/issues/5) | P0 | PDF 内嵌、页码定位与原文高亮 | G1；[#4](https://github.com/IUBOBO/KnowPilot/issues/4) |
| V2-06 | [#6](https://github.com/IUBOBO/KnowPilot/issues/6) | P0 | 检索执行过程可视化 | G1；[#1](https://github.com/IUBOBO/KnowPilot/issues/1)、[#2](https://github.com/IUBOBO/KnowPilot/issues/2) |
| V2-07 | [#7](https://github.com/IUBOBO/KnowPilot/issues/7) | P0 | 知识检索结果页面优化 | G1；[#1](https://github.com/IUBOBO/KnowPilot/issues/1)、[#4](https://github.com/IUBOBO/KnowPilot/issues/4) |
| V2-08 | [#8](https://github.com/IUBOBO/KnowPilot/issues/8) | P1 | 检索与问答的上下文互通 | G1；[#3](https://github.com/IUBOBO/KnowPilot/issues/3)、[#4](https://github.com/IUBOBO/KnowPilot/issues/4)、[#7](https://github.com/IUBOBO/KnowPilot/issues/7)；#1 是传递依赖 |
| V2-09 | [#9](https://github.com/IUBOBO/KnowPilot/issues/9) | P1 | 研究笔记与编辑功能 | G2；[#3](https://github.com/IUBOBO/KnowPilot/issues/3)、[#4](https://github.com/IUBOBO/KnowPilot/issues/4) |
| V2-10 | [#10](https://github.com/IUBOBO/KnowPilot/issues/10) | P1 | Markdown、PDF 研究笔记导出 | G2；[#9](https://github.com/IUBOBO/KnowPilot/issues/9) |
| V2-11 | [#11](https://github.com/IUBOBO/KnowPilot/issues/11) | P1 | 多入口知识草稿生成 | G2；[#9](https://github.com/IUBOBO/KnowPilot/issues/9)；与 #10 可独立并行，入口串行接线 |
| V2-12 | [#12](https://github.com/IUBOBO/KnowPilot/issues/12) | P1 | 主动知识发现、去重与冲突增强 | G3；[#11](https://github.com/IUBOBO/KnowPilot/issues/11) |
| V2-13 | [#13](https://github.com/IUBOBO/KnowPilot/issues/13) | P0 | 检索、引用、动态组件端到端评测 | A 等基线与规划合并；B 按每个功能 PR 合并前/后验收；C 等 G4 和 #1–#12 全部验收合并 |

## 阶段与波次
- [G0](docs/plans/v2/gates/G0.md)：基线、规划和 13-A 通过后的首波是 #1/#2；[G1](docs/plans/v2/gates/G1.md) 通过后推进 #3/#4/#6。
- [G2](docs/plans/v2/gates/G2.md)：#4 后做 #5/#7，#3 完整联调、#4 与 #7 完成后做 #8；G2 通过后做 #9。
- [G3](docs/plans/v2/gates/G3.md)：#9 后推进 #10/#11，G3 通过后做 #12；[G4](docs/plans/v2/gates/G4.md) 通过后执行 13-C，最终验收见 [G5](docs/plans/v2/gates/G5.md)。

## 需求与计划管理
V2-01～13 是稳定业务编号，不是 GitHub 实际 Issue 号。本表维护实际 Issue 链接及关键门禁；各节点依赖以 DAG 为准。正式需求以 GitHub Issue 最新正文和确认的讨论为准；如需偏离，先更新 Issue/Plan。V2 的 13 份初始 Plan 先统一评审，开工前核验并记录修订，任务独立提交 PR。未验收不得标记完成。

## 完成标准
各 Issue 验收项逐项满足；保留原功能与权限；可追溯证据；旧数据兼容；真实测试结果、UI 截图（涉及 UI）、回归报告及已知限制可审查。
