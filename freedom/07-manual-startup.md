# 本机手动启动与公网体验教程

更新：2026-09-08。按本机实际目录 `doc_free`、`active_agent` 编写。重启保留现有数据和账号，不必重新部署或注册。

## 1. 先分清入口

| 服务 | 本机地址 | 启动方式 |
|---|---|---|
| 新版办公工作区 | http://127.0.0.1:3218/office/ | Active Agent 启动器 |
| 新版轻量预览 | http://127.0.0.1:3218/im | 同上 |
| 新版协作服务 | 127.0.0.1:1238 | 启动器内嵌启动，不另开进程 |
| AFFiNE | http://localhost:3010/ | Docker Compose |
| Docmost | http://localhost:3020/ | Docker Compose |
| 旧版文档演示 | http://localhost:3210/ | 文末旧版说明 |

新版和旧版使用不同数据目录。新版 `/office/` 的文档目前不自动全量同步 AFFiNE/Docmost；不要把启动三个服务理解为三端内容自动一致。

## 2. 启动 AFFiNE 和 Docmost

先打开 Docker Desktop，等它启动完成。终端执行：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/doc_free
docker info >/dev/null
./deploy-affine-docmost.sh
```

脚本复用 `.env.affine-docmost` 和现有 Docker 数据卷。日常启动不要重新生成密码，也不要执行 `docker compose down -v`。

检查本机页面：

```bash
curl --noproxy '*' -sS -o /dev/null -w 'AFFiNE HTTP %{http_code}\n' http://127.0.0.1:3010/
curl --noproxy '*' -sS -o /dev/null -w 'Docmost HTTP %{http_code}\n' http://127.0.0.1:3020/
```

## 3. 启动新版 Doc Free（终端 A，保持打开）

先检查是否已经运行；已有服务就跳过启动，不要再开第二份：

```bash
curl --noproxy '*' -fsS --max-time 3 http://127.0.0.1:3218/health
lsof -nP -iTCP:3218 -iTCP:1238 -sTCP:LISTEN
```

未运行时执行：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent
python scripts/dev_office.py --doc-free ../doc_free
```

本机已检查 Python 路径为 `/Users/lwblx/anaconda3/bin/python`；新终端找不到 `python` 时可使用这个完整路径。启动器会构建 Doc Free 编辑器，启动 HTTP、内嵌协作服务和 Agent worker，并读取 Active Agent 的本机 `.env`。已有账号、成员身份和数据会复用，不重置密码。

只体验界面与人工编辑，不启动模型 worker：

```bash
python scripts/dev_office.py --doc-free ../doc_free --no-worker
```

上述两条二选一。模型配置缺失时，Agent 无法完成生成任务；不要把 API Key 写进本教程或群聊。

### `/office/` 返回 404 时

启动器构建的是 Doc Free 编辑器，不会自动构建 Flutter 办公前端。本次检查发现 `apps/office/build/web/index.html` 缺失、`/office/` 返回 404。请先补建：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/active_agent/apps/office
flutter pub get --enforce-lockfile
flutter build web --release --base-href /office/ --no-web-resources-cdn
test -f build/web/index.html && echo 'Flutter Web 构建入口已就绪'
```

构建成功后重新打开 http://127.0.0.1:3218/office/ 。轻量 `/im` 不依赖该 Flutter 构建。这里是补建说明，不代表本次已执行构建修复。

如果缺 Node 依赖，可在 `doc_free` 执行 `npm ci`；Python 缺项目依赖时，在 `active_agent` 执行 `python -m pip install -e .`。日常启动无需每次安装。下载前先短时测试线路；国外源慢时动态读取 `scutil --proxy`，验证当前代理后使用，不把代理端口写死。

## 4. 开三个公网隧道（终端 B、C、D）

先确认本机三个页面都能打开。每个命令占一个终端窗口，保持运行。

终端 B：新版 Doc Free。

```bash
/opt/homebrew/bin/cloudflared tunnel --protocol http2 --url http://127.0.0.1:3218
```

终端 C：AFFiNE。

```bash
/opt/homebrew/bin/cloudflared tunnel --protocol http2 --url http://127.0.0.1:3010
```

终端 D：Docmost。

```bash
/opt/homebrew/bin/cloudflared tunnel --protocol http2 --url http://127.0.0.1:3020
```

看到 `Your quick Tunnel has been created` 后，复制该窗口输出的 `https://...trycloudflare.com`；还要看到 `Registered tunnel connection`。三个窗口对应三个不同域名。HTTP/2 是这次 AFFiNE 大文件加载问题后采用的线路，不保证任何网络都更快；若握手失败可去掉 `--protocol http2` 让工具使用默认协议。

给同事的地址：

| 应用 | 分享方式 |
|---|---|
| Doc Free | 终端 B 的域名后加 `/office/` |
| AFFiNE | 终端 C 的域名后加 `/workspace/779fabb1-3e57-4164-af4c-1ed50153e16a/all` |
| Docmost | 终端 D 的域名即可 |

不要继续复制旧聊天中的临时域名。重新创建 Quick Tunnel 会产生新地址；同一隧道进程中的短暂断网重连不一定改变地址。电脑睡眠或服务停止期间外部无法使用。

## 5. 账号与工作区

- 三套产品分别登录，Doc Free 管理令牌不能替代 AFFiNE/Docmost 账号。
- AFFiNE 登录页输入固定邮箱格式账号，继续选择密码登录。根地址可能打开浏览器本地 Demo Workspace；同事应使用上表的服务器工作区地址。
- AFFiNE/Docmost 的固定体验账号为 `trial01@example.com` 至 `trial05@example.com`，密码按私下提供的凭据使用。本教程不保存密码。
- 本次配置结果：Docmost 5 位均完成；AFFiNE 5 个账号已创建，但仅 `trial01` 确认加入现有工作区，其他 4 位邀请受上游配额限制，未完成。不要把“可以登录”当成“可以看到工作区”。
- Doc Free 新版账号保存在 `active_agent/data/office/access.json`、`demo-company.json`、`test-accounts.json` 等本机私有文件。`admin.json` 是管理凭据，不发给普通成员。
- Docmost 管理员密码本次已变更，使用最新私下确认的密码；服务重启不会把它恢复成旧密码。

## 6. 验收与排错

每个公网地址都应在另一台电脑打开一次，实际登录并打开文档。HTTP 200 只说明请求返回，不能证明编辑器和协作已加载。

- **AFFiNE 白屏或加载很慢**：此前实测首次加载约一分钟，原因包括较大的 JavaScript 包和临时隧道吞吐。先打开本机 `3010` 对比；本机快而公网慢时检查隧道终端、网络和代理。频繁更换域名也会失去原域名的登录会话及缓存。
- **AFFiNE 登录后看不到文档**：确认不是 Local storage / Demo Workspace，且该账号已加入上述工作区。
- **Docmost 能登录但无文档**：检查账号是否加入对应空间及其成员组。
- **公网无法访问**：先查本机页面，再查隧道是否还运行；只有公网失败时再区分 DNS、TLS 和链路错误。`scutil --proxy` 可读取当前系统代理；终端代理变量不等于 Docker daemon 的代理配置。
- **`3218` 或 `1238` 已占用**：用 `lsof` 确认原进程，优先复用；需要重启时回到原启动终端按 Ctrl-C，然后重新运行启动器。不要直接杀掉所有 Node 进程。
- **`/office/` 404**：按第 3 节构建 Flutter 前端，不能靠重开公网隧道解决。
- **多人编辑验收**：两个人使用不同账号、进入同一会话和同一篇文档，点击“协作编辑器”，分别输入不同段落并验证互相可见；模型任务另检查 worker 的执行回执。

临时隧道域名与应用生成的邀请/邮件链接并非自动同步；若邀请链接仍指向 localhost 或旧域名，需要核对 AFFiNE 的 `AFFINE_SERVER_HOST`/`AFFINE_SERVER_HTTPS`、Docmost 的 `DOCMOST_APP_URL`，再按部署配置更新。不要把本地链接直接发给远程同事。

## 7. 停止与下次重启

公网终端 B、C、D 各按 Ctrl-C，停止对外入口。终端 A 按 Ctrl-C，启动器会停止自己启动的后端、协作和 worker。关闭浏览器标签不会停止这些服务。

如需停止两套 Docker 应用并保留数据：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/doc_free
docker compose --env-file .env.affine-docmost -f docker-compose.affine-docmost.yml stop
```

下次按第 2、3、4 节重新启动，重新分发新的公网地址。正常启动无需重新创建账号、清除数据或重新拉取全部镜像。

## 8. 旧版脚本的适用范围

之前的 `freedom/01-demo-tutorial.md` 和 `./start-public.sh` 针对旧版 `3210 + 1234`，旧数据在 `doc_free/data.json`、`yjs-data/`。新版数据在 `active_agent/data/office/`。

如果明确要启动旧版演示，可在 `doc_free` 执行 `./start-public.sh`。它不会启动 Docker 中的 AFFiNE/Docmost，不会为它们建立公网隧道，也不会启动新版办公 worker。不要用它替代第 3 节的新版启动器。
