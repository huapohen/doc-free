# 未读窗口、真实阅读回执、原生话题与完整表情 · 2026-09-06 21:23

记录时间：2026-09-06T21:23:03+08:00，Asia/Shanghai。分支：`equal_rights`。

本批代码基线为 `b8747976dc37a68eedd199a76054a33a53a1d978`（2026-09-06T20:35:03+08:00）；当前已提交文档基线为 `38b65df37f8f25f0c4506d1a052c26a0d50273cc`（2026-09-06T20:42:00+08:00，折叠会话与广播协议说明）。写入本记录时本批实现尚未汇总提交，最终交付记录须另列实际实现 commit，不能用上述旧 commit 代替。

本说明与 20:35 折叠/广播、20:45 桌面导航文档分别保存，历史文档保持可查。此处记录后端协议与已完成测试；客户端画面和真实运行服务验证由集成交付另行记录。

## 消息窗口与未读定位

`GET /api/im/rooms/:rid` 的最近 200 条消息兼容行为保持不变。`GET /api/im/rooms/:rid/messages` 现在支持下列互斥定位方式，消息按序号升序返回：

| 参数 | 语义 |
| --- | --- |
| `first_unread=true` | 从本人第一条未读消息开始，第一条返回消息就是未读锚点；不存在未读时返回最近窗口，锚点为 null |
| `around=N` | 定位首个序号大于等于 N 的消息，并返回前后上下文；超过尾部时定位最后一条 |
| `after=N` | 序号严格大于 N 的最早一页；N 可以为 0 |
| `before=N` | 序号严格小于 N 的最近一页，兼容既有历史翻页 |
| 无定位参数 | 最近一页 |

`limit` 默认 100，范围 1–200；`around`、`before` 要求正安全整数，`after` 要求非负安全整数。`first_unread=false` 不激活定位。正文搜索 `q` 仍支持默认、before、after；与 first_unread/around 混用、非法布尔值或多个定位方式返回 `422 invalid_input`。

```json
{
  "messages": [],
  "has_more": true,
  "has_more_before": true,
  "has_more_after": true,
  "before_cursor": 120,
  "after_cursor": 219,
  "anchor_seq": 120,
  "first_unread_seq": 120,
  "read_seq": 119,
  "unread_count": 300,
  "remaining_unread_after": 200
}
```

`has_more` 始终是“还有更早消息”的兼容字段；向后翻页须读取 `has_more_after`。空页 before/after cursor 为 null。`remaining_unread_after` 只计算返回窗口之后的未读消息；窗口内视口下方尚未看见的未读数量由客户端结合实际可见位置计算。

未读排除本人发出的消息与已撤回消息，使用个人会话 `read_seq` 水位。会话列表和详情的 `room.first_unread_seq` 与窗口采用相同规则，不能用最近 200 条反推更早历史的首未读位置。

所有 GET 均不发送阅读确认。确认沿用 `PATCH /api/im/rooms/:rid/preferences` 的 `{ "read_seq": N }`，也即 MCP `im_preferences`；没有另建 `/read` 端点。客户端须明确提交实际看到的累计位置，不能把最大已下载序号自动当作已看位置。服务端水位只增不减，上限为该会话最后一条消息，越界无效输入不部分修改其它偏好。

## 发送时收件人和真实已读证据

每条新消息在服务端追加时保存 `recipient_snapshot_version: 1`、`recipient_ids` 与 `recipient_snapshots`。收件人是发送时的会话成员，排除作者；与 @、@所有人、通知静音及处理模式无关。普通消息、转发与 Agent 完成回合产生的消息均走相同追加路径，转发记录目标会话的收件人。

快照保存主体 ID、当时名称、human/agent 类型和成员加入周期。新加入周期使用 `joined_seq`，已有旧成员使用既有 `joined_at` 作为兼容周期标识；即使同一毫秒离开并重新加入也能区分新周期。

只有显式 PATCH `read_seq` 才会在 `room.read_acknowledgements[principal_id][membership_key]` 保存累计阅读证据 `{read_seq, at}`。加入时的初始未读水位、GET 请求、Agent claim/finish 与 worker cursor 均不会生成证据。离开再加入后，新成员周期的 ACK 不会把旧周期消息追认为已读；旧周期已保存证据仍保留。

消息视图、会话 `last_message`、执行上下文、搜索结果和会话导出包含动态 `receipt_summary`：

```json
{
  "known": true,
  "basis": "explicit_read_ack",
  "eligible_count": 2,
  "read_count": 1,
  "unread_count": 1,
  "unknown_count": 0
}
```

旧消息没有发送时收件人证据时返回 `known: false`、`basis: "legacy_unknown"`，四个数量均为 null。不能拿当前成员名单、后来加入时的高水位或后来 ACK 伪造历史回执。已撤回消息使用 `basis: "message_retracted"` 和相同未知数量。

`GET /api/im/rooms/:rid/messages/:mid/readers` 返回 `message_id`、`receipt_summary` 和 `readers`。已知收件人的每项包含：

```json
{
  "principal_id": "principal-…",
  "name": "发送时名称",
  "kind": "agent",
  "status": "read",
  "read": true,
  "current_member": true,
  "same_membership": true,
  "read_ack_seq": 219,
  "acknowledged_at": "2026-09-06T13:20:00.000Z"
}
```

`acknowledged_at` 是最新累计确认时间，不承诺消息首次阅读的精确时刻。历史成员可能已不在当前会话，`current_member` 和 `same_membership` 明确标注。未知或撤回消息 `readers` 为空。成员视图另含当前加入周期的 `read_ack_seq`，与处理游标 `cursor` 和未读水位 `read_seq` 分开。

客户端若展示私聊已读勾，须确认消息作者是当前身份、会话是私聊且 `known=true, eligible_count=1, read_count=1`；没有证据时维持未知显示。

## 原生话题回复

`GET /api/im/rooms/:rid/messages/:mid/thread?after=0&limit=100` 沿真实、不可变的 `reply_to` 递归读取后代。`root_id` 表示 Agent 执行根，不能用于替代回复图；人类回复可能开启新执行根，但仍属于原消息话题。

```json
{
  "root_message": {},
  "messages": [],
  "total_replies": 3,
  "has_more": true,
  "next_after": 120,
  "after_cursor": 120
}
```

根消息单独返回，`messages` 只含递归后代，升序排列。after 为独占非负游标，默认 0；limit 默认 100，范围 1–200。剩余一页读完时 `next_after` 为 null；空页的 `after_cursor` 等于请求 after。仅支持 after/limit，其它查询参数返回 422。

进入话题只是读取已有回复图，不创建话题占位、不发消息、不 ACK。发回复仍使用普通消息接口或 MCP `im_send`，设置 `reply_to` 指向被回复的真实消息。根和后代被撤回时保留空 tombstone 及后续回复可达性，省略版本 history、正文、附件和转发内容，不从旧版本恢复隐藏正文。

新增 MCP `im_thread` 与 `im_message_readers`；`im_history` 扩展窗口参数。Human 与 Agent 使用同一成员接口。无当前成员身份返回 403，错误会话或不存在消息返回 404；企业 IM 策略也适用，A2A 缓存回执再次读取时重新验证当前成员权限。

## 完整表情目录与个人最近使用

`native-emoji-catalog.json` 是本批固定目录：182 项经典表情，加上 Unicode 17.0 的 3944 项 fully-qualified 序列，共 **4126 个唯一 ID**，10 个分类。目录资源来源与图片交付由本批集成文档记录。

`GET /api/im/emoji?q=&category=&offset=0&limit=100` 返回：

```json
{
  "version": "emoji-catalog/v1",
  "unicode_version": "17.0",
  "categories": ["经典表情", "笑脸与情感"],
  "catalog_count": 4126,
  "total": 182,
  "offset": 0,
  "limit": 100,
  "has_more": true,
  "next_offset": 100,
  "entries": []
}
```

categories 示例省略其余分类。`catalog_count` 是总目录大小，`total` 是过滤结果大小。q 支持中文名称、英文名称、别名、ID、分类及子类，经过 NFKC 和大小写归一化后按空格分词匹配。category 必须来自目录；offset 非负，limit 默认 100、范围 1–200，q 最多 100 字符；非法参数返回 422。

经典 ID 使用 `feishu:SMILE`，条目包含 `asset: "assets/emoji/feishu/SMILE.png"` 和消息输入文本 `text: ":feishu:SMILE:"`；Unicode ID 就是完整序列，例如 `😀`，text 与 ID 相同。反应提交要传条目的 **id**，不能把 text token 当作经典反应 ID。校验使用完整目录 Set/Map，肤色、性别及 ZWJ 序列均按原样校验，不把 4126 项塞进 MCP schema。

`GET /api/im/emoji/recents` 和 `POST /api/im/emoji/recents` 使用本人凭据。POST 只接受 `{ "emoji": "feishu:SMILE" }`，不接受指定其它身份的字段或查询参数；返回：

```json
{
  "emoji_ids": ["feishu:SMILE", "😀"],
  "entries": [],
  "limit": 32,
  "updated_at": "2026-09-06T13:20:00.000Z"
}
```

entries 实际包含与 emoji_ids 同顺序的完整目录条目。最近使用保留 32 个不同 ID，新选或重选移到最前；原本第一项再选择不增加事件、不重写文件。旧数据首次 GET 返回空列表及 null 时间，不做隐式迁移写入。

输入框选择表情显式 POST 最近使用。消息回应添加由后端自动写同一份最近使用；取消回应不提升顺序。回应与个人最近记录在同一个串行事务中一次持久化，失败时服务 fail-stop，重启恢复最后实际写入状态。更新事件 `emoji.recents.updated` 仅对本人可见，Human/Agent 完全相同。

新增 MCP `im_emoji_catalog`、`im_recent_emoji`、`im_use_emoji`；`im_react` 接收 string 并要求来自目录的精确 ID。目录、最近使用、反应都受 IM 应用策略保护；反应另须当前会话成员身份。旧六个快捷回应仍作为 `agent-store.reaction_options` 的快捷项返回，同时提供 `emoji_catalog` 发现路径，不再充当全目录限制。

21:28 后续补充：新增本人 `DELETE /api/im/emoji/recents` 与 MCP `im_clear_recent_emoji`。不接受 body 字段或查询参数，仅清空本人最近列表，保留所有已发送消息和回应；空列表是只读 no-op。操作继续使用 IM 应用策略、个人事件与一次持久化，供用户清空历史，也使联调能通过公开 API 精确恢复原最近列表及顺序，而不直接篡改运行状态文件。清空及重新选择的更新时间正常推进。

## 验证与范围

- `tests/native-message-reading.test.js` **9/9 通过**：225 条跨越 detail tail 的首未读、双向窗口、局部 ACK、真实递归回复、撤回内容处理、Human/Agent、晚加入与再加入周期、旧历史未知、持久化故障、MCP/A2A 权限、搜索及转发收件人。
- `tests/native-emoji.test.js` **6/6 通过**：4126 项分页完整性、中英文/ID/分类检索、32 项去重隔离、私有事件、经典与 ZWJ 反应、同权 MCP、企业策略、反应/最近记录原子恢复。
- 包含桌面导航及全部既有功能的后端全量 **272/272 通过，0 失败、0 跳过，14.01 秒**，日志 `/tmp/doc-free-reading-emoji-full-fixed.log`。

首次全量运行暴露 3 处隔离 HTTP/编辑器测试只复制 JS/HTML，导致新 JSON 资源缺失、23 项启动前失败。已精确把 `native-emoji-catalog.json` 加入 fixture 拷贝与集成源码摘要；未扩大到复制 .env 或运行数据。修复后全量通过，首次失败记录保留在 `/tmp/doc-free-reading-emoji-full.log`。

本后端批次没有启动模型或 worker，没有新增真实 Agent，没有重启父任务正在操作的在线服务，没有操作真实飞书界面或凭据。此文档不把源码测试误写为已部署验证；最终服务版本、客户端交互证据和实际实现 commit 由集成交付补齐。

21:33 后续验证：增加清空最近使用的专项后，表情测试 **7/7**，全量 **273/273，0 失败/跳过，14.22 秒**（`/tmp/doc-free-reading-emoji-clear-full.log`）。父任务统一重启后完成真实 HTTP/MCP **424/424** 检查；详见另存的 `READING_EMOJI_LIVE_2133.md`，该记录区分成员 API 验证与尚待最新 Flutter 资源构建的图片 HTTP 验证。
