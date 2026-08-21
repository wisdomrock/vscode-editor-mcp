/**
 * Minimal `vscode` stand-in for running extension modules outside a host.
 * NOT a fidelity mock — it covers the surface the state layer touches and
 * nothing more.
 *
 * The correctness-critical code (buildSnapshot, atomicWrite) is deliberately
 * vscode-free, so most tests never reach this file.
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

function stubEvent<T>() {
  const emitter = new EventEmitter<T>();
  const fn = (l: Listener<T>) => emitter.event(l);
  fn.fire = (e: T) => emitter.fire(e);
  return fn;
}

export class Uri {
  private constructor(readonly scheme: string, readonly fsPath: string) {}
  get path() {
    return this.fsPath.replace(/\\/g, '/');
  }
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

export class MarkdownString {
  value = '';
  constructor(_v?: string, _supportThemeIcons?: boolean) {}
  appendMarkdown(md: string) {
    this.value += md;
    return this;
  }
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export const EndOfLine = { LF: 1, CRLF: 2 } as const;
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const TextEditorSelectionChangeKind = { Keyboard: 1, Mouse: 2, Command: 3 } as const;

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
  workspaceFile: undefined as Uri | undefined,
  workspaceFolders: [{ name: 'root', index: 0, uri: Uri.file('d:/mock/root') }] as
    | { name: string; index: number; uri: Uri }[]
    | undefined,
  asRelativePath: (u: Uri | string) => (typeof u === 'string' ? u : u.fsPath.replace('d:/mock/root/', '')),
  getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
  fs: { stat: async () => ({ size: 0 }) },
  openTextDocument: async (_arg?: unknown): Promise<unknown> => {
    throw new Error('not implemented in mock');
  },
  onDidChangeConfiguration: stubEvent<{ affectsConfiguration: (s: string) => boolean }>(),
  onDidSaveTextDocument: stubEvent<unknown>(),
  onDidChangeTextDocument: stubEvent<unknown>(),
  onDidChangeWorkspaceFolders: stubEvent<unknown>(),
};

export const window = {
  activeTextEditor: undefined as unknown,
  state: { focused: true },
  tabGroups: {
    all: [] as unknown[],
    activeTabGroup: { activeTab: undefined as unknown },
    onDidChangeTabs: stubEvent<unknown>(),
    onDidChangeTabGroups: stubEvent<unknown>(),
  },
  createOutputChannel: () => noopChannel,
  createStatusBarItem: () => ({ show() {}, dispose() {} }),
  onDidChangeActiveTextEditor: stubEvent<unknown>(),
  onDidChangeWindowState: stubEvent<{ focused: boolean }>(),
  onDidChangeTextEditorSelection: stubEvent<unknown>(),
  showTextDocument: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
};

export const commands = {
  registerCommand: () => new Disposable(),
  executeCommand: async () => undefined,
};
