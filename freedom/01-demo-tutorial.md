# Doc Free 多人在线演示教程

## 1. 启动

在本机执行：

```bash
cd /Users/lwblx/huapohen/agent/execute/enterprise_work/doc_free
./start-public.sh
```

脚本会检查并启动 Doc Free、Hocuspocus，然后创建 Cloudflare Quick Tunnel。把本次输出的 `https://*.trycloudflare.com` 地址发给体验者。不要把访问令牌公开贴到群公告；通过私聊发送即可。

## 2. 加入协作空间

每个人打开公网地址，填写：

- 显示名称：例如 Alice、Bob、Agent-Reviewer；人和 Agent 都使用同一入口模型。
- 访问令牌：本机 `auth.json` 中的 `token`。

进入后左侧显示文档，右侧显示在线成员和共享群聊。打开同一文档，顶部状态应为“多人实时同步”。

## 3. 成语接龙 Demo

1. 点击左侧“成语接龙”。
2. Alice 输入“歌舞升平”，Bob 会在自己的浏览器实时看到。
3. Alice 在群聊输入：

   ```text
   @doc_free 判断当前成语接龙是否正确，并在末尾追加一个以「平」开头的四字成语，只追加一行。
   ```

4. Agent 会在群聊返回判断和执行结果，并把正文写入 Hocuspocus；所有浏览器随后收到同一 CRDT 更新。
5. 可让 Alice、Bob 同时发送两条不同的 `@doc_free` 指令，验证非重叠修改会 rebase 合并。

## 4. 错误英语作文 Demo

1. 点击“错误作文”。系统创建一篇故意包含大量语法错误的英语作文。
2. Alice、Bob、Carol 分别修改不同段落；人的编辑走 Yjs/Hocuspocus，实时合并。
3. 在群聊输入：

   ```text
   @doc_free 检查大家的修改，列出剩余错误，并更新文档。
   ```

4. Agent 会读取最新共同正文，生成修订稿；默认同步 Doc Free、AFFiNE、Docmost。

## 5. 控制同步范围

自然语言可以改变 Agent 的同步目标：

- `只更新 AFFiNE，保留 Doc Free 本地内容`
- `不要同步 Docmost，只在本地修改`
- `仅保存在本地，不要写外部平台`
- 默认不说明时：本地 + AFFiNE + Docmost。

这是提示词约束，不是独立的权限系统。生产版应把目标限制改成服务端策略和明确授权。

## 6. 判断是否成功

- 群聊：消息在所有在线浏览器出现。
- 正文：一个浏览器输入，另一个浏览器即时出现。
- Agent：群聊出现 `doc_free` 回复和 AFFiNE/Docmost 执行状态。
- AFFiNE：进入有效工作区 `779fabb1-...`，能看到对应页面正文。
- Docmost：能看到同名页面和最新内容。

## 7. 当前演示限制

- Quick Tunnel 不是固定域名，隧道进程重启会换 URL。
- 访问令牌是共享设备令牌，昵称用于协作显示，不等于企业身份认证。
- 编辑器当前主要以 Markdown/纯文本映射为主，复杂块、图片和数据库块不是 Doc Free 自己的完整编辑能力。
- 同一区块的 Agent 冲突会重新规划或报告冲突，不保证语义上自动解决所有冲突。
