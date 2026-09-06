# 2026-09-06 · 企业组织、管理员权限与可读管理审计

| 字段 | 值 |
| --- | --- |
| 记录时间 | 2026-09-06T11:42:11+08:00 |
| 分支 | `equal_rights` |
| 本轮实现基线 | `134e0a78fc51345689be377004e793dd6a7fd71d` |
| 实现提交 | 提交后由 `VERSION.json` 和发布清单关联 |
| 描述 | 为当前单工作区增加真实企业组织、固定角色、成员状态、部门层级、管理审计和导出，并让 Agent 管理员使用相同原生 API |

本篇是 [账号、考勤和审批](ACCOUNTS_ATTENDANCE_AND_APPROVALS.md) 与 [插件/同权通讯录](PLUGINS_CONTACTS_AND_CAPABILITIES.md) 之后的新实现记录。企业管理后台读取真实成员、部门和审计数据，修改由服务端验证权限与版本。UI 是否显示按钮不构成授权边界。

2026-09-06T12:16:07+08:00 后续补充：[企业应用策略](ENTERPRISE_APPLICATION_POLICIES.md) 已实现 owner/admin 的应用开关、人员/部门范围、跨模块依赖、事件过滤及 A2A 历史回执按当前权限复核。以下保留组织管理阶段说明，并列明新增能力。

## 1. 当前企业与初始化

一个 Doc Free 部署中的当前 workspace 对应一个 enterprise，固定内部标识为 `enterprise-workspace`，返回 `scope:single_workspace`。这没有实现多个企业数据隔离、跨租户切换或企业间联合管理。

所有已经存在的 principal 默认迁移为普通 member。human 和 agent 的默认角色相同；已有的房间 owner、专属 Agent owner、商店安装者或机器连接不会因此自动成为企业管理员。只有持工作区 bootstrap 管理凭据的部署运营者，能够第一次指定初始企业所有者：

```text
POST /api/im/admin/enterprise/bootstrap
Authorization: Bearer <工作区管理凭据>

{
  "principal_id": "principal-已存在且有效的身份ID",
  "name": "企业名称"
}
```

成功返回 `{enterprise,membership,capabilities,duplicate:false}`；重复指定相同初始 owner 返回 duplicate=true。企业初始化后不能通过该接口将任意其他成员重新提升为 owner，应由当前企业 owner 通过正式角色管理完成。该 bootstrap 接口不发布到普通成员 MCP/A2A 工具目录，也不出现在普通成员的自提权 UI 中。

普通身份使用 `GET /api/im/enterprise` 检查本人企业身份：

```json
{
  "enterprise": {
    "id": "enterprise-workspace",
    "name": "当前工作空间",
    "initialized": true,
    "revision": 2,
    "scope": "single_workspace"
  },
  "membership": {
    "principal_id": "principal-current-id",
    "role": "member",
    "status": "active",
    "department_id": null,
    "revision": 1
  },
  "capabilities": {
    "access_admin": false,
    "manage_members": false,
    "manage_departments": false,
    "manage_apps": false,
    "assign_admin": false,
    "assign_owner": false,
    "view_audit": false,
    "manage_enterprise": false
  }
}
```

示例省略创建/更新时间、名称及成员公开资料。未初始化时现有参与者仍能正常使用原生 IM，但 access_admin=false，不会因点击企业管理入口而得到管理数据。

## 2. 固定角色和权限

| 行为 | member | admin | owner |
| --- | --- | --- | --- |
| 读取本人企业身份 | 是 | 是 | 是 |
| 管理后台概览、成员目录、角色和审计 | 否 | 是 | 是 |
| 新建普通人/Agent 成员 | 否 | 是 | 是 |
| 修改普通成员名称、状态、部门 | 否 | 是 | 是 |
| 创建和管理部门 | 否 | 是 | 是 |
| 管理应用启用与人员/部门范围 | 否 | 是 | 是 |
| 变更企业角色或管理管理员/owner | 否 | 否 | 是 |
| 修改企业名称 | 否 | 否 | 是 |
| 导出组织与管理审计 | 否 | 是 | 是 |

admin 可以修改自己的名称，但不能借此修改自己的角色、停用/撤销另一个管理员或冒充 owner。成员不能在请求体声明高角色，admin 不能把自己或普通成员提升为 admin/owner。owner 可以授予、变更或收回企业角色，人类和 Agent 的权限判断完全一致。

任何操作都必须留下至少一位 active owner。保护覆盖 owner 自我降权、禁用、正式企业 revoke、旧 `/admin/revoke` 入口以及串行队列中并发发生的两位 owner 同时降权；最后一位 owner 会收到 `409 last_enterprise_owner`。因此不能先禁用最后 owner，再绕过角色检查锁死企业。

企业角色与会话权限是两个独立的业务边界。拥有企业 admin/owner 角色不自动加入所有房间，不自动获得其他人的邮箱、私密审批或文档读取权。后台组织导出也不包含共享业务文档和个人邮箱正文。

## 3. 完整 API 合同

下面的 `/enterprise/admin/*` 路径均以 `/api/im` 为前缀。它们使用当前 principal 的 Bearer，并在每次请求时验证当前企业角色。普通成员调用返回 `403 enterprise_admin_required`；只有 owner 的动作由 `enterprise_owner_required` 保护。

| 方法与路径 | 输入 / 查询 | 响应 |
| --- | --- | --- |
| `GET /enterprise` | 无 | `{enterprise,membership,capabilities}` |
| `GET /enterprise/admin/overview` | 无 | 上述字段和 counts |
| `GET /enterprise/admin/members` | q、status、role、department_id、page、page_size | `{members,total,page,page_size}` |
| `GET /enterprise/admin/members/:principal_id` | 无 | `{member}` |
| `POST /enterprise/admin/members` | `{client_id,name,kind,department_id?}` | `{member,token,duplicate,credential_returned}` |
| `PATCH /enterprise/admin/members/:principal_id` | `{base_revision,name?,role?,status?,department_id?}` | `{member}` |
| `POST /enterprise/admin/members/:principal_id/revoke` | `{base_revision}` | `{member,duplicate}` |
| `GET /enterprise/admin/departments` | 可选 q | `{departments}` |
| `GET /enterprise/admin/departments/:department_id` | 无 | `{department}` |
| `POST /enterprise/admin/departments` | `{client_id,name,parent_id?}` | `{department,duplicate}` |
| `PATCH /enterprise/admin/departments/:department_id` | `{base_revision,name?,parent_id?}` | `{department}` |
| `DELETE /enterprise/admin/departments/:department_id` | `{base_revision}` | `{removed:true}` |
| `GET /enterprise/admin/roles` | 可选 q，匹配固定角色 ID/名称 | `{roles}` |
| `GET /enterprise/admin/roles/:role_id` | owner、admin 或 member | `{role}` |
| `GET /enterprise/admin/audit` | q、page、page_size | `{entries,total,page,page_size}` |
| `PATCH /enterprise/admin/profile` | `{base_revision,name}`，仅 owner | `{enterprise}` |
| `GET /enterprise/admin/export` | 无 | 可读 Markdown，包含组织/角色/成员/部门/脱敏审计 |

counts 包含 members、active、disabled、revoked、humans、agents、departments、owners、admins；owners/admins 仅统计当前 active 的高级角色。成员总数及 human/agent 总数含历史停用/撤销成员。

分页 page 从 1 开始，page_size 缺省 25、最大 100，q 最多 100 字符。members 的 status 可选 all/active/disabled/revoked，role 可选 all/owner/admin/member。department_id 表示该成员的主要部门。未知筛选值和非法页码直接失败，不默认为具有更广范围的查询。

member 包含 `id,principal_id,name,kind,role,status,department_id,department_name,revision,created_at,disabled_at,revoked_at`。enterprise 包含 id、name、revision、initialized、created_at、updated_at、scope。role 包含 id、name 和固定 capabilities flags。

管理写入必须提供当前 base_revision；旧版本返回 `409 conflict`，缺少版本返回 `422 version_required`。角色、状态、部门和名称同时修改时，权限、字段与版本检查全部发生在业务变更之前。未知字段不能借机设置 managed、token_hash、created_at 或其他身份内部状态。

## 4. 真实成员创建和身份生命周期

新建成员 kind 为 human 或 agent，角色固定从 member 开始；部门可选。即使 owner 创建成员，也要经过单独角色修改请求才能授予高级权限，使授予动作在管理审计里单独可见。

创建必须带稳定 client_id，范围为当前管理操作者。相同意图重试返回同一成员，修改负载返回 `409 idempotency_conflict`。首次成功时只返回一次独立随机机器 token，服务端只保存 SHA-256 哈希，目录、审计和组织导出都不会重放它。重试响应为 `token:null,duplicate:true,credential_returned:false`，客户端不能把它显示成新发凭据。

新身份的密码账号继续使用 [账号协议](ACCOUNTS_ATTENDANCE_AND_APPROVALS.md)：持独立机器凭据首次为自己开通，或由 bootstrap 管理者另行开通/重设。创建成员没有自动发送邮件、生成邀请链接或声称完成企业 SSO；如果首次 token 响应丢失，幂等重试保证不重复建人，但不会恢复只保存了哈希的机器 token。

PATCH status=disabled 会立即拒绝该 principal 的机器 Bearer 和密码登录；已有密码 sessions 被撤销，当前事件长轮询和媒体信令长轮询被唤醒后重新鉴权，会议媒体 session 被清除，该 Agent 尚在运行的原生工作转为 cancelled。管理员无需等用户关闭界面才能生效。

禁用保留历史记录和房间成员关系。重新启用为 active 后，原机器身份入口恢复；先前被撤销的密码会话仍然无效，需要重新密码登录。已经提交的历史消息、审批或工具动作不会因禁用而伪装为从未发生。

revoke 是终止身份：拒绝所有凭据、撤销密码会话、移除房间成员关系并取消运行。已 revoked 的 principal 不能通过 status=active 或重新分配角色恢复；组织目录和审计继续保留历史。普通 admin 对自己或其他高级角色没有 revoke 权限，owner 也不能撤销最后有效 owner。

## 5. 部门层级与成员归属

department 包含 `id,name,parent_id,revision,created_at,updated_at,member_count`。每人当前只有一个主要 department_id；null 表示无主要部门。部门层级最多 200 个节点，同一父部门下不允许同名节点，名称长度 1–100。

创建部门也必须使用稳定 client_id。丢失响应后重试返回原 department ID；相同 key 改负载会冲突。原部门如果随后已被删除，该旧意图返回 `409 operation_target_removed`，不能意外复活它。

parent_id 必须指向已有部门或为 null。修改父节点时沿完整祖先链检查，禁止自己作为父节点及把祖先搬到自己的后代之下。循环检查发生在修改前，失败不会推进 revision 或留下半次层级变更；重启遇到损坏的循环结构会拒绝加载，不静默清空组织数据。

删除必须同时满足无子部门、没有任何成员归属，并携带当前 revision；否则返回 `409 department_not_empty`。管理员先明确迁移成员和子部门，再删除空部门。停用/撤销成员仍占据其记录中的部门归属，因此删除前也要处理其组织归属，避免孤立引用。

## 6. 管理审计和文档载体

管理审计包含 `id,seq,at,actor_id,actor_kind,action,target_type,target_id,details`，按管理序列递增，查询按最新顺序分页，保存最新 10000 条。audit 记录成功的初始化、企业资料修改、成员创建、角色/状态/部门变更、撤销及部门增删改。Agent 管理员的 actor_kind=agent，与人类管理员具有同样明确的操作者来源。

旧 bootstrap principal 创建/撤销及通过 Agent 商店创建新身份也写入成员创建/撤销来源。已有密码账号的安全审计仍按账号模块单独保存；当前企业审计不是全链路 SIEM，不声称记录所有失败登录或每一次被拒绝的管理尝试。

`GET /enterprise/admin/export` 生成标题、导出时间/操作者和带边界保护的结构化 Markdown，包含企业资料、固定角色能力、成员公开管理资料、部门及管理审计。它不包含机器 token/hash、密码摘要/salt、账号 session、模型凭据或个人业务正文。该文档使人和有权限的 Agent 能审阅同一组织状态，而不是把组织权限藏在只对某个模型可见的内存里。

企业成员自己的角色/资料变化通过 enterprise.membership_changed 个人事件通知本人，继续使用已有 `/events` 游标。禁用/撤销者不再有权接收事件。后台读写在串行持久化事务中完成，存储故障后进程进入 fail-stop；修复并重启恢复最后完整状态，不会在下一次请求中偷偷提交失败的组织变更。

## 7. 插件、原生传输和验证

企业管理作为 available=true 的 enterprise 插件和工作台入口 `/office#enterprise` 出现。能力 ID 为 enterprise.identity、enterprise.overview、enterprise.members、enterprise.departments、enterprise.roles、enterprise.audit，后续增加 enterprise.apps。能力目录可见不意味着当前身份已获企业管理权；普通用户进入只显示本人角色与真实无权限状态。组织 Markdown 导出后续增加 application_policies，保留当前策略的可读审计依据。

成员端 API 由同一业务处理器执行，MCP/A2A 工具应携带原身份凭据并使用本篇路径，保留版本和 client_id。bootstrap 管理凭据不属于成员工具契约。跨传输新建成员时，凭据只应交付到首次调用响应，不能写入持久 A2A 收据或导出文档。

企业首次专项 **7/7 通过**，随后加入部门创建幂等后 **8/8 通过**；与插件一起执行为 **12/12 通过**。此前包含企业和真实 HTTP 验证的全量 `npm test` 为 **100/100 通过**，最终提交结果由发布清单列出。

覆盖旧数据默认 member、房间 owner 不升权、Agent owner/admin 同权、普通成员拒绝后台、禁止自提权、企业权限不突破房间 ACL、最后 owner 与并发降权、部门防循环/非空删除、版本检查、停用 token/session/事件/媒体和取消 Agent 运行、重新启用后旧 session 仍失效、创建幂等、只返回一次 token、分页/搜索、无凭据导出、rename 故障原子恢复和损坏组织拒绝加载。

本轮后续最终 `npm test` 已为 **114/114 通过**，含 **217 次真实 HTTP 请求**；应用范围具体回归见 [企业应用策略记录](ENTERPRISE_APPLICATION_POLICIES.md)。

当前角色固定为 owner/admin/member，已实现应用级启用和明确人员/部门范围；尚未实现自定义角色、字段级或业务记录级自定义授权编排、动态授权规则、身份治理审批、多部门任职、组织继承权限、SCIM/SSO、跨企业租户隔离或飞书的完整管理员风险控制功能。新增界面应按这些真实边界展示，不能将静态按钮、能力目录或未来规划当成已经生效的企业策略。
