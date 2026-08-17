import * as vscode from 'vscode';

/**
 * §9: the user must never be unaware this file is being written. The item is
 * always visible while the extension is active, and clicking it opens the exact
 * file agents are reading.
 *
 * `MirrorStatus` moves to `state/types.ts` in M1, once the sink owns it.
 */
export type MirrorState = 'disabled' | 'noWorkspace' | 'idle' | 'active' | 'error';

export interface MirrorStatus {
  state: MirrorState;
  /** Absolute path to state.json, once resolved. */
  path?: string;
  lastWriteMs?: number;
  writes: number;
  error?: string;
}

export interface StatusBarHandle extends vscode.Disposable {
  update(status: MirrorStatus): void;
}

export function createStatusBar(): StatusBarHandle {
  const item = vscode.window.createStatusBarItem('editorStateMcp.status', vscode.StatusBarAlignment.Right, 100);
  item.name = 'Editor State';
  item.command = 'editorStateMcp.openStateFile';

  const render = (status: MirrorStatus) => {
    item.backgroundColor = undefined;

    switch (status.state) {
      case 'disabled':
        item.text = '$(eye-closed) State';
        item.tooltip = tooltip('Mirroring is **off**.', [
          'Set `editorStateMcp.enabled` to true to resume.',
        ]);
        break;

      case 'noWorkspace':
        item.text = '$(eye-closed) State';
        item.tooltip = tooltip('No folder open, so nothing is written.', [
          'Open a folder to start mirroring editor state.',
        ]);
        break;

      case 'error':
        item.text = '$(error) State';
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        item.tooltip = tooltip('Mirroring **failed**.', [status.error ?? 'unknown error']);
        break;

      case 'active':
        item.text = '$(eye) State';
        item.tooltip = tooltip('Mirroring editor state for AI agents.', [
          `File: \`${status.path ?? 'resolving…'}\``,
          `Last write: ${age(status.lastWriteMs)}`,
          `Writes this session: ${status.writes}`,
          '',
          'Click to open the file agents read.',
        ]);
        break;

      default:
        item.text = '$(eye) State';
        item.tooltip = tooltip('Mirroring is on; nothing written yet.', [
          status.path ? `File: \`${status.path}\`` : 'Waiting for the first editor event.',
        ]);
    }
    item.show();
  };

  render({ state: 'idle', writes: 0 });

  return {
    update: render,
    dispose: () => item.dispose(),
  };
}

function tooltip(headline: string, lines: string[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**Editor State** — ${headline}\n\n`);
  for (const line of lines) md.appendMarkdown(line ? `${line}\n\n` : '\n');
  return md;
}

function age(atMs: number | undefined): string {
  if (!atMs) return 'never';
  const seconds = Math.round((Date.now() - atMs) / 1000);
  if (seconds < 2) return 'just now';
  if (seconds < 90) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}
