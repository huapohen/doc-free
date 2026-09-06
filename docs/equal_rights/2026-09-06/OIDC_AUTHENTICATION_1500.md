# 可配置登录与外部身份绑定 · 2026-09-06

- 记录时间：2026-09-06 15:00 Asia/Shanghai；新实现处于 `equal_rights` 工作树，最终实现 commit 以本阶段 RELEASE/提交记录为准。
- 文档基线：Doc Free `862609f45d7d4e61c1b2a9c4d33fe527fd31b5e1`（2026-09-06T12:49:59+08:00）。上阶段实现基线为 `901b49bdd268b98dae74613a19d40d7d69891137`。
- 配对前端文档基线：Active Agent `3beae3137c3193555360145300f81a0b5a1c888c`；上阶段实现 `2fad0ac68a05a39cf7d6abe55624b771bfa3ae62`。
- 描述：增加真实可执行的 OIDC Authorization Code + PKCE 身份适配器、管理员显式绑定、登录发现接口及统一可撤销会话。这里没有接入真实企业租户；测试使用隔离的本机身份提供方。

## 默认行为与配置

不设置 `DOC_FREE_AUTH_CONFIG` 时，本地密码登录开启、机器令牌登录保留、外部 provider 列表为空。`{"local_password":false}` 停用密码登录、密码设置以及已有密码会话；机器凭据仍由既有成员生命周期管理。

`DOC_FREE_AUTH_CONFIG` 为部署配置 JSON 的**绝对路径**，启动时读取，配置变更需要重启后端。可从 `config/auth.example.json` 复制到仓库之外的受限部署配置目录。示例域名不提供实际身份服务。不要把包含真实企业配置的文件误当公开示例提交。

```sh
export DOC_FREE_AUTH_CONFIG=/secure/config/doc-free-auth.json
node server.js
```

真实 provider 的 `issuer`、authorization/token/JWKS endpoint、`client_id`、固定 `redirect_uri` 必须来自租户管理员核对过的同一套应用注册。这里不执行不受约束的动态 discovery，也不允许用户请求提供 endpoint。配置拒绝未知字段，帮助发现误拼造成的失效。

| 字段 | 规则 |
| --- | --- |
| `local_password` | 布尔值，默认 `true` |
| `oidc.providers` | 最多 8 个；未配置为 `[]` |
| `id` | 1–40 位，小写字母开头，后续允许数字、`_`、`-` |
| `label` | 对外展示的非敏感登录名称，最多 100 字符 |
| `issuer` | 精确匹配 ID token 的 `iss`，包含尾斜杠差异 |
| `authorization_endpoint` / `token_endpoint` / `jwks_uri` | 固定 HTTPS 地址，禁止 URL 用户名/密码、query 和 fragment |
| `redirect_uri` | 固定 HTTPS URL；path 必须是 `/api/im/auth/oidc/<id>/callback` |
| `client_id` | 同时为 ID token 必須匹配的 audience |
| `token_endpoint_auth_method` | `none`（默认）或 `client_secret_basic` |
| `client_secret_env` | basic 模式必需，值为环境变量**名称**；秘密本身从该环境变量读入，禁止 JSON 中配置 `client_secret` |
| `allowed_algorithms` | 当前实现只接受 `["RS256"]`；不支持 `none`、HS256 或任意客户端指定算法 |
| `scopes` | 默认 `["openid"]`；必须含 openid，不申请 offline_access |

本机测试可设置 `DOC_FREE_AUTH_ALLOW_HTTP_LOOPBACK=1`，仅允许 `localhost`、`127.0.0.1`、`[::1]` 的 HTTP。`NODE_ENV=production` 时该开关无效。生产 provider 与回调必须由 HTTPS 提供；反向代理保留 callback query 和 Set-Cookie，禁止把 OAuth query、一次性码、令牌或响应内容写入访问日志。应用不信任 Host 头来生成回调地址。

## 五端共用实际登录流程

1. `GET /api/im/auth/providers` 无需凭据，返回：
   ```json
   {"local_password":{"enabled":true},"machine_token":{"enabled":true},"providers":[{"id":"company","label":"企业账号","protocol":"oidc","start_endpoint":"/api/im/auth/oidc/company/start"}]}
   ```
   无 provider 时前端不展示企业登录入口；发现接口不返回 issuer、client secret、JWKS 或 token endpoint。
2. App 生成随机 `code_verifier`（RFC 7636，43–128 位），留在本次登录内存中，计算 SHA-256 base64url 无填充的 `code_challenge`。
3. `POST /api/im/auth/oidc/company/start`，JSON `{"code_challenge":"<43位challenge>"}`，得到 `{authorization_url,expires_in:600}`。authorization_url 指向本服务一次性浏览器启动入口，包含的是短期 launch ticket，既不是会话 token，也不是 ID token。
4. 打开系统浏览器。`GET .../authorize?ticket=...` 消耗 ticket，设置 HttpOnly / SameSite=Lax 浏览器绑定 cookie；HTTPS 使用 `__Host-` 前缀和 Secure。再跳转到固定身份服务地址。服务端另行生成 OIDC PKCE verifier、state、nonce，二者与 App 的兑换 verifier 相互独立。
5. 浏览器回到 `GET .../callback?code=...&state=...`。只接受 GET/code flow；检查 state、一次性使用和浏览器 cookie。如果 provider 返回 `iss`，必须精确匹配配置。服务端到固定 token endpoint 兑换，不接受跨域跳转。
6. ID token 验证成功后，页面显示随机 256 位的一次性登录码，有效期 **2 分钟**。用户复制回刚才的 App。页面设置 no-store、no-referrer、禁止第三方资源/脚本/表单/frame；任何远程 token 都不返回 App。
7. `POST /api/im/auth/oidc/company/exchange`，JSON `{"code":"<页面登录码>","code_verifier":"<App保存的verifier>"}`。校验成功后再检查服务器身份绑定，返回与密码登录一致的 `{principal,token,expires_at,session_id}`。登录码用后即失效；知道码但没有 verifier 不能兑换。

该流程不依赖平台深链。不要把授权链接或一次性码转给其他人。App 丢失 verifier、服务端重启、用户打开另一轮同 provider 的浏览器授权导致 cookie 改变时，应重新发起登录。

## 身份与权限

外部 claims 仅证明 `(issuer, subject)`；email、name、roles、groups、kind 均不能创建成员、选择人/Agent 类型或授予企业权限。管理员先用既有流程创建成员，再调用下列接口绑定。绑定是实例管理凭据的操作，普通成员及企业业务角色不会因此取得管理凭据。

| 接口 | 用途 |
| --- | --- |
| `GET /api/im/admin/auth/bindings` | 管理员读取最近 1,000 条绑定记录 |
| `POST /api/im/admin/auth/bindings` | `{provider_id,subject,principal_id}`；可选 issuer 必须等于配置 |
| `DELETE /api/im/admin/auth/bindings/<binding-id>` | 撤销绑定并立即撤销该绑定签发的所有会话 |

同一 issuer+subject 只能有一条有效绑定，变更目标必须先撤销旧绑定。subject 是身份方的稳定、不透明 ID，不能用未验证的 email 猜测。支持人和 Agent 同样使用已绑定身份登录。未绑定返回 `external_identity_unbound`；被停用/撤销成员返回 `external_identity_unavailable`。撤销绑定不会改写机器令牌，也不会撤销无关的密码会话。

新会话仍由 `native-accounts.js` 签发：随机 256 位凭据，持久化仅 SHA-256，12 小时有效，支持会话列表/退出/撤销。每次认证重新检查成员有效性、binding 状态和当前 provider 配置。因此停用 provider 或成员会使已有外部会话失效。登录/绑定/凭据签发没有加入 A2A 持久任务白名单，远程 ID/access token、密码或兑换码不会成为房间文档或 A2A 回执。

## 验证与资源边界

- JWT 仅 RS256；拒绝 unapproved typ/crit/jku/jwk/x5u；`kid` 只在已配置 JWKS 中选择；RSA 至少 2048 位；拒绝重复 kid、非签名用途、私钥字段和不兼容 key_ops。
- 校验签名、精确 issuer、audience、azp、多 audience 约束、exp、iat、nbf、nonce；exp 到时立即失效；iat/nbf 时钟偏差最多 60 秒。iat 必须属于本次授权时间窗口。如含 at_hash/c_hash，同时校验对应 token/code 摘要。
- token/JWKS 请求最多 5 秒、响应体最多 128 KiB，禁止重定向；JWT 最多 32 KiB。没有无限重试。JWKS 缓存 5 分钟，未知 kid 最短 30 秒才刷新，控制轮换刷新风暴。
- 每分钟实例最多 60 次 start，callback 和 exchange 分别最多 120 次；最多 500 条在途 flow 和 500 条待兑换码。失败不会输出 provider 原始响应。
- 临时 flow 与码只在内存中存在。当前部署要求单实例或从 start 到 callback/exchange 保持同一实例的路由；不声称多实例无状态 SSO 已完成。重启必须重新登录授权。

## 已执行验证

```sh
node --test tests/native-auth.test.js tests/native-auth-http.test.js tests/native-accounts.test.js
```

2026-09-06 本轮 **42/42 通过**：36 项 OIDC/config 用例、5 项现有密码会话用例、1 项真实 `server.js` 隔离集成。server 集成包含 **22 个认证/业务 API 请求**及浏览器/provider 往返，验证发现、管理员绑定、OIDC 登录、REST/MCP/A2A 身份一致、绑定撤销后拒绝访问、密码/机器凭据互不混用、重启后 provider 停用。测试无真实企业请求、无生产账号、无已有 3218 服务操作。

本记录证明本机合成 provider 下的协议行为，**不证明真实企业租户已经联通**。真实验收仍需要管理员提供应用注册、正确 issuer/endpoints、client 配置、HTTPS 回调注册和实际成员 subject 绑定，再按上述完整流程验证。
