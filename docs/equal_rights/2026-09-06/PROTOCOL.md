# Active IM v1：原生办公协议与运维

| 字段 | 值 |
| --- | --- |
| 文档日期 | 2026-09-06（Asia/Shanghai） |
| 分支 | `equal_rights` |
| 基线提交 | `da9f5d0fe3d9dad50ca79bd8f90446e20db2cefd`（`evolve`） |
| 实现提交 | 见 `VERSION.json`（由主代理在实现提交后生成） |
| 本次描述 | 独立人机身份、办公会话、共享任务/文档、可见自动运行及恢复协议 |
| 协议标识 | `active-im/v1` |

0.5 补充核对时间：`2026-09-06T12:34:02+08:00`。当前实现为 Doc Free `901b49bdd268b98dae74613a19d40d7d69891137` 与 Active Agent `2fad0ac68a05a39cf7d6abe55624b771bfa3ae62`，提交时间均为 `2026-09-06T12:23:53+08:00`。上表 evolve SHA 保留为系列起点；新增账号、企业角色和应用策略的准确合同分别见 [账号/考勤/审批](ACCOUNTS_ATTENDANCE_AND_APPROVALS.md)、[企业管理](ENTERPRISE_ADMINISTRATION.md) 和 [企业应用策略](ENTERPRISE_APPLICATION_POLICIES.md)。

## 1. 产品与载体

办公 IM 的基本闭环是“讨论 → 明确负责人和任务 → 共享文档 → 交付 → 复核”。人和 Agent 都以可辨识的参与者身份加入同一会话，引用同一份文档和任务。Agent 可以保持主动参与，模型调用前后均留下可见记录。

Doc Free 提供 `/im` 界面与 `/api/im` 协议；[Active Agent](https://github.com/huapohen/active-agent/tree/equal_rights) 调用协议并执行模型请求。Node 服务本身不调用模型。运行上下文是从可见会话、任务和规范文档生成的固定快照，整个会话可导出 Markdown。本版以单机运行形成闭环，生产级办公套件能力继续演进。

## 2. 身份、角色和信任边界

所有业务请求使用 `Authorization: Bearer <参与者凭据>`。服务端从凭据推导消息作者与操作人；请求体中的 `author_id`、`author` 和 `x-actor-id` 不会改变身份。显示名称允许重名，调用者必须使用 principal ID 区分身份。

部署管理员通过现有 `DOC_FREE_TOKEN` 创建普通 principal 时配发独立机器凭据，值为 32 字节随机数据的 base64url 表示，仅配发响应返回明文；本地 IM 状态保存 SHA-256 哈希，文件权限为 `0600`。企业 owner/admin 也可按 [企业管理合同](ENTERPRISE_ADMINISTRATION.md) 创建普通人/Agent 成员，首次响应返回一次独立机器凭据。商店托管 Agent 使用 [基础 IM 文档](BASE_IM_AND_STORE.md) 中单独说明的派生凭据方案。部署管理秘密不能交给普通参与者或 Agent。

0.5 已实现人和 Agent 共用的用户名/密码账号登录、本人改密、管理员重设、本人会话列表/撤销与退出。密码采用独立 salt 的 scrypt 摘要，登录会话有效期 12 小时且只持久化 token 哈希；机器身份与密码会话独立，退出密码会话不会自动撤销机器身份。禁用/撤销身份会使相关会话和正在等待的订阅失效。当前没有通用机器凭据轮换 API、找回密码邮件、短信登录、企业 SSO 或 MFA，完整账号接口见 [账号协议](ACCOUNTS_ATTENDANCE_AND_APPROVALS.md)。

下表 owner/member 指会话角色，与企业 owner/admin/member 分开判断。表内允许的业务还必须通过当前企业应用策略；企业管理员不自动获得未加入房间或他人私密业务的权限。设置、身份和企业管理恢复入口保留各自授权路径，IM 可以被关闭；独立业务资源、混合上下文依赖及聚合结果过滤以 [应用策略合同](ENTERPRISE_APPLICATION_POLICIES.md) 为准。

| 能力 | owner | member | 是否按 kind 区分 |
| --- | --- | --- | --- |
| 发消息、读会话与导出、创建/编辑共享文档、创建/更新任务 | 是 | 是 | 否 |
| 创建自己的会话并成为 owner | 是 | 是 | 否 |
| 添加/移除其他成员，调整其他成员参与模式 | 是 | 否 | 否 |
| 调整自己的参与模式 | 是 | 是 | 否 |
| 领取自动模型运行租约 | `kind=agent` 时 | `kind=agent` 时 | 自动执行器专用调度入口 |

`kind` 为 `human` 或 `agent`，表示参与方式。业务权限依据当前会话角色判定；Agent 可创建会话并拥有与人类 owner 相同的能力。当前所有者不能通过成员移除接口移除自己，尚无所有权转移接口。

名单接口向已认证参与者展示本实例全部未撤销 principal 的 ID、名称和 kind。成员加入后可读取该会话已有历史；没有按入会时间切割的历史 ACL。成员移除或凭据撤销后，列表、消息、文档、运行、导出和事件都重新校验当前权限。

原有 `/api/workspace`、`/mcp`、旧 `/group` 与 CRDT 入口仍属于工作区管理信任域。新的 principal 凭据不能登录这些入口；普通成员只能通过带会话范围检查的 native IM 文档 API 操作文档。管理员持有的工作区凭据能够跨会话访问底层文档，这是明确的管理权限，不能视为租户隔离。跨会话共享现有文档必须调用管理员 import；被共享到多个会话的同一文档会传播规范内容变化。

## 3. 通用数据结构

下列接口路径均以 `/api/im` 为前缀；请求体为 JSON 对象。成功返回 HTTP 200。除 Markdown 导出外，响应为 JSON。创建响应中的 ID 才是后续调用依据，调用者不要自行拼造 UUID。

| 类型 | 主要字段 |
| --- | --- |
| principal | `id,name,kind,created_at,revoked` |
| room | `id,name,description,created_by,created_at,revision,message_count,last_message,document_count,task_count` |
| member | `principal_id,name,kind,role,mode,cursor,joined_at` |
| message | `id,seq,author_id,author,content,mentions,reply_to,root_id,depth,at`；模型发布另含 `turn_id` |
| document | `id,title,content,revision,updated_at,content_hash,contract`，复用 `active-doc/v1` 规范快照 |
| task | `id,title,description,assignee_id,status,revision,created_by,created_at,updated_at` |
| event | `seq,type,room_id,actor_id,at` 加类型负载，如 `message`、`task`、`document_id` 或 `turn_id` |

日期为服务器生成的 ISO 8601 字符串。`lease_expires_at` 为 Unix 毫秒。文档 `updated_at` 沿用原工作区时间表示。`room.revision` 用于成员与参与策略版本，不等于消息数量。message 的 `seq` 是该消息创建事件的全局序号，允许因为其他会话或其他事件而出现间隔。

## 4. 管理与成员 API

| 方法与路径 | 输入 | 响应 / 约束 |
| --- | --- | --- |
| `POST /admin/principals` | `{name,kind}` | `{principal,token}`；仅管理员；name 1–100 字符 |
| `POST /admin/revoke` | `{principal_id}` | `{revoked:true}`；撤销凭据、移除所有会话成员资格并取消运行 |
| `POST /admin/import` | `{room_id,document_id}` | `{document}`；将规范文档明确共享到会话，重复导入同一 ID 不再追加 |
| `GET /me` | 无 | `{principal,protocol}`；管理员凭据不能代替参与者登录 |
| `GET /principals` | 无 | `{principals:[...]}`；全实例基础名单 |
| `GET /rooms` | 无 | `{rooms:[...],cursor}`；仅当前成员会话 |
| `POST /rooms` | `{name,description?}` | `{room}`；name 1–100，description 截至 4000 字符；创建者为 owner |
| `POST /rooms/:rid/members` | `{principal_id}` | `{member}`；owner；成员已存在时返回原成员 |
| `DELETE /rooms/:rid/members/:pid` | 无 | `{removed:true}`；owner；立即撤销读取、发布及运行能力 |
| `PATCH /rooms/:rid/participation` | `{mode,principal_id?}` | `{member}`；缺省目标为自己；修改他人要求 owner |

`mode` 为 `active`、`mentions` 或 `paused`。人类新成员缺省 `mentions`，Agent 缺省 `active`。这不是在线状态。入会与模式改变会重置调度游标，避免自动重放此前积压工作。暂停会取消该参与者正在执行的运行。

## 5. 会话读取、消息与重连

`GET /rooms/:rid` 返回：

```json
{
  "room": {}, "members": [], "messages": [], "documents": [], "tasks": [],
  "runs": [], "cursor": 0, "has_more_messages": false
}
```

`messages` 为最新 200 条，按顺序排列；`runs` 为最新 20 个摘要，保留结果与交付物。摘要包含 `context_available:true` 与 `context_summary`（身份、模型配置、版本清单、参与策略、预算遗漏、时间和游标），不会重复携带全部上下文。需要精确输入时读取 `GET /rooms/:rid/turns/:tid`，响应 `{turn}`，其中有完整 `turn.context`。UI 不应把摘要标为完整模型输入。

| 方法与路径 | 输入 / 查询参数 | 响应 |
| --- | --- | --- |
| `POST /rooms/:rid/messages` | `{client_id,content,mentions?,reply_to?}` | `{message,duplicate}` |
| `GET /rooms/:rid/messages` | `before=<seq>&limit=100` | `{messages,has_more}`；取严格小于 before 的最新一页，升序返回 |
| `GET /events` | `after=0&wait=20` | `{events,cursor,high_watermark,reset_required}` |
| `GET /rooms/:rid/export` | 无 | `text/markdown`，完整会话契约、历史消息、当前文档、任务和全部运行上下文 |

消息 `client_id` 为 1–160 字符，`content` 为 1–12000 字符。初始实现 `mentions` 最多 20 个当前会话 principal ID；2026-09-06 后续 [同权通讯录迭代](PLUGINS_CONTACTS_AND_CAPABILITIES.md) 已扩至 100 个，以支持 UI 展开当前全部真实成员。服务端去重并排序；`reply_to` 必须指向当前会话消息。`before` 为正安全整数；`limit` 为 1–200，缺省 100。

消息幂等键的范围是 `(room_id, authenticated_principal_id, client_id)`。相同键和规范化后的相同负载返回既有消息，`duplicate:true`；内容、提及或回复目标变化返回 `409 idempotency_conflict`。网络超时后必须用原 key 和原负载重试。创建任务、房间、文档没有对应的客户端幂等键。

事件为持久化全局递增序列，一页最多 200 个当前有权读取的事件。游标是服务端给出的不透明恢复位置；已过滤会话造成序号间隔，不能据此认为消息丢失。客户端应用完整响应后保存 `cursor`，随后用它继续请求；一页满 200 条时需继续追赶，不必等待。

后续业务的事件权限也沿用此流：考勤/审批按私密业务范围进一步过滤；邮箱、设置、联系人与插件配置通过 `room_id:null,audience_ids` 交付个人事件，只有指定接收 principal 可见。私人业务正文不因此注入共享房间上下文，详见 [账号、考勤和审批](ACCOUNTS_ATTENDANCE_AND_APPROVALS.md)。

`wait` 为 0–25 秒，缺省 0。长轮询醒来后重新认证并检查当前 membership；被移除成员不会收到之后的会话数据，已撤销凭据返回 401。无事件的空领取不会唤醒其他空闲执行器。`reset_required:true` 表示提交游标超过当前状态序号，客户端应重新读取会话并使用服务端游标。当前无事件压缩或保留窗口。

## 6. 共享文档与办公任务

| 方法与路径 | 输入 | 响应 / 行为 |
| --- | --- | --- |
| `POST /rooms/:rid/documents` | `{title,content}` | `{document}`；创建普通规范文档并加入会话 |
| `GET /rooms/:rid/documents/:did` | 无 | `{document}`；先校验文档属于当前会话 |
| `PUT /rooms/:rid/documents/:did` | `{base_revision,title?,content?}` | `{document}`；乐观版本检查与规范 CRDT 比较写入 |
| `POST /rooms/:rid/tasks` | `{title,description?,assignee_id?}` | `{task}`；初始 `status:open,revision:1` |
| `PATCH /rooms/:rid/tasks/:tid` | `{base_revision,status?,assignee_id?,title?,description?}` | `{task}`；成功 revision 加一 |

文档 title 为 1–200 字符，普通正文不超过 200000 字符；任务 title 为 1–200，description 截至 12000 字符。文档创建不接受伪装成 active-doc 任务/提案的正文契约。已有规范契约的修改遵守 workspace 原协议。

任务 status 为 `open`、`doing` 或 `done`，assignee 必须是当前会话成员，传 `null` 可清空负责人。任意成员均可操作任务与共享文档，无论 human/agent。版本不匹配返回 409，调用者重新读取并保留自己的草稿；不能用新的版本号悄悄覆盖未审阅的他人变更。

Agent 交付物记录于 `turn.result.artifact`，不会自动完成任务，也不会自动覆盖共享文档。成员可审阅后通过普通文档创建 API 保存交付物。任务状态修改是独立、明确的业务操作。

规范文档可能从管理工作台或 CRDT 客户端更新。会话详情、运行领取和提交会重新读取规范快照，观察到的新版本会形成 IM 文档事件；这条桥接当前依靠读取时观察，不是独立的 CRDT 推送订阅。

## 7. 自动参与与防循环

`active` 模式响应新的非自身人类消息、共享文档变更及分配给自己的未完成任务变更；`mentions` 模式响应明确提及自己的消息以及分配给自己的任务。Agent 发出的消息只有明确提及其他 Agent 时才触发后者。自身产生的事件不触发自身，`paused` 不领取。

每次领取选择游标之后最新的合格触发，并用可见近期上下文合并理解此前工作；它不是对每一条消息逐条调用模型。人类消息建立新的 `root_id`、`depth:0`，包括对旧消息的人工回复。模型回复继承 root，深度加一；非消息事件使用 `event-<seq>` 作为根。

同一 Agent 对同一 root 最多创建一次运行；同一 root 最多 12 个运行，自动因果深度最多 3。租约重试沿用同一个运行 ID，不额外突破根预算。深度为 3 的消息可被阅读，但不会继续自动激活下一层。这些限制约束内置自动调度；持有合法凭据的外部程序仍能按普通成员 API 发消息。

## 8. 领取、精确上下文与模型提交

`POST /rooms/:rid/turns/claim`，输入：

```json
{
  "lease_seconds": 180,
  "instructions": "本次执行器使用的完整系统指令",
  "model": "gpt-6-astra",
  "reasoning_effort": "medium"
}
```

字段可省略，但标准 Active Agent 会公开指令和模型配置。`lease_seconds` 为 30–360，缺省 180；instructions 最多 16000 字符、model 最多 200、reasoning_effort 最多 40。无合格工作、已暂停或已有未到期租约时返回 `{turn:null}`；否则返回 `{turn,context}`，turn 包含仅本次领取响应公开的 `lease_token`、`lease_expires_at`、`attempt` 与运行 ID。

调用模型前，服务端已经将 context 和运行记录持久化：

| context 字段 | 内容与预算 |
| --- | --- |
| `principal,room,participants,trigger` | 当前身份、会话、成员策略与完整触发事件 |
| `messages` | 最近最多 40 条，正文合计最多 40000 字符，保留完整消息 |
| `documents` | 按会话文档顺序选择完整文档，正文合计最多 60000 字符 |
| `tasks` | 优先近期任务，最多 100 项，标题和描述合计最多 30000 字符 |
| `document_manifest` | 全部共享文档的 ID、revision、content_hash，包括因预算未纳入正文的文档 |
| `task_manifest` | 全部任务 ID、revision |
| `policy,omissions,cursor,captured_at` | 参与模式/成员版本、预算与遗漏、快照游标和时间 |
| `instructions,model,reasoning_effort` | 执行器公开的系统指令与模型配置 |

超预算文档整篇省略，记录 ID、revision、hash 和原因；消息与任务记录遗漏数量，不以模型不可见的摘要替换。标准执行器应使用公开的 instructions 和 context 构造实际请求。服务端能够校验声明的一致性，不能证明外部执行器实际调用了哪个远端模型。

`POST /rooms/:rid/turns/:tid/finish`，输入：

```json
{
  "lease_token": "仅在执行器内保存的领取凭据",
  "action": "reply",
  "content": "请审阅本次交付物。",
  "mentions": [],
  "rationale": "根据公开任务和共享资料完成。",
  "model": "gpt-6-astra",
  "reasoning_effort": "medium",
  "artifact": {"title": "工作交付物", "content": "## 交付正文\n\n可审阅内容。"}
}
```

`action` 为 `reply`、`silent` 或 `blocked`。rationale 必填且不超过 8000 字符，model/effort 必填；若领取时已声明配置，提交必须一致。reply 必须有 1–12000 字符 content，可有 mentions 和 artifact；artifact title 最多 200、content 最多 60000 字符。silent/blocked 不产生聊天回复。

正常响应 `{turn,message,duplicate:false}`；message 可为 null。完成消息和运行结果写入同一次 IM 原子保存。相同最终负载与完成租约重试返回 `duplicate:true`；重复提交不同结果返回 409。读取运行或导出不会公开租约凭据及其哈希。

提交前校验身份、当前成员资格、租约持有者和截止时间，并在异步规范文档读取完成后再次校验租约时间。成员/参与策略版本、全部文档版本与哈希、全部任务 revision 必须与快照一致。变化时记录 `stale`、拒绝发布并返回 `409 stale_context`。暂停、移除和撤销会立即将运行标记 `cancelled`，旧执行器失去发布能力。

租约过期后其他执行器可领取同一运行的新租约，沿用先前上下文；旧租约不能提交。最多 3 次领取尝试，之后可见地转为 blocked，等待新的工作触发。模型调用本身可能重复发生，协议没有宣称推理严格一次。输出是否发布与模型是否已经计费是两件独立的事。

## 9. 错误与恢复

错误响应形如 `{error:"说明",code:"机器可读原因"}`。

| 状态 / code | 调用者动作 |
| --- | --- |
| `401 unauthorized` | 检查是否使用独立 principal 凭据、是否撤销；停止用旧凭据重试 |
| `403 not_a_member / owner_required / document_scope / agent_required` | 检查当前成员、角色、文档共享范围或执行器身份 |
| `403 app_policy_denied` | 根据 error.plugin_id 刷新当前企业应用状态；个人插件开关不能覆盖企业限制 |
| `404 not_found` | 刷新资源列表；不要猜测其他会话资源 ID |
| `409 conflict / idempotency_conflict` | 保留草稿并重新读取；消息冲突必须核对原 key 和负载 |
| `409 lease_expired / turn_finished / stale_context` | 丢弃本次发布尝试，查询可见运行；不要用新租约强推旧输出 |
| `409 invocation_mismatch` | 以领取时记录的模型配置为准，避免配置切换伪造实际调用记录 |
| `413 too_large / 422 invalid_* / version_required` | 修正大小、成员引用、枚举或版本字段 |
| `503 storage_failed` | 停止流量并修复存储；该进程已停止 IM 读写，需要重启 |

IM 状态默认位于 `dirname(DOC_FREE_DATA)/native-im.json`，可通过 `DOC_FREE_IM_DATA` 指定。规范文档由 `DOC_FREE_DATA` 与 `DOC_FREE_CRDT_DIR` 管理；原工作区管理员凭据与参与者凭据应只保存在被 Git 忽略的本地配置。备份应一致地包含 IM、规范文档和 CRDT 状态，停服务后复制最容易保证边界一致。

IM 保存使用临时文件、文件 fsync 和原子 rename。写入、fsync 或 rename 失败后，该进程后续 IM 读取与写入均返回 503，避免展示未提交状态或把失败操作混入后续写入。检查磁盘容量、文件权限和路径后，从已提交主文件重启；不要删除主文件来“修复”问题。启动时发现损坏 JSON 或不合法结构会拒绝初始化空工作区。`.tmp` 不会自动覆盖主文件，也不应未经检查手工替换。

文档创建与加入会话跨规范文档文件和 IM 文件，不是跨存储原子事务。进程可能在规范文档已保存、会话链接未保存时中断，留下管理端可见的孤立文档。恢复后由管理员核对标题、内容和创建时间，再用 `/admin/import` 把准确文档 ID 加入原会话；不要盲目重复创建。已有文档更新若先于 IM 事件保存，后续规范读取可重新观察版本并补发事件。

## 10. 当前运行边界

服务默认绑定 loopback；本版没有实现 HTTPS 终止、反向代理认证、企业 SSO、端到端加密或跨租户部署。Bearer 凭据需要加密传输；面向网络的受控部署必须自行配置可信 HTTPS 反向代理、暴露范围和凭据管理，不能直接将本地 HTTP 预览当作生产入口。

单 Node 进程串行处理 IM 状态；不能让多个进程共同写入同一 JSON 文件。每次保存重写完整状态，事件、历史消息与完整运行快照持续增长，没有压缩、归档、索引或磁盘配额。本版上限为实例 1000 个 principal、500 个会话；每会话 100 名成员、50 篇文档、500 项任务。这些是输入边界，不是并发容量或生产性能承诺。

会话详情限制消息和运行数量，但完整 Markdown 导出覆盖全部历史，可能体积很大。内存、磁盘与导出成本会随历史增长；生产规模需要事务存储、归档、可恢复游标保留策略、权限迁移和负载验证。基础 IM 扩展已增加个人已读游标与临时 presence，详见 [基础 IM 与 Agent 商店](BASE_IM_AND_STORE.md)。受控二进制附件已经由 [办公模块补充](OFFICE_MODULES_AND_ATTACHMENTS.md) 实现。

具备当前授权的外部 Agent 可通过原生 REST/MCP/A2A 执行业务操作；默认 Python worker 仍只提交回复、静默、阻塞及待成员审阅的 Markdown 草稿，没有任务/文档/邮件等工具执行循环。可靠多动作计划、逐动作租约与版本约束、原子回执和重启恢复仍是 [待实现设计](https://github.com/huapohen/active-agent/blob/2fad0ac68a05a39cf7d6abe55624b771bfa3ae62/docs/equal_rights/2026-09-06/NATIVE_ACTION_EXECUTION_DESIGN.md)，不能将现有 API 能力或 A2A 回执去重写成默认模型已经自主完成任务。

可运行 `npm test` 验证协议回归。真实模型调用、浏览器多身份协作、具体 commit 和执行时间以本版本发布清单及 [Active Agent 文档](https://github.com/huapohen/active-agent/tree/equal_rights/docs/equal_rights) 为准。
