# 0.5 · 企业管理与同权办公界面验收

记录时间：2026-09-06T12:40:38+08:00。分支：`equal_rights`。

实现提交：Active Agent `2fad0ac68a05a39cf7d6abe55624b771bfa3ae62`；Doc Free `901b49bdd268b98dae74613a19d40d7d69891137`。两仓提交时间均为 `2026-09-06T12:23:53+08:00`。本篇描述准确源码启动的本机工作空间验收；五端包的构建证据另见 [发布台账](RELEASE.md) 和 [VERSION.json](VERSION.json)。

## 环境和证据边界

服务地址为本机 `http://127.0.0.1:3218/office/`，Flutter 版本 `0.5.0+2`。两个独立浏览器会话分别用人类账号和 Agent 账号登录同一 Flutter 客户端，业务数据来自真实 Doc Free HTTP 服务。账号和机器凭据只在忽略的本机私有文件中，公开记录不包含密码、令牌或真实企业数据。

“Agent 界面”指以 `kind:agent` 的账号登录并操作同一界面；“Agent 原生操作”指该 Agent 的独立机器凭据直接调用协议。浏览器操作由验收工具驱动，本篇不声称默认模型已自主决定、计划和执行这些办公动作。

## 企业角色与应用策略闭环

1. 人类 owner 登录企业后台，查看真实成员/部门/角色计数与成员列表，在界面将 Active Agent 从 member 改为 admin。重启服务后角色保留，Agent 登录同一客户端显示“企业管理员”。
2. 人类在“企业应用”搜索工作区邮件，打开策略表单，保留全员可用，并在禁用成员中选择 Active Agent。界面保存成功，策略由 r1 变为 r2。
3. Agent 已打开的邮箱显示“企业策略已限制此应用”。Agent 本人的 REST 邮箱请求返回 `403 app_policy_denied`；MCP `office_mail` 也返回 `{status:403,code:app_policy_denied,plugin_id:mail}`。浏览器控制台的 6 条错误均是此场景预期的邮箱列表/文件夹 HTTP 403，没有将它们误报为零错误页面。
4. 同一 Agent 仍能通过受限页的“企业管理”进入其获授权的后台。企业角色没有绕过业务应用限制，也没有因邮箱被禁用而丢失管理恢复入口。
5. 该 Agent 使用自身机器凭据调用 MCP `enterprise_configure_app`，带当前 r2 版本将禁用列表清空。服务返回 r3；审计动作 `application.policy_updated` 的 `actor_kind` 为 `agent`。再次访问邮箱为 200，Agent 客户端重新进入邮箱后正常显示收件箱。
6. 管理策略表中的旧值通过“刷新企业信息”重新获取。本次不把管理表单缓存的自动实时更新写成已验证能力。测试结束时邮件策略恢复为全员可用、无显式拒绝。

此场景验证外部 Agent 可以直接原生管理其获授权的企业能力，无需模拟点击。它没有证明默认 Python worker 已有自主企业管理的工具执行循环。

## 企业文档导出

Agent 管理员调用企业导出接口，得到包含当前组织、角色和管理审计的可读 Markdown，共 7060 字符。检查导出中不存在本地身份 token 和账号密码。导出是基于授权状态生成的工作载体，不授予管理员他人的私人邮件或未加入房间的正文访问权。

本机原始证据：`active_agent/output/enterprise-policy-ui-evidence.json`、`active_agent/output/enterprise-ui-export.md`。公开版本只保存测试描述与证据文件摘要，不上传完整工作空间。

## 人申请、Agent 审批与补卡

人类在 Flutter 界面完成签到，随后发起补卡申请并指定 Agent 为审批人。Agent 用自己的账号登录同一 Flutter 客户端，在审批页批准，原因和审批意见真实保存；签到记录由 r1 原子更新至 r2，补卡时间为 `2026-09-06T01:00:00.000Z`（北京时间 09:00）。未被指定的 peer 无法读取该私密申请。

此处验证真实审批业务和人/Agent 角色对等，不包括定位防作弊、工资计算或多级审批流程。本机证据位于 `active_agent/output/office-business-evidence.json`。

## 内部邮件正文完整性

早先主题为“同权办公第二阶段验收”的邮件正文为空，只证明草稿、主题、投递和各自已读状态。它不作为正文验收证据。本次重新以正确的 Flutter 输入聚焦顺序完成以下闭环：

1. 人类从“写邮件”选择 Agent 收件人，填写主题“企业应用验收 · 正文完整性”和三行正文，在界面保存草稿。
2. HTTP 读取草稿详情，确认正文 93 字符与输入逐字一致。关闭编辑器，在草稿箱重新打开；客户端输入框仍包含同一主题和 93 字符正文。
3. 在界面发送；Agent 独立客户端收件箱自动出现新邮件，打开后完整渲染正文并标为已读。
4. 分别读取发件人和 Agent 自己的 delivery，正文与原草稿一致。第三个未收件身份访问该 delivery 得到 404。

正文 SHA-256：`4b4bd1411b25fb9ccdfed778288b2e13fe2233801e3f9b038e82f72348e74470`。发送时间约 `2026-09-06T12:36:40+08:00`，最终 HTTP 核对约 12:38。不同身份使用各自 delivery ID，不能把发件人的邮件 ID 当成收件人的读取权限。

本机证据：`active_agent/output/mail-body-ui-evidence.json`。这验证工作空间内部邮箱，不涉及外部 SMTP/IMAP 投递。

![Agent 账号在同一 Flutter 客户端读取内部邮件](https://github.com/huapohen/active-agent/blob/equal_rights/docs/equal_rights/2026-09-06/images/mailbox-0.5.0.png?raw=true)

## 公共入口复查

12:38–12:40 在新版 Agent 账号界面复查：

| 入口 | 本次实际结果 |
| --- | --- |
| 全局“+” | 创建人/Agent 群、联系人/私聊、Agent 好友、商店安装、文档、任务、发起/加入会议、日程、审批和邮件 |
| 全局搜索 | 联系人、Agent 好友、Agent 商店、消息、文档、任务、邮件、审批、日程分类；搜索 Active 返回获准文档、Agent 和本人邮件 |
| 群聊 @ 面板 | 全部/成员/Agent 筛选、搜索、所有人包含人和 Agent、逐个成员勾选；本次展开后取消，没有额外发送消息 |
| 底部 Agent 协作 | 在线 Agent、参与方式、@ 协作、商店、分派任务、工作记录与成果入口 |

本次入口复查与既有协议/界面测试共同使用；不是再次完成每个菜单项的全部业务测试。

## 原生客户端和飞书参考

固定提交的 macOS release 与 iOS Simulator debug 均实际启动并显示中文账号登录页。本机原生验收仅覆盖启动与渲染；上述完整业务闭环发生在 Flutter Web。Windows 由 Windows runner 编译，并检查 PE/DLL 结构，本轮没有 Windows 运行时业务验收。

真实飞书仅进行用户已授权的只读导航。Chrome 企业后台与桌面管理员/员工入口差异已观察；iPhone Mirroring 本轮先断连，12:37 尝试重连后进入需要 Mac 系统解锁的界面，手机企业后台仍未验证。具体已看页面与剩余差距见 Active Agent 的 [企业参考记录](https://github.com/huapohen/active-agent/blob/equal_rights/docs/equal_rights/2026-09-06/ENTERPRISE_REFERENCE_AND_SCOPE.md)。

本篇不将这些结果表述为飞书全量复刻、生产规模验收或可靠全自主办公。新增能力的实现与未完成项见 [发布台账](RELEASE.md)。

## 发布文档进入共同工作空间

2026-09-06T12:47:15+08:00，Agent 使用 MCP `im_create_document` 将本次发布台账保存到本机“原生办公 · 产品共创”会话，文档标题为“0.5 企业办公发布台账 · 2026-09-06 12:40 · 2fad0ac”，版本 r1。为使在线文档中的链接可用，文内相对链接转换为 GitHub 链接，正文共 4868 字符。人类身份通过 HTTP 读取逐字一致，并在 Flutter 云文档列表打开，标题和全文长度均核对通过。

内容 SHA-256：`2fb73f138dc8bf362ae0946a90576a6cf9464f71684b235325f8d3e8f82d1321`。本机证据为 `active_agent/output/release-shared-document-evidence.json`。这是原生 Agent 创建、人类可见且可以继续编辑的共同文档，没有额外向聊天发送通知。

最终补存 Python 原始验证日志：`python -m pytest -q tests` 为 37/37 通过，源码仍对应 `2fad0ac`。不带目录的首次采集意外遍历了忽略目录中的两份构建 worktree，因测试模块同名而在收集阶段中止；改为当前仓库 `tests` 后通过，未清空缓存或修改实现源码。日志和诊断分别保存在 `output/python-release-verification.log` 与 `output/python-root-collection-diagnostic.log`，本地证据路径均相对 Active Agent 根目录。
