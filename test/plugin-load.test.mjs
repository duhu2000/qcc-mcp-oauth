/**
 * 插件可加载性冒烟测试（模拟已安装到 DSH profile 的环境）：
 *   - 模块可导入，导出 name/inject/Config/apply
 *   - schemastery Config 能解析插件默认配置
 *   - storage-domain spec 合法、grant schema 能解析样例
 * 说明：需要 node_modules 指向 host 依赖（见 test/setup-deps.sh）。
 *       CI/无 host 依赖环境下自动跳过（OAuth 核心逻辑不受影响）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

let plugin;
let defineQccGrantDomain;
let grantRecordSchema;
let buildGrant;
let GrantStore;
let DomainFacility;

try {
  plugin = await import('../lib/index.js');
  ({ defineQccGrantDomain, grantRecordSchema, buildGrant, GrantStore } = await import('../lib/grant-store.js'));
  ({ DomainFacility } = await import('@deepseek-ai/dsh-storage-domain'));
} catch (error) {
  // host 依赖（@deepseek-ai/schemastery / dsh-storage-domain / zod）不可用时跳过
  plugin = null;
  console.warn(`[plugin-load] host deps unavailable, skipping: ${error.message}`);
}

function skipIfNoDeps() {
  if (!plugin) {
    test('（跳过）host 依赖不可用', { skip: '需要 DSH host 依赖（见 test/setup-deps.sh）' }, () => {});
    return true;
  }
  return false;
}

if (!skipIfNoDeps()) {
  test('GrantStore uses the public table accessor without reading private tables', async () => {
    const records = new Map();
    const table = {
      get: (key) => records.get(key),
      put: async (key, value) => { records.set(key, value); },
      delete: async (key) => records.delete(key),
      entries: () => records.entries(),
    };
    const store = new GrantStore({
      table(name) {
        assert.equal(name, 'grants');
        return table;
      },
      get tables() { throw new Error('tables is private'); },
    });
    await store.put({ accessToken: 'test-token' }, 'test');
    assert.equal((await store.get('test')).accessToken, 'test-token');
    assert.equal((await store.entries()).length, 1);
    await store.delete('test');
    assert.equal(await store.get('test'), undefined);
  });

  test('GrantStore retains support for the legacy tables map', async () => {
    const table = { get: () => ({ accessToken: 'legacy-token' }) };
    const store = new GrantStore({ tables: new Map([['grants', table]]) });
    assert.equal((await store.get()).accessToken, 'legacy-token');
  });

  test('GrantStore persists and restores grants through the installed DSH domain implementation', async (t) => {
    const snapshot = { tables: { grants: {} }, global: null };
    const backend = { kv: { open: async () => ({
      loadAll: async () => structuredClone(snapshot),
      putRecord: async (table, key, value) => { snapshot.tables[table][key] = structuredClone(value); },
      deleteRecord: async (table, key) => { delete snapshot.tables[table][key]; },
      close: async () => {},
    }) } };
    const ctx = {
      storage: { backend: { get: () => backend } },
      emit: () => {},
      logger: { warn: () => {}, error: () => {} },
    };
    const facility = new DomainFacility(ctx, { backend: 'test' });
    t.after(() => facility.closeAll());
    const domain = await facility.open(defineQccGrantDomain());
    const grant = buildGrant({
      issuer: 'https://agent.qcc.com', clientId: 'test-client', scope: 'mcp:tools',
      token: { accessToken: 'test-token', refreshToken: 'test-refresh', expiresIn: 3600 },
      authorizedResources: ['https://agent.qcc.com/mcp/company/stream'],
      entryResource: 'https://agent.qcc.com/mcp/company/stream', clientName: 'DSH test',
    });
    await new GrantStore(domain).put(grant);
    await domain.close();
    const restored = new GrantStore(await facility.open(defineQccGrantDomain()));
    assert.deepEqual(await restored.get(), grant);
    await restored.delete();
    assert.equal(await restored.get(), undefined);
    assert.deepEqual(snapshot.tables.grants, {});
  });

  test('插件导出契约', () => {
    assert.equal(typeof plugin.name, 'string');
    assert.ok(Array.isArray(plugin.inject));
    assert.ok(plugin.inject.includes('tools'));
    assert.ok(plugin.inject.includes('storageDomain'));
    assert.ok(plugin.inject.includes('loader'));
    assert.equal(typeof plugin.Config, 'function');
    assert.equal(typeof plugin.apply, 'function');
  });

  test('schemastery Config 可解析默认与覆盖配置', () => {
    const parsed = plugin.Config({
      issuer: 'https://agent.qcc.com',
      clientName: 'DeepSeek Harness - QCC MCP',
      refreshSkewMs: 300000,
      persistTokens: true,
    });
    assert.equal(parsed.issuer, 'https://agent.qcc.com');
    assert.equal(parsed.refreshSkewMs, 300000);
    assert.equal(parsed.persistTokens, true);
    // 默认值
    assert.ok(parsed.callbackPath, '/callback');
    assert.ok(parsed.mcpEntryPrefix, 'mcp-qcc');
    // 非法配置抛错
    assert.throws(() => plugin.Config({ refreshSkewMs: 'bad' }));
  });

  test('存储域 spec 合法且 grant schema 可解析', () => {
    const spec = defineQccGrantDomain();
    assert.equal(spec.name, 'qcc_mcp_oauth');
    assert.equal(typeof spec.version, 'number');
    assert.ok(spec.tables.grants, 'tables.grants 存在');

    const grant = buildGrant({
      issuer: 'https://agent.qcc.com',
      clientId: 'wb_dyn_test',
      scope: 'mcp:tools',
      token: { accessToken: 'at-1', expiresIn: 3600, refreshToken: 'rt-1', tokenType: 'Bearer', scope: 'mcp:tools' },
      authorizedResources: ['https://agent.qcc.com/mcp/company/stream'],
      entryResource: 'https://agent.qcc.com/mcp/company/stream',
      clientName: 'test',
    });
    const parsed = grantRecordSchema.safeParse(grant);
    assert.equal(parsed.success, true);
    assert.ok(grant.accessTokenExpiresAt > Date.now());
  });
}
