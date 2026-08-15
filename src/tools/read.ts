import * as vscode from 'vscode';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context';
import {
  POSITION_NOTE,
  describeUri,
  fail,
  fromRange,
  guard,
  ok,
  resolveUri,
  severityName,
  sliceDocument,
} from './shared';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_active_file',
    {
      title: 'Get active file',
      description:
        'Return the file currently focused in the editor: its path, language, dirty state and content. ' +
        `Pass startLine/endLine to read a window instead of the whole file. ${POSITION_NOTE}`,
      annotations: READ_ONLY,
      inputSchema: {
        includeContent: z.boolean().optional().describe('Include file content. Default true.'),
        startLine: z.number().int().min(1).optional().describe('First line to return, 1-based inclusive.'),
        endLine: z.number().int().min(1).optional().describe('Last line to return, 1-based inclusive.'),
      },
    },
    guard('get_active_file', async ({ includeContent = true, startLine, endLine }) => {
      const doc = await activeDocument();
      if (!doc) return fail('no active file; the focused editor is not a text editor');

      const editor = vscode.window.activeTextEditor;
      return ok({
        ...describeUri(doc.uri),
        languageId: doc.languageId,
        lineCount: doc.lineCount,
        isDirty: doc.isDirty,
        isUntitled: doc.isUntitled,
        encoding: doc.eol === vscode.EndOfLine.CRLF ? 'crlf' : 'lf',
        cursor: editor?.document === doc ? fromRange(editor.selection).start : null,
        ...(includeContent ? sliceDocument(doc, { startLine, endLine, maxBytes: ctx.maxFileBytes }) : {}),
      });
    }),
  );

  server.registerTool(
    'get_selection',
    {
      title: 'Get selection',
      description:
        'Return the text selected in the active editor, including every cursor when there is a multi-cursor ' +
        `selection. Returns an empty selections array when nothing is selected. ${POSITION_NOTE}`,
      annotations: READ_ONLY,
      inputSchema: {},
    },
    guard('get_selection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return fail('no active text editor');

      const selections = editor.selections
        .filter(s => !s.isEmpty)
        .map(s => ({
          ...fromRange(s),
          text: editor.document.getText(s),
          lineCount: s.end.line - s.start.line + 1,
        }));

      return ok({
        ...describeUri(editor.document.uri),
        languageId: editor.document.languageId,
        selections,
        // Reported separately because an empty selection still tells the agent where the user is.
        cursor: fromRange(editor.selection).start,
      });
    }),
  );

  server.registerTool(
    'get_open_tabs',
    {
      title: 'Get open tabs',
      description:
        'List every open tab across all editor groups, in tab order, flagging which is active and which have ' +
        'unsaved changes. Includes non-text tabs (diffs, notebooks, previews) with their kind.',
      annotations: READ_ONLY,
      inputSchema: {
        textOnly: z.boolean().optional().describe('Only return plain text file tabs. Default false.'),
      },
    },
    guard('get_open_tabs', async ({ textOnly = false }) => {
      const groups = vscode.window.tabGroups.all.map(group => ({
        groupId: group.viewColumn,
        isActive: group.isActive,
        tabs: group.tabs
          .map(tab => describeTab(tab))
          .filter(t => !textOnly || t.kind === 'text'),
      }));

      return ok({
        groups,
        totalTabs: groups.reduce((n, g) => n + g.tabs.length, 0),
      });
    }),
  );

  server.registerTool(
    'get_workspace_folders',
    {
      title: 'Get workspace folders',
      description: 'List the root folders open in this window, plus the workspace name and file.',
      annotations: READ_ONLY,
      inputSchema: {},
    },
    guard('get_workspace_folders', async () =>
      ok({
        name: vscode.workspace.name ?? null,
        workspaceFile: vscode.workspace.workspaceFile?.fsPath ?? null,
        folders: (vscode.workspace.workspaceFolders ?? []).map(f => ({
          name: f.name,
          index: f.index,
          ...describeUri(f.uri),
        })),
      }),
    ),
  );

  server.registerTool(
    'get_diagnostics',
    {
      title: 'Get diagnostics',
      description:
        'Return language-server diagnostics (errors, warnings, hints) for one file or for the whole workspace. ' +
        'These come from the same analysis that drives the Problems panel, so they reflect real type and lint ' +
        `state rather than a fresh compile. ${POSITION_NOTE}`,
      annotations: READ_ONLY,
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe('Absolute or workspace-relative file path. Omit to get diagnostics for every file.'),
        severity: z
          .enum(['error', 'warning', 'information', 'hint'])
          .optional()
          .describe('Minimum severity to include. Default "hint" (everything).'),
        limit: z.number().int().min(1).max(2000).optional().describe('Max diagnostics to return. Default 200.'),
      },
    },
    guard('get_diagnostics', async ({ path: filePath, severity = 'hint', limit = 200 }) => {
      const threshold = { error: 0, warning: 1, information: 2, hint: 3 }[severity];

      const entries: [vscode.Uri, vscode.Diagnostic[]][] = filePath
        ? [[await resolveUri(filePath), vscode.languages.getDiagnostics(await resolveUri(filePath))]]
        : vscode.languages.getDiagnostics();

      const flat = entries.flatMap(([uri, diags]) =>
        diags
          // DiagnosticSeverity is ordered Error=0 .. Hint=3, so "at least as severe" is <=.
          .filter(d => d.severity <= threshold)
          .map(d => ({
            ...describeUri(uri),
            severity: severityName(d.severity),
            message: d.message,
            source: d.source ?? null,
            code: typeof d.code === 'object' ? d.code.value : (d.code ?? null),
            ...fromRange(d.range),
          })),
      );

      flat.sort((a, b) => a.path.localeCompare(b.path) || a.start.line - b.start.line);

      return ok({
        total: flat.length,
        returned: Math.min(flat.length, limit),
        counts: {
          error: flat.filter(d => d.severity === 'error').length,
          warning: flat.filter(d => d.severity === 'warning').length,
        },
        diagnostics: flat.slice(0, limit),
      });
    }),
  );
}

/** The focused text editor, falling back to the active tab when focus is elsewhere (e.g. a webview). */
async function activeDocument(): Promise<vscode.TextDocument | undefined> {
  if (vscode.window.activeTextEditor) return vscode.window.activeTextEditor.document;

  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (tab?.input instanceof vscode.TabInputText) {
    return vscode.workspace.openTextDocument(tab.input.uri);
  }
  return undefined;
}

function describeTab(tab: vscode.Tab) {
  const base = { label: tab.label, isActive: tab.isActive, isDirty: tab.isDirty, isPinned: tab.isPinned };
  const input = tab.input;

  if (input instanceof vscode.TabInputText) {
    return { ...base, kind: 'text' as const, ...describeUri(input.uri) };
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return { ...base, kind: 'diff' as const, ...describeUri(input.modified), originalPath: input.original.fsPath };
  }
  if (input instanceof vscode.TabInputNotebook) {
    return { ...base, kind: 'notebook' as const, ...describeUri(input.uri) };
  }
  if (input instanceof vscode.TabInputCustom) {
    return { ...base, kind: 'custom' as const, ...describeUri(input.uri) };
  }
  return { ...base, kind: 'other' as const, path: null, relativePath: null, scheme: null };
}
