import {
  SCHEMA_VERSION,
  type NormalizedSelection,
  type RawSelection,
  type Snapshot,
  type SnapshotInput,
} from './types';

/**
 * Pure. No `vscode` import — this is the whole correctness surface (design.md
 * §3, §5.4) and it must be unit-testable without an extension host.
 *
 * `prev` is threaded through for M2's carry-forward (`lastDeliberateSelection`,
 * `activeEditor.source: "carriedForward"`); M1 does not populate either yet, so
 * it is currently unused. Kept in the signature now so the sink/watcher plumbing
 * doesn't change shape when M2 lands.
 */
export function buildSnapshot(input: SnapshotInput, _prev: Snapshot | null, nowMs: number): Snapshot {
  const selectionOpts = { maxSelectionBytes: input.maxSelectionBytes, includeSelectionText: input.includeSelectionText };
  const selection = input.primarySelection ? normalizeSelection(input.primarySelection, selectionOpts) : null;
  const additionalSelections = input.additionalSelections.map(raw => normalizeSelection(raw, selectionOpts));
  const cursor = input.primarySelection
    ? { line: input.primarySelection.active.line + 1, column: input.primarySelection.active.character + 1 }
    : null;

  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date(nowMs).toISOString(),
    updatedAtMs: nowMs,
    reason: input.reason,
    extension: { name: 'editor-state-mcp', version: input.extensionVersion },
    window: {
      id: input.windowId,
      pid: input.pid,
      focused: input.focused,
      vscodeVersion: input.vscodeVersion,
      heartbeatPath: input.heartbeatPath,
    },
    workspace: {
      name: input.workspaceName,
      workspaceFile: input.workspaceFile,
      folders: input.workspaceFolders,
    },
    activeEditor: input.activeEditor,
    selection,
    additionalSelections,
    cursor,
    lastDeliberateSelection: null,
    openTabs: [],
    recentFiles: [],
    truncation: { openTabsCapped: false, recentFilesCapped: false },
  };
}

/**
 * design.md §5.4, normative. `raw.start`/`raw.end` are always document-ordered
 * regardless of drag direction (`reversed` is derived separately from
 * anchor vs active) — normalization operates on the ordered values only.
 */
export function normalizeSelection(
  raw: RawSelection,
  opts: { maxSelectionBytes: number; includeSelectionText: boolean },
): NormalizedSelection {
  const { start, end } = raw;
  let startLine: number;
  let startColumn: number;
  let endLine: number;
  let endColumn: number;
  let wholeLineGesture: boolean;

  // The guard on !isEmpty matters: a zero-width range at character 0 would
  // otherwise satisfy `end.character === 0` spuriously (§5.4).
  if (!raw.isEmpty && end.character === 0 && end.line > start.line) {
    startLine = start.line + 1;
    startColumn = start.character + 1;
    // NOT end.line + 1 — the 0-based index of the line *after* the selection is
    // numerically the 1-based number of the last line *in* it. This is the one
    // end position that cannot go through a generic +1 conversion (§5.4).
    endLine = end.line;
    endColumn = raw.precedingLineLength + 1;
    wholeLineGesture = true;
  } else {
    startLine = start.line + 1;
    startColumn = start.character + 1;
    endLine = end.line + 1;
    endColumn = end.character + 1;
    wholeLineGesture = false;
  }

  const { text, textTruncated } = clipSelectionText(raw, opts);

  return {
    isEmpty: raw.isEmpty,
    startLine,
    startColumn,
    endLine,
    endColumn,
    lineCount: endLine - startLine + 1,
    reversed: raw.reversed,
    kind: raw.kind,
    wholeLineGesture,
    text,
    textTruncated,
    // `excludeGlobs` (§9) lands in M3. includeSelectionText: false is a distinct
    // knob from exclusion, so it clears `text` without claiming a reason.
    textOmittedReason: null,
    zeroBased: { startLine: start.line, startChar: start.character, endLine: end.line, endChar: end.character },
  };
}

function clipSelectionText(
  raw: RawSelection,
  opts: { maxSelectionBytes: number; includeSelectionText: boolean },
): { text: string | null; textTruncated: boolean } {
  if (!opts.includeSelectionText) return { text: null, textTruncated: false };
  if (Buffer.byteLength(raw.text, 'utf8') <= opts.maxSelectionBytes) return { text: raw.text, textTruncated: false };
  return { text: clipUtf8(raw.text, opts.maxSelectionBytes), textTruncated: true };
}

/** Clip, never drop the line range (§5.5) — and never split a multi-byte UTF-8 char. */
function clipUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  // Back off until we land clear of a continuation byte (10xxxxxx).
  while (end > 0 && (buf[end] & 0b1100_0000) === 0b1000_0000) end--;
  return buf.subarray(0, end).toString('utf8');
}
