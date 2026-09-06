# 群资料、群公告、个人置顶与历史原消息

- 记录时间：2026-09-06T18:44:46+08:00。
- 分支：`equal_rights`。
- 基础提交：`5618e90e370bb43ee7c4cd5b2cfd86156b1366a5`，2026-09-06T17:39:33+08:00，`fix: expose optional participation revision checks through MCP`。
- 本批提交：尚未提交，由主代理统一审阅集成；不能把基础提交当作本批实现提交。
- 描述：为现有群聊补持久化资料、公告与独立版本；个人置顶独立于收藏；按消息 ID 打开历史原文时保护已撤回内容。
- 验证：`npm test` **229/229 通过，0 失败、0 跳过**；其中本批新增 11 项测试。耗时约 11.77 秒。`git diff --check` 通过。只使用临时目录与随机测试凭据，未调用真实模型、修改真实飞书数据或重启用户服务。

## 群资料与公告协议

以下路径均以 `/api/im` 为前缀，需要当前登录凭据和当前群成员资格；IM 应用策略照常生效。

| 方法及路径 | 请求 | 返回 |
| --- | --- | --- |
| `GET /rooms/:room_id/profile` | 无 | `{profile, permissions}` |
| `PATCH /rooms/:room_id/profile` | `{base_revision, name?, description?}`，至少修改一项 | `{profile, permissions}` |
| `GET /rooms/:room_id/announcement` | 无 | `{announcement, permissions}` |
| `PATCH /rooms/:room_id/announcement` | `{base_revision, content}` | `{announcement, permissions}` |

`profile` 为 `{room_id, name, description, revision, updated_by, updated_at}`。`announcement` 为 `{room_id, content, revision, updated_by, updated_at}`。`permissions` 为 `{can_edit, reason}`，供客户端展示真实可编辑状态，服务端仍在每次写入时复核权限。

群名为 1–100 字符且不能只有空白；描述最多 4,000 字符，可以清空；公告最多 20,000 字符，空字符串表示清空。长度采用 JavaScript 字符串长度。公告正文不经过模型改写或截断。未知写入字段被拒绝，不接受借资料接口修改房主、成员或角色。

资料和公告的 `revision` 分别从 1 开始，独立于 `room.revision`。PATCH 必须传对应对象的当前 `base_revision`；缺失或类型错误返回 `422 version_required`，过期返回 `409 conflict`。修改公告不会令资料版本失效，反之亦然。实际内容相同的请求不产生新版本、不写盘、不新增事件。保存后原样重试旧版本仍会得到冲突，应读取最新版本确认结果。

实际变更时，对应对象的 revision 和房间 revision 各增加 1，记录 `updated_by`、服务端时间以及不可变的事件前后快照，然后使用现有单写者队列、临时文件、fsync、rename 持久化。写盘失败会进入既有 `503 storage_failed` 停止读写状态；重启读取上一个完整持久化状态。出现已存储但格式损坏的资料元信息或公告时拒绝启动，不静默重置。

## 权限和旧群兼容取舍

现有 `newRoom()` 已为创建者写入 `role: "owner"`；人和 Agent 建群完全使用同一路径。当前成员均可读群资料和公告，只有当前显式 `role: "owner"` 成员可写。企业 owner/admin 不会因此自动获得群维护权限，普通人类成员也不能覆盖 Agent 群主的公告。

只兼容同时符合以下条件的旧数据：房间保留明确的 `created_by`；该创建者仍为当前成员；此成员记录完全缺少 `role` 字段；整个房间没有任何记录为 `owner` 的成员。此时仅该创建者返回 `can_edit: true, reason: "legacy_creator"`。不会修改其角色或回填 ACL，也不会将其他人提权。显式 `role: "member"`、空角色、缺失创建者、已有其他房主时不适用回退，返回 `owner_required`。这种严格取舍可能让不完整的旧房间保持只读，避免猜测所有权。

缺少 `kind` 的旧房间按群聊处理。`kind: "direct"` 的固定双人会话对上述群资料/公告接口返回 `409 group_required`；不能通过修改资料把私聊变成群。移除或停用后的成员不能继续读取，A2A 旧回执也会重新检查当前群成员资格。

## 人和 Agent 可见的记录

- `roomView` 群列表项新增 `profile_revision`、`announcement_revision`、`announcement_preview`（最多前 280 字符）；完整正文通过公告接口读取。
- Agent 租约上下文新增 `context.room_details: {profile, announcement}`，完整正文保留。私聊此字段为 `null`。
- 会话 Markdown 导出包含完整资料/公告元信息、独立“群公告”正文，以及群资料和公告的修订审计。代码围栏会随正文中的反引号自动延长。
- 事件类型为 `room.profile.updated`、`room.announcement.updated`，包含 `actor_id`、`room_id`、时间、对象 revision、`previous` 和当前 `profile`/`announcement` 快照；仍按当前成员与 IM 应用权限过滤。
- 房间版本变化使基于旧群约定的运行在发布时得到 `409 stale_context`，旧结果不进入聊天。此次未新增“改公告立即调用模型”的自动触发器；既有事件与工作调度仍适用。

MCP 对等工具为 `im_room_profile`、`im_update_room_profile`、`im_room_announcement`、`im_update_room_announcement`；它们调用与人类客户端完全相同的成员 API。写工具要求对应 `base_revision`，不持有管理员旁路权限。

## 个人置顶

`PATCH /rooms/:room_id/preferences` 新增可选布尔字段 `pinned`，默认 `false`。读取个人 `preferences.pinned` 或 `roomView.is_pinned`；MCP `im_preferences` 同时接受 `pinned`。

置顶与 `favorite` 收藏、`muted` 免打扰分别保存。置顶只属于当前登录身份，不修改其他成员的排序、不改变群权限，也不增加房间共享 revision。仍复用现有个人偏好更新事件与持久化。客户端列表排序和标识由 Active 客户端消费 `is_pinned`；本后端批次不改 Flutter。

## 按 ID 读取原消息

`GET /rooms/:room_id/messages/:message_id` 返回 `{message, reply_parent}`，其中 `reply_parent` 是同一房间内直接回复的父消息，没有时为 `null`。MCP 对等工具为 `im_read_message`。返回正常消息的作者结构与完整当前正文，可打开已不在最近 200 条列表中的搜索命中。

请求先检查当前房间成员资格；非成员返回 `403 not_a_member`，在一个已加入的房间里使用另一个房间的消息 ID 返回 `404 not_found`。不会跨房间查找父消息。

该新接口始终省略消息 `history`。已经撤回的主消息或父消息保留标识、作者、时间和撤回状态，正文置空、附件及其 ID 清空、mentions/reactions 清空，并删除转发来源字段；引用预览不会泄露旧正文或附件文件名。现有明确标注为历史审计的 Markdown 导出等接口保持原来的审计契约，本批未删除历史记录。

## 测试覆盖

1. 首读不落盘、资料/公告独立 CAS、并发单赢家、无变化不写入、重启保留与清空公告。
2. 人类成员、Agent 成员、企业管理员无越权；Agent 群主可写；移除成员后读取被拒绝。
3. 旧 kind/role 缺失的严格创建者回退，以及显式普通成员/已有其他房主/创建者缺失时拒绝提权。
4. 非法长度、字段、版本和半有效输入整体拒绝；私聊不能调用群维护接口。
5. 长公告全文导出与 Agent 上下文、成员可见事件、修订审计、旧上下文发布被拒绝。
6. MCP 群资料、公告、独立 CAS 和个人置顶真实调用。
7. 个人置顶与收藏、免打扰、房间 ACL、其他身份互相独立且重启持久。
8. IM 应用策略及当前成员资格控制事件和 A2A 已存回执读取。
9. 写盘失败停止服务并恢复前状态，损坏元数据不被静默重置。
10. 超过最近 200 条后的历史消息按 ID 打开，包含作者和同群父消息；跨房间拒绝。
11. 已编辑再撤回的父消息和主消息都不泄露旧正文、历史或附件元数据。
