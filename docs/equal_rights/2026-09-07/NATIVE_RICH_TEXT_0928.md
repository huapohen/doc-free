# 原生消息富文本与标准 Agent worker · 2026-09-07 09:28

- 记录时间：2026-09-07T09:28:41+08:00。
- 分支：两个仓库均为 `equal_rights`。
- doc_free 基线 commit：`0edcfb20afe3349f6592b7021a65ad29b46bf4ad`。
- active_agent 基线 commit：`09fe83f19cdee6d242fd4903d1a76d4c451b491d`。
- 本文记录基线后的未提交富文本实现及实测；最终实现 commit 由随后整批交付补记。

## 原生合同

Human 和 Agent 的 `POST /api/im/rooms/:rid/messages`、`im_send`、A2A `im_send` 接受可选 `rich_text`。普通正文 `content` 始终保留，搜索、无障碍、旧客户端和工具可以继续读取完整文本。

格式为 `{"version":1,"spans":[{"start":0,"end":4,"styles":["bold"]}]}`。样式只允许 `bold`、`italic`、`underline`、`strikethrough`；每条消息最多 200 个范围，每个范围 1–4 个样式。范围使用 UTF-16 单元计数，左闭右开，不允许越界或切开 emoji 代理对。拒绝 HTML、任意额外字段、无效类型和非法范围。

样式顺序固定、重复范围去重、范围排序后进入消息幂等摘要。相同内容、相同 `client_id` 和等价规范形式不会产生重复消息；实际改变格式的同 ID 请求返回幂等冲突。空 spans、null 或未提供字段继续使用旧纯文本消息形状。

编辑接口和 `im_edit_message` 支持相同格式：正文未变化且省略 `rich_text` 时保留原样式，正文变化但未提供新样式时清除旧范围，显式 null 清除样式。历史修订保存原样式；当前撤回或个人隐藏墓碑不返回样式字段。

普通转发、合并转发、嵌套合并和共享快照保留原样式，已经分享的快照不随源消息后续编辑变化。任务／文档来源素材保留完整普通正文与 `rich_text` 来源 metadata；这不等于文档已经把所有源样式排版成与聊天完全相同的视觉效果。

## 标准 Agent 的回复路径

检查发现原先只有主动 `im_send` 路径支持样式，`/turns/:tid/finish` 会忽略 `rich_text`，标准 Python worker 的 `IMAgent.validate()` 也会在构造结果时丢弃它。另外，动作计划 `final_result` 的严格字段白名单会拒绝该字段。

本批同时补齐三个位置：

1. 原生完成接口验证样式、加入最终结果幂等摘要，并传给实际生成的消息。非 `reply` 结果携带非 null 样式时明确拒绝。
2. `native-actions.js` 冻结计划接受同一格式，恢复后保留最终说明样式；服务器追加的动作回执仍为普通正文，原有范围不会扩展到回执文本。
3. `active_agent/im.py` 的标准提示词说明可选富文本格式，validator 使用标准库 `utf-16-le` 和 `surrogatepass` 计算范围，规范化后保留到计划、恢复与 finish。格式无效时生成明确 blocked 结果，不能静默丢弃样式后当作正常完成。

没有传入样式时，Python 旧纯文本结果字段保持不变。明确 null、空范围也不增加字段，因此未改写旧纯文本消息或旧计划的摘要语义。没有新增第三方依赖。

## 核验结果

| 检查 | 结果 |
| --- | --- |
| doc_free 完整 `npm test` | 331/331，`/tmp/renji-rich-text-final-full.log` |
| `native-rich-text` 与 `native-actions` 专项 | 21/21，`/tmp/renji-rich-text-plan-targeted.log` |
| Python IM、动作、fleet、富文本 worker 专项 | 25/25，`/tmp/renji-rich-text-worker-tests.log` |
| JavaScript/Python 规范化对照 | 154/154，`active_agent/output/rich-text-normalizer-parity.json` |
| 本机 3218 HTTP/MCP/A2A 与标准 worker | 42/42，`active_agent/output/rich-text-live-20260907.json` |
| 两仓 `git diff --check` | 通过 |

154 个对照样例包含普通字符、astral emoji、显式高低代理、孤立代理单位、所有邻近范围、布尔与数值类型、整数形式 1.0、空格式等。比较的是两边实际函数输出与拒绝结果，没有用 Python 实现自证 Python 结果。

本机服务经核验 listener 和父进程后按原 `dev_office.py --no-worker` 命令重启，最终进程日志为 `/tmp/renji-office-dev-rich-text-final.log`。3217 未触及。

真实脚本记录 23 个 HTTP 响应检查、19 个内容或行为断言，另由真实 `IMClient` 执行一次标准 worker 的领取与完成流程。worker 使用固定合成结果提供器，没有调用大模型。只临时将新建的合成 Agent 在测试源群设为 mentions，结束后恢复 paused，没有启动持续后台 worker。

## 客户端可查看的新增消息

来源群：`合并转发实测 · 来源 · 09-07 08:48`，`room-2cf0c4f3-5871-4517-b5a2-c7709bff26b8`。

| 发送路径 | 消息 ID |
| --- | --- |
| Human HTTP | `msg-9dcfc941-c4ca-4066-a698-d655ed1696fa` |
| Agent MCP | `msg-706afeed-3232-4ae0-a3b5-05a343198d9e` |
| 标准 IMAgent worker | `msg-b76de29d-e9b5-4c9e-9646-793b078810d7` |

收件群：`合并转发实测 · 收件 · 09-07 08:48`，`room-3ff1b2df-5400-41be-bf23-1021e6e14d99`。

| 消息 | ID |
| --- | --- |
| Human A2A | `msg-5ff69fc9-7404-41d1-b9be-40bb89ade546` |
| 保留格式的普通转发 | `msg-715a8d3c-71ae-41b0-a9e4-10e76e5384e5` |
| Human 与 Agent 富文本合并卡片 | `msg-98e695e5-9fed-4459-9385-d163ef051a27` |

可见样例均为 r1，包含“加粗、斜体、下划线、删除线”和 emoji。现有 `huapohen` 已能读取这两个测试群。只对另外新增的控制消息进行清样式、撤回和个人隐藏／恢复验证，没有修改之前的合并转发证据消息。

本记录证明了原生数据与标准 worker 传递，不证明 macOS、移动端已经按所有样式正确渲染；客户端编辑、显示、原文及截图入口的视觉验收由本轮 UI 集成另行记录。没有将这批功能作为全量飞书复刻完成结论。


## 最终实现提交索引

| 仓库 | 最终实现 commit | 实际 Git 时间 | 描述 |
| --- | --- | --- | --- |
| Active Agent | `7570ac2d81b119f14280fc4bf9866151b57e1059` | `2026-09-07T10:27:19+08:00` | `feat(office): align native composers and share rich conversation records` |
| Doc Free | `c34de6ac2e3ec67c7f10f3ef6e2090438d2598a0` | `2026-09-07T10:18:02+08:00` | `feat(im): preserve rich text across native actions and merged forwards` |

本文件中的早期专项或草稿状态按其记录时间保留。最终验证、原生实点与发布范围统一见 `COMPOSER_RICH_TEXT_MERGED_DELIVERY_1027.md`；本批最后Flutter全量为636/636，静态分析无问题。
