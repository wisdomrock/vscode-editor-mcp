import * as vscode from 'vscode';
import { collect } from '../../src/state/collect';
import type { ActiveEditorSnapshot } from '../../src/state/types';
import { eq, section } from './harness';

/**
 * §7 defence 1 (active-tab fallback + carry-forward for `activeEditor`) is the
 * one piece of `collect.ts` with real branching logic, so unlike the rest of
 * the impure layer it's worth pinning down here rather than only through the
 * M2 acceptance test (design.md §13), which needs a live extension host.
 */

const BASE_META = {
  extensionVersion: '0.1.0',
  windowId: 'abc12345',
  maxSelectionBytes: 65_536,
  includeSelectionText: true,
  selectionKind: null,
  heartbeatPath: null,
  prevActiveEditor: null as ActiveEditorSnapshot | null,
  excludeGlobs: [] as string[],
  maxOpenTabs: 100,
  maxRecentFiles: 25,
};

function fakeDocument(path: string, overrides: Partial<vscode.TextDocument> = {}): vscode.TextDocument {
  return {
    uri: vscode.Uri.file(path),
    languageId: 'plaintext',
    isUntitled: false,
    isDirty: false,
    lineCount: 1,
    eol: vscode.EndOfLine.LF,
    getText: () => '',
    lineAt: () => ({ text: '' }) as vscode.TextLine,
    ...overrides,
  } as unknown as vscode.TextDocument;
}

function fakeEditor(doc: vscode.TextDocument, viewColumn = 1): vscode.TextEditor {
  const emptySelection = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, active: { line: 0, character: 0 }, isEmpty: true, isReversed: false };
  return {
    document: doc,
    viewColumn,
    selection: emptySelection,
    selections: [emptySelection],
  } as unknown as vscode.TextEditor;
}

function fakeTextTab(doc: vscode.TextDocument): vscode.Tab {
  return { input: new vscode.TabInputText(doc.uri), isActive: true, isDirty: false, isPinned: false } as unknown as vscode.Tab;
}

function resetMock(): void {
  (vscode.window as { activeTextEditor: unknown }).activeTextEditor = undefined;
  vscode.window.tabGroups.all = [];
  vscode.window.tabGroups.activeTabGroup = { activeTab: undefined };
  vscode.workspace.openTextDocument = async () => {
    throw new Error('not implemented in mock');
  };
}

export async function run(): Promise<void> {
  await section('collect: an active text editor resolves with source activeTextEditor', async () => {
    resetMock();
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = fakeEditor(fakeDocument('d:/mock/root/a.py'));

    const input = await collect('activate', BASE_META);
    eq('source', input.activeEditor?.source, 'activeTextEditor');
    eq('path', input.activeEditor?.path, 'd:/mock/root/a.py');
    eq('relativePath', input.activeEditor?.relativePath, 'a.py');
  });

  await section('collect: no active editor falls back to the active tab', async () => {
    resetMock();
    const doc = fakeDocument('d:/mock/root/b.py');
    vscode.window.tabGroups.activeTabGroup = { activeTab: fakeTextTab(doc) };
    vscode.workspace.openTextDocument = async () => doc;

    const input = await collect('activeEditorChange', BASE_META);
    eq('source', input.activeEditor?.source, 'activeTab');
    eq('no live selection from a tab-only resolution', input.primarySelection, null);
  });

  await section('collect: no editor, no active tab, but some text tab exists -> carried forward', async () => {
    resetMock();
    const doc = fakeDocument('d:/mock/root/c.py');
    vscode.window.tabGroups.all = [{ tabs: [fakeTextTab(doc)] } as unknown as vscode.TabGroup];
    // activeTabGroup.activeTab stays undefined — e.g. the active group's tab is a webview, not this text tab.

    const prevActiveEditor: ActiveEditorSnapshot = {
      path: 'd:\\mock\\root\\c.py',
      relativePath: 'c.py',
      scheme: 'file',
      languageId: 'python',
      isUntitled: false,
      isDirty: false,
      lineCount: 5,
      eol: 'lf',
      viewColumn: 1,
      source: 'activeTextEditor',
    };

    const input = await collect('windowFocus', { ...BASE_META, prevActiveEditor });
    eq('source becomes carriedForward', input.activeEditor?.source, 'carriedForward');
    eq('carried path matches the previous editor, not the unrelated tab', input.activeEditor?.path, prevActiveEditor.path);
  });

  await section('collect: no editor, no active tab, and no text tabs anywhere -> null', async () => {
    resetMock();
    // tabGroups.all stays empty — genuinely nothing text-shaped is open.
    const prevActiveEditor: ActiveEditorSnapshot = {
      path: 'd:\\mock\\root\\stale.py',
      relativePath: 'stale.py',
      scheme: 'file',
      languageId: 'python',
      isUntitled: false,
      isDirty: false,
      lineCount: 1,
      eol: 'lf',
      viewColumn: 1,
      source: 'activeTextEditor',
    };

    const input = await collect('windowFocus', { ...BASE_META, prevActiveEditor });
    eq('activeEditor clears to null only when no text tabs remain anywhere', input.activeEditor, null);
  });

  await section('collect: gathers open tabs across all groups, in order, unclamped', async () => {
    resetMock();
    const docA = fakeDocument('d:/mock/root/a.py');
    const docB = fakeDocument('d:/mock/root/b.py');
    vscode.window.tabGroups.all = [
      {
        viewColumn: 1,
        tabs: [
          { input: new vscode.TabInputText(docA.uri), isActive: true, isDirty: false, isPinned: false, label: 'a.py' },
          { input: new vscode.TabInputText(docB.uri), isActive: false, isDirty: true, isPinned: true, label: 'b.py' },
        ],
      } as unknown as vscode.TabGroup,
      { viewColumn: 2, tabs: [{ input: undefined, isActive: false, isDirty: false, isPinned: false, label: 'untitled' }] } as unknown as vscode.TabGroup,
    ];

    const input = await collect('tabsChange', BASE_META);
    eq('all tabs across both groups collected', input.openTabs.length, 3);
    eq('first tab is text and active', input.openTabs[0], {
      relativePath: 'a.py',
      path: 'd:/mock/root/a.py',
      scheme: 'file',
      kind: 'text',
      isActive: true,
      isDirty: false,
      isPinned: false,
      groupId: 1,
    });
    eq('second tab carries its dirty/pinned flags', input.openTabs[1].isDirty, true);
    eq('a non-URI tab is kind "other" with a null path', input.openTabs[2].kind, 'other');
    eq('non-URI tab path is null', input.openTabs[2].path, null);
  });

  resetMock();
}
