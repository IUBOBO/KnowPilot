# KnowPilot V2 最终质量矩阵

复核基线为 `23da592b9b21fdb05d0dfd08778351a7da7a184c`。通过 GitHub 核对功能 PR 的实际合并 SHA、目标分支和 Issue 状态，通过本地 Git 核对提交属于 main 历史，与执行状态一致。本矩阵核对已有记录和本轮用户反馈。

## G0–G5 阶段报告

阶段验收 SHA 引用对应的功能或基线提交。后续文档 PR 单列。

| 阶段 | 状态 | 已有验收 SHA | 主要关联 PR | 归档覆盖 |
|---|---|---|---|---|
| [G0](../../gates/G0.md) | 已验收 | `07642b4ab8e2c6eae0d3da8107af2ffe5833e3d5` | [#15](https://github.com/IUBOBO/KnowPilot/pull/15)、[#16](https://github.com/IUBOBO/KnowPilot/pull/16) | 改造前合成基线及权限评分修正，合并后复验归档。 |
| [G1](../../gates/G1.md) | 已验收 | `37556f2f894935a25c56c26003dbd265cdec13db` | [#17](https://github.com/IUBOBO/KnowPilot/pull/17)、[#18](https://github.com/IUBOBO/KnowPilot/pull/18)、[#19](https://github.com/IUBOBO/KnowPilot/pull/19) | 检索协议与问答壳分别在实际合并提交回归。 |
| [G2](../../gates/G2.md) | 已验收 | `026bf1dfa060aa359a5ed8e1b7d709494a13625e` | [#21](https://github.com/IUBOBO/KnowPilot/pull/21)、[#20](https://github.com/IUBOBO/KnowPilot/pull/20)、[#23](https://github.com/IUBOBO/KnowPilot/pull/23)、[#26](https://github.com/IUBOBO/KnowPilot/pull/26)、[#25](https://github.com/IUBOBO/KnowPilot/pull/25)、[#28](https://github.com/IUBOBO/KnowPilot/pull/28)、[#27](https://github.com/IUBOBO/KnowPilot/pull/27)、[#29](https://github.com/IUBOBO/KnowPilot/pull/29) | 检索、动态回答和证据阅读的闭环及实际合并复验。 |
| [G3](../../gates/G3.md) | 已验收 | `ac2a9a4e3de439f7f5ff67a085348371bc6e65b8` | [#30](https://github.com/IUBOBO/KnowPilot/pull/30)、[#32](https://github.com/IUBOBO/KnowPilot/pull/32)、[#33](https://github.com/IUBOBO/KnowPilot/pull/33)、[#34](https://github.com/IUBOBO/KnowPilot/pull/34) | 研究笔记、导出、知识草稿及 SQLite v36→v37 的备份恢复。 |
| [G4](../../gates/G4.md) | 已验收 | `43723bd4cc354e71661ac791f456afddfe7f6b20` | [#35](https://github.com/IUBOBO/KnowPilot/pull/35)、[#36](https://github.com/IUBOBO/KnowPilot/pull/36) | 主动发现与审核、SQLite v37→v38、原件权限和索引隔离。 |
| [G5](../../gates/G5.md) | 最终验收待审 | 待最终合并核对 | [#37](https://github.com/IUBOBO/KnowPilot/pull/37)、[#38](https://github.com/IUBOBO/KnowPilot/pull/38) | 离线证据和整体手测已归档，三项 G5-B 自测结果已由用户确认，最终门禁待审。 |

## Issue #1–#12 合并核对

| Issue | 功能 PR | 实际合并 SHA | 状态 |
|---|---|---|---|
| [#1](https://github.com/IUBOBO/KnowPilot/issues/1) | [#17](https://github.com/IUBOBO/KnowPilot/pull/17) | `737312dd43dbd5d1e8d84badc9cb871919376c4b` | 已合并至 main｜已验收｜Issue 已关闭 |
| [#2](https://github.com/IUBOBO/KnowPilot/issues/2) | [#18](https://github.com/IUBOBO/KnowPilot/pull/18) | `37556f2f894935a25c56c26003dbd265cdec13db` | 已合并至 main｜已验收｜Issue 已关闭 |
| [#3](https://github.com/IUBOBO/KnowPilot/issues/3) | [#21](https://github.com/IUBOBO/KnowPilot/pull/21) | `e79559903f909c4166fb9f21616c7b12d686744c` | 已合并至 main。与 [#23](https://github.com/IUBOBO/KnowPilot/pull/23) 联动回归后完成全量验收，Issue 已关闭。 |
| [#4](https://github.com/IUBOBO/KnowPilot/issues/4) | [#23](https://github.com/IUBOBO/KnowPilot/pull/23) | `7e7b8b4cb206b1c00856bd15fa78f9f1b5ceb9d3` | 已合并至 main｜已验收｜Issue 已关闭 |
| [#5](https://github.com/IUBOBO/KnowPilot/issues/5) | [#26](https://github.com/IUBOBO/KnowPilot/pull/26) | `3fb1a2d82ec2db9a3ffd835759d874949e7889a5` | 已合并至 main｜已验收｜Issue 已关闭 |
| [#6](https://github.com/IUBOBO/KnowPilot/issues/6) | [#20](https://github.com/IUBOBO/KnowPilot/pull/20) | `d1013c3e72f3844acea43ee808cf1ac480658aab` | 已合并至 main｜已验收｜Issue 已关闭 |
| [#7](https://github.com/IUBOBO/KnowPilot/issues/7) | [#25](https://github.com/IUBOBO/KnowPilot/pull/25) | `aa0fe140a9678a388472a2ab932f8e72be9f7d74` | 已合并至 main｜已验收｜Issue 已关闭 |
| [#8](https://github.com/IUBOBO/KnowPilot/issues/8) | [#28](https://github.com/IUBOBO/KnowPilot/pull/28) | `026bf1dfa060aa359a5ed8e1b7d709494a13625e` | 已合并至 main｜已验收｜Issue 已关闭 |
| [#9](https://github.com/IUBOBO/KnowPilot/issues/9) | [#30](https://github.com/IUBOBO/KnowPilot/pull/30) | `33d52b998423970a29871c273cabad05665e90f0` | 已合并至 main｜已验收｜Issue 已关闭 |
| [#10](https://github.com/IUBOBO/KnowPilot/issues/10) | [#32](https://github.com/IUBOBO/KnowPilot/pull/32) | `698563be60ea19ebe395c7b3266416c8ad27c66a` | 已合并至 main｜已验收｜Issue 已关闭 |
| [#11](https://github.com/IUBOBO/KnowPilot/issues/11) | [#33](https://github.com/IUBOBO/KnowPilot/pull/33) | `ac2a9a4e3de439f7f5ff67a085348371bc6e65b8` | 已合并至 main｜已验收｜Issue 已关闭 |
| [#12](https://github.com/IUBOBO/KnowPilot/issues/12) | [#35](https://github.com/IUBOBO/KnowPilot/pull/35) | `43723bd4cc354e71661ac791f456afddfe7f6b20` | 已合并至 main｜已验收｜Issue 已关闭 |

## Issue #13 五项验收对照

| 验收项 | 可核对证据 | 待审事项 |
|---|---|---|
| 1. 改造前基线可复现，召回与最终引用分开 | 24 道同语料题和 33 项金标、原始排名/首次入池/准备上下文指标，以及独立 8 块范围问答的实际模型桩输入和引用证据。[G0 基线](../../gates/G0.md) · [检索分层](../g5-a/retrieval.md) | 成对性能采样、24 题的实机上下文与完整终稿引用未测。BGE-M3 通过为用户自测反馈，实机指标未提供。 |
| 2. 正常、异常、权限、虚假引用与数值、旧协议、无精确高亮和未确认草稿 | G5-A 命令及合成端到端回归已归档。GC-08、GC-09 各自有用户自测通过反馈。[命令与证据索引](../g5-a/commands.md) · [用例记录](../g5-a/cases.md) | 保留 39 INCOMPLETE、5 NOT_IMPLEMENTED、124 条 NOT_RUN 断言与两条历史失败。G5-A 的 CLI 结果不随 G5-B 手测反馈重算。 |
| 3. UI 关键链路及必要的人工复现证据 | 浏览器闭环和合成资料复现步骤已归档，G5-A 整体手测由用户确认通过。[G4 演示](../../gates/G4.md) · [G5-A 核对](../../gates/G5.md#g5-a-人工确认) | G5 人工逐链路复现步骤和截图未提供，人工证据保留整体确认，逐项未确认的手测留空。 |
| 4. 实机与离线分列，统计失败、跳过、未执行及成本 | G5-A 自动化及人工结果分列，Codex 云端预检为 0 次调用、0 Token 和 USD 0.00。用户确认两项真实模型用例（GC-08、GC-09）和一项本地向量用例（BGE-M3）均通过。离线命令索引为 33 通过、1 失败，记录中无命令级跳过。[G5-B 回填](../../gates/G5.md#逐项回填) | 供应商响应、实付、模型与权重版本、Token、指标、耗时、用户实机请求、失败或跳过次数及原始文件 SHA-256 未提供，待审本次证据范围。 |
| 5. 各阶段 PR 有回归、最终报告可审查 | 上表 12 项功能合并与 G0–G4 报告相符。G5-A 两轮 33/34 的结果和 G0 两条历史断言有归档。 | 最终 PR 待批准。在实际合并 SHA 回归通过并获 G5 人工验收后才登记 G5.pass。关闭 #13 另需授权。 |

[已知问题和未完成项](known-issues.md) · [V2-13 Plan](../../V2-13.md) · [执行状态](../../EXECUTION-STATE.json)
