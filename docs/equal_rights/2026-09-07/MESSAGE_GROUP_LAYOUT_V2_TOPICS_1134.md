# 消息分组第二版布局、展示规则与显式话题合同

- 记录时间：2026-09-07T11:34:08+08:00。
- 分支：`equal_rights`。
- doc_free 基准 commit：`1cf0cbf9c78771d0333bbe8a73344fa6d0a7cfa9`；提交时间：2026-09-07T11:07:45+08:00；描述：`docs(im): record native navigation and input delivery receipt`。
- active_agent 基准 commit：`02f740fd39645e15e199e3d635da6cb35c772442`；提交时间：2026-09-07T11:07:43+08:00；描述：`docs(office): record native group toggle and stable input verification`。
- 本文记录上述基准之后尚待 root 集成提交的源码与验证，不把基准 commit 当成本轮实现提交。本轮继续保留旧报告，语音实现延期。

## 本轮问题与实际行为

原消息分组只有九个内置过滤器。客户端把内置项和个人标签拆开绘制，允许保存的全局排序与实际展示不一致；也没有真实的云文档和话题分组。“创建话题”此前只打开普通 `reply_to` 回复链，并未创建任何共享话题记录。

这次后端新增真实 `labels`、`documents`、`topics` 内置组，统一标签容器排序合同，补充四种仅影响“消息”主分组的展示规则，并建立显式话题的持久记录、成员 API、MCP 与 A2A 授权。人和 Agent 使用同一成员接口，各自的个人规则隔离，共享话题按会话成员资格开放。

## 分组与布局迁移

`GET /api/im/message-groups` 保持 `protocol: message-groups/v1`，新增 `layout_version: 2`。默认顺序为：

```text
messages / unread / marked / mentions / labels / direct / groups /
documents / topics / completed / muted / agents
```

| 新组 | 实际筛选 |
| --- | --- |
| `labels` 标签 | 当前会话属于本人的至少一个个人标签，取手动归组与名称规则归组的并集。一个会话即使匹配多个标签也只计一次。 |
| `documents` 云文档 | 当前有成员资格、已有 `room.document_ids` 共享文档且本人 docs 应用权限可用的会话。普通消息中的链接或“文档”文字不算。 |
| `topics` 话题 | 当前会话至少有一个明确创建、根消息未撤回且本人未隐藏根消息的共享话题。普通回复不算。 |

每个个人标签仍有自己的 `label-<uuid>` ID，返回 `parent_id: labels`。`order` 是包含全部内置组与个人标签 ID 的扁平前序：个人标签连续出现在 `labels` 容器之后。内置组的相对顺序控制顶级列表，个人标签的相对顺序控制容器子项。

旧偏好缺少新组时，读取只做确定性投影：把 `labels` 插入 `mentions` 之后，把 `documents/topics` 插入 `groups` 之后；已存在的新组位置不变。保留原内置项的相对顺序、原个人标签的相对顺序，把旧跨区个人标签移入容器。`hidden_ids`、`shortcut_ids`、`revision`、`updated_at` 均不因读取变化，也不会发生读取落盘。下一次成功的个人配置写入才持久保存第二版布局，并照常增加一次 revision。

布局写入仍使用 `PATCH /api/im/message-groups` 与 `base_revision`。`order` 必须包含每个现有 ID 一次且 `messages` 第一；服务端返回规范化后的容器前序。上限改为随内置组数量计算，本版为十二个内置组加二十个个人标签，共三十二项。常用分组最多八项，仍以 `messages` 开头。`labels` 可以排序、隐藏、加入常用；隐藏和常用互相独立，隐藏不会取消数据归组或权限。

docs 权限不可用时，`documents.available=false`，结果 ID 与计数清零。权限恢复后按当前共享文档恢复结果，不删个人偏好。旧 MCP/A2A 分组回执若仍声明文档组可用，会再次核验当前 docs 权限，撤权后拒绝重放。

## 四种消息展示规则

`PATCH /api/im/message-groups` 新增可选的完整替换字段：

```json
{
  "base_revision": 3,
  "message_display_rules": {
    "groups": "unread",
    "label-example": "important"
  }
}
```

上例的标签 ID 仅作结构说明；实际必须使用服务器返回的现有 ID。规则允许现有内置分类和个人标签，不允许配置 `messages` 本身。省略字段表示不改，空对象表示清空规则，未显式配置的分类默认 `always`。快照返回顶层 `message_display_rules` 与每组 `message_display_rule`。

| 值 | 人类文案 | 会话在“消息”主分组中的条件 |
| --- | --- | --- |
| `always` | 始终显示 | 始终显示 |
| `unread` | 有新消息时展示 | 当前有本人未读消息 |
| `important` | 有重要新消息时展示 | 有有效未读 @ 或有效待本人确认的站内加急 |
| `never` | 始终不展示 | 不显示 |

优先级明确为：如果会话匹配任何**显式配置的个人标签规则**，只在这些规则中选择；否则取匹配的显式内置分类规则。同层取最严格的一项，顺序为 `always < unread < important < never`。显式的个人标签 `always` 可以覆盖内置分类 `never`；没有显式规则的标签不会凭默认值屏蔽内置设置。

规则仅过滤 `messages.room_ids` 及其对应计数。单聊、群聊、标签、云文档、话题等独立分类仍展示完整匹配结果；不修改会话成员、消息、真实已读游标或其他人的偏好。个人标签删除时一并清理对应展示规则。非法值、未知 ID、身份覆盖和旧 revision 均在写入前拒绝。

重要消息来自真实事实：未读有效 @本人或未屏蔽的 @所有人，以及当前成员周期内、来源消息版本仍有效、来源未隐藏/撤回、发送者仍有效且本人尚未确认的站内加急。普通未读不等于重要；消息已读不自动确认后来发来的站内加急。复用既有加急生命周期判断，不创建另一个加急账本。每组额外返回 `important_count`，同一消息同时被 @ 和加急时按消息 ID 去重。

## 显式话题接口

| HTTP | MCP | 行为 |
| --- | --- | --- |
| `POST /api/im/rooms/:room_id/messages/:message_id/topic` | `im_create_topic` | 显式创建共享话题，输入 `client_id` 与根消息 `base_revision` |
| `GET /api/im/rooms/:room_id/topics` | `im_topics` | 最新在前的可见话题清单，支持 `before` 和 `limit`，默认一百项、最多二百项 |
| `GET /api/im/rooms/:room_id/topics/:topic_id` | `im_topic` | 读取共享话题与当前根消息 |

创建结果：

```text
topic: {
  protocol: message-topic/v1,
  id: topic-<uuid>, room_id, root_message_id,
  created_by, created_at, revision: 1, seq
}
root_message: 当前可见根消息
duplicate: true | false
```

每个会话与根消息组合最多一个话题。人和 Agent 并发创建同一根消息会得到同一话题。稳定 `client_id` 绑定身份、会话、根消息与预期根版本，重试不重复；相同键对应不同意图返回冲突。已成功的旧意图重试可返回同一话题与当前根消息，新的创建意图必须校验当前根版本。

话题记录存入 `state.message_topics`，幂等回执存入 `state.message_topic_keys`；每会话最多一千个话题，每身份每会话最多一千条创建回执。只保存锚点元数据，不复制消息正文或创建普通聊天消息。真正新建会产生一次 `message.topic.created` 事件；重复创建不重复产生事件。会话摘要增加当前本人可见的 `topic_count`。

创建、清单、详情均需要当前会话成员资格与 IM 应用权限。根消息被本人隐藏后，本人话题清单、分组、计数与话题事件均隐藏；其他成员不受本人隐藏偏好影响。恢复根消息可重新看到话题。根撤回后所有成员不再得到可用话题；离群后不可读取旧内容。缓存回执中 `message-topic/v1` 或 `topic_id` 会重新经过当前成员与根可见性检查，不能绕过隐藏、撤回或应用撤权。

原 `GET /messages/:id/thread` / `im_thread` 继续只读真实 `reply_to` 回复树，不创建话题、不标记已读；Agent 执行因果 `root_id` 与共享话题无关。本轮没有实现话题重命名/删除或独立话题已读游标，也不声称已完成飞书全部话题产品行为。

## 验证证据

2026-09-07 本轮实跑：

- 分组十三项、显式话题六项、既有加急十四项，共三十三项通过。
- 全量 `npm test`：三百四十三项通过，零失败、零跳过；耗时约十七点六秒。
- 完整本机测试日志：`/tmp/renji-backend-groups-topics-20260907.log`。
- `git diff --check` 通过。

新增验证涵盖旧偏好只读迁移、跨区标签的规范化排序、二十标签总容量、标签并集去重、真实共享文档和权限撤销、四种规则与标签优先级、CAS 与身份隔离、@所有人屏蔽、加急确认/隐藏/来源编辑失效、显式话题与普通回复的区分、并发幂等、分页、成员/隐藏/撤回围栏、Human/Agent MCP 和 A2A、存储失败后重启恢复。

这些是本机真实模块与协议测试，测试使用临时隔离数据，不发送真实企业消息，不调用模型。Flutter 页面及飞书截图视觉验收由 root 和前端子任务另行集成记录；本报告不代替原生端实点验收，也不代表“全量飞书复刻”已经完成。

## 2026-09-07T12:04:30+08:00：实现提交确认

本轮后端实现已提交：`9cc90648cb8a7b409c3c78d5f89a1546440511c5`，Git 时间 `2026-09-07T11:57:56+08:00`，描述 `feat(im): add native group display rules and explicit message topics`。文首基准继续作为历史起点保留。客户端与最终构建记录另见本轮主集成文档。
