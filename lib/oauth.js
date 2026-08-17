/**
 * 企查查 MCP OAuth 客户端
 * 依据《企查查MCP OAuth 接入文档_20260730_V1.4》：
 *   - 阶段一 Protected Resource Metadata
 *   - 阶段二 OAuth Server Metadata
 *   - 阶段三 动态注册客户端（Dynamic Client Registration，无 client_secret）
 *   - 阶段四 授权码 + PKCE(S256)
 *   - 阶段五 授权码换 token
 *   - 阶段六 Bearer token 调用 MCP（由 mcp-client 插件承担）
 *   - §12 Refresh Token（轮换）与 Revoke
 *
 * 所有 endpoint 均从 Server Metadata 动态读取，不硬编码（文档 §6 建议）。
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  DEFAULT_SCOPE,
  VERIFIER_CHARSET,
  VERIFIER_MIN_LENGTH,
  VERIFIER_MAX_LENGTH,
} from './constants.js';

/** 统一的 OAuth 错误：code 为 RFC 6749 错误码（invalid_grant 等），httpStatus 为可选响应码 */
export class OAuthError extends Error {
  constructor(code, description, httpStatus = undefined) {
    super(description ?? code);
    this.name = 'OAuthError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 网络/超时错误 */
export class OAuthNetworkError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'OAuthNetworkError';
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!response.ok) {
      // OAuth 错误响应体形如 { error, error_description }（文档 §13）
      if (body && typeof body === 'object' && typeof body.error === 'string') {
        throw new OAuthError(body.error, body.error_description, response.status);
      }
      throw new OAuthError('http_error', `HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
    }
    return body;
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthNetworkError(`request failed: ${url}`, error);
  } finally {
    clearTimeout(timer);
  }
}

function formEncode(params) {
  return new URLSearchParams(params).toString();
}

/* ─────────────────────────── 阶段一：Protected Resource Metadata ─────────────────────────── */

/**
 * 由 MCP Streamable HTTP URL 推导 protected resource metadata 地址。
 * 规则：在 `/mcp/` 之后插入 `/.well-known/oauth-protected-resource/`。
 * 例：https://agent.qcc.com/mcp/company/stream
 *   → https://agent.qcc.com/mcp/.well-known/oauth-protected-resource/company/stream
 */
export function resourceMetadataUrl(streamUrl) {
  const marker = '/mcp/';
  const index = streamUrl.indexOf(marker);
  if (index === -1) throw new OAuthError('invalid_resource', `stream url must contain ${marker}: ${streamUrl}`);
  return `${streamUrl.slice(0, index + marker.length)}.well-known/oauth-protected-resource/${streamUrl.slice(index + marker.length)}`;
}

/** 请求 protected resource metadata（文档 §5） */
export async function discoverProtectedResource(streamUrl, timeoutMs) {
  const url = resourceMetadataUrl(streamUrl);
  const body = await fetchJson(url, { method: 'GET' }, timeoutMs);
  if (!Array.isArray(body.authorization_servers) || body.authorization_servers.length === 0) {
    throw new OAuthError('invalid_metadata', 'protected resource metadata missing authorization_servers');
  }
  return {
    resource: body.resource,
    authorizationServers: body.authorization_servers,
    scopesSupported: body.scopes_supported ?? [],
    bearerMethodsSupported: body.bearer_methods_supported ?? [],
    resourceName: body.resource_name,
  };
}

/* ─────────────────────────── 阶段二：OAuth Server Metadata ─────────────────────────── */

/** 请求 OAuth Server Metadata（文档 §6）。issuer 通常为 authorization_servers[0]。 */
export async function discoverServerMetadata(issuer, timeoutMs) {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`;
  const body = await fetchJson(url, { method: 'GET' }, timeoutMs);
  for (const field of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint']) {
    if (typeof body[field] !== 'string' || body[field].length === 0) {
      throw new OAuthError('invalid_metadata', `oauth server metadata missing ${field}`);
    }
  }
  return {
    issuer: body.issuer ?? issuer,
    authorizationEndpoint: body.authorization_endpoint,
    tokenEndpoint: body.token_endpoint,
    registrationEndpoint: body.registration_endpoint,
    revocationEndpoint: body.revocation_endpoint,
    responseTypesSupported: body.response_types_supported ?? [],
    grantTypesSupported: body.grant_types_supported ?? [],
    codeChallengeMethodsSupported: body.code_challenge_methods_supported ?? [],
    tokenEndpointAuthMethodsSupported: body.token_endpoint_auth_methods_supported ?? [],
    scopesSupported: body.scopes_supported ?? [],
  };
}

/* ─────────────────────────── 阶段三：动态注册客户端 ─────────────────────────── */

/**
 * 动态注册客户端（文档 §7）。返回 client_id。
 * 不传 client_secret；token_endpoint_auth_method 固定 none。
 */
export async function registerClient(registrationEndpoint, { clientName, redirectUris, scope = DEFAULT_SCOPE, timeoutMs }) {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new OAuthError('invalid_client_metadata', 'redirect_uris is required');
  }
  const body = await fetchJson(
    registrationEndpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope,
      }),
    },
    timeoutMs,
  );
  if (typeof body.client_id !== 'string' || body.client_id.length === 0) {
    throw new OAuthError('invalid_client_metadata', 'registration response missing client_id');
  }
  return { clientId: body.client_id, clientIdIssuedAt: body.client_id_issued_at, clientName: body.client_name };
}

/* ─────────────────────────── PKCE（文档 §8） ─────────────────────────── */

/** 生成 43–128 位、仅含 [A-Za-z0-9._~-] 的 code_verifier */
export function generateVerifier() {
  const bytes = randomBytes(48);
  let verifier = '';
  for (const byte of bytes) {
    verifier += VERIFIER_CHARSET[byte % VERIFIER_CHARSET.length];
  }
  if (verifier.length < VERIFIER_MIN_LENGTH || verifier.length > VERIFIER_MAX_LENGTH) {
    throw new OAuthError('pkce_generation', `unexpected verifier length ${verifier.length}`);
  }
  return verifier;
}

/** code_challenge = BASE64URL(SHA256(code_verifier))，method = S256 */
export function generateCodeChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** 生成一组新的 PKCE 对 */
export function pkcePair() {
  const verifier = generateVerifier();
  return { verifier, challenge: generateCodeChallenge(verifier), method: 'S256' };
}

/* ─────────────────────────── 阶段四：发起用户授权 ─────────────────────────── */

/** 拼装浏览器授权 URL（文档 §8） */
export function buildAuthorizeUrl(metadata, { clientId, redirectUri, state, challenge, challengeMethod = 'S256', resource, scope = DEFAULT_SCOPE }) {
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', challengeMethod);
  if (resource) url.searchParams.set('resource', resource);
  return url.toString();
}

/* ─────────────────────────── 阶段五：授权码换 token ─────────────────────────── */

/**
 * 用 authorization code + code_verifier 换 token（文档 §9）。
 * 返回 { accessToken, tokenType, expiresIn, refreshToken, scope }
 */
export async function exchangeCode(tokenEndpoint, { clientId, code, redirectUri, codeVerifier, resource, timeoutMs }) {
  const body = await fetchJson(
    tokenEndpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        resource,
      }),
    },
    timeoutMs,
  );
  return parseTokenResponse(body);
}

/* ─────────────────────────── §12.1：刷新 token（轮换） ─────────────────────────── */

/** 用 refresh_token 刷新（文档 §12.1）。服务端会作废旧 refresh_token，返回新的一对。 */
export async function refreshAccessToken(tokenEndpoint, { clientId, refreshToken, resource, timeoutMs }) {
  const body = await fetchJson(
    tokenEndpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
        resource,
      }),
    },
    timeoutMs,
  );
  return parseTokenResponse(body);
}

/* ─────────────────────────── §12.2：撤销 refresh_token ─────────────────────────── */

/** 撤销 refresh_token（文档 §12.2）。成功返回 true；已失效/不存在的 token 也视为已撤销。 */
export async function revokeRefreshToken(revocationEndpoint, { clientId, refreshToken, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(revocationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode({
        client_id: clientId,
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }),
      signal: controller.signal,
    });
    // RFC 7009：200 表示成功；400 invalid_token 也视为已撤销
    if (response.ok) return true;
    if (response.status === 400) return true;
    throw new OAuthError('revoke_failed', `revoke returned HTTP ${response.status}`, response.status);
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthNetworkError('revoke request failed', error);
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────────────── 公共 ─────────────────────────── */

function parseTokenResponse(body) {
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new OAuthError('invalid_token_response', 'token response missing access_token');
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in);
  return {
    accessToken: body.access_token,
    tokenType: body.token_type ?? 'Bearer',
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : 3600,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    scope: body.scope ?? DEFAULT_SCOPE,
  };
}

/** 随机 state（每次授权全新生成，文档 §8） */
export function generateState() {
  return randomBytes(16).toString('base64url');
}
