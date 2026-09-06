# 独立会话顶栏与原生站内加急 · 2026-09-06 23:02

- 记录时间：2026-09-06T23:02:07+08:00。
- 分支：`equal_rights`。
- 实现基线 commit：`4dcbf7e47acf0f9eca91c3df5e507e84ca6d4e5f`。
- 基线 commit 时间：2026-09-06T22:35:53+08:00。
- 基线描述：`feat(im): add personal message actions and atomic source workflows`。
- 本文记录基线之后的后端工作树增量。最终提交 hash、客户端构建和运行验收由根协作智能体写入交付记录；本文不把未提交代码表述为已提交交付。
- 参考边界：23:02 首次记录时，本后端子任务尚未操作飞书；随后追加桌面端只读实测，见文末 23:11 补充。单槽顶栏、当前成员均可管理、仅作者可发加急是本批明确落地的产品规则，尚未通过真实飞书逐项验证，不能据此宣称飞书对应 UI 和权限已完整复刻。

## Pin 集合与会话顶栏分离

既有 `POST /api/im/rooms/:rid/messages/:mid/pin` 与 `GET /api/im/rooms/:rid/pins` 继续管理多个 Pin 收藏项。新增顶栏使用独立的 `room.message_highlights`，不复用消息的 `pinned` 字段。Pin 不会自动替换顶栏，清除顶栏也不会删除 Pin。

| API | 行为 |
|---|---|
| `GET /api/im/rooms/:rid/highlights` | 读取当前顶栏与本人收起状态 |
| `PATCH /api/im/rooms/:rid/highlights` | 按顶栏及来源版本设置、替换或取消 |
| `PATCH /api/im/rooms/:rid/highlights/preferences` | 收起或展开本人看到的当前版本 |

读取响应是未包裹的快照：

```json
{
  "revision": 2,
  "items": [{
    "message_id": "msg-example",
    "message_revision": 3,
    "set_by": "principal-example",
    "set_at": "2026-09-06T15:00:00.000Z",
    "message": {"id": "msg-example", "revision": 3, "content": "当前可见正文"},
    "source_status": "current"
  }],
  "collapsed": false,
  "collapsed_revision": null,
  "max_items": 1,
  "permissions": {"can_set": true, "can_clear": true, "basis": "current_room_member"}
}
```

示例中的消息仅列出解释所需字段，真实 `message` 使用当前消息视图合同。客户端遍历 `items`；本批 `max_items` 为 1，保留以后扩展多项的响应形状。

设置/替换需提供 `{"base_revision":1,"message_id":"msg-...","message_revision":3}`；取消需提供 `{"base_revision":2,"message_id":null}`。两个人同时设置时，后到请求的顶栏版本不匹配返回 `409 conflict`，不能静默覆盖。来源消息版本同样检查；缺失版本返回 `422 version_required`。当前版本上的相同显式意图不写磁盘、不重复发布事件。

收起请求为 `{"base_revision":2,"collapsed":true}`。这里 `base_revision` 是共享顶栏版本，个人偏好只保存本人收起的版本。其他成员的展开状态不变；换成新版顶栏后自动重新展开。此操作不推进 read cursor，不制造已读。

任何当前会话成员都可按相同规则管理顶栏，包括 Human 与 Agent。个人隐藏的来源不返回顶栏 `items`，也不改变其他人的顶栏。来源编辑后返回最新视图及 `source_status:"updated"`，原捕获版本仍保留。撤回后返回无正文、无修订历史的 tombstone 和 `source_status:"retracted"`，可以取消顶栏。

会话详情与 Markdown 导出增加当前阅者可见的 `highlights`。公共更新事件为 `message.highlight.updated`；个人收起事件为 `message.highlight.preferences.updated`，仅本人可见。

## 站内加急与独立确认

```http
POST /api/im/rooms/:rid/messages/:mid/urgencies
```

```json
{
  "client_id": "stable-intent-id",
  "base_revision": 3,
  "recipient_ids": ["principal-human", "principal-agent"],
  "channel": "in_app"
}
```

- 仅当前来源作者可发起，本批不实现代发。
- 接收者必须是其他实际当前成员，支持 Human 和 Agent，1–100 位且不重复；停用、撤销或非成员身份不能被伪装成有效目标。
- 仅实现显式 `in_app`。短信、电话、缺失渠道等返回 `422 unsupported_channel`，没有伪称已发送短信、拨打电话或完成系统推送。
- 来源必须存在于当前会话、对发送者可见、未撤回且版本一致。
- `client_id` 绑定发起者、房间、来源版本、排序后的实际目标集与渠道。相同意图返回原记录与 `duplicate:true`；变更意图返回 `409 idempotency_conflict`。源状态与成员授权仍在幂等读取前检查。
- 当前本地存储每会话最多 1000 条加急记录，达到上限会明确拒绝。

| API | 行为 |
|---|---|
| `GET /api/im/rooms/:rid/urgencies` | 本人发起或本人被指定的清单 |
| `GET /api/im/rooms/:rid/urgencies/:uid` | 当前授权的请求详情 |
| `POST /api/im/rooms/:rid/urgencies/:uid/ack` | 本人显式确认，body 为 `{}` |

清单支持 `box=all|inbox|sent`、`status=all|pending`、`limit`（默认 50，上限 200）与 `before` seq，返回 `{items,has_more,next_before}`，从新到旧分页。创建路径本身不提供 GET；应使用房间清单或详情接口。

详情与创建响应中的 `urgency` 包含 `id`、`seq`、`room_id`、`message_id`、捕获的 `message_revision`、`created_by`、`created_at`、`revision`、`channel`、`status`、`source_status`、当前 `message`、`recipients`、`counts`、`summary_scope` 和 `can_ack`。

每个接收者记录包含 `principal_id`、快照姓名和种类、`acknowledged_at`、`current_member`、`same_membership`、`status`。发送者能看到全部已选目标的明细与统计；接收者只看到自己的明细和总数为 1 的统计，不能借此枚举其他目标。

`source_status` 为 `current|changed|retracted|missing|hidden`。整体 `status` 为 `pending|acknowledged|unavailable|sender_unavailable|source_changed|source_retracted|source_missing|source_hidden`。来源不存在时 `message:null`；隐藏/撤回时是保留 ID、清空正文的安全视图。客户端必须依据服务端 `can_ack` 控制确认，不可只凭 `source_status` 推断。

读消息不会确认加急，确认加急也不会推进已读。本人确认以持久时间为证据，重试返回 `duplicate:true`。不能在 body 中传别人的身份来替别人确认，发送者和旁观者也不能确认目标的请求。已完成的确认不会因后续来源编辑或撤回而消失；新的确认必须仍满足当前来源与成员条件。

## 成员周期、个人隐藏与隐私

请求记录捕获创建者和每个目标的成员周期：优先使用 `joined_seq`，旧数据使用 `joined_at`。退出后重新加入不是原来的分配：旧请求不会重新交给同一 ID，不继承旧确认，旧事件与缓存 A2A 回执也重新校验周期。

目标退出后，发送者看到 `unavailable`；曾确认过的事实保留。创建者退出、被停用或换成员周期后，尚待确认的请求显示 `sender_unavailable`。来源发生编辑或撤回，旧的待确认意图失效，应由作者检查后重新发起。

目标本人隐藏来源时，看不到加急通知，详情为 `source_hidden` 且不能确认；恢复同一有效来源后可确认。发送者看不到对方的私人隐藏偏好：其接收者列表不会以隐藏状态泄露目标的个人操作。

`message.urgency.created` 为私有事件，只有发送者与指定目标可见；事件记录仅带来源 ID、加急 ID 与版本，不快照正文。`message.urgency.acknowledged` 仅发送者与本次确认者可见。分页事件输出会把 `audience_ids` 收敛为当前身份。

加急触发的 Agent 运行同样属于私有范围：仅发送者与这个运行的执行者可看，不向其他被选目标或旁观者暴露对应关系。检查覆盖会话 `runs`、直接 turn 读取、plan/operation 路径、`turn.*` 事件、Markdown 运行上下文导出和 A2A 旧回执读取。本人隐藏来源后，私有运行访问也被拒绝。

运行的传播 `root_id` 使用独立散列，不把加急 ID 或目标 ID 拼进共享消息。Agent 如果明确产出群内回复、共享任务或文档，这些正常共享成果仍按会话权限可见；没有把“工作起因私有”错误地等同于“成果不可共享”。

## Agent 原生主动触发

指定的 Agent 能把站内加急作为原生主动触发，不依赖鼠标、输入框或虚构人类登录。`mentions` 模式支持显式指定加急；`paused` 模式不领取。

每个请求、每个目标有独立且有界的运行 root。多条尚待处理的加急不会因共享事件 cursor 推进而跳过：先处理较新的，再处理未处理的旧请求；同一 root 已处理后不会因为用户尚未确认而无限启动。

捕获上下文优先纳入实际被加急的当前来源，哪怕它已超出最近 40 条消息，随后在既有数量和字符预算内加入近期上下文。合成测试验证来源确实进入上下文；本批没有调用真实大模型，也不把测试执行器标成模型执行成功。

领取、读清单、结束 silent/reply 运行都不会自动确认加急。确认是另一个明确的原生动作。

## MCP 与集成改动

新增原生工具：`im_highlights`、`im_set_highlight`、`im_collapse_highlight`、`im_urge_message`、`im_urgencies`、`im_read_urgency`、`im_acknowledge_urgency`。REST、MCP、A2A 使用同一身份、会话授权与企业 IM 应用策略。

本子任务同时按其他协作者的集成需求完成两个窄接口改动：

- `office_update_settings` schema 增加 `desktop_nav_collapsed:boolean` 与个人桌面导航可收起说明。设置存储、默认值与 Flutter 导航由根协作者实现。
- `createNativeIM` 新增受信构造参数 `accountPasswordPolicy` 并传给 `createAccounts.passwordPolicy`，不接受请求 body 覆盖。密码策略、环境配置及本地启动器由账号协作者实现。

## 持久化与验证

顶栏、个人收起、加急目标、确认时间和幂等键使用既有原生 IM 同一存储提交。持久化失败后服务停止接受读写；重启恢复最后成功状态，不把内存中的确认误报为已持久化。损坏的顶栏偏好、非法加急记录形状与失效幂等引用在初始化时拒绝加载。

新增文件：

- `native-message-highlights.js`
- `native-message-urgency.js`
- `tests/native-message-highlights.test.js`
- `tests/native-message-urgency.test.js`

集成文件：`native-im.js`、`native-im-mcp.js`。本文没有修改 Flutter、账号实现或设置存储。

验证记录：

- `node --test tests/native-message-highlights.test.js tests/native-message-urgency.test.js`：最终 18/18 通过，包含多请求逐个领取回归。日志 `/tmp/message-attention-tests.log`。
- `npm test`：22:59 时点完整后端 305/305 通过。该次全套在最后一项多请求回归及账号/桌面导航并行增量之前；最终集成全套需由根协作者再次运行，不能把旧总数充当最终代码验证。日志 `/tmp/message-attention-full-suite.log`。
- `git diff --check`：通过。
- 23:02 首次收尾时未重启用户服务、未操作飞书真实会话、未调用生产模型、未提交或推送本批工作树；后续只读参考实测另列如下。

本批只实现上述真实后端能力，不包含短信电话供应商接入、操作系统推送、取消加急、全量翻译、合并转发或快捷应用，也未证明生产部署、客户端最终布局和飞书权限逐项对齐。

## 23:11 补充：真实飞书桌面端只读实测

补充记录时间：2026-09-06T23:11:58+08:00。通过 CUA 操作已登录的 `com.electron.lark` 桌面端，从工作台进入消息及既有“探索研究院”群。只针对本人旧文本打开菜单和配置，没有发送消息、加急、回应、选择目标提交或修改置顶；完成后取消所有弹窗与多选，恢复普通群聊。没有操作“人机”应用和手机镜像，没有保存原始聊天 AX 或截图文件。

**加急实测页面：**

- 对本人旧文本右击后，点击“加急”确实先打开配置页。
- 页面包含“搜索”、成员复选框、“全选未读成员”复选框和“已选：0 人”。
- “发送方式”有“仅应用内”（默认选中）、“应用+短信”、“应用+电话”。
- 页脚为“取消”和禁用的“加急 发送 (⌘+Enter)”。没有选人或发送，点击取消关闭。
- 与本批协议的真实差异：后端仅实现 `in_app`；真实目标支持 Human/Agent，但没有电话、短信渠道。我们已经有读取未读快照的独立能力，加急模块本身不提供“全选未读成员”的特殊后端命令；客户端若加此交互，应以可见未读快照生成具体 `recipient_ids`，提交仍按当前成员验证。实测没有证明飞书的加急权限、确认规则或成员周期与我们的规则相同。

**Pin / 置顶实测页面：**

- 右键菜单中“Pin”和“置顶消息”确实是两个独立条目，与本批分离的资源方向一致。
- 当前文本的“置顶消息”行没有可辨认的右侧展开箭头，也没有 AX secondary expand 动作；同一菜单中“表情回复”有明确箭头可对照。
- 因不能确认点击置顶是否直接改群状态，本次没有点击该行，未获得二级设置页。不能把这次观察写成置顶槽数量、权限、收起方式已核实。

**多选 → 合并转发实测页面：**

- 点击右键“多选”后，消息区出现复选框，原消息已勾选，上方有“选择以下消息”，底部有“合并转发”、更多和关闭多选按钮。
- 点底部合并转发图标打开目标选择页，包含“创建群组并转发”、“搜索”、“最近对话”、“切换多选”和“留言（可@成员）”。
- 页脚为“取消”和未选目标时禁用的“发送 (⌘+Enter)”。已取消目标页并关闭多选，未执行任何转发。
- 与本批协议的真实差异：本批尚未实现合并转发的复合消息对象、多目标选择、创建群再转发和带 @ 的附言；不能把现有逐条原生转发或导出文档当成已具备这些能力。

**客户端兼容能力提示：**

根协作者要求新增会话详情 `native_features:{message_highlights:true,message_urgencies:true}`，供新客户端决定是否加载该服务的顶栏/加急入口。字段只随当前会话成员可读的 GET 返回，不代替实际动作鉴权。已追加 Human/Agent 成员可见和非成员拒绝检查；本补充后的定向测试仍为 18/18 通过。

**幂等恢复限制：**

UI 协作者指出的结果不明恢复场景已确认：首个加急创建实际提交后丢失响应，重试之前如果来源或成员发生变化，当前实现可能先返回 `409/422`，不直接返回旧 `client_id` 记录。客户端必须停止自动重建，重新核对来源与本人已发送清单。后续若增加按 `client_id` 读取回执，需要保持原意图和当前成员周期授权；本批不通过优先返回旧结果绕过这些校验。

## 23:44 最终实现提交与验证补记

补记时间：2026-09-06T23:44:25+08:00。本节追加最终事实，前文的基线、未提交阶段与各次测试数字保留为当时记录，不用最终结果覆盖过程证据。

| 仓库 | 最终实现 commit | Commit 时间 | 描述 |
|---|---|---|---|
| `doc_free` | `f6de1e1122493eb156b105db796a3d5e3a0c7cf8` | 2026-09-06T23:43:40+08:00 | `feat(im): add independent highlights and private urgency workflows` |
| `active_agent` | `cd34da4d28be4e92111b201b96a96caa0e6aedcc` | 2026-09-06T23:43:40+08:00 | `feat(office): add personal sidebar collapse and native message attention` |

以上 hash、时间和描述均已通过本地 `git show` 核对。本节记录的是实现提交，不将尚待统一提交的文档补记或远程推送状态混入实现事实。

### 最后补齐的私有运行投影

在 282 项真实接口验证后进行独立审查，发现此前的“只有发送者与该 Agent 可查看加急运行”仍不足以保证个人偏好隔离：捕获的触发消息带有执行者的 `personal_preferences`，捕获的会话视图还有 `message_grouping`、标记数量与个人会话偏好；本人隐藏消息触发的取消原因也会原样出现在发送者可读的运行结果中。

最终修补位于 `native-im.js`，并追加到 `tests/native-message-urgency.test.js`：

- 对非执行者读取的运行视图，删除触发消息、上下文消息和末条消息中的个人偏好，以及捕获会话中的个人分组、收藏、免打扰、折叠、已读游标和通知计数等字段。
- 对非执行者读取的所有取消运行，使用通用原因“本次运行已取消，请由执行者检查当前上下文后继续。”，不披露具体的个人隐藏行为。适用于直接运行读取、会话运行摘要和导出。
- 执行者本人的原始输入、标记状态、取消原因与原始上下文 hash 保留；投影只作用于返回副本，不重写持久化审计。其他阅者的返回值带 `private_context_omitted:true`。
- 投影前仍先检查加急和当前来源访问权限。发送者本人隐藏来源后，不能借投影继续读取该私有运行；执行者隐藏来源期间也不能通过旧运行绕过来源检查。
- 对旧 A2A 运行回执和 Markdown 导出，若包含不属于当前阅者的执行者个人字段或具体取消原因，则返回 `403 receipt_scope_revoked`，要求重新取得当前可见结果。Markdown 只解析末尾由服务生成的运行审计区，不把前文消息或文档中用户引用的 JSON 当成新的授权对象。

### 最终测试结果

| 验证 | 结果 | 本机证据 |
|---|---|---|
| 顶栏/加急专项，包含最后两项隐私投影与旧回执回归 | **20/20 通过** | `/tmp/message-attention-privacy-tests.log` |
| 最终完整后端 `npm test` | **314/314 通过** | `/tmp/message-attention-privacy-full-suite.log` |
| 独立 Pin/顶栏、加急、未读目标和导航折叠真实 HTTP/MCP | **282/282 通过** | `active_agent/output/attention-collapse-live.json` |
| 最终重启后的私有运行投影真实 HTTP/MCP/A2A | **58/58 通过** | `active_agent/output/attention-private-projection-live.json` |
| JavaScript 语法与 `git diff --check` | 通过 | 实现收尾检查 |

282 项验证在 2026-09-06T23:21:45+08:00 至 23:21:47+08:00 执行。只新建两个专有合成会话，分别由 Human 和 Agent 担任群主，各 3 条测试消息与 3 个加急。覆盖独立 Pin/顶栏、本人收起与新版本重现、顶栏 CAS、加急目标隔离与幂等、确认和已读相互独立、非成员拒绝、基于真实收件快照的未读目标筛选、MCP 目录和 Human/Agent 个人桌面折叠 CAS。双方 `desktop_nav_collapsed` 均恢复原 `false`，其他设置值保持不变；恢复后的个人设置 revision 分别为 Human 15、Agent 11。Agent 保持暂停，无模型调用。

58 项验证在最终后端重启后于 2026-09-06T23:38:12+08:00 完成，沿用既有 Human 群主的合成会话与现有待处理加急，没有新增会话或发送普通消息。仅短暂切换 Agent 为 `mentions`，通过 `synthetic-private-projection-test` 标签领取合成运行，不调用模型；随后以本人隐藏来源触发取消，再恢复原个人状态并确保 Agent 为 `paused`。Human 和 Agent 的来源 `marked`、`hidden` 均恢复原 `false`。

该轮实测确认发送者 HTTP/MCP 视图和新缓存回执不含执行者个人偏好；发送者看到通用取消原因，执行者恢复来源可见后仍能看到自己的原始取消原因和输入；旁观者与本人隐藏来源均受访问限制。真实 A2A 回执在来源后来隐藏时被拒绝重放。对“升级前已经缓存的原始私有回执”的迁移拒绝，由 20 项专项中的独立回归验证；没有为制造此场景而篡改在线 A2A 存储。

两份忽略目录中的真实验证证据分别保留，没有用第二轮覆盖第一轮：

```text
attention-collapse-live.json
SHA-256: f1d5f0625693f5bc98553636e06b7c8e4044a185ce48c0c51bc182b6fc187efa

attention-private-projection-live.json
SHA-256: 35730a639d2f0feebaa279d3dc118a780ed467ad4289772349880e766fc09cbe
```

真实验证脚本、证据均位于 Git 忽略的 `active_agent/output`，不保存完整凭据；执行前检查同名证据是否存在，避免盲目重复测试。上述验证不覆盖真实模型输出质量、生产通知供应商或全部飞书界面及权限，前文已列出的未实现项和幂等恢复限制仍然成立。
