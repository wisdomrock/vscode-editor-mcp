import * as vscode from 'vscode';

/**
 * The impure boundary: helpers that touch the `vscode` namespace directly.
 * Salvaged from the deleted `tools/shared.ts` and `tools/read.ts`.
 *
 * Nothing here normalizes a selection range. That rule (§5.4 of design.md) lives
 * in `state/snapshot.ts`, which is pure and vscode-free so the off-by-one table
 * can be tested without an extension host.
 */

/**
 * Positions crossing the output boundary are 1-based for both line and column,
 * matching what agents see from the Read tool, grep, compilers and stack traces.
 * The VS Code API is 0-based on both axes.
 *
 * Safe for a bare cursor position. NOT safe for the end of a selection range —
 * see the whole-line-gesture rule in `state/snapshot.ts`.
 */
export function fromPosition(p: vscode.Position): { line: number; column: number } {
  return { line: p.line + 1, column: p.character + 1 };
}

export function fromRange(r: vscode.Range): {
  start: { line: number; column: number };
  end: { line: number; column: number };
} {
  return { start: fromPosition(r.start), end: fromPosition(r.end) };
}

export interface DescribedUri {
  path: string;
  relativePath: string | null;
  scheme: string;
}

export function describeUri(uri: vscode.Uri): DescribedUri {
  const relative = vscode.workspace.asRelativePath(uri, false);
  return {
    // Non-file schemes (untitled:, vscode-vfs:, …) are recorded as URI strings and
    // are not to be treated as readable paths by consumers.
    path: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
    relativePath: relative === uri.fsPath ? null : relative,
    scheme: uri.scheme,
  };
}

/**
 * The focused text editor, falling back to the active tab when focus is elsewhere
 * (e.g. the Claude Code sidebar webview). This is defence 1 of §7 and the reason
 * the collect path is async: resolving a tab may have to open the document.
 */
export async function activeDocument(): Promise<vscode.TextDocument | undefined> {
  if (vscode.window.activeTextEditor) return vscode.window.activeTextEditor.document;

  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  if (tab?.input instanceof vscode.TabInputText) {
    try {
      return await vscode.workspace.openTextDocument(tab.input.uri);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export type TabKind = 'text' | 'diff' | 'notebook' | 'custom' | 'other';

export interface DescribedTab {
  label: string;
  kind: TabKind;
  path: string | null;
  relativePath: string | null;
  scheme: string | null;
  isActive: boolean;
  isDirty: boolean;
  isPinned: boolean;
}

/** Tabs reflect what the user actually sees, unlike `workspace.textDocuments`. */
export function describeTab(tab: vscode.Tab): DescribedTab {
  const base = { label: tab.label, isActive: tab.isActive, isDirty: tab.isDirty, isPinned: tab.isPinned };
  const input = tab.input;

  if (input instanceof vscode.TabInputText) {
    return { ...base, kind: 'text', ...describeUri(input.uri) };
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return { ...base, kind: 'diff', ...describeUri(input.modified) };
  }
  if (input instanceof vscode.TabInputNotebook) {
    return { ...base, kind: 'notebook', ...describeUri(input.uri) };
  }
  if (input instanceof vscode.TabInputCustom) {
    return { ...base, kind: 'custom', ...describeUri(input.uri) };
  }
  return { ...base, kind: 'other', path: null, relativePath: null, scheme: null };
}

/** True when no text-editor tab remains anywhere — the only condition that clears carried-forward state (§7). */
export function hasAnyTextTab(): boolean {
  return vscode.window.tabGroups.all.some(group =>
    group.tabs.some(tab => tab.input instanceof vscode.TabInputText),
  );
}
