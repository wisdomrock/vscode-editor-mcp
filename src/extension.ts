import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { CONFIG_SECTION, needsSinkReset, readConfig, type StateConfig } from './config';
import { initLog, log } from './log';
import { runFocusProbe } from './probe';
import { maybePromptGitignore } from './state/gitignore';
import { HeartbeatWriter, pruneDeadHeartbeats } from './state/heartbeat';
import { StateFileSink } from './state/sink';
import { StateWatcher } from './state/watcher';
import { createStatusBar, type MirrorStatus, type StatusBarHandle } from './statusBar';

/**
 * M3: `openTabs`, `recentFiles`, the remaining §6 events, `excludeGlobs`,
 * truncation caps, the one-time gitignore prompt, and a status bar that stays
 * live across background writes rather than only updating on explicit triggers.
 */

let statusBar: StatusBarHandle | undefined;
let sink: StateFileSink | undefined;
let watcher: StateWatcher | undefined;
let heartbeat: HeartbeatWriter | undefined;
let config: StateConfig;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(initLog());

  const version = context.extension.packageJSON.version as string;
  config = readConfig();

  statusBar = createStatusBar();
  context.subscriptions.push(statusBar);

  // Stable per extension-host process (design.md §5.2): pid alone is reused by
  // the OS across restarts, so mix in activation time.
  const windowId = crypto.createHash('md5').update(`${process.pid}-${Date.now()}`).digest('hex').slice(0, 8);

  sink = new StateFileSink({
    getEnabled: () => config.enabled,
    getConfiguredPath: () => config.path,
    getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    onFirstSuccessfulWrite: (root, configuredPath) => {
      if (!config.autoGitignore) return;
      void maybePromptGitignore(root, configuredPath, context.workspaceState);
    },
    onStatusChange: () => statusBar?.update(currentStatus()),
  });
  heartbeat = new HeartbeatWriter(
    windowId,
    () => config.heartbeatMs,
    () => config.enabled,
    () => sink?.currentPath(),
  );
  watcher = new StateWatcher(sink, () => config, { extensionVersion: version, windowId, heartbeatPath: heartbeat.path() });
  context.subscriptions.push(sink, watcher);

  // Best-effort hygiene: clears heartbeat files left by hosts that crashed
  // without deactivating, regardless of whether this window ends up enabled.
  void pruneDeadHeartbeats();
  heartbeat.sync();

  context.subscriptions.push(
    vscode.commands.registerCommand('editorStateMcp.writeNow', async () => {
      await watcher?.flush('manual');
      statusBar?.update(currentStatus());
      vscode.window.showInformationMessage('Editor State: wrote the current state file.');
    }),
    vscode.commands.registerCommand('editorStateMcp.openStateFile', async () => {
      const path = sink?.currentPath();
      if (!path) {
        vscode.window.showInformationMessage('Editor State: nothing written yet.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand('editorStateMcp.showLogs', () => log.show()),
    vscode.commands.registerCommand('editorStateMcp.probeFocus', () => runFocusProbe()),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration(CONFIG_SECTION)) return;
      const next = readConfig();
      const previous = config;
      config = next;

      // No listener, no session, nothing to restart — the sharpest contrast with
      // the 0.1.x server this replaces. A path or enablement change only has to
      // reset the sink; everything else applies on the next write.
      if (needsSinkReset(previous, next)) {
        log.info(`Sink config changed (enabled=${next.enabled}, path=${next.path})`);
        if (!next.enabled) void sink?.removeFile();
      }
      heartbeat?.sync();
      statusBar?.update(currentStatus());
    }),
  );

  watcher.start();
  statusBar.update(currentStatus());
  log.info(
    `editor-state-mcp ${version} activated — enabled=${config.enabled}, path=${config.path}, ` +
      `debounce=${config.debounceMs}ms, heartbeat=${config.heartbeatMs}ms`,
  );
}

export async function deactivate(): Promise<void> {
  await watcher?.flush('shutdown');
  // §8.2: the heartbeat's entire meaning is "this host is alive" — always
  // remove it, even if mirroring itself is currently disabled.
  await heartbeat?.dispose();
  statusBar = undefined;
  sink = undefined;
  watcher = undefined;
  heartbeat = undefined;
}

function currentStatus(): MirrorStatus {
  if (!config.enabled) return { state: 'disabled', writes: 0 };
  if (!vscode.workspace.workspaceFolders?.length) return { state: 'noWorkspace', writes: 0 };
  if (sink?.lastError) return { state: 'error', writes: sink.writes, error: sink.lastError, path: sink.currentPath() };
  if (!sink?.writes) return { state: 'idle', writes: 0, path: sink?.currentPath() };
  return { state: 'active', writes: sink.writes, path: sink.currentPath(), lastWriteMs: sink.lastWriteMs };
}
