# The state file

`editor-state-mcp` continuously mirrors live VS Code editor state into a small JSON file inside
your workspace. This is the consumer-facing reference for that file — schema, field meanings,
staleness rules, and how to read it correctly. It's generated from / kept in sync with
[`src/state/types.ts`](../src/state/types.ts), which is the actual source of truth; if the two
ever disagree, trust the code.

No tool call, no MCP server, no configuration is needed to consume this — just read the file.

## Location

```
<workspace root>/.editor-state/state.json
```

- The first workspace folder, unless `editorStateMcp.path` is set to something else. An absolute
  value in that setting is used verbatim (and then lives outside the repo, so nothing here about
  `.gitignore` applies to it).
- If no folder is open, nothing is written — there is no arbitrary file to write next to.
- Gitignored by default: the extension offers once, per workspace, to add `.editor-state/` to
  `.gitignore` (see [Privacy](#privacy) below).

## Example

```jsonc
{
  "schemaVersion": 1,
  "updatedAt": "2026-08-16T14:22:03.512Z",
  "updatedAtMs": 1786969323512,
  "reason": "selectionChange",
  "extension": { "name": "editor-state-mcp", "version": "0.1.0" },
  "window": {
    "id": "d41d8cd9",
    "pid": 24188,
    "focused": true,
    "vscodeVersion": "1.104.0",
    "heartbeatPath": "C:\\Users\\you\\.editor-state-mcp\\heartbeat\\24188.json"
  },
  "workspace": {
    "name": "my-project",
    "workspaceFile": null,
    "folders": ["d:\\MyProjects\\my-project"]
  },
  "activeEditor": {
    "path": "d:\\MyProjects\\my-project\\session1\\Hello.py",
    "relativePath": "session1/Hello.py",
    "scheme": "file",
    "languageId": "python",
    "isUntitled": false,
    "isDirty": false,
    "lineCount": 7,
    "eol": "crlf",
    "viewColumn": 1,
    "source": "activeTextEditor"
  },
  "selection": {
    "isEmpty": false,
    "startLine": 4, "startColumn": 1,
    "endLine": 4,   "endColumn": 20,
    "lineCount": 1,
    "reversed": false,
    "kind": "mouse",
    "wholeLineGesture": false,
    "text": "print(dir(my_lsit))",
    "textTruncated": false,
    "textOmittedReason": null,
    "zeroBased": { "startLine": 3, "startChar": 0, "endLine": 3, "endChar": 19 }
  },
  "additionalSelections": [],
  "cursor": { "line": 4, "column": 20 },
  "lastDeliberateSelection": {
    "path": "d:\\MyProjects\\my-project\\session1\\Hello.py",
    "relativePath": "session1/Hello.py",
    "capturedAtMs": 1786969323512,
    "startLine": 4, "startColumn": 1, "endLine": 4, "endColumn": 20,
    "lineCount": 1,
    "text": "print(dir(my_lsit))"
  },
  "openTabs": [
    {
      "relativePath": "session1/Hello.py",
      "path": "d:\\MyProjects\\my-project\\session1\\Hello.py",
      "scheme": "file",
      "kind": "text",
      "isActive": true, "isDirty": false, "isPinned": false,
      "groupId": 1
    }
  ],
  "recentFiles": [
    { "relativePath": "session1/Hello.py", "path": "d:\\...\\Hello.py", "lastActiveAtMs": 1786969323512 },
    { "relativePath": ".gitignore", "path": "d:\\...\\.gitignore", "lastActiveAtMs": 1786969180003 }
  ],
  "truncation": { "openTabsCapped": false, "recentFilesCapped": false }
}
```

## Reading it correctly

1. **Check `schemaVersion`.** This doc describes version `1`. If you ever see a higher number,
   don't guess at fields you don't recognize — fall back to another source and say why. Changes
   within a major version are additive only.
2. **Use `updatedAtMs` for staleness**, not wall-clock assumptions:
   - **&lt; 60s** — treat as live.
   - **60s – 30min** — usable, but say how old it is.
   - **&gt; 30min** — a hint only; confirm with the user before acting on it. Read
     `window.heartbeatPath` — if that file's own `updatedAtMs` is more than ~90s old, the VS Code
     host is dead, not idle, and you should say so rather than implying live state.
3. **`selection` is live-or-null, never carried forward.** If it's `null` or `isEmpty: true`, fall
   back to `lastDeliberateSelection` (see below) and say you're doing so.
4. **Always re-read the underlying file** for real context — never explain or act from
   `selection.text` alone, and never trust it over what's actually on disk right now.
5. **`window.focused: false`** means another VS Code window may be the one the user actually
   means (this file doesn't disambiguate between multiple open windows on the same workspace —
   see [Known limitations](../README.md#known-limitations)). Use it, but name the file/selection
   you picked so a wrong guess is obvious immediately.

This is exactly the algorithm the bundled `/explain-selection` and `/explain-file` Claude Code
skills implement — see their `SKILL.md` for the full tiered fallback (state file → connected
editor MCP server → asking the user).

## Field reference

### Top level

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `number` | Currently `1`. |
| `updatedAt` / `updatedAtMs` | `string` (ISO 8601) / `number` (epoch ms) | When this file was last actually written. Unchanged writes are skipped (see [Staleness vs no-op writes](#staleness-vs-no-op-writes-important)), so this is *not* the same as "when did the extension last check". |
| `reason` | `string` | What triggered this write: `activate`, `selectionChange`, `activeEditorChange`, `windowFocus`, `tabsChange`, `documentSave`, `documentEdit`, `workspaceFoldersChange`, `manual`, or `shutdown`. |
| `extension` | `{ name, version }` | The extension that wrote this file. |
| `window` | object | See below. |
| `workspace` | `{ name, workspaceFile, folders }` | Mirrors `vscode.workspace`. `folders` is an absolute-path array; only `folders[0]` is ever a write target. |
| `activeEditor` | object \| `null` | See below. `null` only when no text editor and no text tab can be resolved at all. |
| `selection` | object \| `null` | See below. Always reflects live state *at write time* — never carried forward. |
| `additionalSelections` | array of selection objects | Multi-cursor extras beyond the primary. Same shape as `selection`. |
| `cursor` | `{ line, column }` \| `null` | The caret (active) position, 1-based. May differ from `selection`'s end when the selection is reversed. |
| `lastDeliberateSelection` | object \| `null` | See below. The reliability feature — survives focus loss. |
| `openTabs` | array | All tabs across all groups, in tab order. Capped at `editorStateMcp.maxOpenTabs` (default 100); the active tab is always kept even if that means it's not among "the first N". |
| `recentFiles` | array | Most-recently-active first. Only updates on a genuine switch to a different file (not on every keystroke). Capped at `editorStateMcp.maxRecentFiles` (default 25), oldest dropped. |
| `truncation` | `{ openTabsCapped, recentFilesCapped }` | Whether either list above was actually capped. |

### `window`

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Stable for this extension-host process (short hash of pid + activation time). Changes across VS Code restarts. |
| `pid` | `number` | The extension host's process id. |
| `focused` | `boolean` | `vscode.window.state.focused`. The main signal for "which of my windows does this belong to" when more than one is open on the same workspace. |
| `vscodeVersion` | `string` | |
| `heartbeatPath` | `string \| null` | Absolute path to this window's liveness file. See [Telling idle from dead](#telling-idle-from-dead). |

### `activeEditor`

| Field | Type | Notes |
|---|---|---|
| `path` | `string` | Absolute for `file:` scheme documents; the raw URI string otherwise (e.g. `untitled:Untitled-1`). |
| `relativePath` | `string \| null` | Relative to the workspace root, when resolvable. |
| `scheme` | `string` | `file`, `untitled`, etc. Non-`file` schemes are not readable paths. |
| `languageId` | `string` | |
| `isUntitled` | `boolean` | |
| `isDirty` | `boolean` | |
| `lineCount` | `number` | |
| `eol` | `"lf" \| "crlf"` | |
| `viewColumn` | `number \| null` | `null` when resolved from a tab rather than a focused editor. |
| `source` | `"activeTextEditor" \| "activeTab" \| "carriedForward"` | How this was resolved — see [Focus-loss resilience](#focus-loss-resilience). `carriedForward` means "last known, not a live reading right now"; still usable, just don't present it as certain. |

### `selection` and `additionalSelections` entries

| Field | Type | Notes |
|---|---|---|
| `isEmpty` | `boolean` | `true` for a bare cursor with nothing selected. |
| `startLine` / `startColumn` / `endLine` / `endColumn` | `number` | **1-based, inclusive**, matching the `Read` tool, grep, and compiler errors. |
| `lineCount` | `number` | `endLine - startLine + 1`. |
| `reversed` | `boolean` | The user dragged from a later position to an earlier one (anchor after active). Doesn't affect the ordering of `start*`/`end*`, which are always document-ordered regardless of drag direction. |
| `kind` | `"keyboard" \| "mouse" \| "command" \| null` | How the selection was made. `command` means programmatic (e.g. jump-to-definition) — not a deliberate gesture. |
| `wholeLineGesture` | `boolean` | `true` when the user selected exactly N whole lines (drag, or Home+Shift+Down, etc.). |
| `text` | `string \| null` | The selected text, subject to `includeSelectionText` and `maxSelectionBytes`. `null` if either disables it, or if the file matched `excludeGlobs`. |
| `textTruncated` | `boolean` | `text` was clipped to `maxSelectionBytes`. The line range is never dropped even when the text is. |
| `textOmittedReason` | `"excluded" \| null` | `"excluded"` specifically means the file matched `excludeGlobs` — distinct from `text` being `null` merely because `includeSelectionText: false`. |
| `zeroBased` | `{ startLine, startChar, endLine, endChar }` | The raw VS Code values, if you need exactness instead of the 1-based convention above. |

### `lastDeliberateSelection`

The last **non-empty** selection whose `kind` was `mouse` or `keyboard` — i.e. an actual user
gesture, not a programmatic jump. Replaced *only* by another deliberate non-empty selection: it
survives focus loss, programmatic selections, and a click that collapses the range down to an
empty cursor. This is what makes `/explain-selection` work even when you've clicked away from the
editor into a chat panel and `selection` has gone `null`.

| Field | Type | Notes |
|---|---|---|
| `path` / `relativePath` | `string` / `string \| null` | The file this selection was made in — may differ from the *current* `activeEditor` if you've since switched files. |
| `capturedAtMs` | `number` | When this selection was captured — use this for its own staleness, separately from the top-level `updatedAtMs`. |
| `startLine` … `lineCount` | `number` | Same 1-based convention as `selection`. |
| `text` | `string \| null` | Subject to the same `includeSelectionText`/truncation/exclusion rules as `selection.text`. |

### `openTabs` entries

| Field | Type | Notes |
|---|---|---|
| `relativePath` / `path` | `string \| null` | `null` for tab kinds with no underlying URI. |
| `scheme` | `string \| null` | |
| `kind` | `"text" \| "diff" \| "notebook" \| "custom" \| "other"` | |
| `isActive` / `isDirty` / `isPinned` | `boolean` | |
| `groupId` | `number` | The tab group's view column. |

### `recentFiles` entries

| Field | Type |
|---|---|
| `relativePath` | `string \| null` |
| `path` | `string` |
| `lastActiveAtMs` | `number` |

## Focus-loss resilience

Clicking from the editor into a chat panel (e.g. Claude Code's sidebar) is the failure mode this
whole file exists to survive — it's exactly the moment an agent is likely to read this file, and
exactly the moment a naive implementation would report "no editor, no selection." Two independent
mechanisms cover it:

1. **`activeEditor` fallback chain.** Focused editor → the active tab (if it's a text tab, even
   unfocused) → the previous `activeEditor` carried forward with `source: "carriedForward"`. It
   only clears to `null` when no text tab exists anywhere in any tab group.
2. **`lastDeliberateSelection`.** Independent of the above — see [above](#lastdeliberateselection).

## Telling idle from dead

Writes are skipped when nothing changed (see below), so "no write in 10 minutes" is ambiguous
between "the user is reading quietly" and "the VS Code host crashed." The heartbeat file at
`window.heartbeatPath` resolves that ambiguity: it's written on a fixed interval
(`editorStateMcp.heartbeatSeconds`, default 30) for as long as the host is running, **regardless
of focus or activity**, and removed on clean shutdown. If its own `updatedAtMs` is more than
~90 seconds old, the host is gone, not idle.

```jsonc
// ~/.editor-state-mcp/heartbeat/<pid>.json
{ "windowId": "d41d8cd9", "pid": 24188, "updatedAtMs": 1786969323512, "focused": true,
  "statePath": "d:\\MyProjects\\my-project\\.editor-state\\state.json" }
```

## Staleness vs. no-op writes

If the content of the next snapshot is byte-identical to the last one actually written (ignoring
`updatedAt`/`updatedAtMs`/`reason`), the write is skipped entirely — this is what keeps a `tsc
--watch` or test runner in the same workspace from re-triggering on writes that changed nothing.
The practical consequence: `updatedAtMs` tells you when the *content* last changed, not merely
"when the extension last looked." Combined with the heartbeat above, a reader can always tell
live, quietly-unchanged, and dead apart.

## Privacy

This file can contain **source text you selected**, in plaintext, inside your workspace.

- Written with file mode `0600`.
- `excludeGlobs` (default: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `*secret*`,
  `*credential*`) keeps the *contents* of matching files out entirely — the path and line range
  are still recorded (the path isn't secret; the contents may be), with `textOmittedReason:
  "excluded"`.
- `includeSelectionText: false` disables text capture altogether while keeping ranges. A reader
  can still open the file itself, so this loses very little.
- Setting `editorStateMcp.enabled: false` removes both this file and the heartbeat file, so
  opting out is complete rather than partial.

## Not covered here

Non-goals of this file, by design: it is not a full event history (see the repo's `design.md §11`
for what's deferred), not cross-machine, and not a general IPC channel — it's one-way, extension
writes, everyone else reads.
