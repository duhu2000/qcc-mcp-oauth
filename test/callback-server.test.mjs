/**
 * callback-server.js 测试：loopback 回调监听
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCallbackServer, CallbackTimeoutError } from '../lib/callback-server.js';

test('健康检查与 URL 形态', async () => {
  const server = await startCallbackServer({ timeoutMs: 5000 });
  try {
    assert.ok(server.port > 0);
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const res = await fetch(`${server.url.replace(/\/callback$/, '')}/health`);
    assert.equal(res.status, 200);
  } finally {
    await server.close();
  }
});

test('收到 code + state 后解析并返回', async () => {
  const server = await startCallbackServer({ timeoutMs: 5000 });
  try {
    const hit = fetch(`${server.url}?code=abc123&state=xyz`).then((r) => r.status);
    const { code, state } = await server.waitForCallback();
    assert.equal(code, 'abc123');
    assert.equal(state, 'xyz');
    assert.equal(await hit, 200);
  } finally {
    await server.close();
  }
});

test('回调缺少 code/state → reject', async () => {
  const server = await startCallbackServer({ timeoutMs: 5000 });
  try {
    await fetch(`${server.url}?foo=bar`);
    await assert.rejects(server.waitForCallback(), /missing code or state/);
  } finally {
    await server.close();
  }
});

test('超时 → CallbackTimeoutError', async () => {
  const server = await startCallbackServer({ timeoutMs: 150 });
  await assert.rejects(server.waitForCallback(), CallbackTimeoutError);
});

test('外部 abort signal → reject', async () => {
  const controller = new AbortController();
  const server = await startCallbackServer({ timeoutMs: 5000, signal: controller.signal });
  const waiting = server.waitForCallback();
  controller.abort();
  await assert.rejects(waiting, /aborted/);
  await server.close();
});
