# 原生合并转发、共享快照与消息素材导出

- 记录时间：2026-09-07T08:42:33+08:00（Asia/Shanghai）。
- 本机 HTTP 实测补记：2026-09-07T08:49:32+08:00。
- 分支：`equal_rights`。
- 核验基线 commit：`0edcfb20afe3349f6592b7021a65ad29b46bf4ad`。
- 前一实现 commit：`f6de1e1`，独立置顶与加急工作流。
- 本文描述基线之后的未提交实现；合并转发最终实现 commit 以随后交付记录为准，不能将基线 commit 当作本功能已提交的证明。
- 范围：doc_free 的消息合并转发、附件复制、HTTP/MCP/A2A 权限、任务与文档素材。本文不证明客户端视觉一致性或五端构建结果。

## 行为

人或 Agent 选中同一会话中的 1–50 条消息，选择 1–20 个有发送权限的目标会话后，每个目标收到一张真正的 `message.kind = forward_bundle` 卡片。不是把所有内容拼成一条普通文字，也不是用逐条转发冒充合并转发。

服务器在同一次 IM 串行事务中检查所有来源版本、隐藏与撤回状态、禁止转发来源链、目标成员身份、附言提及和所有目标附件配额。任一条件失败，整个批次都不创建卡片、附件记录或事件。所有副本与批次回执一起持久化；存储失败时服务拒绝继续读写，重启后不会出现仅部分目标成功的记录。

来源按原消息序号排列，目标按 ID 排序。同一 `client_id` 对应同一个已确认意图，调换选择顺序不会重新发送。附言可以为空，最多 12000 字符；附言中的原生提及必须是全部目标的当前成员，支持提及人和 Agent。

## HTTP 与 MCP

以下路径均以 `/api/im` 为前缀，并使用当前身份的认证请求头。没有 URL 凭据。

| 操作 | HTTP | MCP |
| --- | --- | --- |
| 原子合并转发 | `POST /rooms/:rid/messages/forward-bundle` | `im_forward_bundle` |
| 展开一张已分享的卡片 | `GET /rooms/:rid/messages/:mid/forward-bundle` | `im_read_forward_bundle` |
| 按本人批次 ID 恢复回执 | `GET /rooms/:rid/messages/forward-bundle-receipts?client_id=...` | `im_forward_bundle_receipts` |

创建请求只接受 `client_id`、`message_ids`、`base_revisions`、`target_room_ids`、可选 `comment` 和 `mentions`。`base_revisions` 必须精确覆盖所选来源，每项为正整数；客户端不能上传伪造来源快照。普通发送接口拒绝自行指定 `kind` 或 `forward_bundle`。

创建结果为 `{bundle, deliveries, duplicate}`，其中 `bundle` 包含 `id/title/message_count/created_by/created_at`，每项 `deliveries` 包含目标 `room_id` 与该目标真实创建的 `message`。消息内 `forward_bundle` 提供摘要、前三条预览和准确的 `detail_path`。

回执结果为 `{receipts, truncated:false}`，每项包含 `client_id/bundle/deliveries/created_at`。只能恢复本人在该来源会话创建的批次，且要求当前仍有来源及全部目标会话权限。其他身份使用相同 `client_id` 得到自己的记录或空数组。

提交响应不确定时，客户端保留原 `client_id`，先查回执。来源编辑或撤回后，重复 POST 会再次进行来源检查，可能返回 `conflict` 或 `message_retracted`；此时历史只读回执仍能恢复已成功批次，不能换一个新 `client_id` 自动重发。若当前权限已撤销，回执也明确拒绝，不能把授权失败当成此前未成功。

## 共享快照与附件

展开结果为 `{bundle, message_id, room_id}`。`bundle.snapshot_policy` 为 `shared_copy`，`items` 包含所分享的精确文本、原始消息 ID、版本、时间、作者身份和附件。未选消息、源会话的私人标记、隐藏偏好、其他目标交付列表均不进入共享快照。

当前目标成员可展开自己收到的共享副本，不要求加入原会话。原消息后续编辑或撤回不会修改已经分享的内容；但作者后来打开禁止转发，会沿原消息、普通转发和嵌套合并链阻止新的转发与关联附件复用。已有共享副本的阅读权限仍依据接收会话和卡片可见性。

每个目标获得新的附件 ID 与目标会话下载路径。附件内容使用已经存在的共享内容寻址数据，不要求接收者读取源房间路径。嵌套合并中的附件路径也逐层转换到最终目标。下载继续进行当前身份、会话、文件状态检查。

卡片隐藏后不能继续展开；卡片撤回后列表和单消息响应不再暴露展开描述。失去目标成员身份后，直接 GET、MCP 和已缓存 A2A 展开回执都拒绝访问。阅读卡片不自动写入来源消息的已读位置。

普通 `im_forward_message` 转发合并卡片时保留真实卡片类型和嵌套内容。上限为 3 层、展开后 200 个条目、1 MiB 来源快照、单批 400 个去重附件；仍受每会话 200 个附件/200 MiB、实例 5000 个附件/1 GiB 原有配额约束。超过上限时整个批次拒绝。

## 创建任务与导出文档

`im_messages_create_task` 和 `im_messages_export_document` 已适配合并卡片。服务器在原有来源验证事务中展开目标已经收到的共享快照，将所有嵌套正文、作者、消息版本、时间和目标附件路径写入任务描述或新文档；不会只写空附言后报告成功。

来源正文中的 Markdown 代码围栏被安全包裹，不能破坏生成的来源结构。目标成员不需要原会话权限。源消息后来编辑时，素材仍使用之前分享的版本。

任务描述 12000 字符、文档正文 200000 字符限制作用于完整展开后的最终正文。超限返回 `source_content_too_large`，在任何任务或文档创建之前拒绝，不静默截断，不创建空资源。文档创建仍保留既有的 pending/幂等机制。

## 已完成核验

| 证据 | 结果与范围 |
| --- | --- |
| `node --test tests/native-message-forward-bundle.test.js tests/native-message-materialize.test.js` | 16/16 通过，日志 `/tmp/renji-bundle-materialize-targeted.log` |
| `npm test` | 324/324 通过，日志 `/tmp/renji-bundle-backend-final-0842.log` |
| `git diff --check` | 通过 |

专项覆盖了 Human/Agent 同权创建与 MCP 读写、未选内容不泄漏、整个批次预检失败无写入、幂等与历史回执、目标独立附件下载、多目标配额失败、嵌套来源保护、3 层深度和数量上限、隐藏/撤回/退出后的直接和缓存 A2A 权限、存储失败重启、递归任务/文档正文以及超限无资源写入。

完整测试包含隔离 HTTP/CRDT 进程的既有系统回归，但这组专项主要直接调用 IM 和 MCP/A2A 处理器。其后另行完成以下 3218 实例验证，不把两种证据混为一谈。

## 3218 实例实际 HTTP 验证

原 `dev_office` 父进程及其 3218 listener 经确认后退出，使用同一 `python3 scripts/dev_office.py --doc-free ../doc_free --no-worker` 命令载入最终实现。新服务 `/health` 返回 200；3217 未触及。日志为 `/tmp/renji-office-dev-bundle-0850.log`。

`active_agent/output/message-bundle-live-20260907.py` 使用真实 3218 HTTP、MCP、A2A 路由完成 **121/121** 检查，其中 73 个 HTTP 响应检查、48 个内容或行为断言。证据为 `active_agent/output/message-bundle-live-20260907.json`。测试没有调用模型，没有真实飞书写入，也没有改动已有公司成员的权限。

首次准备阶段测试脚本误用不存在的 `/members/:pid` PATCH 来暂停 Agent，收到 404。核对现有合同后修正为 `/participation`，保留原始失败记录在 `prior_attempts`，复用已经创建的四位合成参与者和空来源房间；没有重复注册或隐藏首次结果。最终 121 项全部通过。

创建的三个独立测试房间均加入现有 `huapohen` 供客户端查看：

| 房间名 | ID |
| --- | --- |
| 合并转发实测 · 来源 · 09-07 08:48 | `room-2cf0c4f3-5871-4517-b5a2-c7709bff26b8` |
| 合并转发实测 · 收件 · 09-07 08:48 | `room-3ff1b2df-5400-41be-bf23-1021e6e14d99` |
| 合并转发实测 · 嵌套 · 09-07 08:48 | `room-7d4efc1f-0920-4bfb-a949-ad32c3d27d6c` |

可查看的收件卡片为 `msg-46971d25-5b0e-4127-86d8-01caf06d1643`，嵌套卡片为 `msg-5b9b72a2-1cc6-40c9-8ce9-28d9fc5e05ec`。嵌套房间的实际文档 `31eba07b` 和任务 `task-f7e10d8c-eff2-453e-9c16-f0c2c5e579bc` 均包含两条来源消息完整正文、版本与最终目标附件路径。

实际覆盖 Human 批次、Agent MCP 批次、仅有目标权限的人和 Agent 阅读/嵌套转发、共享附件下载、调换目标和来源顺序后的同一回执、源编辑后的旧版本恢复、原子预检无部分目标卡片、隐藏/恢复和撤回后的 A2A 缓存权限、退出后的直接与缓存访问拒绝、来源链禁止转发及附件复用保护。最后恢复了测试来源的可转发状态和测试阅读成员，供后续 UI 验证。新建的两位 Agent 在所属测试房间保持暂停参与。

## 仍需后续核验与补全

- 桌面、移动端实际选择目标、附言 @、卡片展开、复制和往返导航的视觉及交互验收。
- 整个会话的旧 Markdown 导出与模型自动上下文，目前不能据此宣称已经递归纳入每张合并卡片全部正文；原生展开接口已具备。
- 客户端真实账号切换和未知提交恢复；上述本机原生接口恢复通过不等于客户端交互已经验收。
- 全量飞书复刻、其他消息菜单能力、全部管理页面、五平台签名与发布均不属于本文完成结论。

本记录是新增文档，不覆盖 2026-09-06 已发布的任何交付文档。


## 最终实现提交索引

| 仓库 | 最终实现 commit | 实际 Git 时间 | 描述 |
| --- | --- | --- | --- |
| Active Agent | `7570ac2d81b119f14280fc4bf9866151b57e1059` | `2026-09-07T10:27:19+08:00` | `feat(office): align native composers and share rich conversation records` |
| Doc Free | `c34de6ac2e3ec67c7f10f3ef6e2090438d2598a0` | `2026-09-07T10:18:02+08:00` | `feat(im): preserve rich text across native actions and merged forwards` |

本文件中的早期专项或草稿状态按其记录时间保留。最终验证、原生实点与发布范围统一见 `COMPOSER_RICH_TEXT_MERGED_DELIVERY_1027.md`；本批最后Flutter全量为636/636，静态分析无问题。
