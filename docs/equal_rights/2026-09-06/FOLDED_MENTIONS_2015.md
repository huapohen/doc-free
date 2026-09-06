# 折叠会话、真实 @所有人与个人提醒协议 · 2026-09-06 20:15

记录完成时间：2026-09-06T20:17:18+08:00，Asia/Shanghai；20:15 为本说明的编写批次标记。

本记录独立于 19:56 设置与群聊交付批次。开发分支为 `equal_rights`，实际实现基线为 `0dd7556b7c17a10f271ffbffb0a75807b21b5cb5`（2026-09-06T19:48:11+08:00，作者嵌套快照隔离）。记录写入时本批代码尚未提交；最终实现提交号以随后的汇总交付记录为准，不将基线号当作本批实现号。

## 个人会话偏好

沿用 `PATCH /api/im/rooms/:room_id/preferences`，新增：

```json
{
  "folded": true,
  "mute_all_mentions": false
}
```

- 两项必须是布尔值，旧存储默认 `false`；只读时不写文件、不推进事件。
- 只能更新当前身份本人，Human 与 Agent 使用相同权限。目标身份、参与模式等不支持字段返回 422，不静默应用其它字段。
- `folded` 支持单聊和群聊；`mute_all_mentions: true` 仅限群聊，单聊返回 `409 group_required`。
- 折叠不退群，不删除消息，不改变 `read_seq`、参与 `mode`、Agent 游标或自主动作配置。免打扰也不代替 Agent 的暂停模式。
- 沿用既有个人会话偏好的非 CAS 写入协议；本批没有引入偏好版本号。消息编辑仍严格使用消息 `base_revision`。

`GET /api/im/rooms`、会话详情、偏好写入回执的 `room` 均返回顶层 `folded`、`muted`、`mute_all_mentions`，同时保留：

```json
{
  "preferences": {
    "favorite": false,
    "pinned": false,
    "muted": false,
    "folded": false,
    "mute_all_mentions": false,
    "read_seq": 0
  }
}
```

## 真正的 @所有人

消息创建及编辑分别使用 `POST /api/im/rooms/:room_id/messages`、`PATCH /api/im/rooms/:room_id/messages/:message_id`。

```json
{
  "client_id": "stable-message-intent",
  "content": "请所有当前群成员查看交付文档。",
  "mention_all": true,
  "mentions": []
}
```

`mention_all` 是明确的广播意图。服务端不分析正文中的“@所有人”字符串，也不根据 `mentions` 是否包含全员来猜测广播。`mentions` 始终表示显式指定身份。

- 只有群聊允许 `mention_all: true`，Human 与 Agent 群成员同权。
- 服务端在首次发送时生成 `mention_all_ids`：当时的群成员身份快照，排除作者、排序保存。客户端传入该字段返回 422。
- 旧消息读回默认 `mention_all: false`、`mention_all_ids: []`；不会重新计算旧消息的目标。
- `client_id` 幂等摘要包含广播意图，不包含会随群成员变化的派生名单；重试返回原消息及原快照。省略/显式 `false` 兼容旧普通消息摘要。使用同一意图 ID 改变广播意图返回 409。
- 编辑省略 `mentions` 或 `mention_all` 时保留原值。`true → true` 与只改正文保留原广播快照；`false → true` 才按该次编辑时的成员重新生成快照。后来入群的人不会因普通编辑被加入旧广播。
- 编辑保存旧正文、显式提及、广播标记与目标名单到修订历史；原创建事件不重写。撤回后当前消息不再包含有效提及，审计历史仍保留。
- 转发不继承原文的显式提及或广播，避免把来源群的提醒传播到目标群。
- 消息、搜索、Pin、回执、Agent 捕获上下文和 Markdown 导出均携带明确的广播标记与目标名单。返回数组与持久快照隔离。
- 原生运行完成接口的 `reply` 支持 `mention_all`；正常租约、上下文和重复完成约束继续生效。模型自主动作计划的可用动作集合没有因此扩展。

## 提醒计数与筛选

统一的“有效提及”判断为：显式 `mentions` 包含本人，或广播快照包含本人且本人没有开启 `mute_all_mentions`。本人发送或已撤回的消息不构成有效提及。

| 房间字段 | 精确语义 |
| --- | --- |
| `unread_count` | 未撤回、他人发送、原消息 `seq > read_seq` 的消息条数 |
| `explicit_mention_count` | 上述未读消息中显式提及本人的条数 |
| `all_mention_count` | 上述未读消息中广播快照包含本人的条数，不因个人屏蔽而隐藏原始分类 |
| `mention_count` | 上述未读消息中的有效提及条数；同时显式提及与广播只算一条 |
| `notification_count` | 已折叠恒为 0；未折叠但免打扰为 `mention_count`；其余为 `unread_count` |

折叠列表可以继续展示真实未读和提及摘要，但不增加主导航提醒。`mute_all_mentions` 只屏蔽广播的提及效果：显式 @本人仍计入；未免打扰的普通消息未读也不会因此消失。正文编辑不修改原消息序号，不把一条已读历史消息自动改成新未读。

`/api/im/message-groups` 不增加新的内建分组，不迁移个人排序。已有分组额外返回 `mention_count` 与 `notification_count` 汇总。`@我` 保留“包含历史有效提及”的筛选语义：已读有效提及仍可让会话出现在分组中，而其未读提及计数为 0；开启屏蔽广播后，只有广播且没有显式 @本人的历史消息不再匹配本人 `@我`。

本批实现的是应用内列表/提醒计数。操作系统推送、声音、系统通知权限等尚未实现，不能把 `notification_count` 当作已发送系统通知的证据。

## Agent 事件唤醒

Agent 的 `mentions` 模式、Agent 消息触发另一 Agent 的提及门控，使用同一有效提及判断。开启 `mute_all_mentions` 后，仅靠广播不再满足提及门控；显式 @本人仍满足。`active` 模式仍能观察人类普通消息；折叠和免打扰不会暗中将其暂停。

待处理事件还必须与当前消息的有效提及同时匹配，避免作者取消广播或移除提及后，Agent 又从较早的创建事件中被唤醒。已撤回消息不触发运行。已有深度、每根消息回复上限、运行租约与暂停规则继续适用。

## MCP 与验证

`im_send`、`im_edit_message` 明确公开 `mention_all: boolean`；`im_preferences` 公开两个个人布尔偏好。`im_rooms` 描述提醒计数的实际含义。客户端不能通过 MCP 指定派生广播目标。

新增 `tests/native-folded-mentions.test.js` 的 10 项真实协议回归全部通过，覆盖个人隔离与旧数据、群广播快照及幂等、编辑/撤回与历史审计、真实计数、历史筛选、Agent 门控、旧事件防误唤醒、Human/Agent MCP、转发/搜索/上下文/导出、运行回执幂等和写入失败后恢复。

本批最终后端全量测试结果：**252/252 通过，0 失败、0 跳过，13.14 秒**。日志保存在本机 `/tmp/doc-free-folded-mentions-full.log`。`git diff --check` 通过。所有新增测试使用独立临时存储，不修改当前公司群或真实飞书数据；本后端工作阶段没有重启服务、运行模型或发布新版本。

## 集成提交补记

2026-09-06T20:37:51+08:00：实际后端实现 `b8747976dc37a68eedd199a76054a33a53a1d978`（2026-09-06T20:35:03+08:00），配套前端 `49d6115f5bd0ea15e3e9437f060e3ade503bf545`（2026-09-06T20:35:29+08:00）。后端全套252项、真实HTTP/MCP联调92项通过。Active详细交付为 `docs/equal_rights/2026-09-06/FOLDED_BROADCAST_DELIVERY_2035.md`，不得将本批当作全部飞书复刻或系统推送验收。
