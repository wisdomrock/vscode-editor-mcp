import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { log } from './log';

export const DISCOVERY_VERSION = 1;

export interface DiscoveryRecord {
  version: number;
  pid: number;
  url: string;
  host: string;
  port: number;
  token: string | null;
  authRequired: boolean;
  writeEnabled: boolean;
  workspaceName: string | null;
  workspaceFolders: string[];
  vscodeVersion: string;
  startedAt: string;
}

/**
 * One file per extension host process. Clients pick a window by matching their
 * cwd against `workspaceFolders`; the port is not knowable ahead of time because
 * we bind port 0 so that multiple windows can run side by side.
 */
export class DiscoveryFile {
  private filePath: string | undefined;

  constructor(private readonly dir: string) {}

  async write(record: Omit<DiscoveryRecord, 'version' | 'pid' | 'workspaceName' | 'workspaceFolders' | 'vscodeVersion'>): Promise<string> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.pruneStale();

    const folders = vscode.workspace.workspaceFolders ?? [];
    const full: DiscoveryRecord = {
      version: DISCOVERY_VERSION,
      pid: process.pid,
      workspaceName: vscode.workspace.name ?? null,
      workspaceFolders: folders.filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath),
      vscodeVersion: vscode.version,
      ...record,
    };

    const target = path.join(this.dir, `${process.pid}.json`);
    // Write-then-rename so a client never reads a half-written file.
    const tmp = `${target}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(full, null, 2), { mode: 0o600 });
    await fs.rename(tmp, target);
    this.filePath = target;
    log.info(`Discovery file written: ${target}`);
    return target;
  }

  async remove(): Promise<void> {
    if (!this.filePath) return;
    try {
      await fs.unlink(this.filePath);
      log.info(`Discovery file removed: ${this.filePath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Could not remove discovery file: ${String(err)}`);
      }
    }
    this.filePath = undefined;
  }

  /** Drop records left behind by extension hosts that died without deactivating. */
  private async pruneStale(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return;
    }

    await Promise.all(
      entries
        .filter(name => name.endsWith('.json'))
        .map(async name => {
          const pid = Number.parseInt(name.slice(0, -'.json'.length), 10);
          if (!Number.isInteger(pid) || pid <= 0 || isAlive(pid)) return;
          try {
            await fs.unlink(path.join(this.dir, name));
            log.debug(`Pruned stale discovery file for dead pid ${pid}`);
          } catch {
            /* raced with another window; harmless */
          }
        }),
    );
  }
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
