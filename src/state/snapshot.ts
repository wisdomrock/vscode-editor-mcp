import { isExcluded } from './exclude';
import {
  SCHEMA_VERSION,
  type LastDeliberateSelection,
  type NormalizedSelection,
  type OpenTabSnapshot,
  type RawSelection,
  type RecentFileSnapshot,
  type Snapshot,
  type SnapshotInput,
} from './types';

/**
 * Pure. No `vscode` import — this is the whole correctness surface (design.md
 * §3, §5.4) and it must be unit-testable without an extension host.
 *
 * `prev` feeds `lastDeliberateSelection`'s carry-forward (§7 defence 2) — the
 * only carry-forward decision that needs no live vscode query, so it belongs
 * here rather than in the impure `collect.ts`. `activeEditor`'s carry-forward
 * (defence 1) *does* need one (`hasAnyTextTab()`), so it is resolved in
 * `collect.ts` instead and arrives here already decided.
 */
export function buildSnapshot(input: SnapshotInput, prev: Snapshot | null, nowMs: number): Snapshot {
  const excluded = isExcluded(input.activeEditor?.relativePath ?? input.activeEditor?.path ?? null, input.excludeGlobs);
  const selectionOpts = { maxSelectionBytes: input.maxSelectionBytes, includeSelectionText: input.includeSelectionText, excluded };
  const selection = input.primarySelection ? normalizeSelection(input.primarySelection, selectionOpts) : null;
  const additionalSelections = input.additionalSelections.map(raw => normalizeSelection(raw, selectionOpts));
  const cursor = input.primarySelection
    ? { line: input.primarySelection.active.line + 1, column: input.primarySelection.active.character + 1 }
    : null;

  const openTabs = capOpenTabs(input.openTabs, input.maxOpenTabs);
  const recentFiles = capRecentFiles(computeRecentFiles(input, prev, nowMs), input.maxRecentFiles);

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
    lastDeliberateSelection: computeLastDeliberateSelection(input, selection, prev, nowMs),
    openTabs: openTabs.list,
    recentFiles: recentFiles.list,
    truncation: { openTabsCapped: openTabs.capped, recentFilesCapped: recentFiles.capped },
  };
}

/**
 * §7 defence 2. Replaced *only* by another deliberate (mouse/keyboard) non-empty
 * selection — never cleared by focus changes, programmatic selections, or a
 * cursor click that collapses the range down to empty.
 */
function computeLastDeliberateSelection(
  input: SnapshotInput,
  selection: NormalizedSelection | null,
  prev: Snapshot | null,
  nowMs: number,
): LastDeliberateSelection | null {
  const isDeliberate = selection !== null && !selection.isEmpty && (selection.kind === 'mouse' || selection.kind === 'keyboard');
  if (isDeliberate && input.activeEditor) {
    return {
      path: input.activeEditor.path,
      relativePath: input.activeEditor.relativePath,
      capturedAtMs: nowMs,
      startLine: selection.startLine,
      startColumn: selection.startColumn,
      endLine: selection.endLine,
      endColumn: selection.endColumn,
      lineCount: selection.lineCount,
      text: selection.text,
    };
  }
  return prev?.lastDeliberateSelection ?? null;
}

/**
 * MRU, most recent first (§5.2) — the `/explain-file` fallback. Only touches
 * the list on a genuine transition (the active file's path differs from the
 * current front entry); re-affirming the same front entry on every keystroke
 * would defeat the sink's no-op skip and reintroduce R2.
 */
function computeRecentFiles(input: SnapshotInput, prev: Snapshot | null, nowMs: number): RecentFileSnapshot[] {
  const prevList = prev?.recentFiles ?? [];
  if (!input.activeEditor || prevList[0]?.path === input.activeEditor.path) return prevList;

  const { path, relativePath } = input.activeEditor;
  const withoutDuplicate = prevList.filter(f => f.path !== path);
  return [{ path, relativePath, lastActiveAtMs: nowMs }, ...withoutDuplicate];
}

function capRecentFiles(list: RecentFileSnapshot[], max: number): { list: RecentFileSnapshot[]; capped: boolean } {
  if (list.length <= max) return { list, capped: false };
  return { list: list.slice(0, max), capped: true }; // already most-recent-first — slicing drops the oldest.
}

/** Keep the active tab + first N (§5.5) — the active tab must never be the one a cap drops. */
function capOpenTabs(tabs: OpenTabSnapshot[], max: number): { list: OpenTabSnapshot[]; capped: boolean } {
  if (tabs.length <= max) return { list: tabs, capped: false };
  const firstN = tabs.slice(0, max);
  if (firstN.some(t => t.isActive) || max === 0) return { list: firstN, capped: true };
  const active = tabs.find(t => t.isActive);
  return { list: active ? [...firstN.slice(0, max - 1), active] : firstN, capped: true };
}

/**
 * design.md §5.4, normative. `raw.start`/`raw.end` are always document-ordered
 * regardless of drag direction (`reversed` is derived separately from
 * anchor vs active) — normalization operates on the ordered values only.
 */
export function normalizeSelection(
  raw: RawSelection,
  opts: { maxSelectionBytes: number; includeSelectionText: boolean; excluded?: boolean },
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

  const { text, textTruncated, textOmittedReason } = clipSelectionText(raw, opts);

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
    textOmittedReason,
    zeroBased: { startLine: start.line, startChar: start.character, endLine: end.line, endChar: end.character },
  };
}

function clipSelectionText(
  raw: RawSelection,
  opts: { maxSelectionBytes: number; includeSelectionText: boolean; excluded?: boolean },
): { text: string | null; textTruncated: boolean; textOmittedReason: 'excluded' | null } {
  // The path is not secret; the contents may be (§9) — excluded files still
  // record their line range, just never the text, regardless of includeSelectionText.
  if (opts.excluded) return { text: null, textTruncated: false, textOmittedReason: 'excluded' };
  if (!opts.includeSelectionText) return { text: null, textTruncated: false, textOmittedReason: null };
  if (Buffer.byteLength(raw.text, 'utf8') <= opts.maxSelectionBytes) {
    return { text: raw.text, textTruncated: false, textOmittedReason: null };
  }
  return { text: clipUtf8(raw.text, opts.maxSelectionBytes), textTruncated: true, textOmittedReason: null };
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
