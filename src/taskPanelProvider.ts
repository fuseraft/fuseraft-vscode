import * as vscode from 'vscode';
import * as fs from 'fs';
import * as nodePath from 'path';
import * as os from 'os';
import { ConfigInfo, findFuseraftConfigs, getBinary, getRunFlags, runInTerminal, buildRunCommand, logToChannel } from './fuseraftUtils';

interface AttachedFile {
    path: string;
    name: string;
}

export class TaskPanelProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'fuseraft.taskPanel';

    private _view?: vscode.WebviewView;
    private _cwdWarningShown = false;

    constructor(private readonly extensionUri: vscode.Uri) {}

    private async _checkWorkspaceCwd(): Promise<void> {
        if (this._cwdWarningShown) { return; }

        const folders = vscode.workspace.workspaceFolders;
        const home = os.homedir();
        const noFolder = !folders || folders.length === 0;
        const isHome = !noFolder && folders!.length === 1 && folders![0].uri.fsPath === home;

        if (!noFolder && !isHome) { return; }

        this._cwdWarningShown = true;

        const msg = isHome
            ? 'fuseraft works best when VS Code is opened in a project directory, not your home folder.'
            : 'No folder is open. Open a project folder to use fuseraft.';

        const choice = await vscode.window.showWarningMessage(msg, 'Open Folder');
        if (choice !== 'Open Folder') { return; }

        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: false,
            canSelectFolders: true,
            title: 'Select a project folder to open',
            openLabel: 'Open Folder',
        });
        if (uris?.[0]) {
            vscode.commands.executeCommand('vscode.openFolder', uris[0]);
        }
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._html(webviewView.webview);

        this._checkWorkspaceCwd();
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { this._checkWorkspaceCwd(); }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'ready' || msg.type === 'refreshConfigs') {
                logToChannel(`Config request: ${msg.type}`);
                const configs = await findFuseraftConfigs();
                logToChannel(`Found ${configs.length} config(s)`);
                const sent = await webviewView.webview.postMessage({ type: 'configs', configs });
                logToChannel(`Config message sent: ${sent}`);
            } else if (msg.type === 'run') {
                this._run(msg);
            } else if (msg.type === 'browseTaskFile') {
                await this._browseTaskFile(msg.configPath, msg.flags);
            } else if (msg.type === 'pickSpec') {
                await this._pickSpec();
            } else if (msg.type === 'pickFiles') {
                logToChannel('pickFiles: message received from webview');
                await this._pickFiles();
            } else if (msg.type === 'dropFiles') {
                await this._handleDropFiles(msg);
            } else if (msg.type === 'dropFilesMetadata') {
                logToChannel(`dropFilesMetadata: drop occurred but no URI list — files=${JSON.stringify(msg.files)}`);
                vscode.window.showWarningMessage(
                    `Couldn't resolve file path from this drag source. Use the + Files button to attach files.`
                );
            } else if (msg.type === 'initConfig') {
                vscode.commands.executeCommand('fuseraft.init');
            }
        });
    }

    async refresh(): Promise<void> {
        if (!this._view) { 
            logToChannel('refresh: no view available');
            return; 
        }
        logToChannel('refresh: finding configs');
        const configs = await findFuseraftConfigs();
        logToChannel(`refresh: found ${configs.length} config(s)`);
        const sent = await this._view.webview.postMessage({ type: 'configs', configs });
        logToChannel(`refresh: message sent=${sent}`);
    }

    private _run(msg: { task: string; configPath: string; flags: Record<string, boolean>; files?: AttachedFile[]; specFile?: AttachedFile }): void {
        const { task, configPath, flags } = msg;
        if (!task.trim()) { return; }

        const contextFlags = (msg.files ?? [])
            .map(f => `--context-file '${f.path.replace(/'/g, `'\\''`)}'`)
            .join(' ');

        const extra = [
            flags.hitl     ? '--hitl'     : '',
            flags.tools    ? '--tools'    : '',
            flags.verbose  ? '--verbose'  : '',
            flags.snapshot ? '--snapshot' : '',
            contextFlags,
            getRunFlags(),
        ].filter(Boolean).join(' ');

        const label = task.split('\n')[0].trim().slice(0, 40) || 'Task';

        const tmpFile = nodePath.join(os.tmpdir(), `fuseraft-task-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
        fs.writeFileSync(tmpFile, task, 'utf8');

        const specPath = msg.specFile?.path;
        runInTerminal(buildRunCommand(getBinary(), task, configPath || undefined, extra || undefined, tmpFile, specPath), `fuseraft — ${label}`);
    }

    private async _browseTaskFile(configPath: string, flags: Record<string, boolean>): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Task files': ['md', 'txt'] },
            title: 'Select task file',
        });
        if (!uris?.[0]) { return; }

        const extra = [
            flags.hitl     ? '--hitl'     : '',
            flags.tools    ? '--tools'    : '',
            flags.verbose  ? '--verbose'  : '',
            flags.snapshot ? '--snapshot' : '',
            getRunFlags(),
        ].filter(Boolean).join(' ');

        const configFlag = configPath ? ` -c '${configPath}'` : '';
        const flagStr = extra ? ` ${extra}` : '';
        runInTerminal(`${getBinary()} run --vscode${configFlag}${flagStr} -f '${uris[0].fsPath}'`);
    }

    private async _pickSpec(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            filters: { 'Spec files': ['md', 'txt', 'json'] },
            title: 'Attach spec file',
        });
        if (!uris?.length || !this._view) { return; }
        this._view.show(true);
        const uri = uris[0];
        const file = { path: uri.fsPath, name: nodePath.basename(uri.fsPath) };
        let delivered = await this._view.webview.postMessage({ type: 'specSelected', file });
        if (!delivered) {
            await new Promise(r => setTimeout(r, 150));
            delivered = await this._view.webview.postMessage({ type: 'specSelected', file });
        }
    }

    private async _pickFiles(): Promise<void> {
        logToChannel('pickFiles: calling showOpenDialog');
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFiles: true,
            canSelectFolders: false,
            title: 'Attach context files',
        });
        logToChannel(`pickFiles: dialog returned ${uris ? uris.length + ' uri(s)' : 'undefined (cancelled)'}`);
        if (!uris?.length || !this._view) {
            logToChannel(`pickFiles: aborting — uris empty=${!uris?.length}, view missing=${!this._view}`);
            return;
        }

        // The sidebar collapses while the native dialog is open; re-show it so
        // postMessage finds a visible webview and delivers the message.
        logToChannel('pickFiles: calling show(true)');
        this._view.show(true);
        const files = this._expandUris(uris);
        logToChannel(`pickFiles: sending filesSelected with ${files.length} file(s)`);
        let delivered = await this._view.webview.postMessage({ type: 'filesSelected', files });
        if (!delivered) {
            // Give VS Code a tick to finish re-showing the view, then retry once.
            await new Promise(r => setTimeout(r, 150));
            delivered = await this._view.webview.postMessage({ type: 'filesSelected', files });
        }
        logToChannel(`pickFiles: postMessage delivered=${delivered}`);
    }

    private async _handleDropFiles(msg: { uris?: string[]; paths?: string[] }): Promise<void> {
        logToChannel(`dropFiles: received — uris=${JSON.stringify(msg.uris)}, paths=${JSON.stringify(msg.paths)}`);
        const rawUris: vscode.Uri[] = [];
        for (const u of (msg.uris ?? [])) {
            try { rawUris.push(vscode.Uri.parse(u, true)); } catch { /* skip */ }
        }
        for (const p of (msg.paths ?? [])) {
            try { rawUris.push(vscode.Uri.file(p)); } catch { /* skip */ }
        }
        const files = this._expandUris(rawUris);
        logToChannel(`dropFiles: expanded to ${files.length} file(s)`);
        if (files.length && this._view) {
            this._view.show(true);
            const delivered = await this._view.webview.postMessage({ type: 'filesSelected', files });
            logToChannel(`dropFiles: postMessage delivered=${delivered}`);
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

html, body { height: 100%; }

body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
    padding: 12px;
    padding-bottom: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
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

.bottom-bar {
    position: sticky;
    bottom: 0;
    z-index: 10;
    background: var(--vscode-sideBar-background, var(--vscode-panel-background, transparent));
    padding-top: 8px;
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 0;
}

.actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    padding-bottom: 8px;
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
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
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
        <button class="secondary attach-btn" id="addSpecBtn" title="Attach a spec file — agents treat it as the authoritative source of truth">+ Spec</button>
        <div class="chips" id="chips"></div>
    </div>
    <div class="attach-bar" id="specBar" style="display:none;margin-top:2px;">
        <div class="chips" id="specChip"></div>
    </div>
</div>

<div class="section">
    <label>Config</label>
    <div class="config-row">
        <select id="config"><option value="">⟳ Loading configs…</option></select>
        <button class="secondary" id="refreshBtn" title="Refresh config list">↺</button>
    </div>
    <div id="noConfigHint" style="display:none;margin-top:6px;">
        <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:5px;">A config defines your agent team. Create one to get started.</div>
        <button class="secondary" id="createConfigBtn" style="font-size:12px;padding:4px 10px;">Create a config</button>
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
            <label class="flag-row"><input type="checkbox" id="snapshot"><span>Snapshot</span></label>
            <div class="flag-desc">Write per-turn postmortem to ~/.fuseraft/snapshots/</div>
        </div>
    </div>
</div>

<div class="bottom-bar">
    <div class="actions">
        <button class="primary" id="runBtn">▶  Run Task</button>
        <button class="secondary" id="fileBtn">Run Task File…</button>
    </div>
</div>


<script nonce="${nonce}">
const vscode      = acquireVsCodeApi();
const taskEl      = document.getElementById('task');
const configEl    = document.getElementById('config');
const runBtn      = document.getElementById('runBtn');
const fileBtn     = document.getElementById('fileBtn');
const refreshBtn  = document.getElementById('refreshBtn');
const addFilesBtn = document.getElementById('addFilesBtn');
const addSpecBtn  = document.getElementById('addSpecBtn');
const chipsEl     = document.getElementById('chips');
const specChipEl  = document.getElementById('specChip');
const specBar     = document.getElementById('specBar');
const taskSection = document.getElementById('taskSection');

let selectedFiles = [];
let specFile = null;

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

function renderSpecChip() {
    specChipEl.innerHTML = '';
    specBar.style.display = specFile ? '' : 'none';
    if (!specFile) { return; }
    var chip = document.createElement('span');
    chip.className = 'chip';
    chip.title = specFile.path;
    var icon = document.createElement('span');
    icon.textContent = '📋 ';
    icon.style.flexShrink = '0';
    var name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = specFile.name;
    var btn = document.createElement('button');
    btn.className = 'chip-remove';
    btn.textContent = '×';
    btn.title = 'Remove spec';
    btn.addEventListener('click', function() { specFile = null; renderSpecChip(); });
    chip.appendChild(icon);
    chip.appendChild(name);
    chip.appendChild(btn);
    specChipEl.appendChild(chip);
}

specChipEl.addEventListener('click', function(e) {
    if (e.target.closest('.chip-remove')) { specFile = null; renderSpecChip(); }
});

addFilesBtn.addEventListener('click', function() {
    addFilesBtn.textContent = '⏳ picking…';
    addFilesBtn.disabled = true;
    setTimeout(function() { addFilesBtn.textContent = '+ Files'; addFilesBtn.disabled = false; }, 5000);
    vscode.postMessage({ type: 'pickFiles' });
});

addSpecBtn.addEventListener('click', function() {
    addSpecBtn.textContent = '⏳ picking…';
    addSpecBtn.disabled = true;
    setTimeout(function() { addSpecBtn.textContent = '+ Spec'; addSpecBtn.disabled = false; }, 5000);
    vscode.postMessage({ type: 'pickSpec' });
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
    e.preventDefault();
    taskSection.classList.remove('drag-over');

    addFilesBtn.textContent = '📎 dropped…';
    setTimeout(function() { addFilesBtn.textContent = '+ Files'; }, 3000);

    console.log('drop types:', JSON.stringify(Array.from(e.dataTransfer.types)));

    // 1. Prefer URI list — works for most OS file manager drops and VS Code explorer drags.
    var uriList = e.dataTransfer.getData('text/uri-list');
    if (uriList) {
        var uris = uriList.split(/\\r?\\n/).map(function(u) { return u.trim(); }).filter(function(u) { return u && u[0] !== '#'; });
        if (uris.length) {
            vscode.postMessage({ type: 'dropFiles', uris: uris });
            return;
        }
    }

    // 2. Fallback: Chromium File objects.
    //    File.path is stripped in VS Code webviews, so we can only get metadata.
    //    The extension host will show a warning explaining the limitation.
    var dropped = Array.from(e.dataTransfer.files);
    if (dropped.length) {
        vscode.postMessage({
            type: 'dropFilesMetadata',
            files: dropped.map(function(f) { return { name: f.name, size: f.size, type: f.type }; }),
        });
    }
});

function getFlags() {
    return {
        hitl:     document.getElementById('hitl').checked,
        tools:    document.getElementById('tools').checked,
        verbose:  document.getElementById('verbose').checked,
        snapshot: document.getElementById('snapshot').checked,
    };
}

runBtn.addEventListener('click', function() {
    var task = taskEl.value.trim();
    if (!task) { taskEl.focus(); return; }
    vscode.postMessage({ type: 'run', task: task, configPath: configEl.value, flags: getFlags(), files: selectedFiles, specFile: specFile });
    taskEl.value = '';
    selectedFiles = [];
    specFile = null;
    renderChips();
    renderSpecChip();
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

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
}

window.addEventListener('message', function(e) {
    var msg = e.data;
    if (msg.type === 'configs') {
        const configs = msg.configs;
        const hint = document.getElementById('noConfigHint');
        if (configs.length) {
            const prevValue = configEl.value;
            configEl.innerHTML = '<option value="">— no config (use default) —</option>' +
                configs.map(c => '<option value="' + escapeHtml(c.fsPath) + '">' + escapeHtml(c.workspaceRelative) + '</option>').join('');
            if (hint) { hint.style.display = 'none'; }
            // Restore previous selection if still present; otherwise auto-select
            // the first config that lives under the .fuseraft/ directory.
            if (prevValue && Array.from(configEl.options).some(o => o.value === prevValue)) {
                configEl.value = prevValue;
            } else {
                const auto = configs.find(c =>
                    c.workspaceRelative.startsWith('.fuseraft/') ||
                    c.workspaceRelative.startsWith('.fuseraft\\\\')
                );
                if (auto) { configEl.value = auto.fsPath; }
            }
        } else {
            configEl.innerHTML = '<option value="">No configs found in workspace</option>';
            if (hint) { hint.style.display = 'block'; }
        }
    } else if (msg.type === 'filesSelected') {
        addFilesBtn.textContent = '+ Files';
        addFilesBtn.disabled = false;
        var added = msg.files.filter(function(f) {
            return !selectedFiles.some(function(s) { return s.path === f.path; });
        });
        selectedFiles = selectedFiles.concat(added);
        renderChips();
    } else if (msg.type === 'specSelected') {
        addSpecBtn.textContent = '+ Spec';
        addSpecBtn.disabled = false;
        specFile = msg.file;
        renderSpecChip();
    }
});

document.getElementById('createConfigBtn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'initConfig' });
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
