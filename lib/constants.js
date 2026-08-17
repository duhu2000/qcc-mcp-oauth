/**
 * 企查查 MCP OAuth 插件 - 常量定义
 * 依据《企查查MCP OAuth 接入文档_20260730_V1.4》§2
 */
export const DEFAULT_ISSUER = 'https://agent.qcc.com';

/** 文档 §2 当前开放授权的 MCP resource（OAuth 授权集合，共 5 个） */
export const QCC_RESOURCES = {
  company: 'https://agent.qcc.com/mcp/company/stream',
  risk: 'https://agent.qcc.com/mcp/risk/stream',
  ipr: 'https://agent.qcc.com/mcp/ipr/stream',
  operation: 'https://agent.qcc.com/mcp/operation/stream',
  executive: 'https://agent.qcc.com/mcp/executive/stream',
};

export const DEFAULT_SCOPE = 'mcp:tools';
export const DEFAULT_GRANT_KEY = 'default';

/** 授权码换 token 的默认入口 resource（以 company 作为首次接入示例，文档 §4） */
export const DEFAULT_ENTRY_RESOURCE = QCC_RESOURCES.company;

/** client_id 默认有效期（文档 §7：90 天），用于日志提示 */
export const CLIENT_ID_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** 文档 §8：code_verifier 允许字符集 */
export const VERIFIER_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-';

/** 文档 §8：code_verifier 长度约束 */
export const VERIFIER_MIN_LENGTH = 43;
export const VERIFIER_MAX_LENGTH = 128;
