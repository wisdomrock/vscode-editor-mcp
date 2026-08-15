import * as vscode from 'vscode';
import type { ServerController, ServerStatus } from './server/controller';

export function createStatusBar(controller: ServerController): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('vscodeEditorMcp.status', vscode.StatusBarAlignment.Right, 100);
  item.name = 'Editor MCP';
  item.command = 'vscodeEditorMcp.status';

  const render = (status: ServerStatus) => {
    switch (status.state) {
      case 'starting':
        item.text = '$(loading~spin) MCP';
        item.tooltip = 'Editor MCP: starting…';
        item.backgroundColor = undefined;
        break;

      case 'running': {
        const port = status.address?.port;
        // The session count is the whole point of the indicator: it tells the user
        // whether anything is actually attached to their editor right now.
        const badge = status.sessions > 0 ? ` (${status.sessions})` : '';
        item.text = `$(broadcast) MCP :${port}${badge}`;
        item.tooltip = runningTooltip(status);
        item.backgroundColor = undefined;
        break;
      }

      case 'error':
        item.text = '$(error) MCP';
        item.tooltip = `Editor MCP failed to start: ${status.error ?? 'unknown error'}`;
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;

      default:
        item.text = '$(circle-slash) MCP';
        item.tooltip = 'Editor MCP: stopped. Click to start.';
        item.backgroundColor = undefined;
    }
    item.show();
  };

  render(controller.status);
  const sub = controller.onDidChangeStatus(render);

  return vscode.Disposable.from(sub, item);
}

function runningTooltip(status: ServerStatus): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown('**Editor MCP** — running\n\n');
  md.appendMarkdown(`- URL: \`${status.address?.url}\`\n`);
  md.appendMarkdown(`- Clients connected: ${status.sessions}\n`);
  md.appendMarkdown(`- Auth: ${status.address?.token ? 'bearer token required' : '$(warning) disabled'}\n`);
  md.appendMarkdown(`- Write tools: ${status.writeEnabled ? 'enabled' : 'disabled'}\n\n`);
  md.appendMarkdown('Click for actions.');
  return md;
}
