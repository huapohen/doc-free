# 人机妙记：共享逐字稿、录音引用与文档/任务关联

- 记录时间：2026-09-06T16:43:00+08:00。
- 分支：`equal_rights`。
- 基线 commit：`ab9c613ef3c9ea2d57521daa68ef45bc3c7736c2`，提交时间 `2026-09-06T16:16:03+08:00`。
- 本文描述该基线之后本批后端实现；最终 commit 由总发布记录关联。UI 截图、点击验收及实际服务状态由独立 UI 记录给出。

## 已实现的用户结果

“人机妙记”是当前会话成员共同拥有的记录：人和 Agent 使用相同成员 API 创建、查看和修订。内容可以包含手动输入或导入的逐字稿、原会话已有的录音附件、同会话会议、已经共享的 Doc Free 文档和已存在的任务。记录、作者、修订者、时间和 revision 均可见，不把模型内存当作协作产物。

本批没有配置语音识别服务，没有从音频生成文字，没有调用模型生成摘要。每次读取均明确返回 `transcription.status = provider_not_configured`、`summary.status = not_generated` 和 `transcript_source = manual_or_imported`。即使已经关联文档，也不把它标为 AI 摘要。手工提供的发言人名称不代表自动说话人识别。

`minutes` 已加入内置应用目录、工作台和移动底栏允许入口，默认可用；企业应用策略决定有效可见范围。移动菜单默认仍为 messages、agents、docs、workbench，成员可自行选择 minutes。菜单偏好不授予业务权限。

## API 合同

所有地址以 `/api/im` 为前缀，复用已有成员凭据。

| 方法/路径 | 行为 |
| --- | --- |
| `GET /minutes?q=&room_id=` | 在当前成员会话内按标题或逐字稿文本搜索，最多返回 200 项摘要 |
| `GET /rooms/:room_id/minutes` | 读取当前会话的妙记摘要列表 |
| `POST /rooms/:room_id/minutes` | 用稳定 client_id 创建共享妙记 |
| `GET /minutes/:minute_id` | 读取完整逐字稿及当前允许公开的关联信息 |
| `PATCH /minutes/:minute_id` | 用 base_revision 修订字段或完整替换逐字稿 |

创建输入示例仅为协议结构，不包含真实录音或服务凭据：

```json
{
  "client_id": "meeting-review-intent-1",
  "title": "评审妙记",
  "meeting_id": null,
  "audio_attachment_id": null,
  "transcript": [
    {
      "speaker_id": null,
      "speaker_label": "手工标注的发言人",
      "offset_ms": 0,
      "text": "成员实际提供的文字。"
    }
  ],
  "document_id": null,
  "task_ids": []
}
```

创建和详情返回 `{minute}`；创建另有 `duplicate`。列表返回 `{minutes, truncated}`。记录字段为 `id, room_id, title, meeting_id, audio_attachment_id, transcript, document_id, task_ids, revision, created_by, updated_by, created_at, updated_at`。读取投影附带上面的能力状态，以及 `audio_attachment` 元数据、`transcript_count` 和兼容别名 `segment_count`。列表不返回 `transcript` 正文，两种计数均为当前真实段数。查看正文应请求详情；搜索先检查成员范围，再匹配标题和逐字稿。

段落在创建时获得服务器生成的 `id`。修订可以省略 ID 生成新段落，也可保留该记录当前段落的 ID；其他记录 ID 或重复 ID 被拒绝。`speaker_id` 非空时必须是当前有效会话成员，标签由服务器当前成员名决定，输入不能冒充另一个显示名称。未绑定身份时允许手工标签。

限制：标题最多 200 字符；逐字稿最多 200 段，每段最多 4,000 字符，累计最多 100,000 字符；`offset_ms` 为 0 至 86,400,000 的非递减整数；最多 30 个不重复任务 ID。预览实例最多 2,000 份妙记，每会话最多 200 份。全量逐字稿替换适合本地预览，不宣称大规模流式语音编辑。

## 关联真实资源

会议、文档、任务和音频引用必须属于同一个当前成员会话。设置文档需要 docs，设置任务需要 tasks，会议需要现有 meetings/calendar/docs 权限组合，录音引用需要 im。既有 `POST /rooms/:room_id/documents` 和 `POST /rooms/:room_id/tasks` 创建可见实体，成功后再 PATCH 妙记的 `document_id` 或 `task_ids`。

创建实体和关联妙记是两步操作：若第二步 CAS 冲突，第一步已经产生的实体仍真实存在；客户端应保留 ID 并重试关联，不应悄悄再创建。后端没有新增跨存储原子事务，也没有根据逐字稿自动认定行动项。确定性的文字整理应标明人工/导入来源。

音频使用已有附件 API，详情返回现有 `download_path`；下载仍由附件 API 重新验证成员权限。附件子系统将未验证的非图片 MIME 归一为 `application/octet-stream`，因此本批接受已有附件 `audio/*` MIME 或 `.mp3/.wav/.m4a/.aac/.ogg/.opus/.flac/.webm` 文件名提示。该提示不证明编码有效或内容是语音；没有新增编码器或真实转写。附件被删除、其消息均被撤回或成员无 im 权限时，妙记不再公开该附件引用。

## 一致性与权限

状态保存在现有 IM 文件的 `minutes.records` 和 `minutes.create_keys`，所有操作进入既有串行队列。字段先完整验证，再一起变更记录、事件、创建去重索引，并复用一次原子落盘。持久化失败进入现有 fail-stop，重启恢复最后成功提交的版本，不能后续提交已拒绝的修订。

创建去重范围为当前身份、会话与 client_id。请求对象键顺序经规范化后计算摘要；完全相同意图重试返回当前版本，内容变化返回 `409 idempotency_conflict`。修订要求整数 `base_revision`；旧版本返回 `409 conflict`，不覆盖其他成员编辑。人/Agent 没有独立绕过权限的分支。客户端不能替换 `created_by` 或 `updated_by`。

事件为 `minute.created` 和 `minute.updated`，沿用事件顶层结构：`seq, type, room_id, actor_id, at, minute_id, revision`，没有额外的嵌套 payload。事件可见性受 minutes 策略和当前会话成员资格控制。退出会话、身份撤销、应用禁用后访问均重新判断。

关联应用被禁止时，新的妙记读取隐藏对应关联字段；曾经包含这些字段的旧操作回执会拒绝读取，不能用 A2A 缓存恢复已失去的访问范围。音频附件删除后旧妙记回执同样重新验证附件可用性。

## Agent 接入

MCP 已提供 `office_minutes`、`office_create_minute`、`office_read_minute` 和 `office_update_minute`。逐字稿 schema 是对象数组；工具边界检查类型，业务端负责段落字段、时间和成员范围的完整校验。这四个工具也进入既有结构化 A2A 网关能力集合，没有新增协议版本或通道。

本批未把妙记加入自动 worker 原生操作计划，也未改变自动 Agent 的上下文或触发规则。Agent 可以经上述 MCP/A2A 成员工具主动处理；需要进入既有文档工作流时应关联真实 Doc Free 文档。

## 验证证据

运行：

```sh
node --test tests/native-minutes.test.js tests/native-mobile-nav.test.js tests/native-plugins.test.js tests/native-app-policies.test.js tests/office-features.test.js tests/native-im-mcp.test.js tests/native-a2a.test.js
```

结果：**52/52 通过**，其中新增妙记 7 项、移动菜单 4 项。妙记覆盖人机共同修订/重启去重/CAS，输入边界与原子拒绝，真实文档任务会议 API 和附件关联，应用/成员/身份撤销，旧回执重新授权，MCP 对象数组和本机结构化 A2A 调用，以及存储故障恢复。首轮一处测试把平铺事件误当 `payload`，修正断言后同一范围全部通过。

验证全部使用临时 fixture；没有运行模型、录制真实会议、调用 ASR 或操作用户服务。该结果证明本批后端合同和相关回归，不能代替 UI 点击验收，也不代表已完成外部厂商 A2A/MCP 互操作认证。
