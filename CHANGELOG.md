# Changelog

## [0.1.5] - 2026-08

### 变更（开放第 6 个 SERVER：history 历史信息）

- `QCC_RESOURCES` 从 5 个扩到 6 个，新增 `history`（历史信息），对齐官网「6 个 SERVER / 185 工具」口径。
- **按 token 实际授权动态配置条目**：授权成功后解析 access_token（JWT）的 `resource` claim，
  与 `resources` 配置求交集，只挂载实际授权的 SERVER —— 企业认证账号 token 含 history（6 个），
  个人账号不含（5 个），避免把未授权的 history 挂出来却调不通。
- `provisionEntries` / `disableEntries` 等改为由 `grant.authorizedResources` 反推 serverKey
  （新增 `grantedServerKeys`），connect/status 文案动态列出实际 SERVER 名。

### 测试

- 新增 `extractTokenResources` 单元测试（JWT 授权范围解析：含/不含 history、非 JWT、无 claim）。
- 新增「个人账号 token 不含 history → 只建 5 个条目」集成测试（mock 支持 JWT resource claim）。
- 全部断言由 5 个条目更新为 6 个；35 用例全部通过。

## [0.1.4] - 2026-08

### 修复（插件市场收录衔接）

- `package.json` 补充 `repository` / `homepage` 字段，指向 GitHub 仓库
  `duhu2000/qcc-mcp-oauth`。该字段用于 awesome-dsh-plugin 的 npm 探测
  （`scripts/probe-npm.mjs`）把 npm 包与 GitHub 仓库做反查校验：此前缺少此字段，
  市场里该条目被判定为「未发布 npm」而回退到 `github:` 源码安装；补上后即可被识别为
  npm 包 `qcc-dsh-mcp-oauth`，市场一键安装走 npm 预构建，免 `allowBuilds` 构建授权。

## [0.1.3] - 2026-08

### 修复（安装/连接实测 + Windows 测试反馈的 5 个 BUG）

1. **对话工具注册后立即被卸载**（agent 看不到 `qcc_oauth_connect/status/disconnect`）：
   `ctx.effect(() => disposerTools())` 中 cordis 会**立即执行**回调，等价于注册瞬间调用卸载函数。
   改为 `ctx.effect(() => disposerTools)`（返回卸载函数，fiber 卸载时才调用）。
2. **存储域被立即关闭**（授权成功但 token 不落盘、重启不恢复）：
   `ctx.effect(() => { domain.close() })` 同样立即执行，导致后续 `store.put/get` 全部抛
   `DomainError('closed')`。改为返回关闭函数。
3. **首次授权后 mcp-client 条目不创建**：`provisionEntries` 用 `ctx.loader.resolve(id)` 探测条目
   存在性，而当前 loader 版本对不存在的条目**抛错**（`cannot resolve entry`）而非返回 undefined。
   改为非抛错的 `hasEntry()` 探测。
4. **插件永远停留在 loading、自动刷新不调度**：`provisionEntries` 末尾的 `ctx.loader.await()` 会
   等待包括插件自身在内的所有条目 fiber 完成，而当前 `apply()` 正运行在自身 fiber 内，形成**自死锁**。
   移除 `loader.await()`（新建条目在后台加载，无需阻塞插件）。
5. **Windows 打开授权页丢失全部查询参数**：`cmd /c start` 把 URL 中未加引号的 `&` 当作命令分隔符，
   浏览器只打开第一个 `&` 之前的部分。改为 `start "" "<url>"` 并用 `windowsVerbatimArguments: true`
   原样传递引号（整条 URL 置于一对引号内）。

### 测试
- 插件集成测试的伪上下文 `ctx.effect` 改为模拟真实 cordis 语义（立即执行回调、返回值作为 disposer），
  使上述回归可被测试捕获。
- 新增 `util.test.mjs`：跨平台浏览器打开命令构建（重点覆盖 Windows `&` 保护与 verbatim 参数）。
- 30 个用例全部通过。

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
