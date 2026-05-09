# Fuseraft for VS Code

Run and manage [Fuseraft](https://github.com/fuseraft/fuseraft-cli) multi-agent orchestration without leaving your editor.

## Features

### Activity Bar Panel
A dedicated Fuseraft panel in the activity bar gives you two persistent views:

- **Sessions** — lists all past sessions from `~/.fuseraft/sessions/`, showing session ID, task preview, age, and status (complete / incomplete). The list auto-refreshes as sessions change on disk. Click an incomplete session to resume it.
- **Configs** — discovers every YAML or JSON file in your workspace that contains an `Orchestration:` key. Click any config to open it. The list updates automatically when files are added or removed.

### CodeLens on Config Files
When you open a fuseraft config, three inline actions appear above the first line:

```
▶ Run Task   ✓ Validate   ⎇ Diagram
```

### Command Palette
All commands are available via `Ctrl+Shift+P` / `Cmd+Shift+P` under the `Fuseraft:` prefix:

| Command | Description |
|---------|-------------|
| `Fuseraft: Run Task` | Prompt for a task, pick a config, and run in the integrated terminal |
| `Fuseraft: Initialize Config` | Generate a new config from a template (`dev-team`, `graph`, `brownfield`, etc.) |
| `Fuseraft: Validate Config` | Validate a config file and print results |
| `Fuseraft: Validate Config and Show Diagram` | Validate and print a Mermaid flowchart of the pipeline |
| `Fuseraft: Open REPL` | Start an interactive single-agent chat session |
| `Fuseraft: Resume Session` | Pick an incomplete session to resume |

### Status Bar
A `⊙ Fuseraft` button is always visible in the status bar. Click it to run a task.

### YAML / JSON IntelliSense
The extension ships a full JSON Schema for fuseraft config files. You get autocomplete, inline documentation, and validation for all fields — `Agents`, `Models`, `Plugins`, `Capabilities`, `Contracts`, `Routes`, `Security`, `Compaction`, and more.

Schema validation is enabled automatically for files matching `**/orchestration.json` and `**/*.fuseraft.json`. For YAML files, add this to your VS Code settings (requires the [YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)):

```json
"yaml.schemas": {
  "./node_modules/fuseraft/schemas/fuseraft-config.schema.json": [
    "**/orchestration.yaml",
    "**/*.fuseraft.yaml"
  ]
}
```

Or reference the schema inline at the top of any config file:

```yaml
# yaml-language-server: $schema=<path-to-extension>/schemas/fuseraft-config.schema.json
Orchestration:
  Name: MyTeam
  ...
```

## Requirements

- [fuseraft CLI](https://github.com/fuseraft/fuseraft-cli) must be installed and on your `PATH` (or configure the path in settings).
- VS Code 1.85 or later.

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `fuseraft.binaryPath` | `fuseraft` | Path to the fuseraft binary. Set to an absolute path if it is not on `PATH`. |
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
