# 人机本机启动手册附录：全天、重复日历与客户端恢复

记录时间：`2026-09-08T21:31:16+08:00`（Asia/Shanghai）
分支：`equal_rights`

| 仓库 | 本阶段实现 commit | commit 时间 | 描述 |
| --- | --- | --- | --- |
| Doc Free | `a1b21dccd4b7f35851fec826e841e4de31be4814` | `2026-09-08T21:26:11+08:00` | `feat(calendar): add all-day recurring events and native occurrence protocol` |
| Active Agent | `80db77eb9badd29c1e8eef527ae1e082c5de58c1` | `2026-09-08T21:43:08+08:00` | `feat(office): add native all-day and recurring calendar workflows` |

本表在阶段收尾时已使用两仓真实实现提交补齐；教程正文保留编写时的记录时间。

本附录接续 [13:18 原始启动教程](MANUAL_STARTUP_MACOS_IOS_SIMULATOR_1318.md)，原文与其中历史基线保持不变。本阶段增加全天、重复规则、单次实例改期/取消、IANA 时区以及 Human/Agent 共用日历协议。只预览 Mac 和 iPhone Simulator 时，按下面顺序即可；原教程把 Flutter Web 构建放在服务启动之前，并非原生客户端的必需前置步骤。

## 1. 更新本阶段依赖

Doc Free 新增并锁定 `@js-temporal/polyfill 0.5.1`，由 `calendar-recurrence.js` 在 Node 服务中加载。若该依赖尚未安装，即使旧 `node_modules` 目录存在，旧启动器的目录检查也不能保证它完整。

先在原 `dev_office.py` 终端按 `Ctrl-C` 停止旧服务，确认没有其他 npm 安装或构建任务，再执行：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/doc_free
npm ci
node -e "require('@js-temporal/polyfill'); console.log('Temporal dependency ready')"
```

`npm ci` 使用仓库锁文件，不要单独执行无版本约束的安装覆盖锁定版本。下载缓慢时依照工作区 `AGENTS.md` 探测当前网络与动态系统代理，不把代理端口写死。

Flutter 新增并锁定纯 Dart 包 `timezone 0.11.1`。在没有其他 pub/build 任务运行时更新依赖：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent/apps/office
/Users/lwblx/development/flutter/bin/flutter pub get --enforce-lockfile
```

本阶段时区包没有新增原生插件注册或权限。已有 Mac/iOS `flutter run` 会话在依赖准备好后，可在各自调试终端输入 `r` 加载 Dart 日历改动；若仍保留旧初始化状态，输入 `R` 热重启并重新登录现有账号。录音、WebRTC 等原生插件、签名或权限发生变化时，仍需停止并重新运行客户端；这里的纯 Dart 更新不替代那类重建。

## 2. 原生 Mac/iOS 预览不要求先构建 Flutter Web

代码核对结果：

- `active_agent/scripts/dev_office.py` 检查 Doc Free checkout、`node_modules` 和端口，然后执行 Doc Free 的 `npm run build` 并启动服务。
- 这里的 `npm run build` 构建 Doc Free 的三个编辑器 JavaScript 资源，不是 `flutter build web`。
- 启动器只把 `DOC_FREE_OFFICE_BUILD` 设置为 `apps/office/build/web`；它没有检查或强制构建该目录。
- `doc_free/server.js` 只有收到 `/office/` 静态资源请求时才检查 Flutter Web 文件；文件缺失时该请求返回 `404 Office client asset unavailable`，不会因此阻止 HTTP API 或原生客户端启动。

因此，本地 Mac/iOS 预览可以直接启动服务：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent
python3 scripts/dev_office.py --doc-free ../doc_free --no-worker
```

另开终端检查本机服务：

```bash
curl --noproxy '*' --fail --silent --show-error http://127.0.0.1:3218/health
```

默认 HTTP 端口仍是 `3218`，协作文档端口仍是 `1238`。保留 `data/office/`，在原有服务终端停止后再启动同一份工作区，避免重复监听。`--no-worker` 可预览 UI 和手动 Human/Agent API 操作，不会启动模型主动工作器。

需要浏览器中的完整 Flutter 客户端 `/office/` 时，再单独构建 Web：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent/apps/office
/Users/lwblx/development/flutter/bin/flutter build web --release --base-href /office/ --no-web-resources-cdn --no-pub
```

没有构建 Web 时，用 `/health` 和原生应用登录验证服务；不要把 `/office/` 缺失误判为账号或日历 API 故障。

## 3. 启动或继续 Mac 与一个 iPhone Simulator

Mac 热开发终端：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent/apps/office
/Users/lwblx/development/flutter/bin/flutter run -d macos --no-pub
```

iPhone 复用已有模拟器，先在 Simulator 应用中打开并解锁该设备。获取本次真实 UDID：

```bash
/Users/lwblx/development/flutter/bin/flutter devices
xcrun simctl list devices available
```

把下方 `<实际的 iPhone Simulator UDID>` 替换为设备列表中的值，再在另一个终端运行：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent/apps/office
/Users/lwblx/development/flutter/bin/flutter run -d '<实际的 iPhone Simulator UDID>' --no-pub
```

只保留一个 iPhone Simulator；多身份验收通过切换账号、Mac 客户端和各自的 Agent 接口完成。Mac 与 iOS Simulator 登录页都使用 `http://127.0.0.1:3218`。这是本机模拟器预览地址，不能直接作为物理手机上的宿主机地址。

## 4. Mac 进程还在，但磁盘上的应用包被清掉

已经运行的进程与磁盘上的 `.app` 是两个状态。窗口还在，不代表下面的构建目录仍然存在；如果此时重新打开路径，可能提示找不到应用。

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent/apps/office
test -d 'build/macos/Build/Products/Debug/Active Office.app'
```

若包缺失，需要恢复磁盘产物：先在旧 Mac Flutter 调试终端输入 `q`，避免旧会话与新构建同时操作同一构建目录。依赖已完成 `pub get` 时执行：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent/apps/office
/Users/lwblx/development/flutter/bin/flutter build macos --debug --no-pub
```

构建完成后，在 Finder 打开以下应用包即可进行独立预览：

```text
/Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent/apps/office/build/macos/Build/Products/Debug/Active Office.app
```

需要继续用 `r`/`R` 热开发时，执行第 3 节的 `flutter run -d macos --no-pub`，由该调试会话启动应用。重新启动后若显示登录页，使用现有本地人类账号登录；不需要重新建账号，也不需要删除或重置 `data/office/`。

账号资料仍保存在被 Git 忽略的 `data/office/access.json` 中，启动器沿用已有账号、密码及企业角色。不要把该文件全文、密码或身份 token 复制到终端历史、文档或提交中。

## 5. 本阶段启动后的可见核对

登录后进入日历，确认有全天开关、重复规则与时区入口；可查看已存在的阶段验收日程。移动某一次日程后，其 `occurrence_id`/`original_start` 保持原始标识，当前显示日期可以改变；取消一次只隐藏该次，系列保留。全天结束日期在协议中为不含结束日，单日 9 月 8 日对应 `start_date=2026-09-08`、`end_date=2026-09-09`。

本附录编写时只读核对了启动脚本、资源路由、依赖锁文件与真实 backend commit。没有为编写教程再次运行安装、构建、GUI 或修改服务数据；原生页面和真实协议验收另见本阶段交付回执。
