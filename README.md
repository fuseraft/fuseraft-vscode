# fuseraft for VS Code

![fuseraft banner](media/fuseraft-banner.png)

Run and manage [fuseraft](https://github.com/fuseraft/fuseraft-cli) without leaving your editor.

## Features

### Activity Bar Panel

A dedicated fuseraft panel in the activity bar gives you four persistent views:

**Run Task** — a webview form for composing and launching tasks:
- Multi-line textarea for your task description (paste prose, markdown specs, or bullet lists)
- **+ Files** button — attach one or more files as context. Each attached file is passed to the CLI via `--context-file` and its content is appended to the task. Attached files appear as removable chips below the textarea.
  - PDF, DOCX, PPTX, and XLSX files are automatically extracted to plain text by the CLI — attach documents directly without any manual conversion.
  - **Note:** Use the **+ Files** button to attach files. Dragging files from the VS Code Explorer panel or from an OS file manager (Windows Explorer, Finder, Nautilus, etc.) into the task area is not supported — VS Code intercepts file drags at the window level before they reach the sidebar panel.
- **+ Spec** button — attach a single spec file (Markdown, plain text, or JSON) passed to the CLI via `--spec`. The spec is injected into every agent's system prompt as the authoritative source of truth and appended to the task at turn 0. Unlike `--context-file`, the spec survives context compaction. The attached spec appears as a removable chip below the attach bar and is cleared on run.
- Config dropdown auto-populated from configs found in your workspace
- Checkboxes for common flags:
  - **Human-in-the-loop** (`--hitl`) — pause after every agent turn to review or redirect
  - **Show tool calls** (`--tools`) — print tool invocations inline in the output
  - **Verbose** (`--verbose`) — enable debug logging and token counts
  - **Snapshot** (`--snapshot`) — capture per-turn postmortem snapshots to `~/.fuseraft/snapshots/<project>/<session>/` (`turns.jsonl` for agent messages and tool calls, `manifest.json` for the run summary)
- **Run Task** button (`Ctrl+Enter`) — opens a dedicated terminal named after the first 40 characters of your task. Multiple tasks can run simultaneously, each in their own terminal.
- **Run Task File…** button — opens a file picker to select a `.md` or `.txt` task file

**Sessions** — lists sessions from `~/.fuseraft/sessions/` scoped to the current workspace (filtered by config path). Shows session ID, task preview, age, and status. The list auto-refreshes as sessions change on disk.
- Click an incomplete session to resume it in the terminal
- Click the preview icon or right-click → **View Session Transcript** to open a formatted transcript panel for any session (complete or incomplete)
- Right-click → **Open Session Config** to jump to the config used for a session
- Right-click → **Delete Session** to permanently remove a session

**Configs** — discovers every YAML or JSON file in your workspace that contains an `Orchestration:` key. Click any config to open it. The list updates automatically when files are added or removed. Click **+** in the toolbar to run the Initialize Config wizard.

**Context** — manages reference material that agents can access during sessions. Items are stored in `.fuseraft/context/` relative to your workspace root and auto-refresh when the index changes.
- Click **+** in the toolbar or right-click → **Add Context** to import a file or folder. You will be prompted for an optional name (defaults to the filename) and description.
- Right-click any item → **Remove Context Item** to delete it and its copied files
- Hover over an item to see its source path, import time, and file count

### Session Transcript Viewer

Click the preview icon next to any session to open a rich transcript panel showing:
- Session metadata: ID, task, config path, start time, completion status
- Every agent turn as a card with a color-coded header per agent
- Tool calls with ✓ / ✗ status indicators and argument summaries (click the label to collapse)
- Per-turn token usage (input / output) and cost
- Session-level totals: turn count, total tokens, total cost

### REPL Chat Panel

Run `fuseraft: Open REPL` (`Ctrl+Shift+P`) to open an interactive chat panel beside your editor. Select a model from the quick-pick (or use the configured default) and start chatting immediately.

The panel communicates with the fuseraft CLI over a JSON bridge — no terminal window required:

- **Streaming responses** — tokens appear word-by-word as the model generates them
- **Tool call badges** — each tool invoked during a turn appears as a small badge above the response
- **Markdown rendering** — the final response is rendered with headers, bold/italic, code blocks, and lists
- **Slash commands** — type `/tools`, `/plan`, `/execute`, `/sessions`, `/help`, etc. directly in the input box
- **Resumable sessions** — pass `--resume <id>` via the extension or reopen a session from the sessions tree; session snapshots are stored at `~/.fuseraft/repl-sessions/`
- **Shift+Enter** for multi-line input; **Enter** to send

The panel stays open across tab switches (`retainContextWhenHidden`). Closing the panel kills the underlying CLI process and ends the session.

### CodeLens on Config Files

When you open a fuseraft config, three inline actions appear above the first line:

```
▶ Run Task   ✓ Validate   ⎇ Diagram
```

### Right-Click Menus

**Config files** (`orchestration.yaml`, `*.fuseraft.yaml`, etc.) — right-click in the file explorer or inside the editor:
- **Run Task with This Config**
- **Validate Config**
- **Validate Config and Show Diagram**

**Task files** (`.md`, `.txt`) — right-click in the file explorer or inside the editor:
- **Run Task File with fuseraft** — runs `fuseraft run -f <file>`, prompting for a config if multiple are found

### Command Palette

All commands are available via `Ctrl+Shift+P` / `Cmd+Shift+P` under the `fuseraft:` prefix:

| Command | Description |
|---------|-------------|
| `fuseraft: Run Task` | Prompt for a task, pick a config, and run in the integrated terminal |
| `fuseraft: Run Task File with fuseraft` | Run a `.md` or `.txt` task file with `fuseraft run -f` |
| `fuseraft: Initialize Config` | 4-step wizard: template, model, provider endpoint, output path |
| `fuseraft: Validate Config` | Validate a config file and print results |
| `fuseraft: Validate Config and Show Diagram` | Validate and print a Mermaid flowchart of the pipeline |
| `fuseraft: Open REPL` | Open a chat panel with a single-agent REPL session (streaming responses, tool call badges, markdown rendering) |
| `fuseraft: Resume Session` | Pick an incomplete session to resume |
| `fuseraft: View Session Transcript` | Open a formatted transcript for a session |
| `fuseraft: Add Context` | Import a file or folder into the session context store |
| `fuseraft: Remove Context Item` | Remove a context item and delete its copied files |
| `fuseraft: Set Up Provider` | Configure your AI provider, model, API key, and binary path |

### Initialize Config Wizard

`fuseraft: Initialize Config` walks through four steps:

1. **Template** — choose from all available templates:

   | Template | Description |
   |----------|-------------|
   | `solo` | Single capable agent with investigation tooling and lossless compaction — the right starting point for simple tasks |
   | `pipeline` | Planner → Developer → Tester → Reviewer as a directed graph with investigation tooling — no evidence contracts |
   | `swe` | Planner → PlannerCritic → Developer → Tester → Reviewer — full safeguards: evidence contracts, hypothesis tracking, periodic Verifier, lossless compaction |
   | `greenfield` | Planner → Developer → Tester → Reviewer — optimised for new projects: no PlannerCritic, no Verifier, greenfield-aware Planner, larger Developer context window |
   | `brownfield` | Archaeologist recons the codebase once → Planner → Developer → Reviewer as a graph; multi-target back-edges for revision and replan |
   | `research` | Researcher gathers cited findings → Critic adversarially reviews for gaps → Writer synthesises the final document |
   | `data` | DataEngineer fetches and structures data → Analyst computes findings → Reporter synthesises a final document |
   | `devops` | OpsPlanner writes an ops plan with rollback_command → Executor runs steps → Verifier health-checks; can trigger rollback |
   | `debate` | Proposer argues a position → Challenger critiques adversarially → Moderator synthesises a structured final verdict |
   | `audit` | Auditor scans for security / quality / compliance issues → Prioritizer triages by severity → Developer fixes → Verifier confirms |
   | `magentic` | AI-managed team: a manager LLM plans and coordinates 5 specialist workers dynamically; user approves the plan before execution |

2. **Model** — pick from common models across all providers, use auto-detection, or type any model ID
3. **Provider endpoint** — pick a known provider URL, use your saved default, or enter a custom URL
4. **Output path** — defaults to `.fuseraft/config/orchestration.yaml`, fully editable

The generated config file opens automatically in the editor as soon as fuseraft writes it to disk.

### Set Up Provider

`fuseraft: Set Up Provider` runs automatically on first use when the fuseraft binary is not found or when `~/.fuseraft/config` is missing or incomplete. You can also invoke it at any time from the command palette.

It opens a **Set Up Provider** panel — a single form with all fields visible at once:

- **Binary** — path to the fuseraft binary. Click **Browse…** to pick one from disk, or **Validate** to verify the current path. The panel shows the detected version inline.
- **Preset** — choose from Anthropic, OpenAI, xAI, Google, Mistral, DeepSeek, or Custom / Self-hosted. Selecting a preset auto-fills the endpoint URL and suggests models, but both fields remain fully editable.
- **Endpoint URL** — the provider's API base URL.
- **Model** — the model ID to use. Typing opens suggestions for the selected provider, or enter any ID directly.
- **API Key** — paste your key. Stored in VS Code's secure storage (backed by the OS credential store). The extension injects the key as `FUSERAFT_API_KEY` into every terminal it opens and passes `--vscode` to the CLI so it reads the key from that variable instead of the OS keychain. The key is never written to disk in plain text.

Click **Test Connection** to verify the key against the provider — the result appears inline without leaving the form. Click **Save** when ready.

### Status Bar

A `fuseraft` button is always visible in the status bar. Click it to run a task.

### YAML / JSON IntelliSense

The extension ships a full JSON Schema for fuseraft config files. You get autocomplete, inline documentation, and validation for all fields — `Agents`, `Models`, `Plugins`, `Capabilities`, `Contracts`, `Routes`, `Security`, `Compaction`, and more.

Schema validation is enabled automatically for files matching `**/orchestration.json` and `**/*.fuseraft.json`. For YAML files, add this to your VS Code settings (requires the [YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)):

```json
"yaml.schemas": {
  "<extension-path>/schemas/fuseraft-config.schema.json": [
    "**/orchestration.yaml",
    "**/*.fuseraft.yaml"
  ]
}
```

Or reference the schema inline at the top of any config file:

```yaml
# yaml-language-server: $schema=<extension-path>/schemas/fuseraft-config.schema.json
Orchestration:
  Name: MyTeam
  ...
```

## Requirements

- [fuseraft CLI](https://github.com/fuseraft/fuseraft-cli) must be installed and on your `PATH` (or its path set in extension settings).
- VS Code 1.85 or later.

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `fuseraft.binaryPath` | `fuseraft` | Path to the fuseraft binary. Can be absolute (e.g. `/usr/local/bin/fuseraft`) or relative. If not on `PATH`, set to an absolute path. The extension validates this on startup and prompts to configure if invalid. |
| `fuseraft.defaultConfigPath` | _(blank)_ | Default config path relative to workspace root. Leave blank to be prompted each time. |
| `fuseraft.runFlags` | _(blank)_ | Extra flags appended to every `fuseraft run` invocation (e.g. `--tools --verbose`). |
| `fuseraft.openTerminalOnRun` | `true` | Focus the integrated terminal when a task starts. |

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

To package:

```bash
npx vsce package
```

## License

MIT
