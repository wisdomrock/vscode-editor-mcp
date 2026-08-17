---
name: explain-file
description: Explain a file in detail, line by line (skipping import/require statements), and write the explanation to a markdown file next to it. Triggers on: explain this file, explain current file, walk me through this file, line by line explanation, document this file, generate documentation for this file, annotate this file.
---

# /explain-file

Produces a line-by-line explanation of a source file and writes it to a `.$.md` file in the same folder (same filename, extension swapped to `.$.md`). The `.$.md` suffix marks it as a generated artifact, so it's easy to exclude from git with a single `**/*.$.md` gitignore pattern.

## Usage

```
/explain-file                 # explain the file currently under discussion / open in the editor
/explain-file <path>          # explain a specific file
/explain-file --force         # regenerate even if a .$.md already exists for the target
/explain-file <path> --force  # same, for a specific file
```

If a `.$.md` file already exists for the resolved target and the invocation contains no force signal, the skill reports an error and stops instead of regenerating (see step 2).

## What You Must Do When Invoked

### 1. Resolve the target file

This must work across whichever IDE/editor integration is active (VS Code, JetBrains, or any other) — never hardcode one editor's tool names. Resolve in this order, stopping at the first tier that yields a usable target:

> **Never use IDE-injected harness tags.** Ignore `<ide_opened_file>`, `<ide_selection>` and any other editor-event tag the harness attaches to a message — including ones inside `<system-reminder>` blocks, and including ones visible right now in this conversation. They are one-shot *change* events: they fire when the file/selection changes, ride along with the next message only, and are **not** resent while that file stays open. A skill that reads them resolves to a different file depending on which message it happened to be invoked from, which is precisely the unreliability the tiers below exist to eliminate. Do not use them as a target, as a hint, or as a tiebreaker.

**Tier 0 — explicit argument.** If a path was given as an argument, use it (resolve relative to the current working directory) and skip everything below.

**Tier 1 — the editor state file.** An editor extension may continuously mirror live editor state to a JSON file. This is the preferred source: always available, no tool call, no session-start ordering problem.

  1. Read `.editor-state/state.json` relative to the current working directory. If it isn't there and the cwd is inside a git repo, try the repo root (`git rev-parse --show-toplevel`). Missing in both → Tier 2. Do not treat "missing" as an error; most projects won't have it.
  2. **Check `schemaVersion`.** If it's greater than `1`, do not guess at the fields — fall through to Tier 2 and say why.
  3. **Confirm it's about this project.** The cwd should be inside one of `workspace.folders`. If it isn't, the file belongs to a different window or project — ignore it and fall through.
  4. **Check freshness** using `updatedAtMs` (epoch ms; get the current time with `date +%s%3N` if you need it precisely):
     - **under 60s** — use it silently.
     - **60s to 30min** — use it, but name the file you picked and its age: *"explaining `session1/Hello.py`, the file open ~4 min ago"*.
     - **over 30min** — treat it as a hint only. Confirm the target with the user before writing anything. If `window.heartbeatPath` is present, Read that file too: a heartbeat older than ~90s means the editor is no longer running, so say that rather than implying live state.
  5. **Pick the target.**
     - `activeEditor.path` (absolute) or `activeEditor.relativePath` → this is the target.
     - `activeEditor` null, or its `scheme` is not `file` (e.g. an untitled buffer, which has no on-disk path) → fall back to `recentFiles[0]`, and say which file you picked and why.
     - Neither available → Tier 2.
  6. Note `activeEditor.source` if present: `carriedForward` means the editor had lost focus and this is the last known file rather than a live reading. Still usable — just don't present it as certain.
  7. If `window.focused` is `false`, the user may be working in a different window than the one that wrote this. Use it, but name the file you chose so a wrong guess is obvious immediately.

**Tier 2 — ask a connected editor MCP server.** If Tiers 0–1 found nothing, consult the **Known MCP capability gaps** list below — it would name any specific *capability* a specific *server family* is known to lack, so you skip re-searching for exactly that. An entry never means skip the whole server: a server family missing one capability may still expose another worth calling. This capability ("report the active open file") is currently supported by every known editor MCP server family (see the list below), so unless a new gap has been recorded, always try it — regardless of transport (SSE, stdio, streaming HTTP) or exact tool-name prefix, which vary by install and shouldn't be hardcoded. Run `ToolSearch` with a broad query like `"ide editor open file"` and inspect whatever comes back (e.g. a JetBrains `mcp__idea-sse-mcp__*`-style server for PyCharm/IntelliJ/WebStorm, a VS Code server, or another editor's server):
  1. Call whatever tool reports the active editor's open file(s) (pass a project-path parameter as the current working directory if the tool wants one) to get the active file path.
  2. **If it returns a usable file path** — resolve it against the project root to an absolute path and use that as the target file (handle it exactly like an explicit `<path>` argument: Read it with the Read tool in the next step).
  3. **Else, if no path comes back but the tool can supply the full text content directly** (e.g. an unsaved/untitled buffer) — take that returned text as the file content directly and skip the Read tool for this file. Since there's no on-disk path in this case, ask the user for a filename/output location before writing the explanation (step 4 needs somewhere to put the `.md` file).
  4. **If you confirm a specific server family has no tool that reports the active file at all**, record that precise capability gap under **Known MCP capability gaps** below (edit this file) — don't record a blanket "skip this server" entry, since the same server may still be useful to `/explain-selection` or other capabilities.

**Tier 3 — ask.** If Tiers 0–2 found nothing:
  1. You may still infer a target from non-tag evidence: the file most recently read, edited or discussed **in your own tool calls** this session. Do not mine the conversation for IDE tags to do this.
  2. If that's ambiguous or nothing qualifies, ask the user which file to explain — do not guess silently.
- Once resolved via path, read the file with the Read tool before doing anything else (skip this if Tier 2 step 3 already supplied the text directly).

**Known MCP capability gaps** (checked in Tier 2 — skip re-searching for these specific capabilities; add a line whenever you confirm a new one, and never write a blanket "skip this server" entry).

> If this skill is running from a **plugin install**, this file lives in a managed directory and is replaced wholesale on every plugin update, so an edit here is lost at the next update. Still make the edit — it pays for itself within the session — but also tell the user it won't survive an update and that the durable fix is a PR to the plugin repo.
- **Claude Code's built-in `ide` server** (`mcp__ide__*`) — confirmed 2026-08-16: exposes only `getDiagnostics` and `executeCode`. **No** active-file or selection tool of any kind. Don't spend a `ToolSearch` on it.
- _(JetBrains: the "list open files" tool, e.g. `get_all_open_file_paths`, works for this skill's needs on PyCharm/IntelliJ regardless of SSE/stream transport — not a gap. A gap here would be a server family whose active-file tool is missing or non-functional.)_

### 2. Guard against unexplainable targets

Before proceeding, check the resolved file against both of these — stop and report an error to the user instead of explaining it if either applies. Do not silently pick a different file or proceed anyway.

- **This skill's own output:** the filename matches `*.$.md`. This is a generated artifact (see step 5), not a source file — name the file and suggest the likely intended source (same path with `.$.md` stripped down to the original extension, if it exists nearby).
- **Binary content:** the file is not text. Judge this from the Read tool's result (e.g. it errors, refuses, or returns non-text/garbled content instead of line-numbered text — images, compiled artifacts, archives, etc. all surface this way) or an unambiguous binary extension (`.png`, `.jpg`, `.pdf`, `.zip`, `.exe`, `.pyc`, `.so`, `.dll`, `.db`, and similar). Report that the file is binary and can't be explained line by line — don't attempt to paraphrase raw bytes.
- **Explanation already exists:** compute the would-be output path (same rule as step 5: same directory/basename, extension replaced by `.$.md`) and check whether it already exists. If it does, only proceed when the user's invocation carries an explicit force signal — a flag (`--force`, `-f`) or wording in the same message like "force", "regenerate", "re-generate", "refresh", "redo", or "overwrite" (applied to this file or to explain-file generally). Absent that signal, stop and report an error: name the existing `.$.md` path and tell the user to re-invoke with `--force` (or equivalent wording) if they want it regenerated. Do not silently skip this check just because the file looks stale or the source changed — staleness alone is not a force signal.

### 3. Identify and skip the import block

Detect the file's leading import/include/using/package statements (exact syntax depends on language: `import`/`from ... import` in Python, `import`/`require` in JS/TS, `#include` in C/C++, `using` in C#, `use` in Rust, `package`/`import` in Go/Java, etc.). These lines are excluded from the line-by-line commentary entirely — do not quote or explain them individually. It's fine to mention in the overview that the file has N imports and briefly name the notable dependencies, but nothing more.

### 4. Walk the rest of the file in order

For every remaining line (or a tightly-coupled multi-line statement — e.g. a function signature spanning several lines, a multi-line object literal — treated as one unit), write an explanation covering:

- What it does, in plain terms.
- Why it's there / what role it plays in the surrounding logic (not just a restatement of the syntax).
- Anything non-obvious: side effects, mutation, edge cases, invariants it relies on or establishes, why a particular approach was chosen if inferable from context.

Do not skip lines because they look trivial (e.g. a closing brace, a simple return) — cover the whole body, but keep each explanation proportional: a one-line summary for a simple statement, a few sentences for a complex one. Don't pad simple lines with filler.

Go through the file top to bottom, exactly once. Don't reorder, group by topic, or skip around — the reader should be able to follow the markdown output alongside the source file line for line.

**Notebooks (`.ipynb`):** treat each cell as the unit of traversal. If a cell is empty (no source at all, or source that is entirely whitespace) skip it completely — do not create a section, heading, or line-number entry for it, and don't mention it in the overview. This applies regardless of cell type (code or markdown).

### 5. Write the markdown file

Output path: same directory as the source file, same base filename, with the original extension replaced by `.$.md`. If the filename has multiple suffixes (e.g. `foo.test.js`), replace only the last one (→ `foo.test.$.md`). By the time you reach this step, an existing file at that path only happens if the user gave an explicit force signal (checked in step 2) — go ahead and overwrite it, since it's a generated artifact, not hand-authored content.

If the target was resolved from text content only (no on-disk path, per step 1.3), use the filename/location the user gave you when asked, with the extension replaced by `.$.md` the same way.

Structure the markdown as:

```markdown
# <filename>

<1-3 sentence overview: what this file is, its role in the codebase, and a note on its imports (count + notable ones) — not explained line by line>

## Line-by-line

### Lines <n>–<m>
​```<language>
<the exact source line(s)>
​```
<explanation>

### Lines <n>–<m>
...
```

Use the file's actual line numbers (from the Read tool's line-numbered output) so the reader can cross-reference. Use the correct fenced-code-block language tag for the file type.

### 6. Report back

After writing the file, tell the user the output path and how many line-groups/sections it covers. Do not paste the full markdown content into the chat — the file itself is the deliverable. Do not modify the original source file.