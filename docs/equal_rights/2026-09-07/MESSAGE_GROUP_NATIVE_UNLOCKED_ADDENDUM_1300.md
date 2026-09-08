# 消息分组原生解锁复验补记 · 2026-09-07 13:00

记录时间：2026-09-07T13:04:20+08:00，Asia/Shanghai。分支：`equal_rights`。本文件是新增补记，保留此前交付文档、协作文档、原图和锁屏阶段结论，不覆盖历史记录。

本日 Mac 恢复解锁、iPhone 镜像重新连接后，主任务实际操作了已运行的人机 macOS 客户端、iPhone 模拟器及真实飞书 iPhone 镜像。分组入口、编辑器往返、四种规则、取消不落盘、标签新建取消，以及桌面消息右键创建显式话题，已有原生操作与数据读回证据。本补记由子任务根据主任务操作记录、已存在的截图和 JSON 证据整理；没有再次操作 GUI 或重发写请求。

## 对应实现提交与归属

| 仓库 | 已存在的实现完整 commit | Git 提交时间 | 描述 |
| --- | --- | --- | --- |
| active_agent | `025fd560110c912e134520d41fd65b7a88c4a71f` | `2026-09-07T12:11:05+08:00` | `feat(office): align mobile message groups and native group editor` |
| doc_free | `9cc90648cb8a7b409c3c78d5f89a1546440511c5` | `2026-09-07T11:57:56+08:00` | `feat(im): add native group display rules and explicit message topics` |

这些是本次恢复后的分组与话题复验所对应的已提交实现基准。规则页提示的小幅视觉修正、同期语音和会议工作属于其后的新修改，最终新 implementation commit 由主任务实际提交后在整合记录中汇总引用；本补记不虚构 SHA，也不将上述基准 commit 冒充后续修改的实现提交。本文件写入时尚未提交或发布新协作文档。

此前 [MOBILE_GROUP_FIDELITY_DELIVERY_1213.md](MOBILE_GROUP_FIDELITY_DELIVERY_1213.md) 记载“最终原生截图与点击复验仍待 Mac 解锁”。该限制对当时成立；本补记只追加下面已经完成的原生复验，不把未验证项目一并变更为通过。旧协作文档 `e78eb7f5` 及其发布回执仍保持原样。

## iPhone 模拟器实际操作

| 操作 | 本次观察与结果 |
| --- | --- |
| 登录 | 使用模拟器屏幕键盘完成登录，进入人机消息页面 |
| 分组抽屉 | 实点消息旁的三条杠进入分组；捕获消息选中、标签收起状态 |
| 编辑入口 | 实点抽屉右上角管理图标，退出抽屉后打开“编辑分组” |
| 常用分组 | 打开选择页，将 Agent 单聊加入当前编辑草稿，返回编辑器 |
| 消息展示规则 | 实际进入四选项页面；四种模式均显示，选择 important 对应的“有重要新消息时展示”后返回上层 |
| 主编辑器取消 | 取消最外层编辑；通过操作前后 API JSON 验证，没有将 Agent 常用或规则草稿持久化 |
| 标签 | 展开标签层级，进入新建标签表单，然后取消；未把打开表单写成“已成功创建标签” |

四项规则在原生页面上可见，不等于四项均已分别保存到后端并逐项验收。本次路径明确是“选择 important → 返回 → 取消主编辑器”，验证重点是层级往返与草稿隔离。最终保存、跨身份同步及更多组合沿用对应自动化证据，不冒充本次新增的原生操作。

### 取消后的持久化证据

读取本机已有 JSON 后，逐字段比较结果如下：

| 字段 | 操作前与操作后 |
| --- | --- |
| `principal_id` | 相同 |
| `revision` | `5 → 5` |
| `order` | 完全相同 |
| `hidden_ids` | 完全相同 |
| `shortcut_ids` | 完全相同，均为 4 项 |
| `message_display_rules` | 完全相同 |
| 整个 JSON 对象 | 全等 |

证据文件：

- `active_agent/output/group-native-preferences-before-unlocked.json`
- `active_agent/output/group-native-preferences-after-unlocked.json`

两份文件原始字节的 SHA-256 均为 `4ebed959fc1d9552ae205f20050c0fe3ee6838657897e788abd832875f12ab90`。这证明该原生编辑取消路径没有改写这些分组偏好字段；不推断无关服务数据、所有账户或其他操作也均未改变。

## macOS 客户端实际操作

主任务已登录人机 macOS 客户端，实点三条杠展开与收起分组，确认按钮位置随当前栏布局移动；打开分组编辑器后取消返回。以下原生截图均已保存：

- `output/renji-macos-groups-expanded-native-unlocked.png`
- `output/renji-macos-groups-collapsed-native-unlocked.png`
- `output/renji-macos-group-editor-native-unlocked.png`

另外，主任务在原生消息右键菜单中对既有 `Stable toolbar 0907` 消息执行“创建话题”，随后通过 API 读回真实话题。这一操作建立显式话题锚点，未发送额外话题回复。

| 读回字段 | 实际值 |
| --- | --- |
| 操作来源 | macOS native message context menu / 创建话题 |
| 记录时间 | `2026-09-07T12:55:22.691404+08:00` |
| 服务端创建时间 | `2026-09-07T04:54:18.320Z`，即本地 `12:54:18.320+08:00` |
| 话题 ID | `topic-32882bf0-940f-4db4-933e-e40b128e0e1e` |
| 话题 revision | `1` |
| 根消息 ID | `msg-2a24e614-032a-4617-a9c1-ea43d0f56599` |
| 根消息内容 | `Stable toolbar 0907` |
| `source_api_readback_passed` | `true` |
| `sent_reply` | `false` |

数据证据为 `output/group-native-topic-ui-readback-unlocked.json`。界面证据为 `output/renji-macos-topic-context-native-unlocked.png` 与 `output/renji-macos-topic-created-native-unlocked.png`。这些只证明本次已有消息的创建话题流程已从原生 UI 走到真实服务；不扩大为话题重命名、删除、独立已读游标或所有消息类型都已完成原生测试。

## 真实飞书镜像参考与原生截图对照

恢复后重新捕获真实飞书分组抽屉、编辑分组和四项规则页面。可信分组参考采用 `feishu-mobile-groups-verified-live-unlocked.png`；较早同批的未带 verified 文件保留历史，不作为取代该可信状态的依据。

| 页面 | 人机原生截图 | 飞书真实 Mirror 参考 |
| --- | --- | --- |
| 分组抽屉 | `output/renji-mobile-groups-final-native-unlocked.png` | `output/feishu-mobile-groups-verified-live-unlocked.png` |
| 编辑器 | `output/renji-mobile-group-editor-native-aligned-unlocked.png` | `output/feishu-mobile-group-editor-live-unlocked.png` |
| 四项规则 | `output/renji-mobile-group-rules-native-unlocked.png` | `output/feishu-mobile-group-rules-live-unlocked.png` |
| 常用分组选择 | `output/renji-mobile-group-chooser-native-unlocked.png` | 本次以实际交互核验返回路径 |
| 标签展开 | `output/renji-mobile-groups-labels-native-unlocked.png` | 本次以实际交互核验表单和取消 |

已打开并核查的局部对照图：

- `output/renji-feishu-mobile-groups-verified-native-unlocked-live-focused-comparison.png`
- `output/renji-feishu-mobile-group-editor-native-unlocked-live-focused-comparison.png`
- `output/renji-feishu-mobile-group-rules-native-unlocked-live-focused-comparison.png`

相应 `*-full-comparison.png` 完整对照也保留。原生截图与组件渲染分别命名，本补记没有用旧 widget 渲染代替原生客户端。

本次人机手机窗口截图为 `336×732`，上述飞书 Mirror 参考为 `318×701`，macOS 展开/收起截图为 `1043×751`。这些尺寸来自现存文件，并非声称捕获了 iPhone 3 倍设备密度的原始 framebuffer。并排比较需要统一可比区域和缩放；状态栏、水印、光标、窗口裁剪、字体抗锯齿与两边实际账户内容会影响像素。没有根据整幅图片给出未计算的相似率或“逐像素完全一致”结论。

对照中，分组抽屉的层级、消息选中背景、标签折叠与编辑器主要结构已有原生依据。图标字形、描边和局部间距仍存在可见差异。首轮规则页截图含人机独有的“完成后应用当前选项”提示，导致列表起点与飞书不同；该 P2 已完成代码修正及主任务原生重拍。首轮图片保留为修前证据，新的修后证据与比较见下方闭环补充。

## 验证边界与后续引用

本补记解除的是此前因锁屏而缺失的上述登录、分组往返、取消读回、真实 Mirror 对照及 UI 创建话题证据。尚未据此宣称：全量飞书办公功能复刻完成、Android/Windows 同轮原生交互通过、所有规则真实保存路径通过、所有图标达到像素一致，或语音录制/播放原生通过。

尤其是同期语音服务，即便已有代码、自动化测试和 Web 编译，也须另记实际平台、构建版本、权限操作、录制、试听和发送读回证据。这里的“原生通过”只限定于已逐项列出的分组与话题路径。

最终新实现 commit 和统一交付结论，由主任务在新整合文档中补充。此补记已在 active_agent 与 doc_free 两库保存同名副本；不修改 `design-qa.md`，不发布真实账户截图，截图与 API 证据仍留在本机被忽略的 `active_agent/output/`。


## 2026-09-07T13:20:06+08:00：规则提示 P2 的原生重拍闭环

主任务重新捕获 `output/renji-mobile-group-rules-final-native-unlocked.png`（336×732，与修前使用相同窗口 crop），实际查看页面并确认提示已转为辅助功能 Help，不再占据可见行。本补记任务也打开了修后原图、同一飞书规则原图、完整并排图和局部并排图：标题、说明、四项规则及选中状态仍可见，多余可见提示消失。

- 修后完整图：`output/renji-feishu-mobile-group-rules-final-native-unlocked-live-full-comparison.png`。
- 修后局部图：`output/renji-feishu-mobile-group-rules-final-native-unlocked-live-focused-comparison.png`。
- 修前/修后/参考三栏历史：`output/renji-feishu-mobile-group-rules-native-unlocked-before-after-reference.png`。
- 生成脚本与校验信息：`output/group-rules-final-native-compare.py`、`output/group-rules-final-native-comparison.json`。

人机窗口取 `[22,75,315,714)`，Mirror 取 `[8,38,310,694)`，各自归一到402×874；局部取 `[0,65,402,370)`。仅裁剪与LANCZOS整体缩放，没有逐控件扭曲或移动图像来制造一致。第一个蓝色单选标记的采样中心相对参考纵向差，修前约 +22.38，修后约 -4.89 个归一截图像素；修后的约5像素差异保留为 P3，与截图缩放/抗锯齿一并说明，不声称原生逻辑像素精确一致。

限定“移动分组 drawer / editor / rules”的视觉复验已补齐先前缺失的修后证据。字体与间距的其他 P3、不同真实标签/规则状态仍明确保留。用户随后指出的全局手机字号和身份头像问题属于另一轮 P1 修复，不能用这里的分组闭环替它验收；本段也不声明语音原生通过。

根 `design-qa.md` 的先前 blocked 原文已另存 `docs/equal_rights/2026-09-07/DESIGN_QA_BEFORE_NATIVE_GROUPS_1320.md`（两库同名副本），本任务未覆盖根文件。候选新 QA 仅保存在忽略目录 `output/design-qa-native-groups-draft.md`，由主任务决定最终整合。
