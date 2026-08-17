/**
 * util.js 单元测试：跨平台浏览器打开命令构建（buildOpenCommand）。
 * 重点覆盖 Windows cmd /c start 的参数拼装——授权 URL 含 & 分隔的查询参数，
 * 必须用引号包裹整个 URL 并设置 windowsVerbatimArguments，否则 & 会被 cmd
 * 当作命令分隔符导致授权参数丢失（实测 BUG）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenCommand } from '../lib/util.js';

const AUTH_URL =
  'https://agent.qcc.com/oauth/authorize?response_type=code&client_id=wb_test&redirect_uri=http%3A%2F%2F127.0.0.1%3A57537%2Fcallback&scope=mcp%3Atools&state=abc&code_challenge=xyz&code_challenge_method=S256&resource=https%3A%2F%2Fagent.qcc.com%2Fmcp%2Fcompany%2Fstream';

test('darwin: open 直接传 URL', () => {
  const { command, args, options } = buildOpenCommand(AUTH_URL, 'darwin');
  assert.equal(command, 'open');
  assert.deepEqual(args, [AUTH_URL]);
  assert.equal(options.windowsVerbatimArguments, undefined);
});

test('linux: xdg-open 直接传 URL', () => {
  const { command, args } = buildOpenCommand(AUTH_URL, 'linux');
  assert.equal(command, 'xdg-open');
  assert.deepEqual(args, [AUTH_URL]);
});

test('win32: 整个 URL 用双引号包裹，防止 & 被 cmd 当作命令分隔符', () => {
  const { command, args, options } = buildOpenCommand(AUTH_URL, 'win32');
  assert.equal(command, 'cmd');
  assert.deepEqual(args, ['/c', 'start', '""', `"${AUTH_URL}"`]);
  // windowsVerbatimArguments 必须为 true：Node 默认会转义引号，破坏 start 的参数结构
  assert.equal(options.windowsVerbatimArguments, true);
  // 关键断言：URL 必须整体处于一对引号内（保护所有 & 查询参数）
  assert.ok(args[3].startsWith('"'));
  assert.ok(args[3].endsWith('"'));
  // URL 里的原始 & 不应被空格/引号拆散
  assert.equal(args[3].split('&').length, AUTH_URL.split('&').length);
});
