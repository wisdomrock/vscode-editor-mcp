import * as vscode from 'vscode';
import { log } from './log';
import type { ServerController } from './server/controller';

export const PROVIDER_ID = 'vscodeEditorMcp.provider';

/**
 * Advertises the running server to VS Code's own MCP client, so Copilot agent mode
 * gets the same tools as external clients. The definition only exists while the
 * server is listening; starting or stopping fires the change event and VS Code
 * re-queries.
 */
export function registerCopilotProvider(controller: ServerController): vscode.Disposable {
  const changed = new vscode.EventEmitter<void>();
  let lastUrl: string | undefined;

  const statusSub = controller.onDidChangeStatus(status => {
    const url = status.address?.url;
    // Session count changes fire the same event; only re-publish on a real change.
    if (url === lastUrl) return;
    lastUrl = url;
    changed.fire();
  });

  const providerSub = vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => {
      const { address } = controller.status;
      if (!address) return [];

      return [
        new vscode.McpHttpServerDefinition(
          'VS Code Editor',
          vscode.Uri.parse(address.url),
          address.token ? { Authorization: `Bearer ${address.token}` } : {},
          // Bumping the version on port change makes VS Code discard a stale connection.
          `${address.port}`,
        ),
      ];
    },
  });

  log.info('Registered MCP server definition provider for VS Code / Copilot');
  return vscode.Disposable.from(statusSub, providerSub, changed);
}
