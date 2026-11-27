# verify-next-actions 与 G0 基线逐项对照

对已验收的 G0 合并提交 `07642b4ab8e2c6eae0d3da8107af2ffe5833e3d5`（tree `545e7dcd7d711bba5cedb2fce0fa6ebc4a72f781`）在隔离库重跑同一命令。用于排名的 G0 早期 SHA 另见检索报告。两个 G0 提交的依赖锁、该检查器及涉及的工具文件无差异。

`npm.cmd run verify-next-actions -w @knowpilot/server`

| 批次 | 退出及断言 | 开始 UTC / 耗时 | 包内日志 / SHA-256 |
|---|---|---|---|
| G0 重跑 | 1 / 28 PASS、2 FAIL | 2026-11-27T10:42:02.892145+00:00 / 2.431 s | `g0/verify-next-actions/command.log`<br>`849b6ae673dc32b7c8e578ca9d3bc14e34bbf594d146073df9601e14610cbebb` |
| G5-A 首轮 | 1 / 28 PASS、2 FAIL | 首轮未采集逐命令时间 | `original/verify-next-actions/command.log`<br>`b589b78f0de48bc010c4fbc26de421895e0df49a62b6ce8250dbe92e03d5ac51` |
| G5-A 复跑 | 1 / 28 PASS、2 FAIL | 见[命令索引](commands.md) | `timed/verify-next-actions/command.log`<br>`3c4f480cbca8af05b61889448de842963d1bf1551c0146993e96a5a56a5a5dc7` |

| # | 断言原文 | G0 | G5-A 首轮 | G5-A 复跑 |
|---:|---|---|---|---|
| 1 | 台账 0 命中 → 一个「去登记投稿」出口 | PASS | PASS | PASS |
| 2 | 去登记投稿落到 /submissions | PASS | PASS | PASS |
| 3 | 出口带说明（为什么出现） | PASS | PASS | PASS |
| 4 | ★ 先没查到、后来查到了 → 不再给出口 | PASS | PASS | PASS |
| 5 | 报错的调用不算"0 命中" | PASS | PASS | PASS |
| 6 | 分区库 0 命中 → 去补录 | PASS | PASS | PASS |
| 7 | 补录落到 /journals | PASS | PASS | PASS |
| 8 | 数据集 0 命中 → 去登记数据集 | PASS | PASS | PASS |
| 9 | 登记数据集落到 /datasets | PASS | PASS | PASS |
| 10 | 两条记录都没查到 → 两个出口 | PASS | PASS | PASS |
| 11 | 顺序固定：台账在前、分区在后 | PASS | PASS | PASS |
| 12 | ★ 最多两个出口（不把回答下面变成一排按钮） | PASS | PASS | PASS |
| 13 | 只有零引用和依据缺口时不给上传提示 | PASS | PASS | PASS |
| 14 | 专利和大论文未匹配时引到对应台账 | PASS | PASS | PASS |
| 15 | 翻到空页时不会误报台账里没有匹配 | PASS | PASS | PASS |
| 16 | 查询异常时可以重试 | PASS | PASS | PASS |
| 17 | 有引用时不给"去上传" | PASS | PASS | PASS |
| 18 | 零引用但没列依据缺口 → 不给出口 | PASS | PASS | PASS |
| 19 | 所有出口都是站内路径（以 / 开头） | PASS | PASS | PASS |
| 20 | 所有出口都有文字与说明 | PASS | PASS | PASS |
| 21 | 同一输入重复调用结果完全一致（确定性） | PASS | PASS | PASS |
| 22 | 集成：真实 runAsk 装配后给出「去登记投稿」 | PASS | PASS | PASS |
| 23 | 集成：出口指向 /submissions | PASS | PASS | PASS |
| 24 | 集成：回答本身仍是零引用（出口不是靠正文猜的） | PASS | PASS | PASS |
| 25 | 专利 tool 按登记人查且不混入申请人 | FAIL | FAIL | FAIL |
| 26 | 发现线索之后登记新的核对任务 | PASS | PASS | PASS |
| 27 | 大论文返回题名/方向且不返回成绩 | FAIL | FAIL | FAIL |
| 28 | 模型提交的表格完整交付 | PASS | PASS | PASS |
| 29 | 每行保留各自的证据，默认交付无规则语义判定 | PASS | PASS | PASS |
| 30 | 专利和大论文证据都可由服务端核对 | PASS | PASS | PASS |

第 25 条与第 27 条在 G0 和两次 G5-A 运行均失败。前者约束按登记人匹配并排除申请人字段，后者仍按历史脚本期望大论文返回题名和方向且不返回成绩。两条断言原样执行，结果原样保留。本轮没有业务代码或断言变更。
