import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Durability primitive, salvaged from the deleted `discovery.ts` and hardened.
 *
 * Write-then-rename is the whole point: a reader polling the target sees either
 * the previous complete file or the new complete file, never a partial one. That
 * guarantee is what lets consumers `Read` the state file at any instant without
 * coordination.
 *
 * This module deliberately throws on failure. Swallowing belongs one layer up, in
 * the callers that run inside VS Code event handlers.
 */

/**
 * Windows contention is not an edge case here, it is the common case.
 *
 * Node opens files without FILE_SHARE_DELETE, so *any* process holding the
 * destination open at the instant of the rename blocks it with EPERM — a reader
 * doing a single `readFile` is enough if it lands in the wrong microsecond.
 * Measured: a reader in a tight loop fails the very first attempt, and a
 * 25/50/100 ms budget was not enough to outlast it.
 *
 * Starts fast because the overwhelmingly likely case is a reader that holds the
 * handle for well under a millisecond; tails out to cover an AV scanner or
 * indexer. Total worst case ~315 ms plus jitter, which the sink absorbs by
 * coalescing rather than queueing.
 */
const RETRY_BACKOFF_MS = [5, 10, 20, 40, 80, 160];

/** Rename losing to another process holding the target open, rather than a real error. */
const CONTENTION_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface AtomicWriteOptions {
  /** Defaults to 0o600 — these files can contain selected source text. */
  mode?: number;
  /** Rename attempts after the first. Defaults to 3. */
  retries?: number;
}

export async function atomicWriteJson(target: string, data: unknown, opts?: AtomicWriteOptions): Promise<void> {
  return atomicWriteText(target, JSON.stringify(data, null, 2), opts);
}

export async function atomicWriteText(target: string, body: string, opts: AtomicWriteOptions = {}): Promise<void> {
  const mode = opts.mode ?? 0o600;
  const maxRetries = opts.retries ?? RETRY_BACKOFF_MS.length;

  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });

  // The pid keeps concurrent extension hosts from colliding on the temp name.
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, body, { mode });

  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, target);
      return;
    } catch (err) {
      // Windows is the primary platform here. MoveFileEx with MOVEFILE_REPLACE_EXISTING
      // still loses to an AV scanner, an indexer or a reader holding the target open,
      // and it surfaces as EPERM/EBUSY/EACCES rather than anything more specific.
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= maxRetries || !CONTENTION_CODES.has(code)) {
        await fs.rm(tmp, { force: true }).catch(() => {
          /* the temp file is already the lesser problem */
        });
        throw err;
      }
      await delay(jitter(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]));
    }
  }
}

export async function removeFileIfPresent(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Whether a pid is still running, for pruning files left by hosts that crashed
 * without deactivating. Salvaged from `discovery.ts`.
 */
export function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Spreads retries so two windows contending on one file do not resynchronise on every attempt (R4). */
function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
