# Editor State

> **⚠️ This README describes the removed 0.1.x extension and is being rewritten.**
>
> The MCP server documented below — the loopback HTTP listener and its tools — has been
> **deleted**. It worked, but it could never be relied on: the server was off by default,
> bound a dynamic port, rotated its auth token every start, and Claude Code only resolves
> MCP servers at session start, so its tools were usually absent when a skill needed them.
>
> The replacement mirrors editor state into a gitignored JSON file that any agent can
> simply read — no port, no token, no configuration, nothing to restart. See
> [design.md](design.md); this file is rewritten in M4.

Exposes your live VS Code editor state to any MCP client — Claude Code, custom agents,
or VS Code's own Copilot agent mode.

VS Code can *consume* MCP servers, but it doesn't *publish* one. This extension adds
that side: a Model Context Protocol server running inside the extension host, listening
on loopback, with tools backed by the real `vscode` API.

Agents get the buffers you're actually looking at — including unsaved changes, your
current selection, and language-server diagnostics — instead of re-reading files from disk.

## Tools

| Tool | What it does |
| --- | --- |
| `get_active_file` | Focused file: path, language, dirty state, content or line window |
| `get_selection` | Selected text and range, including multi-cursor |
| `get_open_tabs` | Every tab across all editor groups, with kind and dirty state |
| `get_diagnostics` | Errors and warnings from the language server, per file or workspace |
| `get_workspace_folders` | Roots open in this window |
| `create_file` | Create a file with content |
| `edit_file` | `replace_text`, `replace_range`, `insert` or `overwrite` |
| `open_file` | Open and reveal a file, optionally selecting a range |
| `save_file` | Flush a buffer to disk |
| `close_file` | Close tabs, refusing to discard unsaved work by default |

Lines and columns are 1-based. Paths may be absolute or workspace-relative.

## Getting started

1. Run **Editor MCP: Start Server** from the Command Palette.
2. Click the `$(broadcast) MCP` status bar item → **Copy "claude mcp add" command**.
3. Paste it into a terminal.

```
claude mcp add --transport http vscode-myproject http://127.0.0.1:54321/mcp \
  --header "Authorization: Bearer <token>"
```

The status bar shows the port and how many clients are attached.

## Multiple windows

Each VS Code window runs its own server on its own OS-assigned port, because "the active
file" only means something per window. On start, each window writes a discovery file to
`~/.vscode-editor-mcp/<pid>.json`:

```json
{
  "url": "http://127.0.0.1:54321/mcp",
  "token": "…",
  "workspaceFolders": ["/home/you/project"],
  "pid": 4242
}
```

Clients that want to auto-attach should match their working directory against
`workspaceFolders`. Stale files from crashed hosts are pruned on next start.

## Security

This extension opens a local port that can read and write your files. It is built to be
boring about that:

- **Loopback only.** Binding a non-loopback address is not supported, not just discouraged.
- **Bearer token** regenerated on every start, written to the discovery file with `0600`.
- **Origin and Host validation** on every request, so a web page in your browser cannot
  reach the server via DNS rebinding.
- **Edits go through the undo stack** and stay unsaved unless a tool is asked to save, so
  you can see and revert anything an agent did.
- **Off by default.** The server does not start until you start it, unless you enable
  `vscodeEditorMcp.autoStart`.

Set `vscodeEditorMcp.allowWrite` to `false` to remove the mutating tools entirely — they
are not registered, so they don't appear in the client's tool list at all.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `vscodeEditorMcp.autoStart` | `false` | Start on window open |
| `vscodeEditorMcp.port` | `0` | `0` auto-assigns; required for multi-window |
| `vscodeEditorMcp.host` | `127.0.0.1` | Loopback interface |
| `vscodeEditorMcp.allowWrite` | `true` | Register mutating tools |
| `vscodeEditorMcp.requireAuth` | `true` | Require a bearer token |
| `vscodeEditorMcp.maxFileBytes` | `1048576` | Cap on returned content |
| `vscodeEditorMcp.sessionIdleMinutes` | `30` | Reap sessions with no activity |
| `vscodeEditorMcp.registerWithCopilot` | `true` | Advertise to VS Code's MCP client |
| `vscodeEditorMcp.discoveryDir` | `~/.vscode-editor-mcp` | Where discovery files go |

## Development

```bash
npm install
npm run watch     # then press F5 to launch an Extension Development Host
npm run smoke     # transport, auth and tool-registration checks (no editor needed)
npm run package   # build a .vsix
```

## License

MIT
