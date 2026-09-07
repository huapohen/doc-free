# 群聊语音录制与播放只读调查 · 2026-09-07 11:13

记录时间：2026-09-07T11:13:43+08:00。Active Agent 基准 commit `02f740fd39645e15e199e3d635da6cb35c772442`，Doc Free 基准 commit `1cf0cbf9c78771d0333bbe8a73344fa6d0a7cfa9`，分支 `equal_rights`。

本轮仅检查代码、已安装 SDK 和本机包缓存。没有修改语音源码、增加依赖、执行 pub get、下载文件或操作 GUI。用户随后把消息分组截图复刻提升为优先项，因此语音停留在调查阶段；手机麦克风仍然明确未接入。以下是实现建议，不是已交付能力。

## 现有能力

`apps/office/pubspec.yaml` 的媒体依赖只有 `flutter_webrtc ^1.6.1` 和通用 `file_picker ^12.2.0`，另有 `http`、`web 1.1.1`。`path_provider 2.1.6` 已作为传递依赖解析，但尚未直接声明；锁文件中的 `record_use 0.6.0` 是 Dart usage recording SDK 序列化支持，与麦克风录音无关。

会议的 `MeetingController.setMicrophone` 已通过 WebRTC `getUserMedia({'audio':true,'video':false})` 获取麦克风，结束时释放音轨。它证明已有权限路径与实时会议采音结构，不能证明可保存语音文件。现有妙记仅导入或下载已有录音，不含现场录音或音频播放器。`MessageAttachment` 只对图片提供预览，其余附件显示下载卡片。

附件通路已有 1 字节至 12 MiB 限制、成员鉴权上传、按会话读取二进制以及删除。播放应使用 `getAttachmentBytes` 读取鉴权内容，不能把带凭据的 URL 交给外部播放器或改成公开文件地址。后端并行调查指出目前音频 MIME 会降为通用二进制，且无 voice 元数据；真正语音消息需要补实际容器识别、时长及语音语义合同，不能只更换文件后缀。

## WebRTC 录文件的实际限制

已读本机 `flutter_webrtc 1.6.1` 源码，不能把它的 `MediaRecorder` 表面 API 当作五端等价实现：

- Android 存在 audio-only `AudioFileRenderer`，由 `MediaCodec` 和 MPEG-4 `MediaMuxer` 编码；理论上可以输出 AAC/M4A，但使用会议音频采样回调，生命周期和结束编码需单独验证。
- iOS 的 `startRecordToFile` 分支需要有效 `videoTrackId`，并由视频帧初始化 `FlutterRTCMediaRecorder`。只有 audioChannel 的调用可能返回成功却没有创建 recorder，随后 stop 报 recorder 不存在；它不能直接用于手机纯语音。
- Darwin 的该文件录制分支位于 `TARGET_OS_IOS` 条件内，macOS 不提供等价分支；Windows 搜索未找到相同文件录制实现。
- Web 的 wrapper 默认 MIME 为 `video/webm`，需要主动指定音频类型；其 onDataChunk 分支没有初始化 stop 使用的 completer，不能未经核对就依赖该分块模式。
- `startLocalRecording` 只是启动 WebRTC 音频设备模块，没有文件返回合同，不等于录音文件。

不建议为了复用一个已声明依赖而新增伪视频轨或改变会议采音行为。

## 已缓存的可用候选

本机已缓存 `record 6.2.1`、`audioplayers 6.8.1`，及两者的 Android、iOS/macOS、Web、Windows 平台实现。没有进行依赖解析验证，因此“包目录齐全”不等于已经完成离线构建。

| 候选 | 作用与已核对接口 | 适配情况 |
| --- | --- | --- |
| `record 6.2.1` | `hasPermission(request:)`、`isEncoderSupported`、start/stop/cancel、状态流与真实振幅 | 原生 AVFoundation、Android AudioRecord/MediaCodec、Windows MediaFoundation；Web 提供 MediaRecorder 与 PCM/WAV worklet |
| `audioplayers 6.8.1` | 文件或 bytes 播放、暂停、进度、时长、完成和错误事件 | 五个目标端均有平台实现 |
| 已有 `path_provider 2.1.6` | 临时录音和受控播放文件位置 | 若直接导入，应补直接依赖声明 |

本机 Flutter 为 3.47.2／Dart 3.13.2，满足这两个候选的 SDK 约束。iOS 项目最低 15.0、macOS 最低 12.0，满足插件要求；Android 使用 Flutter 默认 minSdk 24，也满足 record 最低 23。iOS/macOS 的 record 和 audioplayers 实现都提供 Swift Package，未引入远程 AVFoundation 二进制依赖。

Windows 仍有构建依赖：record_windows 需要 CMake 3.23；audioplayers_windows 的 CMake 会寻找或下载 NuGet，并安装指定版本 Windows Implementation Library。Dart 缓存不能覆盖这条线路。未来实际需要下载时必须先做短时连通性测试，再动态读取并验证系统代理；NuGet 下载脚本包含 SHA-256 校验，不应绕过。

## 第一阶段格式建议

建议首个完整互通版本使用 PCM16、单声道 WAV，而非同时引入多种压缩容器。record 已支持五端 WAV；16kHz、16bit、mono 的一分钟音频约 1.92 MB，低于既有 12 MiB 限制。最大时长由产品配置并等待真实飞书录音交互参考，不在调查阶段猜定。

服务器可以从 RIFF/WAVE fmt/data 块识别实际采样率、声道、帧数和时长，避免相信后缀或客户端自报时长。录音实际输出仍应检查采样率、容器、文件大小和时长，不把请求参数等同于设备实际输出；Web worklet 的采样率和 WAV header 尤其需真浏览器验证。

后续若需要节省流量，可在原生端启用 AAC-LC/M4A，Web 依据支持的 MIME 选择 AAC 或 WebM Opus。iOS Opus 可能输出 CAF，跨端兼容性较差，不宜按 `.opus` 名称就假设 OGG。多种容器都需要服务端真实识别及五端解码验证。

## 权限与平台差异

| 平台 | 现状 | 实现时必须处理 |
| --- | --- | --- |
| iOS | Release/Debug plist 已有麦克风说明 | 说明当前仅写“会议”，需覆盖用户主动录语音；明确区分尚未请求、拒绝、受限、设备不可用；AVAudioSession 与现有会议协调 |
| macOS | plist、Debug/Release `audio-input` entitlement 已有 | 更新用途说明；原生 TCC 授权与拒绝实测；新增插件需重建而非仅 hot reload |
| Android | `RECORD_AUDIO`、`MODIFY_AUDIO_SETTINGS` 已有 | Android 运行时权限、拒绝后重试、前后台生命周期；不因短语音自动申请后台录音或存储广泛权限 |
| Web | 现有 web 包和会议 getUserMedia | HTTPS/localhost secure context、用户手势、无设备、浏览器拒绝；record_web 直接 query microphone permission，需验证 Safari 不支持该查询时的降级处理 |
| Windows | 普通桌面 runner，已有 WebRTC | Windows 隐私开关/硬件不可用；插件无与移动端等价的 permission check，不能将 true 解释为系统保证；本机 Mac 无法完成 Windows 原生验收 |

## 建议的交互和状态合同

手机沿用已校准的固定 mic 槽位，只启用其入口；开始、停止、取消、预览、发送都在独立录音面板内完成，不向常用工具行动态增加按钮。具体按住说话、上滑取消、松开发送或录完预览等行为等待主任务真实点击参考，不凭想象确定。

推荐服务层独立封装 `OfficeVoiceRecorder` 和 `OfficeAudioPlayback`，UI 使用可替换接口，不直接管理平台通道。录音状态至少包括 idle、requestingPermission、recording、finalizing、preview、uploading/sending、error。每次操作绑定身份代次、会话、录音 ID 与意图版本；权限弹窗或 stop 的迟到返回不得进入新会话。

取消需要调用 recorder.cancel、停止采音、删除临时文件或撤销 Blob URL；关闭面板、切换身份、离开会话和应用进入后台也必须有明确结束策略。波形与计时必须来自真实录音振幅/时长，不用随机动画假装收音。达到限制先停止采集，不自动发送未经用户确认的内容。

发送继续使用附件上传与原有消息幂等通路；建议 voice 元数据引用一个真实音频 attachment ID，附真实 duration。上传失败可重试同一意图，不能再次录音代替原音频；取消或失败后的孤立附件清理必须绑定原身份和会话。Agent 协议可提交相同合法语音附件及元数据，不通过后台调用绕过本机麦克风授权。

## 播放与资源管理

消息行应显示真实播放/暂停、时长、播放进度和错误/重试状态。鉴权下载后再交本地播放器，每个会话统一管理当前播放项，避免多个气泡无意叠加播放；页面离开、撤回、附件不可用和身份变化时立即停止并清空旧音频。

audioplayers 的 BytesSource 在 iOS/macOS 内部会写临时文件；为可靠清理和避免共用缓存路径，建议由服务层创建带会话/随机 ID 的受控临时文件并在停止或注销时删除。Web 使用 Blob/bytes，完成后释放对象 URL；浏览器的播放手势与异步鉴权下载也需实际验证，不能只测试按钮状态。

录音、语音播放与 WebRTC 会议都会改变设备音频会话/焦点。应统一占用管理，停止本次录音后正确恢复；不能为了录短语音擅自结束现有会议。通话并发、蓝牙/耳机切换、系统来电和后台中断是本轮方案的主要原生难点。

## 未来验收重点

- 真实拒绝/同意权限、录制真实声音、停止得到可解析文件、取消不上传，确认系统麦克风指示结束。
- 手机 mic 固定槽位和 320／390、键盘场景位置不跳；录音面板返回完整保留文字草稿。
- 上传失败重试、结果未知重试、切换身份/会话、权限迟到与录音结束迟到。
- 自己试听、发送后另一账号读取并播放，时长与容器解析一致；消息转发和 Agent 调用带真实 voice 合同。
- 音频播放结束、暂停、重播、切换会话与撤回时资源释放。
- Mac、iOS、默认 Android AVD、Web 的实际录制播放；Windows 需对应主机构建与验证，不能从 Mac 的测试推断完成。

调查结果已同步后端协作者。当前因消息分组 UI 优先级调整，以上均未实施。
