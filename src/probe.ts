import * as vscode from 'vscode';
import { log } from './log';

/**
 * Temporary M0 instrumentation for the design.md §6.1 experiments.
 *
 * The question it answers: when focus moves from a text editor to a webview in
 * the *same* window (the Claude Code sidebar), what does VS Code report? That
 * outcome decides whether `lastDeliberateSelection` is insurance or the entire
 * mechanism, so it gates M1's schema.
 *
 * Delete this module once §6.1 findings are recorded.
 */

const SAMPLE_INTERVAL_MS = 500;
const DEFAULT_DURATION_MS = 20_000;

interface Sample {
  atMs: number;
  activeEditorPath: string | null;
  activeTabLabel: string | null;
  activeTabIsText: boolean;
  windowFocused: boolean;
  /** Raw 0-based, because that is what the normalization rule consumes. */
  selection: string | null;
  selectionIsEmpty: boolean | null;
}

interface ProbeEvent {
  atMs: number;
  name: string;
  detail: string;
}

let running = false;

export async function runFocusProbe(durationMs = DEFAULT_DURATION_MS): Promise<void> {
  if (running) {
    vscode.window.showWarningMessage('Focus probe is already running.');
    return;
  }
  if (!vscode.window.activeTextEditor) {
    vscode.window.showWarningMessage('Open a file and select some text before running the focus probe.');
    return;
  }

  running = true;
  const started = Date.now();
  const events: ProbeEvent[] = [];
  const samples: Sample[] = [];
  const since = () => Date.now() - started;

  const record = (name: string, detail: string) => {
    events.push({ atMs: since(), name, detail });
    log.info(`[probe +${since()}ms] ${name} — ${detail}`);
  };

  const subs = [
    vscode.window.onDidChangeActiveTextEditor(editor => {
      record('onDidChangeActiveTextEditor', editor ? label(editor.document.uri) : 'undefined');
    }),
    vscode.window.onDidChangeWindowState(state => {
      record('onDidChangeWindowState', `focused=${state.focused}`);
    }),
    vscode.window.onDidChangeTextEditorSelection(e => {
      record(
        'onDidChangeTextEditorSelection',
        `kind=${kindName(e.kind)} ${describeSelection(e.selections[0])} in ${label(e.textEditor.document.uri)}`,
      );
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => record('tabGroups.onDidChangeTabs', '')),
  ];

  const timer = setInterval(() => samples.push(sample(since())), SAMPLE_INTERVAL_MS);
  samples.push(sample(0));

  vscode.window.showInformationMessage(
    `Focus probe running for ${Math.round(durationMs / 1000)}s. ` +
      'Now click into the Claude Code chat input and type a character, then wait.',
  );

  await new Promise(resolve => setTimeout(resolve, durationMs));

  clearInterval(timer);
  subs.forEach(s => s.dispose());
  samples.push(sample(since()));
  running = false;

  const report = buildReport(events, samples);
  log.info(report);

  const doc = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: false });
}

function sample(atMs: number): Sample {
  const editor = vscode.window.activeTextEditor;
  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  return {
    atMs,
    activeEditorPath: editor ? label(editor.document.uri) : null,
    activeTabLabel: tab?.label ?? null,
    activeTabIsText: tab?.input instanceof vscode.TabInputText,
    windowFocused: vscode.window.state.focused,
    selection: editor ? describeSelection(editor.selection) : null,
    selectionIsEmpty: editor ? editor.selection.isEmpty : null,
  };
}

function buildReport(events: ProbeEvent[], samples: Sample[]): string {
  const first = samples[0];
  const last = samples[samples.length - 1];

  const editorChanges = events.filter(e => e.name === 'onDidChangeActiveTextEditor');
  const firedUndefined = editorChanges.some(e => e.detail === 'undefined');

  // The decisive question: did the editor reference vanish while a text tab was
  // still the active tab? That is the case the carry-forward rule exists for.
  const lostEditorWithTextTab = samples.some(s => s.activeEditorPath === null && s.activeTabIsText);
  const focusedWentFalse = samples.some(s => !s.windowFocused);
  const selectionSurvived = last.selection !== null && last.selectionIsEmpty === false;

  const q = (yes: boolean, y: string, n: string) => (yes ? y : n);

  return [
    '# §6.1 focus-behaviour findings',
    '',
    `Samples: ${samples.length} over ${last.atMs} ms. Events captured: ${events.length}.`,
    '',
    '## Answers',
    '',
    `**Q1 — Does \`onDidChangeActiveTextEditor\` fire? With \`undefined\`?**  `,
    `${q(editorChanges.length > 0, `Yes, ${editorChanges.length} time(s).`, 'No, it never fired.')} ` +
      `${q(firedUndefined, 'At least one fired with `undefined`.', 'It never fired with `undefined`.')}`,
    '',
    `**Q2 — Does \`activeTextEditor\` become \`undefined\`, or retain the last editor?**  `,
    q(
      lostEditorWithTextTab,
      '**Becomes `undefined`** while a text tab was still active. Carry-forward and the ' +
        'active-tab fallback are load-bearing, not insurance.',
      '**Retains the editor.** G4 is nearly free; `lastDeliberateSelection` is insurance.',
    ),
    '',
    `**Q3 — Does \`window.state.focused\` stay \`true\`?**  `,
    q(
      focusedWentFalse,
      '**No** — it went `false` during the probe, so blur-flush does cover this case. ' +
        '(Check the timeline: this may be OS-level focus loss rather than the sidebar click.)',
      '**Yes, stayed `true` throughout.** Confirms blur-flush does NOT cover the sidebar case — ' +
        'the same-window webview click is invisible to `onDidChangeWindowState`.',
    ),
    '',
    `**Q4 — Does \`editor.selections\` still report the selection at the end?**  `,
    q(
      selectionSurvived,
      `**Yes** — final selection ${last.selection}.`,
      `**No** — final selection was ${last.selection ?? 'unavailable (no active editor)'}` +
        `${last.selectionIsEmpty ? ', collapsed to an empty cursor' : ''}.`,
    ),
    '',
    '## Start vs end',
    '',
    '| | at 0 ms | at ' + last.atMs + ' ms |',
    '|---|---|---|',
    `| activeTextEditor | ${fmt(first.activeEditorPath)} | ${fmt(last.activeEditorPath)} |`,
    `| activeTab | ${fmt(first.activeTabLabel)} | ${fmt(last.activeTabLabel)} |`,
    `| activeTab is text | ${first.activeTabIsText} | ${last.activeTabIsText} |`,
    `| window.focused | ${first.windowFocused} | ${last.windowFocused} |`,
    `| selection (0-based) | ${fmt(first.selection)} | ${fmt(last.selection)} |`,
    '',
    '## Event timeline',
    '',
    events.length === 0
      ? '_No events fired._'
      : ['| +ms | event | detail |', '|---|---|---|', ...events.map(e => `| ${e.atMs} | ${e.name} | ${e.detail} |`)].join(
          '\n',
        ),
    '',
    '## Sample timeline',
    '',
    '| +ms | activeTextEditor | activeTab | focused | selection |',
    '|---|---|---|---|---|',
    ...samples.map(
      s =>
        `| ${s.atMs} | ${fmt(s.activeEditorPath)} | ${fmt(s.activeTabLabel)} | ${s.windowFocused} | ${fmt(s.selection)} |`,
    ),
    '',
  ].join('\n');
}

function fmt(v: string | null): string {
  return v === null ? '`null`' : `\`${v}\``;
}

function label(uri: vscode.Uri): string {
  return uri.path.split('/').pop() ?? uri.toString();
}

function describeSelection(sel: vscode.Selection | undefined): string {
  if (!sel) return 'none';
  return `L${sel.start.line}C${sel.start.character}-L${sel.end.line}C${sel.end.character}${sel.isEmpty ? ' (empty)' : ''}`;
}

function kindName(kind: vscode.TextEditorSelectionChangeKind | undefined): string {
  switch (kind) {
    case vscode.TextEditorSelectionChangeKind.Keyboard:
      return 'keyboard';
    case vscode.TextEditorSelectionChangeKind.Mouse:
      return 'mouse';
    case vscode.TextEditorSelectionChangeKind.Command:
      return 'command';
    default:
      return 'undefined';
  }
}
