# 2026-09-06 · 账号登录、考勤、补卡与审批

| 字段 | 值 |
| --- | --- |
| 记录时间 | 2026-09-06T11:12:07+08:00 |
| 分支 | `equal_rights` |
| 本轮实现基线 | `134e0a78fc51345689be377004e793dd6a7fd71d` |
| 实现提交和最终验证 | 提交后由 `VERSION.json` 与发布记录关联，不使用预估 SHA |
| 描述 | 增加真正密码登录、独立限时会话、本人考勤、指定审批人审核和原子补卡，保持人和 Agent 同一身份协议 |

本篇是 [会议、日历和附件版本](OFFICE_MODULES_AND_ATTACHMENTS.md) 之后的新记录。这里的申请、原始打卡、修订与审核都可以通过 API 读取和文档导出复核。原生 JSON 状态保存凭据哈希、版本和操作记录；它不能代替人和 Agent 能看见的业务记录。

以下路径以 `/api/im` 为前缀。除 `POST /auth/login` 外，所有个人接口均要求此人或此 Agent 的有效 Bearer；`/admin/*` 使用工作区管理凭据。UI、API、MCP 和 A2A 不能通过附加 `principal_id` 或 `actor_id` 冒充业务操作者。

## 1. 真正的用户名和密码登录

| 方法与路径 | 输入 | 响应 |
| --- | --- | --- |
| `POST /admin/accounts` | `{principal_id,username,password}` | `{account,sessions_revoked:true,machine_token_unchanged:true}` |
| `POST /auth/login` | `{username,password}`，无需 Bearer | `{principal,token,expires_at,session_id}` |
| `GET /auth/account` | 无 | `{account}`，未开通时为 null |
| `POST /auth/account` | `{username,password,current_password?}` | 创建或变更自己的登录账号 |
| `GET /auth/sessions` | 无 | `{sessions}`，只列本人最新 100 条 |
| `DELETE /auth/sessions/:sid` | 无 | `{revoked:true}`，只可撤销本人的会话 |
| `POST /auth/logout` | `{}`，使用登录 session token | `{logged_out:true}` |

管理员先创建 principal，再为该 principal 开通账号；持已有独立机器凭据的参与者也可以为自己首次开通。用户名去除首尾空格并转小写，需要 3–100 个 ASCII 字母、数字或 `. _ @ + -`，首字符必须为字母或数字。密码为 10–256 字符，不能全为空白。已有账号的本人变更必须验证 `current_password`；管理员重设不依赖旧密码。用户名全实例唯一。

密码以随机 16 字节 salt 和异步 scrypt 保存，参数为 `N=32768,r=8,p=1`，摘要长度 64 字节。状态文件保存 salt、摘要和参数，不保存明文密码。输出的 account 只有 principal_id、username、创建/更新时间和 revision，不含密码材料。

每次密码登录发行新的随机 32 字节 session token，状态仅保存其 SHA-256 哈希。会话有效期 12 小时；每个 principal 最多 20 个有效会话，实例最多 10000 个，另保留最新 1000 个已结束会话。登录响应是获得该 token 的机会，应用应按平台凭据存储能力妥善保存。用户名不存在、密码不正确和 principal 已撤销均返回 `401 invalid_credentials`，不提供账号存在性的错误区分。

登录限流按归一化用户名每分钟 6 次、实例每分钟 60 次执行；该限流窗口位于内存，重启重置。安全审计保留最新 5000 项账号/会话动作，不写入密码或 token。当前没有短信验证码、手机号登录、找回密码邮件、企业 SSO 或 MFA。

密码修改和管理员重设会撤销该 principal 的全部密码登录会话。独立机器 Bearer 与登录 session 是两套凭据：修改密码不会意外中断已授权 Agent 的机器连接。用机器 Bearer 调用 logout 返回 `409 login_session_required`；若要彻底撤销该身份，使用既有管理员 revoke，机器 Bearer、密码会话和会话成员资格都会失效。

事件长轮询在响应前重新认证；密码重设、退出和会话撤销会唤醒等待方进行复查。过期 session 不会因已有连接而继续读取消息。密码登录同样适用于 kind=agent 的独立身份，它仍可自主创建会话、发消息、读文档和处理分配给自己的审批，不需要人代点 UI。

## 2. 本人打卡与可读考勤记录

| 方法与路径 | 输入 / 查询 | 响应 |
| --- | --- | --- |
| `GET /attendance` | `date=YYYY-MM-DD&timezone=Asia/Shanghai` | `{date,timezone,records}`，本人当前会话记录 |
| `GET /attendance/export` | 同上 | 本人该日考勤 Markdown，含原始记录和审计 |
| `GET /rooms/:rid/attendance` | 同上 | room owner 可读该会话记录；普通成员只读本人 |
| `POST /rooms/:rid/attendance` | `{action,client_id,timezone?,location_note?}` | `{record,duplicate}` |

action 只能为 check_in 或 check_out；timezone 是有效 IANA 时区，缺省 Asia/Shanghai，date 缺省该时区的服务端当前日。服务端绑定真实 principal、房间和当前时间，输入中的自称 actor 或打卡时间不起作用。

一条记录对应 `(room_id,principal_id,date,timezone)`，保存一组上班和下班时间、地点说明、revision 和完整 audit。先下班会失败；已有上班或下班记录不能用第二个普通请求直接覆盖。跨午夜的遗漏应走补卡申请，本版没有排班表或多段班次引擎。

location_note 最多 500 字符，仅作为本人自报文字。响应固定包含 `location_verification:self_reported_note_only`，没有宣称 GPS 定位、可信设备、照片验真或办公室围栏验证。Agent 和 human 具有相同接口权限，kind 不会赋予代其他员工打卡的能力。

client_id 长度 1–160，幂等范围为 `(room,principal,client_id)`。同一个键和规范化动作/时区/地点说明重试返回原记录，即使服务端时钟或日期变化，也不会再产生一笔打卡；变更负载返回 `409 idempotency_conflict`。上班后正常下班将 revision 从 1 推到 2。

实例最多保存 20000 条考勤记录；列表返回最新 200 条符合范围的记录。个人导出即使由 room owner 调用，也只导出其本人当前会话记录。已经被移出会话的人无法继续导出该会话考勤；room owner 仍可检查被撤销身份的历史记录及其审计。

## 3. 指定审批人审核

| 方法与路径 | 输入 / 查询 | 响应 |
| --- | --- | --- |
| `GET /approval-templates` | 无 | `{templates}` |
| `GET /approvals` | `inbox=assigned|created|all`，缺省 assigned | `{requests}`，最新 200 条可见申请 |
| `POST /rooms/:rid/approvals` | `{client_id,template_id,title,description?,approver_id,payload?,expires_at?}` | `{request,duplicate}` |
| `GET /approvals/:id` | 无 | `{request}` |
| `POST /approvals/:id/decision` | `{client_id,base_revision,decision,comment?}` | `{request,duplicate}` |
| `POST /approvals/:id/cancel` | `{client_id,base_revision,comment?}` | `{request,duplicate}` |
| `GET /approvals/:id/export` | 无 | 可读审批 Markdown 与完整版本化结构 |

模板包括 general、leave、expense 和 attendance_correction。general/leave/expense 用普通创建接口；补卡只能用下一节专门的 correction 接口，不能自行拼装 payload 绕过考勤检查。

普通申请 title 为 1–200 字符，description 最多 8000，payload 为最多 12000 字符的 JSON 对象，comment 最多 2000。默认审批期限为创建后 7 天；显式 expires_at 必须是带时区时间且在未来 90 天内。请假、报销模板记录业务说明与审核结果，不扣减假期余额、不影响薪资、不发起付款。

申请只对当前会话内的申请人、指定审批人及 room owner 可见，普通同事即使知道 request ID 也不能读取。审批人必须是当前成员，且不能是申请人本人。仅 named approver 可以 approved/rejected；room owner 不能冒充审批人。申请人或 room owner 可以 cancelled。

状态由 pending 进入 approved、rejected、cancelled 或 expired。到期读取或决定时会明确记为 expired 并持久化审计，不能晚于期限批准。每次动作需要当前 base_revision，重复客户端动作按稳定键幂等处理；新动作作用于旧版本会返回 conflict。变更 JSON 对象键顺序不会使语义相同的创建请求丢失重试能力。

request 包含 `id,room_id,template_id,title,description,payload,created_by,approver_id,status,revision,created_at,updated_at,expires_at,audit`，决定后带 decided_by、decided_at、decision_comment。实例最多保存 10000 条申请。

审批详情不进入所有成员共享的 room model context 或房间导出。指定 Agent 审批人通过自己的原生凭据读取申请；要形成公开工作文档，应由有权参与者明确发布可共享内容，不能把私密 HR 数据自动混进全员讨论。

## 4. 补卡和审批共享一次持久化提交

`POST /rooms/:rid/attendance/corrections` 输入：

```json
{
  "client_id": "a-stable-intent-id",
  "date": "2026-09-05",
  "timezone": "Asia/Shanghai",
  "check_in_at": "2026-09-05T01:00:00Z",
  "check_out_at": "2026-09-05T09:00:00Z",
  "reason": "补充昨日遗漏打卡，附上可复核说明",
  "approver_id": "principal-actual-reviewer-id"
}
```

可以附 record_id 和 base_revision 来明确原始记录。服务端始终捕获申请人自己的房间、日期、时区、原记录 ID 和 revision；传其他人的记录会被拒绝。上班时间必须落在指定时区日期内，下班不得早于上班且最多相差 48 小时，任何时间都不能在未来。check_out_at=null 表示更正后尚无下班记录。若已有记录且省略相应时间，会沿用当前值。

提交申请只产生 pending 审批，不修改打卡。指定审批人批准时再次检查申请人当前成员资格和原始记录版本；期间发生正常下班打卡等变化，返回 `409 attendance_conflict`，申请保持 pending，现有考勤保持完整，需要基于新记录重新申请。

检查通过后，补卡和 approved 决定在同一次原生 JSON 持久化中写入。考勤 audit 保留 previous 上/下班时间与 revision、申请人、审核人、request ID、理由和更正后的时间；申请返回 applied_record_id。拒绝、取消和到期均不会应用补卡。

持久化继续沿用单写者、临时文件 fsync、原子 rename 和故障停写策略。若 rename 失败，该进程不继续服务随后读写；修复存储并重启后恢复上一份完整状态，不能出现“审批成功但考勤没变”或以后某个请求偷偷保存被拒绝的更正。

## 5. 私密事件与主动 Agent

审批/考勤使用现有持久化序列通知客户端变化，但事件回放也按业务权限过滤。approval.created/decided/expired 只交付申请人、指定审批人、owner；attendance.recorded/corrected 只交付本人和 owner。事件里仅有记录指针、状态或动作，地点、申请正文和补卡理由保留在授权读取端点。

个人插件、通讯录、设置和邮箱使用同一序列的个人事件：`room_id:null,audience_ids:[...]`。服务端只向接收范围内的当前有效凭据回放；共享会话的模型上下文不自动接收个人事件。内部邮件的收取、投递与个人设置说明以对应实现和发布记录为准，不把工作区内投递称为已经接通外部 SMTP/IMAP。

## 6. 验证证据和运行范围

本轮先运行完整 `npm test`，账号、考勤/审批及内部邮件/设置集成时为 **63/63 通过**。随后新增真实 HTTP 无 Bearer 登录、25 人 @全员、私密事件及个人考勤导出，相关 `native-im/native-workforce/native-plugins` 专测 **30/30 通过**。加入全域搜索和 A2A 模块后，再次运行完整 `npm test` 为 **87/87 通过**；最终合并后的总数以发布记录为准。

专项验证包括密码摘要与通用失败、改密/撤销及长轮询失效、重启后 session 仍可认证、12 小时过期、自身会话隔离、Agent 账号同权、服务端打卡时间、地点自报标识、申请隐私、版本冲突、审批过期、取消、人员移出，以及故意注入 rename 失败验证补卡/审批一致性。测试密码使用明确的测试夹具或随机生成，不使用或提交真实业务凭据。

这是可执行的本地办公能力，仍受 [核心协议中的部署范围](PROTOCOL.md) 约束。没有新增薪资系统、法定工时计算、法务签章、财务执行、多级组织审批、跨租户隔离或生产并发承诺。
