# MCP 参与方式补齐可选版本保护

- 时间：2026-09-06T17:38:00+08:00。
- 分支：equal_rights。
- 基线 commit：`f14be82746f2ecd31e79891b4734c5455c2a067b`，`2026-09-06T17:24:31+08:00`，`feat: add personal message groups and scoped conversation labels`。
- 本文记录基线之后的独立修复，最终 commit 由总发布记录关联。

REST 的 mode-only 参与设置已经支持可选 base_revision，但 MCP `im_participation` 的 schema 没有这个字段，导致 Agent 无法通过原工具获得与 UI 相同的版本保护。

本批仅给工具增加可选整数 `base_revision` 并说明其语义。携带当前 room revision 时修改成功，旧版本由既有服务端返回 409/conflict；不传 revision 的旧客户端继续兼容。参与方式 active/mentions/paused 和 autonomy.enabled 的区分、本人/会话所有者权限均不改变。

新增真实 `nativeMCP` JSON-RPC 调度回归：人类所有者用当前版本把 Agent 改为 mentions；Agent 用旧版本改 active 得到 409 且状态保持；读取最新版本后重试成功；旧的无 revision 调用仍可暂停。使用临时 IM 状态，无模型调用或用户服务操作。

提交前 `npm test` 完整通过 **218/218**，0 失败、0 跳过；包含原 217 项和新增 MCP CAS 回归。
