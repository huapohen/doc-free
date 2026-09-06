# 原生办公深度搜索：服务端过滤验收

- 时间：2026-09-06T15:28:36+08:00。
- 分支：`equal_rights`。
- Doc Free 基线 commit：`862609f45d7d4e61c1b2a9c4d33fe527fd31b5e1`，2026-09-06T12:49:59+08:00。
- 状态：本基线之后的工作区实现。最终交付 commit 由本批次总交付记录关联；本文区别于既有统一搜索和UI验收文档。

## 实际变化

`GET /api/im/search` 与 MCP/A2A `im_search` 接受 `q/type/room_id/author_id/after/before`。作者、会话、日期和类型在服务端内容扫描预算及200条结果上限之前生效。前端筛选已返回的200条无法提供这一语义，因此查询直接传给服务端。

type可为all、message、task、document、person、agent、store、mail、approval、calendar。after包含边界、before不包含边界；均需带时区的ISO时间，错误日期、无时区日期、反向区间、未知类型拒绝。指定会话需当前成员资格；其它域依旧经过其应用策略和私有业务权限。

| 域 | author_id | at / time_basis |
| --- | --- | --- |
| message | 原发送者 | 原发送时间 / sent_at，编辑不改变发送时间 |
| task | 创建者 | created_at |
| document | 当前canonical版本的可验证最后作者；未知为null | canonical updated_at，内容时间 |
| mail | 发件人 | 草稿最初created_at，不是已读或移文件夹时间 |
| approval | 申请创建者 | created_at |
| calendar | 日程创建者 | created_at，不是日程开始时间 |
| person / agent / store | null | null，不捏造内容作者或时间 |

文档snapshot没有可靠作者时，只接受当前revision和content_hash同时匹配的document.created/updated事实事件。协作来源为collaborator或版本已经改变时返回null，不沿用旧作者。目录与商店不匹配作者/日期条件；工作空间内部邮件没有会话绑定，不匹配room_id条件。

返回`filters`、`time_bounds=after_inclusive_before_exclusive`、`supported_types`、`truncated`和结果。每条结果含真实`author_id/at/time_basis`，可为空。最多200条，扫描预算消息10000、任务/邮件/审批/日历各2000、文档100、目录两种各5000、商店100。达到结果或扫描预算时明确truncated；它不意味着完整全库结果。

当前是单工作空间内有界扫描，没有全文索引或分页承诺。带文档作者/日期条件时必须读取canonical snapshot确定实际元数据；元数据读取不算不匹配文档的正文检索预算，但仍有I/O成本。未来大规模部署需要在同一权限语义下增加可重建索引和游标。

## 复用权限与验证

- mailbox内部授权候选迭代器保留每个用户自己的草稿/投递和BCC裁剪，跨域搜索不再取旧mail/search前100条后过滤。
- 审批继续检查申请人、指定审批人、会话owner及当前成员资格，返回匹配项前复用普通读取的到期状态转移。
- 停用应用的聚合结果不包含该域；旧MCP/A2A缓存回执仍要重新验证当前授权。停用或撤销的目录身份不再出现在搜索中。
- 搜索专项5例包括原私有审批/BCC隔离、200结果上限，以及10010条其他作者消息之后仍能精确找到较早目标；任务类型不被消息额度饿死；作者/半开日期边界；canonical新版本不能冒充旧作者；邮件超过旧100条前缀仍能找到真实过滤结果。
- 15:28时点搜索、邮件、应用权限、MCP/A2A批次42/42通过。补充MCP结构化参数真实穿透和审批到期读取一致性后，搜索/MCP/考勤审批专项13/13通过；语法与diff空白检查通过。

这些测试使用临时工作空间和固定业务数据，无模型调用、无外部消息发送。大批量历史数据通过本地fixture注入，目的是验证截断与过滤顺序，不表示已经在生产数据量下做性能测量。
