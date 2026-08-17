/**
 * M3 真实 OAuth 授权冒烟脚本（对真实 agent.qcc.com）
 *
 * 流程：
 *   1. 元数据发现（真实端点）→ 动态注册 → 打开授权 URL（打印，也可自动打开）
 *   2. 等待用户在浏览器完成企查查授权，loopback 接收回调 → 换 token
 *   3. 用真实 access_token 调真实 MCP：initialize + tools/list（company），打印工具数量
 *   4. 结果写入 /tmp/qcc-smoke-result.json（不进入仓库）
 *
 * 用法：node test/real-smoke.mjs [--open]
 *   --open   自动调用系统浏览器打开授权页（默认仅打印 URL）
 */
import { writeFile } from 'node:fs/promises';
import {
  discoverProtectedResource,
  discoverServerMetadata,
  registerClient,
  pkcePair,
  generateState,
  buildAuthorizeUrl,
  exchangeCode,
} from '../lib/oauth.js';
import { startCallbackServer } from '../lib/callback-server.js';
import { openBrowser } from '../lib/util.js';
import { QCC_RESOURCES, DEFAULT_ISSUER } from '../lib/constants.js';

const ENTRY = QCC_RESOURCES.company;
const openFlag = process.argv.includes('--open');

console.log(`[smoke] issuer=${DEFAULT_ISSUER} entry=${ENTRY} openBrowser=${openFlag}`);

// 1. 元数据发现（真实）
const protectedResource = await discoverProtectedResource(ENTRY);
console.log('[smoke] protected resource:', protectedResource.resource, '| servers:', protectedResource.authorizationServers);
const issuer = protectedResource.authorizationServers[0] ?? DEFAULT_ISSUER;
const metadata = await discoverServerMetadata(issuer);
console.log('[smoke] oauth metadata endpoints ok:', metadata.authorizationEndpoint);

// 2. loopback + 动态注册 + PKCE
const callback = await startCallbackServer({ timeoutMs: 5 * 60_000 });
console.log(`[smoke] callback listening: ${callback.url}`);
const registration = await registerClient(metadata.registrationEndpoint, {
  clientName: 'DSH-MCP-OAuth-Smoke',
  redirectUris: [callback.url],
});
console.log('[smoke] registered client_id:', registration.clientId);

const { verifier, challenge, method } = pkcePair();
const state = generateState();
const authorizeUrl = buildAuthorizeUrl(metadata, {
  clientId: registration.clientId,
  redirectUri: callback.url,
  state,
  challenge,
  challengeMethod: method,
  resource: protectedResource.resource ?? ENTRY,
  scope: 'mcp:tools',
});

console.log('\n==========================================================');
console.log('请在你的浏览器打开以下链接并完成企查查授权：');
console.log(authorizeUrl);
console.log('==========================================================\n');
if (openFlag) openBrowser(authorizeUrl, { warn: (m) => console.log('[smoke]', m) });

// 3. 等待回调 → 换 token
const { code, state: returnedState } = await callback.waitForCallback();
if (returnedState !== state) throw new Error('state mismatch!');
console.log('[smoke] callback received, exchanging code...');

const token = await exchangeCode(metadata.tokenEndpoint, {
  clientId: registration.clientId,
  code,
  redirectUri: callback.url,
  codeVerifier: verifier,
  resource: protectedResource.resource ?? ENTRY,
});
console.log('[smoke] token obtained: accessToken=%s... refreshToken=%s... expiresIn=%ds',
  token.accessToken.slice(0, 12), (token.refreshToken ?? '?').slice(0, 12), token.expiresIn);

// 4. 用真实 token 调真实 MCP：initialize + tools/list
/** 解析 MCP Streamable HTTP 响应：兼容普通 JSON 与 SSE（event/data 行） */
function parseMcpBody(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const datas = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith('data:')) datas.push(line.slice(5).trim());
  }
  if (datas.length === 0) throw new Error(`no SSE data in response: ${trimmed.slice(0, 200)}`);
  // 多条 data 行表示分块 JSON，拼接后解析
  return JSON.parse(datas.join(''));
}

async function mcpCall(streamUrl, body) {
  const res = await fetch(streamUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.accessToken}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = parseMcpBody(text); } catch { json = text; }
  return { status: res.status, json };
}

const init = await mcpCall(ENTRY, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-smoke', version: '1.0' } } });
console.log('[smoke] MCP initialize status:', init.status);
if (init.status !== 200) {
  console.error('[smoke] initialize failed:', JSON.stringify(init.json).slice(0, 400));
  process.exit(1);
}
const initBody = init.json;
console.log('[smoke] MCP serverInfo:', JSON.stringify(initBody.result?.serverInfo));

const tools = await mcpCall(ENTRY, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
console.log('[smoke] tools/list status:', tools.status);
const toolList = tools.json?.result?.tools ?? [];
console.log(`[smoke] company 服务工具数量: ${toolList.length}`);
console.log('[smoke] 工具示例:', toolList.slice(0, 5).map((t) => t.name).join(', '));

// 5. 汇总写入 /tmp
const result = {
  ok: true,
  issuer,
  clientId: registration.clientId,
  accessTokenPrefix: token.accessToken.slice(0, 16),
  refreshTokenPrefix: (token.refreshToken ?? '').slice(0, 16),
  expiresIn: token.expiresIn,
  serverInfo: initBody.result?.serverInfo,
  companyToolCount: toolList.length,
  sampleTools: toolList.slice(0, 5).map((t) => t.name),
  timestamp: new Date().toISOString(),
};
await writeFile('/tmp/qcc-smoke-result.json', JSON.stringify(result, null, 2));
console.log('[smoke] DONE ✅ 结果已写入 /tmp/qcc-smoke-result.json');
await callback.close();
