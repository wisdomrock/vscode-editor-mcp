import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HeartbeatWriter, pruneDeadHeartbeats, type HeartbeatPayload } from '../../src/state/heartbeat';
import { eq, section } from './harness';

// HEARTBEAT_DIR is fixed at ~/.editor-state-mcp/heartbeat (config.ts) — HeartbeatWriter
// doesn't take a directory override, so these tests exercise it there directly rather
// than against a temp dir, and clean up only the files they themselves create.
const HEARTBEAT_DIR = path.join(os.homedir(), '.editor-state-mcp', 'heartbeat');

export async function run(): Promise<void> {
  await section('HeartbeatWriter: ticks on an interval and writes a well-formed payload', async () => {
    const writer = new HeartbeatWriter('abc12345', () => 50, () => true, () => '/mock/state.json');
    writer.sync();
    await new Promise(resolve => setTimeout(resolve, 120));

    const body = JSON.parse(await fs.readFile(writer.path(), 'utf8')) as HeartbeatPayload;
    eq('windowId', body.windowId, 'abc12345');
    eq('pid', body.pid, process.pid);
    eq('statePath', body.statePath, '/mock/state.json');

    await writer.dispose();
    const exists = await fs
      .access(writer.path())
      .then(() => true)
      .catch(() => false);
    eq('dispose removes the file', exists, false);
  });

  await section('HeartbeatWriter: sync() with enabled=false never writes and removes an existing file', async () => {
    const enabledFlag = { on: true };
    const writer = new HeartbeatWriter('def67890', () => 50, () => enabledFlag.on, () => undefined);
    writer.sync();
    await new Promise(resolve => setTimeout(resolve, 80));
    const wroteWhileEnabled = await fs
      .access(writer.path())
      .then(() => true)
      .catch(() => false);
    eq('wrote at least once while enabled', wroteWhileEnabled, true);

    enabledFlag.on = false;
    writer.sync(); // removal is fire-and-forget internally, so give it a tick
    await new Promise(resolve => setTimeout(resolve, 20));
    const removedOnDisable = await fs
      .access(writer.path())
      .then(() => false)
      .catch(() => true);
    eq('sync() removes the file once disabled', removedOnDisable, true);

    await new Promise(resolve => setTimeout(resolve, 80));
    const stillGone = await fs
      .access(writer.path())
      .then(() => false)
      .catch(() => true);
    eq('no further writes land while disabled', stillGone, true);

    await writer.dispose();
  });

  await section('HeartbeatWriter: heartbeatMs <= 0 disables ticking entirely', async () => {
    const writer = new HeartbeatWriter('ghi11111', () => 0, () => true, () => undefined);
    writer.sync();
    await new Promise(resolve => setTimeout(resolve, 80));
    const exists = await fs
      .access(writer.path())
      .then(() => true)
      .catch(() => false);
    eq('never wrote', exists, false);
    await writer.dispose();
  });

  await section('pruneDeadHeartbeats: removes files for dead pids, keeps files for live ones', async () => {
    await fs.mkdir(HEARTBEAT_DIR, { recursive: true });
    const deadPid = 2 ** 30; // same "impossible pid" convention as atomicWrite.test.ts
    const deadFile = path.join(HEARTBEAT_DIR, `${deadPid}.json`);
    const liveFile = path.join(HEARTBEAT_DIR, `${process.pid}.json`);
    await fs.writeFile(deadFile, JSON.stringify({ pid: deadPid }));
    await fs.writeFile(liveFile, JSON.stringify({ pid: process.pid }));

    await pruneDeadHeartbeats();

    const deadGone = await fs
      .access(deadFile)
      .then(() => false)
      .catch(() => true);
    const liveRemains = await fs
      .access(liveFile)
      .then(() => true)
      .catch(() => false);
    eq('dead pid file pruned', deadGone, true);
    eq('live pid file kept', liveRemains, true);

    await fs.unlink(liveFile).catch(() => {});
  });
}
