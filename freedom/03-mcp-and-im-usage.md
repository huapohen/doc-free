# Doc Free MCP 与 agent-native-IM 接入手册

## 1. MCP 端点

Doc Free 提供 HTTP JSON-RPC MCP：

```text
POST http://localhost:3210/mcp
Authorization: Bearer <设备令牌>
Content-Type: application/json
```

公网时把 host 换成当前 Quick Tunnel 域名。协议支持 `initialize`、`tools/list`、`tools/call`。所有请求都需要设备令牌。

## 2. 当前 Doc Free 工具完整清单

### 工作空间与本地文档

| 工具 | 参数 | 当前行为 |
|---|---|---|
| `list_document_apps` | 无 | 返回 Doc Free、AFFiNE、Docmost 入口 |
| `list_documents` | 无 | 列出本地文档 ID、标题、更新时间 |
| `read_document` | `document_id` | 读取本地标题、Markdown 正文、更新时间 |
| `create_document` | `title`, `content?` | 创建本地 Markdown 文档 |
| `replace_document` | `document_id`, `content` | 替换本地内容并保留历史 |
| `append_to_document` | `document_id`, `content` | 向本地文档末尾追加并保留历史 |
| `list_blocks` | `document_id` | 返回稳定块 ID、顺序和内容 |
| `read_block` | `document_id`, `block_id` | 读取一个精确块 |
| `replace_block` | `document_id`, `block_id`, `content` | 替换一个块并同步 CRDT/AFFiNE/Docmost |
| `insert_after_block` | `document_id`, `block_id`, `content` | 在指定块后插入并同步三端 |
| `search_documents` | `query` | 搜索本地 + AFFiNE + Docmost 的标题/正文 |
| `list_all_documents` | 无 | 返回三端服务器侧文档集合 |
| `read_external_document` | `document_id` | 读取 `affine:...` 或 `docmost:...` 文档 |

### Docmost 适配器

| 工具 | 参数 | 当前行为 |
|---|---|---|
| `create_docmost_document` | `title`, `content?`, `space_id?` | 调用正式 `pages/create`；未提供 space 时使用首个 space |
| `update_docmost_document` | `document_id`, `title?`, `content?`, `operation?` | 调用正式 `pages/update`；operation 支持 `replace/append/prepend` |

Docmost 读取通过 `read_external_document` 的 `docmost:<pageId>` 路径调用正式 `pages/info`。

### AFFiNE 官方 MCP 适配器

| 工具 | 参数 | 当前行为 |
|---|---|---|
| `create_affine_document` | `title`, `content` | 调用 AFFiNE 官方 `create_document` |
| `update_affine_document` | `document_id`, `content` | 调用官方 `update_document`，结构化差异写入正文 |
| `rename_affine_document` | `document_id`, `title` | 调用官方 `update_document_meta` |
| `read_affine_document` | `document_id` | 调用官方 `read_document` |
| `search_affine_documents` | `query`, `document_ids?`, `limit?` | 调用官方 `doc_search`；限制 1–20 |

AFFiNE 原生工具的当前上游范围：读取、词法/持久化文档搜索、创建 Markdown 文档、结构化更新正文、更新标题。官方描述明确：当前创建/更新不支持数据库块和图片。

## 3. 工具边界与 ID 格式

- 本地 ID：`docfree:<localId>`（调用本地读写工具时传裸 `localId`）。
- AFFiNE ID：搜索结果常见 `affine:<workspaceId>:<pageId>`；写工具可接受带前缀 ID，服务端会剥离前缀。
- Docmost ID：`docmost:<pageId>`；写工具同样会剥离前缀。
- 设备令牌是共享访问凭据，不能放进前端公开代码、IM 消息或日志。

## 4. agent-native-IM 如何接入（未来独立集成）

agent-native-IM 已经是独立系统，当前 Doc Free 不集成、不复制其 UI、身份或消息能力。未来集成时，推荐把 Doc Free 注册为 IM 的“文档工具服务”，而不是在每个 Agent 里复制 AFFiNE/Docmost 凭据：

```json
{
  "name": "doc_free",
  "transport": "streamable_http",
  "url": "https://<当前公网域名>/mcp",
  "headers": {"Authorization": "Bearer <由管理员注入的令牌>"},
  "capabilities": ["tools/list", "tools/call"]
}
```

IM 消息路由建议：

1. 人或 Agent 在群里提及 `@doc_free`。
2. IM 解析当前群、当前文档 ID、actor ID、权限和消息线程。
3. IM Agent 先调用 `read_document` 获取上下文。
4. 需要自然语言编辑时调用 IM 自己的 `@doc_free` bridge（或 POST `/api/agent`）；不要让客户端直接伪造内部同步请求。
5. 将 Agent 运行状态、工具调用摘要和结果写回同一群线程。

## 5. 人和 Agent 同权模型（目标方案）

IM 应把人和 Agent 都建模成 actor：

```json
{
  "actor_id": "agent-reviewer-01",
  "actor_type": "agent",
  "display_name": "Reviewer",
  "requested_by": "alice",
  "group_id": "g-123",
  "document_id": "810c55de",
  "capability": "document.edit"
}
```

同权不等于无审计：当前 Doc Free 的 MCP 写工具已支持 `actor_id`、`requester_id`、`base_version`、`idempotency_key`，并记录 revision 与审计事件。未来 IM gateway 负责把自己的 actor、群组、线程和权限上下文可靠地映射到这些字段；目标端及同步结果由 Doc Free 自己记录和返回。

## 6. P0/P1 当前完成状态

群聊、网页 REST、MCP 整篇写入和 MCP 块级写入现在都进入 Hocuspocus/Yjs command bus，并广播在线文档事件。MCP 写工具支持 `actor_id`、`requester_id`、`base_version`、`idempotency_key`，服务端记录 revision 和审计事件。IM 的统一身份/权限不属于当前 Doc Free 范围，未来由独立适配层把 IM actor 映射到这些字段。
