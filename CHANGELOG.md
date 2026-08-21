# Changelog

## [0.1.2] — `editor-state-mcp`

- README: fixed the Claude Code plugin install commands, which pointed at the wrong marketplace
  repo and plugin name.

## [0.1.1] — `editor-state-mcp`

- Packaging fix: `.editor-state/state.json` was being bundled into the `.vsix` (it was
  gitignored but not vscodeignored). Excluded it via `.vscodeignore` so published packages never
  ship a snapshot of the packager's local editor state.

## [0.1.0] — `editor-state-mcp`

Ground-up redesign, published under a new extension id — not an upgrade of `editor-mcp-server`
0.1.1 below. The loopback HTTP MCP server is gone; in its place, the extension continuously
mirrors live editor state into a gitignored JSON file that any agent can read with zero
configuration, no ports, and no session-start ordering problem. See [design.md](design.md) for
the full rationale.

- `.editor-state/state.json`: active file, selection, cursor, open tabs, recent files — refreshed
  on every relevant editor event, debounced and coalesced.
- Survives clicking away from the editor into another panel: `activeEditor` falls back through the
  active tab to the last known editor, and `lastDeliberateSelection` preserves the last real
  selection independently of live focus state.
- A heartbeat file outside the workspace lets a reader distinguish "idle" from "the editor host
  crashed."
- `excludeGlobs` keeps the *contents* of sensitive files (`.env`, `*.pem`, `*.key`, ...) out of the
  mirror entirely, while still recording the path and selected range.
- One-time prompt to add the state directory to `.gitignore`; never edits a tracked file silently.
- Zero runtime dependencies.
- Bundles `/explain-selection` and `/explain-file` as a Claude Code plugin, both reading the state
  file as their primary source ahead of any connected editor MCP server or asking the user.

## [0.1.1] — `editor-mcp-server` (predecessor)

Initial public release.

- MCP server hosted in the extension host, served over Streamable HTTP on loopback.
- Read tools: `get_active_file`, `get_selection`, `get_open_tabs`, `get_diagnostics`,
  `get_workspace_folders`.
- Write tools: `create_file`, `edit_file`, `open_file`, `save_file`, `close_file`.
- Per-window discovery files at `~/.vscode-editor-mcp/<pid>.json` so multiple windows
  can run side by side.
- Bearer token auth, Origin/Host validation, loopback-only binding.
- Status bar indicator showing port and live client count.
- Optional registration with VS Code's built-in MCP client for Copilot agent mode.
