# 2026-09-06 · 会议、日历、工作台与附件协议

| 字段 | 值 |
| --- | --- |
| 记录时间 | 2026-09-06T10:34:43+08:00 |
| 分支 | `equal_rights` |
| 本轮实现基线 | `9f97b516542715ab7818ee3f32d7e73611cda2bd` |
| 本轮实现提交与最终验证 | 见 `VERSION.json` 与发布记录，提交后关联 |
| 描述 | 增加可用办公模块、房间媒体信令、共同纪要版本、受控文件传输、消息置顶与明确转发 |

本篇在 [核心协议](PROTOCOL.md)、[基础 IM 与 Agent 商店](BASE_IM_AND_STORE.md) 上补充新的服务能力。所有业务 API 沿用独立 Bearer 身份和当前会话权限，人和 Agent 使用相同协议。下面的会议/文件接口完成情况不能代替 Flutter 各平台构建、摄像头权限、网络穿透和真实音视频验证，实际证据由发布记录单独列出。

## 1. 会议与共同纪要

以下路径均以 `/api/im` 为前缀。

| 方法与路径 | 输入 | 响应 |
| --- | --- | --- |
| `GET /meetings` | 无 | `{meetings}`，当前有权访问的最新 200 场，附 participant_count |
| `POST /rooms/:rid/meetings` | `{client_id,title,starts_at?,duration_minutes?,document_id?}` | `{meeting,duplicate}` |
| `GET /meetings/:mid` | 无 | `{meeting,participants}` |
| `PATCH /meetings/:mid` | `{base_revision,document_id}` | `{meeting}`；绑定或解除共同纪要 |
| `POST /meetings/:mid/end` | `{}` | `{meeting,participants:[]}` |

会议字段为 `id,room_id,title,starts_at,duration_minutes,document_id,notes_document,created_by,created_at,status,revision,ended_at,calendar_event_id`。title 为 1–200 字符，client_id 为 1–160；starts_at 使用带时区的 ISO 8601，缺省当前时间；duration_minutes 为 1–480，缺省 30。时间加法也在创建前检查，不能因超出日期范围留下半个会议。

创建者可以是 human 或 agent。幂等键范围为 `(room_id,principal_id,client_id)`；相同键与相同规范请求返回原记录，变更负载返回 `409 idempotency_conflict`。没有给 starts_at 的即时会议不会因为重试时间不同变成冲突。

status 为 scheduled、active 或 ended。预约未来时间为 scheduled；成员提前加入后变为 active。创建者或当前 room owner 可以结束会议，普通成员不能结束别人的会议；结束立即使媒体会话失效，重复结束不创建新记录。

每场会议同时创建一条 linked calendar event，缺省邀请创建时的当前会话成员。会议结束后关联日程标记 completed。若通过日程修改已关联会议的时间，会议标题、开始时间和时长同步更新；已经结束的会议不能改期。

共同纪要必须是已经共享到此会话的规范 Doc Free 文档。创建时可传 document_id；之后由会议创建者或 room owner 用 PATCH 和 base_revision 绑定，null 表示解除。`notes_document:{id,title,revision,content_hash}` 记录绑定时的明确版本；GET 详情另含 `notes_document_current`，表示当前规范文档版本。这样能够同时判断“会议建立时依据哪版资料”和“共同纪要现在更新到了哪版”。正文读写仍使用原会话文档 API，不产生一套会议私有文档副本。

## 2. 媒体会话与 WebRTC 信令

| 方法与路径 | 输入 / 参数 | 响应 |
| --- | --- | --- |
| `POST /meetings/:mid/join` | `{device_id}` | `{meeting,session_id,cursor,peers,participants}` |
| `POST /meetings/:mid/heartbeat` | `{session_id,audio?,video?,sharing?}` | `{participants}` |
| `POST /meetings/:mid/leave` | `{session_id}` | `{left:true,participants}` |
| `POST /meetings/:mid/signals` | `{session_id,to,kind,payload}` | `{signal}` |
| `GET /meetings/:mid/signals` | `session_id=<id>&after=0&wait=20` | `{signals,cursor,participants,reset_required}` |

每位参与者的设备使用 1–100 字符 device_id；服务端为认证 principal 和设备绑定不可预测的 session_id。相同 principal/device 的有效重复加入返回原会话；多个设备分别占用名额，每会议最多六个媒体会话。身份与媒体 session 都要校验，知道另一人的 session_id 不能代表其发送信令或更新状态。

participant 字段包括 `session_id,principal_id,name,kind,device_id,audio,video,sharing,last_seen,expires_at,joined_sequence`。状态初始为静音、摄像头关闭、未共享；audio/video/sharing 必须为布尔值。45 秒没有加入/心跳更新就过期；信令请求本身不延长心跳。客户端应在到期前定期 heartbeat，离开时调用 leave，并在 UI 中明确显示真实媒体状态。

kind 为 offer、answer 或 candidate；payload 必须为 JSON 对象且不超过 64 KiB。to 必须是同一场会议中另一个有效 session_id。服务端从认证身份与 session 决定 from，忽略伪造的发送人字段。信令返回 `seq,from,to,kind,payload,at`；GET 每页最多 100 条，只返回发给本 session 的内容。

cursor 是当前进程会议内的信令位置，不是持久化工作事件游标。join 返回适合本 session 的起点；客户端应用响应后继续使用 cursor。wait 为 0–25 秒。进程重启、session 失效、日志已截断或异常旧游标会使 reset_required 为 true，此时客户端重新加入并重建 WebRTC 连接，不把旧 SDP/ICE 当作可恢复的会议状态。

信令仅保存在内存，每会议最多 1000 条且总计最多 2 MiB，最多 50 个活跃会议运行时。退出、过期、成员移除、凭据撤销和会议结束都清理失效会话与相关信令；长轮询醒来后再次校验权限。SDP/ICE、媒体 session ID、音视频流和设备状态不会写入持久化工作记录、文档导出或服务错误内容。

Node 是身份和信令中继，不是 SFU 或媒体录制服务。实际音视频由客户端 WebRTC 传输；本版没有云会议平台、录制、转写、电话接入或 TURN 服务。跨公网网络条件可能需要运营者自配 STUN/TURN 和 HTTPS；TLS、NAT 穿透、设备权限与客户端能力的部署边界必须实际验证。Agent 能用同一接口参加和协调会议，并不因此自动拥有麦克风、摄像头或语音合成工具。

## 3. 日历邀请与工作台

| 方法与路径 | 输入 | 响应 |
| --- | --- | --- |
| `GET /calendar` | 无 | `{events}`，当前成员会话中最新 500 条日程 |
| `POST /rooms/:rid/calendar` | `{client_id,title,starts_at,ends_at,description?,location?,attendee_ids?}` | `{event,duplicate}` |
| `GET /calendar/:eid` | 无 | `{event}` |
| `PATCH /calendar/:eid` | `{base_revision,title?,starts_at?,ends_at?,description?,location?,attendee_ids?}` | `{event}` |
| `POST /calendar/:eid/respond` | `{response}` | `{event}` |
| `GET /workbench` | 无 | `{apps,favorites}` |
| `PATCH /workbench` | `{favorites:[app_id,...]}` | `{apps,favorites}` |

日程包含 `id,room_id,title,starts_at,ends_at,description,location,attendee_ids,responses,created_by,created_at,updated_at,revision,status`，会议日程另有 meeting_id。开始与结束都要求带时区，结束必须晚于开始；description 最大 8000 字符，location 最大 300，邀请对象最多 100 个且必须是当前会话成员。缺省只邀请创建者。创建接口具有与会议相同范围的客户端幂等保证。

创建者或当前 room owner 可以基于 revision 修改日程。只有 attendee_ids 中的当前成员能够回应；response 为 accepted、declined 或 tentative，服务端把结果写到 `responses[authenticated_principal_id]`，不能替别人接受邀请。回应推进 revision；改期会清空先前回应，避免把对旧时间的同意冒充为对新时间的确认。实例最多保存 2000 场会议、5000 条日程，仍使用单写者 JSON 存储。

本篇最初的工作台目录包括 messages、agents、docs、tasks、meetings、calendar，approvals、reports 当时为 available:false。2026-09-06 后续 [账号/考勤/审批迭代](ACCOUNTS_ATTENDANCE_AND_APPROVALS.md) 已令 approvals 可用，并增加 attendance 和内部 mail；reports 仍明确不可用。不可用模块不能收藏，favorites 为各身份独立保存的有序去重列表。内部审批与工作区邮件的具体范围以新篇为准。

模型可见上下文新增 `office:{meetings,calendar,manifest,omissions,character_budget}`：完整条目合计最多 20000 字符，每类最多 30 项，省略数量和全部版本清单明确记录。日程/会议版本在运行期间变化也会拒绝过时输出。房间 Markdown 导出包含会议和日程记录，共同纪要正文来自原文档区。

## 4. 附件、图片与下载权限

| 方法与路径 | 输入 | 响应 |
| --- | --- | --- |
| `POST /rooms/:rid/attachments` | `{client_id,filename,mime_type?,data_base64}` | `{attachment,duplicate}` |
| `GET /rooms/:rid/attachments` | 无 | `{attachments}`，当前可用文件 |
| `GET /rooms/:rid/attachments/:aid` | 无 | `{attachment}`，包括删除后的审计状态 |
| `GET /rooms/:rid/attachments/:aid/content` | 无 | 经 Bearer 认证的二进制响应 |
| `DELETE /rooms/:rid/attachments/:aid` | 无 | `{attachment}`，仅上传者或 room owner |

附件包含 `id,room_id,filename,mime_type,size,sha256,created_by,created_at,status,message_ids,download_path`；删除后增加 deleted_at/deleted_by。上传为 1 字节至 12 MiB，使用规范 base64，不接受 data URL；只有此上传路径允许最高 18 MiB JSON 请求，其余业务请求仍限制 2 MB。服务器在读取大上传前先认证身份，再按房间校验成员资格。

文件名为 1–200 字符，拒绝路径分隔符、控制字符、`.` 与 `..`。物理文件名只使用服务端计算的 SHA-256，位于 `dirname(DOC_FREE_IM_DATA)/attachments/<sha256>`，权限 0600。上传先用临时文件、fsync 与原子 rename 保存内容，再保存元数据；下载重新验证文件类型、大小及内容 hash，并拒绝符号链接。

PNG/JPEG/GIF/WebP 只有文件 magic 与申报格式匹配才保留 image MIME；其他格式统一 application/octet-stream，包括 HTML/SVG 等主动内容。所有下载都使用 Content-Disposition:attachment、nosniff、CSP sandbox 和 no-store。图片 UI 需要通过 Bearer fetch 取得 bytes 后解码预览，不能把 token 放在图片 URL 或查询参数中。

上传幂等键范围为 `(room,principal,client_id)`，文件名、申报 MIME 或内容变化都会冲突。每条消息最多 8 个附件；POST 消息增加 attachment_ids，正文可以为空但必须至少有一个附件。消息返回 attachments 数组和下载路径。默认模型上下文只包含文件名、MIME、大小、hash、availability 等元数据，未注入文件正文或 OCR，Agent 不能根据附件名称声称已经分析了文件内容。

每次下载都检查当前身份与会话范围。删除附件后内容返回 `410 attachment_deleted`；如果它关联的所有消息均已撤回，返回 `410 attachment_recalled`。相关待发布模型运行同时被置为 stale。房间导出保留附件索引和状态，绝不嵌入二进制或跳过认证的公开下载 URL。

文件内容保存与 JSON 元数据不是跨存储原子事务；中断可能留下不可通过 API 枚举的孤立内容文件。软删除保留文件和审计，未实现物理回收或反病毒扫描。限额是每会话 200 个附件/200 MiB、实例 5000 个附件/唯一内容合计 1 GiB；删除记录仍计入配额，避免反复上传/删除绕过存储边界。正式运营需要一致备份、审计保留和明确的垃圾回收策略。

## 5. 置顶、转发与真实已读

| 方法与路径 | 输入 | 响应 |
| --- | --- | --- |
| `POST /rooms/:rid/messages/:mid/pin` | `{pinned:boolean}` | `{message}`；当前成员可操作，最多置顶 50 条 |
| `GET /rooms/:rid/pins` | 无 | `{messages}`；房间详情也提供 pins 数组 |
| `POST /rooms/:source/messages/:mid/forward` | `{target_room_id,client_id,base_revision}` | `{message,duplicate}`，返回目标会话中的新消息 |

message 增加 pinned、pinned_by、pinned_at。置顶不冒充原作者，不改变正文 revision；撤回自动取消置顶。发送者自己的实际已读位置现在可通过 `members[].read_seq` 读取，客户端根据消息 seq 与对方 read_seq 判断已读，不能用本机打开状态伪造对方已读。

转发者必须同时属于来源和目标会话，并确认原消息的当前 revision。消息作者是认证转发者，`forwarded_from` 保存来源 room/message/author/revision。跨会话附件建立新的受目标权限保护的元数据副本，复用 hash 内容文件。相同 client_id 与相同来源版本幂等；更换来源版本会冲突。

明确转发是一次新的分享行为。原作者之后撤回或删除原文件，不会自动删除已经明确转发到另一会话的副本；目标副本仍由目标会话权限管理。这一边界必须向用户说明，不能声称“撤回会从所有人设备和所有副本中删除”。
