import * as vscode from 'vscode';
import { describeUri } from '../vscodeUtil';
import type { ActiveEditorSnapshot, RawSelection, SelectionKind, SnapshotInput, WriteReason } from './types';

/**
 * The impure boundary: thin translation from live `vscode` state into the plain
 * `SnapshotInput` that `buildSnapshot` consumes. No normalization logic lives
 * here — that's `snapshot.ts`, on purpose (design.md §3).
 *
 * M1 reads only `vscode.window.activeTextEditor` directly; the active-tab
 * fallback and carried-forward `activeEditor` are M2 (§7 defence 1).
 */
export interface CollectMeta {
  extensionVersion: string;
  windowId: string;
  maxSelectionBytes: number;
  includeSelectionText: boolean;
  /** Captured at the triggering `onDidChangeTextEditorSelection` event, not re-derivable from live state at flush time. */
  selectionKind: SelectionKind;
}

export function collect(reason: WriteReason, meta: CollectMeta): SnapshotInput {
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
    // Written by the heartbeat writer, which lands in M2 (§8.2).
    heartbeatPath: null,
    workspaceName: vscode.workspace.name,
    workspaceFile,
    workspaceFolders: folders.map(f => f.uri.fsPath),
    activeEditor: editor ? describeActiveEditor(editor) : null,
    primarySelection: editor ? toRawSelection(editor.selection, editor.document, meta.selectionKind) : null,
    additionalSelections: editor
      ? editor.selections.slice(1).map(sel => toRawSelection(sel, editor.document, meta.selectionKind))
      : [],
    maxSelectionBytes: meta.maxSelectionBytes,
    includeSelectionText: meta.includeSelectionText,
  };
}

function describeActiveEditor(editor: vscode.TextEditor): ActiveEditorSnapshot {
  const doc = editor.document;
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
    viewColumn: editor.viewColumn ?? null,
    source: 'activeTextEditor',
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
