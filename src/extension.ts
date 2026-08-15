import * as vscode from 'vscode';
import { CONFIG_SECTION, needsRestart, readConfig, type McpConfig } from './config';
import { registerCopilotProvider } from './copilot';
import { initLog, log } from './log';
import { ServerController } from './server/controller';
import { createStatusBar } from './statusBar';

let controller: ServerController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(initLog());

  const version = context.extension.packageJSON.version as string;
  controller = new ServerController(version);
  context.subscriptions.push(controller);
  context.subscriptions.push(createStatusBar(controller));

  let config = readConfig();
  if (config.registerWithCopilot) {
    context.subscriptions.push(registerCopilotProvider(controller));
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeEditorMcp.start', () => startWithFeedback()),
    vscode.commands.registerCommand('vscodeEditorMcp.stop', async () => {
      await controller?.stop();
      vscode.window.setStatusBarMessage('Editor MCP: stopped', 3000);
    }),
    vscode.commands.registerCommand('vscodeEditorMcp.restart', async () => {
      await controller?.restart();
      vscode.window.setStatusBarMessage('Editor MCP: restarted', 3000);
    }),
    vscode.commands.registerCommand('vscodeEditorMcp.status', () => showStatusMenu()),
    vscode.commands.registerCommand('vscodeEditorMcp.copyUrl', () => copyUrl()),
    vscode.commands.registerCommand('vscodeEditorMcp.copyClaudeCommand', () => copyClaudeCommand()),
    vscode.commands.registerCommand('vscodeEditorMcp.showLogs', () => log.show()),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (!e.affectsConfiguration(CONFIG_SECTION)) return;
      const next = readConfig();
      const previous = config;
      config = next;

      if (controller?.status.state === 'running' && needsRestart(previous, next)) {
        log.info('Settings changed; restarting server');
        await controller.restart();
      }
    }),
  );

  if (config.autoStart) {
    log.info('autoStart enabled; starting server');
    await startWithFeedback({ silent: true });
  }
}

export async function deactivate(): Promise<void> {
  // Awaited here (unlike in dispose) so the discovery file is gone before the
  // extension host exits, rather than left for the next window to prune.
  await controller?.stop();
  controller = undefined;
}

async function startWithFeedback(opts: { silent?: boolean } = {}): Promise<void> {
  try {
    await controller?.start();
    const address = controller?.status.address;
    if (address && !opts.silent) {
      const choice = await vscode.window.showInformationMessage(
        `Editor MCP listening on ${address.url}`,
        'Copy claude mcp add',
        'Copy URL',
      );
      if (choice === 'Copy claude mcp add') await copyClaudeCommand();
      if (choice === 'Copy URL') await copyUrl();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const choice = await vscode.window.showErrorMessage(`Editor MCP failed to start: ${message}`, 'Show Logs');
    if (choice === 'Show Logs') log.show();
  }
}

async function showStatusMenu(): Promise<void> {
  const status = controller?.status;
  if (!status) return;

  if (status.state !== 'running') {
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(play) Start server', action: 'start' },
        { label: '$(output) Show logs', action: 'logs' },
        { label: '$(gear) Open settings', action: 'settings' },
      ],
      { title: status.state === 'error' ? `Editor MCP: ${status.error}` : 'Editor MCP: stopped' },
    );
    if (choice?.action === 'start') await startWithFeedback();
    if (choice?.action === 'logs') log.show();
    if (choice?.action === 'settings') await openSettings();
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(clippy) Copy "claude mcp add" command', action: 'claude' },
      { label: '$(link) Copy server URL', action: 'url' },
      { label: '$(debug-restart) Restart server', action: 'restart' },
      { label: '$(primitive-square) Stop server', action: 'stop' },
      { label: '$(output) Show logs', action: 'logs' },
      { label: '$(gear) Open settings', action: 'settings' },
    ],
    {
      title: `Editor MCP · ${status.address?.url} · ${status.sessions} client${status.sessions === 1 ? '' : 's'}`,
    },
  );

  switch (choice?.action) {
    case 'claude':
      await copyClaudeCommand();
      break;
    case 'url':
      await copyUrl();
      break;
    case 'restart':
      await controller?.restart();
      break;
    case 'stop':
      await controller?.stop();
      break;
    case 'logs':
      log.show();
      break;
    case 'settings':
      await openSettings();
      break;
  }
}

async function copyUrl(): Promise<void> {
  const address = controller?.status.address;
  if (!address) {
    vscode.window.showWarningMessage('Editor MCP is not running.');
    return;
  }
  await vscode.env.clipboard.writeText(address.url);
  vscode.window.setStatusBarMessage('Editor MCP: URL copied', 3000);
}

async function copyClaudeCommand(): Promise<void> {
  const address = controller?.status.address;
  if (!address) {
    vscode.window.showWarningMessage('Editor MCP is not running.');
    return;
  }

  const name = safeServerName(vscode.workspace.name);
  const header = address.token ? ` --header "Authorization: Bearer ${address.token}"` : '';
  await vscode.env.clipboard.writeText(`claude mcp add --transport http ${name} ${address.url}${header}`);

  vscode.window.showInformationMessage(
    address.token
      ? 'Copied. The command contains this session\'s auth token — it changes every restart.'
      : 'Copied. Auth is disabled, so any local process can reach this server.',
  );
}

function safeServerName(workspaceName: string | undefined): string {
  const slug = (workspaceName ?? 'vscode')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `vscode-${slug}` : 'vscode-editor';
}

function openSettings(): Thenable<unknown> {
  return vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION);
}

export type { McpConfig };
