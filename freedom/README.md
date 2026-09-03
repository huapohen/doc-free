# Doc Free Freedom 文档集

这组文档是 Doc Free 的产品、Agent、MCP、架构和演示手册。事实基线是本机当前源码与部署状态（2026-09-03），不是对上游产品未来能力的承诺。

## 阅读顺序

1. [01-demo-tutorial.md](./01-demo-tutorial.md)：多人体验、成语接龙、错误英语作文。
2. [02-agent-persona-and-control.md](./02-agent-persona-and-control.md)：内置模型是谁、提示词在哪里、自然语言边界。
3. [03-mcp-and-im-usage.md](./03-mcp-and-im-usage.md)：完整 MCP 清单，以及接入 agent-native-IM 的协议。
4. [04-architecture-and-research-diff.md](./04-architecture-and-research-diff.md)：现有技术方案和调研对照。
5. [05-product-boundary-and-roadmap.md](./05-product-boundary-and-roadmap.md)：能否替代 Notion/语雀、AFFiNE/Docmost 的定位、升级路线。
6. [06-api-reference.md](./06-api-reference.md)：JSON-RPC、WebSocket 事件和 agent-native-IM gateway contract。

## 当前入口

- Doc Free 本机：`http://localhost:3210`
- Doc Free MCP：`POST http://localhost:3210/mcp`
- Hocuspocus：`ws://localhost:1234`（通过 Doc Free 同源 `/collab` 代理）
- AFFiNE：`http://localhost:3010/workspace/779fabb1-3e57-4164-af4c-1ed50153e16a/all`
- Docmost：`http://localhost:3020`
- 公网 Quick Tunnel：以当前 `start-public.sh` 输出为准；Quick Tunnel 重启会换 URL。

## 一句话判断

Doc Free 已经是“本地优先 + 自托管 + 人/Agent 通过群聊共同修改文档”的可运行系统。P0 统一 CRDT 写入内核和 P1 块级 Agent 已完成；它还不是 Notion/语雀的完整替代品，后续重点是身份/权限、评论/提及、附件和固定公网域名。agent-native-IM 是独立系统，当前不与 Doc Free 耦合，未来只通过 MCP/事件适配层集成。
