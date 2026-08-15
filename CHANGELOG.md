# Changelog

## [0.1.1]

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
