# 消息旁分组：个人导航、标签与真实会话归类

- 时间：2026-09-06T17:21:00+08:00。
- 分支：`equal_rights`。
- 本批基线 commit：`b068445dfa0f5f8f388035b71c3bb93654894e60`，时间 `2026-09-06T17:04:19+08:00`，描述 `feat: add personal navigation, shared minutes and default agent colleagues`。
- 本文记录该基线后的独立分组批次，最终提交由总发布记录关联。UI 操作和截图另记。

## 已实现范围及参考边界

消息旁三条杠打开个人分组入口。后端将两种配置分开保存：侧栏分组的显示/隐藏与排序、手机常用分组列表。消息固定在首位且不可隐藏。配置由当前人或 Agent 自己持有，与工作区组织、群成员和底部主功能导航无关。

实际查看飞书确认了：编辑分组的展示/隐藏及排序，手机常用分组独立配置，自定义标签的名称/规则、添加会话与编辑/删除菜单；添加会话支持搜索、多选人类单聊和群聊；至少存在“会话名称包含关键词”的规则。未保存参考产品配置，未删除其真实标签。参考实看未证实同会话多标签、Agent/机器人是否可选，以及删除后的底层语义。

本项目明确采用自己的原生规则：所有获准的人/Agent 单聊和混合群聊都能归类；一个会话允许多个个人标签；删除标签只解除本人的归类，保留会话、消息、任务和其他成员偏好。这些是本项目实现，不声称是参考产品已验证行为。自动规则目前只有不区分大小写的会话名称 contains；高级条件组合、按标签控制通知与标签内独立会话排序未实现，不提供虚假按钮或 API。

## 默认筛选

| ID | 名称 | 实际含义 |
| --- | --- | --- |
| messages | 消息 | 当前身份所有可见会话；包含本人标为完成的会话 |
| unread | 未读 | 有别人发出的未读且未撤回消息 |
| marked | 标记 | 本人标记；与原有 favorite 收藏独立 |
| mentions | @我 | 至少包含一条未撤回且提及本人的消息；读后仍可检索 |
| direct | 单聊 | 双人会话，包含人和 Agent |
| groups | 群聊 | 非双人会话，允许人/Agent 混合参与 |
| completed | 已完成 | 本人将会话标为完成；不代表任务完成 |
| muted | 免打扰 | 使用已有个人会话 muted 偏好，默认隐藏 |
| agents | Agent 单聊 | 双人会话的另一位参与者是 Agent，默认隐藏 |

组内 `room_count` 和 `unread_count` 来自当前实际获准会话，后者是组内会话全部未读消息之和。计数不是模板数字，也不复制会话正文。暂不把云文档、话题、服务台或会议等参考产品类别伪装成本项目已有的独立消息会话类型。

## 一套个人 API

统一前缀 `/api/im`。

| 请求 | 输入/结果 |
| --- | --- |
| `GET /message-groups` | 完整个人快照；旧账号读取默认值不落盘、不变更版本 |
| `PATCH /message-groups` | base_revision；可选 order、hidden_ids、shortcut_ids |
| `POST /message-groups` | base_revision、client_id、name；可选 name_contains |
| `GET /message-groups/:label_id` | 当前个人标签详情与 revision |
| `PATCH /message-groups/:label_id` | base_revision；可选 name、name_contains、add_room_ids、remove_room_ids |
| `DELETE /message-groups/:label_id` | base_revision；仅删个人标签和引用 |
| `GET /rooms/:room_id/message-groups` | 读取当前会话的个人归组/标记/完成状态 |
| `PATCH /rooms/:room_id/message-groups` | base_revision；可选 group_ids、marked、completed |

完整快照包含 `protocol: message-groups/v1`、`principal_id`、`revision`、`updated_at`、`order`、`hidden_ids`、`shortcut_ids`、`groups`。每个组返回 `id/name/description/type/fixed/visible/available/name_contains/room_ids/room_count/unread_count`；type 为 builtin 或 label。仅返回当前有成员资格的 room_ids。

`order` 必须是所有内置组与现有标签的完整不重复排序，以 messages 开始；`hidden_ids` 不包含 messages；`shortcut_ids` 为 1–8 个不重复有效 ID，以 messages 开始。手机常用可以包含侧栏隐藏项，两者独立。最多 20 个个人标签，名称最多 40 字符，个人标签名称不能忽略大小写后重复。默认常用为 messages、unread、mentions。

新建标签返回 `created_group_id` 和 `duplicate`。按身份隔离的 client_id 去重不受请求对象键顺序或后续 revision 变化影响；相同请求重试返回同一真实标签与当前快照，改内容复用 ID 返回 409。已删除标签的旧创建意图返回 `group_deleted`，不复活。最多保留 500 条创建意图。label ID 由服务器生成，客户端不能设置另一个人的身份或偏好归属。

`name_contains: null` 清除自动规则；非空关键词最多 100 字符。自动匹配与手工选择取并集，规则实时读取当前会话名称。手工移除不会取消仍被规则匹配的归类；需要修改规则。批量 add_room_ids/remove_room_ids 最多各 500 项，先验证每个会话当前成员资格和两个列表不重叠，再一次写入，任何一个失去权限则整次拒绝。

`GET /rooms` 的每项及单会话详情的 room 都新增 `message_grouping`，内容为 `protocol: message-grouping/v1`、`principal_id`、`room_id`、`group_ids`、`manual_group_ids`、`matched_group_ids`、`marked`、`completed`。归组 PATCH 响应也带同结构的 `room_grouping`。group_ids 只接受本人标签 ID，内置组按真实条件计算。

## 并发、持久化与授权

`state.message_groups[principal_id]` 保存个人 order、hidden_ids、shortcut_ids、labels、room_settings 和 create_keys。所有修改共用一个个人 revision，因此手机修改排序与桌面添加标签不会无声覆盖。每次 PATCH/DELETE 必须带当前 base_revision；冲突返回 409，客户端应保留草稿、读取最新版本并明确重试。新建丢失响应可使用原 client_id 重试。

变更进入现有 IM 串行队列；所有输入先完整校验，再变更快照、发布本人可见的 `message_groups.updated` 事件并一次原子落盘。事件顶层 revision 和 audience_ids 均属于该身份。落盘失败进入既有 fail-stop，后续读写拒绝，重启保留上一版成功记录。参考 UI 的结构没有引入平行数据库或复制消息内容。

分组归类不授予 room ACL。移出会话后，原偏好引用在保存文件里可以保留，但新读取不返回该 room ID/计数；旧 A2A 回执也必须重新验证当前成员资格。回执中的个人分组协议标识与 principal_id 防止将一个人的个人快照授权给另一身份。IM 应用策略关闭后 API/MCP/A2A 访问均拒绝，个人事件也按现有策略过滤。

## Agent 工具与验证

MCP/A2A 使用既有同一成员合同：`im_message_groups`、`im_configure_message_groups`、`im_create_message_group`、`im_update_message_group`、`im_delete_message_group`、`im_room_message_groups`、`im_set_room_message_groups`。人和 Agent 同权配置自己的个人列表，均不能修改他人的配置。没有把导航偏好加入自动 worker 的动作计划或模型触发上下文。

必要验证运行：

```sh
node --test tests/native-message-groups.test.js tests/native-app-policies.test.js tests/native-a2a.test.js tests/native-im.test.js
```

结果 **54/54 通过**，含本批新增 7 项：独立侧栏/常用配置与 CAS，幂等标签/删除不复活，多标签/实时规则/批量原子归类，真实筛选与个人标记，ACL/事件/回执隔离，人/Agent MCP 与真实本机 A2A 调用，以及存储失败恢复。全部使用临时 fixture，无模型调用、无用户服务或实体鼠标操作。

提交前完整 `npm test`：**217/217 通过，0 失败、0 跳过**，包括基线全部 210 项和上述 7 项。真实 HTTP/CRDT/A2A/MCP 测试由隔离进程完成。
