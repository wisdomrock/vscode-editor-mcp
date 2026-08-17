// Bundles the test suite with `vscode` aliased to a stub, so modules that touch
// the extension API can be exercised outside an extension host. The pure layers
// (atomicWrite, and buildSnapshot from M1) need no stub at all.
const path = require('node:path');
const esbuild = require('esbuild');

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'index.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: path.join(__dirname, '..', '..', 'dist-test', 'tests.js'),
    alias: { vscode: path.join(__dirname, 'mockVscode.ts') },
    logLevel: 'info',
  })
  .catch(() => process.exit(1));
