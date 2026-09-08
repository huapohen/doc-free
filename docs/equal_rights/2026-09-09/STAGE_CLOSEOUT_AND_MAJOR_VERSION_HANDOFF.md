# 当前阶段收尾与大版本新分支交接

记录时间：`2026-09-09T01:19:13+08:00`（Asia/Shanghai）。本次按用户“做完当前阶段先停下来，需要一次大版本升级，用新的分支，所以收好尾”的要求整理交接。当前阶段停止开发；下一次大版本从新的分支接续。

## 冻结范围与真实提交

本机两仓当前均为 `equal_rights`，工作区在本次文档收尾前均干净；已通过 `git ls-remote` 核实下列分支 HEAD 与远端一致。

| 仓库／用途 | 完整 commit | 提交时间 | 描述 |
| --- | --- | --- | --- |
| Active Agent：阶段实现 | `80db77eb9badd29c1e8eef527ae1e082c5de58c1` | `2026-09-08T21:43:08+08:00` | `feat(office): add native all-day and recurring calendar workflows` |
| Active Agent：交付基线 HEAD | `0a697c8cf556da0d6913b6e0119f52605c59e5b5` | `2026-09-08T21:50:52+08:00` | `docs: record recurring calendar native acceptance and shared delivery` |
| Doc Free：阶段实现 | `a1b21dccd4b7f35851fec826e841e4de31be4814` | `2026-09-08T21:26:11+08:00` | `feat(calendar): add all-day recurring events and native occurrence protocol` |
| Doc Free：交付文档 | `e03dd326ee5ef8f2272b0723d5aece575bebc24e` | `2026-09-08T21:50:53+08:00` | `docs: publish all-day recurrence protocol and phase acceptance` |
| Doc Free：收尾前 HEAD，保留后来教程 | `e3ca34dab9e51e78d368afe55f0f8a4b05f3adc1` | `2026-09-08T23:23:31+08:00` | `docs: add manual startup and public tunnel guide (2026-09-08)` |

本次收尾只增加交接文档与纠正 QA 入口，其提交位于上述基线之后。新分支应从两仓各自最终收尾提交开始，并成对记录 Active Agent／Doc Free 基线，避免混用不同阶段的客户端与协议。大版本分支名和版本号由下一次升级任务确定；此记录不把已有 `evolve` 或 `main` 当成用户已指定的大版本分支。

## 已交付与证据入口

当前阶段完成全天日程、时区重复规则、有限次数／截止日、单次改期／取消／参与回应，以及共用 HTTP、MCP、A2A、Python SDK。人类界面与 Agent 操作进入同一权限、版本和持久化模型。

- [阶段正文，含实际原生操作](../2026-09-08/PHASE4_CALENDAR_RECURRENCE_DELIVERY_2147.md)。
- [共同文档发布回执](../2026-09-08/PHASE4_PUBLICATION_RECEIPT_2150.md)。
- [完整日历协议及边界](../2026-09-08/CALENDAR_RECURRENCE_PROTOCOL_2056.md)。
- [最终视觉比较与保留差异](../2026-09-08/MOBILE_CALENDAR_VISUAL_QA_2145.md)。
- [Mac／iOS 手动启动与恢复附录](../2026-09-08/MANUAL_STARTUP_CALENDAR_ADDENDUM_2130.md)，同时保留其引用的原始教程。
- Doc Free 后来补充的 `freedom/07-manual-startup.md` 包含办公预览、AFFiNE／Docmost 和公网体验说明，属于已有 `e3ca34d` 提交，完整保留。该说明不表示多个文档服务已经自动同步，也不表示新端口或公网隧道当前已运行。

已发布共同文档仍为 `5ddcd4f4`、r1，标题“全天与重复日历阶段验收 · 80db77e · 2026-09-08 21:43”。原发布检查 118/118，17 份历史文档及成员／消息／安全会话元数据保留。本次只读核对其原 JSON 回执、源文件 SHA-256 和仓库中的发布说明一致，没有修改已发布正文。

上阶段测试结论为后端 390/390、Flutter 最后视觉修正前全量 986/986、修正后定向 74/74、Python 23/23；真实协议 23/23、改单次／取消回读 25/25、独立取消最终回读 18/18。986 和 74 覆盖存在重叠，不能相加。这些是 9 月 8 日的验收结果；本次是文档收尾，没有把它们冒充 9 月 9 日重新运行的测试或构建。

## 带入大版本的未完成项

1. 全量飞书页面、桌面右键／手机长按／再次点击、办公后台等仍须逐页建立功能与截图验收清单。当前交付只证明列明的阶段范围。
2. 手机日历已记录残差：周／月格首边界约 25px／42px，时间摘要区约 35–40px，自定义入口留白约 25–30px，以及叠层卡片、圆角、滚轮透视、细线和文案。当前不是像素完全一致。
3. 日历“本次及以后”、完整会议室／农历／提醒／忙闲、多个每月日期组合、外部日历同步等未完成；会议关联日程的全天或重复模式当前有明确限制。
4. 全量视频会议预约、云录制／转写，五端生产构建、签名／公证、可靠的主动多动作执行和云端迁移仍需各自验收。Windows、Android、Web 没有在本阶段重新构建验证。
5. **人工键盘重复输入的系统根因仍未确认。** 此前模拟器中文输入已单独验证，不能用它推断系统双写已解决。下一次恢复电脑控制时，必须保留这个未解决事实，不能宣称鼠标控制已与人类输入完全隔离。

人机同权、Agent 主动能力、Agent 好友／商店、插件和原生通信、Doc Free 文档协作等既有总体目标继续有效；本次收尾不把整体目标缩小为日历，也不宣称所有目标完成。

## 本机运行与数据交接

收尾检查时：`3218`、`1238` 无监听进程；进程清单中没有运行的 Active Office 或 Flutter 调试进程，仅 iPhone Simulator 应用仍在。9 月 8 日“应用已登录并热更新”属于当时的验收状态，不能当作现在服务在线或现在登录状态的证明。本次没有为交接重新启动服务、模型 worker 或操作 GUI。

必须保留以下本机材料：

| 路径（Active Agent 仓库内） | 用途 |
| --- | --- |
| `data/office/` | 现有身份、组织、成员、日历、共同文档和应用持久化数据 |
| `data/office/access.json`、`data/office/test-accounts.json` | 私有登录与测试身份；本次只核对存在、Git 忽略和 0600 权限，不记录内容 |
| `data/office/native-im.json`、`data/office/checkpoints/` | 真实状态与已有检查点；新分支复用前记录基线，避免重置现有账号 |
| `output/phase4-calendar-native-20260908/` | 原生 before／after、回读和跨端证据 |
| `output/phase4-calendar-recurrence-document-20260908.json` | 一次性发布及完整保护范围的回执 |
| `output/phase4-calendar-recurrence-document-20260908.py` | 已执行过的发布器；后续只能读取回执，不重新执行创建 |

真实飞书截图与身份凭据保留在忽略目录，不随公开 Git 提交。两份现有 detached 构建快照 `data/office-build-snapshot/1ae44da`、`2fad0ac` 仍在 Git worktree 清单中，不能误当当前 `equal_rights` checkout 或新大版本分支。

## QA 入口纠正与停止点

Active Agent 根目录 `design-qa.md` 原来还写着 9 月 7 日分组“锁屏／原生未复验”。它已原样归档为 [历史根 QA](ROOT_DESIGN_QA_BEFORE_MAJOR_VERSION_HANDOFF.md)，SHA-256 为 `b8dd9cb7f96edcfbf5fdddb4115758e204c9a5975598ca37f2d15c7ae6e7e7eb`。当前根入口转向 `apps/office/design-qa.md`、本交接及明确的阶段历史，避免下一次工作误读旧阻断。

本次收尾提交完成并推送后，保持当前阶段冻结。后续大版本在新的分支开始；当前任务停止修改代码、操作参考应用或自动进入下一阶段，等待用户启动大版本任务。
