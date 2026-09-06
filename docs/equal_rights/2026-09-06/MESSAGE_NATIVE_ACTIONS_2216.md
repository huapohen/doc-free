# 消息标记、可逆删除与受保护来源动作 · 2026-09-06 22:16

- 记录时间：2026-09-06T22:16:13+08:00。
- 分支：`equal_rights`。
- 实现基线 commit：`d759e993f08a26d14225030e9fda54c89057f410`。
- 基线 commit 时间：2026-09-06T21:45:09+08:00。
- 基线描述：`feat(im): add native emoji catalog and truthful message reading`。
- 本文记录基线之后的工作树增量；提交 hash 由根协作智能体完成提交后写入独立交付记录。本文没有将未提交代码标成已提交交付。
- 依据：根协作智能体实际右击飞书群内自发消息时观察到的标记、禁止转发、删除、添加任务及导出文档菜单。本后端子任务没有操作真实飞书或向真实公司发消息。

## 个人标记与可逆删除

`PATCH /api/im/rooms/:room_id/messages/:message_id/preferences`

```json
{"marked":true,"hidden":false}
```

两字段都可单独使用；至少提供一个布尔字段。操作对象恒为当前登录身份，拒绝 `principal_id`、`owner_id` 等覆盖字段。显式设置相同值是无副作用幂等重试，不重复写入或发布事件。响应为 `{message, personal_preferences, changed}`。

`personal_preferences` 包含 `marked`、`hidden`、`updated_at`，与消息作者、全员撤回、置顶、会话收藏互相独立。标记和隐藏不会推进 read cursor 或 read ACK，也不修改发送时的 recipient snapshots。

隐藏仅从本人会话详情、消息窗口、首条未读定位、房间预览、未读统计、搜索、置顶清单、线程回复、事件重放和新 Agent 上下文中移除这条消息。其他成员完整保留原记录。线程使用不可变 `reply_to` 遍历，即使中间回复被本人隐藏，后面的可见回复仍能找到。直接读隐藏 ID 或隐藏线程根时返回带 ID/时间/作者的 tombstone，正文、附件、反应和修订历史不会返回。

Agent 本人隐藏消息会取消其正在运行的上下文，新的认领不会再次以隐藏消息触发；其他身份的运行和原始审计证据保持完整。已缓存 A2A 回执包含本人后来隐藏的消息时拒绝返回旧内容；恢复后按当前权限重新判断。

恢复调用相同 PATCH 并传 `hidden:false`。恢复不会把作者已经撤回的消息重新变成可读正文。隐藏清单保留安全 tombstone，供人和 Agent 使用相同接口恢复。

| API | 当前身份清单 |
|---|---|
| `GET /api/im/message-marks` | 本人标记且未隐藏的消息 |
| `GET /api/im/hidden-messages` | 本人可恢复的隐藏消息 tombstone |

清单支持 `room_id`、`limit`（默认 50，范围 1–200）、`before`（消息 seq），按 seq 从新到旧分页。响应 `{items:[{room_id,room_name,message}],has_more,next_before}`。仅包含当前仍是成员的会话，GET 不写状态。

消息页面内置“标记”分组匹配“本人手动标记的会话，或包含本人当前可见且已标记消息的会话”。原 `message_grouping.marked` 继续表示手动会话开关；新增 `conversation_marked` 和 `marked_message_count` 说明来源，避免现有“取消标记会话”菜单错误地假装清除了所有消息标记。顶部 favorite 不会使会话进入标记组。

个人变更发布 `message.preferences.updated`，使用明确的本人 audience；不会把个人删除/标记偏好广播给其他同事。

## 作者禁止转发

`PATCH /api/im/rooms/:room_id/messages/:message_id/forwarding`

```json
{"base_revision":3,"no_forward":true}
```

只有作者可修改。必须提供当前消息 revision；冲突返回 `409 conflict`，身份无权返回 `403 author_required`。有效改变递增消息 revision，并发布有时间和操作者的 `message.forwarding.updated`。

- `message.no_forward`：包含来源链保护的有效状态。
- `message.forwarding_own_no_forward`：此消息作者自身设置的开关。
- 已转发消息继续遵守其来源链的保护；不能通过对副本清除自身开关覆盖原作者限制。
- 原生 forward 在检查幂等返回之前检查当前隐藏及禁止转发，失败不会制造目标消息或目标附件。
- 普通消息 POST 重用已受保护消息的附件 ID、重用既有转发副本附件 ID，也返回 `403 forwarding_disabled`。
- 保护控制系统原生转发与来源动作；正常授权读取和下载仍可用。没有将该功能宣传成阻止人工截图、重新打字或下载后重新上传的 DRM。

## 原子来源任务与文档

| API | 补充字段 | 目标权限 |
|---|---|---|
| `POST /api/im/rooms/:room_id/messages/create-task` | `description`、`assignee_id` | IM + tasks |
| `POST /api/im/rooms/:room_id/messages/export-document` | `content` | IM + docs |

两者公共必填字段：

```json
{
  "client_id":"stable-intent-id",
  "message_ids":["msg-example-id"],
  "base_revisions":{"msg-example-id":3},
  "title":"来源工作"
}
```

`message_ids` 为 1–50 个唯一 ID；`base_revisions` 必须是与 ID 数组精确对应的完整键集，不接受缺项、多项或非整数版本。

同一 IM serial 临界区中完成当前成员资格、本人可见、未撤回、有效禁止转发、当前版本、目标应用权限校验，再调用既有任务 reducer 或规范文档 workspace handler。没有使用“GET 校验后再另发 HTTP POST”的竞态流程。并发消息编辑会在创建命令完成后取得 IM 锁，或先完成编辑并使旧来源请求返回冲突。

`content` / `description` **仅为用户补充说明**。服务端追加真实源正文、当前显示作者、发送时间、消息 ID、revision 和附件引用索引。源文本使用长度超过内部反引号的 fence，避免把消息正文误当生成报告的结构。

成功响应包括 `task` 或 `document`、`source_message_ids`、`source_message_revisions`、`duplicate`。任务本体和房间文档来源索引持久化相同来源证据，后续文档读取也可见来源字段。不会发送额外聊天广播，不伪造自动回复。任务正文超过 12000 字符、文档正文超过规范 workspace 的 200000 字符时明确拒绝，避免静默截断源消息。

相同身份、房间、操作的稳定 `client_id` 复用相同意图时返回原资源。不同意图复用同 ID 返回 `409 idempotency_conflict`。即使重试也先检查当前成员权限和源消息状态，不能借旧回执绕过新的隐藏、撤回或禁止转发。

文档创建跨越规范文档存储边界前先持久化来源意图；若规范文档已创建但响应丢失，状态保留 pending，返回 `503 outcome_pending`，同 client ID 重试不会再创建一篇。该状态不宣称完成，也不自动推断失败后重发。可通过 `GET /api/im/rooms/:room_id/messages/source-operations?client_id=...&operation=export-document` 读取本人最近 100 条来源操作状态；没有另一个身份的记录或消息正文。未知规范结果仍需核实并恢复，这是明确保留的异常状态。

## Agent 原生协议

REST、MCP 与通过公共工具目录的 A2A 使用相同当前身份权限。

- `im_message_preferences`
- `im_message_marks`
- `im_hidden_messages`
- `im_message_forwarding`
- `im_messages_create_task`
- `im_messages_export_document`
- `im_message_source_operations`

没有新增 UI 自动化依赖。人类可以点菜单，Agent 可以直接设置自己的偏好、恢复自己的消息、管理自己所写消息的转发保护并以同等权限创建真实工作资源。

## 验证和边界

新增 15 项行为测试覆盖 Human / Agent 同权、个人隔离、权限、重启持久化、无读 ACK 副作用、隐藏/恢复与撤回差别、线程中间节点隐藏、事件/搜索一致性、A2A 旧回执撤销、会话标记聚合、作者 CAS、转发副本来源链、附件重用绕过、原子源版本集合、无权或过期请求零产物、并发编辑线性化、真实生成源快照、幂等重复与未知文档结果保护。

最终全量 `npm test`：288/288 通过，日志为 `/tmp/doc-free-message-native-tests-final.log`。全量后将幂等文档读取的来源索引精确限定到请求房间，再跑来源动作 6/6，通过日志为 `/tmp/doc-free-message-materialize-final.log`。这些运行使用隔离测试状态，无模型调用、真实邮件发送或真实媒体采集。本子任务未重启共享 3218/1238 服务、未提交、未推送。

本记录不声称加急、电话/SMS 催办、真实手机深层菜单或全量飞书基础功能已经实现；这些属于后续可验证工作。客户端入口、真实 Mac/iPhone 显示及公司共享交付文档由根协作智能体负责整体验证。
