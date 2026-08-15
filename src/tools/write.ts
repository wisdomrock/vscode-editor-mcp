import * as vscode from 'vscode';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context';
import { POSITION_NOTE, describeUri, exists, fail, guard, ok, resolveUri, toPosition } from './shared';

/**
 * Every mutation goes through WorkspaceEdit rather than writing bytes directly.
 * That puts the change on the editor's undo stack and leaves the buffer dirty,
 * so a user can see and revert whatever an agent did before it hits disk.
 */
export function registerWriteTools(server: McpServer, _ctx: ToolContext): void {
  server.registerTool(
    'create_file',
    {
      title: 'Create file',
      description:
        'Create a new file with the given content. Fails if the file exists unless overwrite is true. ' +
        'Parent directories are created as needed. The file is left open and unsaved unless save is true.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        path: z.string().describe('Absolute or workspace-relative path for the new file.'),
        content: z.string().describe('Full content of the new file.'),
        overwrite: z.boolean().optional().describe('Replace the file if it already exists. Default false.'),
        save: z.boolean().optional().describe('Write to disk immediately. Default false.'),
        open: z.boolean().optional().describe('Reveal the file in an editor. Default true.'),
      },
    },
    guard('create_file', async ({ path: filePath, content, overwrite = false, save = false, open = true }) => {
      const uri = await resolveUri(filePath);
      const already = await exists(uri);
      if (already && !overwrite) {
        return fail(`file already exists: ${uri.fsPath}`, { hint: 'pass overwrite:true, or use edit_file' });
      }

      const edit = new vscode.WorkspaceEdit();
      edit.createFile(uri, { overwrite, ignoreIfExists: false });
      if (content) edit.insert(uri, new vscode.Position(0, 0), content);

      if (!(await vscode.workspace.applyEdit(edit))) {
        return fail(`could not create ${uri.fsPath}; the edit was rejected by the editor`);
      }

      const doc = await vscode.workspace.openTextDocument(uri);
      if (save) await doc.save();
      if (open) await vscode.window.showTextDocument(doc, { preview: false });

      return ok({ ...describeUri(uri), created: true, overwritten: already, saved: save, lineCount: doc.lineCount });
    }),
  );

  server.registerTool(
    'edit_file',
    {
      title: 'Edit file',
      description:
        'Modify a file using one of four modes. "replace_text" finds an exact string and replaces it (preferred: ' +
        'no line arithmetic). "replace_range" replaces a line/column range. "insert" inserts at a position. ' +
        `"overwrite" replaces the whole file. Changes land on the undo stack. ${POSITION_NOTE}`,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        path: z.string().describe('Absolute or workspace-relative file path.'),
        mode: z.enum(['replace_text', 'replace_range', 'insert', 'overwrite']),
        text: z.string().optional().describe('Replacement or inserted text. Required for every mode except replace_text, which uses replaceWith.'),
        find: z.string().optional().describe('replace_text: the exact string to find.'),
        replaceWith: z.string().optional().describe('replace_text: the string to substitute.'),
        replaceAll: z.boolean().optional().describe('replace_text: replace every occurrence. Default false, which errors if find is not unique.'),
        startLine: z.number().int().min(1).optional().describe('replace_range: first line, inclusive.'),
        startColumn: z.number().int().min(1).optional().describe('replace_range: column on startLine. Default 1.'),
        endLine: z.number().int().min(1).optional().describe('replace_range: last line, inclusive.'),
        endColumn: z.number().int().min(1).optional().describe('replace_range: column on endLine. Default end of line.'),
        line: z.number().int().min(1).optional().describe('insert: line to insert at.'),
        column: z.number().int().min(1).optional().describe('insert: column to insert at. Default 1.'),
        save: z.boolean().optional().describe('Write to disk after editing. Default false.'),
      },
    },
    guard('edit_file', async args => {
      const uri = await resolveUri(args.path);
      if (!(await exists(uri))) {
        return fail(`file not found: ${uri.fsPath}`, { hint: 'use create_file for new files' });
      }

      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      let occurrences = 1;

      switch (args.mode) {
        case 'overwrite': {
          if (args.text === undefined) return fail('mode "overwrite" requires text');
          const whole = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
          edit.replace(uri, whole, args.text);
          break;
        }

        case 'insert': {
          if (args.text === undefined) return fail('mode "insert" requires text');
          if (args.line === undefined) return fail('mode "insert" requires line');
          if (args.line > doc.lineCount) {
            return fail(`line ${args.line} is past the end of the file (${doc.lineCount} lines)`);
          }
          edit.insert(uri, doc.validatePosition(toPosition(args.line, args.column ?? 1)), args.text);
          break;
        }

        case 'replace_range': {
          if (args.text === undefined) return fail('mode "replace_range" requires text');
          if (args.startLine === undefined || args.endLine === undefined) {
            return fail('mode "replace_range" requires startLine and endLine');
          }
          if (args.endLine < args.startLine) return fail('endLine must be >= startLine');
          if (args.endLine > doc.lineCount) {
            return fail(`endLine ${args.endLine} is past the end of the file (${doc.lineCount} lines)`);
          }
          const start = toPosition(args.startLine, args.startColumn ?? 1);
          const end =
            args.endColumn === undefined
              ? doc.lineAt(args.endLine - 1).range.end
              : toPosition(args.endLine, args.endColumn);
          edit.replace(uri, doc.validateRange(new vscode.Range(start, end)), args.text);
          break;
        }

        case 'replace_text': {
          if (!args.find) return fail('mode "replace_text" requires find');
          if (args.replaceWith === undefined) return fail('mode "replace_text" requires replaceWith');

          const haystack = doc.getText();
          const offsets = findAll(haystack, args.find);
          if (offsets.length === 0) return fail(`find string not present in ${uri.fsPath}`);
          if (offsets.length > 1 && !args.replaceAll) {
            return fail(`find string occurs ${offsets.length} times; pass replaceAll:true or include more context`, {
              occurrences: offsets.length,
              lines: offsets.map(o => doc.positionAt(o).line + 1),
            });
          }

          occurrences = args.replaceAll ? offsets.length : 1;
          // Apply back-to-front so earlier offsets stay valid.
          for (const offset of offsets.slice(0, occurrences).reverse()) {
            const range = new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + args.find.length));
            edit.replace(uri, range, args.replaceWith);
          }
          break;
        }
      }

      if (!(await vscode.workspace.applyEdit(edit))) {
        return fail(`edit rejected by the editor for ${uri.fsPath}`);
      }
      if (args.save) await doc.save();

      return ok({
        ...describeUri(uri),
        mode: args.mode,
        occurrences,
        saved: args.save === true,
        isDirty: doc.isDirty,
        lineCount: doc.lineCount,
      });
    }),
  );

  server.registerTool(
    'open_file',
    {
      title: 'Open file',
      description:
        'Open a file in the editor and optionally scroll to and select a line range. Use this to show the user ' +
        `what you are talking about. ${POSITION_NOTE}`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        path: z.string().describe('Absolute or workspace-relative file path.'),
        startLine: z.number().int().min(1).optional().describe('Line to reveal and select from.'),
        endLine: z.number().int().min(1).optional().describe('Last line to select. Defaults to startLine.'),
        preview: z.boolean().optional().describe('Open as a preview (italic) tab. Default false.'),
        viewColumn: z.number().int().min(1).max(9).optional().describe('Editor group to open in. Default active.'),
        preserveFocus: z.boolean().optional().describe('Do not steal focus from the user. Default false.'),
      },
    },
    guard('open_file', async ({ path: filePath, startLine, endLine, preview = false, viewColumn, preserveFocus = false }) => {
      const uri = await resolveUri(filePath);
      if (!(await exists(uri))) return fail(`file not found: ${uri.fsPath}`);

      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview, preserveFocus, viewColumn });

      if (startLine !== undefined) {
        const last = Math.min(endLine ?? startLine, doc.lineCount);
        const range = doc.validateRange(new vscode.Range(toPosition(startLine, 1), doc.lineAt(last - 1).range.end));
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }

      return ok({ ...describeUri(uri), languageId: doc.languageId, lineCount: doc.lineCount, viewColumn: editor.viewColumn ?? null });
    }),
  );

  server.registerTool(
    'save_file',
    {
      title: 'Save file',
      description: 'Write a file\'s unsaved buffer to disk. Omit path to save the active file. Formatters and save actions run as usual.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        path: z.string().optional().describe('Absolute or workspace-relative path. Omit for the active file.'),
        all: z.boolean().optional().describe('Save every dirty editor instead. Default false.'),
      },
    },
    guard('save_file', async ({ path: filePath, all = false }) => {
      if (all) {
        const saved = await vscode.workspace.saveAll(false);
        return ok({ savedAll: saved });
      }

      const doc = filePath
        ? await vscode.workspace.openTextDocument(await resolveUri(filePath))
        : vscode.window.activeTextEditor?.document;
      if (!doc) return fail('no path given and no active text editor');

      const saved = await doc.save();
      return ok({ ...describeUri(doc.uri), saved, isDirty: doc.isDirty });
    }),
  );

  server.registerTool(
    'close_file',
    {
      title: 'Close file',
      description:
        'Close every tab showing a file. Refuses to close a tab with unsaved changes unless save or discard is set, ' +
        'so an agent cannot silently drop the user\'s work.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        path: z.string().describe('Absolute or workspace-relative file path.'),
        save: z.boolean().optional().describe('Save before closing if dirty. Default false.'),
        discard: z.boolean().optional().describe('Close even if dirty, losing changes. Default false.'),
      },
    },
    guard('close_file', async ({ path: filePath, save = false, discard = false }) => {
      const uri = await resolveUri(filePath);
      const key = uri.toString();

      const tabs = vscode.window.tabGroups.all
        .flatMap(g => g.tabs)
        .filter(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key);

      if (tabs.length === 0) return ok({ ...describeUri(uri), closed: 0, note: 'file was not open' });

      if (tabs.some(t => t.isDirty) && !save && !discard) {
        return fail(`${uri.fsPath} has unsaved changes`, { hint: 'pass save:true to save first, or discard:true to lose them' });
      }
      if (save) await (await vscode.workspace.openTextDocument(uri)).save();

      await vscode.window.tabGroups.close(tabs, true);
      return ok({ ...describeUri(uri), closed: tabs.length, saved: save });
    }),
  );
}

function findAll(haystack: string, needle: string): number[] {
  const offsets: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
    offsets.push(i);
  }
  return offsets;
}
