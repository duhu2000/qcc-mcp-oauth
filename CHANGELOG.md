# Changelog

## [0.1.0] - 2026-08

首个可运行版本。

### 新增
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
