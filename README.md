# Editor State

Mirrors your live VS Code editor state — active file, selection, cursor, open tabs — into a
small gitignored JSON file, so an AI coding agent can always find out what you're looking at.

No port, no auth token, no configuration, nothing to start.

---

> ### 🚧 Pre-release — the mirror is not written yet
>
> This is milestone **M0** of a redesign: the old MCP server has been removed and the new
> foundation is in place, but nothing is written to disk yet. See [design.md](design.md) for
> the full plan and [§13](design.md) for milestones.
>
> **Works today:** the extension activates, shows its status bar item, logs its resolved
> configuration, and ships the `Probe Focus Behaviour` diagnostic.
> **Not yet:** the state file itself (M1), focus-loss resilience (M2), open tabs and
> privacy controls (M3).

---

## Why

A skill or agent that wants to act on "the code I'm looking at right now" has no reliable
way to get it:

- The **`<ide_selection>` tag** Claude Code attaches to a prompt is a one-shot push at send
  time. It is not re-sent on later messages, so if a skill is invoked on a message where the
  tag didn't fire, the selection is simply gone.
- Claude Code's **built-in `ide` MCP server** exposes only `getDiagnostics` and `executeCode`
  — there is no selection or active-file tool.
- **Hooks** run outside the extension host with no `vscode` API access.

Reading a JSON file, on the other hand, is something every agent can do in every session with
zero setup. So the extension writes the state out and gets out of the way.

> **Previously (0.1.x):** this extension published a loopback HTTP MCP server. It worked, but
> it could never be *depended* on — off by default, dynamic port, auth token rotated on every
> start, and Claude Code resolves MCP servers only at session start, so its tools were usually
> absent exactly when a skill needed them. Every consumer had to handle "no MCP" anyway. That
> server has been deleted rather than patched.

## How it works

The extension subscribes to editor events, coalesces them behind a short debounce, and writes:

```
<workspace root>/.editor-state/state.json
```

Reading it is the entire integration:

```jsonc
{
  "schemaVersion": 1,
  "updatedAtMs": 1786969323512,       // how stale am I?
  "activeEditor": {
    "relativePath": "session1/Hello.py",
    "languageId": "python",
    "isDirty": false
  },
  "selection": {                       // live, or null — never stale
    "startLine": 4, "startColumn": 1,
    "endLine": 4,   "endColumn": 20,
    "text": "print(dir(my_lsit))"
  },
  "lastDeliberateSelection": { ... },  // survives clicking into a chat panel
  "recentFiles": [ ... ]
}
```

Two details that make it dependable:

- **Writes are atomic.** Write-to-temp then rename, so a reader sees either the previous
  complete file or the new one — never a partial document. Verified across 214,979 reads
  racing 1,000 writes.
- **`selection` is live-or-null; `lastDeliberateSelection` is the fallback.** Clicking from
  the editor into a chat panel doesn't wipe your selection — the exact failure mode that
  breaks the `<ide_selection>` tag.

Lines and columns are **1-based and inclusive**, matching grep, compilers and the `Read` tool.
The raw 0-based VS Code values are also included, under `selection.zeroBased`.

The full field reference and the normative indexing rules live in
[design.md §5](design.md). A consumer-facing `docs/state-file.md` ships with M4.

## Commands

| Command | What it does |
| --- | --- |
| `Editor State: Write Now` | Force an immediate write (M1) |
| `Editor State: Open State File` | Open the exact file agents read (M1) |
| `Editor State: Show Logs` | Open the extension's output channel |
| `Editor State: Probe Focus Behaviour (diagnostic)` | Samples editor state across a focus change and writes up a report. Temporary; removed once its findings are recorded |

The status bar item on the right shows whether mirroring is on, and clicking it opens the
state file.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `editorStateMcp.enabled` | `true` | Mirror editor state. On by default: one local file, no network port |
| `editorStateMcp.path` | `.editor-state/state.json` | Relative to the first workspace folder; absolute paths used verbatim |
| `editorStateMcp.debounceMs` | `150` | Coalescing window; selection fires on every arrow key |
| `editorStateMcp.includeSelectionText` | `true` | Include selected text, not just its range |
| `editorStateMcp.maxSelectionBytes` | `65536` | Clip longer selections; the range is never dropped |
| `editorStateMcp.excludeGlobs` | `.env`, `*.pem`, `*.key`, … | Never copy contents of these files; path and range still recorded |
| `editorStateMcp.maxOpenTabs` | `100` | Cap on recorded tabs; the active tab is always kept |
| `editorStateMcp.maxRecentFiles` | `25` | Cap on the MRU list |
| `editorStateMcp.autoGitignore` | `true` | Offer once, per workspace, to add `.editor-state/` to `.gitignore` |
| `editorStateMcp.heartbeatSeconds` | `30` | Liveness file, so a reader can tell "idle" from "VS Code died". `0` disables |
| `editorStateMcp.globalMirror` | `false` | Also mirror to `~/.editor-state-mcp/`. Not yet implemented |

## Privacy

The state file contains **source text you selected**, in plaintext, inside your workspace.

- Written with mode `0600`.
- The extension offers once, per workspace, to add `.editor-state/` to your `.gitignore`. It
  never edits a tracked file without asking, and never creates a `.gitignore` that isn't there.
- `excludeGlobs` keeps contents of sensitive files out entirely — the path and line range are
  still recorded, but the text is omitted. The path isn't secret; the contents may be.
- `includeSelectionText: false` disables text capture completely while keeping ranges. A reader
  can still open the file itself, so this costs very little.
- Setting `enabled: false` removes the state and heartbeat files, so opting out is complete.

The heartbeat is deliberately written **outside** your workspace, to
`~/.editor-state-mcp/heartbeat/`. A fixed-interval write inside the project tree would
re-trigger your own `tsc --watch` or test runner on a timer.

## Known limitations

- **No folder open → nothing is written.** The extension will not write next to an arbitrary
  loose file. The opt-in global mirror addresses this later.
- **Two windows on one workspace share one file**, last writer wins. Both `window.id` and
  `window.focused` are recorded so a reader can detect it.
- **Windows write contention.** Node opens files without `FILE_SHARE_DELETE`, so a reader can
  block a rename. Writes retry with jittered backoff and the occasional drop is re-scheduled;
  `updatedAtMs` always tells you how fresh the file really is.

## Development

```bash
npm install
npm run watch         # then press F5 for an Extension Development Host
npm run check-types   # tsc --noEmit
npm test              # atomic-write guarantees; no editor needed
npm run package       # build a .vsix
```

The correctness-critical code is deliberately `vscode`-free — `buildSnapshot` is a pure
function and `atomicWrite` is plain Node — so the tests that matter run without an extension
host. The extension has **zero runtime dependencies**.

## License

MIT
