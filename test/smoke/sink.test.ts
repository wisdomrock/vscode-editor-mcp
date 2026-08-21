import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateFileSink } from '../../src/state/sink';
import type { Snapshot } from '../../src/state/types';
import { check, eq, note, section } from './harness';

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    schemaVersion: 1,
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    updatedAtMs: 1_700_000_000_000,
    reason: 'activate',
    extension: { name: 'editor-state-mcp', version: '0.1.0' },
    window: { id: 'abc12345', pid: 1234, focused: true, vscodeVersion: '1.104.0', heartbeatPath: null },
    workspace: { name: 'mock', workspaceFile: null, folders: ['/mock/root'] },
    activeEditor: null,
    selection: null,
    additionalSelections: [],
    cursor: null,
    lastDeliberateSelection: null,
    openTabs: [],
    recentFiles: [],
    truncation: { openTabsCapped: false, recentFilesCapped: false },
    ...overrides,
  };
}

export async function run(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-state-sink-test-'));

  await section('StateFileSink: writes a snapshot to the resolved path', async () => {
    const target = path.join(dir, 'basic', 'state.json');
    const sink = new StateFileSink({
      getEnabled: () => true,
      getConfiguredPath: () => 'state.json',
      getWorkspaceRoot: () => path.join(dir, 'basic'),
    });

    await sink.write(makeSnapshot());
    eq('currentPath resolves relative to workspace root', sink.currentPath(), target);
    eq('one write recorded', sink.writes, 1);

    const body = JSON.parse(await fs.readFile(target, 'utf8')) as Snapshot;
    eq('written body round-trips', body.window.id, 'abc12345');
  });

  await section('StateFileSink: skips a no-op write and leaves updatedAtMs stale (§8)', async () => {
    const root = path.join(dir, 'noop');
    const target = path.join(root, 'state.json');
    const sink = new StateFileSink({
      getEnabled: () => true,
      getConfiguredPath: () => 'state.json',
      getWorkspaceRoot: () => root,
    });

    await sink.write(makeSnapshot({ updatedAtMs: 1 }));
    const firstBody = await fs.readFile(target, 'utf8');
    eq('first write happened', sink.writes, 1);

    // Same content, later timestamp — must be treated as unchanged (contentKey excludes updatedAt*).
    await sink.write(makeSnapshot({ updatedAtMs: 2 }));
    const secondBody = await fs.readFile(target, 'utf8');
    eq('no-op write does not touch disk', secondBody, firstBody);
    eq('writes counter does not advance on a no-op', sink.writes, 1);

    // A real content change must still write through.
    await sink.write(makeSnapshot({ updatedAtMs: 3, cursor: { line: 1, column: 1 } }));
    eq('a genuinely different snapshot writes through', sink.writes, 2);
  });

  await section('StateFileSink: enabled=false never touches disk', async () => {
    const root = path.join(dir, 'disabled');
    const target = path.join(root, 'state.json');
    const sink = new StateFileSink({
      getEnabled: () => false,
      getConfiguredPath: () => 'state.json',
      getWorkspaceRoot: () => root,
    });

    await sink.write(makeSnapshot());
    eq('no writes recorded', sink.writes, 0);
    const exists = await fs
      .access(target)
      .then(() => true)
      .catch(() => false);
    eq('file was never created', exists, false);
  });

  await section('StateFileSink: no workspace root skips the write without throwing', async () => {
    const sink = new StateFileSink({
      getEnabled: () => true,
      getConfiguredPath: () => 'state.json',
      getWorkspaceRoot: () => undefined,
    });
    let threw = false;
    try {
      await sink.write(makeSnapshot());
    } catch {
      threw = true;
    }
    eq('write resolves rather than throwing', threw, false);
    eq('no writes recorded', sink.writes, 0);
  });

  await section('StateFileSink: an absolute configured path is used verbatim', async () => {
    const target = path.join(dir, 'absolute-target.json');
    const sink = new StateFileSink({
      getEnabled: () => true,
      getConfiguredPath: () => target,
      getWorkspaceRoot: () => path.join(dir, 'irrelevant-root'),
    });
    await sink.write(makeSnapshot());
    eq('currentPath is the absolute path, not root-joined', sink.currentPath(), target);
  });

  await section('StateFileSink: a mid-write request coalesces rather than interleaving', async () => {
    const root = path.join(dir, 'coalesce');
    const sink = new StateFileSink({
      getEnabled: () => true,
      getConfiguredPath: () => 'state.json',
      getWorkspaceRoot: () => root,
    });

    const first = sink.write(makeSnapshot({ updatedAtMs: 1 }));
    const second = sink.write(makeSnapshot({ updatedAtMs: 2, cursor: { line: 5, column: 5 } }));
    await Promise.all([first, second]);

    const target = path.join(root, 'state.json');
    const body = JSON.parse(await fs.readFile(target, 'utf8')) as Snapshot;
    eq('the coalesced follow-up is the one that lands', body.cursor, { line: 5, column: 5 });
  });

  await section('StateFileSink: a forced write failure is retried rather than left stale', async () => {
    const root = path.join(dir, 'retry');
    const target = path.join(root, 'state.json');
    // A directory at the target path forces every rename to fail (same trick as atomicWrite.test.ts).
    await fs.mkdir(target, { recursive: true });

    const sink = new StateFileSink({
      getEnabled: () => true,
      getConfiguredPath: () => 'state.json',
      getWorkspaceRoot: () => root,
    });

    await sink.write(makeSnapshot());
    check('the first attempt failed and was logged, not thrown', sink.lastError !== undefined, sink.lastError);
    eq('no successful write recorded yet', sink.writes, 0);

    // Clear the obstruction, then wait past the ~1s reschedule delay (§8).
    await fs.rmdir(target);
    await new Promise(resolve => setTimeout(resolve, 1_300));

    eq('the rescheduled retry eventually succeeded', sink.writes, 1);
    note('sink retry', `lastError after recovery: ${sink.lastError ?? 'none'}`);
  });

  await fs.rm(dir, { recursive: true, force: true });
}
