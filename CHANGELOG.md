# Changelog

## [0.1.3] - 2026-08

### 修复（安装/连接实测发现的 3 个 BUG）

1. **对话工具注册后立即被卸载**（agent 看不到 `qcc_oauth_connect/status/disconnect`）：
   `ctx.effect(() => disposerTools())` 中 cordis 会**立即执行**回调，等价于注册瞬间调用卸载函数。
   改为 `ctx.effect(() => disposerTools)`（返回卸载函数，fiber 卸载时才调用）。
2. **存储域被立即关闭**（授权成功但 token 不落盘、重启不恢复）：
   `ctx.effect(() => { domain.close() })` 同样立即执行，导致后续 `store.put/get` 全部抛
   `DomainError('closed')`。改为返回关闭函数。
3. **首次授权后 mcp-client 条目不创建**：`provisionEntries` 用 `ctx.loader.resolve(id)` 探测条目
   存在性，而当前 loader 版本对不存在的条目**抛错**（`cannot resolve entry`）而非返回 undefined。
   改为非抛错的 `hasEntry()` 探测。

### 测试
- 插件集成测试的伪上下文 `ctx.effect` 改为模拟真实 cordis 语义（立即执行回调、返回值作为 disposer），
  使上述回归可被测试捕获。

## [0.1.2] - 2026-08

### 新增
- `autoConnectOnActivate`（默认开启）：插件激活且无有效授权时自动发起 OAuth 授权（自动打开授权页），安装重启后无需手动触发；可用 `autoConnectOnActivate: false` 关闭。

## [0.1.1] - 2026-08

### 变更
- 同步 npm 包 README 安装步骤：新增「让 Agent 安装」指引、简化为两步安装（自动注册 bundle）、包内含 `install.sh`。

## [0.1.0] - 2026-08

首个可运行版本。

### 新增
- 支持「让 Agent 安装」：一键安装脚本 `install.sh` + README 安装指引（含 dsh-plugin-marketplace 兜底按钮场景）
- 一键 OAuth 授权连接企查查 MCP（Authorization Code + PKCE S256，动态注册客户端，无 client_secret）
- 一次授权覆盖企查查 OAuth 集合全部 MCP Server（company / risk / ipr / operation / executive）
- loopback 回调（127.0.0.1 随机端口），state 校验，code 单次使用
- token 持久化（DSH 存储域 `~/.dsh/storages`）与重启自动恢复
- access_token 过期前自动刷新（refresh token 轮换、单飞刷新）
- 断开时调用 OAuth revoke 撤销 refresh_token
- 对话工具：`qcc_oauth_connect` / `qcc_oauth_status` / `qcc_oauth_disconnect`
- 通过 `ctx.loader` 动态配置 `@deepseek-ai/dsh-mcp-client` 条目（注入 Bearer header）
- DSH Bundle 分发（包内 `cordis.patch.yml` 自动合入插件行）

### 测试
- 26 个用例：PKCE、元数据发现、动态注册、完整授权码流程（mock OAuth 服务器）、
  refresh 轮换、revoke、插件级集成（连接/幂等/自动刷新/断开/重启恢复）
- DSH 真实 Host 加载冒烟（隔离 dev profile 实测 `apply()` 执行）
