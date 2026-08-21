import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export const CONFIG_SECTION = 'editorStateMcp';

/** Consumers hard-code these field names; bump on any breaking change (design.md §5.2). */
export const SCHEMA_VERSION = 1;

/**
 * Global dir, used for the heartbeat (§8.2) and, later, the opt-in mirror.
 * Deliberately outside the workspace: a fixed-period write inside the project
 * tree would re-trigger the user's own file watchers, which no debounce can
 * suppress (R2).
 */
export const GLOBAL_DIR = path.join(os.homedir(), '.editor-state-mcp');
export const HEARTBEAT_DIR = path.join(GLOBAL_DIR, 'heartbeat');

export const DEFAULT_EXCLUDE_GLOBS = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/*secret*',
  '**/*credential*',
];

export interface StateConfig {
  enabled: boolean;
  /** Workspace-relative, or absolute (used verbatim). */
  path: string;
  debounceMs: number;
  includeSelectionText: boolean;
  maxSelectionBytes: number;
  excludeGlobs: string[];
  maxOpenTabs: number;
  maxRecentFiles: number;
  autoGitignore: boolean;
  /** 0 disables the heartbeat entirely. */
  heartbeatMs: number;
  globalMirror: boolean;
}

export function readConfig(): StateConfig {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    enabled: c.get<boolean>('enabled', true),
    path: c.get<string>('path', '.editor-state/state.json').trim() || '.editor-state/state.json',
    // Floored rather than rejected: a 0 ms debounce would write on every arrow key.
    debounceMs: clamp(c.get<number>('debounceMs', 150), 25, 5_000),
    includeSelectionText: c.get<boolean>('includeSelectionText', true),
    maxSelectionBytes: clamp(c.get<number>('maxSelectionBytes', 65_536), 0, 4 * 1024 * 1024),
    excludeGlobs: c.get<string[]>('excludeGlobs', DEFAULT_EXCLUDE_GLOBS),
    maxOpenTabs: clamp(c.get<number>('maxOpenTabs', 100), 1, 10_000),
    maxRecentFiles: clamp(c.get<number>('maxRecentFiles', 25), 1, 1_000),
    autoGitignore: c.get<boolean>('autoGitignore', true),
    heartbeatMs: heartbeatMs(c.get<number>('heartbeatSeconds', 30)),
    globalMirror: c.get<boolean>('globalMirror', false),
  };
}

/**
 * Which changes force the sink to re-resolve its target and clean up the old
 * file. Everything else simply applies on the next write — there is no server,
 * so nothing ever needs restarting.
 */
export function needsSinkReset(a: StateConfig, b: StateConfig): boolean {
  return a.enabled !== b.enabled || a.path !== b.path;
}

function heartbeatMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  // Below ~5 s the liveness signal costs more than it proves.
  return clamp(seconds, 5, 3_600) * 1_000;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}
