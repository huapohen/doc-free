# 输入干扰暂停记录 · 2026-09-08T19:01:35+08:00

以下为 19:01 的历史快照。后续源码已于 19:09:48 提交为 `1711b32c081936045038894a59595decfc6982d7`；最后三项仍未热更新，输入恢复仍待人工确认。当前阶段状态见 [日历、会议与输入隔离记录](PHASE3_CALENDAR_MEETINGS_INPUT_PAUSE_1909.md)。

基准 commit：`75a461472816a3573ec3531cd7ee8673f9bf2ade`（equal_rights）。本次日历、会议与搜索输入改动仍在工作区，未提交；不能把基准提交当作包含本轮实现的版本。

## 当前优先级与暂停边界

用户反馈在电脑控制进行期间，飞书与人机的真实键盘输入出现重复字符，iPhone 模拟器未出现中文候选，已经影响日常工作。立即停止本轮 GUI 操作，重置 CUA 会话，退出专用控制服务，并暂停自动重生的专用控制客户端。没有退出飞书、输入法、模拟器或终端父任务。后续阶段不得自动重新连接 CUA；先处理并验证正常人工输入。

## 已确认与尚未证明的事

- 进程检查发现多个 SkyComputerUseClient；退出后客户端被 Codex/omp 父进程重新拉起，随后对专用客户端采取暂停。详细 PID 与时点仅保留忽略目录的 input-isolation-incident.json。
- 只读取了事件监听器元信息，没有记录实际按键。退出服务后的元信息没有显示该控制服务的事件监听器。这不能证明所有重复输入原因都已消除。
- iPhone 17 已安装简体中文拼音键盘，当前选中与最近使用的是 en_US 英文键盘，ConnectHardwareKeyboard 为 true。未修改系统输入法、键盘设置或重启模拟器。
- 人机侧栏原先可以接收输入，再把文本同步到另一个全局搜索框。新实现保留侧栏搜索外观，将其改为只读入口，先打开并聚焦唯一全局输入框。
- widget-only 回归验证 q→qi→qiy→qiye 的完整 TextEditingValue 和 composing 保持，再提交“企业”只产生一次查询。
- 原 widget 复现没有证明 autofocus 抢焦导致系统级双写；不得宣称本修复解决了飞书或模拟器输入法。

## 验证

12 个相关 Flutter 测试文件共 **144/144 通过**；flutter analyze 无问题；git diff --check 通过。日志：`/tmp/renji-phase3-input-isolation-final-tests.log`、`/tmp/renji-phase3-input-isolation-final-analyze.log`。

搜索入口修复、最后的月视图拥挤格修复和桌面入会底栏修复尚未热更新/原生重拍。此前日历、会议页面已做 Mac/iOS 原生截图与点击，但不构成最终全部通过。真人输入恢复仍等待用户反馈，未标记完成。

## 日历/会议阶段保全

日历：日/三日/周/月，手机内联月份选择与回到今天，完整 00–24 时间轴，重叠组分列、拥挤月格+n入口，真实人/Agent参与者与RSVP、来源身份隔离。会议：首页桌面双栏/手机四列入口、加入预览、真实会议/纪要导航、合法会话owner权限与旧身份回调隔离。未实现全天/重复/农历/会议室、云录制/自动转写/电话/直播等完整能力，不宣称全量飞书或五端逐像素完成。

## 清理结果

本次过期构建与重复分发清理由21.09 GiB降至约4 GiB，释放17.18 GiB。账号/聊天/未提交源码、正在使用的Mac/iOS构建保留。明细在active_agent/output/CLEANUP_20260908.md。

## 参考

- OpenAI Computer Use文档：https://learn.chatgpt.com/docs/computer-use （未给出本次双写问题的确定解释）。
- Apple外接键盘语言切换：https://support.apple.com/en-ca/guide/iphone/iph5948b3f2e/ios 。Control+Space切换已添加语言；也可使用屏幕键盘语言键。
