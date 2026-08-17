# Design: `editor-state-mcp`

**Status:** accepted, pending implementation
**Supersedes:** `design.v1-proposed.md` (the additive-feature framing; see §0 for what changed and why)
**Target:** `wisdomrock.editor-state-mcp` 0.1.0 — a new extension id, not an upgrade of `editor-mcp-server` 0.1.1
**Date:** 2026-08-16

---

## 0. What this revision changes

The predecessor doc proposed the state file as an *additive* feature of `editor-mcp-server` 0.2.0,
keeping the loopback HTTP MCP server as a complementary channel. Decisions taken at sign-off:

| Decision | Consequence |
|---|---|
| **State file only.** The MCP server is deleted, not kept. | `src/server/`, `src/tools/`, `src/copilot.ts`, `src/discovery.ts` are removed. `@modelcontextprotocol/sdk` and `zod` are dropped — **zero runtime dependencies**. No port, no token, no auth, no session reaping, no Copilot provider, no `needsRestart`. |
| **Workspace-primary output**, global mirror opt-in. | `<workspaceRoot>/.editor-state/state.json` is what skills read (§4). Carries the per-repo `.gitignore` cost, accepted for discoverability. |
| **New extension id**, clean break. | Published as `wisdomrock.editor-state-mcp`; settings namespace `editorStateMcp.*`. Existing 0.1.1 installs get no upgrade path and must reinstall. Defensible: 0.1.1 does not work reliably. |

Six substantive corrections to the predecessor's technical content, each marked **[REV]** at its
section: global-vs-workspace rationale (§4), the whole-line-gesture off-by-one (§5.4), removal of
`selection` carry-forward (§7), the focus experiments promoted to M0 (§6.1), removal of
`visibleRange` and `diagnostics` from the schema (§5), and the heartbeat pulled into v1 (§8.2).

**Note on the name.** With the server gone, nothing in this extension speaks MCP. The name is kept
because it is the user's chosen identity and because §11's stdio MCP reader — which would restore
the meaning honestly — remains the most likely next phase. This is a known cosmetic debt.

---

## 1. Problem

Claude Code skills that need "what is the user looking at right now" have no reliable source for it.

### 1.1 What exists today, and why each channel fails

| Channel | Mechanism | Why it is not enough |
|---|---|---|
| `<ide_selection>` harness tag | The Claude Code VS Code extension attaches the current selection to a prompt **at send time** | One-shot push. **Not** re-sent on later messages while the same selection stays highlighted. A skill invoked on a message where the tag did not fire cannot recover the selection — it must ask the user to re-select. |
| `mcp__ide__*` (Claude Code's own built-in `ide` server) | Local MCP server inside the Claude Code extension | Exposes only `getDiagnostics` and `executeCode`. **No** selection or active-file tool. Verified 2026-08-16. |
| Claude Code hooks | External shell / HTTP / MCP-tool processes | Run outside the extension host with no VS Code API access. No selection-change hook event exists. |
| `editor-mcp-server` 0.1.1 (this repo's predecessor) | Loopback HTTP MCP, `get_selection` / `get_active_file` / `get_open_tabs` | Closed the *capability* gap, not the *reliability* gap — §1.2. |

### 1.2 Why the 0.1.1 HTTP server is being deleted rather than fixed

The code is sound; the architecture cannot deliver the goal:

- `autoStart` defaults to **`false`** (the server opens a network port), so on a fresh window it is
  simply **not running**.
- The port is dynamic (`port: 0`), so clients must read `~/.vscode-editor-mcp/<pid>.json` to find it.
- The auth token is regenerated per start, so a `.mcp.json` entry goes stale on every restart.
- **Claude Code resolves MCP servers at session start.** Starting the server mid-session does not make
  its tools appear; the session must be restarted.

Net effect: a skill could never assume the tools existed, so it had to handle "no MCP" anyway — which
is precisely the case this design eliminates. Keeping the server would mean maintaining a channel
whose failure path every consumer must still implement. It goes.

### 1.3 The insight

Reading a JSON file is the one capability a Claude Code skill **always** has, in every session, with
zero configuration, no ports, no tokens, no auth, and no session-start ordering problem. The `Read`
tool is always present.

So: the extension continuously mirrors editor state into a small, gitignored JSON file in the
workspace. Skills read that file. That is the entire product.

---

## 2. Goals / non-goals

### Goals

- **G1.** A gitignored JSON file in the workspace always reflects current editor state (active file,
  selection, cursor, open tabs), refreshed on every relevant editor event.
- **G2.** Zero configuration and zero network surface. Enabled by default; nothing to start, no port
  to bind, no token to rotate, no session to restart.
- **G3.** A reader never observes a torn/partial file, and never has to guess line-index conventions.
- **G4.** Survives the failure mode that breaks the harness tag: the user clicks from the editor into
  the Claude Code chat panel. State must **not** be nulled out by focus moving off the text editor.
- **G5.** A reader can always distinguish live state from stale state, and stale from dead.
- **G6.** `/explain-selection` and `/explain-file` work with **no** fresh `<ide_selection>` tag.

### Non-goals

- No MCP server, no HTTP listener, no write/edit capability. Claude Code's own `Edit`/`Write` cover
  mutation; this extension is read-only observation.
- Not a full event history in v1 (see §11).
- Not cross-machine / remote. `file:` scheme URIs only; other schemes are recorded by URI string but
  not treated as readable paths.
- Not a general IPC bus. One-way: extension writes, everyone else reads.

---

## 3. Architecture

```
                    VS Code extension host (one per window)
   ┌───────────────────────────────────────────────────────────────────┐
   │  editor events (§6)                                               │
   │  ├─ onDidChangeTextEditorSelection                                │
   │  ├─ onDidChangeActiveTextEditor                                   │
   │  ├─ onDidChangeWindowState                                        │
   │  ├─ tabGroups.onDidChangeTabs                                     │
   │  └─ …                                                             │
   │            │                                                      │
   │            ▼                                                      │
   │     StateWatcher ──coalescing debounce──►  collect()              │
   │   (src/state/watcher.ts)                (src/state/collect.ts)    │
   │                                              │  impure, thin      │
   │                                              ▼                    │
   │                                       buildSnapshot()  ◄── PURE,  │
   │                                    (src/state/snapshot.ts)  no    │
   │                                              │        vscode      │
   │                                              ▼                    │
   │                                       StateFileSink               │
   │                                     (src/state/sink.ts)           │
   │                                              │                    │
   │                                     atomicWriteJson()             │
   │                                   (src/atomicWrite.ts)            │
   │            HeartbeatWriter ──┐                │                   │
   │        (src/state/heartbeat.ts)               │                   │
   └──────────────────────────────┼────────────────┼───────────────────┘
                                  ▼                ▼
        ~/.editor-state-mcp/heartbeat/   <workspaceRoot>/.editor-state/
                  <pid>.json                    state.json  (gitignored)
                (liveness, §8.2)                      │
                                                      ▼
                                        Claude Code skill → Read tool
                                     (/explain-selection, /explain-file)
```

`buildSnapshot` is deliberately **pure** and `vscode`-free at its boundary: it takes a plain
`SnapshotInput` plus the previous snapshot and returns the next one. This is what makes the
off-by-one and carry-forward rules unit-testable without an extension host; the existing
[test/smoke/mockVscode.ts](test/smoke/mockVscode.ts) harness already establishes the pattern and is
the one piece of the current test setup worth keeping.

Everything is wired directly in `activate()`. There is no lifecycle controller, because there is no
longer anything with a lifecycle to control.

---

## 4. Output location

### 4.1 Decision **[REV]**

```
<workspaceFolders[0]>/.editor-state/state.json
```

- A directory, not a bare file, so **one** `.gitignore` line covers it and future siblings.
- Its own dot-dir rather than `.vscode/` or `.claude/` — both contain **committed** files, so a coarse
  ignore rule there is dangerous.
- Workspace-relative, so it travels with the project and is discoverable by a skill that knows only
  its cwd. This is the deciding factor: `Read .editor-state/state.json` needs no path resolution
  step at all.

Overridable via `editorStateMcp.path`. An absolute value is used verbatim.

**[REV] Accepted costs of choosing workspace-primary.** The global alternative
(`~/.editor-state-mcp/<pid>.json` + `latest.json`) avoids all three of the following; it was rejected
for discoverability, so these must be actively managed rather than assumed away:

1. **A `.gitignore` prompt in every repo the user opens** (§4.3). Recurring friction, forever.
2. **Writes land inside trees watched by the user's tooling** — tsc `--watch`, eslint, vitest,
   nodemon. Mitigated by the coalescing debounce and no-op skip (§8), and by keeping the heartbeat
   *out* of the workspace (§8.2). This is R2 and it needs watching during dogfooding.
3. **Multi-window races** on a shared workspace: last writer wins (R4).

### 4.2 No workspace open

If `workspaceFolders` is empty (a loose file), skip the write entirely and log once. Never write next
to an arbitrary user file. The global mirror (§11) is the answer for this case; until then, no-workspace
is unsupported.

### 4.3 Gitignore

On first successful write, if `editorStateMcp.autoGitignore` is true (default) and `<root>/.gitignore`
exists and does not already ignore the path, prompt once via `showInformationMessage` with
**"Add to .gitignore" / "Not now" / "Never"**, and on accept append:

```
# editor-state-mcp: live editor state (machine-local)
.editor-state/
```

Prompt rather than silently editing a tracked file. Record "Never" in `context.workspaceState`, keyed
per workspace.

If `.gitignore` does not exist, do not create one — just log. A repo without a `.gitignore` may be
intentional, and creating one is a bigger footprint than this feature deserves.

---

## 5. The output contract

This is the part that must be stable — skills will hard-code field names.

**[REV] What was cut from the predecessor's schema, and why.** `visibleRange` (scroll-driven, 500 ms
churn) and `diagnostics.activeFile` were removed. Neither serves G6, both add write volume against
R2, and diagnostics are *already* reliably available in every session via `mcp__ide__getDiagnostics`
(§1.1) — duplicating the one channel that already works, at a cost, is backwards. `window.mcpServer`
was removed because there is no server. Every remaining field is one a consumer of G6 actually reads.

### 5.1 Example

```json
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
    "heartbeatPath": "C:\\Users\\wisdo\\.editor-state-mcp\\heartbeat\\24188.json"
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
  "lastDeliberateSelection": {
    "path": "d:\\MyProjects\\AI\\Python_course\\session1\\Hello.py",
    "relativePath": "session1/Hello.py",
    "capturedAtMs": 1786969323512,
    "startLine": 4,
    "startColumn": 1,
    "endLine": 4,
    "endColumn": 20,
    "lineCount": 1,
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
  "truncation": { "openTabsCapped": false, "recentFilesCapped": false }
}
```

### 5.2 Field reference

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | int | **1.** Bump on any breaking change. Readers must check it and bail politely on unknown majors. Additive changes only within a major. |
| `updatedAt` / `updatedAtMs` | ISO8601 / int | Write time. The reader's primary staleness signal (§10.2). |
| `reason` | enum | `activate` \| `selectionChange` \| `activeEditorChange` \| `windowFocus` \| `tabsChange` \| `documentSave` \| `documentEdit` \| `workspaceFoldersChange` \| `manual` \| `shutdown`. |
| `window.id` | string | Stable per extension-host process. Short hash of `pid` + host start time. |
| `window.focused` | bool | From `vscode.window.state.focused`. Key multi-window disambiguator (R4). |
| `window.heartbeatPath` | string | Absolute path to this window's heartbeat file (§8.2). Lets a reader escalate from "stale" to "dead" without knowing the global dir layout. |
| `activeEditor` | object \| null | `null` only when no text document can be resolved at all. Carried forward across focus loss (§7). |
| `activeEditor.source` | enum | `activeTextEditor` \| `activeTab` \| `carriedForward`. Tells the reader how much to trust it. |
| `selection` | object \| null | **[REV] Strictly live-or-null.** The primary selection as it is *at write time*, never carried forward. `null` when no editor resolves. `isEmpty: true` for a bare cursor. |
| `selection.kind` | enum \| null | `keyboard` \| `mouse` \| `command` \| `null`, from `TextEditorSelectionChangeKind`. `mouse`/`keyboard` = deliberate gesture; `command` = programmatic (e.g. jump-to-definition). Drives `lastDeliberateSelection`. |
| `additionalSelections` | array | Multi-cursor extras, primary excluded. Same shape minus `text` when over cap. |
| `lastDeliberateSelection` | object \| null | **The reliability feature.** Last non-empty `mouse`/`keyboard` selection, with its own `path` and `capturedAtMs`, carried forward across focus and active-editor changes. The only carried-forward selection state. What a skill falls back to. |
| `openTabs` | array | All groups in tab order, via `vscode.window.tabGroups`. Includes non-text kinds (`diff`, `notebook`, `custom`, `other`). |
| `recentFiles` | array | MRU, most recent first. The `/explain-file` fallback. |

### 5.3 Line and column indexing — normative

**All top-level positions are 1-based, inclusive, for both line and column.** This matches the
`Read` tool's output, grep, and compiler errors. `selection.zeroBased` carries the raw VS Code values
so a consumer wanting exactness has them without re-deriving.

`vscode.Range.start`/`.end` are always document-ordered regardless of drag direction; `reversed` is
derived separately from `anchor` vs `active`. All normalization below operates on the ordered values.

### 5.4 The whole-line-gesture rule — normative **[REV]**

VS Code represents "the user selected all of line N" as a range ending at **character 0 of line
N+1**. Converted naively this reports an extra line the user did not select. This is the single most
likely correctness bug in the feature.

> The predecessor doc stated this rule as *"set `endLine = end.line` (already 1-based after
> conversion)"*, which is wrong and contradicts its own worked example: after `+1` conversion
> `end.line` is 5, not 4. The rule below uses the **raw, un-incremented** value, and consequently
> the end position **cannot** go through a generic `fromPosition`/`+1` helper. That exception is
> deliberate and must be commented at the implementation site.

Given raw 0-based ordered `start = (sl, sc)` and `end = (el, ec)`:

```
if (!isEmpty && ec === 0 && el > sl) {
    startLine   = sl + 1
    startColumn = sc + 1
    endLine     = el                        // NOT el + 1. The 0-based index of the
                                            // line *after* the selection is numerically
                                            // the 1-based number of the last line *in* it.
    endColumn   = lengthOfLine(el - 1) + 1  // 0-based index el-1 == 1-based line endLine
    wholeLineGesture = true
} else {
    startLine = sl + 1; startColumn = sc + 1
    endLine   = el + 1; endColumn   = ec + 1
    wholeLineGesture = false
}
lineCount = endLine - startLine + 1
```

Empty selections (`start === end`) skip normalization entirely — the guard exists because a
zero-width range at character 0 would otherwise satisfy `ec === 0` spuriously.

Worked example — drag-select all of line 4 in a 7-line file:

| | line | char |
|---|---|---|
| raw `start` (0-based) | 3 | 0 |
| raw `end` (0-based) | 4 | 0 |
| naive 1-based | 4 → 5 | ← **wrong**, claims 2 lines |
| normalized | 4 → 4 | ✅ `wholeLineGesture: true`, `lineCount: 1` |

Second example — drag-select all of lines 4–6: raw `(3,0)–(6,0)` → `startLine 4`, `endLine 6`,
`lineCount 3`, `wholeLineGesture: true`. Third — partial lines 4–6: raw `(3,2)–(5,7)` →
`startLine 4, startColumn 3`, `endLine 6, endColumn 8`, `lineCount 3`, `wholeLineGesture: false`.

**Required test table (M1).** Single char; single full line via drag; single full line via
`Home`+`Shift`+`Down`; multi-line ending mid-line; multi-line ending at char 0; reversed (anchor
after active); empty (cursor only); multi-cursor; untitled document; zero-length document; selection
on the final line of a file with no trailing newline.

### 5.5 Size limits and truncation

| Thing | Default cap | Setting | Over-cap behaviour |
|---|---|---|---|
| `selection.text` | 64 KiB | `maxSelectionBytes` | Clip at a UTF-8 char boundary, `textTruncated: true`. **Never** drop the line range — the reader can always `Read` the file itself. |
| `openTabs` | 100 | `maxOpenTabs` | Keep the active tab + first N, `truncation.openTabsCapped: true`. |
| `recentFiles` | 25 | `maxRecentFiles` | Drop oldest. |
| whole file | ~256 KiB soft | — | Log a warning if exceeded; indicates a cap is misconfigured. |

Clip, never refuse. A snapshot writer that throws on oversize leaves the file stale, which is worse
than a truncated field.

---

## 6. Event handling

The 0.1.x extension subscribed to no editor events at all — it was entirely pull-based. Every
subscription below is new, and the push layer is the whole product now.

| Event | Refreshes | Debounce | Notes |
|---|---|---|---|
| `window.onDidChangeTextEditorSelection` | `selection`, `additionalSelections`, `cursor`, `lastDeliberateSelection` | 150 ms trailing, 750 ms max-wait | Highest volume — fires on **every** arrow key. Debounce mandatory. `e.kind` feeds `selection.kind`. |
| `window.onDidChangeActiveTextEditor` | `activeEditor`, `selection`, `recentFiles` | 50 ms | May fire with `undefined`. §7 — must not null out state. |
| `window.onDidChangeWindowState` | `window.focused` | **0 — immediate flush** | On blur, flush pending debounce at once: the user is leaving, which is exactly when an agent is about to read. |
| `window.tabGroups.onDidChangeTabs` / `onDidChangeTabGroups` | `openTabs` | 300 ms | Prefer `tabGroups` over `workspace.textDocuments` — it reflects what the user actually sees. |
| `workspace.onDidSaveTextDocument` | `activeEditor.isDirty`, `openTabs` | 300 ms | |
| `workspace.onDidChangeTextDocument` | `activeEditor.isDirty`, `lineCount` | 500 ms | Cheap fields only. Do **not** re-read selection text on every keystroke. Ignore events for non-active documents. |
| `workspace.onDidChangeWorkspaceFolders` | `workspace` | 0 | Also re-resolves the output path. |

Debouncing is **coalescing, not per-event**: one shared timer, and the write carries the
highest-priority `reason` seen in the window (`selectionChange` beats `documentEdit`). Always flush
on window blur, `deactivate()`, and the manual command.

### 6.1 Empirical verification — gates M1, not M2 **[REV]**

VS Code's exact behaviour when focus moves from a text editor to a **webview panel in the same
window** — the Claude Code sidebar, i.e. the precise scenario in G4 — is not reliably documented.
The predecessor doc scheduled these experiments in M2. They belong in **M0, before any code**,
because their outcome determines the schema: if `activeTextEditor` goes `undefined` *and*
`editor.selections` becomes unreadable on webview focus, then `lastDeliberateSelection` is not a
fallback, it is the only mechanism, and §5/§7 change shape.

Run and record the results in this section:

1. Click editor → click the Claude Code chat input. Does `onDidChangeActiveTextEditor` fire? With
   `undefined`?
2. Does `vscode.window.activeTextEditor` become `undefined`, or retain the last editor?
3. Does `window.state.focused` stay `true` (same window) — confirming blur-flush does **not** cover
   this case?
4. Does the selection visually persist while `editor.selections` still reports it?

**Expectation (must not be trusted until measured):** `activeTextEditor` *retains* the editor and
`state.focused` stays `true`, because the active *tab* is still a text editor — the webview is a
sidebar view, not a tab. If so, G4 is nearly free and `lastDeliberateSelection` is pure insurance.

**Findings:** _(to be filled in during M0)_

---

## 7. Focus-loss resilience (G4) **[REV]**

The motivating failure: the user selects code, then clicks into the Claude Code chat to type. If the
extension naively mirrors "current state" at that moment and VS Code reports no active text editor,
the file is wiped **exactly** when it is needed.

The predecessor doc listed three defences. Defences 1 and 3 overlapped, and 1 was actively harmful:
carrying a stale range forward *inside* `selection`, with no `capturedAtMs` of its own, let a reader
receive "lines 380–400" for a file since edited down to 50 lines with no way to detect it. Two
defences, with disjoint semantics:

1. **Active-tab fallback for `activeEditor`.** When `window.activeTextEditor` is `undefined`, fall
   back to `tabGroups.activeTabGroup.activeTab` (`TabInputText` → `openTextDocument`). Salvage the
   existing `activeDocument()` helper from the deleted `src/tools/read.ts` rather than reimplementing
   it. It is `async`, so the collect path is async. If that also fails, carry the previous
   `activeEditor` forward with `source: "carriedForward"`; only a genuine "no text tabs remain in
   `tabGroups.all`" clears it to `null`.

2. **`lastDeliberateSelection`.** The last non-empty selection whose `kind` was `mouse` or
   `keyboard`, with its own `path`, `relativePath` and `capturedAtMs`. Replaced *only* by another
   deliberate non-empty selection — never cleared by focus changes, programmatic selections, or a
   cursor click that collapses the range.

`selection` itself is therefore always live-or-null, and needs no `source` enum. A reader that finds
`selection === null` or `isEmpty` falls to `lastDeliberateSelection` and reports the age it carries
(§10.2). This is the whole reason `kind` is captured.

---

## 8. Write mechanics

Salvage the write-then-rename from the deleted `src/discovery.ts` into `src/atomicWrite.ts`:

```ts
export async function atomicWriteJson(
  target: string,
  data: unknown,
  opts?: { mode?: number; retries?: number },
): Promise<void>;
```

Requirements:

- **Write to `<target>.<pid>.tmp`, then `fs.rename`.** A reader sees either the old complete file or
  the new complete file, never a partial one. `pid` in the temp name so concurrent windows cannot
  collide.
- **Windows retry.** `fs.rename` over an existing file uses `MoveFileEx` with
  `MOVEFILE_REPLACE_EXISTING` but can still fail `EPERM` / `EBUSY` / `EACCES` when another process
  holds the target open. **Measured in M0, not theoretical** — see R3 for the numbers: because Node
  opens files without `FILE_SHARE_DELETE`, *any* concurrent reader can block the rename, and a
  25/50/100 ms budget was empirically insufficient. Retry 6 times on those codes with
  5/10/20/40/80/160 ms backoff and ±25% jitter, then log a warning and drop the write. Jitter matters
  because two windows contending on one file would otherwise resynchronise on every attempt (R4).
- **Re-schedule a dropped write.** *(Added in M0 as a direct consequence of the R3 measurements.)*
  A drop is only benign if something writes again. Relying on the next editor event is not enough:
  the dangerous case is a drop on the *last* write before the user goes idle, which would strand
  permanently stale state and defeat G1. On a dropped write the sink must schedule a retry
  (~1 s, a few attempts) independently of editor activity.
- **Never throw into an event handler.** `atomicWriteJson` throws; the sink is the layer that
  swallows, logs and re-schedules.
- **Mode `0o600`.** The file can contain selected source text (§9).
- **Serialise writes.** One in-flight write at a time per sink; a request arriving mid-write coalesces
  into a single follow-up. Prevents rename races against ourselves.
- **`mkdir -p`** the containing directory once, lazily, on first write.
- **Stable key order**, `JSON.stringify(x, null, 2)`. Diffable by a human, byte-identical for
  unchanged state.
- **Skip no-op writes.** If the serialised body is byte-identical to the last one written, skip
  entirely. This is the primary mitigation for R2 — filesystem-watcher storms in the user's own
  project tree.

### 8.1 Shutdown

In `deactivate()`, `await` a final flush with `reason: "shutdown"`. Do **not** delete `state.json`:
its value outlives the window (a skill may run just after VS Code closes), and staleness is already
communicated by `updatedAtMs`. Deleting would trade a knowably-stale answer for no answer. *Do*
delete the heartbeat file — its entire meaning is "this host is alive."

### 8.2 Heartbeat — in v1 **[REV]**

R1 (host dies → file silently stale → skill explains the wrong code) was the predecessor's sharpest
named risk, and its only mitigation was deferred to a later phase. It ships in v1, because §8's
no-op skip *creates* the ambiguity: with identical writes suppressed, "no write in 10 minutes" is
indistinguishable between *the user is reading quietly* and *the extension host is dead*.

```
~/.editor-state-mcp/heartbeat/<pid>.json
{ "windowId": "d41d8cd9", "pid": 24188, "updatedAtMs": …, "focused": true,
  "statePath": "d:\\...\\.editor-state\\state.json" }
```

- Written every `heartbeatSeconds` (default 30, `0` disables) for as long as the host is activated,
  **regardless of focus**, so a stale heartbeat means *dead*, unambiguously.
- **Deliberately in the global dir, not the workspace.** A 30-second write inside the project tree
  would re-trigger the user's `vitest --watch` / `tsc --watch` twice a minute — R2 with a
  fixed period, which no debounce can suppress. Discoverability is not needed here because
  `state.json` publishes `window.heartbeatPath`; a reader only pays the second read when it already
  suspects staleness.
- Reuse the pid-liveness pruning (`process.kill(pid, 0)`) salvaged from `discovery.ts` to clear
  files left by hosts that crashed without deactivating.
- Removed on `deactivate()`.

---

## 9. Privacy and safety

The file contains **source text the user selected**, in plaintext, inside the workspace. Real
consideration, not hypothetical.

| Risk | Mitigation |
|---|---|
| Selected secret gets committed | `.gitignore` prompt on first write (§4.3), directory-level so siblings are covered. |
| Selected secret sits on disk | `mode 0o600`. `includeSelectionText: false` disables text capture while keeping ranges — a skill can still `Read` the file itself, so this loses almost nothing. |
| Sensitive files | `excludeGlobs`, default `["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/*secret*", "**/*credential*"]`. On match: record path + range, omit `text`, set `textOmittedReason: "excluded"`. The path is not secret; the contents may be. |
| Untitled / unsaved scratch buffers | Normal; recorded with `isUntitled: true` and an `untitled:` URI. |
| Surprise | The status bar item shows that mirroring is on and where the file is; clicking opens it. The user should never be unaware this file is being written. |

`editorStateMcp.enabled: false` must fully disable the feature **and** remove an existing state file
and heartbeat, so opting out is complete rather than partial.

Kept default: `includeSelectionText: true`. The harness tag already places selected text in the
transcript, so `false` is conservative theatre that costs real utility; the exclude-globs denylist is
the proportionate control.

---

## 10. Consumer integration

### 10.1 Skill tier changes

Both skills resolve their target through an explicit tier list. The state file becomes Tier 2, and
the MCP tier disappears with the server.

| Tier | Source | Why this rank |
|---|---|---|
| 1 | `<ide_selection>` harness tag | Guaranteed fresh *and* guaranteed to come from the window that sent the prompt. Strictly the best signal when present. |
| **2 (new)** | `.editor-state/state.json` | Always available, no config. Fresh to within the debounce window. |
| 3 | Older tags in history / ask the user | Last resort. |

Also update the **Known MCP capability gaps** note in `explain-selection` to record Claude Code's
built-in `ide` server (`getDiagnostics` / `executeCode` only, no selection tool), so no future
session wastes a `ToolSearch` rediscovering it.

### 10.2 Read algorithm for skills

```
1. Read <cwd>/.editor-state/state.json.
     Missing → fall to next tier (extension not installed, or no workspace).
2. schemaVersion > 1 → do not guess; fall through and say why.
3. age = now - updatedAtMs
     age < 60 s            → use silently
     60 s ≤ age < 30 min   → use, but state the age: "using the selection from
                              ~4 min ago (lines 3–5 of Hello.py)"
     age ≥ 30 min          → treat as a hint only; confirm before explaining.
                              Optionally Read window.heartbeatPath: a heartbeat
                              older than ~90 s means the host is dead, not idle —
                              say so instead of implying live state.
4. window.focused === false and a fresher tag exists → prefer the tag.
5. selection non-null and !isEmpty → use it.
   selection null or isEmpty       → use lastDeliberateSelection and say so, with
                                     its own capturedAtMs age: "nothing is selected
                                     now; explaining your last selection, lines 4–4
                                     of Hello.py"
6. Cross-check: if a harness tag is also present and disagrees, the tag wins (it is
   bound to this prompt); mention the discrepancy rather than silently picking.
7. Always Read the underlying file for surrounding context — never explain from
   selection.text alone, and never trust it over the file on disk.
```

Step 5's "say so" matters: a skill that silently explains a stale selection is worse than one that
explains the right thing out loud. Surfacing provenance is cheap and makes the mechanism debuggable.

### 10.3 Consumer docs

Ship `docs/state-file.md` with the schema, generated from / kept in sync with `src/state/types.ts`,
and add a README section. Third parties should be able to consume this without reading the source.

---

## 11. Deferred

| Item | Value | Phase |
|---|---|---|
| **stdio MCP server** — a standalone process, launched by Claude Code, that reads these files and exposes `get_editor_state` / `get_selection` | The honest path back to the extension's name. stdio has none of HTTP's failure modes: no port, no token, nothing in `.mcp.json` to go stale, no session-start ordering problem. Needs the launcher written to a **stable** path (`~/.editor-state-mcp/bin/`) because the extension's install dir is version-stamped. | 2 |
| Global mirror + `latest.json`, written by the most recently focused window | Properly fixes R4 multi-window ambiguity and §4.2 no-workspace. `latest.json` answers "which of my three windows does the user mean". | 2 |
| `events.jsonl`, append-only, rotated at 1 MiB / 1000 lines | "What has the user been looking at lately." Append-only, so no atomic-write concern. | 3 |
| File-watch push (skills triggered by state change) | Speculative — Claude Code has no mechanism to consume this today (§1.1). | — |

---

## 12. Repo layout

### 12.1 Deletions

```
src/server/controller.ts      DELETE   HTTP lifecycle
src/server/httpServer.ts      DELETE
src/server/mcpServer.ts       DELETE
src/tools/context.ts          DELETE
src/tools/read.ts             DELETE   — salvage activeDocument(), describeTab() first
src/tools/write.ts            DELETE   edit_file / create_file / save_file
src/tools/shared.ts           DELETE   — salvage fromPosition/fromRange/describeUri first
src/copilot.ts                DELETE   mcpServerDefinitionProvider registration
src/discovery.ts              DELETE   — salvage write-then-rename + isAlive() first
package.json deps             DELETE   @modelcontextprotocol/sdk, zod → zero runtime deps
editor-mcp-server-0.1.1.vsix  DELETE   stale local build artifact (untracked; already gitignored)
```

### 12.2 Result

```
src/
  extension.ts        REWRITE  wire watcher + sink + heartbeat + status bar; 3 commands
  config.ts           REWRITE  editorStateMcp.* only; no needsRestart
  log.ts              KEEP     channel renamed to "Editor State"
  statusBar.ts        REWRITE  mirrors state-file status, not server status
  atomicWrite.ts      NEW      salvaged write-then-rename + Windows retry (M0)
  vscodeUtil.ts       NEW      salvaged fromPosition/fromRange/describeUri/activeDocument/describeTab
  probe.ts            TEMP     §6.1 instrumentation; delete once findings are recorded
  state/
    types.ts          NEW      Snapshot interfaces; source of truth for docs/state-file.md
    snapshot.ts       NEW      PURE buildSnapshot(input, prev, nowMs); all normalization
    collect.ts        NEW      thin, impure: vscode API → SnapshotInput
    watcher.ts        NEW      event subscriptions + coalescing debounce
    sink.ts           NEW      path resolution, no-op skip, serialised atomic write
    heartbeat.ts      NEW      global-dir liveness file (§8.2)
    gitignore.ts      NEW      one-time prompt + append
test/smoke/
  mockVscode.ts       KEEP     trimmed to the state layer's surface
  harness.ts          NEW      check/eq/note/section/report
  index.ts            NEW      runner entry point
  atomicWrite.test.ts NEW      torn-read loop, tmp cleanup, Windows retry (M0)
  snapshot.test.ts    NEW      §5.4 off-by-one table, carry-forward, truncation (M1)
docs/state-file.md    NEW      consumer-facing schema doc
```

### 12.3 Key signatures

```ts
// state/snapshot.ts — pure. No vscode import. The whole correctness surface.
export function buildSnapshot(input: SnapshotInput, prev: Snapshot | null, nowMs: number): Snapshot;
export function normalizeSelection(raw: RawSelection, doc: DocInfo): NormalizedSelection;

// state/watcher.ts
export class StateWatcher implements vscode.Disposable {
  constructor(sink: StateFileSink, config: () => StateConfig);
  schedule(reason: WriteReason): void;
  flush(): Promise<void>;      // awaited by deactivate() and the manual command
  dispose(): void;
}

// state/sink.ts
export class StateFileSink implements vscode.Disposable {
  write(snapshot: Snapshot): Promise<void>;   // no-op-skips, serialises, never throws
  currentPath(): string | undefined;
  removeFile(): Promise<void>;                // for enabled → false
}
```

### 12.4 Settings

Namespace `editorStateMcp.*`, flat — with no server there is nothing to disambiguate a `stateFile.`
prefix from.

| Setting | Default |
|---|---|
| `enabled` | `true` — no network surface, so on by default |
| `path` | `".editor-state/state.json"` |
| `debounceMs` | `150` |
| `includeSelectionText` | `true` |
| `maxSelectionBytes` | `65536` |
| `excludeGlobs` | see §9 |
| `maxOpenTabs` | `100` |
| `maxRecentFiles` | `25` |
| `autoGitignore` | `true` |
| `heartbeatSeconds` | `30` (`0` disables) |
| `globalMirror` | `false` (Phase 2) |

Config changes never restart anything. `enabled` and `path` reconfigure the sink (removing the old
file on a path change); everything else applies on the next write.

### 12.5 Commands

- `editorStateMcp.writeNow` — "Editor State: Write Now" (force flush; the debug affordance)
- `editorStateMcp.openStateFile` — "Editor State: Open State File" (inspect what agents see)
- `editorStateMcp.showLogs` — "Editor State: Show Logs"

Activation stays `onStartupFinished`. The few seconds before activation are acceptable; the first
write happens immediately on activate with `reason: "activate"`.

---

## 13. Milestones

### M0 — Strip and spike (no new features) — **done except the §6.1 run**
- Delete everything in §12.1; salvage the helpers named there into `vscodeUtil.ts` / `atomicWrite.ts`.
- Rename to `editor-state-mcp` / `editorStateMcp.*`; new publisher id; version → 0.1.0.
- `atomicWrite.ts` **pulled forward from M1**: it is rescued code with no dependency on the snapshot
  schema, so finishing it here keeps M1 purely about the snapshot. Its measurements changed a
  requirement (§8, §14.1), which is the argument for having done it early.
- Ship `src/probe.ts` — a `Editor State: Probe Focus Behaviour` command that samples across the
  editor→sidebar transition and emits a §6.1 findings report. Delete the module once §6.1 is filled in.
- **AC:** `npm run check-types` passes; `package.json` has zero runtime dependencies; the extension
  activates and writes nothing; `npm test` green.
- **Outstanding:** run the probe and paste the result into §6.1. This gates M1's schema.

### M1 — Snapshot + write (the core)
- `state/types.ts`, `state/snapshot.ts` (pure), `state/collect.ts`, `state/sink.ts`.
- `StateWatcher` with selection + active-editor events only. Write once on activate.
- Sink: no-op skip, serialised writes, swallow-and-log, and the dropped-write re-schedule (§8).
- **AC:**
  - Selecting line 4 of a file updates `state.json` within 300 ms with `startLine: 4, endLine: 4`.
  - A whole-line drag yields `endLine === startLine` and `wholeLineGesture: true`.
  - The full §5.4 test table passes as pure unit tests, no extension host required.
  - Holding an arrow key produces coalesced writes, not one per keypress.
  - A forced write failure is retried by the sink rather than left stale.

### M2 — Resilience (the acceptance milestone)
- Active-tab fallback + carry-forward for `activeEditor`; `lastDeliberateSelection`.
- Blur-flush; `deactivate()` flush; heartbeat writer (§8.2).
- **AC:** select lines → click into the Claude Code chat panel → `state.json` still shows the
  selection, `activeEditor` is not `null`, `lastDeliberateSelection` is populated. **This is the
  acceptance test for the entire product** (G4). Kill the extension host and confirm a reader can
  tell dead from idle via the heartbeat (G5).

### M3 — Breadth, safety, ergonomics
- `openTabs`, `recentFiles`, remaining events, truncation caps, `excludeGlobs`,
  `includeSelectionText`, settings, commands, gitignore prompt, status bar.
- **AC:** selecting inside a `.env` file records the range with `text: null` and
  `textOmittedReason: "excluded"`; `enabled: false` removes both files; no-op writes are skipped
  (verify by watching mtime while idle); a `vitest --watch` running in the host workspace does not
  re-trigger while the user edits (R2).

### M4 — Consumers, docs, publish
- Insert Tier 2 into both `SKILL.md` files per §10.1; add the §10.2 read algorithm; record the
  built-in `ide` server gap.
- `docs/state-file.md`, README, CHANGELOG; publish `wisdomrock.editor-state-mcp` 0.1.0.
- **AC (G6):** in a **fresh** Claude Code session with **no** `<ide_selection>` tag on the invoking
  message, `/explain-selection` correctly explains the selected lines without asking the user to
  re-select. End-to-end proof.

### M5 — Deferred (§11)
stdio MCP server, global mirror + `latest.json`, `events.jsonl`. Only after M4 has been used in anger.

---

## 14. Risks

| # | Risk | Mitigation / status |
|---|---|---|
| R1 | Extension host crashes → file silently stale → skill explains the wrong code | `updatedAtMs` + staleness policy (§10.2) + **heartbeat in v1** (§8.2). Downgraded from the predecessor's "sharpest remaining risk" because the fix now ships in M2. |
| R2 | Writes into the workspace trip filesystem watchers in the user's project | Coalescing debounce + no-op skip (§8) + heartbeat kept out of the workspace (§8.2). **Sharpest remaining risk**, and a direct cost of choosing workspace-primary (§4.1). Explicit M3 acceptance test. |
| R3 | Windows rename contention | **Measured in M0 — see §14.1.** Confirmed real and unavoidable; reduced by a longer jittered backoff and made harmless by the sink re-schedule (§8). Tearing, the property that actually matters, is proven absolute. |
| R4 | Multiple VS Code windows on one workspace race on one file | v1: last-writer-wins, with `window.focused` and `window.id` recorded so a reader can detect it. Fixed properly by Phase 2's `latest.json`. **Accepted limitation — document it in `docs/state-file.md`.** |
| R5 | Selected secrets on disk / in git | §9. Requires the gitignore prompt to actually land in M3, not slip. |
| R6 | §6.1 focus behaviour differs from assumptions | Now gates M1 rather than being discovered during M2. |
| R7 | No workspace open → feature silently does nothing | §4.2. Logged, not silent. Real gap until Phase 2's global mirror. |
| R8 | Claude Code ships a native pull API, obsoleting this | Would be welcome. `buildSnapshot` stays useful for §11's stdio server regardless. |
| R9 | Schema churn breaks skills | `schemaVersion` + readers required to check it (§10.2 step 2). Additive changes only within a major. |
| R10 | Existing 0.1.1 users are orphaned by the id change | Accepted at sign-off. Optionally push a final 0.1.2 to the old listing pointing at the replacement. |

### 14.1 R3 measured (M0, Windows 11, `test/smoke/atomicWrite.test.ts`)

Node opens files without `FILE_SHARE_DELETE`, so on Windows **any** process holding the destination
open at the instant of the rename blocks it with `EPERM`. A reader doing a single `readFile` is
enough if it lands in the wrong microsecond. Isolation run: 1000 back-to-back writes with **no**
reader dropped **0**; the same run with a 5 ms-gap reader dropped **42**. So it is reader contention,
not antivirus.

Retry policy, 1000 writes against a 5 ms-gap reader:

| Policy | Drop rate | Rename attempts per write |
|---|---|---|
| 3 retries, 25/50/100 ms (original design) | write 1 of 1000 failed outright | — |
| 6 retries, 5/10/20/40/80/160 ms, no jitter | 5.2 % | 1.39 |
| 6 retries, same, ±25 % jitter | 4.5 % | 1.39 |
| 10 retries, jittered | 2.6 % | 1.49 |
| 6 retries, jittered, **150 ms between writes** | **1.0 %** | 1.09 |

Two conclusions:

1. **Failures cluster.** At 1.39 attempts per write, ~61 % of writes succeed first try and the
   failures are concentrated in bursts lasting longer than the whole retry budget. More retries buy
   less than the shape of the curve suggests, so the budget is capped at 6 (~315 ms) to bound
   latency, and the sink re-schedule (§8) covers the tail instead.
2. **Write cadence dominates.** The drop rate is driven far more by how fast we write than by how
   hard anyone reads. At the production debounce it is ~1 % against a pathological reader, and 0/60
   against a merely busy one — orders of magnitude beyond a real consumer, which reads once per
   invocation.

**Tearing was never observed**: 0 torn reads across 214,979 reads racing 1000 writes. That is the
guarantee G3 actually needs; a dropped write only costs freshness, and `updatedAtMs` already
communicates it.
