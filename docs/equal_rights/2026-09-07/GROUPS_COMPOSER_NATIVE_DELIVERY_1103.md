# 消息分组按钮迁移与手机输入稳定性 · 2026-09-07 11:03

这是本轮新增交付文档，保留此前所有协作文档与历史结论。分支为 `equal_rights`。本次完成两个明确问题：分组展开后按钮移到分组标题旁；手机输入文字时不再插入发送图标挤动工具行。全量飞书办公 IM 复刻与所有生产终端仍是持续目标。

## 实现版本

| 项目 | 实际 Git commit | Git 提交时间 | 描述 |
| --- | --- | --- | --- |
| Active Agent 本次实现 | `c28c5422fa67b5b6490d206f3f05b26a70e9286d` | `2026-09-07T10:59:56+08:00` | `fix(office): relocate group toggle and stabilize mobile composer tools` |
| Doc Free 沿用的最近实现，本次无服务端修改 | `c34de6ac2e3ec67c7f10f3ef6e2090438d2598a0` | `2026-09-07T10:18:02+08:00` | `feat(im): preserve rich text across native actions and merged forwards` |

Doc Free 本轮开始时 HEAD 为 `6f4f8be7b43075a93db8d30a441d34508eef9276`，本轮仅同步交付文档。代码实现与后续文档提交分别记录，避免使用不存在的自引用提交号。

## 飞书真实操作与对应行为

主任务在已登录的飞书桌面端与 iPhone 镜像实际点击开关，观察展开和收起两个状态，再在人机电脑端和 iOS 模拟器重复操作。参考应用没有发送消息；手机输入的参考草稿已清空。

| 端 | 收起状态 | 展开状态 | 关闭动作 |
| --- | --- | --- | --- |
| 桌面 | 三条杠在“消息”左侧 | 三条杠在“分组”左侧，“分组”右侧保留齿轮；独立消息标题不重复显示开关 | 点击分组标题左侧三条杠，回到消息标题旁 |
| 手机 | 三条杠在消息筛选行旁 | 左侧分组抽屉标题在左，三条杠在右；原入口隐藏 | 标题按钮、遮罩、选择分组后关闭并恢复原入口 |

人机桌面新构建实点中，展开和收起开关均位于窗口坐标 `(203,68)`。保留筛选状态、分组管理和标签入口；桌面选择筛选后保持面板，手机选择后收起。测试同时覆盖身份变化、旧回调、重复打开和嵌套页面取消。

手机输入栏的常用行固定为表情、@、麦克风占位、图片、Aa、Agent、+；Aa 行同样保持固定。普通紧凑输入使用系统键盘发送；展开编辑器保留自身发送入口。发送仍执行草稿可发送检查、IME 候选检查、身份与会话范围检查、重复提交保护。硬件快捷键配置保持有效。

## 原生验证与像素证据

手机模拟器使用 iPhone 17 / iOS 26.5，保留一个设备及 Flutter 开发会话。实际打开软件键盘，完成普通行输入、清空、Aa 行输入和清空；点击蓝色发送键向本机合成群发送验证消息。

- 唯一验证消息：`msg-2a24e614-032a-4617-a9c1-ea43d0f56599`，revision 1，文本 `Stable toolbar 0907`。服务端读回只匹配到 1 条，发送后草稿清空、键盘保持打开。证据 `output/groups-composer-native-send-1051.json`。
- 普通行空→输入：同坐标 330×40 裁切共 13,200 像素完全一致，7 个图标中心位移 0px。
- 普通行空→清空：排除鼠标及阴影后 11,280 像素变化为 0，6 个可见图标中心位移 0px。
- Aa 行空→输入：排除鼠标及阴影后 10,160 像素变化为 0，6 个可见图标中心位移 0px。被遮挡图标不计入该组结论。

原生截图稳定性不是“飞书与人机所有像素相同”的证明；人机额外 Agent 入口、字体与部分图标轮廓仍存在差异。参考合成图只保留标题或输入局部，避免收录私人聊天。

局部证据：`output/mobile-native-toolbar-stability-1057.png`、`output/mobile-feishu-footer-reference-1057.png`、`output/mobile-native-toolbar-metrics-1057.json`；分组最终电脑截图 `output/renji-desktop-groups-final-open-1057.png` / `output/renji-desktop-groups-final-closed-1057.png`，手机截图 `output/renji-mobile-groups-open-1053.png` / `output/renji-mobile-groups-header-closed-1053.png`。原图保存在本机忽略目录，不进入公开 Git。

## 验证结果

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| 当前源码 Flutter 全量 | 662/662 通过 | `/tmp/renji-groups-composer-full-tests-1054.log` |
| 当前源码静态检查 | No issues found | `/tmp/renji-groups-composer-analyze-1054.log` |
| 手机输入专项 | 43/43 通过；8 个位移用例先复现失败再修复通过 | `/tmp/renji-mobile-send-stability-final.log` |
| 分组位置及原分组/折叠专项 | 38/38 通过 | `/tmp/renji-group-toggle-tests-final-1052.log` |
| macOS debug 构建、重新登录与开关实点 | 通过 | `/tmp/renji-groups-composer-macos-run-1056.log` |
| Web 构建 | build/web 成功 | `/tmp/renji-groups-composer-web-build-1058.log` |

全量输入指纹 `5f0a3d5027ccadb8bfef7597fdca5fa6b5e8c4d21346ea37b0511c15ec606368`，覆盖 135 个 Dart 源码、测试和依赖声明文件。机器验证摘要为 `output/groups-composer-final-verification.json`。独立子智能体只读复核未发现阻塞问题。本轮未修改后端、未发起大模型调用，不重复宣称后端历史测试为本次新测试。

## 开发运行中发现的边界

旧 iOS 输入框在热加载时已保持焦点，Flutter 3.47.2 的现有原生输入连接可能保留原 newline 配置；退出会话重新进入后蓝色发送键生效并实际发送成功。没有通过每次输入重建控件来规避问题。

旧 Mac 调试进程热更新时出现 Flutter AXTree pending node 错误，导致后续自动点击失败。已退出该进程、新构建启动并亲自登录，在新进程实际完成展开→收起→再展开。该记录区分旧调试运行问题与新构建验收。

Android、Windows、实体手机第三方输入法与旋转场景本轮未新增原生实测；Web 是构建验证。生产签名、公证、全量办公能力、语音和真实外设控制继续保留为未完成事项。

## 后续文档交付

本文件将在公司协作群创建为一份新文档，保留包括 `022b8553` 在内的旧文档 ID、版本与内容哈希。创建结果与人类、管理员、员工、Agent 读取及非成员拒绝结果，由单独发布回执记录。此前共享文档不被覆盖。

更多专项：`GROUP_HEADER_TOGGLE_1053.md`、`MOBILE_COMPOSER_SEND_STABILITY_1044.md`、`MOBILE_NATIVE_KEYBOARD_VERIFICATION_1052.md`、`MOBILE_NATIVE_TOOLBAR_PIXEL_AUDIT_1059.md`。
