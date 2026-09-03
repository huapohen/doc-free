# Doc Free Freedom 版本清单

## 当前版本

- 版本标签：`2026-09-03-p0-p1`
- 发布时间：`2026-09-03T16:01:05+08:00`
- Git 实现提交：`d14ee4d`（P0 统一 CRDT 写入内核、P1 块级 Agent 能力及配套文档）
- Git 仓库：`https://github.com/huapohen/doc-free`（私有）
- 发布 tag：`v2026.09.03-p0-p1`

## 版本边界

本版本已完成：网页 REST、MCP、群聊 `@doc_free` 和内置 Agent 共用 Hocuspocus/Yjs 写入路径；稳定块 ID、块读取、块替换、块后插入；actor/requester、revision、base version、幂等键和审计记录。

agent-native-IM 仍是独立产品线，本版本不集成 IM UI、群组或消息系统。未来通过适配层接入 MCP 和事件流。

## 可复现方式

```bash
git clone https://github.com/huapohen/doc-free.git
cd doc-free
npm ci
npm run start:collab
npm start
```

运行时的 `.env`、`auth.json`、数据库/CRDT 数据、Cookie 和日志不会进入仓库；请按 `.env.*.example` 创建本机配置。
