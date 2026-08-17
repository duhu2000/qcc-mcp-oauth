/**
 * 对话工具面：qcc_oauth_connect / qcc_oauth_status / qcc_oauth_disconnect
 * 用户说"连接企查查"等即触发 connect；模型据此完成一键授权。
 */
import { QCC_RESOURCES } from './constants.js';

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
    detail: { type: 'object', additionalProperties: true },
  },
  required: ['ok', 'message'],
  additionalProperties: true,
};

const resultOutput = {
  schema: RESULT_SCHEMA,
  render(args, value) {
    return value.message;
  },
};

/**
 * @param {import('cordis').Context} ctx
 * @param {{connect:(server:string, signal:AbortSignal)=>Promise<object>, status:()=>Promise<object>, disconnect:(signal:AbortSignal)=>Promise<object>}} api
 */
export function registerTools(ctx, api) {
  const disposers = [];

  disposers.push(
    ctx.tools.register({
      name: 'qcc_oauth_connect',
      description:
        '一键连接企查查 MCP：完成 OAuth（PKCE）授权并配置全部企查查 MCP Server。' +
        '会打开系统浏览器跳转企查查授权页，用户登录授权后自动回跳完成连接。' +
        '连接成功后 mcp__qcc-company__*、mcp__qcc-risk__* 等企查查工具即可使用。' +
        '已在连接状态时调用将复用现有授权（token 自动刷新），不会重复弹授权页。',
      parameters: {
        type: 'object',
        properties: {
          server: {
            type: 'string',
            enum: Object.keys(QCC_RESOURCES),
            description: '授权入口 resource，默认 company（授权一次覆盖全部企查查 MCP Server）',
          },
        },
        additionalProperties: false,
      },
      output: resultOutput,
      timeoutMs: 180_000,
      async execute(args, exec) {
        return api.connect(args.server ?? 'company', exec.signal);
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'qcc_oauth_status',
      description:
        '查看企查查 MCP 连接状态：是否已授权、access_token 过期时间、覆盖的 MCP Server、' +
        '是否需要重新授权等。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: resultOutput,
      async execute() {
        return api.status();
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'qcc_oauth_disconnect',
      description:
        '断开企查查 MCP 连接：撤销 refresh_token（调用 OAuth revoke）、清除本地授权、' +
        '停用企查查 MCP 工具。之后需要重新执行 qcc_oauth_connect 才能再次使用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: resultOutput,
      async execute(args, exec) {
        return api.disconnect(exec.signal);
      },
    }),
  );

  return () => {
    for (const dispose of disposers) dispose();
  };
}
