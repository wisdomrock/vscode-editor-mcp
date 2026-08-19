import * as vscode from 'vscode';
import { activeDocument, describeTab, describeUri, hasAnyTextTab } from '../vscodeUtil';
import type {
  ActiveEditorSnapshot,
  ActiveEditorSource,
  OpenTabSnapshot,
  RawSelection,
  SelectionKind,
  SnapshotInput,
  WriteReason,
} from './types';

/**
 * The impure boundary: thin translation from live `vscode` state into the plain
 * `SnapshotInput` that `buildSnapshot` consumes. No normalization logic lives
 * here — that's `snapshot.ts`, on purpose (design.md §3).
 *
 * `activeEditor` resolution (§7 defence 1) is the one exception to "thin": it
 * needs `hasAnyTextTab()`, a live vscode query, to decide carry-forward vs
 * clearing to null, so that decision has to live here rather than in the pure
 * `buildSnapshot`.
 */
export interface CollectMeta {
  extensionVersion: string;
  windowId: string;
  maxSelectionBytes: number;
  includeSelectionText: boolean;
  /** Captured at the triggering `onDidChangeTextEditorSelection` event, not re-derivable from live state at flush time. */
  selectionKind: SelectionKind;
  heartbeatPath: string | null;
  /** From the previous snapshot — carried forward when no editor and no active tab resolve, but some text tab still exists. */
  prevActiveEditor: ActiveEditorSnapshot | null;
  excludeGlobs: string[];
  maxOpenTabs: number;
  maxRecentFiles: number;
}

export async function collect(reason: WriteReason, meta: CollectMeta): Promise<SnapshotInput> {
  const editor = vscode.window.activeTextEditor;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const workspaceFile = vscode.workspace.workspaceFile ? describeUri(vscode.workspace.workspaceFile).path : null;

  return {
    reason,
    extensionVersion: meta.extensionVersion,
    windowId: meta.windowId,
    pid: process.pid,
    focused: vscode.window.state.focused,
    vscodeVersion: vscode.version,
    heartbeatPath: meta.heartbeatPath,
    workspaceName: vscode.workspace.name,
    workspaceFile,
    workspaceFolders: folders.map(f => f.uri.fsPath),
    activeEditor: await resolveActiveEditor(editor, meta.prevActiveEditor),
    primarySelection: editor ? toRawSelection(editor.selection, editor.document, meta.selectionKind) : null,
    additionalSelections: editor
      ? editor.selections.slice(1).map(sel => toRawSelection(sel, editor.document, meta.selectionKind))
      : [],
    maxSelectionBytes: meta.maxSelectionBytes,
    includeSelectionText: meta.includeSelectionText,
    excludeGlobs: meta.excludeGlobs,
    openTabs: collectOpenTabs(),
    maxOpenTabs: meta.maxOpenTabs,
    maxRecentFiles: meta.maxRecentFiles,
  };
}

/** All groups in tab order (design.md §5.2) — reflects what the user actually sees, unlike `workspace.textDocuments`. Unclamped; `buildSnapshot` applies the cap. */
function collectOpenTabs(): OpenTabSnapshot[] {
  const tabs: OpenTabSnapshot[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const described = describeTab(tab);
      tabs.push({
        relativePath: described.relativePath,
        path: described.path,
        scheme: described.scheme,
        kind: described.kind,
        isActive: described.isActive,
        isDirty: described.isDirty,
        isPinned: described.isPinned,
        groupId: group.viewColumn,
      });
    }
  }
  return tabs;
}

/**
 * §7 defence 1: focused editor, else the active tab, else the previous
 * `activeEditor` carried forward. Only a genuine "no text tabs remain
 * anywhere" clears it to null — the failure mode this whole defence exists to
 * avoid is nulling out `activeEditor` just because focus moved to a webview.
 */
async function resolveActiveEditor(
  editor: vscode.TextEditor | undefined,
  prevActiveEditor: ActiveEditorSnapshot | null,
): Promise<ActiveEditorSnapshot | null> {
  if (editor) return describeDocument(editor.document, 'activeTextEditor', editor.viewColumn ?? null);

  // Salvaged from the deleted tools/read.ts (design.md §7): re-derives the same
  // fallback internally, so this re-checks activeTextEditor once more for no cost.
  const doc = await activeDocument();
  if (doc) return describeDocument(doc, 'activeTab', null);

  if (hasAnyTextTab()) return prevActiveEditor ? { ...prevActiveEditor, source: 'carriedForward' } : null;
  return null;
}

function describeDocument(doc: vscode.TextDocument, source: ActiveEditorSource, viewColumn: number | null): ActiveEditorSnapshot {
  const described = describeUri(doc.uri);
  return {
    path: described.path,
    relativePath: described.relativePath,
    scheme: described.scheme,
    languageId: doc.languageId,
    isUntitled: doc.isUntitled,
    isDirty: doc.isDirty,
    lineCount: doc.lineCount,
    eol: doc.eol === vscode.EndOfLine.CRLF ? 'crlf' : 'lf',
    viewColumn,
    source,
  };
}

function toRawSelection(sel: vscode.Selection, doc: vscode.TextDocument, kind: SelectionKind): RawSelection {
  return {
    start: { line: sel.start.line, character: sel.start.character },
    end: { line: sel.end.line, character: sel.end.character },
    active: { line: sel.active.line, character: sel.active.character },
    isEmpty: sel.isEmpty,
    reversed: sel.isReversed,
    kind,
    text: doc.getText(new vscode.Range(sel.start, sel.end)),
    // Only ever consumed by the whole-line-gesture branch, which requires
    // end.line > start.line >= 0, so end.line - 1 is always a valid index there.
    precedingLineLength: sel.end.line > 0 ? doc.lineAt(sel.end.line - 1).text.length : 0,
  };
}

/** `TextEditorSelectionChangeKind` -> our plain `SelectionKind`. */
export function selectionKindFromVscode(kind: vscode.TextEditorSelectionChangeKind | undefined): SelectionKind {
  switch (kind) {
    case vscode.TextEditorSelectionChangeKind.Keyboard:
      return 'keyboard';
    case vscode.TextEditorSelectionChangeKind.Mouse:
      return 'mouse';
    case vscode.TextEditorSelectionChangeKind.Command:
      return 'command';
    default:
      return null;
  }
}
