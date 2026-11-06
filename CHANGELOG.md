# Changelog

## Unreleased

### Chat
- **Open REPL** is now **Open Chat**, and the panel, the resume picker and messages say "chat" instead of "REPL", as the Chats view already does. The command ID (`fuseraft.repl`) is unchanged, so keybindings keep working.

## 0.9.0 — 2026-11-05

### Chat
- While fuseraft works, **Send** holds a message as a chip above the prompt until the work is done. The chip's send arrow (or Ctrl+Enter) hands it to the model at its next call, after its current tool calls or as the next turn of a `/goal` run starts, without stopping anything; its pencil takes it back into the prompt.
- The panel no longer treats the end of each `/goal` turn as the end of the run, so `/hitl on|off` and `/title` apply at once for the whole run instead of being sent as ordinary input.

## 0.8.2 — 2026-11-04

### New chat
- The logo, starters and sandbox note sit centered in the panel instead of pressed against the prompt under empty space.
- Starter cards (Continue, Explain, Review) stay at most 560px wide, so a wide panel no longer stretches them edge to edge.

## 0.8.1 — 2026-11-04

### Chat
- The chat column is wider in a wide panel: messages and the prompt now go up to 960px instead of 680px.

## 0.8.0 — 2026-11-04

### Setup
- Redesigned setup screen: numbered steps (CLI, provider, API key, model), provider tiles instead of a dropdown, and a footer with Test and Save that stays in view.
- The API key comes before the model, since loading the model list needs it. Show/Hide, a **Get a key** link for each provider, and a note instead of a key field for Ollama.
- The model list refreshes from the provider with one button and says where its models came from.
- A missing CLI locks the other steps behind a single **Install the CLI** button.

### Fixes
- Test and Load models no longer send a saved key to a different provider or server than the one it was saved for. With fuseraft CLI 1.17.0 or later, a key is looked up for the server you're testing.
- A model list loaded for one provider no longer shows up under another after the screen refreshes.
- A refused connection says why ("Nothing answered at http://localhost:11434/v1. Is the server running?") instead of showing an empty error.
- The CLI version shows as `1.16.0` instead of the full build string.

## 0.7.0 — 2026-11-02

### First run
- With no model configured, New Chat, Open REPL, Add to Chat and the status bar button open setup instead of a chat you can't type in.
- If the CLI exits before the chat is ready (missing API key, CLI not installed), the panel shows the error and an **Open Setup** button.
- Test Connection works without a model: it lists the provider's models and fills the model dropdown.

### Starting a chat
- One prompt, docked at the bottom from the start, with attachments always available.
- An empty chat offers starters based on what's open: **Explain `<file>`**, **Review my uncommitted changes**, and **Continue "<title>"** to resume the last chat in place.
- A line under the starters says where the agent may work, or warns when `repl.yolo` turns the sandbox off.
- The conversation and prompt share a centered column, so lines no longer stretch across a wide panel.

### New
- **Fix with fuseraft**: a quick fix (light bulb or Ctrl+.) on errors and warnings that puts the problem and the surrounding code in the prompt.
- The status bar item follows the chat: model and context use when idle, a spinner while working, and a highlighted "approval needed" or "question for you".
- **Export to Markdown** on a chat's right-click menu in the Chats view.

### Fixes
- Google model listing never worked; Ollama's default `/v1` endpoint listed from the wrong path.
- Loading models no longer wipes an endpoint you just typed.
- Test Connection uses the saved API key when the key field is blank.
- Reply blocks are no longer each boxed inside the reply; the trailing dash after each reply is gone.

## 0.6.0 — 2026-11-02

### Working with your code
- **Add to Chat** (Ctrl+Shift+Alt+A, or the editor's right-click menu) puts the selected code in the message, or attaches the file when nothing is selected.
- **Add File to Chat** on the Explorer and editor tab menus; Shift+drop onto the panel.
- The active file shows as a chip above the prompt and is sent with each message, with its selected lines (`fuseraft.includeActiveFile`; click the chip to toggle).
- File paths in replies open at their line; code blocks can be inserted at the cursor or opened in a new editor.
- Ctrl+Shift+Alt+F opens the chat, and from the chat goes back to your file.

### Keeping the chat
- A chat open when the window reloads or VS Code restarts is resumed in its tab.
- A chat tab left behind by an extension host restart is replaced by one that resumes the same chat.

### Fixes
- Opening a chat from the editor could leave the prompt disabled.
- /commands and $skills sent with attached context were treated as plain prompts.
- Replayed turns, input history and the Chats view showed the attached context.

## 0.5.2 — 2026-10-31
- Published to [Open VSX](https://open-vsx.org/extension/fuseraft/fuseraft) as well as the VS Code Marketplace.
- New banner and README introduction.

## 0.5.1 — 2026-10-30
- The Marketplace description now leads with model choice.

## 0.5.0 — 2026-10-30
- Docs: memories are saved with `/memory save` (or with `memory.autoSave` on), not automatically.

## 0.4.0 — 2026-10-30
- A tool line counts up while the call runs and shows how long it took.
- Alt+↑/↓ jump between your messages.
- ↑ on an empty prompt takes back the last queued message; stopping a turn drops what was queued.
- Large pastes fold into `[pasted #N · X lines]`, are sent in full, and can be viewed with Ctrl+O.
- Ctrl+G opens the draft in an editor tab; each save puts it back.
- The status line shows the session's tokens and the share of input served from cache.

## 0.3.0 — 2026-10-28
- **Rename Chat** (right-click or F2, in the Chats view or the panel); chats without a title show the CLI's generated one.
- `/title` and `/hitl on|off` run immediately instead of waiting for the reply to finish.
- A command sent mid-reply no longer ends up below the finished reply.
- The prompt keeps its text, caret and wrapping consistent; Up/Down only recall history from the first/last line.
- README rewritten around getting started.

## 0.2.0 — 2026-10-27
The extension is now a single chat experience; multi-agent orchestration stays in the CLI.
- The sidebar is now **Chats** (this workspace's saved sessions: click to resume, + for a new chat), **Memory** and **Skills**.
- Open REPL starts with the configured model; switch models from the panel header.
- Turns read like the terminal REPL: folding thinking, a ✓/✗ line per tool call, nested subagent calls, and inline approvals.
- Type while a turn runs: messages join the turn, commands wait as chips until the REPL is ready.
- Status line, Ctrl+O output viewer, ↑/↓ and Ctrl+R history, `@path` suggestions, `!` shell output, `/copy`, Ctrl+F find, and a notification when a reply or approval is waiting.

## 0.1.39 – 0.1.52 — 2026-09-06 to 2026-09-30
- Approval prompts for file, shell, git and HTTP tools, anchored above the prompt.
- `write_file` / `patch_file` approvals open as native VS Code diff tabs.
- Replies stream one block at a time, with a copy button on code blocks.
- Paste or attach images; answer `ask_user` questions in the panel.
- Resumed sessions replay their last turns.
- Per-turn token usage on hover; extra workspace folders passed to the CLI.
- Bold command highlighting and Tab completion, including `/mcp login|logout` and `/goal drop`.
- Fixed: provider setup no longer overwrites other settings in `~/.fuseraft/config`.

## 0.1.0 – 0.1.38 — 2026-05-09 to 2026-08-02
- REPL chat panel with live Markdown rendering, a stop button, a model dropdown and session resume.
- Provider setup screen with API keys in VS Code SecretStorage and the OS keychain, live model lists, and Ollama and self-hosted endpoints.
- Installs and updates the fuseraft CLI from the extension.
- Memory and Skills views; `FUSERAFT_HOME` support.
- Orchestration task panel, config wizard and session views (removed in 0.2.0).
