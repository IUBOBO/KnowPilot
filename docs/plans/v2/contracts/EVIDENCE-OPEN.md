# 3-4.contract-frozen｜证据打开回调 v1

适用于 G1 合并基线 `37556f2f894935a25c56c26003dbd265cdec13db`。#3 回答组件和 #4 证据阅读器负责人均确认本契约。复用 #1 的 `EvidenceLocator`、服务端回填的 `Citation` 和 #2 现有问答插槽。

## 输入与处理

- `EvidenceOpenRequest` 携带 `version: 1`、`locator: EvidenceLocator`，引用入口另带 `citation: { runId, citationId }`。文档定位含 `documentId`、`chunkId` 和 `sourceVersion`，台账定位含 `recordType`、`recordId` 和 `sourceVersion`。
- `citationEvidenceRequest(runId, citation)` 只从当前答复服务端回填的引用生成意图。块只能引用该答复中的证据 ID。正文、表格和动态块共用身份绑定。搜索入口从当前可见命中构造定位，保持来源列表由宿主持有。
- `OpenEvidence` 同步返回布尔值。返回真表示宿主已接管打开操作，授权、取证和状态更新仍由阅读器异步完成。宿主核对版本、运行 ID、证据 ID 与当前名单中的定位完全一致。版本未知、定位失效、引用缺失或回调未安装时，保留已有可用链接或中性提示。
- 请求不含模型文本、任意 URL 或高亮坐标。阅读器重新按登录会话访问授权接口，拒绝或失效时清除旧内容。摘录须在同版本授权正文中唯一精确匹配，才能高亮。无匹配或版本发生变化时显示可用的原文/页码和明确提示。旧历史仍保留既有打开路径。
- #3 N3 只验证模拟阅读器和安全降级。#4 N1/N2 可用冻结契约和 fixture 开发。真实回调联调等 `3.released`，`3.full-accepted` 等待 #4 联调及合并后回归。

## 验证

冻结时用合成文档和台账检查映射、缺失版本或运行 ID 的拒绝、以及跨版本和跨来源定位不相等。#3/#4 各自重跑类型检查和节点用例。
