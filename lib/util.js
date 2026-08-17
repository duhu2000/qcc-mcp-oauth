/**
 * 平台工具：打开系统默认浏览器（macOS/Linux/Windows）
 */
import { spawn } from 'node:child_process';

export function openBrowser(url, logger) {
  const { platform } = process;
  let command;
  let args;
  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', (error) => {
    logger?.warn(`qcc-mcp-oauth: failed to open browser via '${command}': ${error.message}`);
  });
  child.unref();
}
