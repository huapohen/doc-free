# 0.5.0+2 · 企业办公与原生管理发布台账

记录时间：2026-09-06T12:40:38+08:00。分支：两仓均为 `equal_rights`。这是第二阶段开发预览的实现、验收和产物记录，历史 `docs/evolve` 和第一阶段安装包继续保留。

## 精确实现提交

| 仓库 | 实现提交 | 提交时间 | 描述 |
| --- | --- | --- | --- |
| Active Agent | [`2fad0ac68a05a39cf7d6abe55624b771bfa3ae62`](https://github.com/huapohen/active-agent/commit/2fad0ac68a05a39cf7d6abe55624b771bfa3ae62) | 2026-09-06T12:23:53+08:00 | 企业办公客户端、账号与人/Agent 业务工作流 |
| Doc Free | [`901b49bdd268b98dae74613a19d40d7d69891137`](https://github.com/huapohen/doc-free/commit/901b49bdd268b98dae74613a19d40d7d69891137) | 2026-09-06T12:23:53+08:00 | 同权企业管理、原生办公协议与当前权限复核 |

本篇与 [VERSION.json](VERSION.json) 在上述实现提交之后入库。表中 SHA 指实现和构建来源，本文自身的提交由 Git 历史查询，避免文档自引用提交号。两仓版本清单相同，可用来准确配对部署；不将后来的文档提交重标为二进制构建来源。

## 本轮交付

企业后台增加真实的概览、成员与组织、部门、角色详情、管理日志和企业应用策略。人和 Agent 都可成为 owner/admin/member，使用同一客户端与同一服务端鉴权。普通员工不能调用管理 API；管理员不会自动获得其他成员的私人业务数据。最后有效 owner 保护、成员禁用/撤销、版本冲突、幂等创建与管理 Markdown 导出已实现。

账号可独立登录同一 Flutter UI；内部邮件、签到/签退、补卡及审批、个人设置、联系人和应用目录已接入持久业务。人可以选择 Agent 为收件人或审批人，Agent 通过自己的身份使用同样对象和权限。既有 IM、独立 Agent 好友/商店、文档、任务、日历、会议及底部 Agent 协作入口继续保留。

企业应用启停、允许成员/直接部门范围和显式拒绝名单成为服务端约束。REST、MCP、A2A、搜索、事件、资料库、聚合房间上下文及历史回执读取均检查当前授权。禁用 IM 后，其他仍获准的独立业务使用最小房间目录继续工作。身份、设置与企业恢复入口保留，但管理操作仍需要真实角色。

A2A 支持原生工具调用、任务状态、幂等和排队取消；历史结果不会绕过之后的应用禁用或角色变更。一次性凭据和媒体信令不写进可持久化 A2A 回执。外部软件/硬件扩展目前仍是声明与配置，执行状态明确为未连接。

详细协议位于 Doc Free 同目录的企业管理、应用策略、账号考勤审批、插件能力和回执验证文档；客户端能力矩阵与真实飞书观察位于 Active Agent 同目录。具体索引见 [README](README.md)。

## 验证结果

| 验证 | 结果与准确范围 |
| --- | --- |
| Python | 37/37 通过，对应 Active Agent 实现源码 |
| Flutter | 24/24 共享测试通过，静态分析 0 问题 |
| Doc Free Node | 114/114 通过；其中包括 A2A 19、应用策略 8、HTTP 8 共 35 项专项，不重复累加 |
| 真实 HTTP 集成 | 上述后端测试包含 217 次 HTTP 请求，覆盖实际 HTTP/MCP/A2A 传输和授权 |
| 企业界面与协议闭环 | 人类界面限制 Agent 邮箱，REST/MCP 同时拒绝，Agent 管理员用 MCP 恢复，审计主体为 agent，导出不含凭据 |
| 业务界面 | 人提交补卡、Agent 账号批准并更新签到；93 字符邮件正文经草稿重开、发送、Agent 读取逐字一致；第三方无权读取 |
| 原生客户端 | macOS 与 iOS 模拟器实际启动到中文登录页；完整业务交互本轮在 Flutter Web 验收 |

后端全部根 JS 按集成测试算法计算的 SHA-256 为 `1793d8f0348edad7affaf7a6e3a6634513812d7a3f00e22782a9823e41613682`，与最后测试候选相同。测试覆盖、真实交互、模型验证和构建分别记录，互不替代。完整 UI 步骤与原始本机证据位置见 [界面验收](LIVE_UI_ACCEPTANCE.md)。

首阶段真实 `gpt-6-astra / medium` 文档草稿与主动提及验证仍保留在历史记录；调用发生于 09:20–09:23，不能作为本轮 0.5 企业管理或自动业务动作的模型验收证据。本轮临时配置和凭据没有进入 Git 或客户端包。

## 五端构建与校验

[GitHub Actions 34011406113](https://github.com/huapohen/active-agent/actions/runs/34011406113) 的 head 为准确 `2fad0ac68a05a39cf7d6abe55624b771bfa3ae62`，2026-09-06T04:24:09Z 创建，最后一个 job 于 04:29:56Z 完成。Web、Android、macOS、iOS unsigned、Windows 五端全部成功。每个 runner 都执行同一套 24 项 Flutter 测试和静态分析，不能累加为 120 个不同测试。

五份 GitHub archive 均匹配官方 artifact digest，解包后各自产物又匹配包内 manifest 的 SHA-256、字节数、目标和提交。当前本机目录为 `active_agent/output/builds/2fad0ac`；原始官方 metadata、日志、下载记录、包结构检查与完整清单位于该目录。SHA、构建/校验时间和 CI job 链接也已收入可提交的 [VERSION.json](VERSION.json)。

| CI 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `active-office-android-preview.apk` | 95,686,698 | `1fcd510d3c1a59a2d2f573bda772ac22633802747b8407b0fc3f00612d7fe7e7` |
| `active-office-ios-unsigned.zip` | 14,408,797 | `df8b2313e26b684b1e15700fa965b1617255c35b6f7bed42ae3404d5e0db92f4` |
| `active-office-macos.zip` | 34,366,389 | `ceec727927e2a3e80190bda0491a50dabd888e5046dc1b4db1d932b10a86d5e8` |
| `active-office-web.tar.gz` | 14,479,356 | `326ab32ea84cc366fb650a646a3b3b7cce9c75e8299f69b38f6c8bcdea31dbd2` |
| `active-office-windows.zip` | 22,602,712 | `325994ed5d1dd66bd969f9b6b71fe13dc7218729eb87d2ee5f61785bff6c930f` |

本机另外从干净的精确提交 detached worktree 生成 `local/active-office-macos-2fad0ac.zip` 和 `local/active-office-ios-simulator-2fad0ac.zip`，两包 SHA/CRC 已复核；其登录页真实启动证据和完整 SHA 见版本清单与本机 `local/LOCAL-BUILD-REPORT.md`。这些包与 CI 包分别标明来源，没有覆盖第一阶段 `output/builds/1ae44da`。

下载按本机约定动态读取系统代理、测试目标线路，并验证完整性。Android 下载中途超时后保留断点，通过已验证代理以 HTTP 206 续传，完整 SHA 通过；没有把部分文件当成成功产物。

## 发行与能力边界

- macOS 为开发签名，尚未公证，仍含 `get-task-allow`；iOS 真机包未签名，模拟器包为 Debug 预览；Android 使用开发签名。当前没有宣称 App Store、Google Play 或 Windows 安装器发行完成。
- Windows 已在真实 Windows runner 编译并检查 x86_64 PE 和 WebRTC DLL；本机为 macOS，没有执行 Windows 应用的业务验收。
- 一个部署对应一个工作空间。尚无多租户企业切换、SSO/MFA、自定义管理角色、SCIM 或完整入离职流程。
- 默认 Python worker 仍支持回复、可见阻塞与待审阅文档草稿，没有办公工具执行循环。可靠多动作计划、逐动作租约检查、原子回执与重启恢复见 Active Agent 的 `NATIVE_ACTION_EXECUTION_DESIGN.md`，该设计尚未实现。
- 邮箱限内部投递；考勤未实现定位验真/排班薪资；审批未实现完整流程设计器；外部插件和硬件尚未接通。
- 会议已有 WebRTC 能力与信令，但本轮没有采集真实音视频，也没有完成跨网络质量、SFU 大会、录制转写和生产规模验收。
- Doc Free 保留共同可见文档与版本冲突控制；Flutter 富文本 CRDT、多维表格、知识库树和细粒度共享仍待扩展。
- 已深入查看飞书 Web 企业管理与桌面身份入口。手机企业管理受镜像系统锁定影响未验证。资产计费、全部安全策略、细粒度消息管控、报表与其他成熟企业套件能力仍在差距清单中。

本次交付是已构建并有明确证据的 0.5 开发预览，不代表飞书全部功能和界面已 1:1 完成。“超越飞书”的方向继续落实到可读工作文档、身份对等和可直接调用的原生能力，不以概念或按钮数量代替实际完成度。
