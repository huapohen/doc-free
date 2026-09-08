# 日历全天、重复与实例协议 · 后端阶段记录

- 记录时间：2026-09-08T20:56:41+08:00。
- 仓库：Doc Free，分支 `equal_rights`。
- 已提交基线：`6504a490bd19386394d93a169525afe83f65e91a`，提交时间 `2026-09-08T20:08:03+08:00`，描述 `docs: sync native acceptance and shared document receipt`。
- 本文描述的新增实现仍在工作区，尚未提交；以上 SHA 是基线，不能当作本阶段实现 SHA。最终阶段交付文档应补真实实现提交。
- 描述：HTTP、MCP、A2A、主动 Agent 动作共用同一个日程 reducer；真实全天日期、时区重复、单次例外、取消和 RSVP 均进入持久状态，生成的实例不写入 master 数组。

## 权威数据与日期

`all_day` 是布尔值，旧记录默认 `false`；`timezone` 使用 IANA 名称，旧记录默认 `UTC`。显式 null 不表示省略。唯一可用 null 清除的排程字段是 `recurrence`。

定时日程提交带时区的 `starts_at`、`ends_at` ISO 时间戳；全天日程提交 `start_date`、`end_date`，格式 `YYYY-MM-DD`，结束日期不包含在区间内。两类输入不能混传，时间戳不能冒充全天日期。全天记录保留服务端生成的时间戳投影供旧客户端兼容；新界面以日期为准。单项区间为大于零、最多 366 天。

全天查询以请求 `timezone` 将日期边界投影到查询窗口，返回的原始日期不会随显示时区改变。定时重复以 master 的 IANA 时区做本地日历运算，持续时长保持实际经过时间。不是每天固定加 86400000 毫秒。

日期运算使用固定版本 `@js-temporal/polyfill@0.5.1`，其依赖 `jsbi@4.3.2`。安装前 npm 官方 registry 短测返回 200，随后 npm 安装成功；package-lock 保存官方 tarball 地址和 SHA-512 integrity，没有执行依赖安装脚本。主要实现依据为 [Temporal polyfill 官方项目](https://github.com/js-temporal/temporal-polyfill)。

## 重复规则

```json
{
  "frequency": "weekly",
  "interval": 1,
  "weekdays": [1, 3, 5],
  "count": 12
}
```

- `frequency`：`daily`、`weekly`、`monthly`、`yearly`。
- `interval`：1–999，省略为 1。
- weekly 使用 `weekdays`，1 表示周一，7 表示周日；省略取首次日程星期。周周期锚定周一。
- monthly/yearly 使用 `month_day`（1–31 或 -1 表示最后一天），或 `ordinal_weekday:{ordinal,weekday}`；ordinal 为 1–5 或 -1。两种形式互斥。
- yearly 另可指定 `month`（1–12），默认首次月份。月份规则只能用于对应频率。
- `count` 为 1–10000；与 `until_date` 互斥。until_date 是包含的最后本地日期。均省略时无限重复，查询仍有窗口和分页限制。
- 首个日程必须符合规则。不存在的月份日期、闰日或 DST 本地时间跳过，不消耗 count；DST 重叠时间取较早偏移。首个定时日程如果落在重叠时段的较晚偏移则明确拒绝。

## HTTP 与返回值

| 接口 | 行为 |
| --- | --- |
| `GET /api/im/calendar` | 兼容已有 master 列表；保留取消记录及状态，不展开无限实例 |
| `GET /api/im/calendar/occurrences` | 必填 from/to，带时区 ISO；最多 366 天；timezone 默认 UTC；limit 默认 200，范围 1–500；可传 cursor |
| `GET /api/im/calendar/:event_id` | 返回 `{event:master}` |
| `GET /api/im/calendar/:event_id?occurrence_id=...` | 返回 `{event:有效实例,series:master}`；已取消单次仍可读其 tombstone |
| `POST /api/im/rooms/:room_id/calendar` | 创建 master，需 client_id；返回 event 和 duplicate |
| `PATCH /api/im/calendar/:event_id` | 更新 series 或 occurrence |
| `DELETE /api/im/calendar/:event_id` | 取消 series 或 occurrence，保留 tombstone，不物理删除 |
| `POST /api/im/calendar/:event_id/respond` | 本人 accepted/tentative/declined；支持 series 默认回应及单次覆盖 |

实例查询返回 `{occurrences,truncated,next_cursor,range}`。只返回与最终生效时间相交且未取消的实例：从窗外移进来的单次必须出现，从窗内移出去的必须消失。不会按原时间错误筛除移入实例。

实例保留 master 的标题、组织会话、创建者和重复规则，并增加：

```text
id / event_id             master ID（不能单独当实例列表 key）
occurrence_id            服务端稳定实例 ID；客户端不要自行解析或伪造
original_start           原始发生时间，全天为日期，定时为 ISO 时间戳
base_revision            当前 master revision
recurrence_generation    当前规则代次
exception_count          当前系列例外总数
is_exception             是否有本次覆盖
responses                合并并过滤后的有效回应
```

改单次时间不会更换其 occurrence_id。实例更新/取消/回应的响应为 `{event:有效实例,series:master}`；系列操作为 `{event:master}`。更新响应不额外承诺 duplicate 字段，通过原始回执和 revision 识别重试。

## 版本、权限与重试

重复日程修改需显式 `scope:'series'|'occurrence'`、`client_id` 和 `base_revision`。单次操作另需 occurrence_id。整个系列只有一个 revision，任何单次修改或 RSVP 都递增 master revision，防止系列和单次并发覆盖。

旧非重复 PATCH/RSVP 可省 scope，默认 series；保留其旧 client_id 兼容性。取消始终需要 client_id，单次 RSVP 始终需要版本。只允许创建者或当前 room owner 编辑/取消；RSVP 只能由当前受邀且仍在 room 内的本人执行，不能靠传 principal_id 替人回应。

持久回执按 room、本人、event、client_id 隔离。同一请求返回原冻结回执，检查顺序为当前权限、回执、CAS，避免丢响应重试产生第二次写入。同 client_id 换参数返回 idempotency_conflict。重启后仍成立。创建回执重试会校验当前调用者资格和完整规范化请求内容，但不要求其他历史受邀人仍在 room；首次创建仍校验每个当前受邀人。系列结构已改代次后，原管理操作重试仍可返回原回执；旧单次 RSVP 已不存在时，重试必须满足当前系列邀请，否则 not_invited。回执不会恢复被撤销的权限。

主动动作的 execution_manifest 使用当前真实 master revision；历史回执保留原 revision，并可另标 current_resource_revision，防止同一计划里重放旧回执把版本水位倒退。

## 单次例外与系列重置

master 保存 `exceptions` 映射，不保存无限生成实例。单次内容字段只覆盖明确修改的字段，系列以后改名仍可传播到没有显式标题覆盖的实例。单次改期会清空本次回应，并停止继承系列默认回应；普通单次 RSVP 覆盖本人默认值。

系列时间、日期、时区、全天模式或重复规则发生结构变化，且已有例外时，必须显式 `reset_exceptions:true`，否则 exceptions_reset_required。确认后归档原代次例外、generation 递增、当前例外和系列回应清空；旧 ID 新读报 stale_occurrence。例外不会被静默映射到另一个日期。单次更新不接受 recurrence 或 reset_exceptions。

每个系列最多 1000 个当前例外、20 次非空例外归档；达到上限明确拒绝，不能删除旧历史腾位。已取消日程不能继续更新或回应，已提交取消的相同请求仍可重试。

## Agent 复核与上下文

主动复核使用未来 24 小时的实际实例，第一场 master 已结束不影响后续重复日程触发。上下文补充未来 7 天的 bounded upcoming_calendar 和能力描述，共享原有 20000 字符内容预算；完整 master revision manifest 继续执行过期上下文检测。

单次变更携带生效参与者及相关旧参与者通知范围；整系列取消会覆盖只受邀某一次的 Agent。受邀 Agent 的复核过滤发生在分页前，不会被其他人的前 100 条日程挤掉。所有事实由同一 reducer 和实例查询生成。

cursor 与本人、查询窗口、timezone、limit 和所有当前可见 master revisions 绑定；身份、成员范围或任一修订变化返回 stale_cursor。客户端必须清当前窗口缓存并重取第一页，不能继续拼接旧页。UI 的缓存还应包含 endpoint、登录代次和显示时区。

## 验证与本阶段边界

- 全部 Doc Free backend：`npm test`，389/389 通过，约 20.2 秒；日志 `/tmp/renji-calendar-recurrence-backend-20260908.log`。
- 自有 engine、持久协议与原会议日程回归：26/26；含真实隔离状态文件、重启、拒绝无写入、DST、月末/闰年、移入移出、分页、冻结回执、CAS、权限、RSVP、主动复核和取消通知。
- 跨 MCP/A2A/主动动作及 Python 薄 SDK 的额外验证由同阶段协议子任务记录；上述 389 已包括 Node 侧新增协议文件。
- `git diff --check` 通过。未操作真实 3218 状态、未重启用户服务、未调用模型或 GUI。
- 本阶段支持整系列/单次；“此及以后”未实现。关联视频会议日程不支持全天、重复、单次修改或取消，返回 meeting_schedule_mode_unsupported；普通定时系列改期保留。单独结束视频会议沿用原协议。
- 未声称实现外部 CalDAV/ICS 同步、第三方日历导入、周期视频媒体会议或完整飞书所有日历页面。master 搜索与实例窗口查询是不同能力，未将旧搜索伪装为全实例搜索。

## 21:20 最终审查补记

记录时间 `2026-09-08T21:20:05+08:00`，工作区仍未提交。本轮修复了审查确认的创建重试边界：创建已提交但响应丢失后，其他受邀人离群，不应阻止仍有权限的创建者读取原回执。仅跳过该既成请求中其他历史成员的动态资格校验；原请求结构、规范化内容摘要和当前调用者资格仍严格检查，不允许同一 client_id 篡改名单或标题。

新增回归验证离群后原回执、重启后重放、改标题/换名单拒绝、畸形名单拒绝、使用新 client_id 邀请已离群成员拒绝，以及调用者被移除后不能读取旧回执；拒绝和重放均检查没有新增持久写入。纯内存额外验证全天单次切到定时并移到窗外、再切回全天多日、最后取消，始终保留原 occurrence_id 并正确按最终日期查询。

最终 focused 为 **48/48**，日志 `/tmp/renji-calendar-receipt-fix-focused-20260908.log`；最终全 backend 为 **390/390**，约 19.4 秒，日志 `/tmp/renji-calendar-recurrence-backend-final-20260908.log`。这两次结果替代上方修复前的 389/389 作为本阶段最终后端验收数据。无真实服务写请求、无 GUI 操作。

## 已提交实现补记

记录时间 `2026-09-08T21:34:53+08:00`。本阶段后端实现已提交：`a1b21dccd4b7f35851fec826e841e4de31be4814`，提交时间 `2026-09-08T21:26:11+08:00`，描述 `feat(calendar): add all-day recurring events and native occurrence protocol`。上文“未提交”和“未操作真实服务”是相应子任务记录时的状态；随后根任务已在专用验收会话实际创建、移动和取消实例，具体证据及前后版本另见最终阶段交付文档。
