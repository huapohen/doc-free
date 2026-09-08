# 全天与重复日历：共同文档发布回执

记录时间：`2026-09-08T21:49:55+08:00`。分支：`equal_rights`。

本阶段正文：[全天与重复日历阶段验收](PHASE4_CALENDAR_RECURRENCE_DELIVERY_2147.md)。两个仓库保存同一份 Markdown。

| 仓库 | 实现 commit | 提交时间 | 描述 |
| --- | --- | --- | --- |
| Active Agent | `80db77eb9badd29c1e8eef527ae1e082c5de58c1` | `2026-09-08T21:43:08+08:00` | `feat(office): add native all-day and recurring calendar workflows` |
| Doc Free | `a1b21dccd4b7f35851fec826e841e4de31be4814` | `2026-09-08T21:26:11+08:00` | `feat(calendar): add all-day recurring events and native occurrence protocol` |

## 发布与可读性

共同文档：`5ddcd4f4`，版本 **r1**。标题：**全天与重复日历阶段验收 · 80db77e · 2026-09-08 21:43**。

目标是已有“人机共创公司 · 全员协作”会话 `room-653437e5-042e-43d0-aa99-0e7b744e6e00`。只创建这一份新文档，没有发送聊天消息、修改成员或登录会话，也没有覆盖旧文档。

发布器完成 **118/118** 检查。Human、企业管理员、普通员工和企业 Agent 读取的 id、title、revision、全文与哈希一致；不在群中的 Agent 读取返回 403 not_a_member；跨会话读取返回 403 document_scope。

此前 **17 份历史文档**（包括 `e78eb7f5`、`67bca2fd`）的标题、版本、内容哈希全部保持不变；群内文档因此由 17 份增加到 18 份。发布前完整可见消息 ID 分页、成员 kind/role/mode、五种身份已有登录会话的安全元数据都先持久化，发布后逐项相等。这比仅比较计数提供更完整的依据，但仍只覆盖当前 API 可见的授权范围。

## 原文与回执完整性

- 源 Markdown SHA-256：`263b420fcfc9c7bc10985a012d773603d3f595ca32c7888f050c5e9ffbef8dff`。
- 服务端正文 SHA-256：`6341a59edad8094046fe35cd665318acb25e9c27d6adaec4f7f4c94236ee4cc7`。
- 规范化：只移除恰好一个末尾 LF，没有其他内容差异；源文件发布后逐字节不变。
- 原始 JSON 回执：`output/phase4-calendar-recurrence-document-20260908.json`。
- 原始回执文件 SHA-256：`fcbd4dbf943639ad2f8de6b2149f65600fab0d685c4de0972fa50901cfee9427`。
- 独立发布器：`output/phase4-calendar-recurrence-document-20260908.py`；仅一次 POST，完整快照 fsync 后才请求；不确定结果只允许 GET 恢复。本次正常返回，没有重复创建。

原始回执包含本机授权检查快照，仅保留在被忽略的 output 内，不把凭据或私有会话清单提交公共仓库。发布器经过另一子任务独立只读审查；提交前扫描正文不含本机凭据。

## 原生与运行状态

Mac 已实际打开这份共同文档，标题、共同版本 r1 和两仓实现 SHA 可见：`output/phase4-calendar-native-20260908/renji-desktop-phase4-document-published.png`。没有点击“保存共同文档”造成额外修订。两端应用沿用已登录开发会话；最后热更新后的运行日志没有新增异常／溢出标题。

独立取消复验最后回读 **18/18**：仅 `Phase4 Cancel Recheck` 的指定实例取消，其系列保留为 r2；原两个验收系列仍为 r4/r1，三身份一致，群成员和消息不变。即时 AX 为“正在取消日程…”，随后正常返回日历，原来的短暂不可用提示已不再出现。

本阶段停止继续开发，等待用户验收。全量飞书像素复刻、其它平台本轮构建、系统级物理键盘双写根因等仍按正文未完成项保留，不以阶段交付替代全部完成。
