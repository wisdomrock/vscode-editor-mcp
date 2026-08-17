/**
 * The output contract (design.md §5). Plain data only — nothing here may import
 * `vscode`. This is the source of truth for docs/state-file.md (§10.3, not yet
 * written) and for `snapshot.ts`, which is pure specifically so these shapes can
 * be unit-tested without an extension host.
 */

/** Bump on any breaking change. Additive changes only within a major (§5.2, R9). */
export const SCHEMA_VERSION = 1;

export type WriteReason =
  | 'activate'
  | 'selectionChange'
  | 'activeEditorChange'
  | 'windowFocus'
  | 'tabsChange'
  | 'documentSave'
  | 'documentEdit'
  | 'workspaceFoldersChange'
  | 'manual'
  | 'shutdown';

export type SelectionKind = 'keyboard' | 'mouse' | 'command' | null;

/** M1 only ever produces `activeTextEditor` or `null` — §7's fallback/carry-forward land in M2. */
export type ActiveEditorSource = 'activeTextEditor' | 'activeTab' | 'carriedForward';

export interface ZeroBasedRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

export interface NormalizedSelection {
  isEmpty: boolean;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  lineCount: number;
  reversed: boolean;
  kind: SelectionKind;
  wholeLineGesture: boolean;
  text: string | null;
  textTruncated: boolean;
  textOmittedReason: 'excluded' | null;
  zeroBased: ZeroBasedRange;
}

export interface LastDeliberateSelection {
  path: string;
  relativePath: string | null;
  capturedAtMs: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  lineCount: number;
  text: string | null;
}

export interface ActiveEditorSnapshot {
  path: string;
  relativePath: string | null;
  scheme: string;
  languageId: string;
  isUntitled: boolean;
  isDirty: boolean;
  lineCount: number;
  eol: 'lf' | 'crlf';
  viewColumn: number | null;
  source: ActiveEditorSource;
}

export interface OpenTabSnapshot {
  relativePath: string | null;
  path: string;
  kind: 'text' | 'diff' | 'notebook' | 'custom' | 'other';
  isActive: boolean;
  isDirty: boolean;
  isPinned: boolean;
  groupId: number;
}

export interface RecentFileSnapshot {
  relativePath: string | null;
  path: string;
  lastActiveAtMs: number;
}

export interface Snapshot {
  schemaVersion: number;
  updatedAt: string;
  updatedAtMs: number;
  reason: WriteReason;
  extension: { name: string; version: string };
  window: {
    id: string;
    pid: number;
    focused: boolean;
    vscodeVersion: string;
    /** Null until the heartbeat writer lands in M2 (§8.2). */
    heartbeatPath: string | null;
  };
  workspace: {
    name: string | undefined;
    workspaceFile: string | null;
    folders: string[];
  };
  activeEditor: ActiveEditorSnapshot | null;
  selection: NormalizedSelection | null;
  additionalSelections: NormalizedSelection[];
  cursor: { line: number; column: number } | null;
  /** Always null in M1 — carry-forward across focus loss is M2 (§7). */
  lastDeliberateSelection: LastDeliberateSelection | null;
  /** Always [] in M1 — populated in M3 (§13). */
  openTabs: OpenTabSnapshot[];
  /** Always [] in M1 — populated in M3 (§13). */
  recentFiles: RecentFileSnapshot[];
  truncation: { openTabsCapped: boolean; recentFilesCapped: boolean };
}

/**
 * A single 0-based, document-ordered range plus everything `normalizeSelection`
 * needs to derive its output — computed by the impure `collect.ts` so this stays
 * plain data with no vscode dependency.
 */
export interface RawSelection {
  start: { line: number; character: number };
  end: { line: number; character: number };
  /** The actual caret position (vscode's `Selection.active`), independent of document order. */
  active: { line: number; character: number };
  isEmpty: boolean;
  /** `Selection.isReversed` — anchor is after active. */
  reversed: boolean;
  kind: SelectionKind;
  /** Full, untruncated selected text. */
  text: string;
  /** Length of the raw 0-based line `end.line - 1`. Only meaningful for the whole-line-gesture branch (§5.4). */
  precedingLineLength: number;
}

/**
 * Everything `buildSnapshot` needs, already extracted from `vscode` by
 * `collect.ts`. Plain data in, plain data out — the whole point of the
 * pure/impure split (design.md §3).
 */
export interface SnapshotInput {
  reason: WriteReason;
  extensionVersion: string;
  windowId: string;
  pid: number;
  focused: boolean;
  vscodeVersion: string;
  heartbeatPath: string | null;
  workspaceName: string | undefined;
  workspaceFile: string | null;
  workspaceFolders: string[];
  activeEditor: ActiveEditorSnapshot | null;
  primarySelection: RawSelection | null;
  additionalSelections: RawSelection[];
  maxSelectionBytes: number;
  includeSelectionText: boolean;
}
