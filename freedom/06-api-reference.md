# Doc Free API 参考与调用样例

## 1. MCP 初始化

```bash
curl -sS http://localhost:3210/mcp \
  -H 'Authorization: Bearer <DEVICE_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

然后调用 `tools/list` 获取当前服务端实际清单。不要在代码中硬编码可能变化的工具集合。

## 2. 调用本地文档

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "tools/call",
  "params": {
    "name": "read_document",
    "arguments": {"document_id": "810c55de"}
  }
}
```

创建和追加：

```json
{"name":"create_document","arguments":{"title":"Agent 会议纪要","content":"## 决策\n"}}
{"name":"append_to_document","arguments":{"document_id":"810c55de","content":"## 下一步\n"}}
```

## 3. 外部文档 ID 示例

```text
affine:779fabb1-3e57-4164-af4c-1ed50153e16a:<pageId>
docmost:<pageId>
```

先用 `list_all_documents` 或 `search_documents` 获取 ID，再调用 `read_external_document`。写 AFFiNE 时也可以使用裸 page ID；服务端会处理常见前缀。

## 4. AFFiNE 原生 MCP 直连（仅适配器内部使用）

```text
POST http://localhost:3010/api/workspaces/<workspaceId>/mcp
Authorization: Bearer <AFFINE_MCP_CREDENTIAL>
```

当前原生工具：`read_document`、`doc_search`、`create_document`、`update_document`、`update_document_meta`。Doc Free 已把这些封装成自己的 `*_affine_document` 工具，IM Agent 应优先使用 Doc Free MCP，避免持有 AFFiNE 凭据。

## 5. Docmost 正式 API（仅适配器内部使用）

当前服务端使用：

- `POST /api/pages/create`：`spaceId`, `title`, `content`, `format: "markdown"`
- `POST /api/pages/update`：`pageId`, `title?`, `content?`, `format: "markdown"`, `operation: replace|append|prepend`
- `POST /api/pages/info`：`pageId`, `format: "markdown"`

Docmost 的 cookie 和数据库凭据只保存在本机被忽略的文件中，不应交给 IM Agent。

## 6. WebSocket 事件

### `/group`

客户端首次发送：

```json
{"type":"auth","token":"<DEVICE_TOKEN>","name":"Alice","documentId":"810c55de"}
```

随后支持：

```json
{"type":"focus","documentId":"810c55de"}
{"type":"chat","text":"@doc_free 检查这一段","documentId":"810c55de","currentTitle":"标题","currentContent":"当前草稿"}
```

服务端广播：`ready`、`presence`、`chat`、`agent_status`、`document`、`docs_changed`。

### `/collab`

Hocuspocus/Yjs 原生 WebSocket。文档名为 `doc-<localId>`，token 使用同一设备令牌；Tiptap provider 设置 awareness 的 `user.name` 和 `user.color`。

## 7. agent-native-IM Gateway 建议接口

建议 IM 不直接把浏览器的 `currentContent` 当作可信事实，而是先读取 CRDT 最新值：

```http
POST /internal/document-agent-run
Authorization: Bearer <IM_SERVICE_TOKEN>
Content-Type: application/json
```

```json
{
  "document_id":"810c55de",
  "instruction":"检查所有语法错误并给出修改稿",
  "actor":{"id":"agent-reviewer-01","type":"agent","display_name":"Reviewer"},
  "requested_by":"alice",
  "group_id":"g-123",
  "thread_id":"t-456",
  "base_version":"server-revision-or-yjs-state-vector",
  "idempotency_key":"g-123:t-456:message-789"
}
```

当前代码还没有这个独立 endpoint；这是推荐的下一版 gateway contract。当前可用替代方案是 IM 调用 MCP 读取后，再调用现有 `/api/agent` 或由群聊 `/group` 提及触发。

## 8. 错误与重试

- `401 Unauthorized`：设备令牌无效或未提供。
- `当前文档不存在`：local ID 不存在。
- `模型请求失败`：检查模型端点、网络和本机 `.env.agent`，不要输出完整 Key。
- `AFFiNE/Docmost failed`：Agent 结果仍可能已写入本地/CRDT；查看群聊执行结果和 `actions`，再单独重试外部同步。
- 并发真实冲突：服务端会基于最新正文重规划；仍冲突时返回“同一区块发生并发冲突，请重试这条指令”。
