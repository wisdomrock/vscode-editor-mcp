import { report } from './harness';
import { run as atomicWrite } from './atomicWrite.test';
import { run as snapshot } from './snapshot.test';
import { run as sink } from './sink.test';

async function main(): Promise<void> {
  await atomicWrite();
  snapshot();
  await sink();
  report();
}

main().catch(err => {
  console.error('test runner threw:', err);
  process.exit(1);
});
