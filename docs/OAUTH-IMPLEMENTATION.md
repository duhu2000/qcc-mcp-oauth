# OAuth 实现说明

对照《企查查MCP OAuth 接入文档_20260730_V1.4》逐条说明本插件的实现与落点。

## 依赖实现

| 文档章节 | 能力 | 实现位置 | 说明 |
| --- | --- | --- | --- |
| §2 对外服务地址 | 授权集合（5 个 resource） | `lib/constants.js` `QCC_RESOURCES` | company/risk/ipr/operation/executive |
| §5 阶段一 | Protected Resource Metadata | `lib/oauth.js` `discoverProtectedResource` / `resourceMetadataUrl` | 由 stream URL 推导 metadata 地址；解析 `resource`、`authorization_servers`、`scopes_supported` |
| §6 阶段二 | OAuth Server Metadata | `lib/oauth.js` `discoverServerMetadata` | 从 well-known 读取 authorization/token/register/revoke 四个端点，**不硬编码** |
| §7 阶段三 | 动态注册客户端 | `lib/oauth.js` `registerClient` | `token_endpoint_auth_method: none`（无 client_secret）；redirect_uris 用 loopback |
| §8 阶段四 | PKCE S256 + 授权 URL | `lib/oauth.js` `pkcePair` / `buildAuthorizeUrl` / `generateState` | verifier 43–128 位 `[A-Za-z0-9._~-]`；每次授权全新生成；`scope=mcp:tools` |
| §8 阶段四 | Loopback 回调 | `lib/callback-server.js` | 先启动监听再打开授权页；校验 `state`；`code` 单次使用 |
| §9 阶段五 | 授权码换 token | `lib/oauth.js` `exchangeCode` | form-urlencoded；携带 `code_verifier`、`redirect_uri`、`resource` |
| §10 阶段六 | Bearer 调用 MCP | `lib/mcp-provision.js` + `@deepseek-ai/dsh-mcp-client` | 通过 `ctx.loader` 为 mcp-client 条目注入 `Authorization: Bearer` |
| §11 多 Server 复用 | 授权状态模型 | `lib/grant-store.js` `buildGrant` | `QccOAuthGrant` 对齐文档；一份 token 覆盖全部 resource |
| §11.3 | 401 处理 | `lib/index.js` `connect()` | 已有授权先刷新一次再复用；刷新失败才重新授权 |
| §12.1 | refresh 轮换 | `lib/oauth.js` `refreshAccessToken` + `lib/index.js` `refreshGrant` | 单飞刷新；新 refresh_token 覆盖旧值；过期前 `refreshSkewMs` 自动触发 |
| §12.2 | revoke | `lib/oauth.js` `revokeRefreshToken` + `lib/index.js` `disconnect()` | 断开时撤销 refresh_token |
| §13 | 错误处理 | `lib/oauth.js` `OAuthError` | `invalid_grant`/`invalid_client_metadata`/`invalid_scope` 等归一处理 |

## 关键设计决策

### 1. 插件形态：DSH Bundle
包内 `cordis.patch.yml` 声明插件行，`package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。
用户把包名加入 profile `package.json` 的 `dsh.profile.bundles` 即完成注册（参考 `docs/INSTALL.md`）。

### 2. 动态配置 MCP 条目：`ctx.loader`
- 授权成功：`loader.update(id, { config: { headers: { Authorization: 'Bearer <at>' } }, disabled: false })`，`serverName` 不变 → 工具名不变；
- 断开：`loader.update(id, { disabled: true })`（保留配置、可逆）；
- 启动恢复：从存储域读取 grant，重新 provision。

### 3. Token 持久化：`ctx.storageDomain`
- 域 `qcc_mcp_oauth`，表 `grants`，记录 schema 见 `lib/grant-store.js`；
- 落盘位置 `~/.dsh/storages`（目录 0700）。

### 4. 安全
- `loader.update` 会把条目配置写回 profile 配置文件（app-boot ConfigFile 持久化整个 loader 树）→ **token 会出现在 `cordis.patch.yml` 中**；
  缓解：`chmod 600` 配置文件、token 不进入 git、`persistTokens: false` 可仅内存。
- Bearer 只发送给 `authorizedResources` 精确匹配的 URL。
- PKCE 强制 S256；`state` 校验防 CSRF；`code` 单次使用。

### 5. 多账号预留
grant 键 = `grant:{account}`，`config.account` 默认 `default`；如需多账号可扩展（每个账号一份授权状态）。

## 验证矩阵

`npm test`（26 个用例）覆盖：

- 单元：PKCE 字符集/长度/challenge 计算、metadata URL 推导、OAuth 错误归一
- mock 集成：动态注册、完整授权码流程（loopback）、PKCE 不匹配、code 单次使用、refresh 轮换（旧 token 失效）、revoke 后刷新拒绝、MCP 401 challenge 响应头
- 插件级：一键连接（自动模拟用户授权）、授权持久化 + 5 条目创建、重复连接幂等、过期自动刷新（token 轮换 + 条目更新）、断开（revoke + 清除 + 停用）、重启恢复
- 冒烟：插件模块在 DSH 真实 Host 中加载并执行 `apply()`（隔离 dev profile 实测）

## 未覆盖 / 需确认

- 真实 `agent.qcc.com` 端到端授权（需要真实账号在浏览器点击授权）—— 见 `docs/INSTALL.md` 使用流程
- history / legal-regulation / legal-case / tender 是否纳入 OAuth 集合（文档当前仅 5 个）
- SaaS/Web 回调地址白名单、private-use scheme（如需非本地部署）
