/**
 * 平台工具：打开系统默认浏览器（macOS/Linux/Windows）
 */
import { spawn } from 'node:child_process';

/**
 * 按平台构建打开命令（纯函数，便于单测）。
 * @param {string} url 授权页 URL（含 & 分隔的查询参数）
 * @param {string} [platform=process.platform] node 平台标识
 * @returns {{command: string, args: string[], options: object}}
 */
export function buildOpenCommand(url, platform = process.platform) {
  if (platform === 'darwin') {
    return { command: 'open', args: [url], options: { detached: true, stdio: 'ignore' } };
  }
  if (platform === 'win32') {
    // Windows 关键修复：cmd.exe 会把未加引号的 `&` 当作命令分隔符，导致授权 URL
    // 的查询参数（client_id / code_challenge / redirect_uri ...）全部丢失，只打开
    // 第一个 `&` 之前的部分。必须：
    //   1. 用双引号包裹整个 URL（`"${url}"`）保护 `&`；
    //   2. `start` 的第一个引号参数是「窗口标题」，用空字符串 `""` 占位；
    //   3. windowsVerbatimArguments: true 让 Node 原样传递引号，不做自动转义。
    return {
      command: 'cmd',
      args: ['/c', 'start', '""', `"${url}"`],
      options: { detached: true, stdio: 'ignore', windowsVerbatimArguments: true },
    };
  }
  return { command: 'xdg-open', args: [url], options: { detached: true, stdio: 'ignore' } };
}

export function openBrowser(url, logger) {
  const { command, args, options } = buildOpenCommand(url);
  const child = spawn(command, args, options);
  child.on('error', (error) => {
    logger?.warn(`qcc-mcp-oauth: failed to open browser via '${command}': ${error.message}`);
  });
  child.unref();
}
