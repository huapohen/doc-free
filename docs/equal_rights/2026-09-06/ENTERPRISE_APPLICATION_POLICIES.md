# 2026-09-06 · 企业应用策略、独立业务入口与当前权限回执

| 字段 | 值 |
| --- | --- |
| 记录时间 | 2026-09-06T12:16:07+08:00 |
| 分支 | `equal_rights` |
| 本轮实现基线 | `134e0a78fc51345689be377004e793dd6a7fd71d` |
| 实现提交 | 提交后由 `VERSION.json` 和发布清单关联 |
| 描述 | 将企业应用开关与人员/部门范围变为真实服务端权限；保留独立业务选择器，并按当前权限复核 A2A 历史结果 |

本篇接续 [企业管理](ENTERPRISE_ADMINISTRATION.md) 和 [插件与能力](PLUGINS_CONTACTS_AND_CAPABILITIES.md)。企业管理员配置的应用范围会同时约束人类与 Agent 的 API、MCP、A2A 调用，个人插件偏好继续独立保存。浏览器隐藏入口只是权限结果的展示，服务端在请求、事件回放和异步结果读取时执行检查。

## 1. 管理权限与 API

接口均以 `/api/im` 为前缀，使用当前 principal 的 Bearer。企业 owner 和 admin 具有 `manage_apps` 能力，普通 member 返回 `403 enterprise_admin_required`。拥有管理角色仍须遵守其本人被配置的业务应用范围，不自动获得其他房间、邮箱或私密审批访问权。

| 方法与路径 | 输入 | 响应 |
| --- | --- | --- |
| `GET /enterprise/admin/apps` | 可选 q，最多 100 字符，匹配 ID/名称 | `{apps}` |
| `GET /enterprise/admin/apps/:plugin_id` | 无 | `{app}` |
| `PATCH /enterprise/admin/apps/:plugin_id` | 当前版本、启用状态和可用范围 | `{app}` |

```json
{
  "base_revision": 1,
  "enabled": true,
  "scope_mode": "restricted",
  "allowed_principal_ids": ["principal-example-agent"],
  "allowed_department_ids": ["department-example"],
  "denied_principal_ids": []
}
```

上述 ID 为占位示例，写入时必须替换为当前企业的真实成员和部门。`base_revision` 与布尔型 `enabled` 必填。数组字段可省略并继承旧值；未明确提供 `scope_mode`、但提供任一 allowed 数组时，模式自动为 `restricted`。未提供模式和 allowed 数组则保留原模式。客户端应明确发送模式，避免把空列表误解为全员可用。

未知字段、非法类型、不存在或已撤销的成员、未知部门均被拒绝。成员数组最多 1000 项，部门数组最多 200 项；保存前去重并排序。缺少版本返回 `422 version_required`，版本过时返回 `409 conflict`，非法范围返回 `422 invalid_app_scope`；失败不推进策略版本。

`app` 包含插件声明、`execution`、`policy`、`protected_core`、对当前调用者计算的 `enterprise_allowed`、`enterprise_policy_revision`、`enterprise_policy_reason` 和 `required_plugins`。`policy` 包含上述启用/范围字段以及 `revision,updated_at,updated_by`。管理目录中的“已启用”表示企业策略状态，不意味着一个未连接的外部扩展已经具有执行器。

MCP 对应工具为 `enterprise_apps`、`enterprise_read_app`、`enterprise_configure_app`，内建能力 ID 为 `enterprise.apps`。A2A 通过同一冻结工具描述和原生处理器执行这些成员操作，管理权限不会因为换了传输而改变。

## 2. 可用范围的精确含义

没有配置记录时，应用默认 `enabled:true,scope_mode:all`，三个范围数组为空，revision 为 1。每次有效写入递增版本并记录当前操作者和服务端时间。

对普通业务应用，判断顺序为：

1. `enabled:false` 拒绝所有身份，原因 `disabled`。
2. 身份出现在 `denied_principal_ids` 时拒绝，原因 `explicitly_denied`；显式拒绝优先于部门或人员允许。
3. `scope_mode:restricted` 时，只有本人 ID 在允许列表，或其当前主要部门在允许部门列表，才获允许；否则为 `not_in_scope`。
4. 其余情况允许，原因 `allowed`。

`all` 模式下 allowed 数组不缩小范围，denied 数组仍然生效。`restricted` 加空 allowed 数组表示无人被允许。部门采用当前主要部门的精确匹配，不继承父/子部门权限，也不从旧请求或历史回执缓存部门归属。调整成员部门会立即重新计算业务范围。

`settings` 和 `enterprise` 是受保护核心应用，必须保持全员启用、`scope_mode:all` 且所有范围数组为空。试图限制这些入口返回 `409 app_policy_protected`。这保留身份与管理恢复路径，并不赋予普通成员管理权限。`/me`、`/auth/*`、企业身份/管理接口、设置、插件/能力发现继续遵守各自身份权限而可被访问。IM 本身可以被企业策略关闭。

业务拒绝返回 `403 app_policy_denied`，错误对象包含 `plugin_id`，指明具体受限模块。REST 与 MCP 保留这一字段，客户端可据此更新应用状态；它不能把房间 ACL、私密审批或其他一般 403 当作企业关闭应用。

## 3. 个人开关与真实可用状态

个人 `PATCH /plugins/:id` 的 `enabled` 仍是 `principal_preference`，不授予或撤销基础业务权限。企业策略单独保存于 `enterprise.app_policies`，个人不能通过打开插件绕过企业限制。

`GET /plugins` 在个人偏好与插件声明之外返回：

| 字段 | 含义 |
| --- | --- |
| `enterprise_allowed` | 当前 principal 是否通过该应用的企业范围 |
| `enterprise_policy_revision` | 当前企业策略版本 |
| `enterprise_policy_reason` | allowed / disabled / explicitly_denied / not_in_scope |
| `required_plugins` | 该能力界面涉及的原生模块依赖 |
| `blocked_dependency_ids` | 当前不允许的依赖 ID |
| `dependencies_allowed` | 所有依赖均通过企业策略 |
| `effective_enabled` | 个人启用、企业允许、依赖允许且实际 available 同时成立 |

外部 integration/hardware 声明仍为 `available:false,execution:not_connected`。管理员登记、企业允许或个人启用它们都不会发出网络调用、安装代码或连接设备。

## 4. 原生路由与跨模块依赖

服务端按固定业务路径和已知房间子资源映射应用，不接受用户提供 URL 通配符或代码来定义权限。

| 原生资源/操作 | 必须允许的应用 |
| --- | --- |
| 会话列表、私聊、会话元信息、消息、成员和会话偏好 | im |
| 同事/联系人、Agent、商店、在线状态、附件 | im |
| `/rooms/:id/documents...` | docs |
| `/rooms/:id/tasks...` | tasks |
| 本人/房间考勤 | attendance |
| 房间补卡申请 | attendance + approvals |
| 审批及审批模板 | approvals |
| 工作区内部邮箱 | mail |
| 日历和日程 | calendar |
| 工作台偏好 | workbench |
| 会议和 WebRTC 信令/媒体 session | meetings + calendar + docs |
| 会话 Markdown 完整导出、原生 turns 与租约操作 | im + docs + tasks + meetings + calendar |

会议目前包含关联日程与规范会议笔记的元数据，因此这些依赖属于真实返回合同。完整会话导出与 Agent 运行包含不可分割的精确混合上下文，不能在撤销某一模块后仍让旧执行器拿到完整上下文。需要更细的运行权限时，应另行设计能够独立授权的上下文合同。

文档、任务、考勤、审批、日历可以在 IM 关闭时独立操作，前提是当前房间成员权限和各模块策略通过。关闭 IM 不等于退出已有房间；建立新房间或改变其成员仍属于 IM 能力。

## 5. 聚合、独立业务房间和事件过滤

`/search` 与 `/library` 按域过滤当前被拒绝的应用。合法结果继续返回，无需所有应用同时开启。会话详情在 IM 可用时保留自身信息，但受限的 documents/tasks 数组和计数被清空；混合运行记录仅在完整上下文依赖全部可用时出现，响应附 `restricted_plugins`。

为了让独立业务界面在关闭 IM 后仍能选择会话与负责人，`GET /library` 增加最小房间目录：

```json
{
  "rooms": [
    {
      "id": "room-example",
      "name": "业务空间",
      "members": [
        {"principal_id": "principal-example", "name": "协作者", "kind": "human"}
      ]
    }
  ]
}
```

这里只包含调用者当前所属房间，以及当前未禁用/撤销的房间成员公开 ID、名称和 kind。没有机器凭据、角色、在线状态、消息摘要、未读或业务计数。只有 docs/tasks/attendance/approvals/calendar 中至少一个可用时返回这些房间；会议可用也必然满足 docs/calendar。没有可用房间业务时为 `rooms:[]`。

`/events` 同时按当前应用范围、当前房间关系、既有私密审批/考勤规则过滤。个人事件只返回本人有权接收的条目，响应中的 `audience_ids` 投影为当前本人 ID，避免从通知获得其他人的私人收件名单。

策略写入产生 `application.policy_changed`，包含 plugin_id/revision，并唤醒订阅者。已经等待的长轮询醒来后重新检查权限，后续被关闭模块的邮件、审批、文档或其他事件不会沿旧订阅泄漏。设置、插件、企业和应用策略恢复通知继续按本人受众可见。

策略或成员部门变化会取消已失去混合上下文权限的 running turn。会议媒体 session 在策略变更检查时被移除，信令轮询在开始及唤醒后复核；策略变更不会等待用户重新打开界面才生效。

## 6. A2A 历史回执按当前权限复核

A2A 的 task 所有权只标识提交者，不能永久授权其读取旧业务快照。`native-im` 提供 `authorizeStoredOperation({method,pathname,input,receipt},credential)`；网关以可信冻结 MCP 工具描述解析原始操作路径，传入保存的原生结果，而不是将任意 artifact 文本解释成权限。

复核在原生串行队列中完成，检查当前身份有效性、模块依赖、管理角色、原操作房间以及结构化结果中的真实业务资源。私密审批、考勤、会议/日程、个人邮箱、消息及房间归属沿用相应当前权限。`room_id`、`room_ids`、来源/目标房间与实际结果投影中的文档、任务、消息、运行、清单、计数和搜索类型都会参与检查。

验证覆盖 task 查看、历史、重复提交和取消相关结果返回路径。离开房间、应用范围收紧、管理员降权、账号会话撤销后，旧收据中不再可访问的结果会被拒绝；网关不会为了重新“验证”而执行一次原业务写入，也不读取 CRDT 正文、写业务状态或推进到期处理。

聚合回执根据实际包含的数据验证：新搜索/资料库已经过滤掉受限领域时仍可完成；旧搜索若还包含现已不可见的邮件、文档或审批片段则拒绝读取和重复投递。没有对所有 search/library/room-list 结果施加“所有模块必须可用”的一刀切条件。

结构化遍历最多 10000 节点、深度 30。正文、描述、payload、instructions、details 等显式用户内容与 `forwarded_from` 来源记载不会被递归当作新的授权引用。字符串形式的完整会话导出由原始路由、当前房间和完整上下文依赖保护。具体真实传输证据见 [A2A 当前访问验证](A2A_CURRENT_ACCESS_VERIFICATION_1215.md)。

## 7. 文档、持久化与验证证据

企业策略的成功写入生成 `application.policy_updated` 管理审计，包含 before/after、操作者和时间。`GET /enterprise/admin/export` 的 Markdown 包含 `application_policies`；`GET /plugins/export` 展示个人启用、企业允许、实际可用、企业策略版本及受限依赖。人和获授权 Agent 可以读取同一配置及变更记录。

配置与业务变更遵循现有单进程串行 JSON 持久化；故障后 fail-stop，重启加载最后完整状态。损坏策略结构不会被静默重置为全员开放。持久化失败的拒绝配置不会在下一请求偷偷落盘。

本轮验证结果：

- 应用策略专项 **8/8**：角色/种类同权、个人偏好隔离、全部业务路径映射、聚合与事件过滤、部门实时范围、独立 library rooms、旧收据检查、版本/schema 与持久化故障。
- 企业管理专项 **8/8**；独立审查的 A2A 19 + 应用策略 8 + 真实 HTTP 8 合计 **35/35**。
- 最终 `npm test` **114/114 通过，0 失败/取消/跳过**，耗时约 5.44 秒；真实 HTTP 集成共 **217 次请求**，外部扩展产生 **0 次适配器请求**。
- 验证时 JavaScript 源码 SHA-256：`1793d8f0348edad7affaf7a6e3a6634513812d7a3f00e22782a9823e41613682`。源码摘要用于关联测试候选，不替代最终 Git commit。

测试使用隔离服务/CRDT 进程和明确夹具，不调用模型、外部邮件传输或真实媒体采集。浏览器、Flutter 各平台构建和真实模型验收由发布记录另行列出，不能由这些后端测试推断。

## 8. 当前边界

应用策略约束模块访问，不是内容 DLP。用户先前明确发布到 IM 的文档摘录、邮件文字或转发副本仍是那条消息的可读内容，关闭源模块不会追溯擦除副本。完整旧回执则按其结构化源资源和当前权限检查。

本版仍是单 workspace 对应单 enterprise，固定 owner/admin/member、单主要部门、精确部门匹配；没有跨租户隔离、自定义字段权限、继承组织授权、动态策略语言、SSO/SCIM 或外部适配器执行平台。模型原生动作编排的下一阶段设计与本轮已经实现的成员 API/MCP/A2A 应分开验收。
