# 人机 · 合并转发与富文本原生协议交付附录

- 创建时间：2026-09-07T09:51:32+08:00，Asia/Shanghai。
- 分支：Active Agent 与 Doc Free 均为 `equal_rights`。
- 状态：本批实现和协议测试已完成；本文为双仓同名新增附录，最终实现提交、终端验收与共享文档发布由主集成补记。正文中的源码基线不能充当最终功能 commit。
- 本文只汇总本批后端与标准 Agent worker 的证据，不把专项通过当作全量飞书办公软件复刻完成。

## 版本与提交

| 仓库 | 本批起点 HEAD | 实际 Git 时间 | 描述 |
| --- | --- | --- | --- |
| Active Agent | `09fe83f19cdee6d242fd4903d1a76d4c451b491d` | `2026-09-06T23:48:19+08:00` | `docs(office): publish verified sidebar attention and identity delivery` |
| Doc Free | `0edcfb20afe3349f6592b7021a65ad29b46bf4ad` | `2026-09-06T23:46:12+08:00` | `docs(im): record message attention contracts and live verification` |

| 仓库 | 本批最终实现 commit | 实际 Git 时间 | 描述 |
| --- | --- | --- | --- |
| Active Agent | 待主集成提交后读取 | 待读取 | 待读取 |
| Doc Free | 待主集成提交后读取 | 待读取 | 待读取 |

最终冻结时必须从实际 Git 对象补入上表。本文采用新的日期目录和文件名，保留以往已发布文档；本附录撰写阶段没有暂存、提交、推送或发布共享文档。

## 同权能力与使用路径

Human 与 Agent 使用同一身份、会话成员资格和原生协议。Agent 可以主动调用 HTTP、MCP 或 A2A 分享消息、查看已收到的聊天记录、以富文本发言及把消息素材交给任务或 Doc Free 文档。上述能力不依赖模拟鼠标点击，也不授予 Agent 额外管理权限。

| 行为 | HTTP，以 `/api/im` 为前缀 | MCP / A2A operation |
| --- | --- | --- |
| 合并转发 | `POST /rooms/:rid/messages/forward-bundle` | `im_forward_bundle` |
| 展开共享卡片 | `GET /rooms/:rid/messages/:mid/forward-bundle` | `im_read_forward_bundle` |
| 恢复本人批次回执 | `GET /rooms/:rid/messages/forward-bundle-receipts?client_id=...` | `im_forward_bundle_receipts` |
| 富文本发言 | `POST /rooms/:rid/messages` | `im_send` |
| 富文本编辑 | `PATCH /rooms/:rid/messages/:mid` | `im_edit_message` |
| 由消息创建任务 | `POST /rooms/:rid/messages/create-task` | `im_messages_create_task` |
| 由消息创建 Doc Free 文档 | `POST /rooms/:rid/messages/export-document` | `im_messages_export_document` |

认证通过当前身份请求头传递，URL 不携带凭据。会话响应显式声明 `native_features.message_forward_bundles` 与 `native_features.message_rich_text`，客户端按能力声明提供入口。

## 合并转发合同

人或 Agent 选择同一来源会话的 1–50 条消息、1–20 个当前有发送资格的目标会话。请求包括稳定 `client_id`、`message_ids`、精确覆盖来源的 `base_revisions`、`target_room_ids`、可选 `comment` 与 `mentions`。服务器生成不可由调用方伪造的共享快照，每个目标创建一条真实 `kind = forward_bundle` 消息。普通发送接口拒绝客户端自行注入卡片类型或快照。

服务器在同一个 IM 串行事务中核对来源版本、隐藏、撤回、禁止转发来源链、全部目标成员资格、提及对象和附件配额。一个目标预检失败就拒绝整个批次。附件引用、所有目标消息和幂等回执共同持久化；存储失败进入拒绝读写状态，不报告部分成功。

创建结果为 `{bundle, deliveries, duplicate}`；卡片中的 `detail_path` 指向实际共享记录。展开结果为 `{bundle, message_id, room_id}`，其中 `snapshot_policy = shared_copy`。当前目标成员可读取已收到副本，不要求加入来源群。源消息后续编辑或撤回不改变已分享的正文、版本、作者、时间和样式；源作者后来禁止转发仍会阻止来源链上的新转发和相关附件复用。

每个目标获得独立附件 ID 与目标会话下载路径。嵌套快照中的附件也映射到最终目标。最多 3 层、展开后 200 个条目、1 MiB 快照和每批 400 个去重来源附件；仍受每会话 200 个附件 / 200 MiB、实例 5000 个附件 / 1 GiB 等既有配额限制。本地合并转发台账另有 2000 批次上限，不能据此宣称已经具备无限云端历史容量。

回执查询结果为 `{receipts, truncated:false}`，只返回本人在该来源会话创建的原批次，并重新检查当前来源与全部目标会话权限。响应不确定时保留原 `client_id`，先查只读回执；源消息变化后重复 POST 可能拒绝，但已经成功批次仍可按原 ID 恢复。权限丢失不等于此前没有成功，不能因此悄悄换新 ID 重发。

目标卡片被个人隐藏、撤回或当前身份失去成员资格后，直接展开、MCP 及 A2A 缓存回读都会重查权限。展开卡片不自动推进来源消息已读位置。普通转发收到的合并卡片仍保留真实嵌套记录。

## 富文本与标准 worker

富文本是可选、受限元数据，普通 `content` 一直保留。格式为 `{"version":1,"spans":[{"start":0,"end":4,"styles":["bold"]}]}`。允许 `bold`、`italic`、`underline`、`strikethrough`；每条消息最多 200 段，每段 1–4 个样式。范围为 UTF-16 单元、左闭右开，不允许越界或切开有效 emoji 代理对。不接受 HTML、额外字段或任意标记。

相同范围去重、样式和范围按固定规则排序后进入幂等摘要。null、空 spans 或省略字段保持旧纯文本 payload 形状。同一 client ID 的等价格式不会重复创建消息，实际格式变化会触发幂等冲突。

编辑正文不变且省略样式时保留原样式；改变正文但省略样式时清除旧范围；显式 null 清除。历史修订保留样式，当前隐藏或撤回墓碑不暴露样式。普通转发、合并转发及嵌套共享副本保留分享时格式。

本批补齐 `/turns/:tid/finish`、冻结动作计划 `final_result` 和 `active_agent/im.py` 标准 worker 三条原先会丢失或拒绝样式的路径。worker 的提示合同和 validator 采用同一 UTF-16 规范，Python 使用标准库 `utf-16-le` / `surrogatepass`，拒绝布尔范围并接受 JS 可安全表示的整数形式数值。无需新增依赖。

有效样式在标准完成、相同完成重试、冻结计划及计划恢复中保留。非法格式进入明确 blocked 结果，不能静默删掉格式后冒充正常完成。非回复结果不能携带非 null 样式。服务器追加的动作回执保持普通文字，不把源样式扩展到额外回执段落。

## 文档作为可见工作载体

消息创建任务和导出 Doc Free 文档会递归展开实际共享副本的正文、作者、时间、版本和最终目标附件路径。来源样式写入 metadata，可供人和 Agent 检查，正文不会只留下空附言。来源代码围栏被安全包裹。任务最终描述限制 12000 字符，文档最终正文限制 200000 字符；针对完整展开结果校验，超限在创建资源前明确拒绝，不能静默截断。

这证明消息来源到任务及真实文档的原生链路。富文本来源 metadata 不等于 Doc Free 已按每条消息的全部样式完成同等视觉排版；整个会话的旧 Markdown 导出和模型自动上下文仍未全面递归展开所有合并卡片。

## 最终协议核验

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Doc Free 完整测试 | 331/331 | `/tmp/renji-rich-text-final-full.log` |
| 富文本与动作计划专项 | 21/21，属于上述完整套件 | `/tmp/renji-rich-text-plan-targeted.log` |
| Python IM、动作、fleet、富文本 worker 专项 | 25/25 | `/tmp/renji-rich-text-worker-tests.log` |
| 实际 JS/Python 规范化对照 | 154/154 | `active_agent/output/rich-text-normalizer-parity.json` |
| 富文本本机 HTTP/MCP/A2A 与标准 worker | 42/42；23 个响应检查 + 19 个行为断言 | `active_agent/output/rich-text-live-20260907.json` |
| 合并转发本机 HTTP/MCP/A2A | 121/121；73 个响应检查 + 48 个行为断言 | `active_agent/output/message-bundle-live-20260907.json` |
| 两仓工作树格式检查 | `git diff --check` 通过 | 最终提交前仍须由主集成再核对实际冻结版本 |

上述层次分别陈述，不把重叠专项与全量测试累加为一个总数。先前 324/324、330/330 后端结果由本表 331/331 取代。前端 08:54 开始验证的 525/525 属于更早的 UI 批次，未覆盖后续输入框与富文本集成，不能充当本批最新 Flutter 通过证据。

154 个差异对照包含 emoji、显式代理单位、孤立代理、邻近范围、数值与布尔类型及空格式。比较两种语言的实际规范化函数结果，不是同一种实现自证。

合并转发实测结束于 `2026-09-07T08:49:32+08:00`，富文本实测结束于 `2026-09-07T09:28:26+08:00`。两组均通过本机真实 HTTP 服务、MCP 与 A2A 路由；没有向真实飞书发送消息，没有调用大模型。富文本另执行真实 IMClient 与标准 IMAgent 的一次领取/完成流程，模型提供器使用确定性的合成 stub；这不是实际大模型自主任务能力评测。

合并实测首次准备误用不存在的成员 PATCH 路由而收到 404；修正为 participation 后复用已建合成身份和空来源群，完整保留首次记录在 `prior_attempts`，最终 121 项通过。富文本 worker 只临时启用合成 Agent 的 mentions 参与，结束恢复 paused，未启动持续后台 worker。

测试服务按 `python3 scripts/dev_office.py --doc-free ../doc_free --no-worker` 启动，3218/1238 载入最终后端；日志 `/tmp/renji-office-dev-rich-text-final.log`。3217 未触及。本附录仅描述验证时状态，不保证后续进程一直运行。

## 界面可查看证据

本机 huapohen 已加入来源、收件与嵌套三个独立测试群，群名分别为「合并转发实测 · 来源 · 09-07 08:48」「合并转发实测 · 收件 · 09-07 08:48」「合并转发实测 · 嵌套 · 09-07 08:48」。

| 证据 | ID |
| --- | --- |
| 实际收件合并卡片 | `msg-46971d25-5b0e-4127-86d8-01caf06d1643` |
| 实际嵌套卡片 | `msg-5b9b72a2-1cc6-40c9-8ce9-28d9fc5e05ec` |
| 实际导出来源文档 | `31eba07b`，这是测试素材文档，不是本附录发布 ID |
| 实际来源任务 | `task-f7e10d8c-eff2-453e-9c16-f0c2c5e579bc` |
| Human HTTP 富文本 | `msg-9dcfc941-c4ca-4066-a698-d655ed1696fa` |
| Agent MCP 富文本 | `msg-706afeed-3232-4ae0-a3b5-05a343198d9e` |
| 标准 worker 富文本回复 | `msg-b76de29d-e9b5-4c9e-9646-793b078810d7` |
| Human A2A 富文本 | `msg-5ff69fc9-7404-41d1-b9be-40bb89ade546` |
| 带格式普通转发 | `msg-715a8d3c-71ae-41b0-a9e4-10e76e5384e5` |
| 带格式合并卡片 | `msg-98e695e5-9fed-4459-9385-d163ef051a27` |

源群、目标群坐标和完整检查脚本详见 Doc Free 同日期目录的 `NATIVE_MERGED_FORWARD_0842.md` 与 `NATIVE_RICH_TEXT_0928.md`。这些可见样例用于主集成实际点击验收，不自动构成终端渲染正确的结论。

## 只读审阅与凭据扫描

本轮审阅了新增合并转发与富文本模块、接入差异、来源权限与附件路径、素材递归、完成与冻结计划路径，以及 Python worker validator 和专项测试；未发现需要再次修改这些冻结源码的阻塞项。审阅范围不覆盖全部既有系统或主集成随后修改的 Flutter 文件。

工作树扫描覆盖 tracked 与未被忽略的 untracked 文件，并对密钥样式、私钥头、含密码数据库 URL、本机已知凭据字节及不应入库的运行时路径做检查。仅记录路径和规则，不打印匹配内容，不读取完整历史，不暂存文件。最新明细保存在被忽略的 `active_agent/output/backend-worker-precommit-secret-scan-20260907.json`。

原始扫描在 Doc Free 的 `docker-compose.affine-docmost.yml` 命中一个数据库 URL 文件规则，实际为两处 Compose 连接配置。安全核对确认密码字段完整地由 `AFFINE_DB_PASSWORD`、`DOCMOST_DB_PASSWORD` 环境变量占位，不包含字面密码，目标均为本文件定义的容器服务；该文件与起点 HEAD 字节一致。该命中明确分类为环境变量占位符，不删除原始命中、不改动既有示例，也不把分类结果描述为扫描证明系统绝无凭据问题。

## 客户端编辑复核补记 · 2026-09-07T10:04:10+08:00

后续只读集成审阅在 `message_edit_dialog.dart` 的新嵌套排版路径与合并卡片编辑路径复现了两个 P2；这次复核晚于前文协议源码审阅。临时复现明确断言当时的错误行为，日志 `/tmp/renji-rich-text-integration-review-repro.log` 的两项通过是缺陷被复现，不是正确行为验收。

1. 在消息编辑里打开「文字格式」后，另一端撤回来源消息。父编辑页已清空并锁定，但嵌套文字排版只观察身份和会话，仍显示旧正文、允许点击完成；返回父页后才显示已撤回。修复为传入来源有效性检查，状态事件及完成动作都重新核对；来源失效时立即清空编辑正文和样式、退出预览、禁用完成，保留过期回调也无法保存。来源随后恢复不能复活这个旧排版页。原有身份、同 principal 重新登录与会话切换清空边界保持不变。
2. 真实合并卡片本体存在时，原编辑检查仍按普通文本要求正文或附件非空，导致不能清空可选附言。编辑对话框现允许结构完整的 `forward_bundle` 卡片保存空正文，同时清除原附言样式；普通文本消息继续拒绝空内容。conversation 的后续提交条件由其集成负责人同步放行真实卡片；实际桌面右键及手机长按入口的专项结果由对应 conversation 记录确认，不能用下面两文件的测试替代。

本次负责的源码仅为 `apps/office/lib/ui/message_edit_dialog.dart`、`apps/office/lib/ui/office_rich_text.dart` 及对应两个测试文件；未并发修改 conversation、office_state 或 message_original，也没有改变后端合同。以上位于 Active Agent，Doc Free 保留这份相同协议交付补记供双方协作查阅。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 消息编辑与富文本两文件专项 | 47/47 | `/tmp/renji-rich-text-source-dialog-fix-tests-final.log` |
| 上述四文件静态分析 | `No issues found` | `/tmp/renji-rich-text-source-dialog-fix-analyze.log` |
| 工作树格式 | `git diff --check` 通过 | 本补记时核对 |

47 项包含新加的 4 条回归：来源撤回后的嵌套编辑清空、嵌套预览清空、通知到达前失效时的完成重查与恢复不复活、真实合并卡片清空带格式附言。前两项同时调用之前捕获的完成回调，确认旧回调不能绕过失效。其他既有测试继续覆盖身份切换、同身份重新登录、会话切换和空普通消息限制。47 是该两文件套件的总数，不与其中 4 条新回归相加。

首次专项因新测试变量保留基类 `TextEditingController` 静态类型而无法读取 `richText` 编译失败，已经修正为实际控制器类型；原始失败日志 `/tmp/renji-rich-text-source-dialog-fix-tests.log` 保留。上表只引用随后完整通过的最终日志。

服务只读复核记录于 `2026-09-07T10:01:05+08:00`，证据 `active_agent/output/backend-runtime-final-readonly-20260907.json`：3218 返回 `/health` 200，认证会话读取声明两项新能力，MCP tools/list 提供三个合并转发工具及发送/编辑富文本 schema，实际源群读到三条富文本。运行进程 cwd 为 Doc Free，启动时间晚于冻结后端源码最后修改，后端与 worker 哈希仍一致。`/health` 本身只有 ok，没有 commit 指纹，不能宣称它直接证明了运行源码的 Git SHA。

本补记以后这四份客户端文件保持冻结；主集成继续执行最新全量 Flutter、原生 macOS、模拟器与跨端验收。本节 47 项不代表这些工作已完成，也不替代331后端、25 worker或真实模型能力评测。最终 commit、实际时间和描述仍由主集成随后从真实 Git 读取并统一记录，本处不猜填。

## 尚未完成的目标边界

- 主集成负责最终 Mac 登录、真实 UI 点击、截图对比、移动端实际交互及最终版本 Flutter 检查；协议测试不能替代这些验收。
- 合并转发「创建群聊并转发」等剩余参考路径仍待补全；客户端未知提交意图当前保存在 OfficeState 生命周期中，应用进程退出后的持久恢复仍待实现。
- 整个会话旧 Markdown 导出、自动模型上下文与共享卡片全面展开，以及文档源样式完整视觉排版仍待补齐。
- 短信、电话等外部通知提供器仍未配置。实际大模型持续主动多动作工作的可靠性需独立评测；本批没有调用用户临时模型配置。
- 全量飞书基础功能、全部企业后台页签与管理工作流、macOS / Windows / iOS / Android / Web 五端完整验收和生产签名、公证、发布尚未据此完成。
- iPhone 镜像连接是系统会话，不能保证永久不掉线；真机镜像观察、模拟器检查和桌面检查分别记录，不能互相替代。

最终交付时由主集成填写真实 commit、时间、描述、最新终端检查与新共享文档 ID / revision / 内容读回证据；当前附录不覆盖或冒充既往交付记录。


## 最终实现提交索引

| 仓库 | 最终实现 commit | 实际 Git 时间 | 描述 |
| --- | --- | --- | --- |
| Active Agent | `7570ac2d81b119f14280fc4bf9866151b57e1059` | `2026-09-07T10:27:19+08:00` | `feat(office): align native composers and share rich conversation records` |
| Doc Free | `c34de6ac2e3ec67c7f10f3ef6e2090438d2598a0` | `2026-09-07T10:18:02+08:00` | `feat(im): preserve rich text across native actions and merged forwards` |

本文件中的早期专项或草稿状态按其记录时间保留。最终验证、原生实点与发布范围统一见 `COMPOSER_RICH_TEXT_MERGED_DELIVERY_1027.md`；本批最后Flutter全量为636/636，静态分析无问题。
