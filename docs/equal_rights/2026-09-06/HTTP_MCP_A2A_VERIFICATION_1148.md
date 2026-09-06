# 2026-09-06 11:48 · HTTP、MCP、A2A 与企业同权验证

| 字段 | 本次记录 |
| --- | --- |
| 记录时间 | `2026-09-06T11:48:01+08:00` / `2026-09-06T03:48:01Z` |
| 分支 | `equal_rights` |
| Doc Free 基线 commit | `134e0a78fc51345689be377004e793dd6a7fd71d` |
| 基线提交时间 | `2026-09-06T10:42:30+08:00` |
| 基线提交描述 | `feat: add native office meetings calendar and deep message workflows` |
| 本次描述 | 验证真实服务上的账号会话、文档与办公能力、MCP/A2A 权限、企业角色管理、私密业务及持久化回执 |
| 测试对象 | 基线之后的未提交工作树；不能将以下结果解释为基线 commit 本身已有全部能力 |
| 测试源码 SHA-256 | `d1f1c3e77c5e9abf81e99d469c1f7585b2589e4b0dde14b59a6cc0cad6c2eba5` |

本记录独立于前一轮办公模块和跨平台构建记录。最终实现 commit 由后续发布清单关联；本记录不预填尚未产生的提交编号。源码摘要按暂存测试目录中名称排序后的每个顶层 JavaScript 文件，依次加入“文件名 + 换行 + 原始文件字节”计算，准确标识本次实际启动的服务代码。

## 1. 可复现命令与结果

在 Doc Free 根目录执行：

```sh
node --test tests/native-a2a.test.js
node --test tests/office-http-integration.test.js tests/native-enterprise.test.js
```

| 验证层 | 通过 / 失败 | 证据 |
| --- | --- | --- |
| A2A 模块回归 | 16 / 0 | 接受持久化、回执、授权、幂等、重启恢复、队列取消、故障停写及限额 |
| 企业权限回归 | 8 / 0 | 初始 owner、同权角色、最后 owner、部门层级、停用、撤销、创建幂等、损坏状态拒绝启动 |
| 真实 HTTP 集成 | 7 / 0 | 147 次真实 HTTP 请求；19 项内置能力映射；全部 17 个企业 MCP 工具实际调用 |

合计 31 个测试通过。真实 HTTP 套件启动当前源码的 `server.js` 和 `collab-server.js`，通过真实路由验证服务接线，包含一次重启与回执重读。它使用动态 loopback 端口、独立临时规范文档/CRDT/IM/A2A 数据和随机测试凭据。既有 `3218` 服务及个人数据未参与测试。

测试不复制本机 `.env` 或认证文件，仅继承 `PATH` 并显式设置测试所需配置；子进程输出会检查是否包含生成的测试凭据。测试结束关闭全部测试子进程并删除临时目录。本轮没有调用模型、外部邮件传输或真实摄像头/麦克风。

## 2. 真实协议验证

| 场景 | 已验证行为 |
| --- | --- |
| 独立身份与登录 | human 和 agent 均可创建密码账号、登录、经 MCP/A2A 工作；会话 token 与机器凭据不同，作者由当前凭据推导 |
| Agent Card | URL 取显式公开地址，不受伪造 Host 改写；声明 JSONRPC、Bearer、无 streaming/push |
| A2A 幂等与重启 | owner + messageId 重试返回原任务，不重复发消息；重启后仍读相同回执 |
| 回执范围 | 非任务 owner 不能读任务；独立 actor 输入和凭据覆盖被拒绝 |
| 文档 | 内置文档能力实际通过规范文档服务和 CRDT 创建、读取，不以模拟文档响应替代 |
| 邮件 | 草稿和内部投递经真实 MCP 完成；收件人看不到 BCC 名单，局外人通过 REST/MCP/A2A 均不能读取该投递 |
| 审批与考勤 | 指定审阅人可读；普通会话同事不能从 REST/MCP/A2A、事件或会话 Markdown 导出获得私密业务 ID/正文 |
| 临时媒体 | 使用合成 SDP/ICE 信令验证直接 MCP；信令正文不写入 IM/A2A 文件，A2A 拒绝媒体操作 |
| 退出登录 | 退出后原会话在 MCP/A2A 失效；独立机器身份仍有效；再次登录可读取同一 principal 的旧回执 |
| 插件声明 | 注册并在个人设置中启用扩展后仍为 `available:false` / `execution:not_connected`；未制造执行工具，测试 adapter 收到 0 次请求 |

19 项内置能力各自映射到真实、已认证的 MCP 操作，涵盖文档、消息、联系人、工作台、任务、会议、日历、媒体信令、考勤、审批、邮件、个人设置及插件配置。可执行性由真实调用证明，扩展声明本身不算实现了能力。

## 3. 企业管理：人和 Agent 使用相同权限

企业角色与会话 owner 分开。测试中的人类已经拥有会话，初始企业角色仍是普通成员，不能读取企业后台。仅使用隔离 fixture 的工作区管理凭据初始化企业 owner；此 bootstrap 没有暴露给成员 MCP 或 A2A。

随后企业 owner 经 A2A 将 Agent 授权为 admin。Agent 使用现有登录会话即可执行企业目录、成员管理、部门 CRUD 和审计导出。普通成员经 REST/MCP/A2A 仍被拒绝。Agent admin 不可将自己升为 owner，不可分配高权限角色；伪造 `actor_id` 也不能获得 owner 权限。owner 将该 Agent 降回 member 后，无需退出或重登，新的 MCP/A2A 企业管理请求即被拒绝。

| 已调用企业 MCP 工具 | 核验点 |
| --- | --- |
| `enterprise_identity`, `enterprise_overview` | 当前角色、能力及实际企业统计 |
| `enterprise_members`, `enterprise_read_member` | 目录检索、分页与指定成员读取 |
| `enterprise_create_member` | 默认普通成员；同一创建意图只创建一次，明文凭据只返回一次 |
| `enterprise_update_member`, `enterprise_revoke_member` | 预期 revision、部门调整、授权/降权、撤销后机器凭据失效 |
| `enterprise_departments`, `enterprise_read_department` | 实际父子层级及成员数量 |
| `enterprise_create_department` | 稳定 client_id 返回同一部门 |
| `enterprise_update_department`, `enterprise_delete_department` | 循环引用被拒绝；非空不可删除；迁移成员后可以删除 |
| `enterprise_roles`, `enterprise_read_role` | 固定 owner/admin/member 能力定义 |
| `enterprise_audit` | Agent 执行操作的 actor_id、actor_kind、时间及动作可核对 |
| `enterprise_update_profile` | owner 按版本修改企业名称 |
| `enterprise_export` | Markdown 包含组织与审计，不含凭据、密码哈希或私密邮件正文 |

最后一位有效 owner 不能被降权。模块测试进一步验证停用/两条撤销路径和并发所有权变更也遵守该约束；停用会使密码会话失效、唤醒并拒绝正在等待的事件/媒体请求、停止 Agent 运行。修复后重新启用身份不会恢复旧登录会话。

## 4. A2A 持久化边界

`enterprise_create_member` 会返回一次性个人凭据，因此仅保留为直接成员认证的 REST/MCP 操作，明确排除在 Agent Card 和 A2A 执行目录之外。HTTP 测试验证 A2A 在执行前返回不支持操作，既不创建成员也不保存凭据。其他企业操作继续使用当前 owner/admin ACL，角色授权与 human/agent 类型无关。

A2A 同时排除账号/登录会话管理，以及 presence、加入/离开会议、会议实时详情、SDP/ICE 收发等临时能力。会议创建、结束、规范会议纪要、日历等可持久化业务仍可按成员权限调用。

A2A 先持久化接受记录，再开始执行，最后保存回执。进程重启遇到 submitted/working 会转为 `input-required`，保留“结果未知”状态，不自动重放。接受保存失败不会执行业务；回执保存失败进入故障停写，避免对不确定副作用自动重试。只有未开始任务可取消。原始异常不会直接写入回执，凭据字段及当前 bearer 的回显会被清理。

这不是跨文档、IM 与 A2A 文件的全局事务，也没有证明任意外部程序的副作用恰好一次。实际边界、失败状态和待人工核对的结果保留在协议中。

## 5. 本次验证范围

本轮证明真实 HTTP、MCP、A2A 接线及可见业务权限的行为；没有将协议测试当作各平台视觉验收、真实媒体质量、SMTP 投递、模型质量或生产容量证据。跨平台构建和真实模型验证使用对应发布记录中的 commit、时间及产物哈希。

相关实现与复现入口：`native-a2a.js`、`native-enterprise.js`、`native-im-mcp.js`、`tests/native-a2a.test.js`、`tests/native-enterprise.test.js`、`tests/office-http-integration.test.js`。
