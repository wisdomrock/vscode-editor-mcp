import * as path from 'node:path';
import { atomicWriteJson, removeFileIfPresent } from '../atomicWrite';
import { log } from '../log';
import type { Snapshot } from './types';

/** ~1s, a few attempts — the dropped-write reschedule (design.md §8). */
const RETRY_DELAY_MS = 1_000;
const MAX_RETRIES = 3;

export interface StateFileSinkOptions {
  /** Read fresh on every write — no listener, no restart (design.md §0); a toggle just applies on the next write. */
  getEnabled: () => boolean;
  /** Absolute, or relative to `getWorkspaceRoot()`. Read fresh on every write so a config change applies without restart. */
  getConfiguredPath: () => string;
  getWorkspaceRoot: () => string | undefined;
  /** Fired once, after the first successful write of this activation (§4.3 — the gitignore prompt trigger). */
  onFirstSuccessfulWrite?: (root: string, configuredPath: string) => void;
  /** Fired after every write attempt that changes `writes`/`lastError`, so a status bar can stay live. */
  onStatusChange?: () => void;
}

/**
 * Path resolution, no-op skip, serialised atomic write (design.md §8). Takes
 * plain closures rather than reading `vscode.workspace` directly, so it can be
 * unit-tested against a real temp directory with no vscode stub at all.
 */
export class StateFileSink {
  /** The tail of a serial queue: each write() call chains onto whatever is already pending. */
  private queueTail: Promise<void> = Promise.resolve();
  private pending: Snapshot | null = null;
  private lastWrittenKey: string | null = null;
  private resolvedPath: string | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryCount = 0;
  private loggedNoWorkspace = false;
  private notifiedFirstWrite = false;

  writes = 0;
  lastWriteMs: number | undefined;
  lastError: string | undefined;

  constructor(private opts: StateFileSinkOptions) {}

  currentPath(): string | undefined {
    return this.resolvedPath;
  }

  /**
   * Never throws — failures are logged and rescheduled (§8). Serialised: one
   * in-flight write at a time. A request arriving mid-write overwrites
   * `pending` before the in-flight drain reads it, so only the latest
   * snapshot in a burst is ever written — a single coalesced follow-up.
   */
  write(snapshot: Snapshot): Promise<void> {
    this.pending = snapshot;
    this.queueTail = this.queueTail.then(() => this.drain());
    return this.queueTail;
  }

  private async drain(): Promise<void> {
    if (!this.pending) return;
    const next = this.pending;
    this.pending = null;
    await this.doWrite(next);
  }

  async removeFile(): Promise<void> {
    clearTimeout(this.retryTimer);
    this.retryCount = 0;
    if (this.resolvedPath) await removeFileIfPresent(this.resolvedPath);
    this.lastWrittenKey = null;
  }

  dispose(): void {
    clearTimeout(this.retryTimer);
  }

  private async doWrite(snapshot: Snapshot): Promise<void> {
    if (!this.opts.getEnabled()) return; // §9: enabled: false fully disables the feature.

    const root = this.opts.getWorkspaceRoot();
    if (!root) {
      // §4.2: no workspace open. Never write next to an arbitrary user file.
      if (!this.loggedNoWorkspace) {
        log.info('No workspace folder open — state file mirroring is skipped until one is.');
        this.loggedNoWorkspace = true;
      }
      return;
    }
    this.loggedNoWorkspace = false;

    const target = resolveTargetPath(root, this.opts.getConfiguredPath());
    this.resolvedPath = target;

    const key = contentKey(snapshot);
    if (key === this.lastWrittenKey) return; // §8: skip no-op writes entirely.

    try {
      await atomicWriteJson(target, snapshot);
      this.lastWrittenKey = key;
      this.writes++;
      this.lastWriteMs = Date.now();
      this.lastError = undefined;
      this.retryCount = 0;
      clearTimeout(this.retryTimer);
      if (!this.notifiedFirstWrite) {
        this.notifiedFirstWrite = true;
        this.opts.onFirstSuccessfulWrite?.(root, this.opts.getConfiguredPath());
      }
      this.opts.onStatusChange?.();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to write state file: ${this.lastError}`);
      this.scheduleRetry(snapshot);
      this.opts.onStatusChange?.();
    }
  }

  private scheduleRetry(snapshot: Snapshot): void {
    clearTimeout(this.retryTimer);
    if (this.retryCount >= MAX_RETRIES) {
      log.warn('State file write still failing after reschedules; giving up until the next editor event.');
      this.retryCount = 0;
      return;
    }
    this.retryCount++;
    this.retryTimer = setTimeout(() => void this.write(snapshot), RETRY_DELAY_MS);
  }
}

function resolveTargetPath(root: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.join(root, configuredPath);
}

/**
 * Excludes the always-changing fields so identical *content* written seconds
 * apart compares equal. This is what makes the no-op skip real: a snapshot
 * whose only difference is `updatedAtMs` must still be treated as unchanged,
 * which is exactly why the heartbeat (§8.2) exists as an independent liveness
 * signal — a suppressed no-op write means `updatedAtMs` stops advancing too.
 */
function contentKey(s: Snapshot): string {
  const { updatedAt: _updatedAt, updatedAtMs: _updatedAtMs, reason: _reason, ...rest } = s;
  return JSON.stringify(rest);
}
