# 2026-09-06 12:15 · A2A 历史回执的当前权限与应用策略验证

| 字段 | 本次记录 |
| --- | --- |
| 记录时间 | `2026-09-06T12:15:40+08:00` / `2026-09-06T04:15:40Z` |
| 分支 | `equal_rights` |
| Doc Free 基线 commit | `134e0a78fc51345689be377004e793dd6a7fd71d` |
| 基线时间 | `2026-09-06T10:42:30+08:00` |
| 基线描述 | `feat: add native office meetings calendar and deep message workflows` |
| 本次描述 | 修复任务所有者通过旧 A2A 回执绕过已收回的模块、房间或企业权限；验证应用策略的真实 REST/MCP/A2A 接线 |
| 测试对象 | 基线之后的未提交工作树，最终实现 commit 由发布清单关联 |
| 测试暂存 JavaScript SHA-256 | `1793d8f0348edad7affaf7a6e3a6634513812d7a3f00e22782a9823e41613682` |

这是 [11:48 HTTP/MCP/A2A 验证](HTTP_MCP_A2A_VERIFICATION_1148.md) 之后的独立增量记录。先前报告的源码摘要、测试数量和请求数保留为当时证据，不能用它代替本次新增权限检查的验收。

## 1. 问题与修复行为

此前 A2A 的 `tasks/get` 与相同 messageId 重试只验证当前身份和任务 owner。完成任务的 `artifacts` 保存原始业务结果，`history` 保存原始输入；即使后来关闭邮件/文档/审批模块、移出房间或撤回企业管理员角色，任务 owner 仍可能从旧回执读取先前正文。

现在 `native-a2a.js` 通过 `resolveNativeTool()` 使用固定 MCP 定义解析历史操作，再调用原生的 `authorizeStoredOperation({method,pathname,input,params,receipt},credential)`。该接口在 IM 的串行权限边界内检查当前身份、模块、房间、业务对象和企业角色，不重新执行工具、不调用业务 handler、不读取 CRDT 或重放副作用。

- completed、submitted、canceled、input-required 的输入/回执在返回前校验当前权限，包括 `tasks/get`、相同 messageId 重试和取消响应。
- 已无权读取的旧回执返回 JSON-RPC `-32003`，保留安全的 `code`、HTTP 语义 `status` 和 `plugin_id`，不返回原始正文或 history 参数。
- 原业务执行失败的任务保留安全的 failed 状态，但 `history` 为空，不回显可能属于受限业务的输入。新请求被模块策略拒绝时仍能读取明确的失败原因。
- 旧回执和幂等键继续保存。恢复合法权限后可以读取原任务；权限检查没有再次执行创建或更新操作。

聚合回执依据实际包含的数据检查模块及资源范围。旧搜索回执包含已禁用模块的正文时整体拒绝；按当前权限重新查询形成的过滤结果仍可成功。搜索中回显调用者自己的 query 不算返回受限业务结果，测试分别检查实际 results。

## 2. 可复现结果

在 Doc Free 根目录执行：

```sh
node --test tests/native-a2a.test.js tests/office-http-integration.test.js tests/native-app-policies.test.js
```

| 验证 | 通过 / 失败 |
| --- | --- |
| A2A 模块及撤权回归 | 19 / 0 |
| 企业应用策略 | 8 / 0 |
| 真实 HTTP 服务集成 | 8 / 0 |
| 合计 | **35 / 0** |

HTTP 套件完成 **217 次真实 HTTP 请求**，实际调用原有 17 个企业管理 MCP 工具及新增 `enterprise_apps`、`enterprise_read_app`、`enterprise_configure_app` 三个工具。原 19 项内置业务能力映射继续通过。

## 3. 本次关键场景

| 场景 | 结果 |
| --- | --- |
| 邮件模块关闭 | 原 REST 返回 403；MCP 与新 A2A 返回带 mail plugin_id 的失败；旧邮件回执 get/重复提交/重启后读取均被拒绝 |
| 文档与审批模块关闭 | 同一登录身份立即失去相应 REST/MCP/A2A 访问；规范文档、私密审批及旧搜索正文回执被拒绝 |
| 新聚合查询 | search/library 按当前权限过滤后仍可经 A2A 完成；禁用域的实际结果不出现 |
| 移出房间 | 旧任务创建、房间详情、房间列表、搜索、library、events、Markdown 导出和审批读取回执全部拒绝 |
| 企业角色降权 | 既有 Agent 登录会话无法再读取此前完成的企业导出回执，也不能借相同 messageId 取得旧组织文档 |
| 当前插件状态 | plugins 返回 enterprise_allowed/effective_enabled 的变化；个人偏好不会覆盖企业硬限制 |
| 恢复路径 | settings、当前企业身份及授权企业管理入口仍可用；恢复策略后读取原任务 ID，无新增业务副作用 |
| 任务失败回执 | 保留 app_policy_denied/status/plugin_id，history=[]，没有原始私密参数 |
| 无重复执行 | 模块测试显式统计 invoke 次数，读取/重复提交旧任务没有增加业务调用；房间内仍只有原来创建的一个任务 |

应用策略模块另行验证个人/部门允许范围与显式拒绝、原生模块依赖、私密事件再过滤、长轮询唤醒、媒体权限撤回、运行取消、版本冲突和持久化 fail-stop。

## 4. 验证边界

真实 HTTP 测试仍使用临时隔离服务、动态 loopback 端口、随机测试身份与独立数据；不复制本地 .env，不继承模型凭据，不操作既有 3218 服务。测试结束关闭子进程并删除临时目录；没有真实邮件外发、模型调用、摄像头或麦克风采集。

回执授权是服务器继续提供数据时的当前权限检查，不能删除调用者此前已经合法下载的副本。转发内容属于已经明确共享的副本，provenance 外键本身不等同于重新读取原房间；每次仍检查当前操作和实际返回资源的范围。

本轮未编译客户端，也未触发第二阶段 CI。默认 Python worker 的多步动作执行仍属于另外的待实现设计，不能将本次 MCP/A2A 权限修复写成模型已可自动执行任意办公工作。
