import * as vscode from 'vscode';
import * as path from 'path';
import { checkCli, getFuseraftHome, listCliSettings, setCliSetting } from './fuseraftUtils';
import { fuseraftMarkSvg } from './setupWizard';

/** Singleton panel: reuse it if it's already open. */
let _panel: vscode.WebviewPanel | undefined;

/** Opens the panel for the CLI's global settings (`fuseraft settings`), shared with the terminal REPL. */
export async function openSettingsPanel(extensionUri: vscode.Uri): Promise<void> {
    if (_panel) {
        _panel.reveal();
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'fuseraftSettings',
        'fuseraft settings',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] }
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    _panel = panel;

    const configPath = path.join(getFuseraftHome(), 'config');
    panel.webview.html = getHtml(panel.webview, extensionUri, configPath);

    // The terminal REPL, `fuseraft settings set` and fuseraft-web edit the same file.
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(path.dirname(configPath)), 'config'));
    const reload = () => void load(panel);
    watcher.onDidChange(reload);
    watcher.onDidCreate(reload);
    watcher.onDidDelete(reload);

    panel.onDidDispose(() => {
        _panel = undefined;
        watcher.dispose();
    });

    panel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.action) {
            case 'ready':
                await load(panel);
                return;
            case 'set': {
                const result = await setCliSetting(String(msg.key), String(msg.value ?? ''));
                panel.webview.postMessage('data' in result
                    ? { type: 'saved', key: msg.key, setting: result.data }
                    : { type: 'saveFailed', key: msg.key, error: 'error' in result ? result.error : 'This fuseraft CLI is too old to change settings here.' });
                return;
            }
            case 'openSetup':
                vscode.commands.executeCommand('fuseraft.setup');
                return;
            case 'update':
                vscode.commands.executeCommand('fuseraft.update');
                return;
            case 'install':
                vscode.commands.executeCommand('fuseraft.install');
                return;
            case 'openConfig':
                vscode.window.showTextDocument(vscode.Uri.file(configPath));
                return;
            case 'openExtensionSettings':
                vscode.commands.executeCommand('workbench.action.openSettings', '@ext:fuseraft.fuseraft');
                return;
        }
    });
}

async function load(panel: vscode.WebviewPanel): Promise<void> {
    const cli = await checkCli();
    if (!cli.found) {
        panel.webview.postMessage({ type: 'state', state: 'missing' });
        return;
    }
    const result = await listCliSettings();
    if ('data' in result) {
        panel.webview.postMessage({ type: 'settings', settings: result.data });
    } else if ('error' in result) {
        panel.webview.postMessage({ type: 'state', state: 'error', error: result.error });
    } else {
        const version = cli.version.replace(/^fuseraft\s+/i, '').replace(/\+.*$/, '');
        panel.webview.postMessage({ type: 'state', state: 'outdated', version });
    }
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri, configPath: string): string {
    const nonce = Math.random().toString(36).substring(2, 15);
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${media('settings.css')}">
</head>
<body>
<main>
    <header>
        ${fuseraftMarkSvg('icon-mark', 'fr-mark-settings')}
        <div>
            <h1>fuseraft settings</h1>
            <p>Defaults for every chat, saved in <a href="#" id="configLink" title="Open the file">${escHtml(configPath)}</a> and shared with fuseraft in the terminal. New chats use them; restart an open chat to apply a change.</p>
        </div>
    </header>

    <div class="toolbar" id="toolbar">
        <input type="search" id="search" placeholder="Search settings" aria-label="Search settings">
        <label class="only-changed"><input type="checkbox" id="onlyChanged"> Changed only</label>
    </div>

    <div id="notice" class="notice" hidden></div>
    <div id="sections"><p class="loading">Loading settings…</p></div>
    <p id="noMatch" class="empty" hidden>No settings match.</p>

    <footer>
        <a href="#" id="extensionSettingsLink">Extension settings</a> (the CLI's path and home folder) are in VS Code's own settings.
    </footer>
</main>
<script nonce="${nonce}" src="${media('settings.js')}"></script>
</body>
</html>`;
}
