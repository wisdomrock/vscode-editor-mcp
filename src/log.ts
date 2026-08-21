import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('Editor State', { log: true });
  return channel;
}

export const log = {
  info: (msg: string, ...args: unknown[]) => channel?.info(msg, ...args),
  warn: (msg: string, ...args: unknown[]) => channel?.warn(msg, ...args),
  error: (msg: string, ...args: unknown[]) => channel?.error(msg, ...args),
  debug: (msg: string, ...args: unknown[]) => channel?.debug(msg, ...args),
  show: () => channel?.show(),
};
