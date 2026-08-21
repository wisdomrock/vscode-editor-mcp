import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { maybePromptGitignore } from '../../src/state/gitignore';
import { eq, section } from './harness';

function fakeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: ((key: string, def?: unknown) => (store.has(key) ? store.get(key) : def)) as vscode.Memento['get'],
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    keys: () => [...store.keys()],
  };
}

async function withPrompt<T>(response: string | undefined, fn: () => Promise<T>): Promise<T> {
  const original = vscode.window.showInformationMessage;
  (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async () => response;
  try {
    return await fn();
  } finally {
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = original;
  }
}

export async function run(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-state-gitignore-test-'));

  await section('maybePromptGitignore: no .gitignore in the workspace -> does nothing', async () => {
    const root = path.join(dir, 'no-gitignore');
    await fs.mkdir(root, { recursive: true });
    await withPrompt('Never should not be shown', async () => {
      await maybePromptGitignore(root, '.editor-state/state.json', fakeMemento());
    });
    const exists = await fs
      .access(path.join(root, '.gitignore'))
      .then(() => true)
      .catch(() => false);
    eq('no .gitignore was created', exists, false);
  });

  await section('maybePromptGitignore: choosing "Add to .gitignore" appends the entry', async () => {
    const root = path.join(dir, 'add');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n');

    await withPrompt('Add to .gitignore', async () => {
      await maybePromptGitignore(root, '.editor-state/state.json', fakeMemento());
    });

    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    eq('original content preserved', content.includes('node_modules/'), true);
    eq('ignore entry appended', content.includes('.editor-state/'), true);
  });

  await section('maybePromptGitignore: an entry already present is left untouched and not re-prompted', async () => {
    const root = path.join(dir, 'already-ignored');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n.editor-state/\n');

    let prompted = false;
    const original = vscode.window.showInformationMessage;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async () => {
      prompted = true;
      return undefined;
    };
    try {
      await maybePromptGitignore(root, '.editor-state/state.json', fakeMemento());
    } finally {
      (vscode.window as { showInformationMessage: unknown }).showInformationMessage = original;
    }
    eq('no prompt shown', prompted, false);
  });

  await section('maybePromptGitignore: choosing "Never" is remembered and skips future prompts', async () => {
    const root = path.join(dir, 'never');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
    const memento = fakeMemento();

    await withPrompt('Never', async () => {
      await maybePromptGitignore(root, '.editor-state/state.json', memento);
    });
    const contentAfterNever = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    eq('file not modified on Never', contentAfterNever, 'node_modules/\n');

    let prompted = false;
    const original = vscode.window.showInformationMessage;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async () => {
      prompted = true;
      return undefined;
    };
    try {
      await maybePromptGitignore(root, '.editor-state/state.json', memento);
    } finally {
      (vscode.window as { showInformationMessage: unknown }).showInformationMessage = original;
    }
    eq('not prompted again', prompted, false);
  });

  await section('maybePromptGitignore: an absolute configured path is never prompted for', async () => {
    const root = path.join(dir, 'absolute');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n');

    let prompted = false;
    const original = vscode.window.showInformationMessage;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async () => {
      prompted = true;
      return undefined;
    };
    try {
      await maybePromptGitignore(root, path.join(dir, 'outside', 'state.json'), fakeMemento());
    } finally {
      (vscode.window as { showInformationMessage: unknown }).showInformationMessage = original;
    }
    eq('no prompt for an absolute path', prompted, false);
  });

  await fs.rm(dir, { recursive: true, force: true });
}
