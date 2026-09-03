# 内置 Doc Free Agent：人设、提示词与可控边界

## 1. 它是不是 Doc Free 内置大模型？

是。群聊中 `@doc_free` 和 HTTP `/api/agent` 都调用 Doc Free 服务端内置的文档 Agent。当前模型配置从以下优先级读取：

1. 进程环境变量；
2. 被 `.gitignore` 忽略的 `execute/enterprise_work/doc_free/.env.agent`；
3. 本机 broker 的 `.env.local` 回退配置。

当前实际模型名是配置中的 `DEEPSEEK_MODEL`（本机默认 `deepseek-chat`），通过兼容 OpenAI Chat Completions 的 `/chat/completions` 调用。API Key 只存在本机配置，不写入本文档。

## 2. 人设提示词在哪里

源代码位置：

- [server.js](../server.js) 的 `planDocumentUpdate()`，约在第 130 行起。
- system message 当前核心内容：

  ```text
  你是 Doc Free 的文档执行 Agent。根据用户指令编辑当前文档，并只返回 JSON 对象：
  {"title":"最终标题","content":"最终完整 Markdown 正文",
   "targets":["affine","docmost"],"reply":"给用户的简短说明"}。
  content 必须是编辑后的完整正文，不是建议或差异。
  默认 targets 同时包含 affine 和 docmost；只有用户明确说仅本地、仅某个平台或不要同步时才改变。
  不要把标题 H1 重复放进正文。
  ```

这意味着当前 Agent 是“文档规划器”，不是把所有 MCP 工具直接暴露给模型的自由代理。模型产出计划 JSON，服务端验证并执行计划。

## 3. 执行链路

```text
群聊 @doc_free
  → /group WebSocket 收消息
  → runDocumentAgent()
  → 读取文档基线
  → DeepSeek 生成完整 Markdown 计划
  → Hocuspocus 内部 /internal/rebase 原子 CRDT 合并
  → 本地 data.json/history 更新
  → AFFiNE 原生 MCP DocWriter
  → Docmost 正式 pages API
  → 群聊广播 Agent 回复和执行结果
```

多个 Agent 可以并行运行。每个任务以自己的基线生成结果，提交前在 Hocuspocus 内读取最新正文并 rebase；非重叠改动合并，真实冲突会基于最新正文重新规划。

## 4. 自然语言可控范围

已实现：

- 内容改写、扩写、删减、总结、翻译、纠错、会议纪要化等完整 Markdown 更新。
- 改标题。
- 默认同步三端。
- 明确表达“只更新 AFFiNE”“不要同步 Docmost”“仅本地”时改变 `targets`。
- 并发 Agent 的正文 rebase 与冲突重试。

已新增的块级能力：

- `list_blocks`、`read_block`、`replace_block`、`insert_after_block`；
- 内置模型能读取真实块 ID，局部修改时返回经过服务端校验的块操作；
- 块操作统一提交 Hocuspocus/Yjs，并同步 AFFiNE、Docmost。

尚未作为显式一等工具实现：

- 评论、批注、@人、任务、审批、附件和图片；
- 删除文档前确认、外部分享权限、成员/角色权限；
- Agent 自主规划多步工具调用和可取消工作流；
- 结构化数据库块和白板元素编辑。

## 5. 重要安全边界

当前 `targets` 是模型输出后由服务端过滤的 `affine/docmost` 枚举，不是模型可以任意构造 URL 或任意执行 SQL 的接口。模型看不到外部平台凭据。外部写入由 Doc Free 服务端固定适配器完成。

但“自然语言同步范围”目前主要是意图约束，不应替代生产权限系统。下一版应由 IM 的 actor、文档 ACL 和服务端 policy 决定是否允许目标平台写入。
