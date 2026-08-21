import * as vscode from 'vscode';
import type { StateConfig } from '../config';
import { collect, selectionKindFromVscode } from './collect';
import { buildSnapshot } from './snapshot';
import type { StateFileSink } from './sink';
import type { SelectionKind, Snapshot, WriteReason } from './types';

/**
 * Highest-priority reason wins when several events coalesce into one write
 * (design.md §6: "selectionChange beats documentEdit"). All ten reasons are
 * produced as of M3.
 */
const REASON_PRIORITY: Record<WriteReason, number> = {
  workspaceFoldersChange: 9,
  windowFocus: 8,
  activeEditorChange: 7,
  tabsChange: 6,
  documentSave: 5,
  selectionChange: 4,
  documentEdit: 3,
  activate: 2,
  manual: 1,
  shutdown: 0,
};

/** Safety net so a held-down arrow key (constantly resetting the trailing timer) still flushes (§6). */
const MAX_WAIT_MS = 750;

export class StateWatcher implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private trailingTimer: ReturnType<typeof setTimeout> | undefined;
  private maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingReason: WriteReason | null = null;
  private lastSelectionKind: SelectionKind = null;
  private prevSnapshot: Snapshot | null = null;
  private inFlightFlush: Promise<void> | null = null;

  constructor(
    private sink: StateFileSink,
    private getConfig: () => StateConfig,
    private meta: { extensionVersion: string; windowId: string; heartbeatPath: string },
  ) {}

  /** Subscribes to editor events and performs the immediate `activate` write. */
  start(): void {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(e => {
        this.lastSelectionKind = selectionKindFromVscode(e.kind);
        this.schedule('selectionChange');
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule('activeEditorChange')),
      // 0 debounce — flush whatever is pending immediately (§6). On blur the
      // user is leaving, which is exactly when an agent is about to read.
      vscode.window.onDidChangeWindowState(() => this.scheduleImmediate('windowFocus')),
      vscode.window.tabGroups.onDidChangeTabs(() => this.schedule('tabsChange')),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.schedule('tabsChange')),
      vscode.workspace.onDidSaveTextDocument(() => this.schedule('documentSave')),
      // Cheap fields only (isDirty, lineCount) — never re-reads selection text on
      // every keystroke, and ignores edits to documents that aren't the active one.
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document === vscode.window.activeTextEditor?.document) this.schedule('documentEdit');
      }),
      // 0 debounce — also re-resolves the sink's output path (§6).
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleImmediate('workspaceFoldersChange')),
    );
    this.scheduleImmediate('activate');
  }

  /** Forces an immediate write with the given reason, cancelling any pending debounce. Awaited by deactivate() and the manual command. */
  async flush(reason: WriteReason): Promise<void> {
    clearTimeout(this.trailingTimer);
    clearTimeout(this.maxWaitTimer);
    this.trailingTimer = undefined;
    this.maxWaitTimer = undefined;
    this.pendingReason = null;
    await this.doFlush(reason);
  }

  dispose(): void {
    clearTimeout(this.trailingTimer);
    clearTimeout(this.maxWaitTimer);
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }

  private schedule(reason: WriteReason): void {
    this.mergeReason(reason);

    // Coalescing, not per-event: one shared trailing timer, reset on every call.
    clearTimeout(this.trailingTimer);
    this.trailingTimer = setTimeout(() => this.performWrite(), this.getConfig().debounceMs);

    // Started once per batch, never reset — bounds latency under sustained events.
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => this.performWrite(), MAX_WAIT_MS);
    }
  }

  /** Bypasses the debounce entirely — for events where staleness defeats the point (§6: window blur, activate). */
  private scheduleImmediate(reason: WriteReason): void {
    this.mergeReason(reason);
    this.performWrite();
  }

  private mergeReason(reason: WriteReason): void {
    if (this.pendingReason === null || REASON_PRIORITY[reason] > REASON_PRIORITY[this.pendingReason]) {
      this.pendingReason = reason;
    }
  }

  private performWrite(): void {
    clearTimeout(this.trailingTimer);
    clearTimeout(this.maxWaitTimer);
    this.trailingTimer = undefined;
    this.maxWaitTimer = undefined;

    const reason = this.pendingReason;
    this.pendingReason = null;
    if (reason === null) return;

    void this.doFlush(reason);
  }

  private doFlush(reason: WriteReason): Promise<void> {
    this.inFlightFlush = this.doFlushAsync(reason).finally(() => {
      this.inFlightFlush = null;
    });
    return this.inFlightFlush;
  }

  private async doFlushAsync(reason: WriteReason): Promise<void> {
    const config = this.getConfig();
    const input = await collect(reason, {
      extensionVersion: this.meta.extensionVersion,
      windowId: this.meta.windowId,
      maxSelectionBytes: config.maxSelectionBytes,
      includeSelectionText: config.includeSelectionText,
      selectionKind: this.lastSelectionKind,
      heartbeatPath: this.meta.heartbeatPath,
      prevActiveEditor: this.prevSnapshot?.activeEditor ?? null,
      excludeGlobs: config.excludeGlobs,
      maxOpenTabs: config.maxOpenTabs,
      maxRecentFiles: config.maxRecentFiles,
    });
    const snapshot = buildSnapshot(input, this.prevSnapshot, Date.now());
    this.prevSnapshot = snapshot;
    await this.sink.write(snapshot);
  }
}
