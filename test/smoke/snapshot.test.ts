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

  section('buildSnapshot: M1 fields not yet populated stay at their documented defaults', () => {
    const s = buildSnapshot(baseInput, null, 1_700_000_000_000);
    eq('lastDeliberateSelection', s.lastDeliberateSelection, null);
    eq('openTabs', s.openTabs, []);
    eq('recentFiles', s.recentFiles, []);
    eq('schemaVersion', s.schemaVersion, 1);
    eq('updatedAtMs', s.updatedAtMs, 1_700_000_000_000);
  });
}
