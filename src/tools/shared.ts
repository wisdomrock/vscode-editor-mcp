import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Positions crossing the MCP boundary are 1-based for both line and column,
 * matching what agents see from grep, compilers and stack traces. The VS Code
 * API is 0-based on both axes, so every conversion goes through the helpers
 * here rather than being open-coded at call sites.
 */
export const POSITION_NOTE = 'Lines and columns are 1-based.';

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function fail(message: string, details?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, ...details }, null, 2) }],
    isError: true,
  };
}

/** Wraps a handler so an unexpected throw becomes a readable tool error, not a transport error. */
export function guard<A extends unknown[]>(
  name: string,
  fn: (...args: A) => Promise<ToolResult>,
): (...args: A) => Promise<ToolResult> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(`${name} failed: ${message}`);
    }
  };
}

export function toPosition(line: number, column = 1): vscode.Position {
  return new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
}

export function fromPosition(p: vscode.Position): { line: number; column: number } {
  return { line: p.line + 1, column: p.character + 1 };
}

export function fromRange(r: vscode.Range) {
  return { start: fromPosition(r.start), end: fromPosition(r.end) };
}

/**
 * Accepts an absolute path or a workspace-relative one. Relative paths resolve
 * against the first workspace folder that actually contains the file, falling
 * back to the first folder so that `create_file` on a new path still works.
 */
export async function resolveUri(input: string): Promise<vscode.Uri> {
  const raw = input.trim();
  if (!raw) throw new Error('path must not be empty');

  if (raw.startsWith('untitled:')) return vscode.Uri.parse(raw);
  if (path.isAbsolute(raw)) return vscode.Uri.file(raw);

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    throw new Error(`'${raw}' is relative but no folder is open; pass an absolute path`);
  }

  for (const folder of folders) {
    const candidate = vscode.Uri.joinPath(folder.uri, raw);
    if (await exists(candidate)) return candidate;
  }
  return vscode.Uri.joinPath(folders[0].uri, raw);
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export function describeUri(uri: vscode.Uri) {
  const relative = vscode.workspace.asRelativePath(uri, false);
  return {
    path: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
    relativePath: relative === uri.fsPath ? null : relative,
    scheme: uri.scheme,
  };
}

export interface ContentWindow {
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

/**
 * Slices a document to the requested 1-based inclusive line range, or the whole
 * document when no range is given. Oversized documents are refused rather than
 * silently clipped so the caller knows to ask for a range.
 */
export function sliceDocument(
  doc: vscode.TextDocument,
  opts: { startLine?: number; endLine?: number; maxBytes: number },
): ContentWindow {
  const totalLines = doc.lineCount;
  const hasRange = opts.startLine !== undefined || opts.endLine !== undefined;

  const start = Math.min(Math.max(1, opts.startLine ?? 1), totalLines);
  const end = Math.min(Math.max(start, opts.endLine ?? totalLines), totalLines);

  const range = hasRange
    ? new vscode.Range(toPosition(start, 1), doc.lineAt(end - 1).range.end)
    : new vscode.Range(new vscode.Position(0, 0), doc.lineAt(Math.max(0, totalLines - 1)).range.end);

  let text = doc.getText(range);
  let truncated = false;

  if (Buffer.byteLength(text, 'utf8') > opts.maxBytes) {
    if (hasRange) {
      // The caller asked for this range explicitly, so clip rather than refuse.
      text = Buffer.from(text, 'utf8').subarray(0, opts.maxBytes).toString('utf8');
      truncated = true;
    } else {
      throw new Error(
        `file is larger than the ${opts.maxBytes} byte limit (${totalLines} lines); ` +
          `re-request with startLine/endLine, or raise vscodeEditorMcp.maxFileBytes`,
      );
    }
  }

  return { text, startLine: hasRange ? start : 1, endLine: hasRange ? end : totalLines, totalLines, truncated };
}

export function severityName(s: vscode.DiagnosticSeverity): 'error' | 'warning' | 'information' | 'hint' {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'information';
    default:
      return 'hint';
  }
}
