import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { log } from '../log';

/**
 * §4.3: on first successful write, offer once to add the state directory to
 * `.gitignore`. Prompts rather than silently editing a tracked file; an
 * existing `.gitignore` is required (we never create one — a repo without one
 * may be intentional, and creating one is a bigger footprint than this feature
 * deserves), and a workspace-relative path is required (an absolute
 * `editorStateMcp.path` writes outside the repo, so there's nothing to ignore).
 */
export async function maybePromptGitignore(
  root: string,
  configuredPath: string,
  workspaceState: vscode.Memento,
): Promise<void> {
  if (path.isAbsolute(configuredPath)) return;

  const ignoreEntry = topLevelIgnoreEntry(configuredPath);
  const neverKey = `editorStateMcp.gitignore.never:${root}`;
  if (workspaceState.get<boolean>(neverKey)) return;

  const gitignorePath = path.join(root, '.gitignore');
  let content: string;
  try {
    content = await fs.readFile(gitignorePath, 'utf8');
  } catch {
    log.info('No .gitignore in this workspace — not creating one for the state directory.');
    return;
  }
  if (alreadyIgnores(content, ignoreEntry)) return;

  const choice = await vscode.window.showInformationMessage(
    `editor-state-mcp writes live editor state (including selected text) to ${ignoreEntry} — add it to .gitignore?`,
    'Add to .gitignore',
    'Not now',
    'Never',
  );

  if (choice === 'Add to .gitignore') {
    const needsLeadingNewline = content.length > 0 && !content.endsWith('\n');
    await fs.appendFile(gitignorePath, `${needsLeadingNewline ? '\n' : ''}\n# editor-state-mcp: live editor state (machine-local)\n${ignoreEntry}\n`);
    log.info(`Added ${ignoreEntry} to .gitignore`);
  } else if (choice === 'Never') {
    await workspaceState.update(neverKey, true);
  }
}

/** The top-level directory (or bare filename) to ignore for a given configured relative path — e.g. `.editor-state/state.json` -> `.editor-state/`. */
function topLevelIgnoreEntry(configuredRelativePath: string): string {
  const normalized = configuredRelativePath.replace(/\\/g, '/');
  const firstSlash = normalized.indexOf('/');
  return firstSlash === -1 ? normalized : `${normalized.slice(0, firstSlash)}/`;
}

function alreadyIgnores(gitignoreContent: string, ignoreEntry: string): boolean {
  const bare = ignoreEntry.replace(/\/$/, '');
  return gitignoreContent
    .split(/\r?\n/)
    .map(line => line.trim())
    .some(line => line === ignoreEntry || line === bare || line === `/${ignoreEntry}` || line === `/${bare}`);
}
