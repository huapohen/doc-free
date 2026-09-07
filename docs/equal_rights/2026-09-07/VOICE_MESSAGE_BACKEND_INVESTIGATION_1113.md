# 语音消息后端调查与待实施合同 · 2026-09-07T11:15:15+08:00

本记录为内部只读调查，不是实现或交付证明。用户随后要求优先整块消息分组截图复刻，语音实施暂缓；本记录不提交、不发布，不修改语音源码，不调用识别或合成服务。

| 仓库 | 调查基准 commit | 实际 Git 时间 | 描述 |
| --- | --- | --- | --- |
| Active Agent | `02f740fd39645e15e199e3d635da6cb35c772442` | `2026-09-07T11:07:43+08:00` | `docs(office): record native group toggle and stable input verification` |
| Doc Free | `1cf0cbf9c78771d0333bbe8a73344fa6d0a7cfa9` | `2026-09-07T11:07:45+08:00` | `docs(im): record native navigation and input delivery receipt` |

两个仓库均为 `equal_rights`。以下依据当前源码和既有测试阅读；没有新跑编解码、录音、播放或模型测试。

## 已有能力

Doc Free `native-attachments.js` 已提供当前成员鉴权的上传、元数据、字节下载及删除。单文件1字节至12MiB，REST上传JSON base64最大请求体18MiB；稳定上传client_id、内容SHA-256、文件完整性、会话/实例配额、目标独立附件ID、转发保护和撤回后的可访问性均可复用。当前二进制响应200整文件、no-store、禁止URL携带token，没有HTTP Range播放接口。

当前 `normalizedMime` 只验证PNG/JPEG/GIF/WebP。所有audio类型都被降为 `application/octet-stream`。当前音频只是可下载的普通文件，没有可验证的音频格式、时长、采样率或波形字段，不能以文件后缀宣称能够解码。

Flutter `ui/attachments.dart` 只有图片预览和通用下载，没有音频播放器。`conversation.dart` 中语音按钮明确禁用；settings中的自动语音转文字明确未接入。`OfficeState.uploadAttachment/getAttachmentBytes` 可复用传输，但新增录音/播放流程必须自己检查身份、来源会话和异步返回，不能长期缓存跨身份的字节。

妙记 `minutes_api.dart` 和 `native-minutes.js` 支持上传已有音频、关联会议/任务/Doc Free文档、手工或导入逐字稿。既有文案与MCP声明均明确没有自动ASR。没有录制设备音频、音频识别或TTS成功证据。

原生麦克风权限声明已随会议存在于macOS、iOS、Android；这不能说明操作系统已经授予录音权限。录音仍须处理请求、拒绝、取消、占用及异常退出。服务器Agent读取获授权音频与远程开启某台设备麦克风属于不同能力，本轮提议不把两者混为一谈。

## Agent协议缺口

`native-im-mcp.js` 已有 `im_attachments`、`im_attachment`、`im_delete_attachment`，没有音频上传工具或字节返回工具；元数据工具明确要求通过成员HTTP接口下载，不把二进制放模型上下文。

A2A只接受结构化原生操作，单请求上限256KiB、回执512KiB；普通MCP HTTP请求上限2MB。不能直接增加一个12MiB base64参数而宣称全量MCP/A2A传输已实现。推荐先让MCP/A2A承担发送、读取音频坐标及可选转写等控制动作，媒体字节通过同一成员鉴权HTTP传输。

Python `active_agent/im.py` 的 `IMClient.request` 只解析JSON、读取上限8MB，直接调用附件二进制下载会失败。需要独立有界媒体下载/上传方法，保留不跨域重定向、认证头、大小和SHA校验。标准worker最终结果与冻结动作计划也尚无voice字段，不能仅改MCP就声称标准worker会生成语音消息。当前自动上下文只有附件元数据，不能假装Agent已听到内容。

## 推荐首个可交付闭环

1. 人类点击录音入口，权限确认后录制；可停止、取消、试听。建议默认最多60秒且可配置。用户确认后先以稳定上传ID存音频，再以稳定消息ID发送；取消不发送，失败保留可重试草稿，应用切换身份或来源房间后不把旧录音发到新位置。
2. 优先统一为mono、16kHz、PCM16 WAV，约1.92MB/分钟。Flutter工具链子任务只读调查报告本机缓存已有record6.2.1及五端实现、audioplayers6.8.1及五端实现；尚未pub get或实际五端编解码验收。WAV便于后端从真实RIFF fmt/data块推导时长、采样率、声道和有效帧数。未来再按实际端能力扩展native M4A/AAC与WebM/Opus，首轮不同时承担多种容器与CAF互通。
3. 在现有 `im_send` 加可选 `voice`，以已上传音频attachment_id为源；服务器验证其当前会话、音频数据和可用性后生成真正的 `kind=voice` 与元数据。继续禁止调用方直接伪造kind。图片/文件附件发送不自动变成语音。消息正文可为空，音频本体提供可访问内容；可选说明保持普通正文。
4. 语音气泡具有真实播放/暂停、时长/进度、加载/失败/重试。先通过认证接口取字节，再以进程内数据、Web Blob或受控临时文件交给播放器；不把凭据放媒体URL。换身份、退出来源、隐藏或撤回时停止并清理，异步音频加载结束后重新核对原始身份与消息。
5. 普通转发、合并转发、嵌套共享快照、消息原文和素材导出都保留真实语音类型与音频坐标，目标附件ID必须重映射。隐藏/撤回墓碑不泄漏voice字段，A2A缓存回读继续核对当前授权。未解码音频不得生成假的识别文本。
6. Agent可按同一HTTP/MCP/A2A合同发送已有音频、取得当前可访问音频元数据及通过HTTP取得字节。真正的设备麦克风原生协议和模型/TTS生成音频是后续单独的设备或媒体提供器能力。

如果明确要求所有大音频也直接经MCP/A2A传输，应另加有界上传会话与分块：每块不超过96KiB原始数据、精确块序号/哈希、总大小/总哈希、稳定完成ID、配额预占、超时清理及当前身份/会话绑定。禁止把12MiB音频塞进A2A持久任务或普通语言模型prompt。

## 转文字阶段

将转写定义为可配置provider，明确 `unavailable/queued/running/succeeded/failed`。未配置时真实显示不可用；不调用现有文本模型假造ASR。成功结果需要实际提供器回执、源音频SHA、提供器/模型版本及时间，读取或恢复缓存继续重查当前权限。

识别文本可在语音消息下人眼可见，并可由用户/Agent明确导出Doc Free或创建妙记；人工修订与模型识别来源要区分。现有模型端点是否支持音频输入、ASR或TTS尚未验证，不能据文本模型配置推断音频能力。

## 可分配文件范围

- Doc Free：新音频校验/voice规范模块；`native-attachments.js`、`native-im.js`、`native-im-mcp.js`、`native-actions.js`；共享快照 `native-message-forward-bundle.js`、来源导出及能力声明；对应真实WAV、幂等、授权、墓碑与转发测试。
- Active：Python IMClient媒体传输和worker规范；Flutter录制/播放适配、语音草稿、气泡和既有消息菜单入口。工具链安装与五端检查由客户端任务统筹。
- 现 `native-minutes.test.js` 的fixture.wav实际为普通字符串，测试明确不作codec声明且期望octet-stream。增加真实音频验证时，应替换为合法最小WAV并另测伪造/损坏音频拒绝，不应为旧假夹具放宽新规则。

本记录只保存调查结论。实施前先读取当时最新commit及分组主线进度，再分工编辑，不能把本文待实施建议记作已完成能力。
