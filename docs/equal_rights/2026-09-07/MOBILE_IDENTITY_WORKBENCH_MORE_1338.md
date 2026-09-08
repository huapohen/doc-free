# 2026-09-07 13:38：移动身份视觉、工作台与更多面板校准

- 记录时间：2026-09-07T13:37:45+08:00。
- 工作分支：`equal_rights`。
- Active-Agent 已提交基准：`1774c284ba41d5db71ed77a4b905bd3db1c0369f`，时间 `2026-09-07T12:18:30+08:00`，描述 `docs(office): record mobile group fidelity and native verification limits`。
- doc_free 已提交基准：`55967f5234568d80cee36d836f06b942cb3db0b1`，时间 `2026-09-07T12:18:30+08:00`，描述 `docs(im): publish mobile group fidelity protocol and delivery receipt`。
- 本文记录上述基准之后的工作树实现。基准 SHA 不是本轮实现提交；最终集成 commit 由主任务收尾时记录。

## 参考与范围

本轮已实际打开用户提供的 `automation/2026/04_09/3/05/input/img/9.png`、`10.png`，以及主任务取得的 `output/feishu-mobile-workbench-font-reference-1314.png`、`output/renji-feishu-messages-font-before-1310.png`。参考覆盖移动工作台、底栏更多面板和身份头像；企业私有内容与参考截图仅保存在被忽略的本地输出目录。

消息列表、聊天正文、设置、壳头部的字号由并行任务负责，详见 `MOBILE_TYPE_AND_VOICE_DIAGNOSTIC_1316.md`。本轮不再次改变已经校准的消息分组字号。

## 身份与文字

`PersonAvatar` 的身份容器统一为圆形，覆盖人、Agent 和群身份。`CompanionAvatar` 同样采用圆形身份背景，保留机伴独立的动态光标与减少动态效果设置。应用图标、应用卡片和产品标志仍使用圆角方形。

沿用共享 `officeFontSize` 以整页宽度区分移动端和桌面端，不以桌面窄列误判为手机。手机的通讯录、Agent 商店、Agent 好友分类树等主要名字与分类行采用 17，次级内容采用 14，计数/标签采用 12。桌面原有字号保留。职业身份与机伴说明在手机使用 14。

## 移动工作台

`OfficeAppWorkbench` 和 `OfficeWorkbenchNavigator` 均增加可选 `embeddedMobileHeader`，默认 `false`。当壳已显示头像旁工作台标题时传入 `true`，手机工作台不再重复绘制自身标题与搜索行；独立入口继续保留这行。

- 增加 16 字号的“工作空间头条”，分区标题 17，应用名称 12。
- 手机应用图标由 40 调为 52 逻辑像素，圆角方形；桌面维持 34。
- “我的常用”右侧采用添加、排序图标按钮，保留可访问提示与原有真实编辑弹窗、取消及保存行为。
- 修正云文档、邮箱、打卡等已有目的地的图标与颜色映射，点击继续通过实际路由回调。
- 四列网格依据用户字号计算行高，保证两行长名称在 320 宽、130% 字号仍可显示，不因加大图标产生纵向溢出。
- 手机头条卡片使用最小高度而非固定高度，长文案随可用宽度展开。卡片保留人机自己的文案和状态数据。

## 手机更多面板

新增 `OfficeMobileMorePanel(items, recentItems, onOpen, onEditNavigation)`。壳负责将当前身份有权访问的目的地与真实最近使用记录传入，组件不从收藏或应用目录虚构历史。

- “最近使用”按传入顺序、稳定 ID 去重，主页最多展示四条。
- 无真实记录时明确显示“打开应用后，会在这里显示最近使用。”
- “全部”在面板内展示完整真实记录，返回按钮回到主面板。
- “更多”下方为四列 52 像素圆角方形应用图标，保留 Agent 目的地的实际打开回调。
- “编辑”使用导航编辑回调。组件不另画重复的顶层“更多/关闭”标题。
- 灰色面板背景为 `#f4f4f6`。常规行/分区文字 17，应用名称 12，网格支持 320 宽及 130% 字号。

底栏保持可点击、再次点击更多关闭、背景层与 Escape/系统返回由既有 `mobile_more_menu.dart` 与壳负责；主任务在集成时验证。真实最近打开的记录、身份切换隔离与持久化也属于壳/状态实现范围，不应把本组件测试误认为已经覆盖了存储和后端。

## 验证

最终定向测试 `mobile_more_panel_test.dart`、`workbench_mobile_layout_test.dart`、`workbench_navigation_test.dart`：23/23 通过，日志 `/tmp/renji-workbench-more-tests-final.log`。

测试覆盖真实最近条目去重/顺序/四条截断、全部/返回、空历史、Agent 入口与导航编辑回调、小屏与大字滚动无溢出、嵌入头部避免重复、独立页面保留搜索、收藏添加/排序弹窗取消不改状态，以及人和 Agent 的应用返回、关闭、身份切换隔离等既有回归。

本轮涉及的十个源文件及测试文件定向 analyze 无问题，日志 `/tmp/renji-workbench-more-analyze-final.log`。前一轮身份/字号与工作台布局回归为 38/38，通过，日志 `/tmp/renji-avatar-mobile-type-regression-final.log`。

工作台/更多生产源已冻结交给主任务集成。本子任务未操作 GUI、重载应用或提交代码。本文写入时，工作台与更多的最终实机 after 截图尚待主任务取得；不以 widget 测试证明完整像素一致，更不据此宣布全 IM 或五个平台完整交付。
