import { report } from './harness';
import { run as atomicWrite } from './atomicWrite.test';

// M1 adds snapshot.test.ts here — the §5.4 off-by-one table, carry-forward and
// truncation. It needs no vscode stub, because buildSnapshot is pure.
async function main(): Promise<void> {
  await atomicWrite();
  report();
}

main().catch(err => {
  console.error('test runner threw:', err);
  process.exit(1);
});
