# 0.6 原生实时文档工作区

- 记录时间：2026-09-06T16:10:35+08:00；分支：`equal_rights`。
- Doc Free当前基线commit：`862609f45d7d4e61c1b2a9c4d33fe527fd31b5e1`。
- Active Agent配套基线commit：`3beae3137c3193555360145300f81a0b5a1c888c`。
- 两个基线时间均为2026-09-06T12:49:59+08:00。本篇描述基线之后的0.6候选工作区，最终实现commit等待总发布清单关联。既有0.5的README、RELEASE、VERSION及测试计数保留为历史，不改写成0.6证据。

## 人与Agent使用同一共享正文

原生会话中的文档窗口现在可以点击“协作编辑器”，以当前办公身份打开`/office-document`。Tiptap编辑Yjs共享正文，Hocuspocus经同源`/collab`同步；标题也使用同一个Y.Doc内的共享文本。界面有协作身份、光标、目录、字符数、共同版本、标题、常用格式和Markdown导出。

正文、标题和canonical投影归属于原Doc Free文档ID。导出重新读取服务器当前canonical正文；Agent的上下文及文档动作也读取、修改这份正文。界面输入不再仅保存为消息里的草稿。原有版本检查Markdown编辑和旧`/workbench`管理员工作台继续保留。

富文本投影保留已实现的标题、粗体/斜体等强调、列表、安全链接、引用和代码块；旧逐行Yjs文档有兼容投影。不能据此宣称任意Markdown扩展、媒体或第三方编辑器格式完全无损。契约、运行记录与提案依旧通过专用流程操作。

## 单文档授权与实时撤权

| 环节 | 当前合同 |
| --- | --- |
| 申请打开 | 当前成员POST `/api/im/rooms/:room_id/documents/:document_id/editor-session`，检查身份、会话绑定、im/docs应用权限与文档类型 |
| 一次性链接 | 返回60秒打开ticket，放在`/office-document#open=…`片段；页面读取后清理地址历史，POST交换一次即消费 |
| 编辑会话 | 交换为30分钟、服务器内存绑定的单文档capability；不向编辑页分发源成员凭据或部署管理令牌 |
| 当前身份 | 同进程同步`authorizeDocument`检查有效登录/机器身份、成员资格、im/docs范围和文档绑定，不读取文档或进入IM串行队列 |
| 收发边界 | Yjs入站更新、awareness以及每次outbound都重新检查当前权限；已经建立的连接也不能继续收取撤权后的正文或在线状态 |
| 显式结束与重启 | 删除当前编辑会话后capability失效；进程重启后旧capability失效，成员需从IM重新打开，正文保留 |

协作presence的名称、principal_id和人类/Agent类型由服务器当前身份覆盖，客户端不能用光标资料冒充其他同事。单文档capability不能访问其它文档、成员`/me`、旧workspace或内部CRDT管理接口。

收到更新前，服务器在候选Y.Doc中检查正文/标题限额、受保护的`active-agent-operations`回执及共享根结构。普通编辑者不能修改原生动作回执、注入未知Yjs根或借正文编辑伪造Agent契约。实时权限与CRDT在同一Node进程中，避免用异步远程权限缓存维持一个已经撤销的连接。

原生编辑器需要`DOC_FREE_EMBED_COLLAB=1`，loopback `COLLAB_URL`和`COLLAB_PORT`必须匹配。配套`dev_office.py`已使用此模式；旧独立collab启动方式仍可用于旧工作台和隔离canonical测试，不自动提供原生成员编辑入口。

## 可靠的原生文档动作

Agent以自己的身份领取上下文和租约，公开冻结步骤、参数及原文依据，再执行允许的文档/任务动作。文档创建使用稳定ID和create-once；更新使用当前版本及canonical内容比较。权限和租约在实际提交边界再次检查。

跨IM与CRDT存储的动作先持久化intent及applying状态，再执行canonical提交；业务正文与CRDT操作回执一同持久化。超时或通信不确定时保留applying，通过相同operation_id/input_hash恢复已提交结果，不盲目重新创建。恢复旧r1回执不能覆盖人后来编辑的r2。服务器回执公开resource_id、前后版本、内容hash和实际状态；模型说明不能代替committed结果。

同文件任务/日历/联系人动作和回执使用同次IM保存，文档适配器另有提交截止时间及恢复合同。每轮最多4步，每个因果根最多12步、深度3；演示中每位同事设置3步。任务done需要领取时已经捕获的共享文档依据。

普通实时输入也在Y.Doc发生事务变更后同步持久化，使用文件fsync、rename和目录fsync，不依赖延迟onStore存活。存储失败进入fail-stop，避免之后的旧内存状态覆盖不确定但已到磁盘的版本。

配套公司实测使用三位独立Agent、三次真实`gpt-6-astra`/`medium`调用，提交3篇文档、3项真人后续任务和2次本人任务更新；独立人类读回身份、版本与文档hash一致。这是8次真实动作，不是八种能力全部用真实模型逐项验收。实际执行链走REST租约API；MCP/A2A的工具覆盖另有专项，不能写成全量协议互通。

## 组织目录与职业同事

目录包含100个唯一职业模板、10个分类；模板来源组织、当前任职组织、部门、职业与职位分别呈现。安装生成独立同事身份，目录不会启动100个模型进程；默认8个worker槽位、3个模型并发，个人房间自主策略决定可运行范围。

组织记录提供公司归属与查询、版本检查及可读管理审计。它仍是单workspace内的组织目录；跨公司名称不构成租户隔离。企业权限使用实际owner/admin/member角色，不能由人类/Agent类型、房间owner或来源组织名称推定管理权限。五人三Agent演示的账号与业务状态使用当前服务，私有登录材料保持Git忽略。

## 已完成验证与退出修复状态

| 项目 | 已有证据 | 范围 |
| --- | --- | --- |
| 真实双UI编辑 | 主集成已验证同一doc两端并发正文输入、标题同步、粗体与导出 | 实际浏览器UI；不替代五端全部操作验收 |
| 真实CRDT与当前授权 | 两个真实Hocuspocus/Y.Doc客户端经实际隔离服务器合并正文并读取canonical版本；logout、移群、禁docs分别验证入站与出站阻断 | 包含后续正文、awareness、capability范围和伪造身份检查 |
| 进程SIGKILL恢复 | peer的Y.Doc更新回调看到新正文时立即SIGKILL服务；kill前没有canonical读取、debounce或优雅关闭；重启前读取CRDT文件确认内容在盘；重启后新capability恢复并继续协作 | 真实进程强杀，不是构造成功快照，也不是断电或分布式故障实验 |
| 文档动作恢复 | 真实HTTP创建/更新文档、任务及重复回执；已有applying故障快照对照真实CRDT提交，保留人的后续版本 | 明确区分实际HTTP/CRDT与故障快照模拟 |
| 显式退出竞态 | 主集成发现结束编辑会话时TCP代理EPIPE未处理导致服务退出；已加client/upstream双边error及close清理 | 隔离自动化通过；修复后实际设计页重复退出，原进程health正常，工程页可继续输入 |

退出专项以同一隔离服务连续进行8轮DELETE编辑会话及强制断开：4轮WebSocket terminate、4轮TCP resetAndDestroy，交替在peer写入前后断开。断开后检查health、旧capability 401、另一编辑者持续持久读写，最后新peer仍可双向同步。临时完整源码副本撤去双边代理修复后，新回归实际失败并出现health读取ECONNRESET，证明测试能击中旧实现；临时副本及进程已清理。浏览器现场原始错误是EPIPE，自动化注入的是TCP reset，不能混写为相同错误码。

本时点reference执行：`node --test tests/native-document-editor.test.js tests/native-document-actions-http.test.js tests/collab-operations.test.js`，exit 0、18/18通过，约4.8秒。其中editor14项、223次真实HTTP请求及真实WebSocket；8轮退出竞态和SIGKILL均包含在该批次。这里不是0.6全库测试总数，不与旧0.5的114项相加。

主集成随后完成Doc Free全库193/193，并完成上表的实际双UI退出复验；这是同一批次的总体数，不再与18项专项相加。Web入口另发现异步取得ticket后新窗口被浏览器拦截，前端已改用当前窗口打开；入口修复的最终UI状态以[Active Agent 0.6总发布记录](https://github.com/huapohen/active-agent/blob/equal_rights/docs/equal_rights/2026-09-06/RELEASE_0_6_1600.md)为准。

本篇整理时没有操作用户服务、重跑测试或模型。退出错误保留为本轮真实发现、可击中旧实现的回归及UI复验事实。最终实现commit、全库测试、构建产物和剩余UI验收由上述总发布清单统一关联。
