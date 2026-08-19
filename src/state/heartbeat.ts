import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { atomicWriteJson, isAlive, removeFileIfPresent } from '../atomicWrite';
import { HEARTBEAT_DIR } from '../config';
import { log } from '../log';

/**
 * §8.2: R1's mitigation. Written every `heartbeatSeconds` regardless of focus,
 * so "no write in 10 minutes" (which the sink's no-op skip makes ambiguous for
 * `state.json` itself) has an independent, unambiguous liveness signal.
 * Deliberately in the global dir, not the workspace — see config.ts's
 * `GLOBAL_DIR` comment for why a fixed-period write can't go in the project tree.
 */
export interface HeartbeatPayload {
  windowId: string;
  pid: number;
  updatedAtMs: number;
  focused: boolean;
  statePath: string | undefined;
}

export class HeartbeatWriter implements vscode.Disposable {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly filePath: string;
  /** Tracks whichever tick is currently in flight, so dispose() can wait for it before removing the file. */
  private tickPromise: Promise<void> = Promise.resolve();

  constructor(
    private windowId: string,
    private getHeartbeatMs: () => number,
    private getEnabled: () => boolean,
    private getStatePath: () => string | undefined,
  ) {
    this.filePath = path.join(HEARTBEAT_DIR, `${process.pid}.json`);
  }

  path(): string {
    return this.filePath;
  }

  /**
   * Re-reads config and starts, restarts (interval changed) or stops the timer
   * accordingly. Call on activation and on every config change — no listener,
   * no restart, same philosophy as the sink (design.md §0).
   */
  sync(): void {
    const ms = this.getHeartbeatMs();
    if (!this.getEnabled() || ms <= 0) {
      this.stop();
      return;
    }
    clearInterval(this.timer);
    this.timer = setInterval(() => this.scheduleTick(), ms);
    this.scheduleTick();
  }

  private scheduleTick(): void {
    this.tickPromise = this.tick();
  }

  /** Stops ticking and removes the file — §9: `enabled: false` must remove state *and* heartbeat. */
  private stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    void removeFileIfPresent(this.filePath).catch(() => {});
  }

  private async tick(): Promise<void> {
    const payload: HeartbeatPayload = {
      windowId: this.windowId,
      pid: process.pid,
      updatedAtMs: Date.now(),
      focused: vscode.window.state.focused,
      statePath: this.getStatePath(),
    };
    try {
      await atomicWriteJson(this.filePath, payload);
    } catch (err) {
      log.warn(`Failed to write heartbeat: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Final cleanup on deactivate() — always removes the file regardless of
   * current config. Waits for any in-flight tick first: otherwise a tick
   * already mid-write could finish *after* the removal and recreate the file,
   * breaking the "removed on deactivate()" guarantee (§8.2).
   */
  async dispose(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.tickPromise;
    await removeFileIfPresent(this.filePath);
  }
}

/** Clears heartbeat files left by hosts that crashed without deactivating (§8.2). */
export async function pruneDeadHeartbeats(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(HEARTBEAT_DIR);
  } catch {
    return; // directory doesn't exist yet — nothing to prune
  }

  await Promise.all(
    entries
      .filter(f => f.endsWith('.json'))
      .map(async f => {
        const pid = Number.parseInt(f, 10);
        if (Number.isFinite(pid) && !isAlive(pid)) {
          await removeFileIfPresent(path.join(HEARTBEAT_DIR, f)).catch(() => {});
        }
      }),
  );
}
