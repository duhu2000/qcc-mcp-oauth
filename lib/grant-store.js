/**
 * OAuth Grant 存储：基于 DSH 存储域（ctx.storageDomain）的持久化 KV。
 * 落盘位置：~/.dsh/storages/（目录权限 0700），凭证不进入 loader 配置树以外的任何地方。
 * 记录结构对齐 OAuth 文档 §11.1 的 QccOAuthGrant。
 */
import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { DEFAULT_GRANT_KEY } from './constants.js';

/** 存储记录 schema（zod，供 storage-domain 校验与持久化） */
export const grantRecordSchema = z.object({
  issuer: z.string(),
  clientId: z.string(),
  scope: z.string(),
  accessToken: z.string(),
  accessTokenExpiresAt: z.number(), // epoch ms
  refreshToken: z.string(),
  authorizedResources: z.array(z.string()), // OAuth 授权集合内的完整 resource 列表
  entryResource: z.string(),
  clientName: z.string(),
  updatedAt: z.number(), // epoch ms
});

/** 定义 qcc-mcp-oauth 存储域（单表 grants） */
export function defineQccGrantDomain() {
  return defineDomain({
    name: 'qcc_mcp_oauth',
    version: 1,
    tables: {
      grants: domainTable(grantRecordSchema),
    },
  });
}

/** 由 token 换码响应构造一条 grant 记录 */
export function buildGrant({ issuer, clientId, scope, token, authorizedResources, entryResource, clientName, skewMs = 0 }) {
  return {
    issuer,
    clientId,
    scope,
    accessToken: token.accessToken,
    accessTokenExpiresAt: Date.now() + token.expiresIn * 1000 - skewMs,
    refreshToken: token.refreshToken ?? '',
    authorizedResources,
    entryResource,
    clientName,
    updatedAt: Date.now(),
  };
}

/**
 * GrantStore：封装单表的 get/put/delete。
 * @param {import('@deepseek-ai/dsh-storage-domain').Domain} domain storage-domain open 后的域句柄
 */
export class GrantStore {
  constructor(domain) {
    this.domain = domain;
    this.table = domain.tables.get('grants');
    if (!this.table) throw new Error(`qcc-mcp-oauth: domain table 'grants' not found`);
  }

  keyFor(account = DEFAULT_GRANT_KEY) {
    return `grant:${account}`;
  }

  /** @returns {Promise<object|undefined>} */
  async get(account = DEFAULT_GRANT_KEY) {
    return this.table.get(this.keyFor(account));
  }

  async put(grant, account = DEFAULT_GRANT_KEY) {
    grant.updatedAt = Date.now();
    await this.table.put(this.keyFor(account), grant);
    return grant;
  }

  async delete(account = DEFAULT_GRANT_KEY) {
    return this.table.delete(this.keyFor(account));
  }

  async entries() {
    const out = [];
    for (const [key, value] of this.table.entries()) {
      if (key.startsWith('grant:')) out.push([key, value]);
    }
    return out;
  }
}
