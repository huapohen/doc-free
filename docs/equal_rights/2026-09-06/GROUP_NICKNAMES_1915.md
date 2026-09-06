# 本人群昵称与当前显示名称

- 记录时间：2026-09-06T19:15:29+08:00。
- 分支：equal_rights。
- 基础提交：eb1f7b9b558aa9745dd154376b82b76c1c043e1c，2026-09-06T18:56:42+08:00，feat: add versioned group profiles announcements and personal pinning。
- 本批提交：尚未提交，由主代理统一审阅集成；基础提交不包含本批改动。
- 描述：补充同群成员共同可见、只能由本人设置的昵称；历史消息读取时使用当前群昵称，同时保留稳定身份及原始发送记录。
- 验证：新增 9 项定向测试全部通过；Doc Free 全量 npm test **238/238 通过，0 失败、0 跳过**，约 12.22 秒。git diff --check 通过。测试仅使用隔离临时目录，没有调用模型、CUA 或操作真实协作数据。

## 原生 API 与 MCP

所有路径以 /api/im 为前缀，需要有效当前身份、当前群成员资格和 IM 应用权限。

| 操作 | 输入 | 输出 |
| --- | --- | --- |
| GET /rooms/:room_id/membership-profile | 无 | {membership_profile, permissions} |
| PATCH /rooms/:room_id/membership-profile | {nickname, base_revision} | {membership_profile, permissions} |

membership_profile 包含 room_id、principal_id、name、nickname、display_name、revision、updated_at、updated_by。name 保留真实身份名，nickname 为空时 display_name 使用本名。permissions 为 {can_edit:true}，表示当前成员可以修改自己的昵称。其他成员的昵称通过既有 GET /rooms/:room_id 的 members 数组读取；没有给别人改昵称的旁路参数。

MCP 工具为 im_membership_profile、im_update_membership_profile，写操作必须传 nickname 和 base_revision。所有操作直接调用同一成员 API。Human、Agent、群主及普通成员都只能修改当前凭据本人。传入 principal_id、role 等额外字段会被拒绝，不能利用昵称接口改变身份或权限。

只支持群聊，缺少 kind 的旧房间按群聊兼容；direct 返回 409 group_required。昵称最多 40 个 JavaScript 字符串单位，不支持控制字符或换行，保存前 trim；空串或只有普通空格表示恢复本名。昵称不要求全群唯一，身份判断始终使用 principal_id，客户端保留本名与人类/Agent 类型。

## 版本、持久化与离群

每个房间和身份有独立 revision，旧记录缺省为 1。读取默认值不修改文件。PATCH 缺少或传入非法版本返回 422 version_required，旧版本返回 409 conflict，保留本地输入并重读即可确认差异。保存相同昵称不写盘、不产生版本或事件。

昵称存放在房间 membership_profiles[principal_id]，不改变 principal.name，也不改变别群的昵称。个人置顶、收藏和免打扰仍是独立个人偏好，群昵称则向所有当前群成员公开。

实际更新写入服务端时间、修改者、独立 revision，并产生 membership_profile.updated 事件；使用既有单写者事务队列及 fsync/rename 持久化。昵称只是显示名称，不改变 room.revision、成员角色、权限、消息 revision 或消息作者 ID。运行仍以稳定身份 ID 判断授权；改昵称不会取消已捕获的运行。

移除或永久撤销成员时，清空其群昵称并递增独立版本，保留版本墓碑。重新邀请后显示本名，旧编辑器持有的 base_revision 无法复活昵称。移除事件和昵称清理在同一持久化事务中完成。普通停用不会冒充本人修改昵称，但停用身份不能读取或写入。存储失败沿用 503 storage_failed 停止读写；已存在但损坏的昵称配置会阻止启动，不静默重置。

## 当前昵称和发时昵称

成员视图新增 nickname、display_name、membership_profile_revision、display_name_basis。稳定 principal_id、name、kind、role 均保留。

消息作者视图新增 nickname、display_name、display_name_basis。最近消息、分页历史、单条原消息、回复父消息、置顶消息、搜索结果、会话 last_message，以及发送、编辑、反应、置顶、转发和幂等重试的回执，都从目标房间当前成员资料计算 display_name。display_name_basis 为 current_room_nickname。清空昵称后使用当前真实身份名；离群后不继续展示已清理昵称。

原始消息存储不会被批量改写。新消息发送时保存作者昵称快照，标注 sent_room_nickname；已有 message.created 等事件保持逐字不变。消息修订 history 不受昵称更新影响。转发消息显示转发者在目标房间的昵称，不把源房间昵称带入另一群。

Agent 新租约上下文中的 participants 和 messages 使用捕获时的当前群昵称。已保存的运行上下文保持当时快照，不随之后改名变化。MCP/A2A 已保存的操作回执也是历史操作快照，读取仍校验当前成员资格和应用策略；需要当前昵称时重新调用原生读取。

Markdown 导出当前消息使用当前昵称，并明确列出 current_author 与 sent_author；已有原始作者快照和历史事件未改写。另增加“群昵称变更审计”，记录旧昵称、新昵称、真实修改身份、时间及 self_updated/membership_removed 原因。导出说明区明确当前显示与发时快照的区别。

## 成员移除的服务端保护

既有 DELETE /rooms/:room_id/members/:principal_id 仍不接受 CAS 版本，返回 {removed:true}。当前 owner 权限在服务器单写者队列内验证。本批额外拒绝移除调用者本人、任何当前 role:owner 成员和原 created_by，返回 409 owner_required；防止仅靠 UI 判断、在未来多房主情况下误移除群主。私聊成员仍固定，返回 409 direct_membership。

## 测试证据

1. 同群共同可见、本人昵称持久化、空串恢复本名、真实身份名/角色/别群/别身份隔离。
2. Human 与 Agent 对等本人修改；群主无法以 principal_id 冒充给别人改；非成员及私聊拒绝。
3. 并发 CAS 单赢家、独立成员版本、冲突不覆盖、无变化不写入、非法输入整体拒绝。
4. 历史消息、父消息、置顶、搜索、反应回执和 last_message 的当前昵称一致；原始消息作者与创建事件不变；撤回墓碑不回露正文。
5. 跨群转发使用目标群昵称，幂等重试返回最新目标群显示信息且不新增消息。
6. Agent 捕获上下文冻结、当前读取更新、事件只向当前成员公开、导出区分 current_author/sent_author。
7. 离群清理、重新加入版本墓碑、旧 CAS 拒绝，以及 self/多 owner 移除保护。
8. MCP 本人权限与 CAS、A2A 旧回执撤权、IM 应用策略与事件过滤。
9. 持久化失败停止服务并恢复上一个完整状态；损坏昵称状态拒绝启动。
