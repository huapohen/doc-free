# Doc Free

> **Evolve 0.2 · 2026-09-06**：新增与 [Active Agent](https://github.com/huapohen/active-agent/tree/evolve) 配合的纯文档工作台 `/workbench`。任务、依据、提案和结果都是可见文档；支持持续观察、人工审阅、版本冲突保护与恢复。本轮不接入或扩展 IM。使用两个仓库的 `evolve` 分支，详见 [新版演进文档](docs/evolve/README.md)。以下内容保留原有产品说明。

本地优先、Agent-native 的团队文档工作空间，采用调研中的 Tiptap + Yjs + Hocuspocus + MCP 路线。浏览器编辑器由本地 npm 依赖打包，不依赖 CDN；协作 WebSocket 经同源 `/collab` 代理，可通过同一个公网域名工作。

## 启动

```bash
npm start
npm run start:collab
```

启动日志会输出本机地址、MCP 地址和设备令牌。令牌只保存在进程环境/浏览器 localStorage，不写入仓库。数据保存在 `data.json`（已加入 gitignore）。

## 多人协作与群聊 Agent

打开页面后输入显示名称和工作空间访问令牌。不同电脑进入同一个文档后会显示在线成员，正文修改通过 Yjs + Hocuspocus 实时同步，右侧群聊也会广播给所有成员。

在群聊中使用 `@doc_free` 即可让 Agent 操作当前文档。多个人可以同时点名：模型任务并行执行，每个任务以启动时的正文为基线，提交前重新读取 Hocuspocus 中的最新 CRDT 正文，再将自己的变化 rebase 到最新版本。非重叠变化自动合并；补丁上下文确实冲突时，Agent 会基于最新正文重新规划，而不是静默覆盖其他成员。

Agent 默认同步到：

- Doc Free 本地文档与历史版本
- AFFiNE 官方 MCP/DocWriter（CRDT 安全写入）
- Docmost 正式页面 API

首次同步会在 AFFiNE 和 Docmost 创建对应文档并记录 ID；后续指令复用这组 ID 更新原文，不会重复创建。用户明确说“只更新 AFFiNE”“不要同步 Docmost”或“仅本地”时，模型会调整目标。左侧“一键测试”提供成语接龙和故意包含大量错误的 writing agents 英语作文。

模型配置优先读取进程环境和已忽略的 `.env.agent`，格式参考 `.env.agent.example`。

## MCP

HTTP JSON-RPC endpoint：`POST /mcp`，请求头 `Authorization: Bearer <设备令牌>`。支持 `initialize`、`tools/list` 以及文档的 list/read/create/replace/append/search 工具，可直接接入支持自定义 MCP server URL 的 Codex/Claude 客户端。

Docmost 已通过正式 `/api/pages/create`、`/api/pages/update`、`/api/pages/info` 接入，MCP 工具为 `create_docmost_document`、`update_docmost_document` 和 `read_external_document`。

AFFiNE 已接入 stable 镜像自带的原生 MCP endpoint `/api/workspaces/:workspaceId/mcp`。Compose 使用 `AFFINE_ENV=dev` 开启官方 CRDT 安全写工具，读写凭据保存在已忽略的 `integration-auth.json`，有效期一年。Doc Free 提供：

- `create_affine_document`
- `update_affine_document`
- `rename_affine_document`
- `read_affine_document`
- `search_affine_documents`

其中创建和更新由 AFFiNE 的 `DocWriter` 执行；正文更新使用结构化差异算法，保留文档历史并兼容 Yjs 实时协作，不直接修改 AFFiNE 数据库。

AFFiNE 原生 `doc_search` 使用 Compose 内的 Manticore Search 做全文索引；首次部署会自动执行 AFFiNE 自带的数据迁移来创建索引表，并为已有工作区回填索引。没有配置向量模型时会使用官方 lexical 模式，不影响全文搜索。

## 公网

执行 `./start-public.sh` 会检查并启动文档服务、Hocuspocus 协作服务，然后建立 Cloudflare Tunnel。同一公网域名承载网页、`/group` 群聊 WebSocket、`/collab` CRDT WebSocket 和 `/mcp`。公网访问仍受设备令牌保护；Quick Tunnel 地址在进程重启后会变化，长期固定域名需要绑定 Cloudflare 账户并创建 named tunnel。

## AFFiNE + Docmost

版本二部署文件为 `docker-compose.affine-docmost.yml`：AFFiNE 在 `3010`，Docmost 在 `3020`，Manticore Search 仅在 Docker 内网提供索引服务。复制 `.env.affine-docmost.example` 为 `.env.affine-docmost` 并设置随机密码，再执行 `./deploy-affine-docmost.sh`。Docker Desktop 必须保持运行。
