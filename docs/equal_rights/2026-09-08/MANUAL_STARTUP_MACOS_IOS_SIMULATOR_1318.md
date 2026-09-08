# 人机本机启动手册：服务、macOS 电脑版与 iPhone 模拟器

记录时间：`2026-09-08T13:18:27+08:00`（Asia/Shanghai）
分支：`equal_rights`
当前已提交实现：`d0be30a3c08920642ff7f94c4d0d52b9450c5e72`（2026-09-07T12:18:30+08:00，记录上一批办公 UI 与 Doc Free 发布台账）。
说明：写本文时工作区还有本轮 UI、语音和本地登录修复的未提交改动；提交完成后，应把本段基线替换为最终实现 commit，并在交付文档中同时记录 commit、时间和描述。本文的命令以当前目录结构为准。

这套本机预览由一个 Doc Free HTTP 服务、一个可选的 CRDT 协作服务和 Flutter 客户端组成。macOS 客户端和 iPhone Simulator 使用同一个 `127.0.0.1:3218` 服务；应用里的账号登录走本机服务，模型密钥不会打进客户端。

## 1. 一次性准备

在终端确认目录存在：

```bash
cd /Users/lwblx/huapohen/agent
test -d execute/enterprise_work/active_agent
test -d execute/enterprise_work/doc_free
```

需要 Python 3.9+、Node.js 20+、npm，以及 Flutter 3.47.2 / Dart 3.13.2。检查 Flutter：

```bash
/Users/lwblx/development/flutter/bin/flutter --version
/Users/lwblx/development/flutter/bin/flutter doctor
```

首次准备 Doc Free 依赖：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/doc_free
npm ci
```

首次准备 Python 包和 Flutter 依赖：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent
python3 -m pip install -e .
cd apps/office
/Users/lwblx/development/flutter/bin/flutter pub get --enforce-lockfile
```

模型配置只放在被 Git 忽略的 `.env` 中。只看 UI 时可以不配置模型，并使用下面的 `--no-worker`；不要把密钥写进命令行、截图、文档或 Git。

## 2. 启动本机服务

先编译 Flutter Web 客户端，因为 `dev_office.py` 会把 `apps/office/build/web` 挂载到 `/office/`：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent/apps/office
/Users/lwblx/development/flutter/bin/flutter build web --release --base-href /office/ --no-web-resources-cdn
```

再开一个终端启动服务。推荐第一次排查 UI 时不启动模型 worker：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent
python3 scripts/dev_office.py --doc-free ../doc_free --no-worker
```

需要启动 Agent 主动工作器时，去掉 `--no-worker`：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent
python3 scripts/dev_office.py --doc-free ../doc_free
```

脚本默认监听：

| 用途 | 地址 |
| --- | --- |
| HTTP / Flutter Web | `http://127.0.0.1:3218` |
| 协作文档 CRDT | `127.0.0.1:1238` |
| Flutter Web 客户端 | `http://127.0.0.1:3218/office/` |
| 轻量 HTML 预览 | `http://127.0.0.1:3218/im` |

服务启动后，另开终端做健康检查：

```bash
curl --fail --silent --show-error http://127.0.0.1:3218/health
curl --fail --silent --show-error http://127.0.0.1:3218/capabilities
```

健康检查只证明服务可达，不证明某个账号已经登录或某个功能已获授权。首次启动会在以下被忽略目录创建本机数据和账号文件：

```text
/Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent/data/office/
```

其中 `access.json` 是本机私有凭据文件，权限为 `0600`。登录页应填写你已设置的本地人类账号和密码；不要把密码复制进 shell 历史或文档。启动器会保留已经存在的密码和企业角色，不会在每次重启时重置它们。

## 3. 启动 macOS 电脑版（热更新）

服务保持运行，再开第二个终端：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent/apps/office
/Users/lwblx/development/flutter/bin/flutter run -d macos --no-pub
```

Flutter 输出 `A Dart VM Service ...` 后，应用会打开。登录页的服务地址使用本机默认值 `http://127.0.0.1:3218`。需要只构建、不保持调试会话时：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent/apps/office
/Users/lwblx/development/flutter/bin/flutter build macos --debug
open "build/macos/Build/Products/Debug/Active Office.app"
```

调试终端中：

- 输入 `r`：热 reload，适合 Dart UI 小改动；
- 输入 `R`：热 restart，适合状态或路由初始化改动；
- 输入 `q`：退出 Flutter 调试进程；
- 原生插件、Info.plist、权限和依赖变化后要停止并重新执行 `flutter run`，不能只依赖热 reload。

## 4. 启动 iPhone Simulator（只保留一个模拟器）

推荐复用已经存在的 iPhone 17 模拟器，不要为每个测试账号开一个模拟器。先打开 Simulator：

```bash
open -a Simulator
```

查看可用设备和真实 UDID：

```bash
/Users/lwblx/development/flutter/bin/flutter devices
xcrun simctl list devices available
```

如果 iPhone 17 尚未启动，可以按名称启动（已启动时提示可忽略）：

```bash
xcrun simctl boot "iPhone 17"
open -a Simulator
```

在设备列表中复制 `iPhone 17` 的 UDID，然后在第三个终端运行：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent/apps/office
/Users/lwblx/development/flutter/bin/flutter run -d <iPhone-17-UDID> --no-pub
```

当前一次验收实际识别到的设备为 iPhone 17 Simulator（UDID 会因本机重建而变化，不能写死到脚本）。Flutter 调试会话启动后，Simulator 中的人机会连接 `127.0.0.1:3218`；iOS Simulator 与 macOS 共享宿主机 loopback。调试终端同样使用 `r` 热 reload、`R` 热 restart、`q` 退出。

如果要改用 Flutter 的模拟器管理器：

```bash
/Users/lwblx/development/flutter/bin/flutter emulators
/Users/lwblx/development/flutter/bin/flutter emulators --launch apple_ios_simulator
```

这可能创建或启动另一个设备；日常 UI 对比应优先使用已登录的 iPhone 17，并在 `flutter devices` 中确认实际目标。

## 5. 登录和客户端联通检查

按以下顺序排查，能区分“服务没启动”和“账号认证失败”：

1. 浏览器打开 `http://127.0.0.1:3218/office/`，确认登录页可以加载。
2. 终端执行 `curl --fail --silent http://127.0.0.1:3218/health`，确认返回成功。
3. macOS 或 Simulator 登录页使用本机人类账号；登录成功后应进入消息页并显示工作空间。
4. 如果 Web 能登录而原生客户端不能登录，先退出旧的 Flutter 调试进程，再重新执行对应的 `flutter run`；不要重复启动第二个 3218 服务。
5. 如果服务重启后仍提示账号错误，检查 `data/office/access.json` 是否仍存在，并确认没有误切换到另一个工作区或测试账号。启动器不会替换已有密码。

不要用管理员 token、Agent token 或 `.env` 模型凭据代替人类账号密码；三者权限和用途不同。

## 6. 常见问题

### 端口 3218 或 1238 已被占用

先查看监听进程：

```bash
lsof -nP -iTCP:3218 -sTCP:LISTEN
lsof -nP -iTCP:1238 -sTCP:LISTEN
```

如果确认是自己遗留的开发进程，结束对应 PID 后再启动；不要盲目结束不认识的进程。也可以临时使用其他端口：

```bash
python3 scripts/dev_office.py --doc-free ../doc_free --port 3228 --collab-port 1248 --no-worker
```

此时客户端服务地址也必须改为 `http://127.0.0.1:3228`，不能继续使用默认 3218。

### 健康检查失败或断网

确认终端中的 `dev_office.py` 仍在运行；若进程退出，读取终端最后一段错误后重新启动。服务只绑定 `127.0.0.1`，系统代理、VPN 或外部网络断开通常不会影响同机 macOS/Simulator 的 loopback；如果服务依赖安装失败，先恢复 npm/Python 依赖，再重启脚本。

### 热更新后页面不对或输入框状态残留

先在客户端退出当前会话并重新进入页面；仍不对时使用调试终端的 `R`。输入法、录音、WebRTC、Info.plist 或插件改动必须完全停止并重新 `flutter run`。热 reload 不会重建原生插件，也不会清除服务端数据。

### Simulator 找不到或卡住

```bash
/Users/lwblx/development/flutter/bin/flutter devices
xcrun simctl list devices available
```

确认 Simulator 已解锁、设备状态为 `Booted`，再用实际 UDID 执行 `flutter run -d`。只有在模拟器进程确实无响应时才关闭并重新打开 Simulator；不要同时启动多个 iPhone 模拟器占用资源。

### 镜像手机断开

iPhone Mirror 是 macOS 的系统会话，和 Simulator、Flutter 调试会话相互独立，不能由本项目保证永久不断开。断开后在系统中重新连接镜像即可；项目本机验收优先使用 Simulator，避免把 Mirror 的连接状态误判为应用服务故障。

### 启动器提示缺少 Doc Free 或 node_modules

确认参数指向带有 `native-im.js` 和 `node_modules` 的 checkout：

```bash
test -f /Users/lwblx/huapohen/agent/execute/enterprise_work/doc_free/native-im.js
test -d /Users/lwblx/huapohen/agent/execute/enterprise_work/doc_free/node_modules
```

缺少依赖时回到第 1 节执行 `npm ci`。不要把旧 `doc-free` 工作区的数据目录复制到当前 `data/office/`。

## 7. 停止服务和客户端

分别在各自的 Flutter 终端输入 `q`，再在运行 `dev_office.py` 的终端按 `Ctrl-C`。正常退出会停止 HTTP、协作服务和可选 worker；`data/office/` 会保留本机开发数据，方便下次继续登录。

## 8. 当前边界

本手册只描述本机开发预览的可重复启动方式，不代表生产部署。Windows、Android、iOS 真机签名、公证、商店发布、外部企业身份提供商、推送和大规模会议仍需单独构建与验收。当前 `--no-worker` 可验证 UI 与基础办公流程；主动 Agent、模型调用和真实外部服务需要另行配置并承担对应的权限、网络和费用。
