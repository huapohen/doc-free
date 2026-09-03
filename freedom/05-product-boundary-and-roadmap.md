# 能否替代并超越 Notion / 语雀

## 1. 诚实结论

现在不能声称已经全面替代 Notion 或语雀。当前 Doc Free 在以下维度已经更贴近你的目标：

- 本地优先、自托管，不依赖 Notion 登录和席位计费。
- 人和 Agent 都能在同一个群聊线程中发起文档动作。
- Yjs/Hocuspocus 提供实时多人编辑和离线/并发合并基础。
- AFFiNE、Docmost 可以作为独立 UI 和同步出口。
- MCP 让外部 Agent 能读写文档，而不是只能操作网页。

但 Notion/语雀在成熟度上仍领先：权限、评论、提及、数据库、附件、模板、搜索、通知、移动端、审计、稳定公网服务和企业支持都更完整。

## 2. AFFiNE 和 Docmost 能否帮你超越

可以帮助“超过某些体验”，不能自动让整体产品超过：

- AFFiNE 强项：完整文档/白板 UI、块结构、CRDT/DocWriter 路线、搜索。
- Docmost 强项：团队知识库式页面组织、Docker 自托管、页面 API。
- Doc Free 强项：把它们放在 agent-native-IM 的同一个工作流中，并用自然语言 + MCP + CRDT 串起来。

真正的差异化是“协作对象不是页面，而是群聊里的共享工作状态”：人可以编辑，Agent 可以编辑，二者都能看到上下文、执行状态、版本和审计。

## 3. 建议的超越指标

| 目标 | 验收方式 |
|---|---|
| Agent 与人同权 | 同一群里，人/Agent 均可读、提及、编辑；均有 actor 审计 |
| 并发不丢改动 | 20 个客户端同时编辑/点名，非重叠变化全部保留 |
| 一次授权 | IM SSO/OIDC 或 Passkey，设备令牌可轮换、可撤销 |
| 可退出 | 可导出 Markdown、Tiptap JSON、Yjs update、附件和审计 |
| 平台一致 | 本地、AFFiNE、Docmost 的 revision/同步状态可追踪 |
| 低摩擦 | 群里一句话创建文档、分段修改、总结、审校、生成任务 |

## 4. 升级路线

### P0：统一真实协作内核（已完成）

- MCP、网页 REST、群聊 Agent 的写入全部进入 Hocuspocus/Yjs command bus。
- 写工具支持 `actor_id/requester_id/base_version/idempotency_key`，并记录 revision/audit。
- 服务端广播文档更新和 Agent 运行状态。
- 当前访问控制仍是 Doc Free 自己的共享令牌；IM 统一身份/ACL 留给未来独立适配，不在本阶段耦合。

### P1：块级 Agent 能力（已完成）

- 已暴露 `list_blocks`、`read_block`、`replace_block`、`insert_after_block`。
- 块 ID 持久保存，块写入保留未修改块并统一进入 CRDT。
- 内置模型会收到真实块 ID，局部任务优先返回块操作；完整正文仍是冲突回退。
- `move_block`、`comment`、`suggest` 属于后续增强，不作为本轮 P1 验收项。

### 未来：与独立 agent-native-IM 集成（当前不做）

agent-native-IM 已独立搭建，Doc Free 当前保持分离。未来只需要建设适配层：IM 群/线程/actor 映射到 Doc Free document、MCP actor 字段和事件流；不在 Doc Free 内重复开发 IM UI、群组或消息系统。

### P2：企业可用性

- OIDC/Passkey/SSO、细粒度空间/文档权限、设备管理。
- PostgreSQL 持久化消息/元数据/审计，S3/MinIO 附件。
- 固定 Cloudflare named tunnel 或自有域名、TLS、备份和监控。
- SBOM、NOTICE、许可证策略和灾备演练。

### P3：减少双产品模型

- 选择一个 canonical CRDT 文档模型。
- AFFiNE/Docmost 作为可插拔视图/导出适配器，而不是三个互相覆盖的事实源。
- 对数据库块、图片、白板、评论制定明确映射或声明“不互通”。

## 5. 最终产品定位

Doc Free 不应该只是“另一个 Notion clone”。推荐定位是：

> 一个由 agent-native-IM 驱动的、自托管、CRDT 原生、MCP 可编程的人机共同文档工作空间。

Notion/语雀解决的是“人打开页面后协作”；Doc Free 要解决的是“人在群里和 Agent 一起，让共享文档持续完成工作”。当 P0/P1 完成后，这个差异才会从 Demo 变成可验证的产品优势。
