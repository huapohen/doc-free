# equal_rights：原生人机办公协作

当前入口为 **0.6办公预览**。记录时点2026-09-06T16:10:35+08:00，当前Doc Free基线commit为`862609f45d7d4e61c1b2a9c4d33fe527fd31b5e1`（2026-09-06T12:49:59+08:00）。本轮实现提交等待新的总发布清单关联；下方旧`VERSION.json`及114/114等计数属于0.5历史验收。

- [原生实时文档工作区、可靠动作与实时权限](2026-09-06/NATIVE_DOCUMENT_WORKSPACE_1610.md)：单文档编辑器、真实双UI、SIGKILL恢复、退出竞态修复与当前复验范围。
- [OIDC企业登录](2026-09-06/OIDC_AUTHENTICATION_1500.md)：配置式登录、身份映射和未连接真实企业issuer的边界。
- [服务端结构化深度搜索](2026-09-06/SERVER_SEARCH_FILTERS_1528.md)：过滤先于截断、真实作者/时间语义和私有业务范围。
- [配套Active Agent公司协作审查](https://github.com/huapohen/active-agent/blob/equal_rights/docs/equal_rights/2026-09-06/COMPANY_AUTONOMY_1603.md)与[三位Agent真实模型验收](https://github.com/huapohen/active-agent/blob/equal_rights/docs/equal_rights/2026-09-06/REAL_COMPANY_MODEL_1546.md)：100模板、五人三Agent、8次真实动作及REST/MCP/A2A覆盖边界。

主集成0.6全库为193/193；双UI退出修复已复验。剩余UI、两仓实现SHA及五端构建统一见[Active Agent 0.6总发布记录](https://github.com/huapohen/active-agent/blob/equal_rights/docs/equal_rights/2026-09-06/RELEASE_0_6_1600.md)。

## 0.5与分支建立时的历史记录

- 文档系列日期：2026-09-06（Asia/Shanghai）。
- 分支：[`equal_rights`](https://github.com/huapohen/doc-free/tree/equal_rights)。
- Doc Free 基线：`da9f5d0fe3d9dad50ca79bd8f90446e20db2cefd`，来自 `evolve`。
- 0.5实现提交：见 `2026-09-06/VERSION.json`；该台账不代表本轮0.6候选代码。
- 本系列描述：在可见文档协作之上，实现独立身份、工作会话、共享任务、原生 Agent 运行和可检查交付物。

这是新的办公协作版本记录；此前 [evolve 文档](../evolve/README.md) 保留为历史基线。用户此次明确将 IM 纳入实现范围，并将目标定义为面向办公的软件。

阅读入口：[版本说明](2026-09-06/README.md) · [协议与运维](2026-09-06/PROTOCOL.md)。

2026-09-06 后续实现记录：[会议、日历与附件](2026-09-06/OFFICE_MODULES_AND_ATTACHMENTS.md) · [账号、考勤与审批](2026-09-06/ACCOUNTS_ATTENDANCE_AND_APPROVALS.md) · [插件、通讯录与全域搜索](2026-09-06/PLUGINS_CONTACTS_AND_CAPABILITIES.md)。各篇保留具体时间、实现基线和描述，最终提交由发布清单关联。

最新组织管理记录：[企业后台、同权管理员与可读审计](2026-09-06/ENTERPRISE_ADMINISTRATION.md)，记录时间为 2026-09-06T11:42:11+08:00。

后续应用治理记录：[企业应用策略、独立业务入口与当前权限回执](2026-09-06/ENTERPRISE_APPLICATION_POLICIES.md)，记录时间为 2026-09-06T12:16:07+08:00。最终后端测试 **114/114 通过**，真实 HTTP **217 次请求**；界面与平台构建按发布记录分别验收。

配套执行器：[`active-agent / equal_rights`](https://github.com/huapohen/active-agent/tree/equal_rights)。Doc Free 承担人和 Agent 共同使用的办公界面与协议；Active Agent 承担持续参与和模型调用。Quantum Entanglement 的消息因果关系、运行上下文与去重设计作为参考，本版不依赖它的运行时。

补充协议验证：[真实HTTP/MCP/A2A验证](2026-09-06/HTTP_MCP_A2A_VERIFICATION_1148.md) · [旧回执按当前权限复核](2026-09-06/A2A_CURRENT_ACCESS_VERIFICATION_1215.md)。报告记录基线、时间和源码摘要；最终提交由版本台账关联。
