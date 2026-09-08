# 手机消息分组面板 · 截图校准记录

记录日期：2026-09-07（Asia/Shanghai）。最后源码改动：2026-09-07T12:08:57+08:00。分支：`equal_rights`。

本轮基准 HEAD 为 `02f740fd39645e15e199e3d635da6cb35c772442`，提交时间 2026-09-07T11:07:43+08:00，描述 `docs(office): record native group toggle and stable input verification`。本报告记录该基准之后的手机分组面板增量，最终实现 SHA 由本批主交付文档记录，不能将基准当成实现提交。

原根目录 QA 已原样保存在 [DESIGN_QA_BEFORE_MOBILE_GROUP_PANEL_1205.md](docs/equal_rights/2026-09-07/DESIGN_QA_BEFORE_MOBILE_GROUP_PANEL_1205.md)。历史输入区通过结论仍仅覆盖其原有范围，不被本轮替换或扩大解释。

## 当前结论与阻断

手机分组面板已完成两轮布局校准和一次授权库图标纠偏。最终 widget 同状态截图没有继续发现需要扩大布局修改的 P1/P2；44 项交互回归与所属文件分析通过。**第二轮原生实机/模拟器截图和点击复验尚未完成**：主任务在 12:05 再次确认 Mac 仍处于系统锁屏。widget 渲染不代替原生验收，不将已有第一轮原生截图冒充最终原生结果。

依据 [design-qa SKILL.md](/Users/lwblx/.codex/plugins/cache/openai-api-curated/product-design/1e285826/skills/design-qa/SKILL.md) 的要求：“If either artifact cannot be opened, captured, or compared, write `design-qa.md` with `final result: blocked` and name the blocker.” 本轮有可打开的参考和 widget 渲染，但用户要求的最后原生状态仍无法捕获，所以保留 blocked。系统解锁后需完成原生复验再更新结论；这不是要求重新授权已允许的开发工作。

## 视觉真值、视口与状态

- 真值：`/Users/lwblx/huapohen/agent/automation/2026/04_09/3/05/input/img/5.png` 的**右侧真实手机**。左侧旧人机模拟器是待修实现，不能作为目标。
- 右侧屏幕裁剪 `[654,14,1257,1324)`，603×1310 像素，归一为 402×874 逻辑视口。
- 主任务确认 iPhone 17 display 为 1206×2622，3 倍密度，对应 402×874。
- 第一轮原生 `output/renji-mobile-panel-first-native-1137.png` 的屏幕裁剪为 `[22,75,315,714)`，293×639，归一为 402×874。原生窗口经过缩放，不能将窗口像素误当逻辑像素。
- 最终实现捕获：`output/message-group-widget-render-402-1212.png`，生产 Flutter widget 树、402×874 视口、顶部/底部安全区 62/34，以 `toImage(pixelRatio:3)` 输出 1206×2622；比较时下采样为 402×874。
- 最终比较状态：浅色、手机分组 drawer 打开、消息选中、标签收起。fixture 采用真实服务端协议形状，包含 labels/documents/topics；它不证明联网或原生数据刷新成功。
- 系统状态栏、设备圆角与 Home Indicator 由系统负责，widget 图没有这些 chrome。参考右侧聊天区被遮盖；用户红色“镜像真机”批注与水印不当成需要实现的 UI。
- 真实账户截图只留在被忽略的本机 `output/`，不提交或嵌入公开文档，不公开真实会话信息。

## 全图与局部对比证据

已实际打开并排图进行判断，没有以分别读图的记忆代替同图比较。

| 轮次 | 完整并排图 | 用途 |
| --- | --- | --- |
| 第一轮原生 | `output/message-group-mobile-full-compare-first-1139.png` | 发现面板偏窄、首行下移、内容偏右、正文字号略小 |
| 第二轮 widget | `output/message-group-mobile-full-widget-compare-1155.png` | 核对布局纠偏，暴露矩形未读/完成、错误话题符号等图标差异 |
| 最终 widget | `output/message-group-mobile-full-widget-compare-1212.png` | 同消息选中/标签收起状态，查看完整组成与上下白底 |

最终局部并排图为 `output/message-group-mobile-focused-widget-compare-1212.png`，分别取归一屏幕 `[0,62,322,622)`，排除系统 chrome 和用户红字，检查标题、10 条分组、文字锚点与图标。中间 `1210` 图保留，用于记录单聊/群组 glyph 从 22 调至 26 后的墨迹尺寸纠正；行尺寸未变。旧 `1155` 和第一轮原生证据均未覆盖。

## 发现、纠偏历史与残差

| 级别 | 之前的问题与证据 | 修复及后续证据 | 当前状态 |
| --- | --- | --- | --- |
| P1 | 用户图5显示旧面板整体字号、留白、行节奏与真机明显不符；安全区灰色 | 白色 Material 全高，内部 SafeArea；402 宽时 drawer 为 80%；最终 full/focused 图检查 | widget 已修复，原生复验 pending |
| P1 | 第一轮原生正文偏右约 7–8、首行下移约 11、drawer 窄约 8 个归一像素 | header 左26/上4/右12/下5，list 左10/右8，正文17，49行高/47选中底 | 第二轮及最终 widget 改善，非原生最终通过 |
| P1 | 旧手机右上图标被误判为“收起”；之前标题局部测试掩盖用途错误 | 真机重新点击确认是管理入口；旧抽屉退出后再打开编辑；旧回调不得 pop 新页 | 专项覆盖正常管理与身份/路由代次保护 |
| P2 | 1155图中未读/完成为矩形气泡、标记为错形旗、话题为感叹号 | Solar 圆气泡未读/完成、Tabler 三角缺口旗与文本气泡；最终1212同图对照 | 明显用途及轮廓差异已改善，细部见P3 |
| P2 | 去掉常驻 + 后，空标签没有可发现的创建入口 | 默认折叠；展开标签尾部保留“新建标签”，调用真实创建流程 | 新专项验证空标签→创建→列表出现 |
| P3 | 各库描边、未读空心圆点、完成勾/气泡闭合方式与真机不同 | 使用已有许可库最接近素材，没有手绘路径 | 明确保留，不声称像素完全相同 |
| P3 | 单聊/群组胸像、云文档折角、话题气泡角的位置与参考有细部差异 | Material 平底胸像增至26，使墨迹尺寸更接近；行尺寸不变 | 后续精修，当前无布局阻断 |

## 五项视觉检查

| 视觉面 | 实際检查与结果 |
| --- | --- |
| 字体 | 标题20半粗、正文17/1.25行高；已比较字重、换行、锚点。widget 显式加载本机 PingFang SC、SFNS 和 Flutter MaterialIcons，避免 Ahem 豆腐字；系统字体只本机读取，不复制到项目。中文字形抗锯齿仍可能与原生 iOS 不同，需要最终原生图确认。 |
| 间距 | drawer 80%，手机 list 左10/右8，行内左14、图标列24、图文间12；49行高，选中底47，圆角6；白底覆盖安全区。最终 full/focused 看过完整区域与行节奏。 |
| 色彩 | 未选中 `#767c82`，选中底 `#e9efff`，选中蓝使用既有 accent；浅灰图文和浅蓝背景已并排核对。参考水印不参与灰度指标，不伪造整图相似率。 |
| 图像与图标 | PNG 由原库 SVG 转为96×96透明图，运行时缩放着色；新增Solar/Tabler；单聊/群组使用已有Material glyph。没有以手绘SVG、字符或截图替代真实控件。逐asset来源、SHA与许可证在 `apps/office/assets/message_groups/`；旧asset路径保留。残差按上表P3记录。 |
| 文案与内容 | “消息、未读、标记、@我、标签、单聊、群组、云文档、话题、已完成”按服务端顶级顺序展示；“群组”只改该builtin，未全局替换业务“群聊”。标签默认收起，无常驻加号/手机逐行重复计数；展开有真实新建入口。 |

## 功能验证

最终专项日志 `/tmp/renji-mobile-group-panel-tests-1212.log`：**44/44 通过**。覆盖桌面同位置开合、手机遮罩/返回/选择退出、管理迁移、390/402白色安全区、标签默认折叠及创建、新版容器排序/隐藏、文档话题集合筛选、重开与身份切换防串写。

五文件分析 **No issues found**，日志 `/tmp/renji-mobile-group-panel-analyze-1212.log`。最终 widget 捕获独立日志 `/tmp/renji-message-group-render-1212.log`，该捕获仅1项且不加入业务测试计数。最终全量测试/各端构建由主任务记录。

## 原生恢复后待办

1. 用已授权账户打开最新 macOS/iOS 构建，在手机“消息选中、标签折叠”的相同状态截屏，按屏幕内容区归一后与图5并排。
2. 实点手机管理入口、返回消息、重开分组、标签展开/新建；验证无旧overlay滞留和安全区背景回退。
3. 将新原生证据与实现提交关联，再决定能否把此局部 QA 更新为 passed。

本报告仅覆盖手机消息分组面板；编辑分组细节另见 `docs/equal_rights/2026-09-07/MESSAGE_GROUP_NATIVE_EDITOR_1131.md`。不代表全量飞书、全部五端、语音、生产签名、公证和外设控制已完成。

final result: blocked
