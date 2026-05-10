import * as vscode from 'vscode';
import { ConfigInfo, findFuseraftConfigs, getBinary, getRunFlags, runInTerminal, buildRunCommand } from './fuseraftUtils';

export class TaskPanelProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'fuseraft.taskPanel';

    private _view?: vscode.WebviewView;

    constructor(private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._html(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'ready' || msg.type === 'refreshConfigs') {
                const configs = await findFuseraftConfigs();
                webviewView.webview.postMessage({ type: 'configs', configs });
            } else if (msg.type === 'run') {
                this._run(msg);
            } else if (msg.type === 'browseTaskFile') {
                await this._browseTaskFile(msg.configPath, msg.flags);
            }
        });
    }

    async refresh(): Promise<void> {
        if (!this._view) { return; }
        const configs = await findFuseraftConfigs();
        this._view.webview.postMessage({ type: 'configs', configs });
    }

    private _run(msg: { task: string; configPath: string; flags: Record<string, boolean> }): void {
        const { task, configPath, flags } = msg;
        if (!task.trim()) { return; }

        const extra = [
            flags.hitl    ? '--hitl'    : '',
            flags.tools   ? '--tools'   : '',
            flags.verbose ? '--verbose' : '',
            flags.devui   ? '--devui'   : '',
            getRunFlags(),
        ].filter(Boolean).join(' ');

        const label = task.split('\n')[0].trim().slice(0, 40) || 'Task';
        runInTerminal(buildRunCommand(getBinary(), task, configPath || undefined, extra || undefined), `Fuseraft — ${label}`);
    }

    private async _browseTaskFile(configPath: string, flags: Record<string, boolean>): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Task files': ['md', 'txt'] },
            title: 'Select task file',
        });
        if (!uris?.[0]) { return; }

        const extra = [
            flags.hitl    ? '--hitl'    : '',
            flags.tools   ? '--tools'   : '',
            flags.verbose ? '--verbose' : '',
            flags.devui   ? '--devui'   : '',
            getRunFlags(),
        ].filter(Boolean).join(' ');

        const configFlag = configPath ? ` -c '${configPath}'` : '';
        const flagStr = extra ? ` ${extra}` : '';
        runInTerminal(`${getBinary()} run${configFlag}${flagStr} -f '${uris[0].fsPath}'`);
    }

    private _html(webview: vscode.Webview): string {
        const nonce = nid();
        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

label {
    display: block;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 4px;
}

textarea {
    width: 100%;
    min-height: 120px;
    resize: vertical;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    padding: 6px 8px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    line-height: 1.5;
    outline: none;
}
textarea:focus {
    border-color: var(--vscode-focusBorder);
}
textarea::placeholder {
    color: var(--vscode-input-placeholderForeground);
}

select {
    width: 100%;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 2px;
    padding: 4px 6px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    outline: none;
    cursor: pointer;
}
select:focus { border-color: var(--vscode-focusBorder); }

.flags {
    display: flex;
    flex-direction: column;
    gap: 5px;
}
.flag-row {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
}
.flag-row input[type=checkbox] { cursor: pointer; accent-color: var(--vscode-checkbox-background); }
.flag-row span { font-size: var(--vscode-font-size); }
.flag-desc {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-left: 20px;
}

.actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}

button {
    border: none;
    border-radius: 2px;
    padding: 5px 10px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    cursor: pointer;
    white-space: nowrap;
}
button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    flex: 1;
}
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
}
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: 0.5; cursor: not-allowed; }

.section { display: flex; flex-direction: column; gap: 4px; }

.config-row {
    display: flex;
    gap: 4px;
    align-items: center;
}
.config-row select { flex: 1; }
.config-row button { padding: 4px 7px; font-size: 13px; }
</style>
</head>
<body>

<div class="section">
    <label>Task</label>
    <textarea id="task" placeholder="Describe the task for your agent team…&#10;&#10;You can paste a full spec, bullet list, or prose."></textarea>
</div>

<div class="section">
    <label>Config</label>
    <div class="config-row">
        <select id="config"><option value="">⟳ Loading configs…</option></select>
        <button class="secondary" id="refreshBtn" title="Refresh config list">↺</button>
    </div>
</div>

<div class="section">
    <label>Options</label>
    <div class="flags">
        <div>
            <label class="flag-row"><input type="checkbox" id="hitl"><span>Human-in-the-loop</span></label>
            <div class="flag-desc">Pause after every agent turn to review or redirect</div>
        </div>
        <div>
            <label class="flag-row"><input type="checkbox" id="tools"><span>Show tool calls</span></label>
            <div class="flag-desc">Print tool invocations inline in the output</div>
        </div>
        <div>
            <label class="flag-row"><input type="checkbox" id="verbose"><span>Verbose</span></label>
            <div class="flag-desc">Enable debug logging and token counts</div>
        </div>
        <div>
            <label class="flag-row"><input type="checkbox" id="devui"><span>DevUI</span></label>
            <div class="flag-desc">Open real-time session visualization in browser</div>
        </div>
    </div>
</div>

<div class="actions">
    <button class="primary" id="runBtn">▶  Run Task</button>
    <button class="secondary" id="fileBtn">Run Task File…</button>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();

const taskEl    = document.getElementById('task');
const configEl  = document.getElementById('config');
const runBtn    = document.getElementById('runBtn');
const fileBtn   = document.getElementById('fileBtn');
const refreshBtn = document.getElementById('refreshBtn');

function getFlags() {
    return {
        hitl:    document.getElementById('hitl').checked,
        tools:   document.getElementById('tools').checked,
        verbose: document.getElementById('verbose').checked,
        devui:   document.getElementById('devui').checked,
    };
}

runBtn.addEventListener('click', () => {
    const task = taskEl.value.trim();
    if (!task) { taskEl.focus(); return; }
    vscode.postMessage({ type: 'run', task, configPath: configEl.value, flags: getFlags() });
    const prev = runBtn.textContent;
    runBtn.textContent = '✓ Started';
    runBtn.disabled = true;
    setTimeout(() => { runBtn.textContent = prev; runBtn.disabled = false; }, 1500);
});

fileBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'browseTaskFile', configPath: configEl.value, flags: getFlags() });
});

refreshBtn.addEventListener('click', () => {
    configEl.innerHTML = '<option value="">⟳ Refreshing…</option>';
    vscode.postMessage({ type: 'refreshConfigs' });
});

taskEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { runBtn.click(); }
});

window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'configs') {
        const configs = msg.configs;
        configEl.innerHTML = configs.length
            ? '<option value="">— no config (use default) —</option>' +
              configs.map(c => \`<option value="\${c.fsPath}">\${c.workspaceRelative}</option>\`).join('')
            : '<option value="">No configs found in workspace</option>';
    }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}

function nid(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
