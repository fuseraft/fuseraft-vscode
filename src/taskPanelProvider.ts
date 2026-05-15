import * as vscode from 'vscode';
import * as fs from 'fs';
import * as nodePath from 'path';
import { ConfigInfo, findFuseraftConfigs, getBinary, getRunFlags, runInTerminal, buildRunCommand } from './fuseraftUtils';

interface AttachedFile {
    path: string;
    name: string;
}

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
            } else if (msg.type === 'pickFiles') {
                await this._pickFiles(webviewView.webview);
            } else if (msg.type === 'dropFiles') {
                await this._handleDropFiles(webviewView.webview, msg);
            }
        });
    }

    async refresh(): Promise<void> {
        if (!this._view) { return; }
        const configs = await findFuseraftConfigs();
        this._view.webview.postMessage({ type: 'configs', configs });
    }

    private _run(msg: { task: string; configPath: string; flags: Record<string, boolean>; files?: AttachedFile[] }): void {
        const { task, configPath, flags } = msg;
        if (!task.trim()) { return; }

        const contextFlags = (msg.files ?? [])
            .map(f => `--context-file '${f.path.replace(/'/g, `'\\''`)}'`)
            .join(' ');

        const extra = [
            flags.hitl    ? '--hitl'    : '',
            flags.tools   ? '--tools'   : '',
            flags.verbose ? '--verbose' : '',
            flags.devui   ? '--devui'   : '',
            contextFlags,
            getRunFlags(),
        ].filter(Boolean).join(' ');

        const label = task.split('\n')[0].trim().slice(0, 40) || 'Task';
        runInTerminal(buildRunCommand(getBinary(), task, configPath || undefined, extra || undefined), `fuseraft — ${label}`);
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

    private async _pickFiles(webview: vscode.Webview): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFiles: true,
            canSelectFolders: true,
            title: 'Attach context files',
        });
        if (!uris?.length) { return; }
        webview.postMessage({ type: 'filesSelected', files: this._expandUris(uris) });
    }

    private async _handleDropFiles(webview: vscode.Webview, msg: { uris?: string[]; paths?: string[] }): Promise<void> {
        const rawUris: vscode.Uri[] = [];
        for (const u of (msg.uris ?? [])) {
            try { rawUris.push(vscode.Uri.parse(u, true)); } catch { /* skip */ }
        }
        for (const p of (msg.paths ?? [])) {
            try { rawUris.push(vscode.Uri.file(p)); } catch { /* skip */ }
        }
        const files = this._expandUris(rawUris);
        if (files.length) {
            webview.postMessage({ type: 'filesSelected', files });
        }
    }

    // Resolves file/folder URIs to AttachedFile records. Folders expand to their
    // immediate non-hidden children (up to 20 total across all selections).
    private _expandUris(uris: vscode.Uri[]): AttachedFile[] {
        const result: AttachedFile[] = [];
        for (const uri of uris) {
            if (result.length >= 20) { break; }
            let stat: fs.Stats;
            try { stat = fs.statSync(uri.fsPath); } catch { continue; }

            if (stat.isFile()) {
                result.push({ path: uri.fsPath, name: nodePath.basename(uri.fsPath) });
            } else if (stat.isDirectory()) {
                const base = nodePath.basename(uri.fsPath);
                let entries: fs.Dirent[];
                try { entries = fs.readdirSync(uri.fsPath, { withFileTypes: true }); } catch { continue; }
                for (const e of entries) {
                    if (result.length >= 20) { break; }
                    if (e.isFile() && !e.name.startsWith('.')) {
                        result.push({ path: nodePath.join(uri.fsPath, e.name), name: `${base}/${e.name}` });
                    }
                }
            }
        }
        return result;
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
textarea:focus { border-color: var(--vscode-focusBorder); }
textarea::placeholder { color: var(--vscode-input-placeholderForeground); }

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

.flags { display: flex; flex-direction: column; gap: 5px; }
.flag-row { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.flag-row input[type=checkbox] { cursor: pointer; accent-color: var(--vscode-checkbox-background); }
.flag-row span { font-size: var(--vscode-font-size); }
.flag-desc { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: 20px; }

.actions { display: flex; gap: 6px; flex-wrap: wrap; }

button {
    border: none;
    border-radius: 2px;
    padding: 5px 10px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    cursor: pointer;
    white-space: nowrap;
}
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); flex: 1; }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: 0.5; cursor: not-allowed; }

.section { display: flex; flex-direction: column; gap: 4px; }

.config-row { display: flex; gap: 4px; align-items: center; }
.config-row select { flex: 1; }
.config-row button { padding: 4px 7px; font-size: 13px; }

.attach-bar {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    flex-wrap: wrap;
    min-height: 24px;
}
.attach-btn { padding: 2px 8px; font-size: 11px; flex-shrink: 0; }

.chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }

.chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 10px;
    padding: 2px 4px 2px 8px;
    font-size: 11px;
    max-width: 160px;
    min-width: 0;
}
.chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.chip-remove {
    padding: 0 2px;
    background: transparent;
    color: inherit;
    font-size: 14px;
    line-height: 1;
    opacity: 0.6;
    flex-shrink: 0;
}
.chip-remove:hover { opacity: 1; background: transparent; }

#taskSection.drag-over {
    outline: 2px dashed var(--vscode-focusBorder);
    outline-offset: 2px;
    border-radius: 3px;
}
</style>
</head>
<body>

<div class="section" id="taskSection">
    <label>Task</label>
    <textarea id="task" placeholder="Describe the task for your agent team…&#10;&#10;You can paste a full spec, bullet list, or prose."></textarea>
    <div class="attach-bar">
        <button class="secondary attach-btn" id="addFilesBtn" title="Attach files or folders as context&#10;(folders expand to immediate children, max 20 files)">+ Files</button>
        <div class="chips" id="chips"></div>
    </div>
</div>

<div class="section">
    <label>Config</label>
    <div class="config-row">
        <select id="config"><option value="">&#x27f3; Loading configs&#x2026;</option></select>
        <button class="secondary" id="refreshBtn" title="Refresh config list">&#x21ba;</button>
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
    <button class="primary" id="runBtn">&#x25b6;&#xa0; Run Task</button>
    <button class="secondary" id="fileBtn">Run Task File&#x2026;</button>
</div>

<script nonce="${nonce}">
const vscode      = acquireVsCodeApi();
const taskEl      = document.getElementById('task');
const configEl    = document.getElementById('config');
const runBtn      = document.getElementById('runBtn');
const fileBtn     = document.getElementById('fileBtn');
const refreshBtn  = document.getElementById('refreshBtn');
const addFilesBtn = document.getElementById('addFilesBtn');
const chipsEl     = document.getElementById('chips');
const taskSection = document.getElementById('taskSection');

let selectedFiles = [];

function renderChips() {
    chipsEl.innerHTML = '';
    selectedFiles.forEach(function(f, i) {
        var chip = document.createElement('span');
        chip.className = 'chip';
        chip.title = f.path;

        var name = document.createElement('span');
        name.className = 'chip-name';
        name.textContent = f.name;

        var btn = document.createElement('button');
        btn.className = 'chip-remove';
        btn.textContent = '×';
        btn.setAttribute('data-idx', String(i));
        btn.title = 'Remove';

        chip.appendChild(name);
        chip.appendChild(btn);
        chipsEl.appendChild(chip);
    });
}

chipsEl.addEventListener('click', function(e) {
    var btn = e.target.closest('.chip-remove');
    if (!btn) { return; }
    selectedFiles.splice(parseInt(btn.getAttribute('data-idx'), 10), 1);
    renderChips();
});

addFilesBtn.addEventListener('click', function() {
    vscode.postMessage({ type: 'pickFiles' });
});

taskSection.addEventListener('dragover', function(e) {
    var types = Array.from(e.dataTransfer.types);
    if (types.indexOf('Files') !== -1 || types.indexOf('text/uri-list') !== -1) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        taskSection.classList.add('drag-over');
    }
});

taskSection.addEventListener('dragleave', function(e) {
    if (!taskSection.contains(e.relatedTarget)) {
        taskSection.classList.remove('drag-over');
    }
});

taskSection.addEventListener('drop', function(e) {
    taskSection.classList.remove('drag-over');
    var uriList = e.dataTransfer.getData('text/uri-list');
    if (uriList) {
        e.preventDefault();
        var uris = uriList.split(/\r?\n/).map(function(u) { return u.trim(); }).filter(function(u) { return u && u[0] !== '#'; });
        vscode.postMessage({ type: 'dropFiles', uris: uris });
        return;
    }
    var dropped = Array.from(e.dataTransfer.files);
    if (dropped.length) {
        e.preventDefault();
        var paths = dropped.map(function(f) { return f.path || ''; }).filter(Boolean);
        if (paths.length) { vscode.postMessage({ type: 'dropFiles', paths: paths }); }
    }
});

function getFlags() {
    return {
        hitl:    document.getElementById('hitl').checked,
        tools:   document.getElementById('tools').checked,
        verbose: document.getElementById('verbose').checked,
        devui:   document.getElementById('devui').checked,
    };
}

runBtn.addEventListener('click', function() {
    var task = taskEl.value.trim();
    if (!task) { taskEl.focus(); return; }
    vscode.postMessage({ type: 'run', task: task, configPath: configEl.value, flags: getFlags(), files: selectedFiles });
    taskEl.value = '';
    selectedFiles = [];
    renderChips();
    var prev = runBtn.textContent;
    runBtn.textContent = '✓ Started';
    runBtn.disabled = true;
    setTimeout(function() { runBtn.textContent = prev; runBtn.disabled = false; }, 1500);
});

fileBtn.addEventListener('click', function() {
    vscode.postMessage({ type: 'browseTaskFile', configPath: configEl.value, flags: getFlags() });
});

refreshBtn.addEventListener('click', function() {
    configEl.innerHTML = '<option value="">⟳ Refreshing…</option>';
    vscode.postMessage({ type: 'refreshConfigs' });
});

taskEl.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { runBtn.click(); }
});

window.addEventListener('message', function(e) {
    var msg = e.data;
    if (msg.type === 'configs') {
        configEl.innerHTML = msg.configs.length
            ? '<option value="">— no config (use default) —</option>' +
              msg.configs.map(function(c) { return '<option value="' + c.fsPath + '">' + c.workspaceRelative + '</option>'; }).join('')
            : '<option value="">No configs found in workspace</option>';
    } else if (msg.type === 'filesSelected') {
        var added = msg.files.filter(function(f) {
            return !selectedFiles.some(function(s) { return s.path === f.path; });
        });
        selectedFiles = selectedFiles.concat(added);
        renderChips();
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
