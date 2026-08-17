import * as vscode from 'vscode';
import { CONFIG_SECTION, needsSinkReset, readConfig, type StateConfig } from './config';
import { initLog, log } from './log';
import { runFocusProbe } from './probe';
import { createStatusBar, type MirrorStatus, type StatusBarHandle } from './statusBar';

/**
 * M0 scaffold. The extension activates, reports its configuration and exposes the
 * §6.1 focus probe; it does not write anything yet. StateWatcher, StateFileSink
 * and HeartbeatWriter land in M1/M2 (design.md §13).
 */

let statusBar: StatusBarHandle | undefined;
let config: StateConfig;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(initLog());

  const version = context.extension.packageJSON.version as string;
  config = readConfig();

  statusBar = createStatusBar();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('editorStateMcp.writeNow', () => notYetImplemented('Write Now')),
    vscode.commands.registerCommand('editorStateMcp.openStateFile', () => notYetImplemented('Open State File')),
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
      }
      statusBar?.update(currentStatus());
    }),
  );

  statusBar.update(currentStatus());
  log.info(
    `editor-state-mcp ${version} activated — enabled=${config.enabled}, path=${config.path}, ` +
      `debounce=${config.debounceMs}ms, heartbeat=${config.heartbeatMs}ms`,
  );
  log.info('M0 scaffold: no state is written yet. Run "Editor State: Probe Focus Behaviour" for the §6.1 experiments.');
}

export async function deactivate(): Promise<void> {
  // M1 awaits a final flush here with reason "shutdown" (design.md §8.1).
  statusBar = undefined;
}

function currentStatus(): MirrorStatus {
  if (!config.enabled) return { state: 'disabled', writes: 0 };
  if (!vscode.workspace.workspaceFolders?.length) return { state: 'noWorkspace', writes: 0 };
  return { state: 'idle', writes: 0 };
}

function notYetImplemented(what: string): void {
  vscode.window.showInformationMessage(`Editor State: "${what}" arrives in M1, once the state file is being written.`);
}
