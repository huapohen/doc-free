# 2026-09-07 15:04：原生壳集成回归、置顶头像与 Agent 真编辑区

- 写入时间：2026-09-07T15:06:46+08:00；文档名的 1504 标识本轮验证批次。
- 分支：`equal_rights`。
- 已提交基准：`1774c284ba41d5db71ed77a4b905bd3db1c0369f`，提交时间 `2026-09-07T12:18:30+08:00`，描述 `docs(office): record mobile group fidelity and native verification limits`。
- 本文记录上述基准之后的工作树集成验证；基准不是本轮最终实现提交。

## 实际验证结果

六个文件共 52/52 通过：`shell_interactions_test.dart`、`profile_navigation_test.dart`、`desktop_navigation_test.dart`、`desktop_navigation_collapse_test.dart`、`workbench_navigation_test.dart`、新增 `shell_mobile_fidelity_test.dart`。完整日志 `/tmp/renji-shell-integrated-final.log`。

本组运行实际 `ActiveOfficeApp`、`OfficeShell`、真实会话行、导航器、Agent 协作面板和编辑区 Widget，状态服务由受控测试实例提供。它能证明 UI 与实际编辑区的连接及正确动作目标，不替代 HTTP 服务、多端同步或原生截图验证。

## 新增五项完整链路

1. 手机长按来源会话，选择置顶，只对来源 `/rooms/room-demo/preferences` 写入 `pinned: true`；打开菜单本身不选中该会话。顶部头像区随后出现来源头像，点击后进入来源会话及其编辑区。
2. 桌面右键执行相同链路。审查中发现旧桌面头像区按收藏而手机按置顶筛选，已通知主任务；主任务统一使用置顶辅助函数后，本回归通过。
3. 手机以 Agent 身份登录，先在来源群聊输入草稿、切到另一会话，再从来源行进入 Agent 超级入口。真实 Agent 协作面板挂载后，选择指定 `agent-demo` 的 `@ 协作`，来源群聊编辑区出现提及，原草稿保持。
4. 桌面以 Agent 身份执行相同链路。切到另一会话不带来源提及，返回来源时草稿和提及仍在，且一次性入口不会再次弹出面板。
5. 来源会话加载尚未结束时发生身份代次变化，完成旧加载不会为新身份打开 Agent 面板，也不会给新会话添加旧提及。

## 本轮布局变更后的选择器调整

- 手机 More 已改为应用网格，移出底栏的云文档按 `mobile-more-open-docs` 验证可见且可点击，继续验证底栏排序保存与重新挂载后的持久偏好。
- 手机“我的”的组织名限定在 `mobile-profile-layout` 内验证，避免把后方壳头部相同组织文字算入面板。
- 设置“通用”内的“编辑底栏”保留其真实设置入口；不使用 More 网格的编辑按钮 key 去查找设置页面。
- 工作台已在壳中展示手机头部。手机独立重复的“搜索应用”不再存在；集成回归改为验证相同工作台 State、相同滚动位置对象和打开前后偏移保持，独立全局搜索入口可达。桌面仍验证相同搜索控制器及查询文字保留。
- 工作台内会话应用继续校验被其它应用、More 覆盖时停止可见状态，上层返回后恢复；没有删除回退、身份隔离或保留页面 State 的断言。

独立 `workbench_navigation_test.dart` 仍覆盖非嵌入入口的移动应用搜索与滚动保留，以及主任务新接入的真实最近使用记录时机。

## 失败历史与边界

首次集成编译被 `OfficeState` 两处返回结果集合错误推断为 void 阻断，负责状态的并行任务修复后继续。证据 `/tmp/renji-shell-integrated-before.log`。

下一轮 42 项通过、5 项旧布局选择器失败，证据 `/tmp/renji-shell-integrated-layout.log`。新增链路首轮 3 项通过、2 项因为当前 Agent 身份与另一 Agent 各有一个 `@ 协作` 按钮导致选择器歧义；选择明确的协作伙伴后完成验证，证据 `/tmp/renji-shell-mobile-fidelity-before.log`。

五文件 analyze（最终 quick menu、其测试及本轮三个测试文件）无问题，`/tmp/renji-shell-fidelity-analyze.log`。

本子任务未修改壳、操作 GUI、热加载应用或提交代码。macOS/iOS 的登录、真实点击与截图由主任务负责。不得将本轮 52 项通过描述为全部 IM、所有飞书页面或五个平台交付完成。
