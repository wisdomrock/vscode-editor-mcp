/**
 * Minimal `vscode` stand-in — just enough to boot McpHttpServer and exercise the
 * MCP handshake, auth gate and tool registration outside an extension host.
 * NOT a fidelity mock: document-heavy tools are not covered here.
 */

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (l: Listener<T>) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter(x => x !== l)) };
  };
  fire(e: T) {
    for (const l of this.listeners) l(e);
  }
  dispose() {
    this.listeners = [];
  }
}

export class Uri {
  private constructor(readonly scheme: string, readonly fsPath: string) {}
  static file(p: string) {
    return new Uri('file', p);
  }
  static parse(s: string) {
    return new Uri(s.split(':')[0], s);
  }
  static joinPath(base: Uri, ...parts: string[]) {
    return new Uri(base.scheme, [base.fsPath, ...parts].join('/'));
  }
  toString() {
    return `${this.scheme}://${this.fsPath.replace(/\\/g, '/')}`;
  }
}

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}
export class Range {
  constructor(readonly start: Position, readonly end: Position) {}
  get isEmpty() {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}
export class Selection extends Range {}
export class Disposable {
  constructor(private fn: () => void = () => {}) {}
  static from(...d: { dispose(): unknown }[]) {
    return new Disposable(() => d.forEach(x => x.dispose()));
  }
  dispose() {
    this.fn();
  }
}
export class WorkspaceEdit {
  createFile() {}
  insert() {}
  replace() {}
}
export class MarkdownString {
  appendMarkdown() {}
}
export class ThemeColor {
  constructor(readonly id: string) {}
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;
export const EndOfLine = { LF: 1, CRLF: 2 } as const;
export const TextEditorRevealType = { InCenterIfOutsideViewport: 2 } as const;
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;

export class TabInputText {
  constructor(readonly uri: Uri) {}
}
export class TabInputTextDiff {
  constructor(readonly original: Uri, readonly modified: Uri) {}
}
export class TabInputNotebook {
  constructor(readonly uri: Uri) {}
}
export class TabInputCustom {
  constructor(readonly uri: Uri) {}
}

const noopChannel = {
  info: (...a: unknown[]) => console.log('[ext]', ...a),
  warn: (...a: unknown[]) => console.warn('[ext]', ...a),
  error: (...a: unknown[]) => console.error('[ext]', ...a),
  debug: () => {},
  show: () => {},
  dispose: () => {},
};

export const version = '1.104.0-mock';

export const workspace = {
  name: 'mock-workspace',
  workspaceFile: undefined,
  workspaceFolders: [{ name: 'root', index: 0, uri: Uri.file('d:/mock/root') }],
  asRelativePath: (u: Uri | string) => (typeof u === 'string' ? u : u.fsPath.replace('d:/mock/root/', '')),
  getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
  fs: { stat: async () => ({ size: 0 }) },
  openTextDocument: async () => {
    throw new Error('not implemented in mock');
  },
  applyEdit: async () => true,
  saveAll: async () => true,
};

export const window = {
  activeTextEditor: undefined as unknown,
  tabGroups: { all: [], activeTabGroup: { activeTab: undefined }, close: async () => true },
  createOutputChannel: () => noopChannel,
  createStatusBarItem: () => ({ show() {}, dispose() {} }),
  showTextDocument: async () => {
    throw new Error('not implemented in mock');
  },
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
};

export const languages = { getDiagnostics: () => [] as unknown[] };
export const lm = { registerMcpServerDefinitionProvider: () => new Disposable() };
export const commands = { registerCommand: () => new Disposable(), executeCommand: async () => undefined };
export const env = { clipboard: { writeText: async () => {} } };
