# fuseraft for VS Code

![fuseraft banner](media/fuseraft-banner.png)

Chat with a [fuseraft](https://github.com/fuseraft/fuseraft-cli) agent in an interactive REPL panel, right in your editor.

[Docs](https://fuseraft.ai/fuseraft-cli/) · [GitHub](https://github.com/fuseraft/fuseraft-cli)

## Features

### REPL Chat Panel

`fuseraft: Open REPL` (or the `fuseraft` status bar button) opens an interactive chat panel beside your editor, using the model from your provider setup.

![fuseraft REPL](media/fuseraft-repl.png)

- **Model dropdown** — switch models live from the header; list is fetched from your provider via `fuseraft models`, history is preserved
- **Streaming responses** — one thought at a time live, each replacing the last as the next begins; the full response reveals in full, broken into bordered blocks, once it's done
- **Tool call badges** — click to expand arguments, hover for a summary
- **Diff approvals** — with HITL on, file writes and patches open as a real diff before you approve them
- **Markdown rendering** — headers, bold/italic, links, images, blockquotes, horizontal rules, code blocks with a one-click copy button, tables, lists
- **Stop button** — interrupt mid-stream and immediately redirect
- **Slash commands** — `/plan`, `/execute`, `/goal`, `/compact`, `/tools`, `/help`, and more
- **File change summary** — files added, modified, renamed, or deleted appear below each response
- **Shift+Enter** for multi-line input; **Enter** to send

### Activity Bar Panel

A dedicated fuseraft panel with three views:

**Chats** — your saved REPL sessions for the current workspace, newest first. Click one to resume it (the last few turns are replayed); **+** starts a new chat; right-click to delete. Sessions are saved after every turn to the fuseraft home's `repl-sessions/` directory.

**Memory** — lists entries from `~/.fuseraft/memory/repl`, grouped by type with each entry's description shown inline. Click to open the entry's markdown file; right-click to delete one entry or clear them all.

**Skills** — lists skills discovered under the fuseraft home's `skills/` directory. Click to open `SKILL.md`; **+** to add a skill, right-click to remove one.

### Command Palette

| Command | Description |
|---------|-------------|
| `fuseraft: Open REPL` | Show the open chat, or start one |
| `fuseraft: New Chat` | Start a fresh chat (the current one stays resumable) |
| `fuseraft: Resume Chat` | Pick any saved REPL session and resume it |
| `fuseraft: Refresh Chats` | Reload the Chats view |
| `fuseraft: Delete Memory` | Delete a memory entry |
| `fuseraft: Delete All Memories` | Delete every memory entry |
| `fuseraft: Add Skill` | Add a skill to the fuseraft home's `skills/` directory |
| `fuseraft: Remove Skill` | Remove a skill |
| `fuseraft: Install CLI` | Run the fuseraft installer in the integrated terminal |
| `fuseraft: Update CLI` | Update the fuseraft CLI to the latest release |
| `fuseraft: Set Binary Path` | Pick or enter the path to the fuseraft binary |
| `fuseraft: Set Home Directory` | Override the fuseraft home directory (`~/.fuseraft` by default) |
| `fuseraft: Configure fuseraft` | Configure your AI provider, model, and API key |

Multi-agent orchestration (`fuseraft run`, `init`, `validate`, sessions) lives in the CLI — run it from a terminal.

## Requirements

- [fuseraft CLI](https://github.com/fuseraft/fuseraft-cli) installed and on your `PATH`
- VS Code 1.85 or later

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `fuseraft.binaryPath` | `fuseraft` | Path to the fuseraft binary |
| `fuseraft.homeDir` | _(blank)_ | Override the fuseraft home directory (`~/.fuseraft` by default); matches the CLI's `FUSERAFT_HOME` |

## Development

```bash
npm install && npm run compile
```

Press `F5` to launch an Extension Development Host. To package: `npx vsce package`.

## License

MIT
