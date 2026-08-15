import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../tools/context';
import { registerReadTools } from '../tools/read';
import { registerWriteTools } from '../tools/write';

export const SERVER_NAME = 'vscode-editor-mcp';

const INSTRUCTIONS = [
  'These tools read and modify the live state of a running VS Code window: the editor buffers the user is',
  'actually looking at, including unsaved changes. Prefer them over reading files from disk when you need to',
  'know what the user currently sees or has selected.',
  '',
  'Conventions:',
  '- Lines and columns are 1-based everywhere.',
  '- Paths may be absolute or workspace-relative; relative paths resolve against the open workspace folders.',
  '- Edits are applied to the editor buffer and land on the undo stack. They are NOT written to disk unless you',
  '  pass save:true or call save_file, which lets the user review changes first.',
  '- get_diagnostics reflects the language server, so it reports real type errors without running a build.',
].join('\n');

export function createMcpServer(ctx: ToolContext, version: string): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version, title: 'VS Code Editor' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  registerReadTools(server, ctx);
  // Not registered at all when writes are off, so the tool list itself reflects the policy.
  if (ctx.allowWrite) registerWriteTools(server, ctx);

  return server;
}
