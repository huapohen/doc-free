# Doc Free 0.2：人和主动 Agent 共享文档

> 文档序列：`evolve / 2026-09-06 / v0.2`
>
> 编写时间：`2026-09-06T02:50:08+08:00`（Asia/Shanghai）
>
> Active Agent 实现：[`c05f904`](https://github.com/huapohen/active-agent/commit/c05f904f0ec11d680d5527e37519e1836ccba0af) · `2026-09-06T02:41:10+08:00` · feat: evolve proactive agents around visible collaborative documents
>
> Doc Free 实现：[`f5c3b6f`](https://github.com/huapohen/doc-free/commit/f5c3b6f0cdbf03b74895d6e3884154578b8ceb3f) · `2026-09-06T02:41:11+08:00` · feat: add document-native workspace for proactive agent collaboration
>
> Doc Free 源码排版：`b182142` · `2026-09-06T02:42:03+08:00`
>
> 旧版资料保留，新版结论以本序列的实现、验证和限制为准。

## 新增入口

`/workbench` 是独立的纯文档工作台。人通过真实 Tiptap/Yjs 编辑器写正文，通过文档卡片设定目标、暂停和审阅。Agent 通过同一 Workspace API 读取可见契约，自动产生提案。

## 快速运行

使用两个仓库的 evolve 分支。在 Doc Free 执行 `npm ci`，在 Active Agent 配置忽略的 `.env` 并执行：

```bash
python scripts/dev_workspace.py --doc-free ../doc-free
```

本机使用下划线目录时改为 `../doc_free`。组合启动器使用 3217/1237 端口和独立的演示数据。

## 接口与实现

- `work-protocol.js`：从普通文档中的 active-agent 块读取任务和提案语义。
- `workspace.js`：来源、任务、提案、观察和接受/拒绝；复用文档写内核。
- `workspace-mcp.js`：七个 `active_doc_*` 工具，与 REST 共用业务路径。
- `collab-server.js`：事务内比较正文、标题、CRDT 状态，并保存提案提交回执。
- `server.js`：最新 CRDT 投影、可重放文档事件、心跳和工作台资源。

新工作流不调用旧版 AFFiNE/Docmost 自动同步，不扩展群组或 IM 消息逻辑，也不从其他项目路径加载模型凭据。

## 验证

```bash
npm test
npm run build
```

12 个测试使用隔离 HTTP/CRDT 服务，覆盖重复投递、旧版本、接受/拒绝、引用真实性、纯 CRDT 变化、相同文本的不同 CRDT 状态、MCP 一致性、重启和回执恢复。实际浏览器和 gpt-6-astra / medium 的完整闭环证据见 Active Agent 同日期验证文档。

## 预览边界

当前是共享令牌的可信本地工作空间；没有文档 ACL、独立审批身份或多实例事务。段落和标题是本轮重点，复杂富内容的无损往返尚未完成。完整文档轮询和未压缩日志需要后续规模化改造。

旧入口和旧文档继续保留；本序列是 evolve 实现的新依据，不把早期 freedom/ 的路线建议自动视为本轮已交付能力。
