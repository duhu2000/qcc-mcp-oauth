/**
 * oauth.js 单元/集成测试（对 mock OAuth 服务器）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMockQccServer } from './mock-oauth-server.mjs';
import {
  OAuthError,
  resourceMetadataUrl,
  discoverProtectedResource,
  discoverServerMetadata,
  registerClient,
  generateVerifier,
  generateCodeChallenge,
  pkcePair,
  generateState,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  revokeRefreshToken,
} from '../lib/oauth.js';
import { startCallbackServer } from '../lib/callback-server.js';
import { VERIFIER_CHARSET } from '../lib/constants.js';

let mock;
let base;
let metadata;

before(async () => {
  mock = await createMockQccServer({ expiresIn: 3600 });
  base = mock.base;
  metadata = await discoverServerMetadata(base);
});

after(async () => {
  await mock.close();
});

const ENTRY = () => `${base}/mcp/company/stream`;

test('PKCE: verifier 字符集与长度', () => {
  for (let i = 0; i < 20; i++) {
    const verifier = generateVerifier();
    assert.ok(verifier.length >= 43 && verifier.length <= 128, `length ${verifier.length}`);
    for (const ch of verifier) assert.ok(VERIFIER_CHARSET.includes(ch), `bad char ${ch}`);
  }
});

test('PKCE: code_challenge = BASE64URL(SHA256(verifier))', () => {
  const verifier = generateVerifier();
  const expected = createHash('sha256').update(verifier).digest('base64url');
  assert.equal(generateCodeChallenge(verifier), expected);
  const pair = pkcePair();
  assert.equal(pair.method, 'S256');
  assert.equal(pair.challenge, generateCodeChallenge(pair.verifier));
});

test('resourceMetadataUrl: 正确插入 .well-known 段', () => {
  assert.equal(
    resourceMetadataUrl('https://agent.qcc.com/mcp/company/stream'),
    'https://agent.qcc.com/mcp/.well-known/oauth-protected-resource/company/stream',
  );
  assert.throws(() => resourceMetadataUrl('https://agent.qcc.com/nope'), OAuthError);
});

test('阶段一/二：元数据发现', async () => {
  const protectedResource = await discoverProtectedResource(ENTRY());
  assert.equal(protectedResource.resource, ENTRY());
  assert.deepEqual(protectedResource.authorizationServers, [base]);
  assert.ok(protectedResource.scopesSupported.includes('mcp:tools'));
  assert.equal(metadata.issuer, base);
  assert.ok(metadata.authorizationEndpoint.endsWith('/oauth/authorize'));
  assert.ok(metadata.tokenEndpoint.endsWith('/oauth/token'));
  assert.ok(metadata.registrationEndpoint.endsWith('/oauth/register'));
  assert.ok(metadata.revocationEndpoint.endsWith('/oauth/revoke'));
});

test('阶段三：动态注册客户端', async () => {
  const reg = await registerClient(metadata.registrationEndpoint, {
    clientName: 'dsh-test',
    redirectUris: ['http://127.0.0.1:39991/callback'],
  });
  assert.equal(reg.clientId, mock.state.clientId);
});

test('阶段三：非法注册元数据被拒绝', async () => {
  await assert.rejects(
    registerClient(metadata.registrationEndpoint, { clientName: 'x', redirectUris: [] }),
    (e) => e instanceof OAuthError && e.code === 'invalid_client_metadata',
  );
  await assert.rejects(
    registerClient(metadata.registrationEndpoint, { clientName: 'x', redirectUris: ['https://evil.example/cb'] }),
    (e) => e instanceof OAuthError && e.code === 'invalid_client_metadata',
  );
});

test('阶段四/五：完整授权码流程（loopback 回调）', async () => {
  const callback = await startCallbackServer({ timeoutMs: 10_000 });
  try {
    const reg = await registerClient(metadata.registrationEndpoint, { clientName: 'dsh-test', redirectUris: [callback.url] });
    const { verifier, challenge } = pkcePair();
    const stateParam = generateState();
    const authorizeUrl = buildAuthorizeUrl(metadata, {
      clientId: reg.clientId,
      redirectUri: callback.url,
      state: stateParam,
      challenge,
      resource: ENTRY(),
    });
    const res = await fetch(`${authorizeUrl}&auto=1`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.ok(location.startsWith(callback.url));

    const callbackHit = fetch(location).then((r) => r.status);
    const { code, state: returnedState } = await callback.waitForCallback();
    assert.equal(returnedState, stateParam);
    assert.equal(await callbackHit, 200);

    const token = await exchangeCode(metadata.tokenEndpoint, {
      clientId: reg.clientId,
      code,
      redirectUri: callback.url,
      codeVerifier: verifier,
      resource: ENTRY(),
    });
    assert.ok(token.accessToken.startsWith('mock-at-'));
    assert.ok(token.refreshToken);
    assert.equal(token.tokenType, 'Bearer');
    assert.equal(token.scope, 'mcp:tools');
    assert.equal(token.expiresIn, 3600);
  } finally {
    await callback.close();
  }
});

test('PKCE 不匹配 → invalid_grant', async () => {
  const callback = await startCallbackServer({ timeoutMs: 10_000 });
  try {
    const reg = await registerClient(metadata.registrationEndpoint, { clientName: 'dsh-test', redirectUris: [callback.url] });
    const { challenge } = pkcePair();
    const stateParam = generateState();
    const authorizeUrl = buildAuthorizeUrl(metadata, {
      clientId: reg.clientId, redirectUri: callback.url, state: stateParam, challenge, resource: ENTRY(),
    });
    const res = await fetch(`${authorizeUrl}&auto=1`, { redirect: 'manual' });
    const location = res.headers.get('location');
    await fetch(location);
    const { code } = await callback.waitForCallback();
    await assert.rejects(
      exchangeCode(metadata.tokenEndpoint, {
        clientId: reg.clientId, code, redirectUri: callback.url,
        codeVerifier: 'x'.repeat(43), resource: ENTRY(),
      }),
      (e) => e instanceof OAuthError && e.code === 'invalid_grant',
    );
  } finally {
    await callback.close();
  }
});

test('授权码单次使用：重复换码 → invalid_grant', async () => {
  const callback = await startCallbackServer({ timeoutMs: 10_000 });
  try {
    const reg = await registerClient(metadata.registrationEndpoint, { clientName: 'dsh-test', redirectUris: [callback.url] });
    const { verifier, challenge } = pkcePair();
    const stateParam = generateState();
    const authorizeUrl = buildAuthorizeUrl(metadata, {
      clientId: reg.clientId, redirectUri: callback.url, state: stateParam, challenge, resource: ENTRY(),
    });
    const res = await fetch(`${authorizeUrl}&auto=1`, { redirect: 'manual' });
    await fetch(res.headers.get('location'));
    const { code } = await callback.waitForCallback();
    const params = {
      clientId: reg.clientId, code, redirectUri: callback.url, codeVerifier: verifier, resource: ENTRY(),
    };
    const first = await exchangeCode(metadata.tokenEndpoint, params);
    assert.ok(first.accessToken);
    await assert.rejects(
      exchangeCode(metadata.tokenEndpoint, params),
      (e) => e instanceof OAuthError && e.code === 'invalid_grant',
    );
  } finally {
    await callback.close();
  }
});

test('§12.1 refresh token 轮换：旧 refresh token 立即失效', async () => {
  const callback = await startCallbackServer({ timeoutMs: 10_000 });
  try {
    const reg = await registerClient(metadata.registrationEndpoint, { clientName: 'dsh-test', redirectUris: [callback.url] });
    const { verifier, challenge } = pkcePair();
    const stateParam = generateState();
    const authorizeUrl = buildAuthorizeUrl(metadata, {
      clientId: reg.clientId, redirectUri: callback.url, state: stateParam, challenge, resource: ENTRY(),
    });
    const res = await fetch(`${authorizeUrl}&auto=1`, { redirect: 'manual' });
    await fetch(res.headers.get('location'));
    const { code } = await callback.waitForCallback();
    const token = await exchangeCode(metadata.tokenEndpoint, {
      clientId: reg.clientId, code, redirectUri: callback.url, codeVerifier: verifier, resource: ENTRY(),
    });

    const refreshed = await refreshAccessToken(metadata.tokenEndpoint, {
      clientId: reg.clientId, refreshToken: token.refreshToken, resource: ENTRY(),
    });
    assert.ok(refreshed.accessToken);
    assert.notEqual(refreshed.refreshToken, token.refreshToken, 'refresh token 必须轮换');

    await assert.rejects(
      refreshAccessToken(metadata.tokenEndpoint, { clientId: reg.clientId, refreshToken: token.refreshToken, resource: ENTRY() }),
      (e) => e instanceof OAuthError && e.code === 'invalid_grant',
      '旧 refresh token 应已失效',
    );
  } finally {
    await callback.close();
  }
});

test('§12.2 revoke 后 refresh → invalid_grant', async () => {
  const callback = await startCallbackServer({ timeoutMs: 10_000 });
  try {
    const reg = await registerClient(metadata.registrationEndpoint, { clientName: 'dsh-test', redirectUris: [callback.url] });
    const { verifier, challenge } = pkcePair();
    const stateParam = generateState();
    const authorizeUrl = buildAuthorizeUrl(metadata, {
      clientId: reg.clientId, redirectUri: callback.url, state: stateParam, challenge, resource: ENTRY(),
    });
    const res = await fetch(`${authorizeUrl}&auto=1`, { redirect: 'manual' });
    await fetch(res.headers.get('location'));
    const { code } = await callback.waitForCallback();
    const token = await exchangeCode(metadata.tokenEndpoint, {
      clientId: reg.clientId, code, redirectUri: callback.url, codeVerifier: verifier, resource: ENTRY(),
    });

    const revoked = await revokeRefreshToken(metadata.revocationEndpoint, {
      clientId: reg.clientId, refreshToken: token.refreshToken,
    });
    assert.equal(revoked, true);

    await assert.rejects(
      refreshAccessToken(metadata.tokenEndpoint, { clientId: reg.clientId, refreshToken: token.refreshToken, resource: ENTRY() }),
      (e) => e instanceof OAuthError && e.code === 'invalid_grant',
    );
  } finally {
    await callback.close();
  }
});

test('MCP stream：无 token → 401 + resource_metadata 响应头；带 token → 200', async () => {
  const res401 = await fetch(`${base}/mcp/risk/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  });
  assert.equal(res401.status, 401);
  const challenge = res401.headers.get('www-authenticate');
  assert.ok(challenge.includes('resource_metadata='), challenge);
  assert.ok(challenge.includes(`${base}/mcp/.well-known/oauth-protected-resource/risk/stream`), challenge);

  const res200 = await fetch(`${base}/mcp/risk/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mock-at-abc' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  });
  assert.equal(res200.status, 200);
});
