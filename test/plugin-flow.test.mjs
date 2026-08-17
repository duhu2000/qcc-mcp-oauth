/**
 * 插件级集成测试：用伪 cordis 上下文 + mock OAuth 服务器，验证插件完整逻辑
 *   - 一键连接（OAuth 全流程，自动模拟用户点击授权）
 *   - 授权持久化（storage 表）与 6 个 mcp-client 条目创建（Bearer header）
 *   - 重复连接幂等复用（不重新弹授权）
 *   - access_token 过期自动刷新（token 轮换 + 条目更新）
 *   - 断开：revoke + 清除 grant + 停用条目
 *   - 重启恢复：再次 apply 时从 storage 恢复连接
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMockQccServer } from './mock-oauth-server.mjs';
import { QCC_RESOURCES } from '../lib/constants.js';

// 插件入口依赖 DSH host 包（schemastery/storage-domain 等）；CI 无 host 依赖时优雅跳过
let plugin;
try {
  plugin = await import('../lib/index.js');
} catch (error) {
  console.warn(`[plugin-flow] host deps unavailable, skipping: ${error.message}`);
}

const SKIP = { skip: plugin ? false : '需要 DSH host 依赖（见 test/setup-deps.sh）；CI 环境跳过' };

let mock;
let config;

function createFakeCtx(tableStore) {
  const tools = [];
  const created = [];
  const updated = [];
  const logs = [];
  const effects = [];
  const registry = new Map(); // id -> entry options（模拟 loader 的真实解析行为）
  const fakeTable = {
    get: (k) => tableStore.get(k),
    put: async (k, v) => { tableStore.set(k, v); return v; },
    delete: async (k) => tableStore.delete(k),
    entries: () => tableStore.entries(),
  };
  const fakeDomain = { tables: new Map([['grants', fakeTable]]), close: async () => {} };
  const ctx = {
    logger: () => ({
      info: (m) => logs.push(['info', String(m)]),
      warn: (m) => logs.push(['warn', String(m)]),
      error: (m) => logs.push(['error', String(m)]),
    }),
    storageDomain: { open: async () => fakeDomain },
    tools: { register: (def) => { tools.push(def); return () => {}; } },
    loader: {
      resolve: (id) => {
        const options = registry.get(id);
        return options ? { options } : null;
      },
      create: async (opts) => { registry.set(opts.id, opts); created.push(opts); return opts.id; },
      update: async (id, opts) => {
        updated.push([id, opts]);
        if (registry.has(id)) registry.set(id, { ...registry.get(id), ...opts });
      },
      remove: async (id) => { updated.push([id, { removed: true }]); registry.delete(id); },
      await: async () => {},
    },
    // 模拟真实 cordis 的 ctx.effect 语义：立即执行回调，回调的返回值才是
    // fiber 卸载时的清理函数（disposer）。防止 `ctx.effect(() => disposer())`
    // 这类"立即执行清理"的回归写法通过测试。
    effect: (fn) => {
      const disposer = typeof fn === 'function' ? fn() : fn;
      effects.push(disposer);
      return () => {};
    },
  };
  ctx.logs = logs; // 便于测试访问日志
  return { ctx, tools, created, updated, logs, effects, tableStore };
}

function findTool(tools, name) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} registered`);
  return tool;
}

/** 轮询直到条件满足（超时抛错） */
async function waitFor(fn, what, timeoutMs = 8000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** 模拟用户点击授权：从日志取出 authorize URL，auto 授权并回跳 loopback */
async function autoApprove(ctx) {
  const [entry] = await waitFor(() => {
    const hit = ctx.logs.find(([level, msg]) => msg.includes('opening authorization page:'));
    return hit ? [hit] : null;
  }, 'authorize URL in logs');
  const authorizeUrl = entry[1].replace('opening authorization page: ', '');
  const res = await fetch(`${authorizeUrl}&auto=1`, { redirect: 'manual' });
  assert.equal(res.status, 302, 'authorize should redirect');
  const location = res.headers.get('location');
  assert.ok(location, 'redirect location');
  await fetch(location); // 回跳 loopback，触发回调
}

before(async () => {
  mock = await createMockQccServer({ expiresIn: 2 }); // 短有效期：便于验证自动刷新
  const resources = {};
  for (const key of Object.keys(QCC_RESOURCES)) {
    resources[key] = `${mock.base}/mcp/${key}/stream`;
  }
  config = {
    issuer: mock.base,
    resources,
    clientName: 'dsh-test',
    callbackTimeoutMs: 15000,
    requestTimeoutMs: 5000,
    refreshSkewMs: 0,
    openBrowser: false,
    autoConnectOnActivate: false,
    persistTokens: true,
    mcpEntryPrefix: 'mcp-qcc',
    account: 'test',
  };
});

after(async () => {
  await mock.close();
});

test('一键连接：OAuth 全流程 → 持久化 + 创建 6 个 mcp-client 条目 + 注册 3 个工具', SKIP, async () => {
  const { ctx, tools, created, tableStore, logs } = createFakeCtx(new Map());
  await plugin.apply(ctx, config);

  const connect = findTool(tools, 'qcc_oauth_connect');
  const exec = { signal: new AbortController().signal };
  const promise = connect.execute({}, exec);
  await autoApprove(ctx);
  const result = await promise;

  assert.equal(result.ok, true, result.message);
  assert.equal(result.detail.entries.length, 6);

  // 6 个 mcp-client 条目，均带 Bearer header
  assert.equal(created.length, 6);
  for (const entry of created) {
    assert.equal(entry.name, '@deepseek-ai/dsh-mcp-client');
    assert.equal(entry.disabled, false);
    assert.match(entry.config.headers.Authorization, /^Bearer mock-at-/);
    assert.equal(entry.config.transport, 'streamable-http');
  }
  assert.deepEqual(created.map((e) => e.config.serverName).sort(), ['company', 'executive', 'history', 'ipr', 'operation', 'risk']);

  // grant 已持久化
  const grant = tableStore.get('grant:test');
  assert.ok(grant);
  assert.equal(grant.issuer, mock.base);
  assert.equal(grant.authorizedResources.length, 6);
  assert.ok(grant.refreshToken);

  // 3 个工具已注册
  for (const name of ['qcc_oauth_connect', 'qcc_oauth_status', 'qcc_oauth_disconnect']) findTool(tools, name);

  // status 反映已连接
  const status = findTool(tools, 'qcc_oauth_status');
  const statusResult = await status.execute({}, exec);
  assert.equal(statusResult.detail.connected, true);
  assert.equal(statusResult.detail.authorizedResources.length, 6);
  assert.equal(logs.some(([, m]) => m.includes('openBrowser disabled')), true);
});

test('重复连接幂等：复用现有授权，不重复创建条目', SKIP, async () => {
  const { ctx, tools, created, tableStore } = createFakeCtx(new Map());
  await plugin.apply(ctx, config);
  const connect = findTool(tools, 'qcc_oauth_connect');
  const exec = { signal: new AbortController().signal };

  const first = connect.execute({}, exec);
  await autoApprove(ctx);
  const r1 = await first;
  assert.equal(r1.ok, true);
  assert.equal(created.length, 6);

  // 第二次连接：立即复用（不弹授权）
  const r2 = await connect.execute({}, exec);
  assert.equal(r2.ok, true);
  assert.equal(r2.detail.reused, true);
  assert.equal(created.length, 6, '不应重复创建条目');
});

test('access_token 过期自动刷新：token 轮换 + 条目更新', SKIP, async () => {
  const { ctx, tools, updated, tableStore } = createFakeCtx(new Map());
  await plugin.apply(ctx, config);
  const connect = findTool(tools, 'qcc_oauth_connect');
  const exec = { signal: new AbortController().signal };

  const promise = connect.execute({}, exec);
  await autoApprove(ctx);
  await promise;

  const oldAccess = tableStore.get('grant:test').accessToken;
  const oldRefresh = tableStore.get('grant:test').refreshToken;

  // 等自动刷新（mock expires_in=2s）
  await waitFor(() => {
    const grant = tableStore.get('grant:test');
    return grant && grant.accessToken !== oldAccess ? grant : null;
  }, 'access token refresh');

  const newGrant = tableStore.get('grant:test');
  assert.notEqual(newGrant.accessToken, oldAccess, 'access_token 应已轮换');
  assert.notEqual(newGrant.refreshToken, oldRefresh, 'refresh_token 应已轮换（文档 §12.1）');
  // 条目配置同步更新为新 token
  const lastUpdate = updated.filter(([id]) => id.startsWith('mcp-qcc-')).at(-1);
  assert.ok(lastUpdate);
  assert.equal(lastUpdate[1].config.headers.Authorization, `Bearer ${newGrant.accessToken}`);
});

test('断开：revoke + 清除 grant + 停用条目', SKIP, async () => {
  const { ctx, tools, updated, tableStore, logs } = createFakeCtx(new Map());
  await plugin.apply(ctx, config);
  const connect = findTool(tools, 'qcc_oauth_connect');
  const exec = { signal: new AbortController().signal };

  const promise = connect.execute({}, exec);
  await autoApprove(ctx);
  await promise;
  assert.ok(tableStore.get('grant:test'));

  const disconnect = findTool(tools, 'qcc_oauth_disconnect');
  const result = await disconnect.execute({}, exec);
  assert.equal(result.ok, true);
  assert.equal(result.detail.revoked, true);

  // grant 已清除
  assert.equal(tableStore.get('grant:test'), undefined);
  // 条目已停用（disabled: true）
  const disabledUpdates = updated.filter(([id, opts]) => id.startsWith('mcp-qcc-') && opts.disabled === true);
  assert.equal(disabledUpdates.length, 6);

  // 断开后重新连接 → 重新走完整授权（grant 已删）；清空旧日志避免误用第一次的授权 URL
  logs.length = 0;
  const reconnect = connect.execute({}, exec);
  await autoApprove(ctx);
  const r2 = await reconnect;
  assert.equal(r2.ok, true);
});

test('重启恢复：storage 中有 grant 时 apply 自动恢复连接（无需重新授权）', SKIP, async () => {
  const tableStore = new Map();
  // 第一次运行：完成授权
  const first = createFakeCtx(tableStore);
  await plugin.apply(first.ctx, config);
  const connect = findTool(first.tools, 'qcc_oauth_connect');
  const exec = { signal: new AbortController().signal };
  const promise = connect.execute({}, exec);
  await autoApprove(first.ctx);
  await promise;
  assert.ok(tableStore.get('grant:test'));

  // 模拟重启：新的 ctx，共享同一 storage（持久化介质）
  const second = createFakeCtx(tableStore);
  await plugin.apply(second.ctx, config);
  // 恢复路径应直接创建带 Bearer 的条目，无 OAuth 交互
  assert.equal(second.created.length, 6);
  for (const entry of second.created) {
    assert.match(entry.config.headers.Authorization, /^Bearer mock-at-/);
  }
  // 无新的授权页日志
  assert.equal(second.logs.some(([, m]) => m.includes('opening authorization page:')), false);
});

test('激活自动授权：无授权时 apply 自动发起 OAuth（autoConnectOnActivate 默认开启）', SKIP, async () => {
  const { ctx, tools, created, tableStore, logs } = createFakeCtx(new Map());
  const cfg = {
    ...config,
    autoConnectOnActivate: true,
  };
  await plugin.apply(ctx, cfg);
  // 不调用 connect.execute —— 自动连接应已发起
  await autoApprove(ctx);
  await waitFor(() => (tableStore.get('grant:test') ? true : null), 'auto-connect grant');
  assert.ok(tableStore.get('grant:test'), '自动授权应写入 grant');
  assert.equal(created.length, 6, '自动授权应创建 6 个 mcp-client 条目');
  assert.ok(logs.some(([, m]) => m.includes('auto-starting OAuth connect')), '应有自动连接日志');
});

test('个人账号：token 不含 history → 只创建 5 个条目（history 不挂载）', SKIP, async () => {
  // 独立 mock：token 只授权 5 个（不含 history），模拟个人/未认证账号
  const personalMock = await createMockQccServer({
    expiresIn: 3600,
    tokenResources: ['company', 'risk', 'ipr', 'operation', 'executive'],
  });
  const resources = {};
  for (const key of Object.keys(QCC_RESOURCES)) {
    resources[key] = `${personalMock.base}/mcp/${key}/stream`;
  }
  const personalConfig = { ...config, resources, issuer: personalMock.base };
  const { ctx, tools, created } = createFakeCtx(new Map());
  await plugin.apply(ctx, personalConfig);

  const connect = findTool(tools, 'qcc_oauth_connect');
  const exec = { signal: new AbortController().signal };
  const promise = connect.execute({}, exec);
  await autoApprove(ctx);
  const result = await promise;

  assert.equal(result.ok, true, result.message);
  assert.equal(result.detail.entries.length, 5);
  assert.deepEqual(created.map((e) => e.config.serverName).sort(), ['company', 'executive', 'ipr', 'operation', 'risk']);
  assert.equal(created.some((e) => e.config.serverName === 'history'), false, 'history 不应挂载');
  await personalMock.close();
});
