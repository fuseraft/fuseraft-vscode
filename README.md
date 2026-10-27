# fuseraft for VS Code

![fuseraft banner](media/fuseraft-banner.png)

Chat with a [fuseraft](https://github.com/fuseraft/fuseraft-cli) agent in an interactive REPL panel, right in your editor.

[Docs](https://fuseraft.ai/fuseraft-cli/) · [GitHub](https://github.com/fuseraft/fuseraft-cli)

## Features

### REPL Chat Panel

`fuseraft: Open REPL` (or the `fuseraft` status bar button) opens an interactive chat panel beside your editor, using the model from your provider setup.

![fuseraft REPL](media/fuseraft-repl.png)

It works like the CLI's full-screen REPL:

- **The turn as it happens** — the model's thinking streams in dimmed under `∴` and folds into one line once it moves on; each tool call is a line that turns ✓ or ✗ when its result comes back (a failure shows its first line), a subagent's calls are nested under it and tagged with its name, and each changed file shows as `✎ path +added -removed` (click to open it). Long turns keep the latest steps in view.
- **Output viewer** — click a tool line for its arguments and output, or press **Ctrl+O** for the last 100 tool outputs, thoughts and shell outputs in full (←/→ to move, **Open in Editor** for a tab)
- **Type while it works** — a message sent during a turn joins it (the model reads it after its current tool calls); a `/command`, `!command` or `$skill` waits as a chip above the prompt until the turn ends
- **Status line** — model, turn, how full the context is (green, yellow as auto-compaction nears, red once past it), active modes such as `hitl`, and a timer while something runs
- **Completions** — `/commands` and their subcommands, `$skills`, and `@paths` (one level down first, then files anywhere by name; git-ignored files and `.env` aren't offered). A mention attaches the file to your message.
- **History** — ↑/↓ walk what you've sent, **Ctrl+R** searches it
- **Approvals** — HITL prompts appear above the prompt; file writes open a real diff. Answer with **y**/**n** (or Esc to deny) when you're not typing.
- **`!` shell escape** — `!git status` runs the command yourself (unsandboxed, never shown to the model) and streams its output into the panel
- **Find** — **Ctrl+F** searches the conversation
- **Notifications** — when a reply finishes or an approval or question waits while you're elsewhere (`fuseraft.notifications` turns them off)
- **Model dropdown** — switch models live from the header; list is fetched from your provider via `fuseraft models`, history is preserved
- **Markdown rendering** — headers, bold/italic, links, images, blockquotes, horizontal rules, code blocks with a one-click copy button, tables, lists; `/copy` puts the last reply on the clipboard
- **Images** — paste a screenshot into the message box, or attach a file with the paperclip
- **Stop** — the Stop button or **Ctrl+C** interrupts the turn; press again to kill commands it's stuck waiting on
- **Resumable sessions** — snapshots stored at `~/.fuseraft/repl-sessions/`; resuming replays the last few turns
- **Enter** sends; **Shift+Enter** or **Alt+Enter** for a new line; **PgUp/PgDn** scroll, **Ctrl+End** follows new output again

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

- [fuseraft CLI](https://github.com/fuseraft/fuseraft-cli) installed and on your `PATH` (thinking, tool results, the status line, typing during a turn and `!` need a CLI release from this version on; an older one still works, with less detail)
- VS Code 1.85 or later

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `fuseraft.binaryPath` | `fuseraft` | Path to the fuseraft binary |
| `fuseraft.homeDir` | _(blank)_ | Override the fuseraft home directory (`~/.fuseraft` by default); matches the CLI's `FUSERAFT_HOME` |
| `fuseraft.notifications` | `true` | Notify when a reply finishes, or an approval or question waits, while you're away from the panel |

## Development

```bash
npm install && npm run compile
```

Press `F5` to launch an Extension Development Host. To package: `npx vsce package`.

## License

MIT
