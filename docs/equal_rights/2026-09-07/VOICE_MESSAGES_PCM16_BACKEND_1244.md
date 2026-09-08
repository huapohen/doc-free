# 原生语音消息后端实现与验证 · 2026-09-07T12:44:05+08:00

本记录描述本轮已实现并通过测试的 Doc Free 语音后端。它接续当天 `VOICE_MESSAGE_BACKEND_INVESTIGATION_1113.md`，保留旧调查记录，不能将旧记录中的待实施建议直接视为交付。本轮生产源码已经冻结，等待主任务集成提交；本文创建时的真实基准如下，尚未产生本轮语音实现 commit。

| 仓库 | 基准 commit | Git 时间 | 描述 |
| --- | --- | --- | --- |
| Doc Free | `55967f5234568d80cee36d836f06b942cb3db0b1` | `2026-09-07T12:18:30+08:00` | `docs(im): publish mobile group fidelity protocol and delivery receipt` |
| Active Agent | `1774c284ba41d5db71ed77a4b905bd3db1c0369f` | `2026-09-07T12:18:30+08:00` | `docs(office): record mobile group fidelity and native verification limits` |

两个仓库均处于 `equal_rights`。后续交付回执应记录实际实现 commit；不要用本文基准冒充语音实现提交。

## 人与 Agent 共用的语音合同

Human 与 Agent 通过同一当前成员身份、会话成员权限及企业 IM 应用权限发送语音。界面负责录音和播放交互，原生接口不要求 Agent 模拟点击录音按钮。

先使用既有当前成员鉴权附件接口上传真实音频，再调用 `POST /api/im/rooms/:room_id/messages`，或 MCP / A2A 的 `im_send`：

```json
{
  "client_id": "stable-voice-intent-id",
  "voice": {
    "attachment_id": "attachment-<已上传的当前会话附件ID>"
  }
}
```

`voice` 只接受 `attachment_id`，不接受调用方声称的时长、编码、SHA 等字段；`null` 也不合法。`content` 可省略或为空，也可提供纯文本附言。语音的 `rich_text` 只能省略或为 `null`。服务端自动将语音附件纳入 `attachment_ids`，调用方不必重复传；另带普通附件时仍受最多 8 个附件的既有限制。

服务端读取实际文件、核验 SHA 与完整 WAV 数据后推导 `kind: "voice"`。返回的 `voice` 包含：

```text
attachment_id, container="wav", codec="pcm_s16le",
sample_rate, channels=1, bits_per_sample=16, frame_count,
duration_ms=frame_count*1000/sample_rate, sha256, size, availability
```

`duration_ms` 允许精确小数，避免将单帧音频四舍五入成虚假的整毫秒。有效 WAV 上传回包同时有 `attachment.audio`，保留真实容器、编码、采样率、声道、位深、帧数和时长。消息及合并转发中的附件元数据沿用这些字段，供客户端按真实音频渲染。

仅把 WAV 作为普通附件发送不会自动变成语音消息。语音类别需要明确的 `voice` 意图，调用方仍不得直接伪造 `kind`。

## 格式与可配置限制

新增 `native-voice.js`，完整解析 RIFF/WAVE，而非仅检查文件后缀或几个 magic bytes。首轮支持 8000–48000 Hz、单声道、signed PCM16 little-endian WAV。

| 检查 | 已实现行为 |
| --- | --- |
| RIFF | 文件声明大小必须与实际字节数一致，不接受尾随额外字节 |
| Chunk | 遍历所有块，接受合法未知块与奇数长度 padding，拒绝截断块 |
| fmt | 只接受一份 fmt，支持 PCM format 1 的 fmt16、fmt18/cbSize0 |
| Extensible | 支持完整 fmt40、cbSize22、validBits16、PCM subtype GUID，单声道 mask 为 0 或单 bit |
| data | 只接受一份非空 data，位于 fmt 后且完整帧对齐 |
| PCM | 核对声道、位深、采样率、blockAlign 和 byteRate，拒绝压缩、float、stereo 或不一致参数 |
| 类型 | 按真实合法 WAV 字节归一为 `audio/wav`；声明 WAV 但无效的上传被拒绝 |

格式检查支持真实 Windows 录音器常见的 fmt18/WAVEFORMATEX；截断的 WAVE_FORMAT_EXTENSIBLE 不会因兼容性而放行。

单附件上限沿用 12 MiB，HTTP JSON base64 上传请求体上限沿用 18 MiB。长 WAV 可以作为普通音频文件上传，供文件分享或妙记使用；只有新语音消息受语音时长上限约束。

默认上限 60000 ms，可以配置 1000–60000 之间的整数：

```text
createNativeIM({ voiceMaxDurationMs: 30000, ... })
DOC_FREE_VOICE_MAX_DURATION_MS=30000
```

`server.js` 将环境变量转换为数值，构造器严格校验，非法配置启动失败。降低限制后，已经提交的稳定 `client_id` 仍可幂等重放，历史语音仍可读取和转发；新的超限语音会被拒绝。

`GET /api/im/capabilities` 回包顶层新增 `voice_media`，既有 `capabilities` 数组结构保持原样。`voice_media` 报告当前授权下的 `enabled`、容器、编码、采样率范围、声道、位深、最大时长和附件字节数。MCP 复用 `office_capabilities` 获取这一配置。会话详情的 `native_features` 新增 `message_voice: true`。

MCP / A2A 传递结构化操作与音频坐标；字节通过同一当前成员鉴权 HTTP 附件上传、下载接口传输，不将大型 base64 数据塞入模型上下文或 A2A 持久回执。

## 转发、隐藏、撤回及文档载体

普通转发创建目标会话自己的附件记录与新 ID，并重写 `voice.attachment_id`。底层内容可以共享 SHA 对应的字节文件，消息关联与生命周期独立。源消息撤回或源附件删除后，已合法分享的目标副本仍可访问。

合并转发保留真实 `kind: voice`、`voice` 和 `attachment.audio`。嵌套合并转发递归重映射每层 `voice.attachment_id`，指向当前目标资源，而不是源会话 ID；空正文语音预览显示 `[语音]`。普通、合并及嵌套合并转发都重新校验源文件完整性，损坏时不会先写入目标附件元数据。禁止转发的来源也不能借重用语音附件规避保护。

语音消息可以编辑纯文本附言；PATCH 不能替换 `voice`、`kind` 或 `attachment_ids`，也不能给语音附言添加 rich_text。当前消息被本人隐藏后不再返回可播放的 voice；撤回回包没有 voice，且清空当前消息的附件回包。

音频下载与缓存引用会重新检查当前成员、附件 active 状态，以及至少一条当前身份可见且未撤回的关联消息。尚未关联消息的合法上传仍可供录音草稿试听。隐藏、撤回、附件删除、离群或企业 IM 应用撤权后，不能利用缓存语音引用绕过当前权限。A2A 回读递归检查结构化 `voice.attachment_id`，复用原有文件 SHA / no-symlink 校验。

当前会话 Markdown 导出、消息导出 Doc Free 文档、合并与嵌套消息素材导出保留 voice 元数据和正确的目标附件 ID。这样人和 Agent 都能在文档中看到语音来源和真实媒体坐标；本轮没有把未知音频内容伪造成转写正文。

持久化沿用 fail-stop 行为。消息保存失败后，磁盘只保留此前已经提交的上传；重启后没有半条语音消息，稳定 `client_id` 可以安全重试。

## 验证证据

本轮全量 `npm test` 最终结果为 **355 项通过，0 失败，0 跳过**，耗时 18648.693916 ms。日志：`/tmp/renji-backend-voice-full-20260907-final.log`。初次全量运行发现旧 `native_features` 精确断言未纳入新能力，更新断言后完整重跑通过。`git diff --check` 通过。

新增 `tests/native-voice.test.js` 的 12 项覆盖：

1. 完整 WAV / fmt16、fmt18、fmt40、未知块、padding、精确帧时长及非法格式。
2. 根据真实字节识别音频，拒绝伪造 MIME，长 WAV 保持可作为普通文件。
3. Human / Agent 空正文发送、稳定幂等、读取、重启及配置发现。
4. 伪造元数据、跨会话附件、非法音频、无权限与不兼容 rich_text 在写入前拒绝。
5. 附言编辑、媒体身份不可变、本人隐藏与撤回后的可播放字段清除。
6. 普通转发 ID 重映射，以及来源撤回 / 删除后目标副本仍能下载。
7. 多目标合并与嵌套合并转发、每层目标 ID、禁止转发保护。
8. 文件缺失或损坏时发送与各类转发拒绝，目标状态不变。
9. MCP / A2A 人机同权、附件删除和应用撤权阻断缓存媒体引用。
10. 会话与 Doc Free 素材导出保留 voice 和正确目标 ID。
11. 持久化故障后重启、稳定重试与不出现半条消息。
12. 降低时长配置后，既有幂等回执与历史转发可用，新超限发送拒绝。

旧妙记测试的 `.wav` 夹具此前实际为普通字符串，现改为真实生成的 WAV，校验 `audio/wav` 和 100 ms 时长。没有为假音频放宽解析。`tests/voice-fixture.js` 统一提供可独立解码的 PCM 数据。

除单元/集成测试外，使用本机 **ffmpeg 9.0.1** 完成 13 个独立编解码案例：8000、16000、44100、48000 Hz 各自配 fmt16 / fmt18 / fmt40 共 12 例，全部带 JUNK / LIST / padding，独立解码后的 PCM 字节逐字节等于原始样本；另以真实 ffmpeg PCM16 WAV encoder 生成 48000 Hz / 200 ms 音频，后端解析后再次完整解码成功。证据记录：`output/voice-pcm-decoding-20260907.json`，时间 `2026-09-07T04:36:17.744Z` 至 `2026-09-07T04:36:18.340Z`。该 output 目录被 Git 忽略，属于本机验证产物。

## 交付边界

本记录验证了后端音频格式、身份权限、结构化协议、转发生命周期和文档导出。Flutter 录音 / 播放 service、语音 UI 与 OfficeState 由并行客户端任务集成，其真实设备验收以各自后续回执为准。

本轮后端任务没有打开真实麦克风、没有用真实企业群发送消息、没有调用模型 / ASR / TTS、没有重启用户正在验收的旧服务。不能据此宣称五端真实录音播放已经验收、标准 worker 已能自行合成语音，或完整飞书能力已经完成。自动识别、语音合成和远程设备录音仍需实际可配置提供器、权限与真实调用证据。

本轮修改范围为 `native-voice.js`、`native-attachments.js`、`native-im.js`、`native-im-mcp.js`、`native-message-forward-bundle.js`、`native-message-materialize.js`、`server.js` 及对应测试；没有引入新后端依赖。
