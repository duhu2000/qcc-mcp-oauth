# 安装指南

## 前置条件

- DeepSeek Harness（`dsh` CLI）已安装，web profile 可用（`dsh web` 能启动）
- Node.js ≥ 20
- 一个企查查账号（用于在授权页登录授权）

## 方式 A：npm 发布版（推荐给普通用户）

```bash
# 1) 安装插件到 profile（自动安装依赖并注册 bundle）
dsh plugin --profile web add qcc-dsh-mcp-oauth

# 2) 重启 dsh web（Ctrl-C 停止后重新运行 dsh web）
#    注：声明了 dsh.bundle 的包会被 dsh plugin add 自动加入
#    ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles；若未自动注册，
#    手动在该数组追加 "qcc-dsh-mcp-oauth"（与 "@deepseek-ai/dsh-base" 等并列）后再重启
```

## 方式 B：GitHub 直装（未发 npm 时）

```bash
dsh plugin --profile web add github:duhu2000/qcc-mcp-oauth
# 再执行方式 A 的第 2 步（重启）
```

## 方式 C：本地源码

```bash
git clone https://github.com/duhu2000/qcc-mcp-oauth.git
cd qcc-mcp-oauth
dsh plugin --profile web add "link:$(pwd)"
# 再执行方式 A 的第 2 步（重启）
```

## 验证安装

重启后，在对话中输入：

```
查看企查查连接状态
```

- 若返回「企查查 MCP 未连接。对我说"连接企查查"即可一键 OAuth 授权。」→ 安装成功
- 若提示找不到 `qcc_oauth_status` 工具 → 检查 bundle 是否已注册、重启是否完成、日志是否有报错

## 升级 / 卸载

```bash
# 升级
dsh plugin --profile web update qcc-dsh-mcp-oauth
# 卸载（先断开连接）
# 对话中执行 qcc_oauth_disconnect，然后：
dsh plugin --profile web remove qcc-dsh-mcp-oauth
# 并从 package.json 的 bundles 中移除该包名
```

## 常见问题

### 提示与 DSH 0.2.0-rc.2 不兼容？

插件 0.1.7 及更早版本声明的 `@deepseek-ai/dsh-mcp-client` 范围为 `^0.1.0-rc.6`，不包含 `0.2.0-rc.2`。0.1.8 已扩展兼容声明，存储表也改用两版均支持的公开接口 `domain.table()`。

当 npm 已发布 0.1.8 后，安装修复版并重启 DSH：

```bash
dsh plugin --profile web add qcc-dsh-mcp-oauth@0.1.8
```

发布前可在包含此修复的源码目录安装本地版本：

```bash
dsh plugin --profile web add "file:$(pwd)"
```

PowerShell 对应命令为 `dsh plugin --profile web add "file:$((Get-Location).Path)"`。如果使用 Desktop，将 `--profile web` 改为 `--profile desktop`，安装前完全退出 Desktop，安装后重新打开。

### 安装后工具不出现？
1. 确认 `dsh plugin --profile web add` 成功（profile node_modules 里有 `qcc-dsh-mcp-oauth`）；
2. 确认 `package.json` 的 `bundles` 包含包名；
3. 重启 web；
4. 查看启动日志中是否有 `qcc-mcp-oauth` 相关报错。

### 授权页打不开？
- 检查 `openBrowser` 配置（默认 true）；false 时插件会打印授权 URL，可手动复制到浏览器打开。
- macOS/Linux/Windows 分别使用 `open` / `xdg-open` / `start`，如缺失请自行安装（Linux 常见）。

### 回调一直等不到？
- loopback 监听 `127.0.0.1:{随机端口}/callback`，请确认本机防火墙未拦截；
- 授权页提示「暂未完成授权」时，确认 `redirect_uri` 的协议/host/端口/路径与注册一致（插件每次授权重新注册客户端，通常不会出现）；
- 等待超时（默认 5 分钟）会自动报错，可重试。

### token 会过期吗？
- access_token 过期前插件自动刷新；refresh_token 轮换后旧值立即失效；
- `client_id` 默认 90 天有效，成功授权/刷新会自动续期；若长期未用被清理，重新执行"连接企查查"即可（会自动重新注册）。
