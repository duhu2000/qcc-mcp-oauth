/**
 * 企查查 MCP OAuth 插件（DeepSeek Harness / Cordis 插件）
 *
 * 能力：
 *   - 一键 OAuth 授权（Authorization Code + PKCE S256，动态注册客户端，无 client_secret）
 *   - 一次授权覆盖企查查 OAuth 集合内全部 MCP resource（company/risk/ipr/operation/executive）
 *   - token 持久化（ctx.storageDomain，~/.dsh/storages）与自动刷新（refresh token 轮换）
 *   - 通过 ctx.loader 动态配置 @deepseek-ai/dsh-mcp-client 条目（注入 Bearer header）
 *   - 对话工具：qcc_oauth_connect / qcc_oauth_status / qcc_oauth_disconnect
 *
 * 依据《企查查MCP OAuth 接入文档_20260730_V1.4》
 */
import z from '@deepseek-ai/schemastery';
import { defineQccGrantDomain, GrantStore, buildGrant } from './grant-store.js';
import {
  discoverProtectedResource,
  discoverServerMetadata,
  registerClient,
  pkcePair,
  generateState,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  revokeRefreshToken,
  OAuthError,
} from './oauth.js';
import { startCallbackServer } from './callback-server.js';
import { provisionEntries, disableEntries, entryIdFor } from './mcp-provision.js';
import { registerTools } from './tools.js';
import { openBrowser } from './util.js';
import { DEFAULT_ISSUER, DEFAULT_SCOPE, DEFAULT_GRANT_KEY, QCC_RESOURCES } from './constants.js';

export const name = 'qcc-mcp-oauth';

/** 依赖服务：工具注册、存储域、loader（动态配置 mcp-client 条目） */
export const inject = ['tools', 'storageDomain', 'loader'];

export const Config = z.object({
  /** OAuth 授权服务器 issuer */
  issuer: z.string().default(DEFAULT_ISSUER),
  /** serverKey -> MCP stream url（OAuth 授权集合） */
  resources: z.dict(z.string()).default(QCC_RESOURCES),
  /** 动态注册的客户端展示名（授权页展示，文档 §7/§15） */
  clientName: z.string().default('DeepSeek Harness - QCC MCP'),
  /** loopback 回调路径 */
  callbackPath: z.string().default('/callback'),
  /** 等待回调超时（ms） */
  callbackTimeoutMs: z.number().default(300000),
  /** 网络请求超时（ms） */
  requestTimeoutMs: z.number().default(15000),
  /** 提前刷新阈值（ms）：expires_at 前多少毫秒触发 refresh */
  refreshSkewMs: z.number().default(300000),
  /** 是否自动打开系统浏览器跳转授权页（false = 仅打印授权 URL，适合无头环境/测试） */
  openBrowser: z.boolean().default(true),
  /** 是否把 token 持久化到存储域（false 则仅内存，重启需重新授权） */
  persistTokens: z.boolean().default(true),
  /** 受管 mcp-client 条目的 id 前缀 */
  mcpEntryPrefix: z.string().default('mcp-qcc'),
  /** 授权账号标识（预留多账号；默认 single） */
  account: z.string().default(DEFAULT_GRANT_KEY),
});

export async function apply(ctx, config) {
  const logger = ctx.logger('qcc-mcp-oauth');

  const domain = await ctx.storageDomain.open(defineQccGrantDomain());
  ctx.effect(() => {
    domain.close().catch((error) => logger.warn(`domain close: ${error.message}`));
  });
  const store = new GrantStore(domain);

  /** 插件实例状态（内存态为权威；persistTokens=false 时仅内存） */
  const state = {
    grant: null,
    refreshTimer: undefined,
    refreshPromise: null,
    needsReauth: false,
  };

  /* ───────────────────────── 刷新（§12.1，轮换 + 单飞） ───────────────────────── */

  async function refreshGrant() {
    if (state.refreshPromise) return state.refreshPromise;
    state.refreshPromise = (async () => {
      const grant = state.grant;
      if (!grant?.refreshToken) throw new OAuthError('no_refresh_token', 'no refresh token available');
      const metadata = await discoverServerMetadata(grant.issuer, config.requestTimeoutMs);
      const token = await refreshAccessToken(metadata.tokenEndpoint, {
        clientId: grant.clientId,
        refreshToken: grant.refreshToken,
        resource: grant.entryResource,
        timeoutMs: config.requestTimeoutMs,
      });
      const next = {
        ...grant,
        accessToken: token.accessToken,
        accessTokenExpiresAt: Date.now() + token.expiresIn * 1000 - config.refreshSkewMs,
        refreshToken: token.refreshToken ?? grant.refreshToken,
        updatedAt: Date.now(),
      };
      state.grant = next;
      state.needsReauth = false;
      if (config.persistTokens) await store.put(next, config.account);
      await provisionEntries(ctx, config, next);
      logger.info(`refreshed access token (expires in ${token.expiresIn}s)`);
      scheduleRefresh(next);
      return next;
    })();
    try {
      return await state.refreshPromise;
    } finally {
      state.refreshPromise = null;
    }
  }

  function scheduleRefresh(grant) {
    clearTimeout(state.refreshTimer);
    const delay = Math.max(0, grant.accessTokenExpiresAt - Date.now());
    state.refreshTimer = setTimeout(() => {
      refreshGrant().catch((error) => {
        state.needsReauth = true;
        logger.warn(`token refresh failed — re-authorization required: ${error.message}`);
      });
    }, delay);
    state.refreshTimer.unref?.();
  }

  /* ───────────────────────── 一键连接（完整 OAuth 流程） ───────────────────────── */

  async function fullConnect(server, signal) {
    const entryResource = config.resources[server] ?? QCC_RESOURCES[server];
    if (!entryResource) throw new Error(`unknown server '${server}'; known: ${Object.keys(config.resources).join(', ')}`);

    // 阶段一：Protected Resource Metadata（文档 §5）
    const protectedResource = await discoverProtectedResource(entryResource, config.requestTimeoutMs);
    const canonicalResource = protectedResource.resource ?? entryResource;
    const issuer = protectedResource.authorizationServers[0] ?? config.issuer;

    // 阶段二：OAuth Server Metadata（文档 §6）
    const metadata = await discoverServerMetadata(issuer, config.requestTimeoutMs);

    // 阶段三 + 四 + 五：动态注册 → loopback 监听 → 打开授权页 → 回调 → 换 token
    const callback = await startCallbackServer({
      path: config.callbackPath,
      timeoutMs: config.callbackTimeoutMs,
      signal,
    });
    const registration = await registerClient(metadata.registrationEndpoint, {
      clientName: config.clientName,
      redirectUris: [callback.url],
      timeoutMs: config.requestTimeoutMs,
    });

    const { verifier, challenge, method } = pkcePair();
    const stateParam = generateState();
    const authorizeUrl = buildAuthorizeUrl(metadata, {
      clientId: registration.clientId,
      redirectUri: callback.url,
      state: stateParam,
      challenge,
      challengeMethod: method,
      resource: canonicalResource,
      scope: DEFAULT_SCOPE,
    });

    logger.info(`opening authorization page: ${authorizeUrl}`);
    if (config.openBrowser) openBrowser(authorizeUrl, logger);
    else logger.info(`openBrowser disabled — please open the URL above manually to authorize`);

    const { code, state: returnedState } = await callback.waitForCallback();
    if (returnedState !== stateParam) {
      throw new Error('OAuth callback state mismatch — aborting (possible CSRF)');
    }

    const token = await exchangeCode(metadata.tokenEndpoint, {
      clientId: registration.clientId,
      code,
      redirectUri: callback.url,
      codeVerifier: verifier,
      resource: canonicalResource,
      timeoutMs: config.requestTimeoutMs,
    });

    // 一次授权覆盖完整 OAuth 集合（文档 §11）
    const grant = buildGrant({
      issuer,
      clientId: registration.clientId,
      scope: token.scope ?? DEFAULT_SCOPE,
      token,
      authorizedResources: Object.values(config.resources),
      entryResource: canonicalResource,
      clientName: config.clientName,
      skewMs: config.refreshSkewMs,
    });
    state.grant = grant;
    state.needsReauth = false;
    if (config.persistTokens) await store.put(grant, config.account);

    const ids = await provisionEntries(ctx, config, grant);
    scheduleRefresh(grant);
    return { grant, ids };
  }

  /* ───────────────────────── API 门面（供工具调用） ───────────────────────── */

  const api = {
    async connect(server = 'company', signal) {
      try {
        // 已有授权：优先复用/刷新（文档 §11.2），避免重复弹授权页
        if (state.grant) {
          if (state.grant.accessTokenExpiresAt > Date.now()) {
            await provisionEntries(ctx, config, state.grant);
            return { ok: true, message: `企查查 MCP 已连接（复用现有授权，覆盖 ${Object.keys(config.resources).length} 个 Server）`, detail: { reused: true } };
          }
          try {
            await refreshGrant();
            return { ok: true, message: '企查查 MCP 已连接（access_token 已自动刷新）', detail: { refreshed: true } };
          } catch (error) {
            logger.warn(`refresh failed, re-authorizing: ${error.message}`);
          }
        }
        const { grant, ids } = await fullConnect(server, signal);
        return {
          ok: true,
          message: `企查查 MCP 授权成功，已连接 ${ids.length} 个 MCP Server（company/risk/ipr/operation/executive），可以直接使用 mcp__qcc-* 工具`,
          detail: { clientId: grant.clientId, expiresAt: grant.accessTokenExpiresAt, entries: ids },
        };
      } catch (error) {
        logger.error(`connect failed: ${error.message}`);
        return {
          ok: false,
          message: `企查查 MCP 连接失败：${error.message}${error instanceof OAuthError && error.code === 'invalid_grant' ? '（授权已失效，请重试连接）' : ''}`,
          detail: { error: error.message },
        };
      }
    },

    async status() {
      const grant = state.grant ?? (config.persistTokens ? await store.get(config.account) : null);
      if (!grant) {
        return { ok: true, message: '企查查 MCP 未连接。对我说"连接企查查"即可一键 OAuth 授权。', detail: { connected: false } };
      }
      const now = Date.now();
      const expired = grant.accessTokenExpiresAt <= now;
      return {
        ok: true,
        message: [
          `企查查 MCP 已连接：${grant.clientName}`,
          `授权覆盖 ${grant.authorizedResources.length} 个 MCP Server：${grant.authorizedResources.length}`,
          `access_token 过期时间：${new Date(grant.accessTokenExpiresAt).toLocaleString()}${expired ? '（已过期）' : ''}`,
          state.needsReauth ? '⚠️ 需要重新授权（对我说"连接企查查"）' : '状态正常，token 自动刷新中',
        ].join('；'),
        detail: {
          connected: true,
          clientId: grant.clientId,
          accessTokenExpiresAt: grant.accessTokenExpiresAt,
          needsReauth: state.needsReauth,
          authorizedResources: grant.authorizedResources,
          account: config.account,
        },
      };
    },

    async disconnect() {
      const grant = state.grant;
      let revoked = false;
      if (grant?.refreshToken) {
        try {
          const metadata = await discoverServerMetadata(grant.issuer, config.requestTimeoutMs);
          revoked = await revokeRefreshToken(metadata.revocationEndpoint, {
            clientId: grant.clientId,
            refreshToken: grant.refreshToken,
            timeoutMs: config.requestTimeoutMs,
          });
        } catch (error) {
          logger.warn(`revoke failed (best-effort): ${error.message}`);
        }
      }
      clearTimeout(state.refreshTimer);
      state.grant = null;
      state.needsReauth = false;
      if (config.persistTokens) await store.delete(config.account);
      const ids = await disableEntries(ctx, config);
      return {
        ok: true,
        message: `企查查 MCP 已断开：refresh_token ${revoked ? '已撤销' : '已清除（撤销失败，本机凭证已删除）'}，${ids.length} 个 MCP Server 已停用`,
        detail: { revoked, entries: ids },
      };
    },
  };

  /* ───────────────────────── 启动恢复 + 工具注册 ───────────────────────── */

  const disposerTools = registerTools(ctx, api);
  ctx.effect(() => disposerTools());

  // 启动时恢复已授权状态（文档 §11.2：Server 切换/重启可复用，无需重新授权）
  if (config.persistTokens) {
    const stored = await store.get(config.account);
    if (stored) {
      state.grant = stored;
      try {
        if (stored.accessTokenExpiresAt <= Date.now()) {
          await refreshGrant();
        } else {
          await provisionEntries(ctx, config, stored);
          scheduleRefresh(stored);
        }
        logger.info(`restored QCC MCP authorization for account '${config.account}'`);
      } catch (error) {
        state.needsReauth = true;
        logger.warn(`restore failed (${error.message}); run qcc_oauth_connect to re-authorize`);
      }
    }
  }

  ctx.effect(() => {
    clearTimeout(state.refreshTimer);
  });

  logger.info(`qcc-mcp-oauth plugin active (manages ${Object.keys(config.resources).length} QCC MCP servers)`);
  // 注意：apply 不得返回普通对象（cordis 会将其视为非法 effect），工具与状态都挂在内部分装上。
}

export { entryIdFor };
