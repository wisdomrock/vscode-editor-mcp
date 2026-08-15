import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { initLog } from '../../src/log';
import { McpHttpServer } from '../../src/server/httpServer';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

async function waitFor(cond: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25));
  }
}

async function main() {
  initLog();

  const server = new McpHttpServer({
    host: '127.0.0.1',
    port: 0,
    requireAuth: true,
    allowWrite: true,
    maxFileBytes: 1024 * 1024,
    version: '0.1.0-test',
  });

  const address = await server.start();
  check('binds an OS-assigned port', address.port > 0, `port ${address.port}`);
  check('issues a bearer token', !!address.token && address.token.length > 20);

  // --- unauthenticated request must be rejected -------------------------------
  const noAuth = await fetch(address.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  check('rejects request without token', noAuth.status === 401, `got ${noAuth.status}`);

  // --- browser-style Origin must be rejected ----------------------------------
  const badOrigin = await fetch(address.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${address.token}`,
      origin: 'https://evil.example.com',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  check('rejects foreign Origin (DNS rebinding)', badOrigin.status === 403, `got ${badOrigin.status}`);

  // --- health probe is open but says nothing sensitive ------------------------
  const health = await fetch(`http://127.0.0.1:${address.port}/health`);
  const healthBody = (await health.json()) as Record<string, unknown>;
  check('health probe responds', health.status === 200 && healthBody.server === 'vscode-editor-mcp');
  check('health probe leaks no token', !JSON.stringify(healthBody).includes(address.token ?? '@@'));

  // --- real MCP client handshake ----------------------------------------------
  const client = new Client({ name: 'smoke-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(address.url), {
    requestInit: { headers: { authorization: `Bearer ${address.token}` } },
  });
  await client.connect(transport);
  check('MCP handshake completes', true);
  check('server tracks the session', server.sessionCount === 1, `count ${server.sessionCount}`);

  const { tools } = await client.listTools();
  const names = tools.map(t => t.name).sort();
  console.log(`      tools: ${names.join(', ')}`);

  const expected = [
    'close_file', 'create_file', 'edit_file', 'get_active_file', 'get_diagnostics',
    'get_open_tabs', 'get_selection', 'get_workspace_folders', 'open_file', 'save_file',
  ];
  check('all 10 tools registered', JSON.stringify(names) === JSON.stringify(expected));
  check('schemas carry descriptions', tools.every(t => (t.description ?? '').length > 20));

  const diag = tools.find(t => t.name === 'get_diagnostics')!;
  check('input schema converted to JSON Schema', diag.inputSchema?.type === 'object' && !!(diag.inputSchema as any).properties?.severity);

  // --- a tool that runs entirely off the mocked API ---------------------------
  const folders = await client.callTool({ name: 'get_workspace_folders', arguments: {} });
  const payload = JSON.parse((folders.content as any)[0].text);
  check('get_workspace_folders returns live state', payload.name === 'mock-workspace' && payload.folders.length === 1);

  const diagResult = await client.callTool({ name: 'get_diagnostics', arguments: { severity: 'error' } });
  check('get_diagnostics runs', JSON.parse((diagResult.content as any)[0].text).total === 0);

  // --- errors come back as tool errors, not transport failures ----------------
  const noEditor = await client.callTool({ name: 'get_selection', arguments: {} });
  check('missing editor is a tool error, not a crash', noEditor.isError === true);

  // --- write tools disappear when writes are disabled -------------------------
  // close() alone does NOT tell the server anything — only terminateSession()
  // sends the DELETE. Both paths are checked because real clients use both.
  await transport.terminateSession();
  await waitFor(() => server.sessionCount === 0, 2000);
  check('terminateSession() drops the server session', server.sessionCount === 0, `count ${server.sessionCount}`);
  await client.close();
  await server.stop();

  // --- abandoned sessions get reaped ------------------------------------------
  const reap = new McpHttpServer({
    host: '127.0.0.1', port: 0, requireAuth: false, allowWrite: false,
    maxFileBytes: 1024, version: '0.1.0-test', sessionIdleMs: 500,
  });
  const reapAddr = await reap.start();
  const ghost = new Client({ name: 'smoke-ghost', version: '1.0.0' });
  await ghost.connect(new StreamableHTTPClientTransport(new URL(reapAddr.url)));
  check('ghost session registered', reap.sessionCount === 1);
  await ghost.close(); // walks away without terminating, like a crashed client
  await waitFor(() => reap.sessionCount === 0, 5000);
  check('idle session reaped', reap.sessionCount === 0, `count ${reap.sessionCount}`);
  await reap.stop();

  const ro = new McpHttpServer({
    host: '127.0.0.1', port: 0, requireAuth: false, allowWrite: false,
    maxFileBytes: 1024, version: '0.1.0-test',
  });
  const roAddr = await ro.start();
  const roClient = new Client({ name: 'smoke-ro', version: '1.0.0' });
  await roClient.connect(new StreamableHTTPClientTransport(new URL(roAddr.url)));
  const roTools = (await roClient.listTools()).tools.map(t => t.name);
  check('allowWrite:false hides all mutating tools',
    !roTools.some(n => ['create_file', 'edit_file', 'save_file', 'close_file', 'open_file'].includes(n)),
    `${roTools.length} tools`);
  check('read tools still present', roTools.includes('get_active_file'));
  await roClient.close();
  await ro.stop();

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('smoke test threw:', err);
  process.exit(1);
});
