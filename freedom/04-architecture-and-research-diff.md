# Doc Free 整体架构与调研对照

## 1. 当前架构

```text
浏览器 / agent-native-IM
       │ HTTPS + WebSocket（同源）
       ▼
Doc Free server.js :3210
  ├─ 本地文档元数据：data.json
  ├─ MCP JSON-RPC：/mcp
  ├─ 群聊：/group（ws）
  ├─ Agent：DeepSeek Chat Completions
  ├─ AFFiNE adapter：官方 workspace MCP
  └─ Docmost adapter：正式 pages API
       │ /collab proxy
       ▼
Hocuspocus :1234
  ├─ Y.Doc / Awareness
  ├─ Tiptap ProseMirror XML fragment
  ├─ yjs-data/*.bin 持久化
  └─ /internal/read + /internal/rebase（服务端原子写）

独立产品：AFFiNE :3010 + PostgreSQL/Redis/Manticore
           Docmost :3020 + PostgreSQL/Redis
公网：cloudflared Quick Tunnel → :3210
```

## 2. 与调研推荐的对应关系

| 调研建议 | 当前状态 | 说明 |
|---|---|---|
| Tiptap + Yjs + Hocuspocus | 已用 | Doc Free 内嵌编辑器与多人正文协作核心 |
| BlockSuite | 未用 | 没有直接嵌入；AFFiNE 内部使用其块/CRDT 产品体系 |
| AFFiNE | 已用作外部产品/同步目标 | stable Docker + 官方 MCP/DocWriter；不是 Doc Free 主编辑器 |
| Docmost | 已用作外部产品/同步目标 | Docker + 正式页面 API；不是 Doc Free 主编辑器 |
| HedgeDoc | 未用 | 轻量 Markdown 协作候选，暂不重复引入 |
| Outline | 未用 | 作为未来知识库/SSO 参考，不在当前运行链路 |
| Suite Docs | 未用 | 仅调研比较 |
| AppFlowy | 未用 | 仅调研比较 |
| 自有 IM 身份、群组、权限、审计 | 分离设计 | IM 是独立系统；Doc Free 只保留 actor/requester/audit 接口供未来适配 |
| MCP 受控工具 | 已用 | 本地、AFFiNE、Docmost 工具已暴露 |
| 块级工具 | 已完成 P1 | 稳定块 ID、读块、替换块、块后插入；内置模型可返回块操作 |
| Agent 异步队列 | Demo 级已用 | 群聊任务可并行；缺少持久任务队列、取消、重试策略 |
| S3/MinIO 附件 | 未用 | 当前不支持附件资产管线 |
| OIDC/Passkey/SSO | 未用 | 当前是设备令牌 |

## 3. 为什么选择版本二的实际落地

“Yjs + Hocuspocus + AFFiNE + Docmost”把职责拆开：

- Yjs/Hocuspocus：Doc Free 自己掌握嵌入式实时编辑和 CRDT。
- AFFiNE：高完成度的文档/白板产品 UI、官方 DocWriter/MCP、搜索。
- Docmost：团队知识空间和页面 API。

优点是快速得到可用 UI 和外部持久化；缺点是三套文档模型并存，复杂块同步和权限统一更难。版本一的 BlockSuite + HedgeDoc 更适合完全自定义块编辑器或临时 Markdown，但需要自己补足完整知识库产品。

## 4. 数据与一致性

- 浏览器正文：Tiptap JSON ↔ Y.XmlFragment。
- Hocuspocus：共享文档按 `doc-<localId>` 命名，二进制 Yjs update 保存在 `yjs-data`。
- Agent：使用基线正文生成完整稿，再在 Hocuspocus 中做 diff-match-patch rebase。
- 外部同步：本地文档保存 `integrations.affine` 和 `integrations.docmost` ID，后续更新复用 ID。
- 历史：本地 `data.json` 的 history；AFFiNE 由官方 DocWriter/CRDT 保留其历史。

## 5. 调研中目前没有用上的关键建议

调研建议中的 `read_block/replace_block/insert_after` 和 actor/requester/version/idempotency/audit 已实现。尚未完成的是 comment、企业 ACL、对象存储、OIDC、SBOM/NOTICE 和完整可迁移导出；它们是从当前系统走向企业级基础设施的下一阶段。
