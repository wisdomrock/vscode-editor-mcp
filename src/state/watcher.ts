import * as vscode from 'vscode';
import type { StateConfig } from '../config';
import { collect, selectionKindFromVscode } from './collect';
import { buildSnapshot } from './snapshot';
import type { StateFileSink } from './sink';
import type { SelectionKind, Snapshot, WriteReason } from './types';

/**
 * Highest-priority reason wins when several events coalesce into one write
 * (design.md §6: "selectionChange beats documentEdit"). Only `selectionChange`
 * and `activeEditorChange` are ever produced in M1; the rest are wired as their
 * events land in M2/M3, kept here so the ranking doesn't get revisited per event.
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
    private meta: { extensionVersion: string; windowId: string },
  ) {}

  /** Subscribes to editor events and performs the immediate `activate` write. */
  start(): void {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(e => {
        this.lastSelectionKind = selectionKindFromVscode(e.kind);
        this.schedule('selectionChange');
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule('activeEditorChange')),
    );
    this.pendingReason = 'activate';
    this.performWrite();
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
    if (this.pendingReason === null || REASON_PRIORITY[reason] > REASON_PRIORITY[this.pendingReason]) {
      this.pendingReason = reason;
    }

    // Coalescing, not per-event: one shared trailing timer, reset on every call.
    clearTimeout(this.trailingTimer);
    this.trailingTimer = setTimeout(() => this.performWrite(), this.getConfig().debounceMs);

    // Started once per batch, never reset — bounds latency under sustained events.
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => this.performWrite(), MAX_WAIT_MS);
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
    const config = this.getConfig();
    const input = collect(reason, {
      extensionVersion: this.meta.extensionVersion,
      windowId: this.meta.windowId,
      maxSelectionBytes: config.maxSelectionBytes,
      includeSelectionText: config.includeSelectionText,
      selectionKind: this.lastSelectionKind,
    });
    const snapshot = buildSnapshot(input, this.prevSnapshot, Date.now());
    this.prevSnapshot = snapshot;

    this.inFlightFlush = this.sink.write(snapshot).finally(() => {
      this.inFlightFlush = null;
    });
    return this.inFlightFlush;
  }
}
