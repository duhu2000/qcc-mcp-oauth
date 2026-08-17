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

try {
  plugin = await import('../lib/index.js');
  ({ defineQccGrantDomain, grantRecordSchema, buildGrant } = await import('../lib/grant-store.js'));
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
