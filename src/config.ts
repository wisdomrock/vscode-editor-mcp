import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export const CONFIG_SECTION = 'vscodeEditorMcp';

export interface McpConfig {
  autoStart: boolean;
  port: number;
  host: string;
  allowWrite: boolean;
  requireAuth: boolean;
  maxFileBytes: number;
  sessionIdleMs: number;
  registerWithCopilot: boolean;
  discoveryDir: string;
}

export function readConfig(): McpConfig {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const configuredDir = c.get<string>('discoveryDir', '').trim();
  return {
    autoStart: c.get<boolean>('autoStart', false),
    port: clampPort(c.get<number>('port', 0)),
    // Anything other than a loopback address is rejected here rather than trusted
    // from settings — the enum in package.json is UI, not enforcement.
    host: isLoopback(c.get<string>('host', '127.0.0.1')) ? c.get<string>('host', '127.0.0.1') : '127.0.0.1',
    allowWrite: c.get<boolean>('allowWrite', true),
    requireAuth: c.get<boolean>('requireAuth', true),
    maxFileBytes: Math.max(1024, c.get<number>('maxFileBytes', 1024 * 1024)),
    sessionIdleMs: Math.max(0, c.get<number>('sessionIdleMinutes', 30)) * 60_000,
    registerWithCopilot: c.get<boolean>('registerWithCopilot', true),
    discoveryDir: configuredDir || path.join(os.homedir(), '.vscode-editor-mcp'),
  };
}

function clampPort(p: number): number {
  return Number.isInteger(p) && p >= 0 && p <= 65535 ? p : 0;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** Settings that require a listener restart to take effect. */
export function needsRestart(a: McpConfig, b: McpConfig): boolean {
  return a.port !== b.port || a.host !== b.host || a.requireAuth !== b.requireAuth || a.allowWrite !== b.allowWrite;
}
