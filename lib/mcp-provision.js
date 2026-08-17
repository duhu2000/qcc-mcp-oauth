/**
 * MCP 条目动态配置：通过 ctx.loader 创建/更新/停用 @deepseek-ai/dsh-mcp-client 条目。
 * 授权成功后把 Bearer access_token 注入条目 config 并重启对应 fiber；
 * 断开时停用条目（disabled），保持 serverName 不变 → 工具名不变、幂等。
 */
import { QCC_RESOURCES } from './constants.js';

export function entryIdFor(config, serverKey) {
  return `${config.mcpEntryPrefix}-${serverKey}`;
}

/**
 * 非抛错的存在性探测：部分 loader 版本的 resolve(id) 对不存在的条目会抛
 * "cannot resolve entry" 而非返回 undefined，直接用它探测会中断首次配置流程。
 */
function hasEntry(ctx, id) {
  try {
    ctx.loader.resolve(id);
    return true;
  } catch {
    return false;
  }
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
    const existing = hasEntry(ctx, id) ? ctx.loader.resolve(id) : null;
    if (existing) {
      const previous = existing.options?.config ?? {};
      await ctx.loader.update(id, { config: { ...previous, ...entryConfig }, disabled: grant ? false : true });
    } else {
      await ctx.loader.create({ id, name: '@deepseek-ai/dsh-mcp-client', config: entryConfig, disabled: grant ? false : true });
    }
    ids.push(id);
  }
  // 注意：不能在这里 await ctx.loader.await() —— loader.await() 会等待包括
  // 插件自身在内的所有条目 fiber 完成，而当前 apply() 正运行在自身 fiber 内，
  // 会形成自死锁导致插件永远停留在 loading 阶段（自动刷新调度也不会执行）。
  // 新建的 mcp-client 条目会在后台加载，无需阻塞插件 apply。
  return ids;
}

/** 停用全部受管 mcp-client 条目（断开连接时调用） */
export async function disableEntries(ctx, config) {
  const ids = [];
  for (const serverKey of Object.keys(config.resources)) {
    const id = entryIdFor(config, serverKey);
    if (hasEntry(ctx, id)) {
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
    if (hasEntry(ctx, id)) {
      await ctx.loader.remove(id);
      ids.push(id);
    }
  }
  return ids;
}
