/**
 * Loopback 回调服务器（文档 §8 Native/Desktop 场景）
 * 监听 127.0.0.1:{随机端口}/callback，接收授权页回跳的 code + state。
 * 约束：先启动监听再打开授权页；收到回调后先校验 state；code 只使用一次。
 */
import { createServer } from 'node:http';

export class CallbackTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CallbackTimeoutError';
  }
}

/**
 * 启动 loopback 回调监听。
 * @param {object} options
 * @param {string} [options.path='/callback'] 回调路径
 * @param {number} [options.port=0] 0 = 随机端口
 * @param {string} [options.host='127.0.0.1']
 * @param {number} [options.timeoutMs=300000] 等待回调的超时
 * @param {AbortSignal} [options.signal] 外部取消（如工具执行被中断）
 * @returns {Promise<{port:number, url:string, waitForCallback:()=>Promise<{code:string,state:string}>, close:()=>Promise<void>}>}
 */
export async function startCallbackServer({ path = '/callback', port = 0, host = '127.0.0.1', timeoutMs = 300_000, signal } = {}) {
  if (!path.startsWith('/')) path = `/${path}`;

  let resolveCallback;
  let rejectCallback;
  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // 请求可能在 waitForCallback() 挂接前到达并触发 reject；
  // 挂一个 no-op catch 标记为已处理，避免 unhandled rejection 告警/测试失败。
  callbackPromise.catch(() => {});

  const onAbort = () => rejectCallback(new CallbackTimeoutError('callback wait aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const timer = setTimeout(() => {
    rejectCallback(new CallbackTimeoutError(`no callback received within ${timeoutMs}ms`));
  }, timeoutMs);

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, `http://${host}:${port}`);
    if (requestUrl.pathname === path) {
      const code = requestUrl.searchParams.get('code');
      const state = requestUrl.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><title>企查查 MCP 授权</title></head>' +
        '<body style="font-family:system-ui;text-align:center;padding-top:80px">' +
        '<h2>✅ 授权成功</h2><p>企查查 MCP 已连接，可以关闭此页面并返回 DeepSeek Harness。</p>' +
        '</body></html>',
      );
      if (code !== null && state !== null) {
        resolveCallback({ code, state });
      } else {
        rejectCallback(new Error('callback missing code or state'));
      }
      return;
    }
    if (requestUrl.pathname === '/' || requestUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('qcc-mcp-oauth callback server is running');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const actualPort = server.address().port;
  const url = `http://${host}:${actualPort}${path}`;

  const close = () =>
    new Promise((resolve) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      server.close(() => resolve());
    });

  const waitForCallback = async () => {
    try {
      return await callbackPromise;
    } finally {
      await close();
    }
  };

  return { port: actualPort, url, waitForCallback, close };
}
