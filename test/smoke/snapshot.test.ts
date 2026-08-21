import { buildSnapshot, normalizeSelection } from '../../src/state/snapshot';
import type { RawSelection, SnapshotInput } from '../../src/state/types';
import { eq, section } from './harness';

const OPTS = { maxSelectionBytes: 65_536, includeSelectionText: true };

function raw(partial: Partial<RawSelection>): RawSelection {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
    active: { line: 0, character: 0 },
    isEmpty: true,
    reversed: false,
    kind: null,
    text: '',
    precedingLineLength: 0,
    ...partial,
  };
}

export function run(): void {
  // design.md §5.4 "Required test table (M1)".

  section('normalizeSelection: single char', () => {
    const n = normalizeSelection(
      raw({ start: { line: 0, character: 0 }, end: { line: 0, character: 1 }, isEmpty: false, text: 'x' }),
      OPTS,
    );
    eq('startLine', n.startLine, 1);
    eq('startColumn', n.startColumn, 1);
    eq('endLine', n.endLine, 1);
    eq('endColumn', n.endColumn, 2);
    eq('lineCount', n.lineCount, 1);
    eq('wholeLineGesture', n.wholeLineGesture, false);
  });

  section('normalizeSelection: single full line via drag (§5.4 worked example)', () => {
    // Drag-select all of line 4 in a 7-line file: raw (3,0)-(4,0).
    const n = normalizeSelection(
      raw({
        start: { line: 3, character: 0 },
        end: { line: 4, character: 0 },
        isEmpty: false,
        precedingLineLength: 20,
        text: 'print(dir(my_lsit))',
      }),
      OPTS,
    );
    eq('startLine', n.startLine, 4);
    eq('endLine', n.endLine, 4);
    eq('endColumn', n.endColumn, 21);
    eq('lineCount', n.lineCount, 1);
    eq('wholeLineGesture', n.wholeLineGesture, true);
  });

  section('normalizeSelection: single full line via Home+Shift+Down', () => {
    // Mechanically identical range shape to a drag, different lines — the
    // normalizer only ever sees the raw range, never the gesture.
    const n = normalizeSelection(
      raw({
        start: { line: 9, character: 0 },
        end: { line: 10, character: 0 },
        isEmpty: false,
        precedingLineLength: 5,
        text: 'hello',
      }),
      OPTS,
    );
    eq('startLine', n.startLine, 10);
    eq('endLine', n.endLine, 10);
    eq('endColumn', n.endColumn, 6);
    eq('wholeLineGesture', n.wholeLineGesture, true);
  });

  section('normalizeSelection: multi-line ending mid-line (§5.4 "Third" worked example)', () => {
    // raw (3,2)-(5,7) -> startLine 4, startColumn 3, endLine 6, endColumn 8, lineCount 3.
    const n = normalizeSelection(
      raw({ start: { line: 3, character: 2 }, end: { line: 5, character: 7 }, isEmpty: false }),
      OPTS,
    );
    eq('startLine', n.startLine, 4);
    eq('startColumn', n.startColumn, 3);
    eq('endLine', n.endLine, 6);
    eq('endColumn', n.endColumn, 8);
    eq('lineCount', n.lineCount, 3);
    eq('wholeLineGesture', n.wholeLineGesture, false);
  });

  section('normalizeSelection: multi-line ending at char 0 (§5.4 "Second" worked example)', () => {
    // raw (3,0)-(6,0) -> startLine 4, endLine 6, lineCount 3, wholeLineGesture true.
    const n = normalizeSelection(
      raw({
        start: { line: 3, character: 0 },
        end: { line: 6, character: 0 },
        isEmpty: false,
        precedingLineLength: 12,
      }),
      OPTS,
    );
    eq('startLine', n.startLine, 4);
    eq('endLine', n.endLine, 6);
    eq('endColumn', n.endColumn, 13);
    eq('lineCount', n.lineCount, 3);
    eq('wholeLineGesture', n.wholeLineGesture, true);
  });

  section('normalizeSelection: reversed (anchor after active)', () => {
    // start/end stay document-ordered regardless of drag direction; `reversed`
    // is a separate, independently-derived flag.
    const n = normalizeSelection(
      raw({ start: { line: 1, character: 0 }, end: { line: 1, character: 5 }, isEmpty: false, reversed: true }),
      OPTS,
    );
    eq('reversed', n.reversed, true);
    eq('startLine', n.startLine, 2);
    eq('endColumn', n.endColumn, 6);
  });

  section('normalizeSelection: empty (cursor only)', () => {
    const n = normalizeSelection(raw({ start: { line: 2, character: 5 }, end: { line: 2, character: 5 } }), OPTS);
    eq('isEmpty', n.isEmpty, true);
    eq('startLine', n.startLine, 3);
    eq('startColumn', n.startColumn, 6);
    eq('endLine', n.endLine, 3);
    eq('endColumn', n.endColumn, 6);
    eq('lineCount', n.lineCount, 1);
    eq('wholeLineGesture', n.wholeLineGesture, false);
  });

  section('normalizeSelection: empty selection at character 0 does not spuriously trigger whole-line-gesture', () => {
    // The guard this specific case exists for (§5.4): a zero-width range at
    // char 0 satisfies `end.character === 0` but must not be treated as a
    // whole-line selection.
    const n = normalizeSelection(raw({ start: { line: 4, character: 0 }, end: { line: 4, character: 0 } }), OPTS);
    eq('wholeLineGesture', n.wholeLineGesture, false);
    eq('startLine', n.startLine, 5);
    eq('endLine', n.endLine, 5);
  });

  section('normalizeSelection: zero-length document', () => {
    const n = normalizeSelection(raw({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }), OPTS);
    eq('startLine', n.startLine, 1);
    eq('endLine', n.endLine, 1);
    eq('lineCount', n.lineCount, 1);
  });

  section('normalizeSelection: selection on the final line of a file with no trailing newline', () => {
    // end.character > 0, so this can never satisfy the whole-line-gesture guard
    // even though it is the last line in the document.
    const n = normalizeSelection(
      raw({ start: { line: 6, character: 0 }, end: { line: 6, character: 5 }, isEmpty: false, text: 'hello' }),
      OPTS,
    );
    eq('startLine', n.startLine, 7);
    eq('endLine', n.endLine, 7);
    eq('endColumn', n.endColumn, 6);
    eq('wholeLineGesture', n.wholeLineGesture, false);
  });

  section('normalizeSelection: text truncation clips at a UTF-8 char boundary', () => {
    const text = 'a'.repeat(5) + '€'; // '€' is 3 bytes in utf8
    const n = normalizeSelection(
      raw({ start: { line: 0, character: 0 }, end: { line: 0, character: 6 }, isEmpty: false, text }),
      { maxSelectionBytes: 7, includeSelectionText: true },
    );
    eq('textTruncated', n.textTruncated, true);
    eq('text stops before the split multi-byte char', n.text, 'aaaaa');
    eq('clipped text re-encodes losslessly', Buffer.byteLength(n.text ?? '', 'utf8') <= 7, true);
  });

  section('normalizeSelection: includeSelectionText false clears text without an omitted reason', () => {
    const n = normalizeSelection(
      raw({ start: { line: 0, character: 0 }, end: { line: 0, character: 3 }, isEmpty: false, text: 'abc' }),
      { maxSelectionBytes: 65_536, includeSelectionText: false },
    );
    eq('text', n.text, null);
    eq('textOmittedReason', n.textOmittedReason, null);
  });

  const baseInput: SnapshotInput = {
    reason: 'activate',
    extensionVersion: '0.1.0',
    windowId: 'abc12345',
    pid: 1234,
    focused: true,
    vscodeVersion: '1.104.0',
    heartbeatPath: null,
    workspaceName: 'mock-workspace',
    workspaceFile: null,
    workspaceFolders: ['d:/mock/root'],
    activeEditor: null,
    primarySelection: null,
    additionalSelections: [],
    maxSelectionBytes: 65_536,
    includeSelectionText: true,
    excludeGlobs: [],
    openTabs: [],
    maxOpenTabs: 100,
    maxRecentFiles: 25,
  };

  section('buildSnapshot: multi-cursor selections are each independently normalized', () => {
    const s = buildSnapshot(
      {
        ...baseInput,
        primarySelection: raw({ start: { line: 0, character: 0 }, end: { line: 0, character: 1 }, isEmpty: false }),
        additionalSelections: [
          raw({ start: { line: 1, character: 0 }, end: { line: 1, character: 2 }, isEmpty: false }),
          raw({ start: { line: 2, character: 0 }, end: { line: 2, character: 3 }, isEmpty: false }),
        ],
      },
      null,
      0,
    );
    eq('additionalSelections length', s.additionalSelections.length, 2);
    eq('first additional startLine', s.additionalSelections[0].startLine, 2);
    eq('second additional endColumn', s.additionalSelections[1].endColumn, 4);
  });

  section('buildSnapshot: untitled document passes through isUntitled', () => {
    const s = buildSnapshot(
      {
        ...baseInput,
        activeEditor: {
          path: 'untitled:Untitled-1',
          relativePath: null,
          scheme: 'untitled',
          languageId: 'plaintext',
          isUntitled: true,
          isDirty: true,
          lineCount: 1,
          eol: 'lf',
          viewColumn: 1,
          source: 'activeTextEditor',
        },
      },
      null,
      0,
    );
    eq('activeEditor.isUntitled', s.activeEditor?.isUntitled, true);
  });

  section('buildSnapshot: cursor tracks the active (not anchor) position', () => {
    const s = buildSnapshot(
      {
        ...baseInput,
        primarySelection: raw({
          start: { line: 1, character: 0 },
          end: { line: 1, character: 5 },
          active: { line: 1, character: 0 },
          reversed: true,
          isEmpty: false,
        }),
      },
      null,
      0,
    );
    eq('cursor', s.cursor, { line: 2, column: 1 });
  });

  section('buildSnapshot: with no editor and no tabs, openTabs/recentFiles default to empty', () => {
    const s = buildSnapshot(baseInput, null, 1_700_000_000_000);
    eq('openTabs', s.openTabs, []);
    eq('recentFiles', s.recentFiles, []);
    eq('schemaVersion', s.schemaVersion, 1);
    eq('updatedAtMs', s.updatedAtMs, 1_700_000_000_000);
  });

  const activeEditor = {
    path: 'd:/mock/root/a.py',
    relativePath: 'a.py',
    scheme: 'file',
    languageId: 'python',
    isUntitled: false,
    isDirty: false,
    lineCount: 10,
    eol: 'lf' as const,
    viewColumn: 1,
    source: 'activeTextEditor' as const,
  };

  section('buildSnapshot: a deliberate non-empty selection populates lastDeliberateSelection (§7 defence 2)', () => {
    const s = buildSnapshot(
      {
        ...baseInput,
        activeEditor,
        primarySelection: raw({
          start: { line: 3, character: 0 },
          end: { line: 3, character: 5 },
          isEmpty: false,
          kind: 'mouse',
          text: 'hello',
        }),
      },
      null,
      1_000,
    );
    eq('path', s.lastDeliberateSelection?.path, 'd:/mock/root/a.py');
    eq('capturedAtMs', s.lastDeliberateSelection?.capturedAtMs, 1_000);
    eq('startLine', s.lastDeliberateSelection?.startLine, 4);
    eq('text', s.lastDeliberateSelection?.text, 'hello');
  });

  section('buildSnapshot: a programmatic selection does not overwrite an existing lastDeliberateSelection', () => {
    const prev = buildSnapshot(
      {
        ...baseInput,
        activeEditor,
        primarySelection: raw({
          start: { line: 3, character: 0 },
          end: { line: 3, character: 5 },
          isEmpty: false,
          kind: 'mouse',
          text: 'hello',
        }),
      },
      null,
      1_000,
    );
    const next = buildSnapshot(
      {
        ...baseInput,
        activeEditor,
        primarySelection: raw({
          start: { line: 8, character: 0 },
          end: { line: 8, character: 3 },
          isEmpty: false,
          kind: 'command', // e.g. jump-to-definition — not a deliberate gesture
          text: 'xyz',
        }),
      },
      prev,
      2_000,
    );
    eq('lastDeliberateSelection is carried forward unchanged', next.lastDeliberateSelection, prev.lastDeliberateSelection);
  });

  section('buildSnapshot: a cursor click that collapses the selection does not clear lastDeliberateSelection', () => {
    const prev = buildSnapshot(
      {
        ...baseInput,
        activeEditor,
        primarySelection: raw({
          start: { line: 3, character: 0 },
          end: { line: 3, character: 5 },
          isEmpty: false,
          kind: 'mouse',
          text: 'hello',
        }),
      },
      null,
      1_000,
    );
    const next = buildSnapshot(
      {
        ...baseInput,
        activeEditor,
        primarySelection: raw({ start: { line: 5, character: 2 }, end: { line: 5, character: 2 }, isEmpty: true, kind: 'mouse' }),
      },
      prev,
      2_000,
    );
    eq('selection is live-or-null and now empty', next.selection?.isEmpty, true);
    eq('lastDeliberateSelection survives the empty click', next.lastDeliberateSelection, prev.lastDeliberateSelection);
  });

  section('buildSnapshot: no editor at all carries lastDeliberateSelection forward unchanged', () => {
    const prev = buildSnapshot(
      {
        ...baseInput,
        activeEditor,
        primarySelection: raw({
          start: { line: 3, character: 0 },
          end: { line: 3, character: 5 },
          isEmpty: false,
          kind: 'mouse',
          text: 'hello',
        }),
      },
      null,
      1_000,
    );
    // Carried-forward activeEditor with no live selection — the shape collect.ts
    // produces when focus moves to a webview and no active tab resolves either.
    const next = buildSnapshot(
      { ...baseInput, activeEditor: { ...activeEditor, source: 'carriedForward' }, primarySelection: null },
      prev,
      2_000,
    );
    eq('selection is null', next.selection, null);
    eq('lastDeliberateSelection survives', next.lastDeliberateSelection, prev.lastDeliberateSelection);
  });

  section('buildSnapshot: a selection inside an excluded file omits text regardless of includeSelectionText', () => {
    const s = buildSnapshot(
      {
        ...baseInput,
        activeEditor: { ...activeEditor, path: '.env', relativePath: '.env' },
        primarySelection: raw({ start: { line: 0, character: 0 }, end: { line: 0, character: 5 }, isEmpty: false, text: 'SECRET=x' }),
        excludeGlobs: ['**/.env'],
        includeSelectionText: true,
      },
      null,
      1_000,
    );
    eq('text', s.selection?.text, null);
    eq('textOmittedReason', s.selection?.textOmittedReason, 'excluded');
    eq('the range is still recorded', s.selection?.startLine, 1);
  });

  section('buildSnapshot: a non-excluded file with includeSelectionText false omits text without claiming exclusion', () => {
    const s = buildSnapshot(
      {
        ...baseInput,
        activeEditor,
        primarySelection: raw({ start: { line: 0, character: 0 }, end: { line: 0, character: 3 }, isEmpty: false, text: 'abc' }),
        excludeGlobs: ['**/.env'],
        includeSelectionText: false,
      },
      null,
      1_000,
    );
    eq('text', s.selection?.text, null);
    eq('textOmittedReason', s.selection?.textOmittedReason, null);
  });

  section('buildSnapshot: recentFiles adds the active file to the front on a genuine switch', () => {
    const first = buildSnapshot({ ...baseInput, activeEditor }, null, 1_000);
    eq('first switch adds one entry', first.recentFiles.length, 1);
    eq('lastActiveAtMs', first.recentFiles[0].lastActiveAtMs, 1_000);

    const otherFile = { ...activeEditor, path: 'd:/mock/root/b.py', relativePath: 'b.py' };
    const second = buildSnapshot({ ...baseInput, activeEditor: otherFile }, first, 2_000);
    eq('new file is pushed to the front', second.recentFiles[0].path, 'd:/mock/root/b.py');
    eq('previous file moves to second', second.recentFiles[1].path, activeEditor.path);
  });

  section('buildSnapshot: recentFiles does not bump the timestamp while the same file stays active', () => {
    const first = buildSnapshot({ ...baseInput, activeEditor }, null, 1_000);
    // A selectionChange write with no activeEditor switch — must not touch
    // recentFiles, or the sink's no-op skip (R2) would be defeated.
    const second = buildSnapshot({ ...baseInput, activeEditor, reason: 'selectionChange' }, first, 5_000);
    eq('recentFiles content is unchanged', second.recentFiles, first.recentFiles);
    eq('lastActiveAtMs did not advance', second.recentFiles[0].lastActiveAtMs, 1_000);
  });

  section('buildSnapshot: recentFiles drops the oldest once over maxRecentFiles', () => {
    let snap = buildSnapshot({ ...baseInput, activeEditor, maxRecentFiles: 2 }, null, 1_000);
    for (let i = 0; i < 3; i++) {
      const editorN = { ...activeEditor, path: `d:/mock/root/f${i}.py`, relativePath: `f${i}.py` };
      snap = buildSnapshot({ ...baseInput, activeEditor: editorN, maxRecentFiles: 2 }, snap, 2_000 + i);
    }
    eq('capped at maxRecentFiles', snap.recentFiles.length, 2);
    eq('capped flag set', snap.truncation.recentFilesCapped, true);
    eq('most recent survives', snap.recentFiles[0].path, 'd:/mock/root/f2.py');
  });

  section('buildSnapshot: openTabs under the cap is left untouched', () => {
    const tabs = [tab('a.py', true), tab('b.py', false)];
    const s = buildSnapshot({ ...baseInput, openTabs: tabs, maxOpenTabs: 100 }, null, 1_000);
    eq('all tabs kept', s.openTabs.length, 2);
    eq('not capped', s.truncation.openTabsCapped, false);
  });

  section('buildSnapshot: openTabs over the cap keeps the active tab even outside the first N', () => {
    const tabs = [tab('a.py', false), tab('b.py', false), tab('c.py', true)];
    const s = buildSnapshot({ ...baseInput, openTabs: tabs, maxOpenTabs: 2 }, null, 1_000);
    eq('capped to maxOpenTabs', s.openTabs.length, 2);
    eq('capped flag set', s.truncation.openTabsCapped, true);
    eq('active tab survives the cap', s.openTabs.some(t => t.isActive), true);
  });
}

function tab(name: string, isActive: boolean) {
  return {
    relativePath: name,
    path: `d:/mock/root/${name}`,
    scheme: 'file',
    kind: 'text' as const,
    isActive,
    isDirty: false,
    isPinned: false,
    groupId: 1,
  };
}
