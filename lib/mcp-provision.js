/**
 * MCP 条目动态配置：通过 ctx.loader 创建/更新/停用 @deepseek-ai/dsh-mcp-client 条目。
 * 授权成功后把 Bearer access_token 注入条目 config 并重启对应 fiber；
 * 断开时停用条目（disabled），保持 serverName 不变 → 工具名不变、幂等。
 */
import { QCC_RESOURCES } from './constants.js';

export function entryIdFor(config, serverKey) {
  return `${config.mcpEntryPrefix}-${serverKey}`;
}

function buildEntryConfig(config, serverKey, grant) {
  const url = config.resources[serverKey] ?? QCC_RESOURCES[serverKey];
  if (!url) throw new Error(`qcc-mcp-oauth: no resource url for server '${serverKey}'`);
  return {
    transport: 'streamable-http',
    serverName: serverKey,
    url,
    headers: grant?.accessToken ? { Authorization: `Bearer ${grant.accessToken}` } : {},
    failOnStartupError: false,
  };
}

/**
 * 把企查查 OAuth 集合内的全部 resource 配置为已连接的 mcp-client 条目。
 * @param {import('cordis').Context} ctx
 * @param {object} config 插件配置
 * @param {object|null} grant 授权记录；null 表示停用（无 token 不建立未授权连接）
 * @returns {Promise<string[]>} 受管条目 id 列表
 */
export async function provisionEntries(ctx, config, grant) {
  const ids = [];
  for (const serverKey of Object.keys(config.resources)) {
    const id = entryIdFor(config, serverKey);
    const entryConfig = buildEntryConfig(config, serverKey, grant);
    const existing = ctx.loader.resolve(id);
    if (existing) {
      const previous = existing.options?.config ?? {};
      await ctx.loader.update(id, { config: { ...previous, ...entryConfig }, disabled: grant ? false : true });
    } else {
      await ctx.loader.create({ id, name: '@deepseek-ai/dsh-mcp-client', config: entryConfig, disabled: grant ? false : true });
    }
    ids.push(id);
  }
  if (ctx.loader.await) await ctx.loader.await();
  return ids;
}

/** 停用全部受管 mcp-client 条目（断开连接时调用） */
export async function disableEntries(ctx, config) {
  const ids = [];
  for (const serverKey of Object.keys(config.resources)) {
    const id = entryIdFor(config, serverKey);
    const existing = ctx.loader.resolve(id);
    if (existing) {
      await ctx.loader.update(id, { disabled: true });
      ids.push(id);
    }
  }
  return ids;
}

/** 移除全部受管条目（卸载/彻底清理时可选） */
export async function removeEntries(ctx, config) {
  const ids = [];
  for (const serverKey of Object.keys(config.resources)) {
    const id = entryIdFor(config, serverKey);
    const existing = ctx.loader.resolve(id);
    if (existing) {
      await ctx.loader.remove(id);
      ids.push(id);
    }
  }
  return ids;
}
