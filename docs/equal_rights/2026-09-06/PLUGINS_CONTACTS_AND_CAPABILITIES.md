# 2026-09-06 · 插件声明、个人配置与同权通讯录

| 字段 | 值 |
| --- | --- |
| 记录时间 | 2026-09-06T11:12:07+08:00 |
| 分支 | `equal_rights` |
| 本轮实现基线 | `134e0a78fc51345689be377004e793dd6a7fd71d` |
| 实现提交与最终验证 | 由 `VERSION.json` 和发布记录关联 |
| 描述 | 为原生办公模块提供统一能力声明、版本化个人开关、受控扩展登记、人和 Agent 同权联系人及真实全员提及 |

原生插件目录让人和 Agent 看到同一组可用能力和配置。权限仍由真实业务处理器判断：通讯录关系不等于加入房间，个人开关不等于授予权限，声明一个网络或硬件适配器也不会自动获得任意网络调用和代码执行能力。

2026-09-06T12:16:07+08:00 后续补充：[企业应用策略](ENTERPRISE_APPLICATION_POLICIES.md) 已加入独立于个人偏好的真实模块访问限制。插件读取返回 enterprise_allowed、企业策略版本/原因、required_plugins、blocked_dependency_ids、dependencies_allowed 与 effective_enabled；插件 Markdown 导出同步展示个人/企业/实际状态。最终后端 `npm test` **114/114 通过**，含 **217 次真实 HTTP 请求**，以下此前阶段计数保留为历史记录。

## 1. 插件与能力发现

以下路径以 `/api/im` 为前缀，个人端点均需身份 Bearer。

| 方法与路径 | 输入 | 响应 |
| --- | --- | --- |
| `GET /plugins` | 无 | `{plugins}`，内建与管理员登记的扩展 |
| `GET /plugins/:id` | 无 | `{plugin}`，含本人配置 |
| `PATCH /plugins/:id` | `{base_revision,enabled?,config?}` | `{plugin}` |
| `GET /plugins/export` | 无 | 本人可读的插件目录、能力和配置 Markdown |
| `GET /capabilities` | 无 | protocol、identity_model、configuration_scope 和 capabilities |
| `GET /admin/plugins` | 管理凭据 | `{plugins}`，声明列表 |
| `POST /admin/plugins` | `{manifest,base_revision?}`，管理凭据 | `{plugin}`，创建或按版本更新扩展声明 |

plugin 返回 id、name、description、kind、builtin、available、capabilities、config_schema、enabled、config，以及个人 revision 和独立 manifest_revision。内建模块默认 enabled=true、available=true；未连接扩展默认 enabled=false、available=false。

个人配置的 `configuration_scope=principal_preference` 表示这是 UI/连接器可消费的个人偏好，不是新的 ACL。隐藏或关闭某个内建插件不撤销已授予的基础业务访问，也不阻止用户再次打开设置。启用某个扩展不会令 available 从 false 变为 true；不能提交 role、principal_id、执行代码或未声明配置字段来扩权。

每次 PATCH 都需要当前 base_revision 并推进个人 revision；两个设备写同一旧版本会冲突。配置只对当前 principal 生效，Agent 也拥有自己的配置。配置变化发出 plugin.configured 个人事件，包含 plugin_id/revision，其他人收不到此人的配置变更。配置值不直接广播到共享房间。

## 2. 稳定的内建能力 ID

| 插件 | 能力 ID | 权限依据 |
| --- | --- | --- |
| im | im.identity、im.contacts | 当前身份本人 |
| im | im.rooms、im.messages、im.agents、im.attachments | 当前房间成员、owner 或当前同事关系对应的原生权限 |
| docs | docs.documents | 当前成员和已共享文档绑定 |
| tasks | tasks.tasks | 当前会话成员 |
| meetings | meetings.meetings、meetings.media | 当前成员、会议创建者、本人媒体 session |
| calendar | calendar.events | 当前成员、创建者或本人邀请回应 |
| workbench | workbench.preferences | 本人工作台收藏 |
| attendance | attendance.records、attendance.corrections | 本人/owner；补卡指定审批 |
| approvals | approvals.requests、approvals.decisions | 申请参与者/owner；决定仅指定审批人 |
| mail | mail.messages | 本人的工作区邮箱 |
| settings | settings.preferences、settings.plugins | 本人设置和插件偏好 |
| enterprise | enterprise.identity、enterprise.overview、enterprise.members、enterprise.departments、enterprise.roles、enterprise.audit、enterprise.apps | 本人企业身份；后台按企业 admin/owner 与目标角色检查 |

capabilities 每项包含 id、name、authorization、plugin_id、enabled、available 和 execution。authorization 是可读声明，调用仍须通过真实 API 的身份、当前成员、版本和业务状态检查。内建 execution 为 native_authorized_handler。

enterprise 为 2026-09-06T11:42:11+08:00 后续新增模块，具体初始化、固定角色和真实后台范围见 [企业管理记录](ENTERPRISE_ADMINISTRATION.md)。

API、MCP、A2A 的统一工具路由可以引用这些稳定 ID，但不能把 capability 文本当作执行代码。各传输使用同一成员业务接口；其网关入口、Agent Card 与任务回放的最终合同由对应网关实现和发布记录列出。

## 3. 网络与硬件扩展登记

管理员可以登记 integration 或 hardware 类型的 manifest，不能覆盖 im/docs 等内建 ID。扩展 ID 为 2–50 位小写字母、数字、下划线或连字符，必须以字母开头；每个扩展声明 1–32 个独立能力，能力 ID 必须位于 `<plugin_id>.` 命名空间，避免伪装内建能力。

```json
{
  "manifest": {
    "id": "device_demo",
    "name": "设备状态声明",
    "kind": "hardware",
    "description": "登记待连接的办公设备适配器",
    "adapter": {
      "transport": "device",
      "endpoint": "https://device.example.invalid/adapter"
    },
    "capabilities": [
      {"id": "device_demo.status", "name": "读取设备状态"}
    ],
    "config_schema": {
      "label": {"type": "string", "default": "预览设备"},
      "polling": {"type": "boolean", "default": false}
    }
  }
}
```

这是声明示例，不是可连接的设备地址。adapter.transport 允许 api、mcp、a2a、device；可选 endpoint 仅接受不带用户名、密码、查询参数、片段的 HTTP(S) URL。登记和启用均不发出网络请求，不加载代码，不驱动硬件，不读取本机文件；扩展持续显示 `available:false,execution:not_connected`。

config_schema 最多 20 个字段；每字段声明 string、boolean 或 number，可带 label、default 和最多 30 项 enum。string 值最多 1000 字符，number 必须有限；所有写入检查类型和枚举。字段名不能含 password、secret、token、authorization、credential、api_key 等凭据含义，登录 token 与外部密钥不得保存到普通插件配置。未来实际连接器应使用独立、受控的凭据提供机制。

管理员再次 POST 同一 ID 必须带声明 base_revision；实例最多登记 100 个扩展。声明更新和个人配置具有独立版本。删除或变更配置字段后，读取只返回当前 schema 允许的值，不把已废弃字段暴露为有效配置。扩展没有动态执行器或自动安装包机制，本版不宣称已经打通所有办公硬件。

## 4. 人和 Agent 同权联系人

| 方法与路径 | 输入 | 响应 |
| --- | --- | --- |
| `GET /contacts` | 无 | `{contacts}`，本人主动添加且仍有效的联系人 |
| `POST /contacts` | `{principal_id}` | `{contact,duplicate}` |
| `DELETE /contacts/:principal_id` | 无 | `{removed}` |

contact 与 principal 共享 id、name、kind 等公开资料，附 relationship=friend 和短期 presence。human 可以添加 human/agent；agent 也可以添加 human/agent。不能添加自己，不可伪造其他人的通讯录关系；每人最多 100 个主动联系人。

添加同一联系人幂等，删除不存在关系返回 removed=false。联系人关系是单向个人记录，不会自动替另一人添加好友、开私聊、改变房间成员资格或撤销身份。添加和删除会发布只属于自己的 contact.added/contact.removed 事件；其他人的通讯录和房间成员列表保持各自的业务规则。

原 `/agents` 接口保留兼容：它继续合并本人专属安装、当前共享房间与主动 Agent 联系人，供原 Agent 商店 UI 使用。`/contacts` 则是本人明确添加的通讯录；shared-room 出现在 /agents 不表示已经添加为联系人。已被管理员撤销的身份不出现在有效通讯录中，已有会话审计仍保留历史身份资料。

## 5. 真实 @全员

消息 mentions 接受最多 100 个真实 principal ID，与每房间最大 100 名成员一致；必须全部是发送时的当前成员，服务端去重并排序。不接受伪造的 `all` 或 `@all` 身份。

UI 的“@全员”应读取当前成员，把真实 ID 数组填入 mentions。这样每个 human/agent 接收相同持久消息，Agent 的 mentions 参与策略可以依据自己的实际 ID 决定是否行动。成员从房间移除后，旧名单发送会失败，客户端应刷新并重新确认当前成员。

## 6. 原生 API 全域搜索

`GET /search?q=<文本>` 返回 `{query,results,truncated}`。q 为 1–100 字符，大小写不敏感子串匹配，所有领域合计最多 200 个结果。API 内部直接调用已有模块的授权读取逻辑，不在串行事务里递归调用自己，也不依赖人点击 UI 后才能触发搜索。

每个结果有 type、id、title、content、snippet，原 message/document/task 字段保持兼容。工作区目录新增 person/agent（附 principal），商店模板为 store（附 agent）；本人邮箱为 mail（附 mail），私密申请为 approval（附 request），有权访问的日程为 calendar（附 event）。涉及房间的结果附 room_id，版本化记录附 revision。

消息搜索仍排除撤回正文和修订历史，消息/任务/文档扫描预算继续为 10000/2000/100。身份目录只含未撤销的公开 principal 资料，商店仅公开模板。邮件复用本人所有邮箱文件夹搜索，并从授权正文生成命中附近片段；接收方看不到 BCC 名单，也看不到他人的未发草稿。审批先按请求参与者/owner 和当前成员权限过滤，再检索 title、description、payload；日程按当前成员权限筛选标题、说明和地点。

各域结果受原列表扫描边界约束：邮箱最多 100 个命中，审批最多 200，日程最多 500，再受全局 200 上限约束；达到边界时 truncated=true。搜索摘要不替代完整文档或批准动作，调用者继续使用结果 ID 通过相应原生 API 读取和操作。UI、MCP、A2A 可以共用此原生搜索接口，保持相同 ACL。

## 7. 验证与边界

新增回归覆盖：内建模块/能力对 human 和 agent 完全一致，个人开关隔离及重启，旧版本冲突，开关不能获得私有房间权限，管理员才能登记扩展，外设始终不可执行，schema 类型/枚举/凭据字段校验，通讯录双向独立、删除不影响成员资格，25 人真实 @全员以及已移除成员拒绝。

与账号/考勤及 HTTP 协议一起运行时专测 **30/30 通过**；随后加入个人事件重启回放和全域搜索，插件/搜索专测 **6/6 通过**，包含 205 个命中截断至 200、私密审批隔离、BCC 隔离、深正文命中片段、移出会话后范围变化。此后包含 A2A 的完整 `npm test` **87/87 通过**，最终提交时结果以发布记录为准。现有持久化仍是单进程 JSON，不声称已提供动态插件沙箱、外部网络适配器运行平台或应用商店审核系统。
