import { report } from './harness';
import { run as atomicWrite } from './atomicWrite.test';
import { run as snapshot } from './snapshot.test';
import { run as sink } from './sink.test';
import { run as collect } from './collect.test';
import { run as heartbeat } from './heartbeat.test';
import { run as exclude } from './exclude.test';
import { run as gitignore } from './gitignore.test';

async function main(): Promise<void> {
  await atomicWrite();
  snapshot();
  await sink();
  await collect();
  await heartbeat();
  exclude();
  await gitignore();
  report();
}

main().catch(err => {
  console.error('test runner threw:', err);
  process.exit(1);
});
