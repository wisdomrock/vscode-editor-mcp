// Bundles the smoke test with the `vscode` module aliased to a stub, so the
// server/transport layer can be exercised without an extension host.
const path = require('node:path');
const esbuild = require('esbuild');

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'smoke.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: path.join(__dirname, '..', '..', 'dist-test', 'smoke.js'),
    alias: { vscode: path.join(__dirname, 'mockVscode.ts') },
    logLevel: 'info',
  })
  .catch(() => process.exit(1));
