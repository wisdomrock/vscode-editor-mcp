import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteJson, isAlive, removeFileIfPresent } from '../../src/atomicWrite';
import { check, eq, note, section } from './harness';

const TORN_READ_CYCLES = 1000;

export async function run(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-state-test-'));

  // Two distinct properties, deliberately not conflated:
  //
  //   Tearing  — a reader must NEVER see a partial document. Absolute; any
  //              violation is a correctness bug.
  //   Dropping — a write may fail under contention. Tolerable by design (§8):
  //              the sink logs and drops, the next event rewrites, and
  //              updatedAtMs tells the reader how old the file is.
  //
  // Windows makes the second one routine, because Node opens files without
  // FILE_SHARE_DELETE and so any live reader can block the rename with EPERM.
  async function tornReadRun(
    name: string,
    opts: { readGapMs: number; writeGapMs: number; writes: number; maxDropRate?: number },
  ) {
    const { readGapMs, writeGapMs, writes, maxDropRate } = opts;
    await section(`atomicWrite: ${name}`, async () => {
      const target = path.join(dir, `state-${name.replace(/\W+/g, '-')}.json`);
      let reads = 0;
      let torn = 0;
      let drops = 0;
      let stop = false;

      const reader = (async () => {
        while (!stop) {
          try {
            const raw = await fs.readFile(target, 'utf8');
            reads++;
            // Payload length is derived from n, so a torn read desyncs these two
            // fields even in the unlikely case it stayed parseable.
            const parsed = JSON.parse(raw) as { n: number; filler: string };
            if (parsed.filler.length !== parsed.n % 500) torn++;
          } catch (err) {
            // ENOENT only before the first write lands; anything else that is not
            // a clean parse counts as tearing.
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') torn++;
          }
          if (readGapMs > 0) await new Promise(r => setTimeout(r, readGapMs));
        }
      })();

      for (let n = 0; n < writes; n++) {
        try {
          await atomicWriteJson(target, { n, filler: 'x'.repeat(n % 500) });
        } catch {
          drops++; // exactly what the sink will swallow in production
        }
        if (writeGapMs > 0) await new Promise(r => setTimeout(r, writeGapMs));
      }
      stop = true;
      await reader;

      const dropRate = drops / writes;
      const detail = `${drops}/${writes} dropped (${(dropRate * 100).toFixed(1)}%), ${reads} reads`;

      check('reader actually observed the file', reads > 0, `${reads} reads`);
      eq(`no torn reads across ${writes} writes`, torn, 0);

      if (maxDropRate === undefined) {
        note('dropped writes (not a guarantee — the sink re-schedules)', detail);
      } else {
        check(`dropped writes stay under ${Math.round(maxDropRate * 100)}%`, dropRate <= maxDropRate, detail);
      }
    });
  }

  // Tearing is the absolute guarantee, so it is tested under load far beyond
  // anything real: writes back-to-back against a reader with no gap at all.
  // Drops are expected here and are only reported.
  await tornReadRun('no torn reads under pathological load', {
    readGapMs: 0,
    writeGapMs: 0,
    writes: TORN_READ_CYCLES,
  });

  // Drops are a quality metric, so they are measured at a cadence resembling
  // production: writes no faster than the debounce, against a reader still far
  // busier than a real consumer (which reads once per invocation).
  await tornReadRun('few dropped writes at production cadence', {
    readGapMs: 5,
    writeGapMs: 50,
    writes: 60,
    maxDropRate: 0.05,
  });

  await section('atomicWrite: leaves no temp files behind', async () => {
    const target = path.join(dir, 'clean.json');
    await atomicWriteJson(target, { ok: true });
    const leftovers = (await fs.readdir(dir)).filter(f => f.endsWith('.tmp'));
    eq('no .tmp remains after a successful write', leftovers, []);
  });

  await section('atomicWrite: creates missing parent directories', async () => {
    const target = path.join(dir, 'nested', 'deeper', 'state.json');
    await atomicWriteJson(target, { nested: true });
    const body = JSON.parse(await fs.readFile(target, 'utf8')) as { nested: boolean };
    eq('file written through mkdir -p', body.nested, true);
  });

  await section('atomicWrite: cleans up and rethrows when the rename cannot succeed', async () => {
    // A directory at the target path is the most portable way to force rename to
    // fail. Windows reports EPERM (retryable, so this also exercises the backoff
    // path); POSIX reports EISDIR and fails fast. Both must clean up.
    const target = path.join(dir, 'blocked.json');
    await fs.mkdir(target, { recursive: true });

    const startedAt = Date.now();
    let thrown: NodeJS.ErrnoException | undefined;
    try {
      await atomicWriteJson(target, { nope: true });
    } catch (err) {
      thrown = err as NodeJS.ErrnoException;
    }
    const elapsed = Date.now() - startedAt;

    check('the write throws rather than silently dropping', thrown !== undefined, thrown?.code ?? 'no error');
    const leftovers = (await fs.readdir(dir)).filter(f => f.startsWith('blocked.json.') && f.endsWith('.tmp'));
    eq('no .tmp remains after a failed write', leftovers, []);

    if (thrown && ['EPERM', 'EBUSY', 'EACCES'].includes(thrown.code ?? '')) {
      // 5+10+20+40+80+160 = 315 ms of backoff, less the 0.75x jitter floor.
      check('retryable failures exhaust the backoff before giving up', elapsed >= 200, `${elapsed}ms`);
    } else {
      check('non-retryable failures fail fast', elapsed < 100, `${elapsed}ms, code ${thrown?.code}`);
    }
  });

  await section('atomicWrite: overwrites an existing file in place', async () => {
    const target = path.join(dir, 'overwrite.json');
    await atomicWriteJson(target, { v: 1 });
    await atomicWriteJson(target, { v: 2 });
    const body = JSON.parse(await fs.readFile(target, 'utf8')) as { v: number };
    eq('second write replaces the first', body.v, 2);
  });

  await section('removeFileIfPresent tolerates a missing file', async () => {
    let threw = false;
    try {
      await removeFileIfPresent(path.join(dir, 'never-existed.json'));
    } catch {
      threw = true;
    }
    eq('removing a missing file is a no-op', threw, false);

    const target = path.join(dir, 'doomed.json');
    await atomicWriteJson(target, {});
    await removeFileIfPresent(target);
    const gone = await fs
      .access(target)
      .then(() => false)
      .catch(() => true);
    eq('an existing file is actually removed', gone, true);
  });

  await section('isAlive distinguishes live from dead pids', () => {
    eq('our own pid is alive', isAlive(process.pid), true);
    // A pid that cannot exist. Not 0: signal 0 to pid 0 targets the process group.
    eq('an impossible pid is not alive', isAlive(2 ** 30), false);
  });

  await fs.rm(dir, { recursive: true, force: true });
}
