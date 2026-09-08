# 工作台真实最近使用、+ 菜单与语音清理审查 · 2026-09-07

记录时间：2026-09-07T14:03:02+08:00。工作分支：两库均为 `equal_rights`。本文同步保存于 Active Agent 与 Doc Free 的 `docs/equal_rights/2026-09-07/WORKBENCH_RECENTS_PROTOCOL_AND_REVIEW_1402.md`，不覆盖当天较早的调查与验收文档。

**本轮实现尚未 commit。** 以下仅为实际已提交基准，不是本轮实现提交；最终集成 commit 及其时间、描述由主任务收尾后另记。

| 仓库 | 基准 commit | Git 时间 | 描述 |
| --- | --- | --- | --- |
| Active Agent | `1774c284ba41d5db71ed77a4b905bd3db1c0369f` | `2026-09-07T12:18:30+08:00` | `docs(office): record mobile group fidelity and native verification limits` |
| Doc Free | `55967f5234568d80cee36d836f06b942cb3db0b1` | `2026-09-07T12:18:30+08:00` | `docs(im): publish mobile group fidelity protocol and delivery receipt` |

## 真实最近使用合同

“最近使用”来自当前登录身份实际打开应用时的记录请求。空身份返回 `[]`，不会把四个默认收藏、应用目录前四项或演示数据冒充使用历史。人类和 Agent 使用同一个成员鉴权边界，不需要 Agent 模拟鼠标点击后才能记录。

| 方法 | 路径 | 输入 | 行为 |
| --- | --- | --- | --- |
| GET | `/api/im/workbench` | 无 | 返回当前应用可用性、本人收藏及本人真实最近使用 |
| PATCH | `/api/im/workbench` | `{favorites: string[]}` | 沿用既有收藏操作，同时保留本人最近使用 |
| POST | `/api/im/workbench/recents` | `{app_id: string}` | 验证应用，置于本人历史首位、去重、最多保留 32 项 |
| DELETE | `/api/im/workbench/recents` | 无 | 仅清空本人最近使用，保留收藏和其他身份历史 |

上述成功结果均为 `{apps, favorites, recents}`。`recents` 为 app_id 字符串数组，最近访问在前，不是完整应用对象。没有客户端时间戳；请求按 native IM 的既有串行事务顺序生效。

MCP 对应工具：`office_workbench`、`office_favorite_apps`、新增 `office_record_recent_app` 和 `office_clear_recent_apps`。A2A 使用相同公开工具、当前身份和持久回执规则。未新增管理凭据入口，也未把 API Key、密码或令牌加入协议参数。

POST 错误：不存在的 app_id 返回 `404 app_not_found`，未实现的报表返回 `422 app_unavailable`，企业策略或必需依赖拒绝返回 `403 app_policy_denied`，缺少或非字符串 app_id 返回 422。校验失败前不改变历史及事件。

## 应用 ID 与模块依赖

应用目录的 `route` 保持 `/office#<app_id>`，客户端应使用稳定 ID 映射现有目的地；它不是允许 Agent 执行任意 URL 的开放重定向。

| app_id | 页面 | 权限插件 |
| --- | --- | --- |
| messages | 消息 | im |
| agents | Agent 同事与好友 | im |
| docs | 云文档 | docs |
| tasks | 任务 | tasks |
| meetings | 视频会议 | meetings、calendar、docs |
| minutes | 人机妙记 | minutes |
| calendar | 日历 | calendar |
| approvals | 审批 | approvals |
| attendance | 打卡 | attendance |
| mail | 邮箱 | mail |
| reports | 报表，尚未实现 | 不可记录 |
| enterprise | 企业管理入口 | enterprise，内部管理动作仍按当前企业角色鉴权 |

`apps.available` 现在同时反映代码实现状态及当前身份的企业应用策略。读取历史时动态过滤当前不可用应用，避免旧访问记录继续提供已禁用入口。撤销禁用后原有真实历史可以重新出现，这不被视为发生了一次新访问。个人插件显隐偏好不充当企业 ACL；没有借最近使用给普通员工授予后台管理权限。

## 身份、持久化与可见性审查

状态存入既有 native IM state 的 `office.workbench_preferences[principal_id].recents`。身份始终来自已鉴权的 principal，不由请求传入；REST 即使带额外 principal_id 也只能操作本人，MCP/A2A 的额外字段校验会直接拒绝身份覆盖参数。

收藏更新保留 recents；记录或清空 recents 保留 favorites。读取返回新数组及复制后的应用对象，调用方不能通过修改回包改变共享状态。旧版本没有 recents 字段时按空历史兼容；格式损坏、重复或超过 32 项的持久历史启动时拒绝重置，不悄悄清掉个人数据。历史中已退役应用会从展示过滤，后续记录仍按 32 项上限修剪。

`application.recents.updated` / `application.recents.cleared` 是明确仅发给本人 ID 的个人事件。IM 插件被禁用时仍可收到本人的应用偏好事件；其他人或 Agent 不能订阅到这份个人历史。事件写入和状态变更在同一 persist 中。

持久化沿用原服务的临时文件、fsync、rename 和 fail-stop：保存失败后不再接受后续读写，不允许一条失败历史被后续成功请求带入磁盘；修复并重启后回到此前已经提交的历史。新增故障注入用例分别覆盖 POST 与 DELETE。

A2A 历史回执包含的最近应用和 `available: true` 应用会再次核对当前权限；管理员撤权后旧回执被阻断，调用方需重新获取经过当前过滤的工作台。清空最近使用是个人 MRU 清空操作，不删除已存在的独立 A2A 执行审计记录。

本轮独立源代码审查未在 recents 的身份绑定、企业策略、事件受众、持久化失败路径发现未处理的阻断问题。该结论针对上述实现及测试范围，不把本机文件存储描述为已部署的云端生产服务。

## + 菜单组件与实际截图证据

新增 Flutter `OfficeQuickCreateMenu`，供壳通过 `onSelected`、`isModuleAvailable`、`scopeKey` 接入原生动作。

- 锚点取真实 + IconButton 的 RenderBox；位于按钮下方 8 像素，右边界齐，默认宽 240。
- 白底、灰色 24 像素标准图标、17 字号、400 字重、50 行高。长列表在按钮下方可用区域内滚动。
- 增加 Agent 好友、Agent 商店等入口。保留已经工作的群组、联系人、文档、任务、会议、日程、审批、邮件、妙记回调 ID。
- 扫一扫、多维表格、问卷、会议室投屏可查看明确的未接入说明，不调用假的成功回调。妙记尚未接 ASR，因此不标为“开始录音转写”。联系人是现有身份添加，不标为已实现外部注册。
- 点击旧身份打开的菜单时再次核对 scope 与权限，不能替换后的新身份派发旧操作。

已打开参考图 `automation/2026/04_09/3/05/input/img/11.png`，并与真实字体 widget 渲染放在同一张全图和局部对比图查看。发现扫码图标多余 QR 纹理后改为 `CupertinoIcons.viewfinder`，重新截图及并排复查。

本机证据位于 Active Agent 的被忽略 `output`：`quick-create-menu-widget-402-reference11.png`、`quick-create-menu-reference11-widget-full-compare.png`、`quick-create-menu-reference11-widget-focused-compare.png`、`quick-create-menu-reference11-comparison.json`。详细五项保真检查见 `apps/office/design-qa.md`。

组件测试壳不是原生完整客户端；原参考图也裁掉右边缘。标准 Cupertino / Material 图标与飞书专属路径仍有形状差异。因此完整像素级验收尚未通过，不能以本轮组件截图宣布五端或全量飞书复刻已经完成。

## 语音边界复查与清理错误修正

重新审阅后端语音链路：只接受已上传的当前会话 attachment_id；真实字节经过完整 PCM16 WAV 图解析、字节数与 SHA 校验后推导媒体参数；隐藏、撤回、删除、离群、企业 IM 撤权和 A2A 回执都重查当前权限。普通、合并、嵌套转发重写为目标附件 ID，损坏音频在目标写入前拒绝。没有发现需要再修改的后端语音阻断问题；此前 12 项语音测试包含在本轮通过的后端全量中。

独立审查发现客户端 `voice_composer.dart` 在身份变化、后台和销毁时直接 `unawaited(close/cancel/stop)`；设备 dispose 或本机存储清理异常能逃出生命周期回调。现新增本组件的异步清理错误处理：消费失败；当前仍有效页面显示固定提示“语音设备清理失败，请关闭页面后重试。”；旧身份或已销毁页面不再 setState，也不覆盖身份变化提示。音频服务原本不能确认设备停止时保留焦点的保护保持有效。

新增四项抛错驱动测试分别覆盖身份切换、切换会话、后台取消，以及播放预览期间关闭面板且设备/存储同时失败。它们验证没有未处理 future、没有 dispose 后 setState、没有上传或发送旧录音，恢复前台不自动重新开启麦克风。没有以吞掉异常为由标注实际硬件已停止；设备状态无法确认时仍由原音频焦点保护阻止并发录音。

## 准确验证记录

| 验证 | 结果 | 日志与说明 |
| --- | --- | --- |
| Doc Free `npm test` 全量 | 363/363，0 失败/跳过 | `/tmp/renji-workbench-recents-full-20260907.log`；包含新增最近使用、真实 HTTP MCP 能力探测、A2A、12 项语音测试及既有后端回归 |
| 最终 recents 专项 | 9/9 | `/tmp/renji-workbench-recents-final-20260907.log`；在全量通过后增加一项 POST/DELETE 持久化故障注入，仅新增测试未改生产后端，未虚报已运行 364 项全量 |
| 早期 recents/办公/策略/MCP/插件专项 | 30/30 | `/tmp/renji-workbench-recents-targeted-20260907.log`，不是与全量互不重叠的额外数量 |
| A2A 加 recents 专项 | 27/27 | `/tmp/renji-workbench-recents-a2a-20260907.log`，不是与全量互不重叠的额外数量 |
| + 菜单最终组件及截图 | 5/5 | `/tmp/renji-quick-create-capture-20260907-fixed.log` |
| + 菜单定向 analyze | 无问题 | `/tmp/renji-quick-create-analyze-20260907-final.log` |
| 语音清理、既有 UI、音频 service、真实磁盘专项 | 41/41 | `/tmp/renji-voice-cleanup-final-20260907.log`，包含新增清理故障 4 项 |
| 语音清理定向 analyze | 无问题 | `/tmp/renji-voice-cleanup-analyze-20260907.log` |

初次后端全量的唯一失败是能力声明检查要求新 `workbench.recents` 对应真实端点探测；已增加 `office-http-integration.test.js` 中实际 HTTP MCP 记录、读取和清空验证后完整重跑 363 项通过，没有通过删除能力声明绕开测试。客户端首次语音测试遇到并行 OfficeState 编辑中的 Future.wait 推断编译错误，由状态任务修正后重跑通过。

本子任务没有重启本机 3218 服务，没有操作企业真实群发消息，没有打开麦克风或调用模型服务，也没有改主壳、stage、commit 或 push。主任务负责 OfficeState/导航集成后的原生构建、登录、客户端截图与最终提交回执。之前完成的媒体 SDK、WAV 解码与存储目录修复分别保留在当天独立文档中，不把旧结果冒充本轮原生设备验证。
