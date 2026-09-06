# 2026-09-06 · 基础 IM 与专属 Agent 商店

| 字段 | 值 |
| --- | --- |
| 文档日期 | 2026-09-06（Asia/Shanghai） |
| 分支 | `equal_rights` |
| 基线提交 | `da9f5d0fe3d9dad50ca79bd8f90446e20db2cefd`（`evolve`） |
| 实现提交与时间 | 见 `VERSION.json`（实现提交后关联） |
| 本次描述 | 私聊、已读与会话偏好、消息修订/撤回、表情、搜索、工作资料库和托管专属 Agent |

本篇补充 [核心协议](PROTOCOL.md)。人和 Agent 均通过同一套原生接口创建私聊、发送与提及、操作任务和文档；Agent 不需要模拟点击人类界面。Flutter 各平台客户端与原生 Agent 的 UI 形态不同，身份验证、会话范围及业务语义使用同一服务。

## 私聊、群聊和个人状态

| 方法与路径（前缀 `/api/im`） | 输入 | 响应与语义 |
| --- | --- | --- |
| `POST /rooms/direct` | `{principal_id}` | `{room,duplicate}`；按无序参与者对幂等创建私聊 |
| `POST /rooms` | `{name,description?,kind?:"group"}` | `{room}`；创建群聊，私聊使用专用入口 |
| `PATCH /rooms/:rid/preferences` | `{favorite?,muted?,read_seq?}` | `{room,preferences}`；只改变认证用户自己的偏好 |
| `POST /presence` | `{status}` | `{presence}`；短期连接心跳 |

room 增加 `kind:group|direct`。人或 Agent 都能创建私聊；创建者仍为 owner，另一方为 member，双方能使用相同工作 API。重复调用或对方反向发起返回同一私聊。不能与自己私聊。私聊保持两名参与者，普通成员添加/删除接口返回 `409 direct_membership`；需要更多同事时创建群聊。管理员撤销仍能使私聊成员失效，随后不会通过再次调用 direct 接口悄悄恢复资格。

认证用户读取 room 时，还会得到 `preferences:{favorite,muted,read_seq}`、`is_favorite`、`muted`、`read_seq` 和 `unread_count`。未读数量只统计读游标之后其他作者发出的、当前未撤回的消息。收藏和静音不改变成员资格、Agent 参与策略或历史保存。

favorite/muted 必须是布尔值。read_seq 必须为不超过当前全局事件序号的非负安全整数；服务器保持单调，并将新进度限制在本会话最新消息位置。客户端将详情 cursor 用于标记已读时，偏好更新事件不会继续推动读游标形成循环。新加入的成员从入会位置开始未读计数，历史仍可阅读。后续补充已通过 members[].read_seq 暴露实际成员已读位置，见 [办公模块补充](OFFICE_MODULES_AND_ATTACHMENTS.md)。

presence 的 status 为 `online`、`busy`、`away` 或 `offline`，服务端返回 `{principal_id,status,at,expires_at}`。信息仅保存在进程内，60 秒未刷新后显示 offline，重启会清空；它不会持久化到工作记录，不代表身份可信程度或模型一定可用。会话 members 与 Agent 好友列表附带 presence。此心跳没有独立事件推送，客户端可在自己的刷新周期读取。

## 消息修订、撤回与表情

新消息含 `revision:1,edited_at:null,retracted_at:null,history:[],reactions:{}`。已有旧消息的缺省 revision 按 1 处理。

| 方法与路径 | 输入 | 响应与约束 |
| --- | --- | --- |
| `PATCH /rooms/:rid/messages/:mid` | `{content,base_revision}` | `{message}`；仅作者；内容 1–12000 字符 |
| `DELETE /rooms/:rid/messages/:mid` | `{base_revision}` | `{message}`；仅作者；软撤回，保留墓碑和审计 |
| `POST /rooms/:rid/messages/:mid/reactions` | `{emoji}` | `{message}`；当前成员按自己身份切换表情 |

编辑/撤回成功后 revision 加一；版本错误返回 `409 conflict`，缺失版本返回 `422 version_required`，非作者返回 `403 author_required`。owner 也不能冒充消息作者修改消息。每条消息最多 100 次修订，已经撤回的消息不能再编辑、撤回或添加表情。

软撤回把当前 content 置空并设置 retracted_at；它不是“从所有副本中删除”。history 持久保留旧正文、旧 revision、操作时间、操作人和 edit/retract 类型。消息创建事件是不可变快照，随后通过 message.updated / message.retracted 事件表达新状态。当前成员可检查审计；离开会话者仍受成员权限限制。客户端的普通消息展示应使用最新状态，不能把历史正文重新显示为当前消息。

Markdown 导出将“当前消息记录”和“消息修订审计（包含已撤回历史）”明确分开，撤回的当前正文显示 `[消息已撤回]`。已经生成的旧运行上下文仍作为历史证据保留；新模型上下文不包含 message.history，撤回的最新消息正文为空。

编辑或撤回模型输入涉及的消息，会立即把关联 running 运行置为 stale、收回发布租约。提交时还校验消息 ID/revision/撤回状态清单，防止使用过时指令发布结果。编辑事件建立单独的修订触发根，允许 Agent 重新处理修改后的请求；原运行、旧内容和新修订的因果记录都保留。单独新增消息仍按后续工作处理，不自动取消已经进行的独立上下文。

表情限定 `👍`、`❤️`、`🎉`、`👀`、`✅`、`🙏`。响应 reactions 为 `{emoji:[principal_id,...]}`；再次发送同一 emoji 切换自己的状态。请求体中的 actor_id 不会改变操作者。表情不修改正文 revision，也不触发新的模型调用。此操作是 toggle，网络结果不明时先读取最新状态，不能按消息发送的幂等规则盲目重试。

## 搜索与工作资料库

初始 `GET /search?q=<文本>` 搜索当前成员会话的当前消息、任务与规范文档，不搜索已撤回正文或修订历史，最多 100 个结果。2026-09-06 后续 [全域搜索迭代](PLUGINS_CONTACTS_AND_CAPABILITIES.md) 已增加工作区公开身份/商店及本人有权读取的邮件、审批、日程，总上限改为 200。q 仍为 1–100 字符，采用大小写不敏感的子串匹配。

```json
{
  "query": "验收",
  "results": [
    {"type":"document","room_id":"room-…","id":"…","title":"产品方案","content":"匹配位置附近的摘要","revision":2}
  ],
  "truncated": false
}
```

本篇初始 type 为 message、document 或 task；后续增加的 type 与原字段保持兼容。扫描预算为 10000 条消息、2000 项任务、100 篇文档；达到预算或结果上限时 truncated 可能为 true。结果中的 content/snippet 是匹配摘要，不能作为完整工作上下文。服务端按当前权限读取规范文档，成员被移除后不会继续搜到该会话。

`GET /rooms/:rid/messages?q=<文本>&before=<seq>&limit=100` 在原分页协议上增加会话内正文搜索，同样排除撤回内容。

`GET /library` 提供跨会话工作资料入口：

```json
{
  "documents": [{"id":"…","title":"产品方案","revision":2,"content_hash":"…","updated_at":0,"room_ids":["room-…"]}],
  "tasks": [{"id":"task-…","title":"验收检查","description":"最多240字符摘要","status":"open","revision":1,"room_id":"room-…","room_name":"项目组"}],
  "truncated": false
}
```

文档按 ID 去重并列出所有当前有权访问的关联会话，最多 100 篇；任务最多 500 项。这里返回概要，文档正文必须通过对应会话文档 API 读取。任务保留负责人、创建/更新时间等标准字段。资料库没有创建新的文档副本，Doc Free 规范文档仍是共同载体。

## Agent 商店与专属好友

商店是本版受控的静态角色目录，包含：

| 模板 ID | 名称 | 能力边界 |
| --- | --- | --- |
| `product` | 产品同事 | 根据共享资料整理需求、方案和验收标准 |
| `reviewer` | 评审同事 | 检查可见方案中的逻辑、风险、遗漏和可验证性 |
| `research` | 研究同事 | 综合团队提供的资料并形成有依据的研究备忘录 |

模板包含公开的 description、skills 和 instructions。当前没有外部浏览器、搜索、代码执行或消息发送工具，研究角色不能声称已完成外部调研。商店名称也不构成更高业务权限。

| 方法与路径 | 输入 | 响应 |
| --- | --- | --- |
| `GET /agent-store` | 无 | `{agents:[{id,name,description,skills,instructions}],reaction_options:[...]}` |
| `POST /agent-store/:template/install` | `{}` | `{principal,installed:true,duplicate}` |
| `GET /agents` | 无 | `{agents:[...]}`，当前用户的安装、显式好友和共享会话 Agent |
| `POST /agents` | `{principal_id}` | `{principal,added:true}`，添加一个已存在的 Agent 好友 |
| `GET /admin/workers` | 无 | `{workers:[{principal,token}]}`，仅工作区管理员/可信本地 supervisor |

安装以 `(当前用户,模板 ID)` 幂等。同一用户重复安装返回原 principal，不同用户获得不同 Agent 身份。安装响应不返回凭据，也不自动加入任何既有会话；用户可以随后创建私聊，或由群 owner 邀请。安装身份被管理员撤销后，重复安装返回 `409 agent_revoked`，避免把撤销变成重新授权。

托管 principal 增加 `managed:true,owner_id,store_template_id,instructions,skills`，这些工作角色配置进入可见运行上下文。owner_id 表示安装归属，不赋予账户管理或跨会话权限。好友列表 relationship 为 `installed`、`friend` 或 `room`，并提供临时 presence。显式加好友不加入会话；通过共处会话认识的 Agent 也可显示为 room 关系。此版本好友关系不是对其他用户不可见的私有身份，实例基础名单仍按核心协议公开。

参与者无论 kind 都可安装或添加 Agent，同一拥有者最多 12 个托管安装、100 个显式 Agent 好友，仍受实例 1000 个 principal 总额约束。当前静态目录只有三个模板，没有付费购买、第三方上传、插件沙箱或商店审核服务。

## 托管执行器凭据与运行边界

托管 Agent 凭据由 `HMAC-SHA256(DOC_FREE_TOKEN, "active-im/v1/managed-agent/" + principal_id)` 派生，使用 base64url 表示。IM 状态仅保存派生凭据的 SHA-256 哈希，绝不保存明文。普通安装者只得到 principal；只有可信管理员调用 `/admin/workers` 可获得当前未撤销的托管身份及其独立 token，用于为各身份启动执行器。

每个执行器拿到的 token 只代表一个 Agent，不能调用管理员入口或旧工作区管理 API。Node 服务不接收也不保存模型 Key；模型配置由 Active Agent supervisor 的本地环境提供。角色 instructions 是可见工作配置，不能修改认证身份、提升权限或突破工具边界。

派生方案使同一管理秘密下的进程重启保持凭据稳定；更换管理秘密后，管理员下一次枚举 workers 会刷新托管身份的凭据哈希，旧执行器需要重建。撤销身份会从 worker 清单移除并立即取消其会话运行。Supervisor 应以清单为准启动、更新和停止工作进程，避免用工作区管理凭据直接执行成员动作。

核心的单进程 JSON、完整状态重写、事件增长、跨存储文档创建和 HTTPS 部署边界仍然存在。商店安装、好友创建和房间初始化是本地预览能力；后续补充已实现受控附件传输与原生视频会议信令，详见 [会议、日历和附件](OFFICE_MODULES_AND_ATTACHMENTS.md)；推送系统、企业通讯录同步和商店商业化仍未实现。Flutter 五个平台的编译与实机验证范围应以发布清单列出的真实证据为准，不能由 API 完成推断所有平台已通过验证。
