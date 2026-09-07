# 消息分组编辑器：原生布局与消息展示设置

记录时间：2026-09-07T11:32:04+08:00。分支：`equal_rights`。

本轮开始时的代码基线：`02f740fd39645e15e199e3d635da6cb35c772442`，提交时间 `2026-09-07T11:07:43+08:00`，描述 `docs(office): record native group toggle and stable input verification`。

本文件记录基线后的实现与验证。实现提交由主任务统一创建；本文件尚不把基线提交冒充为本轮实现提交。原生应用构建与实机截图由主任务另行核验、补充提交记录。

## 真实参考

主任务通过已经连接的 iPhone 镜像实际打开分组编辑器、点击常用分组加号、点击标签齿轮及单聊齿轮，得到以下参考：

- `output/feishu-mobile-group-editor-verified-1119.png`：编辑分组底部面板。
- `output/feishu-mobile-group-shortcuts-1118.png`：选择常用分组。
- `output/feishu-mobile-group-label-settings-1120.png`：标签的消息展示设置列表。
- `output/feishu-mobile-group-visibility-options-1121.png`：具体标签的四项展示规则。
- `output/feishu-mobile-direct-display-settings-1123.png`：单聊直接进入四项展示规则。

`feishu-mobile-group-editor-stable-1115.png` 和 `feishu-mobile-group-editor-1114.png` 实际捕获了分组抽屉，不作为编辑器参考。此错误在实现前交叉查看图像后已排除。

## 本轮实现

移动端从全屏普通对话框改成顶部留出状态区、圆角顶部、底部铺满的灰色面板。取消、编辑分组标题和保存固定在顶部，较长列表只滚动内容。桌面端保持有固定标题栏的居中对话框。

常用分组改为白色胶囊，消息为固定项，其余胶囊可通过蓝色叉号移除。加号进入独立“选择常用分组”面板，选择后返回上层草稿。列表直接使用当前身份获得授权且可用的分组，保留 Agent 单聊和个人标签，不编造尚未实现的原生服务台等分组。

侧栏使用显示/隐藏区、白色圆角列表、红色减号、固定消息的灰色减号以及右侧拖动柄。拖动不再堆叠额外上下箭头按钮；辅助功能仍提供上移和下移操作。显示状态和常用分组仍分别保存，隐藏分组不会意外删除其常用入口。标签子项仍有独立顺序编辑区。

标签容器齿轮进入个人标签列表；具体标签以及单聊、群聊、云文档、Agent 单聊齿轮进入“消息展示设置”。可选项来自实际参考：

1. 始终显示。
2. 有新消息时展示。
3. 有重要新消息时展示。
4. 始终不展示。

页面顶部为取消和完成，无额外底部保存按钮。带规则的侧栏行呈现当前规则的简短说明。Agent 分组使用同一状态接口和编辑流程。

## 草稿与协议

`OfficeMessageGroups.saveLayout` 新增可选 `messageDisplayRules`。非空参数通过 `PATCH /message-groups` 发送 `message_display_rules`，与 `order`、`hidden_ids`、`shortcut_ids` 共用 `base_revision`。字段省略时保持后端原规则不变，空对象用于显式清空。

规则映射使用稳定分组 ID，取值为 `always`、`unread`、`important`、`never`。具体匹配和个人可见会话过滤由后端执行，UI 不伪造未读或重要消息的结果。

设置页面和标签二级页面各自持有本地草稿。具体标签页“完成”仅合入标签设置页；标签设置页“完成”仅合入编辑器；编辑器“保存”才产生真实写请求。任一层取消均不写后端，取消标签设置页可丢弃其已经完成的标签子页编辑。

版本冲突时保留本地排序、显隐、常用项和已明确改过的规则。读取新版本并采用后，仅以用户改动过的规则覆盖远端值；未编辑的远端规则继续保留。删除的分组从合并草稿移除，新增分组保留。身份切换使编辑器及其已经打开的二级页同时失效，防止将旧身份草稿写入新身份。

## 验证范围

新增 `apps/office/test/message_group_editor_native_test.dart`，通过真实 production widgets/controller、仅替换认证 API transport 的合成 fixture 验证：

- 320、390、1512 宽度的编辑面板、固定操作栏、Agent 常用添加和取消草稿。
- 标签二级设置的逐层完成、逐层取消、最终提交完整规则映射。
- 版本冲突合并保留本地单聊规则与远端新增 Agent 规则。
- 身份切换时二级设置失效且不产生写请求。
- 通过真实拖动手势调整分组顺序，固定消息不移动，Agent 与标签 ID 保留。

原有 `message_groups_test.dart` 继续覆盖私有标签创建/修改/删除、可见会话过滤、旧协议未提供规则字段时的兼容保存、冲突恢复与身份隔离。

这些是 Flutter 组件与状态集成验证，不等同于 iOS、Android、macOS、Windows、Web 五端已逐一构建或原生视觉已经全部等同飞书。最终原生截图、像素对比和往返点击验证由主任务追加，本记录不以组件通过代替实机核验。

最终聚焦验证：`message_groups_test.dart` 9 项 + `message_group_editor_native_test.dart` 7 项，共 **16/16 通过**；上述两个源码文件及新增测试静态分析通过。测试日志：`/tmp/renji-editor-native-tests.log`；分析日志：`/tmp/renji-editor-native-analyze.log`。

## 2026-09-07T11:52:47+08:00：合同复核后的补充修复

只读复核发现：合法 40 字符标签加入常用分组，在 320 宽度下曾出现 352 像素的 RenderFlex 右侧溢出。最小复现保存在 `/tmp/renji_editor_review_long_label_test.dart`，失败日志 `/tmp/renji-editor-review-long-label.log`。现将名称限制在胶囊剩余宽度内，长文本省略显示，关闭按钮保留；独立语义节点和 tooltip 提供完整名称。短名称保持自然宽度。

隐藏标签容器后，若当前选中的个人标签没有独立常用入口，当前选择回到消息；存在该标签的常用入口时仍保留选择。控制器兼容明确的 `parent_id` 与先前已提供 labels 容器的标签响应。

没有显式消息展示规则时，父页摘要显示“跟随其他分组设置”，避免在其他匹配分类限制展示时错误承诺“始终展示”。四选项页保留参考中的四种模式，另说明“完成后应用当前选项”；完成会将当前选项明确写入上层草稿，默认选项为 always。取消不产生显式覆盖。即使完成时选项数值未变化，也会记录这次明确确认，因此后续冲突合并仍保留用户选择。只有最外层保存才持久化。

追加 320/390 宽度 × 普通名称/20 个火箭 emoji/40 个中文字名称，共 6 项布局和完整名称语义/删除快捷入口检查；另加 2 项隐藏标签容器的选择恢复、2 项继承规则完成/取消、1 项显式 always 未变但遇远端冲突的确认测试。现新增文件合计 **18 项**，与原有分组 9 项联合 **27/27 通过**。静态分析通过。日志：`/tmp/renji-editor-followup-regression.log` 与 `/tmp/renji-editor-followup-analyze.log`。

手机新建标签入口缺失已交由负责分组面板的子任务修复；本文件没有修改其源码。

## 2026-09-07T12:05:56+08:00：基于同状态组件截图的小幅布局校准

依据 `message-group-editor-visual-comparison-final.png` 的同宽对比，进一步调整编辑器：拖动柄改为三条横线，保留 23px 灰色；显式约束红色显隐按钮/齿轮的 Material tap target，避免默认 48px 挤大常规行；副标题行最低 64px；同步微调按钮前距、文字起始位置、右侧拖柄和常用/侧栏区域间距。

保留前一轮全部 `*-final.*` 证据。新对比图：`output/message-group-editor-visual-comparison-refined.png`、`output/message-group-rule-visual-comparison-refined.png`；新的原始图和测量数据以 `*-refined.*` 命名。均为402×874、top62/bottom34、真实字体的 Flutter widget 渲染，仍不是原生应用截图。TextButton 字体fallback由临时渲染脚本注入，说明延续前一轮记录。

9个对应红减号中心的同宽测量：横向最大偏差从 4.00px 缩小到 0.11px；纵向最大偏差从 8.70px 缩小到 2.70px。未读行纵向 +0.53px，已完成 +2.08px；标题和卡片整体没有因压缩行距而向上偏离。该结果只说明这些可定位元素更接近参考，不是整图或原生像素级完成率。

回归：`message_groups_test.dart` 与 `message_group_editor_native_test.dart` 共 **27/27 通过**；临时渲染测试1项通过；静态分析通过。日志 `/tmp/renji-editor-pixel-refine-regression.log`、`/tmp/renji-editor-refined-render.log`、`/tmp/renji-editor-pixel-refine-analyze.log`。
