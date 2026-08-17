# Design: Workspace Editor State File

**Status:** proposed
**Target version:** 0.2.0
**Author:** design doc for implementation by Claude Code
**Date:** 2026-08-16

---

## 1. Problem

Claude Code skills that need "what is the user looking at right now" have no reliable
source for it.

### 1.1 What exists today, and why each channel fails

| Channel | Mechanism | Why it is not enough |
|---|---|---|
| `<ide_selection>` harness tag | The Claude Code VS Code extension attaches the current selection to a prompt **at send time** | One-shot push. It is **not** re-sent on later messages while the same selection stays highlighted. If a skill is invoked on a message where the tag did not fire, the selection is unrecoverable — the skill must ask the user to re-select. |
| `mcp__ide__*` (Claude Code's own built-in `ide` server) | Local MCP server inside the Claude Code extension | Exposes only `getDiagnostics` and `executeCode`. **No** selection or active-file tool. Verified 2026-08-16. |
| Claude Code hooks (`UserPromptSubmit`, `PreToolUse`, …) | External shell / HTTP / MCP-tool processes | Run outside the extension host with no VS Code API access. There is no selection-change hook event. Cannot read live editor state. |
| **This extension's MCP server** (`editor-mcp-server` 0.1.1) | Loopback HTTP MCP, tools `get_selection` / `get_active_file` / `get_open_tabs` | Solves the *capability* gap, but not the *reliability* gap — see below. |

### 1.2 Why this extension's own MCP server does not close the gap

The MCP path works but has too much setup friction to be the thing a skill depends on:

- `vscodeEditorMcp.autoStart` defaults to **`false`** ([package.json:80-84](package.json#L80-L84)),
  because the server opens a network port. So on a fresh window the server is simply **not running**.
- The port is dynamic (`port: 0`, [package.json:85-91](package.json#L85-L91)), so clients must
  read `~/.vscode-editor-mcp/<pid>.json` to find it.
- Auth token is regenerated per start ([package.json:106-110](package.json#L106-L110)), so a
  `.mcp.json` entry goes stale on every restart.
- **Claude Code resolves MCP servers at session start.** Starting the server mid-session does not
  make its tools appear; the session must be restarted.

Net effect: a skill cannot assume the tools exist. It must handle "no MCP" anyway — which is the
case we are trying to eliminate.

### 1.3 The insight

Reading a JSON file is the one capability a Claude Code skill **always** has, in every session,
with zero configuration, no ports, no tokens, no auth, and no session-start ordering problem.
The `Read` tool is always present.

So: have the extension continuously mirror editor state into a small, gitignored JSON file in the
workspace. Skills read that file. The MCP server stays as the richer, interactive, write-capable
channel.

---

## 2. Goals / non-goals

### Goals

- **G1.** A gitignored JSON file in the workspace always reflects current editor state
  (active file, selection, cursor, open tabs), refreshed on every relevant editor event.
- **G2.** Works with the MCP server **stopped**. No port, no token, no `.mcp.json`, no session restart.
  Default **on** — writing a local file has no network attack surface, unlike the server.
- **G3.** A reader never observes a torn/partial file, and never has to guess line-index conventions.
- **G4.** Survives the failure mode that breaks the harness tag: user clicks from the editor into the
  Claude Code chat panel. State must **not** be nulled out by focus moving off the text editor.
- **G5.** Reuses existing primitives — 1-based conversion in [src/tools/shared.ts](src/tools/shared.ts),
  atomic write in [src/discovery.ts](src/discovery.ts) — rather than re-deriving them.
- **G6.** `/explain-selection` and `/explain-file` work with **no** fresh `<ide_selection>` tag.

### Non-goals

- Not replacing the MCP server. Complementary: file = passive/always-available reads;
  MCP = interactive reads plus `edit_file` / `create_file` / `save_file`.
- Not a full event history in v0.2.0 (see §11 for the optional append-only log).
- Not cross-machine / remote. `file:` scheme URIs only; other schemes are recorded by URI string but
  not treated as readable paths.
- Not a general IPC bus. One-way: extension writes, everyone else reads.

---

## 3. Architecture

```
                    VS Code extension host (one per window)
   ┌───────────────────────────────────────────────────────────────────┐
   │                                                                   │
   │  editor events                                                    │
   │  ├─ onDidChangeTextEditorSelection                                │
   │  ├─ onDidChangeActiveTextEditor                                   │
   │  ├─ onDidChangeWindowState                                        │
   │  ├─ tabGroups.onDidChangeTabs                                     │
   │  └─ …                          (§6 full table)                    │
   │            │                                                      │
   │            ▼                                                      │
   │     StateWatcher  ──debounce──►  buildSnapshot()  ◄── PURE, no    │
   │     (src/state/watcher.ts)       (src/state/snapshot.ts)  vscode  │
   │                                        │            side effects  │
   │                                        ▼                          │
   │                                  StateFileSink                    │
   │                                (src/state/sink.ts)                │
   │                                        │                          │
   │                              atomicWriteJson()                    │
   │                            (src/atomicWrite.ts)  ◄── extracted    │
   │                                        │           from           │
   │                                        │           discovery.ts   │
   └────────────────────────────────────────┼──────────────────────────┘
                                            ▼
                      <workspaceRoot>/.editor-state/state.json   (gitignored)
                                            │
                                            ▼
                             Claude Code skill  →  Read tool
                          (/explain-selection, /explain-file)
```

`buildSnapshot` is deliberately **pure** and `vscode`-free at its boundary: it takes a plain
`SnapshotInput` and the previous snapshot, and returns the next snapshot. This is what makes the
off-by-one and carry-forward rules unit-testable without an extension host — the existing
[test/smoke/mockVscode.ts](test/smoke/mockVscode.ts) harness already establishes this pattern.

`StateFileSink` is wired in `activate()` **independently of `ServerController`**
([src/extension.ts:14-16](src/extension.ts#L14-L16)). This is the point of the feature: the file
must be written whether or not the server ever starts.

---

## 4. Output location

### 4.1 Decision

Primary (what skills read):

```
<workspaceFolders[0]>/.editor-state/state.json
```

Rationale:
- A directory, not a bare file, so **one** `.gitignore` line covers it and future siblings
  (`events.jsonl`, `heartbeat.json`).
- Its own dot-dir rather than `.vscode/` or `.claude/` — both of those contain **committed** files
  (`settings.json`, `launch.json`), so a coarse ignore rule there is dangerous.
- Workspace-relative, so it travels with the project and is trivially discoverable by a skill that
  knows only the cwd.

Overridable via `vscodeEditorMcp.stateFile.path`. An absolute value is used verbatim.

### 4.2 No workspace open

If `workspaceFolders` is empty (a loose file), skip the workspace write and fall back to the global
mirror (§4.3). Never write next to an arbitrary user file.

### 4.3 Global mirror (Phase 2, opt-in)

```
~/.vscode-editor-mcp/state/<pid>.json     ← one per window
~/.vscode-editor-mcp/state/latest.json    ← written only by the most recently focused window
```

Reuses the existing discovery directory and its **pid-liveness pruning**
([src/discovery.ts:71-93](src/discovery.ts#L71-L93)), which already solves stale files from crashed
hosts. `latest.json` resolves "which of my three VS Code windows does the user actually mean" —
the answer is whichever last reported `focused: true`. Deferred to Phase 2 to keep v0.2.0 tight.

### 4.4 Gitignore

On first successful write, if `vscodeEditorMcp.stateFile.autoGitignore` is true (default) and
`<root>/.gitignore` exists and does not already ignore the path, append:

```
# editor-mcp-server: live editor state (machine-local)
.editor-state/
```

Prompt once (`showInformationMessage` with "Add to .gitignore" / "Not now" / "Never") rather than
editing a tracked file silently. Record the "Never" answer in `context.workspaceState`.

If `.gitignore` does not exist, do not create one — just log. A repo without a `.gitignore` may be
intentional, and creating one is a bigger footprint than this feature deserves.

---

## 5. The output contract

This is the part that must be stable — skills will hard-code field names.

### 5.1 Example

Real state for the file open during this design session:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-08-16T14:22:03.512Z",
  "updatedAtMs": 1786969323512,
  "reason": "selectionChange",
  "extension": { "name": "editor-mcp-server", "version": "0.2.0" },
  "window": {
    "id": "d41d8cd9",
    "pid": 24188,
    "focused": true,
    "vscodeVersion": "1.104.0",
    "mcpServer": { "state": "stopped", "url": null }
  },
  "workspace": {
    "name": "Python_course",
    "workspaceFile": null,
    "folders": ["d:\\MyProjects\\AI\\Python_course"]
  },
  "activeEditor": {
    "path": "d:\\MyProjects\\AI\\Python_course\\session1\\Hello.py",
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
    "startLine": 4,
    "startColumn": 1,
    "endLine": 4,
    "endColumn": 20,
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
  "visibleRange": { "startLine": 1, "endLine": 7 },
  "lastDeliberateSelection": {
    "path": "d:\\MyProjects\\AI\\Python_course\\session1\\Hello.py",
    "relativePath": "session1/Hello.py",
    "capturedAtMs": 1786969323512,
    "startLine": 4,
    "startColumn": 1,
    "endLine": 4,
    "endColumn": 20,
    "text": "print(dir(my_lsit))"
  },
  "openTabs": [
    {
      "relativePath": "session1/Hello.py",
      "path": "d:\\MyProjects\\AI\\Python_course\\session1\\Hello.py",
      "kind": "text", "isActive": true, "isDirty": false, "isPinned": false, "groupId": 1
    }
  ],
  "recentFiles": [
    { "relativePath": "session1/Hello.py", "path": "d:\\...\\Hello.py", "lastActiveAtMs": 1786969323512 },
    { "relativePath": ".mcp.json", "path": "d:\\...\\.mcp.json", "lastActiveAtMs": 1786969180003 }
  ],
  "diagnostics": { "activeFile": { "error": 0, "warning": 0, "information": 0, "hint": 0 } },
  "truncation": { "openTabsCapped": false, "recentFilesCapped": false }
}
```

### 5.2 Field reference

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | int | **1.** Bump on any breaking change. Readers must check this and bail politely on unknown majors. |
| `updatedAt` / `updatedAtMs` | ISO8601 / int | Write time. The reader's staleness signal (§10.2). |
| `reason` | enum | Which event triggered the write: `activate` \| `selectionChange` \| `activeEditorChange` \| `windowFocus` \| `tabsChange` \| `documentSave` \| `documentEdit` \| `visibleRangeChange` \| `workspaceFoldersChange` \| `diagnosticsChange` \| `manual` \| `shutdown`. |
| `window.id` | string | Stable per extension-host process. Short hash of `pid` + host start time. |
| `window.focused` | bool | From `vscode.window.state.focused`. Key multi-window disambiguator. |
| `window.mcpServer` | object | Lets an agent discover the richer channel *from* the file — the bridge between the two mechanisms. Sourced from `ServerController.status`. |
| `activeEditor` | object \| null | `null` **only** when no text document can be resolved at all — not merely because focus left the editor (§7). |
| `activeEditor.source` | enum | `activeTextEditor` \| `activeTab` \| `carriedForward`. Tells the reader how much to trust it. |
| `selection` | object \| null | The **primary** selection. `null` when there is no active editor. `isEmpty: true` for a bare cursor. |
| `selection.kind` | enum \| null | `keyboard` \| `mouse` \| `command` \| `null`, from `TextEditorSelectionChangeKind`. `mouse`/`keyboard` = deliberate user gesture; `command` = programmatic (e.g. a jump-to-definition). Drives `lastDeliberateSelection`. |
| `additionalSelections` | array | Multi-cursor extras, primary excluded. Same shape minus `text` when over cap. |
| `lastDeliberateSelection` | object \| null | **The reliability feature.** Last non-empty `mouse`/`keyboard` selection, carried forward across focus changes and active-editor changes. Includes its own `path` because the active editor may have moved on. This is what a skill falls back to. |
| `openTabs` | array | All groups in tab order, via `vscode.window.tabGroups`. Includes non-text kinds (`diff`, `notebook`, `custom`, `other`) — reuse `describeTab()` from [src/tools/read.ts:201-218](src/tools/read.ts#L201-L218). |
| `recentFiles` | array | MRU, most recent first. Excellent `/explain-file` fallback. |
| `diagnostics.activeFile` | object | Severity counts only, not full messages — full diagnostics stay an MCP-tool concern. |

### 5.3 Line and column indexing — normative

**All top-level positions are 1-based, inclusive, for both line and column.** This matches the
existing MCP boundary convention ([src/tools/shared.ts:4-10](src/tools/shared.ts#L4-L10)), the
`Read` tool's output, grep, and compiler errors. Reuse `fromPosition` / `fromRange`
([src/tools/shared.ts:48-54](src/tools/shared.ts#L48-L54)) — do not open-code `+1`.

`selection.zeroBased` carries the raw VS Code values, so a consumer that wants exactness has it
without re-deriving.

#### The whole-line-gesture rule

VS Code represents "user selected all of line N" as a range ending at **character 0 of line N+1**.
Converted naively that reports an extra line the user did not select. This is the single most
likely correctness bug in this feature, so the rule is normative:

> If `end.character === 0` **and** `end.line > start.line`, then the last line is not really part of
> the selection. Set `endLine = end.line` (already 1-based after conversion, which equals the true
> last line), set `endColumn` to that line's length + 1, and set `wholeLineGesture: true`.
> `zeroBased` keeps the un-normalized values.

Worked example — user drags to select all of line 4 in a 7-line file:

| | line | char |
|---|---|---|
| raw `start` (0-based) | 3 | 0 |
| raw `end` (0-based) | 4 | 0 |
| naive 1-based | 4 → 5 | ← **wrong**, claims 2 lines |
| normalized | 4 → 4 | ✅ `wholeLineGesture: true`, `lineCount: 1` |

Test cases required in M1 (§13): single char; single full line via drag; single full line via
`Home`+`Shift+Down`; multi-line ending mid-line; multi-line ending at char 0; reversed (anchor after
active); empty (cursor only); multi-cursor; untitled document; zero-length document.

### 5.4 Size limits and truncation

| Thing | Default cap | Setting | Over-cap behaviour |
|---|---|---|---|
| `selection.text` | 64 KiB | `stateFile.maxSelectionBytes` | Clip at a UTF-8 char boundary, `textTruncated: true`. **Never** drop the line range — the reader can always `Read` the file itself. |
| `openTabs` | 100 | `stateFile.maxOpenTabs` | Keep active tab + first N, `truncation.openTabsCapped: true`. |
| `recentFiles` | 25 | `stateFile.maxRecentFiles` | Drop oldest. |
| whole file | ~256 KiB soft | — | Log a warning if exceeded; indicates a cap is misconfigured. |

Clipping (not refusing) is correct here, unlike `sliceDocument`
([src/tools/shared.ts:128-139](src/tools/shared.ts#L128-L139)) which throws for oversize — a
throwing snapshot writer would leave the file stale, which is worse than a truncated field.

---

## 6. Event handling

No editor events are currently subscribed anywhere in the codebase — verified: the only
`onDidChange*` usages are config, server-status and Copilot-provider
([src/extension.ts:40](src/extension.ts#L40), [src/server/controller.ts:27](src/server/controller.ts#L27),
[src/copilot.ts:17](src/copilot.ts#L17)). The extension is entirely pull-based today. This feature
introduces the first push layer, so all subscriptions below are new.

| Event | Refreshes | Debounce | Notes |
|---|---|---|---|
| `window.onDidChangeTextEditorSelection` | `selection`, `additionalSelections`, `cursor`, `lastDeliberateSelection` | 150 ms trailing, 750 ms max-wait | Highest volume — fires on **every** arrow key. Debounce is mandatory. `e.kind` feeds `selection.kind`. |
| `window.onDidChangeActiveTextEditor` | `activeEditor`, `selection`, `recentFiles` | 50 ms | May fire with `undefined`. See §7 — must not null out state. |
| `window.onDidChangeWindowState` | `window.focused` | **0 — immediate flush** | On blur, flush pending debounce right away: the user is leaving, and this is exactly when an agent is about to read. |
| `window.tabGroups.onDidChangeTabs` / `onDidChangeTabGroups` | `openTabs` | 300 ms | Prefer `tabGroups` over `workspace.textDocuments` — it reflects what the user actually sees. |
| `workspace.onDidSaveTextDocument` | `activeEditor.isDirty`, `openTabs` | 300 ms | |
| `workspace.onDidChangeTextDocument` | `activeEditor.isDirty`, `lineCount` | 500 ms | Cheap fields only. Do **not** re-read selection text on every keystroke. Ignore events for non-active documents. |
| `window.onDidChangeTextEditorVisibleRanges` | `visibleRange` | 500 ms | Scroll spam. Lowest priority; drop entirely if it proves noisy. |
| `workspace.onDidChangeWorkspaceFolders` | `workspace` | 0 | Also re-resolves the output path. |
| `languages.onDidChangeDiagnostics` | `diagnostics.activeFile` | 1000 ms | Only if the change set intersects the active file. |

Debouncing is **coalescing, not per-event**: one shared timer, and the write carries the
highest-priority `reason` seen in the window (`selectionChange` beats `documentEdit`). Always flush
on: window blur, `deactivate()`, and the manual command.

### 6.1 Empirical verification required

VS Code's exact behaviour when focus moves from a text editor to a **webview panel in the same
window** (i.e. the Claude Code sidebar — the precise scenario in G4) is not reliably documented.
Before finalising M2, verify by experiment and record findings in this file:

1. Click editor → click Claude Code chat input. Does `onDidChangeActiveTextEditor` fire? With
   `undefined`?
2. Does `vscode.window.activeTextEditor` become `undefined`, or retain the last editor?
3. Does `window.state.focused` stay `true` (same window) — confirming blur-flush does **not** cover
   this case?
4. Does the selection visually persist while `editor.selections` still reports it?

Do not assume. The defensive rule in §7 is written to be correct under *either* outcome, but the
tests in M2 must encode the real behaviour.

---

## 7. Focus-loss resilience (G4)

The failure mode that motivates this whole feature: the user selects code, then clicks into the
Claude Code chat to type. If the extension naively mirrors "current editor state" at that moment
and VS Code reports no active text editor, the file is wiped **exactly** when it is needed.

Three defences, in order:

1. **Never null out on absence.** A snapshot write triggered by an event that reports no active
   editor must not overwrite a good `activeEditor` / `selection` with `null`. Carry the previous
   value forward and mark `activeEditor.source: "carriedForward"`. Only a genuine "all editors
   closed" (`tabGroups.all` has no text tabs) clears it.

2. **Active-tab fallback.** When `window.activeTextEditor` is `undefined`, fall back to
   `tabGroups.activeTabGroup.activeTab`. This is already solved — reuse `activeDocument()`
   ([src/tools/read.ts:190-199](src/tools/read.ts#L190-L199)); do not reimplement it. Note it is
   `async` (it may `openTextDocument`), so the snapshot path is async.

3. **`lastDeliberateSelection`.** Independently of the above, retain the last non-empty selection
   whose `kind` was `mouse` or `keyboard`, with its own `path` and `capturedAtMs`. It is only
   replaced by another deliberate non-empty selection — never cleared by focus changes, programmatic
   selections, or a cursor click that collapses the range.

Point 3 is what makes a skill's fallback trustworthy, and it is why `kind` is captured at all.

---

## 8. Write mechanics

Extract the existing write-then-rename from
[src/discovery.ts:47-52](src/discovery.ts#L47-L52) into `src/atomicWrite.ts` and use it for both
call sites, so there is one implementation of durability.

```ts
export async function atomicWriteJson(
  target: string,
  data: unknown,
  opts?: { mode?: number; retries?: number },
): Promise<void>;
```

Requirements:

- **Write to `<target>.<pid>.tmp`, then `fs.rename`.** A reader therefore sees either the old
  complete file or the new complete file, never a partial one. Include `pid` in the temp name so
  concurrent windows cannot collide on it.
- **Windows retry.** `fs.rename` over an existing file uses `MoveFileEx` with
  `MOVEFILE_REPLACE_EXISTING`, but can still fail `EPERM` / `EBUSY` / `EACCES` when another process
  (a reader, an AV scanner, an indexer) holds the target open. This is the primary platform is
  Windows 11, so this is not theoretical: retry up to 3 times with 25/50/100 ms backoff, then log a
  warning and drop the write. **Never throw into an event handler.**
- **Mode `0o600`.** The file can contain selected source text (§9). Matches the existing discovery
  file's posture ([src/discovery.ts:50](src/discovery.ts#L50)).
- **Serialise writes.** One in-flight write at a time per sink; if another is requested while one is
  running, coalesce to a single follow-up. Prevents rename races against ourselves.
- **`mkdir -p`** the containing directory once, lazily, on first write.
- **Stable key order** and `JSON.stringify(x, null, 2)`. Diffable when a human inspects it, and keeps
  byte-identical output for unchanged state.
- **Skip no-op writes.** If the serialised body is byte-identical to the last one written, skip the
  write entirely. Prevents filesystem-watcher storms in the host workspace (a real hazard: watchers,
  hot-reloaders and test runners in the user's project may be watching the tree).

### 8.1 Shutdown

In `deactivate()`, `await` a final flush with `reason: "shutdown"` before returning — mirroring the
existing comment about awaiting so the discovery file is gone before the host exits
([src/extension.ts:59-64](src/extension.ts#L59-L64)). Do **not** delete the state file on shutdown:
its value outlives the window (a skill may run just after VS Code closes), and staleness is already
communicated by `updatedAtMs`. Deleting would trade a knowable-stale answer for no answer.

---

## 9. Privacy and safety

The file contains **source text the user selected**, in plaintext, inside the workspace. That is a
real consideration, not a hypothetical.

| Risk | Mitigation |
|---|---|
| Selected secret gets committed | `.gitignore` prompt on first write (§4.4). Directory-level rule so siblings are covered too. |
| Selected secret sits on disk | `mode 0o600`. `stateFile.includeSelectionText: false` disables text capture entirely while keeping ranges — a skill can still `Read` the file itself, so this loses almost nothing. |
| Sensitive files | `stateFile.excludeGlobs`, default `["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/*secret*", "**/*credential*"]`. On match: still record path + range, omit `text`, set `textOmittedReason: "excluded"`. Path is not secret; contents may be. |
| Untitled / unsaved scratch buffers | Treated as normal; recorded with `isUntitled: true` and a `untitled:` URI. |
| Surprise | Status bar item already exists ([src/statusBar.ts](src/statusBar.ts)) — extend its tooltip to show that state mirroring is on and where the file is. The user should never be unaware this file is being written. |

`stateFile.enabled: false` must fully disable the feature and remove an existing state file, so
opting out is complete rather than partial.

---

## 10. Consumer integration

### 10.1 Skill tier changes

Both skills already resolve their target through an explicit tier list. The state file becomes a new
**Tier 2**, ahead of MCP.

`~/.claude/skills/explain-selection/SKILL.md` — current tiers are
(1) harness tag, (2) MCP, (3) older tags / ask. New order:

| Tier | Source | Why this rank |
|---|---|---|
| 1 | `<ide_selection>` harness tag | Guaranteed fresh *and* guaranteed to come from the window that sent the prompt. Strictly the best signal when present. |
| **2 (new)** | `.editor-state/state.json` | Always available, no config. Fresh to within the debounce window. |
| 3 | Editor MCP tools, if present | Live pull, but usually unavailable (§1.2). |
| 4 | Older tags in history / ask the user | Last resort. |

`explain-file` gets the same insertion, reading `activeEditor.relativePath` with `recentFiles[0]`
as fallback.

Also update the **Known MCP capability gaps** list in `explain-selection` to record Claude Code's
built-in `ide` server (`getDiagnostics` / `executeCode` only, no selection tool) so no future session
wastes a `ToolSearch` on it.

### 10.2 Read algorithm for skills

```
1. Read <cwd>/.editor-state/state.json. Missing → fall to next tier (extension not installed).
2. schemaVersion > 1 → do not guess; fall through and say why.
3. age = now - updatedAtMs
     age < 60 s                  → use silently
     60 s ≤ age < 30 min         → use, but state the age: "using the selection
                                    from ~4 min ago (lines 3–5 of Hello.py)"
     age ≥ 30 min                → treat as a hint only; confirm before explaining
4. window.focused === false and a fresher tag exists → prefer the tag.
5. selection non-null and !isEmpty  → use it.
   selection null or isEmpty        → use lastDeliberateSelection, and say so:
                                      "nothing is selected now; explaining your
                                       last selection, lines 4–4 of Hello.py"
6. Cross-check: if a harness tag is also present and disagrees, the tag wins (it is
   bound to this prompt); mention the discrepancy rather than silently picking.
7. Always Read the underlying file for surrounding context — never explain from
   selection.text alone, and never trust it over the file on disk.
```

Step 5's "say so" matters: a skill that silently explains a stale selection is worse than one that
explains the right thing out loud. Surfacing provenance is cheap and makes the mechanism debuggable.

### 10.3 Consumer docs

Ship `docs/state-file.md` with the schema, and add a §to README. Third parties (other skills, editor
plugins, scripts) should be able to consume this without reading the extension source.

---

## 11. Optional / deferred

| Item | Value | Phase |
|---|---|---|
| Global mirror + `latest.json` (§4.3) | Multi-window disambiguation; works with no workspace | 2 |
| `heartbeat.json`, refreshed every 30 s while focused | Makes staleness *provable* — distinguishes "user hasn't moved" from "VS Code died". Separate file so `state.json` stays churn-free. | 2 |
| `events.jsonl`, append-only, rotated at 1 MiB / 1000 lines | Recent-history context: "what has the user been looking at". Append-only, so no atomic-write concern. | 3 |
| `get_editor_state` MCP tool returning the same snapshot | One source of truth across both channels; `buildSnapshot` is already pure and reusable | 3 |
| File-watch push (skills triggered by state change) | Speculative — Claude Code has no mechanism to consume this today (§1.1) | — |

---

## 12. Repo layout

New and changed files only:

```
src/
  atomicWrite.ts        NEW   extracted from discovery.ts; used by both
  state/
    types.ts            NEW   Snapshot interfaces; source of truth for docs/state-file.md
    snapshot.ts         NEW   PURE buildSnapshot(input, prev, now) — all normalization rules
    collect.ts          NEW   thin, impure: vscode API → SnapshotInput
    watcher.ts          NEW   event subscriptions + coalescing debounce
    sink.ts             NEW   path resolution, no-op skip, serialised atomic write
    gitignore.ts        NEW   one-time prompt + append
  config.ts             EDIT  add StateFileConfig to readConfig()
  extension.ts          EDIT  wire StateWatcher, independent of ServerController
  discovery.ts          EDIT  use atomicWrite.ts
  statusBar.ts          EDIT  surface state-file status in tooltip
test/smoke/
  snapshot.test.ts      NEW   off-by-one table, carry-forward, truncation
  atomicWrite.test.ts   NEW   torn-read loop, tmp cleanup, Windows retry
docs/
  state-file.md         NEW   consumer-facing schema doc
package.json            EDIT  stateFile.* settings + 2 commands
README.md / CHANGELOG.md EDIT
```

### 12.1 Key signatures

```ts
// state/snapshot.ts — pure. No vscode import. The whole correctness surface.
export function buildSnapshot(input: SnapshotInput, prev: Snapshot | null, nowMs: number): Snapshot;
export function normalizeSelection(raw: RawSelection, doc: DocInfo): NormalizedSelection;

// state/watcher.ts
export class StateWatcher implements vscode.Disposable {
  constructor(sink: StateFileSink, getServerStatus: () => ServerStatus);
  schedule(reason: WriteReason): void;
  flush(): Promise<void>;      // awaited by deactivate() and the manual command
  dispose(): void;
}

// state/sink.ts
export class StateFileSink implements vscode.Disposable {
  write(snapshot: Snapshot): Promise<void>;   // no-op-skips, serialises, never throws
  currentPath(): string | undefined;
  removeFile(): Promise<void>;                // for stateFile.enabled → false
}
```

`getServerStatus` is injected rather than importing `ServerController`, keeping the state layer
decoupled from the server (and unit-testable).

### 12.2 New settings

All under the existing `vscodeEditorMcp` section
([src/config.ts:5](src/config.ts#L5)), namespaced `stateFile.*`:

| Setting | Default |
|---|---|
| `stateFile.enabled` | `true` — unlike the server, no network surface, so on by default |
| `stateFile.path` | `".editor-state/state.json"` |
| `stateFile.debounceMs` | `150` |
| `stateFile.maxSelectionBytes` | `65536` |
| `stateFile.includeSelectionText` | `true` |
| `stateFile.excludeGlobs` | see §9 |
| `stateFile.maxOpenTabs` | `100` |
| `stateFile.maxRecentFiles` | `25` |
| `stateFile.autoGitignore` | `true` |
| `stateFile.includeGlobalMirror` | `false` (Phase 2) |

Extend `needsRestart` ([src/config.ts:46-48](src/config.ts#L46-L48)) semantics: `stateFile.*` changes
must **not** restart the HTTP server. Handle them in a separate branch — `stateFile.enabled` and
`stateFile.path` reconfigure the sink (removing the old file on a path change), the rest apply on the
next write.

### 12.3 New commands

- `vscodeEditorMcp.writeStateNow` — "Editor MCP: Write Editor State Now" (force flush; the debug affordance)
- `vscodeEditorMcp.openStateFile` — "Editor MCP: Open Editor State File" (inspect what agents see)

---

## 13. Milestones

Each milestone is independently shippable and independently verifiable.

### M0 — Extract `atomicWrite` (no behaviour change)
- Extract write-then-rename from `discovery.ts` into `src/atomicWrite.ts`; add Windows retry + serialisation.
- `discovery.ts` uses it.
- **AC:** `npm run check-types` and `npm run smoke` pass; discovery file still written/pruned as before; `atomicWrite.test.ts` proves a concurrent reader never sees a partial file across 1000 write/read cycles.

### M1 — Snapshot + write (the core)
- `state/types.ts`, `state/snapshot.ts` (pure), `state/collect.ts`, `state/sink.ts`.
- `StateWatcher` with selection + active-editor events only.
- Wire into `activate()`; write once on activate with `reason: "activate"`.
- **AC:**
  - Selecting line 4 of `Hello.py` updates `state.json` within 300 ms with `startLine: 4, endLine: 4`.
  - A whole-line drag yields `endLine === startLine` and `wholeLineGesture: true`.
  - The full §5.3 test table passes as pure unit tests, no extension host needed.
  - Works with the MCP server **stopped** (G2). Verify explicitly.
  - Holding an arrow key produces coalesced writes, not one per keypress.

### M2 — Focus-loss resilience
- Run the §6.1 verification experiments; record results in this doc.
- Carry-forward rules, `activeDocument()` fallback, `lastDeliberateSelection`.
- Blur-flush; `deactivate()` flush.
- **AC:** select lines → click into the Claude Code chat panel → `state.json` still shows the
  selection, `activeEditor` not `null`, `lastDeliberateSelection` populated. **This is the
  acceptance test for the entire feature** (G4).

### M3 — Breadth, safety, ergonomics
- `openTabs`, `recentFiles`, `visibleRange`, `diagnostics`, `window.mcpServer`.
- Remaining events; truncation caps; `excludeGlobs`; `includeSelectionText`; settings; commands;
  gitignore prompt; status-bar tooltip.
- **AC:** selecting inside a `.env` file records the range with `text: null` and
  `textOmittedReason: "excluded"`; `stateFile.enabled: false` removes the file; no-op writes are
  skipped (verify by watching mtime while idle).

### M4 — Skill + docs integration
- Insert Tier 2 into both `SKILL.md` files per §10.1; add the read algorithm from §10.2.
- Record the Claude Code built-in `ide` server gap.
- `docs/state-file.md`, README, CHANGELOG, version → 0.2.0.
- Add `.editor-state/` to the `Python_course` `.gitignore` (currently only `**/*.$.md`).
- **AC (G6):** in a **fresh** Claude Code session with **no** `<ide_selection>` tag on the invoking
  message, `/explain-selection` correctly explains the selected lines without asking the user to
  re-select. This is the end-to-end proof.

### M5 — Optional (§11)
Global mirror, heartbeat, event log, `get_editor_state` tool. Only after M4 has been used in anger.

---

## 14. Risks and open questions

| # | Risk | Mitigation / status |
|---|---|---|
| R1 | Extension host crashes → file silently stale, skill explains the wrong code | `updatedAtMs` + staleness policy (§10.2) + heartbeat (Phase 2). Fundamental to any file-based mirror; managed, not eliminated. |
| R2 | Write storms trip filesystem watchers in the user's project | Coalescing debounce + no-op skip (§8) + dedicated dot-dir. Watch for interaction with test watchers / hot reload during dogfooding. |
| R3 | Windows rename contention | Bounded retry, never throw (§8). Explicit test. |
| R4 | Multiple VS Code windows on the same workspace race on one file | v0.2.0: last-writer-wins, with `window.focused` and `window.id` recorded so a reader can detect it. Properly fixed by Phase 2's `latest.json`. **Accepted limitation — document it.** |
| R5 | Selected secrets on disk / in git | §9. Requires the gitignore prompt to actually land in M3, not slip. |
| R6 | §6.1 focus behaviour differs from assumptions | Carry-forward rule is written to be correct either way; experiments gate M2. |
| R7 | Claude Code ships a native pull API, obsoleting this | Would be welcome. Cost is one small module; `buildSnapshot` stays useful for the MCP tool regardless. |
| R8 | Schema churn breaks skills | `schemaVersion` + readers required to check it (§10.2 step 2). Additive changes only within a major. |

### Open questions for sign-off

1. **Output path** — `.editor-state/` at the workspace root, as proposed? Alternatives:
   `.vscode/editor-state.json` (needs a file-level ignore rule) or `.claude/editor-state/`
   (ties it to Claude Code specifically).
2. **Selection text on by default?** `includeSelectionText: true` is more useful and matches what the
   harness tag already puts in the transcript; `false` is more conservative. Proposed: `true`, with
   the exclude-globs denylist.
3. **Scope of v0.2.0** — M0–M4 as scoped, or pull the Phase 2 heartbeat forward given R1 is the
   sharpest remaining risk?
