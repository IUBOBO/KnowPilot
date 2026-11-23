# KnowPilot

KnowPilot 是实验室知识协作工具。它支持本地文档入库、检索与带出处问答，管理投稿、专利、人员和学位论文台账，并提供 Excel 草稿导入和导出。

前端使用 React 和 Vite，后端使用 Hono 和 SQLite。问答通过 Pi Agent 调用本地检索与业务工具。文档向量保存在 SQLite 中，检索时由服务进程计算相似度。

## 本地启动

安装 Node.js 22.19 或更高版本，以及随 Node.js 提供的 npm。在项目根目录执行：

```sh
npm ci
```

将 `.env.example` 复制为 `.env`。填入 `KNOWPILOT_ADMIN_USER` 和 `KNOWPILOT_ADMIN_PASSWORD`，使用一组新的本地账号和密码。服务首次启动时会建库并创建管理员。

在两个终端分别运行：

```sh
npm run dev:server
npm run dev:web
```

在浏览器打开 `http://localhost:5173`。后端健康检查地址为 `http://127.0.0.1:3000/health`。

- 配置自己的 `DEEPSEEK_API_KEY` 后，可以使用问答、知识草稿和数据集整理计划。
- 运行 `npm run fetch-model -w @knowpilot/server` 下载本地向量模型。对已有资料可运行 `npm run embed -w @knowpilot/server` 补建向量。没有权重时仍可以进行关键词检索。
- 期刊分区可在页面手工录入。批量导入可运行 `npm run seed-journals -w @knowpilot/server -- --file path/to/journals.json`，输入文件应为有权使用的本地数据。文件结构见 [虚构测试样例](apps/server/src/submissions/seed/journals.example.json)。

## 构建与检查

```sh
npm run typecheck
npm run build -w @knowpilot/web
npm run verify-journal -w @knowpilot/server
npm run verify-auth -w @knowpilot/server
```

数据库和上传原件默认保存在 `data/`，模型权重默认保存在 `.cache/`。需要将模型和大型数据集放到数据盘时，可在 `.env` 中配置 `HF_HOME` 和 `DATA_ROOT`。模型问答可能向你配置的模型服务发送问题和相关资料片段，请使用适合该服务处理的资料。公开部署前请配置 HTTPS 和安全 Cookie，并复核访问范围。
