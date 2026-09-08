import * as vscode from 'vscode';
import * as cp from 'child_process';
import { getBinary, readApiKeyFromConfig, fetchModelsViaCli, getFuseraftHomeEnvOverride } from './fuseraftUtils';
import { readSkills, getSkillsDir } from './skillsTreeProvider';

interface ReplEvent {
    type: string;
    [key: string]: unknown;
}

export class ReplPanelProvider {
    private static _current: ReplPanelProvider | undefined;
    static extensionUri: vscode.Uri;

    static show(model: string, resumeId?: string, cwd?: string): void {
        if (ReplPanelProvider._current) {
            const cur = ReplPanelProvider._current;
            if (!resumeId || cur._sessionId === resumeId) {
                if (cur._alive) {
                    // Same live session — just bring it into view.
                    cur._panel.reveal(vscode.ViewColumn.Beside);
                    return;
                }
                // Session is dead — dispose the stale panel and fall through to open a fresh one.
            } else {
                // Different session requested — close the current panel.
                cur._proc?.kill();
            }
            ReplPanelProvider._current = undefined;
            cur._panel.dispose();
        }
        const panel = vscode.window.createWebviewPanel(
            'fuseraftRepl',
            resumeId ? `fuseraft REPL · ${resumeId}` : 'fuseraft REPL',
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.iconPath = vscode.Uri.joinPath(ReplPanelProvider.extensionUri, 'media', 'icon.png');
        ReplPanelProvider._current = new ReplPanelProvider(panel, model, resumeId, cwd);
    }

    private readonly _panel: vscode.WebviewPanel;
    private _proc: cp.ChildProcess | undefined;
    private _buf = '';
    private _alive = false;
    /** Session ID of the currently running session (set to resumeId when resuming). */
    private _sessionId: string | undefined;
    /** Set once the CLI's own session_end event has been relayed, so the exit handler doesn't send a second one. */
    private _sessionEndSent = false;

    private constructor(panel: vscode.WebviewPanel, model: string, resumeId?: string, cwd?: string) {
        this._panel    = panel;
        this._sessionId = resumeId;   // refined to actual sessionId once CLI emits 'ready'
        panel.webview.html = this._html();

        panel.webview.onDidReceiveMessage((msg: { type: string; text?: string; model?: string; approved?: boolean }) => {
            if (msg.type === 'user_input' && msg.text !== undefined) {
                this._send({ type: 'user_input', text: msg.text });
            } else if (msg.type === 'approval_response' && typeof msg.approved === 'boolean') {
                this._send({ type: 'approval_response', approved: msg.approved });
            } else if (msg.type === 'interrupt') {
                if (process.platform === 'win32') {
                    // Windows has no equivalent of SIGINT for child processes; send the
                    // interrupt as a JSON message over stdin so the CLI can cancel the
                    // active request without terminating the session.
                    this._proc?.stdin?.write(JSON.stringify({ type: 'interrupt' }) + '\n');
                } else {
                    this._proc?.kill('SIGINT');
                }
            } else if (msg.type === 'model_change' && msg.model) {
                this._send({ type: 'user_input', text: `/model ${msg.model}` });
            } else if (msg.type === 'pick_files') {
                vscode.window.showOpenDialog({
                    canSelectMany: true,
                    openLabel: 'Attach',
                    title: 'Attach files to message',
                }).then(uris => {
                    if (uris && uris.length > 0) {
                        this._panel.webview.postMessage({
                            type: 'files_picked',
                            files: uris.map(u => ({
                                name: u.fsPath.split(/[/\\]/).pop() ?? u.fsPath,
                                path: u.fsPath,
                            })),
                        });
                    }
                });
            }
        });

        panel.onDidDispose(() => {
            this._proc?.kill();
            ReplPanelProvider._current = undefined;
        });

        this._spawn(model, resumeId, cwd);
        this._fetchModels(cwd);
        this._fetchSkills();
    }

    private _spawn(model: string, resumeId?: string, cwd?: string): void {
        const args = ['repl', '--vscode', '--no-banner'];
        if (model) { args.push('--model', model); }
        if (resumeId) { args.push('--resume', resumeId); }

        // Inherit the full environment. Inject FUSERAFT_API_KEY from the saved
        // config only when the variable is not already present — an explicitly
        // set env var always takes priority.  On Windows the CLI subprocess may
        // not resolve ~/.fuseraft/config through the same home-directory path
        // that the extension used when writing it, so the env var is the
        // reliable channel for the key.
        const configKey = readApiKeyFromConfig();
        const env: NodeJS.ProcessEnv = { ...process.env, ...getFuseraftHomeEnvOverride() };
        if (configKey && !env['FUSERAFT_API_KEY']) { env['FUSERAFT_API_KEY'] = configKey; }

        this._proc = cp.spawn(getBinary(), args, {
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            ...(cwd ? { cwd } : {}),
        });

        this._proc.stdout?.on('data', (chunk: Buffer) => {
            this._buf += chunk.toString();
            const lines = this._buf.split('\n');
            this._buf = lines.pop() ?? '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) { continue; }
                try {
                    const evt = JSON.parse(trimmed) as ReplEvent;
                    if (evt.type) {
                        // Capture the authoritative session ID from the CLI's ready event
                        // so that same-session reveal works correctly for new sessions too.
                        if (evt.type === 'ready' && typeof evt.sessionId === 'string') {
                            this._sessionId = evt.sessionId as string;
                            this._alive = true;
                        }
                        if (evt.type === 'session_end') {
                            this._sessionEndSent = true;
                        }
                        this._panel.webview.postMessage(evt);
                    }
                } catch {
                    // non-JSON line — informational output from the CLI, ignore
                }
            }
        });

        this._proc.on('exit', () => {
            this._alive = false;
            if (this._sessionEndSent) { return; }
            try { this._panel.webview.postMessage({ type: 'session_end' }); } catch { /* panel disposed */ }
        });

        this._proc.on('error', (err: Error) => {
            try { this._panel.webview.postMessage({ type: 'error', text: err.message }); } catch { /* panel disposed */ }
        });
    }

    private _fetchModels(cwd?: string): void {
        fetchModelsViaCli(cwd).then(result => {
            if (result && result.list.length > 0) {
                this._panel.webview.postMessage({ type: 'models', list: result.list, current: result.current });
            }
        });
    }

    /** Feeds the webview the $skill-name completion list — matched against the skill's frontmatter
     *  `name` (not its directory slug), mirroring how ReplTurn resolves `$<skill-name>` invocations. */
    private _fetchSkills(): void {
        try {
            const names = readSkills(getSkillsDir()).map(s => s.name);
            this._panel.webview.postMessage({ type: 'skills', list: names });
        } catch { /* skills dir missing/unreadable — webview just gets no skill completions */ }
    }

    private _send(msg: object): void {
        this._proc?.stdin?.write(JSON.stringify(msg) + '\n');
    }

    private _mark(className: string, gradId: string): string {
        return `<svg class="${className}" viewBox="0 0 1500 1500" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="#c4452e"/><stop offset="100%" stop-color="#d98c4f"/>
  </linearGradient></defs>
  <rect width="1500" height="1500" fill="url(#${gradId})"/>
  <rect x="675" y="150" width="150" height="1200" fill="#fff"/>
  <rect x="1200" y="150" width="150" height="525" fill="#fff"/>
  <rect x="150" y="825" width="150" height="525" fill="#fff"/>
  <rect x="675" y="150" width="675" height="150" fill="#fff"/>
  <rect x="150" y="1200" width="675" height="150" fill="#fff"/>
  <rect x="300" y="675" width="900" height="150" fill="#fff"/>
</svg>`;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private _html(): string {
        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:var(--vscode-font-family);
  font-size:var(--vscode-font-size);
  color:var(--vscode-editor-foreground);
  background:var(--vscode-editor-background);
  display:flex;flex-direction:column;height:100vh;overflow:hidden
}
#header{
  padding:6px 12px;
  border-bottom:1px solid var(--vscode-panel-border);
  display:flex;align-items:center;gap:8px;
  font-size:11px;color:var(--vscode-descriptionForeground);
  flex-shrink:0
}
#header .session{opacity:.6}
.icon-mark{width:14px;height:14px;border-radius:3px;overflow:hidden;flex-shrink:0}
.brand{display:inline-flex;align-items:center;gap:6px}
#model-select{
  font-family:var(--vscode-font-family);
  font-size:11px;font-weight:600;
  color:var(--vscode-editor-foreground);
  background:var(--vscode-dropdown-background,var(--vscode-input-background));
  border:1px solid var(--vscode-dropdown-border,transparent);
  border-radius:4px;padding:1px 4px;
  outline:none;cursor:pointer;max-width:260px
}
#model-select:disabled{opacity:.5;cursor:default}
#model-select option{
  background:var(--vscode-dropdown-background,var(--vscode-editor-background));
  color:var(--vscode-editor-foreground)
}
#messages{
  flex:1;overflow-y:auto;padding:12px;
  display:flex;flex-direction:column;gap:10px;
  position:relative
}
#welcome{
  position:absolute;inset:0;
  display:flex;align-items:center;justify-content:center;
  padding:32px 24px;
  background:var(--vscode-editor-background);
  z-index:5
}
#welcome-inner{
  width:100%;max-width:540px;
  display:flex;flex-direction:column;gap:14px
}
#welcome-title{
  font-size:1.3em;font-weight:600;
  text-align:center;
  color:var(--vscode-editor-foreground);
  display:flex;align-items:center;justify-content:center;gap:8px
}
#welcome-title .icon-mark{width:26px;height:26px;border-radius:6px}
#welcome-hint{
  font-size:.92em;text-align:center;
  color:var(--vscode-descriptionForeground)
}
#welcome-input-wrap{
  position:relative;width:100%;min-height:72px;max-height:200px
}
#welcome-input-wrap.disabled{opacity:.45}
#welcome-highlight,#welcome-input{
  position:absolute;top:0;left:0;width:100%;
  padding:10px 14px;
  border:1px solid transparent;
  border-radius:8px;
  font-family:var(--vscode-font-family);
  font-size:var(--vscode-font-size);
  line-height:1.5;
  box-sizing:border-box
}
#welcome-highlight{
  background:var(--vscode-input-background);
  color:var(--vscode-input-foreground);
  border-color:var(--vscode-input-border,var(--vscode-panel-border));
  white-space:pre-wrap;word-wrap:break-word;overflow:hidden;
  pointer-events:none
}
#welcome-input{
  resize:none;outline:none;
  background:transparent;color:transparent;
  caret-color:var(--vscode-input-foreground)
}
#welcome-input::placeholder{color:var(--vscode-input-placeholderForeground,var(--vscode-descriptionForeground))}
#welcome-input-wrap:focus-within #welcome-highlight{border-color:var(--vscode-focusBorder)}
#welcome-input-wrap.disabled #welcome-input{cursor:not-allowed}
#welcome-send{
  align-self:flex-end;height:36px;padding:0 20px;
  background:var(--vscode-button-background);
  color:var(--vscode-button-foreground);
  border:none;border-radius:6px;cursor:pointer;
  font-size:var(--vscode-font-size);white-space:nowrap
}
#welcome-send:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
#welcome-send:disabled{opacity:.45;cursor:not-allowed}
.msg{display:flex;flex-direction:column;gap:4px}
.msg.user{align-items:flex-end}
.msg.assistant{align-items:flex-start}
.msg.system{align-items:center}
.bubble{
  max-width:88%;padding:8px 12px;border-radius:8px;
  line-height:1.6;word-break:break-word
}
.user .bubble{
  background:var(--vscode-button-background);
  color:var(--vscode-button-foreground)
}
.assistant .bubble{
  background:var(--vscode-input-background);
  border:1px solid var(--vscode-panel-border)
}
.system .bubble{
  background:transparent;
  color:var(--vscode-descriptionForeground);
  font-size:11px;font-style:italic
}
.msg.warning .bubble{
  color:var(--vscode-editorWarning-foreground,#e2c08d);
  font-size:11px;font-style:italic
}
.msg.file-changes .bubble{
  font-family:var(--vscode-editor-font-family,monospace);
  font-size:10px;
  background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.12));
  border:1px solid var(--vscode-panel-border);
  border-radius:4px;padding:4px 8px;max-width:100%
}
.approval-bubble{
  max-width:92%;
  background:var(--vscode-inputValidation-warningBackground,rgba(226,192,141,.12));
  border:1px solid var(--vscode-inputValidation-warningBorder,var(--vscode-editorWarning-foreground,#e2c08d));
  border-radius:8px;padding:10px 12px
}
.approval-title{
  font-size:11px;font-weight:600;
  color:var(--vscode-editorWarning-foreground,#e2c08d);
  margin-bottom:6px
}
.approval-cmd{
  font-family:var(--vscode-editor-font-family,monospace);font-size:11px;
  background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.15));
  border-radius:4px;padding:6px 8px;margin:0 0 8px;
  white-space:pre-wrap;word-break:break-all
}
.approval-actions{display:flex;gap:8px}
.approval-btn{
  height:28px;padding:0 14px;border:none;border-radius:6px;cursor:pointer;
  font-size:var(--vscode-font-size);font-weight:600
}
.approval-allow{
  background:var(--vscode-button-background);
  color:var(--vscode-button-foreground)
}
.approval-allow:hover{background:var(--vscode-button-hoverBackground)}
.approval-deny{
  background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.2));
  color:var(--vscode-button-secondaryForeground,var(--vscode-editor-foreground))
}
.approval-deny:hover{background:var(--vscode-button-secondaryHoverBackground,rgba(128,128,128,.3))}
.approval-status{
  margin-top:8px;font-size:11px;font-style:italic;
  color:var(--vscode-descriptionForeground)
}
.msg-actions{
  display:flex;align-items:center;height:16px;
  opacity:0;transition:opacity .12s
}
.msg:hover .msg-actions,.msg-actions:focus-within{opacity:1}
.copy-btn{
  display:flex;align-items:center;justify-content:center;
  width:18px;height:18px;padding:0;border:none;border-radius:3px;
  background:transparent;color:var(--vscode-descriptionForeground);
  cursor:pointer
}
.copy-btn:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2));color:var(--vscode-editor-foreground)}
.copy-btn svg{width:12px;height:12px;pointer-events:none}
.copy-btn.copied{color:var(--vscode-terminal-ansiGreen,#89d185)}
.bubble pre .code-copy-btn{
  position:absolute;top:6px;right:6px;
  opacity:0;transition:opacity .12s;
  background:var(--vscode-editorWidget-background,rgba(128,128,128,.25))
}
.bubble pre:hover .code-copy-btn,.bubble pre .code-copy-btn.copied{opacity:1}
.tool-row{display:flex;flex-wrap:wrap;gap:3px;padding-bottom:2px}
.tool-badge{
  padding:1px 6px;border-radius:3px;font-size:10px;
  background:var(--vscode-badge-background);
  color:var(--vscode-badge-foreground);
  cursor:pointer;user-select:none;transition:filter .12s
}
.tool-badge:hover{filter:brightness(1.25)}
.tool-badge.active{
  outline:1px solid var(--vscode-focusBorder);outline-offset:1px
}
.tool-badge.tool-overflow{
  background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.2));
  color:var(--vscode-button-secondaryForeground,var(--vscode-descriptionForeground));
  font-style:italic
}
.tool-detail{
  font-family:var(--vscode-editor-font-family,monospace);font-size:10px;
  background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.12));
  border:1px solid var(--vscode-panel-border);
  border-radius:4px;padding:6px 8px;margin-top:3px;
  white-space:pre-wrap;word-break:break-all;
  max-height:180px;overflow-y:auto;
  color:var(--vscode-editor-foreground);
  animation:fadein .12s ease
}
#tip{
  position:fixed;z-index:999;pointer-events:none;display:none;
  background:var(--vscode-editorWidget-background,#252526);
  border:1px solid var(--vscode-panel-border);
  border-radius:4px;padding:5px 8px;
  font-family:var(--vscode-editor-font-family,monospace);font-size:10px;
  color:var(--vscode-editor-foreground);
  max-width:340px;white-space:pre-wrap;word-break:break-all;
  box-shadow:0 2px 8px rgba(0,0,0,.35);line-height:1.5
}
/* markdown */
.bubble p{margin:4px 0}
.bubble p:first-child{margin-top:0}
.bubble p:last-child{margin-bottom:0}
.bubble .cot-block{
  border:1px solid var(--vscode-panel-border);
  border-radius:6px;padding:6px 10px;margin:6px 0
}
.bubble .cot-block:first-child{margin-top:0}
.bubble .cot-block:last-child{margin-bottom:0}
.bubble .cot-block>*:first-child{margin-top:0}
.bubble .cot-block>*:last-child{margin-bottom:0}
.bubble h1,.bubble h2,.bubble h3,.bubble h4,.bubble h5,.bubble h6{margin:8px 0 4px;font-weight:600}
.bubble h1{font-size:1.2em}
.bubble h2{font-size:1.1em}
.bubble h3,.bubble h4,.bubble h5,.bubble h6{font-size:1em}
.bubble ul,.bubble ol{margin:4px 0;padding-left:20px}
.bubble li{margin:2px 0}
.bubble code{
  font-family:var(--vscode-editor-font-family,monospace);
  background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.15));
  padding:1px 5px;border-radius:3px;font-size:.9em
}
.bubble pre{
  background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.15));
  padding:10px;border-radius:6px;overflow-x:auto;margin:6px 0;
  position:relative
}
.bubble pre code{background:none;padding:0;font-size:.88em;display:block}
.bubble pre[data-lang]::before{
  content:attr(data-lang);
  position:absolute;top:6px;right:30px;
  font-size:10px;opacity:.45;
  font-family:var(--vscode-font-family)
}
.bubble blockquote{
  border-left:3px solid var(--vscode-panel-border);
  padding-left:10px;margin:4px 0;
  color:var(--vscode-descriptionForeground)
}
.bubble strong{font-weight:600}
.bubble em{font-style:italic}
.bubble ol+ol,.bubble ol+ul,.bubble ul+ol{margin-top:-2px}
.bubble table{border-collapse:collapse;margin:6px 0;font-size:.9em;width:auto}
.bubble th,.bubble td{border:1px solid var(--vscode-panel-border);padding:4px 10px;text-align:left}
.bubble th{background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.15));font-weight:600}
.bubble tr:nth-child(even) td{background:rgba(128,128,128,.06)}
.bubble a{color:var(--vscode-textLink-foreground);text-decoration:none}
.bubble a:hover{color:var(--vscode-textLink-activeForeground);text-decoration:underline}
.bubble img{max-width:100%;border-radius:4px;margin:4px 0;display:block}
.bubble hr{border:none;border-top:1px solid var(--vscode-panel-border);margin:10px 0}
.bubble li.task-list-item{list-style:none;margin-left:-20px}
.bubble li.task-list-item input[type=checkbox]{margin-right:6px;vertical-align:middle}
.cursor{
  display:inline-block;width:2px;height:1em;
  background:var(--vscode-editor-foreground);
  animation:blink 1s step-end infinite;
  vertical-align:text-bottom;margin-left:1px
}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.bubble.finalised::after{
  content:'';
  display:block;
  width:16px;height:2px;
  background:var(--vscode-panel-border);
  margin-top:8px;border-radius:1px;opacity:.5
}
.thinking{
  display:flex;align-items:center;gap:6px;
  color:var(--vscode-descriptionForeground);font-size:11px;
  padding:4px 0;animation:fadein .2s ease
}
.cot-toggle{
  display:flex;align-items:center;gap:4px;
  font-size:10px;color:var(--vscode-descriptionForeground);
  cursor:pointer;user-select:none;padding:2px 0;
  font-style:italic;opacity:.7
}
.cot-toggle:hover{opacity:1}
.cot-toggle::before{content:'▶ ';font-size:8px}
.cot-toggle.open::before{content:'▼ '}
@keyframes fadein{from{opacity:0}to{opacity:1}}
.dots span{
  display:inline-block;width:4px;height:4px;border-radius:50%;
  background:currentColor;animation:pulse 1.2s ease-in-out infinite
}
.dots span:nth-child(2){animation-delay:.2s}
.dots span:nth-child(3){animation-delay:.4s}
@keyframes pulse{0%,80%,100%{transform:scale(.8);opacity:.5}40%{transform:scale(1.2);opacity:1}}
#footer{
  border-top:1px solid var(--vscode-panel-border);
  padding:8px;display:flex;flex-direction:column;gap:4px;flex-shrink:0
}
#attach-row{display:none;flex-wrap:wrap;gap:4px;padding-bottom:2px}
#attach-row.has-files{display:flex}
.attach-chip{
  display:inline-flex;align-items:center;gap:5px;
  padding:2px 8px 2px 10px;border-radius:12px;font-size:11px;
  background:var(--vscode-badge-background);
  color:var(--vscode-badge-foreground)
}
.attach-chip-remove{
  cursor:pointer;opacity:.6;font-size:10px;line-height:1;
  padding:1px 2px;border-radius:2px
}
.attach-chip-remove:hover{opacity:1}
#input-row{display:flex;gap:6px;align-items:flex-end}
#attach-btn{
  height:36px;width:36px;flex-shrink:0;
  background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.2));
  color:var(--vscode-button-secondaryForeground,var(--vscode-editor-foreground));
  border:none;border-radius:6px;cursor:pointer;
  display:flex;align-items:center;justify-content:center
}
#attach-btn:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground,rgba(128,128,128,.3))}
#attach-btn:disabled{opacity:.45;cursor:not-allowed}
#input-wrap{
  position:relative;flex:1;min-height:36px;max-height:120px
}
#input-wrap.disabled{opacity:.45}
#input-highlight,#input{
  position:absolute;top:0;left:0;width:100%;
  padding:7px 10px;
  border:1px solid transparent;
  border-radius:6px;
  font-family:var(--vscode-font-family);
  font-size:var(--vscode-font-size);
  line-height:1.4;
  box-sizing:border-box
}
#input-highlight{
  background:var(--vscode-input-background);
  color:var(--vscode-input-foreground);
  border-color:var(--vscode-input-border,var(--vscode-panel-border));
  white-space:pre-wrap;word-wrap:break-word;overflow:hidden;
  pointer-events:none
}
#input{
  resize:none;outline:none;
  background:transparent;color:transparent;
  caret-color:var(--vscode-input-foreground)
}
#input::placeholder{color:var(--vscode-input-placeholderForeground,var(--vscode-descriptionForeground))}
#input-wrap:focus-within #input-highlight{border-color:var(--vscode-focusBorder)}
#input-wrap.disabled #input{cursor:not-allowed}
.cmd-token{font-weight:700;color:var(--vscode-textLink-foreground)}
.ghost-suffix{color:var(--vscode-descriptionForeground);opacity:.65}
#send{
  height:36px;padding:0 14px;
  background:var(--vscode-button-background);
  color:var(--vscode-button-foreground);
  border:none;border-radius:6px;cursor:pointer;
  font-size:var(--vscode-font-size);white-space:nowrap
}
#send:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
#send:disabled{opacity:.45;cursor:not-allowed}
#stop{
  height:36px;padding:0 14px;
  background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.2));
  color:var(--vscode-button-secondaryForeground,var(--vscode-editor-foreground));
  border:none;border-radius:6px;cursor:pointer;
  font-size:var(--vscode-font-size);white-space:nowrap;display:none
}
#stop:hover{background:var(--vscode-button-secondaryHoverBackground,rgba(128,128,128,.3))}
#thinking-bar{
  display:none;flex-shrink:0;
  padding:4px 12px;
  border-top:1px solid var(--vscode-panel-border);
  align-items:center;gap:6px;
  color:var(--vscode-descriptionForeground);font-size:11px;
  animation:fadein .15s ease
}
#thinking-bar.active{display:flex}
</style>
</head>
<body>
<div id="header">
  <span class="brand">${this._mark('icon-mark', 'fr-mark-header')}fuseraft REPL</span>
  <select id="model-select" disabled title="Switch model"></select>
  <span class="session" id="session-label"></span>
</div>
<div id="tip"></div>
<div id="messages">
  <div id="welcome">
    <div id="welcome-inner">
      <div id="welcome-title">${this._mark('icon-mark', 'fr-mark-welcome')}fuseraft</div>
      <div id="welcome-hint">What would you like to work on?</div>
      <div id="welcome-input-wrap" class="disabled">
        <div id="welcome-highlight" aria-hidden="true">&nbsp;</div>
        <textarea id="welcome-input" rows="3" placeholder="Ask something or type a /command…" disabled></textarea>
      </div>
      <button id="welcome-send" disabled>Send</button>
    </div>
  </div>
</div>
<div id="thinking-bar">
  <span class="dots"><span></span><span></span><span></span></span>
  <span id="thinking-label">Thinking…</span>
</div>
<div id="footer" style="display:none">
  <div id="attach-row"></div>
  <div id="input-row">
    <button id="attach-btn" title="Attach files" disabled>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M4.5 3a2.5 2.5 0 0 1 5 0v9a1.5 1.5 0 0 1-3 0V5a.5.5 0 0 1 1 0v7a.5.5 0 0 0 1 0V3a1.5 1.5 0 1 0-3 0v9a2.5 2.5 0 0 0 5 0V5a.5.5 0 0 1 1 0v7a3.5 3.5 0 1 1-7 0z"/>
      </svg>
    </button>
    <div id="input-wrap" class="disabled">
      <div id="input-highlight" aria-hidden="true">&nbsp;</div>
      <textarea id="input" rows="1" placeholder="Ask something or type a /command…" disabled></textarea>
    </div>
    <button id="stop">Stop</button>
    <button id="send" disabled>Send</button>
  </div>
</div>
<script>
const vscode   = acquireVsCodeApi();
const $msgs    = document.getElementById('messages');
const $input   = document.getElementById('input');
const $send    = document.getElementById('send');
const $stop    = document.getElementById('stop');
const $tip     = document.getElementById('tip');
const $welcome      = document.getElementById('welcome');
const $wInput       = document.getElementById('welcome-input');
const $wInputWrap   = document.getElementById('welcome-input-wrap');
const $wHighlight   = document.getElementById('welcome-highlight');
const $wSend        = document.getElementById('welcome-send');
const $inputWrap    = document.getElementById('input-wrap');
const $inputHighlight = document.getElementById('input-highlight');
const $modelSelect  = document.getElementById('model-select');
const $thinkingBar   = document.getElementById('thinking-bar');
const $thinkingLabel = document.getElementById('thinking-label');
const $footer        = document.getElementById('footer');
const $attachBtn     = document.getElementById('attach-btn');
const $attachRow     = document.getElementById('attach-row');
let modelsLoaded     = false;
let activeModel      = ''; // model actually running this session, set by the CLI's 'ready' event
let attachedFiles    = []; // [{name, path}]
let skillNames       = []; // $skill-name completion targets, populated by the 'skills' message

// Marks the given model as selected in the dropdown, adding it as an option
// first if the provider's model list didn't happen to include it (e.g. a
// manually entered model ID).
function selectModel(model){
  if(!model) return;
  activeModel = model;
  for(const opt of $modelSelect.options){
    if(opt.value===model){ opt.selected=true; return; }
  }
  const opt=document.createElement('option');
  opt.value=model; opt.textContent=model; opt.selected=true;
  $modelSelect.appendChild(opt);
}

function renderAttachments(){
  $attachRow.innerHTML='';
  if(!attachedFiles.length){ $attachRow.classList.remove('has-files'); return; }
  $attachRow.classList.add('has-files');
  for(const {name,path} of attachedFiles){
    const chip=document.createElement('span');
    chip.className='attach-chip';
    const label=document.createElement('span');
    label.textContent=name;
    const rm=document.createElement('span');
    rm.className='attach-chip-remove';
    rm.textContent='✕';
    rm.title='Remove';
    rm.addEventListener('click',()=>{
      attachedFiles=attachedFiles.filter(f=>f.path!==path);
      renderAttachments();
    });
    chip.appendChild(label);
    chip.appendChild(rm);
    $attachRow.appendChild(chip);
  }
}

/* ── slash/skill completion ──────────────────────────── */
// Mirrors ReplLineReader's SlashCommands/SubCommands in fuseraft-cli — keep in sync.
const SLASH_COMMANDS = [
  '/adversarial','/assist','/clear','/compact','/context',
  '/conversation','/delegate','/events','/execute','/exit','/explore',
  '/fork','/help','/hitl','/history','/last','/locate',
  '/max-tokens','/mcp','/memory','/model','/models','/paste','/plan',
  '/provider','/reasoning','/recover','/resume','/retry','/rewind',
  '/run','/safe-mode','/save','/seed','/sessions','/snapshot','/switch',
  '/system','/temperature','/tools','/top-p','/undo',
];
const SUB_COMMANDS = {
  '/adversarial':  ['off','on'],
  '/fork':         ['switch'],
  '/hitl':         ['off','on'],
  '/max-tokens':   ['reset'],
  '/mcp':          ['add','remove'],
  '/memory':       ['delete','list','save','show'],
  '/provider':     ['setup'],
  '/safe-mode':    ['off','on'],
  '/seed':         ['reset'],
  '/temperature':  ['reset'],
  '/tools':        ['disable','enable','restrict','unrestrict'],
  '/top-p':        ['reset'],
};

// Returns full completion strings for the given input, e.g. '/tool' -> ['/tools'],
// or '/tools d' -> ['/tools disable']. Mirrors ReplLineReader's Tab-completion rules.
function findCompletions(text){
  if(text.startsWith('$') && !text.includes(' ')){
    const partial = text.slice(1).toLowerCase();
    return skillNames
      .filter(n=>n.toLowerCase().startsWith(partial))
      .sort((a,b)=>a.localeCompare(b))
      .map(n=>'$'+n);
  }
  if(text.startsWith('/')){
    const spaceIdx = text.indexOf(' ');
    if(spaceIdx<0){
      const t = text.toLowerCase();
      return SLASH_COMMANDS.filter(c=>c.toLowerCase().startsWith(t));
    }
    const cmd  = text.slice(0,spaceIdx);
    const rest = text.slice(spaceIdx+1);
    const subs = SUB_COMMANDS[cmd.toLowerCase()];
    if(!subs) return [];
    const r = rest.toLowerCase();
    return subs.filter(s=>s.toLowerCase().startsWith(r)).map(s=>cmd+' '+s);
  }
  return [];
}

// Bolds the leading /command (and its subcommand, if recognized) or $skill-name token.
// Only a token that's an exact, recognized match gets bolded — free-text args never do.
function highlightTokens(text){
  const spaceIdx   = text.indexOf(' ');
  const firstToken = spaceIdx<0 ? text : text.slice(0,spaceIdx);
  if(text.startsWith('$')){
    const name = firstToken.slice(1);
    if(name && skillNames.some(n=>n.toLowerCase()===name.toLowerCase()))
      return '<span class="cmd-token">'+esc(firstToken)+'</span>'+esc(text.slice(firstToken.length));
    return esc(text);
  }
  if(text.startsWith('/')){
    if(!SLASH_COMMANDS.some(c=>c.toLowerCase()===firstToken.toLowerCase())) return esc(text);
    let out  = '<span class="cmd-token">'+esc(firstToken)+'</span>';
    let rest = text.slice(firstToken.length);
    const subs = SUB_COMMANDS[firstToken.toLowerCase()];
    if(subs){
      const m = rest.match(/^(\\s+)(\\S+)/);
      if(m && subs.some(s=>s.toLowerCase()===m[2].toLowerCase())){
        out  += esc(m[1])+'<span class="cmd-token">'+esc(m[2])+'</span>';
        rest  = rest.slice(m[0].length);
      }
    }
    return out + esc(rest);
  }
  return esc(text);
}

// Wires a textarea + its background highlight/ghost-text mirror div together: keeps the
// mirror's box the same size as the textarea (whose own text is transparent — only the
// mirror's text is actually visible), renders bold command tokens plus a dim "shadow"
// completion after the caret, and makes Tab accept/cycle that completion the same way
// ReplLineReader's terminal tab-completion does.
function setupCommandInput(ta, wrap, mirror, maxHeight){
  let tabActive = false, tabMatches = [], tabIndex = -1;

  function resetTab(){ tabActive=false; tabMatches=[]; tabIndex=-1; }

  function ghostSuffix(text){
    if(ta.selectionStart!==ta.selectionEnd || ta.selectionEnd!==text.length) return '';
    const matches = tabActive ? tabMatches : findCompletions(text);
    if(!matches.length) return '';
    const target = tabActive ? matches[tabIndex] : matches[0];
    if(target.length<=text.length) return '';
    if(target.slice(0,text.length).toLowerCase()!==text.toLowerCase()) return '';
    return target.slice(text.length);
  }

  function render(){
    const text  = ta.value;
    let html    = highlightTokens(text);
    const ghost = ghostSuffix(text);
    if(ghost) html += '<span class="ghost-suffix">'+esc(ghost)+'</span>';
    mirror.innerHTML = html || '&nbsp;';
  }

  function resize(){
    ta.style.height = 'auto';
    const h = Math.min(ta.scrollHeight, maxHeight);
    ta.style.height   = h+'px';
    wrap.style.height = h+'px';
    mirror.style.height = h+'px';
    mirror.scrollTop = ta.scrollTop;
  }

  function sync(){ resize(); render(); }

  ta.addEventListener('input', ()=>{ resetTab(); sync(); });
  ta.addEventListener('click', render);
  ta.addEventListener('keyup', e=>{
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)) render();
  });
  ta.addEventListener('scroll', ()=>{ mirror.scrollTop = ta.scrollTop; });
  ta.addEventListener('keydown', e=>{
    if(e.key!=='Tab') return;
    const text    = ta.value;
    const matches = tabActive ? tabMatches : findCompletions(text);
    if(!matches.length) return; // nothing to complete — let Tab move focus as usual
    e.preventDefault();
    tabIndex   = (tabIndex+1) % matches.length;
    tabMatches = matches;
    tabActive  = true;
    const completed = matches[tabIndex] + (matches.length===1 ? ' ' : '');
    ta.value = completed;
    ta.selectionStart = ta.selectionEnd = completed.length;
    sync();
  });

  return { sync, resetTab };
}

const wCtl = setupCommandInput($wInput, $wInputWrap, $wHighlight, 200);
const mCtl = setupCommandInput($input, $inputWrap, $inputHighlight, 120);
wCtl.sync();
mCtl.sync();

let curBubble   = null;
let curTools    = null;
let curText     = '';
let curMsgDiv   = null;
let isStreaming  = false;
// True while the inline "thinking…" placeholder (in the message list) is covering the
// wait — the bottom thinking-bar is redundant in that case and stays hidden to avoid
// showing two "thinking" indicators at once.
let usingInlineThinking = false;
let curToolList  = [];
// Mutable {expanded} holder for the tool row currently being built. Passed by
// reference into _renderToolRow's overflow-pill closures so each finalised
// message's pill keeps working against its own tool row/list forever, instead
// of a shared global that later turns repurpose out from under it.
let curToolState = { expanded: false };

// Tool-detail expand state — at most one expanded at a time.
let activeDetailBadge = null;
let activeDetail      = null;

const TOOL_VISIBLE_MAX = 5;

/* ── helpers ─────────────────────────────────────────── */
function esc(s){
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const ICON_COPY  = '<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M4 4V2.5A1.5 1.5 0 0 1 5.5 1h7A1.5 1.5 0 0 1 14 2.5v7a1.5 1.5 0 0 1-1.5 1.5H11v1.5A1.5 1.5 0 0 1 9.5 14h-7A1.5 1.5 0 0 1 1 12.5v-7A1.5 1.5 0 0 1 2.5 4H4zm1 0h4.5A1.5 1.5 0 0 1 11 5.5V10h1.5a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-7a.5.5 0 0 0-.5.5V4zM2.5 5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-7z"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13.85 4.15a.5.5 0 0 1 0 .707l-7 7a.5.5 0 0 1-.707 0l-3.5-3.5a.5.5 0 1 1 .707-.707L6.5 10.793l6.646-6.647a.5.5 0 0 1 .707 0z"/></svg>';

function makeCopyBtn(getText){
  const btn=document.createElement('button');
  btn.type='button';
  btn.className='copy-btn';
  btn.title='Copy message';
  btn.innerHTML=ICON_COPY;
  btn.addEventListener('click',e=>{
    e.stopPropagation();
    const text=getText();
    if(!text) return;
    navigator.clipboard.writeText(text).then(()=>{
      btn.innerHTML=ICON_CHECK;
      btn.classList.add('copied');
      btn.title='Copied!';
      setTimeout(()=>{
        btn.innerHTML=ICON_COPY;
        btn.classList.remove('copied');
        btn.title='Copy message';
      },1200);
    });
  });
  return btn;
}

function makeActionsRow(getText){
  const row=document.createElement('div');
  row.className='msg-actions';
  row.appendChild(makeCopyBtn(getText));
  return row;
}

// Code-fence copy buttons are baked into mdToHtml's output as static markup
// (re-rendered on every streamed token), so a single delegated listener
// handles clicks rather than rebinding one per button on every render.
$msgs.addEventListener('click', e=>{
  const btn = e.target.closest('.code-copy-btn');
  if(!btn) return;
  e.stopPropagation();
  const code = btn.nextElementSibling;
  const text = code ? code.textContent : '';
  if(!text) return;
  navigator.clipboard.writeText(text).then(()=>{
    btn.innerHTML = ICON_CHECK;
    btn.classList.add('copied');
    btn.title = 'Copied!';
    setTimeout(()=>{
      btn.innerHTML = ICON_COPY;
      btn.classList.remove('copied');
      btn.title = 'Copy code';
    },1200);
  });
});

function buildList(text){
  const lines=text.replace(/\\n$/,'').split('\\n');
  const root={children:[]};
  const stack=[{indent:-1,node:root}];
  for(const line of lines){
    const m=line.match(/^([ \\t]*)(?:([-*+])|(\\d+)\\.)[ \\t]+(.*)$/);
    if(!m) continue;
    const indent=m[1].replace(/\\t/g,'    ').length;
    const ordered=m[3]!==undefined;
    const number=ordered?parseInt(m[3],10):null;
    let content=m[4];
    let task=null;
    const tm=content.match(/^\\[([ xX])\\][ \\t]+(.*)$/);
    if(tm){ task=tm[1]!==' '; content=tm[2]; }
    while(stack.length>1 && indent<=stack[stack.length-1].indent) stack.pop();
    const parent=stack[stack.length-1].node;
    if(parent.children.length===0){ parent.ordered=ordered; parent.start=number; }
    const item={content,children:[],task};
    parent.children.push(item);
    stack.push({indent,node:item});
  }
  function render(node){
    if(!node.children.length) return '';
    const tag=node.ordered?'ol':'ul';
    const attr=(node.ordered && node.start && node.start!==1)?' start="'+node.start+'"':'';
    return '<'+tag+attr+'>'+node.children.map(c=>{
      const cls=c.task!==null?' class="task-list-item"':'';
      const box=c.task!==null?'<input type="checkbox" disabled'+(c.task?' checked':'')+'> ':'';
      return '<li'+cls+'>'+box+c.content+render(c)+'</li>';
    }).join('')+'</'+tag+'>';
  }
  return render(root);
}

function mdToHtml(raw){
  if(!raw) return '';
  const blocks=[];
  // block-level constructs are stashed as placeholders (padded with blank
  // lines) so the paragraph pass below never mangles their inner markup,
  // even when the source has no blank line separating them from prose.
  const stash=html=>{
    const i=blocks.length;
    blocks.push(html);
    return '\\n\\n\\x00'+i+'\\x00\\n\\n';
  };
  // extract fenced code blocks
  let s = raw.replace(/\`\`\`(\\w*)\\n?([\\s\\S]*?)\`\`\`/g,(_,lang,code)=>{
    const attr=lang?' data-lang="'+esc(lang)+'"':'';
    const btn='<button type="button" class="code-copy-btn" title="Copy code">'+ICON_COPY+'</button>';
    return stash('<pre'+attr+'>'+btn+'<code>'+esc(code.replace(/\\n$/,''))+'</code></pre>');
  });
  s = esc(s);
  // inline code
  s = s.replace(/\`([^\`\\n]+)\`/g,'<code>$1</code>');
  // images (before links: image syntax is link syntax prefixed with !)
  s = s.replace(/!\\[([^\\]\\n]*)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g,(_,alt,url)=>'<img src="'+url+'" alt="'+alt+'" loading="lazy">');
  // links (http/https/mailto only, to avoid javascript:/data: hrefs)
  s = s.replace(/\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s)]+|mailto:[^\\s)]+)\\)/g,(_,text,url)=>'<a href="'+url+'" title="'+url+'" target="_blank" rel="noopener noreferrer">'+text+'</a>');
  // bold+italic, bold, italic
  s = s.replace(/\\*\\*\\*([^*]+?)\\*\\*\\*/g,'<strong><em>$1</em></strong>');
  s = s.replace(/\\*\\*([^*]+?)\\*\\*/g,'<strong>$1</strong>');
  s = s.replace(/(?<!\\*)\\*([^*\\n]+?)\\*(?!\\*)/g,'<em>$1</em>');
  // headers
  s = s.replace(/^###### (.+)$/gm,(_,t)=>stash('<h6>'+t+'</h6>'));
  s = s.replace(/^##### (.+)$/gm,(_,t)=>stash('<h5>'+t+'</h5>'));
  s = s.replace(/^#### (.+)$/gm,(_,t)=>stash('<h4>'+t+'</h4>'));
  s = s.replace(/^### (.+)$/gm,(_,t)=>stash('<h3>'+t+'</h3>'));
  s = s.replace(/^## (.+)$/gm,(_,t)=>stash('<h2>'+t+'</h2>'));
  s = s.replace(/^# (.+)$/gm,(_,t)=>stash('<h1>'+t+'</h1>'));
  // horizontal rule
  s = s.replace(/^ {0,3}(?:-{3,}|_{3,}|\\*{3,})[ \\t]*$/gm,()=>stash('<hr>'));
  // blockquote (consecutive lines merge into a single quote block)
  s = s.replace(/((?:^&gt; ?.*$\\n?)+)/gm,m=>{
    const text=m.replace(/^&gt; ?/gm,'').replace(/\\n$/,'');
    return stash('<blockquote>'+text.split('\\n').join('<br>')+'</blockquote>');
  });
  // lists (unordered/ordered, arbitrarily nested by indentation)
  s = s.replace(/((?:^[ \\t]*(?:[-*+]|\\d+\\.)[ \\t]+.+$\\n?)+)/gm,m=>stash(buildList(m)));
  // tables: match header row | separator row | one or more data rows
  s = s.replace(/((?:^[ \\t]*\\|.+\\|[ \\t]*$\\n?){2,})/gm, m=>{
    const rows = m.trim().split('\\n');
    if(rows.length < 2) return m;
    // A separator row's cells must each be dashes (with optional alignment colons) — checked
    // cell-by-cell rather than with a blanket character class, which would also accept an
    // all-blank header row like "| | |" (itself made only of pipes/spaces) as the separator.
    const isSep = r => {
      const t = r.trim();
      if(!/^\\|.*\\|$/.test(t)) return false;
      const cells = t.slice(1,-1).split('|');
      return cells.length>0 && cells.every(c=>/^:?-+:?$/.test(c.trim()));
    };
    const sepIdx = rows.findIndex(isSep);
    if(sepIdx < 1) return m;
    const parseRow = r => r.replace(/^[ \\t]*\\|/, '').replace(/\\|[ \\t]*$/, '').split('|').map(c=>c.trim());
    const headers = parseRow(rows[0]);
    const thead = '<thead><tr>' + headers.map(h=>'<th>'+h+'</th>').join('') + '</tr></thead>';
    const bodyRows = rows.slice(sepIdx+1).filter(r=>r.trim()).map(r=>{
      return '<tr>'+parseRow(r).map(c=>'<td>'+c+'</td>').join('')+'</tr>';
    });
    return stash('<table>'+thead+'<tbody>'+bodyRows.join('')+'</tbody></table>');
  });
  // paragraphs
  s = s.split(/\\n{2,}/).filter(p=>p.trim()!=='').map(para=>{
    if(/^\\x00\\d+\\x00$/.test(para.trim())) return para.trim();
    return '<p>'+para.replace(/\\n/g,'<br>')+'</p>';
  }).join('\\n');
  // restore stashed blocks
  s = s.replace(/\\x00(\\d+)\\x00/g,(_,i)=>blocks[parseInt(i)]);
  return s;
}

function scrollBottom(){
  $msgs.scrollTop = $msgs.scrollHeight;
}

function setThinkingLabel(text){ $thinkingLabel.textContent = text; }
function resetThinkingLabel(){ $thinkingLabel.textContent = 'Thinking…'; }

function setEnabled(on){
  $input.disabled = !on;
  $inputWrap.classList.toggle('disabled', !on);
  $send.disabled  = !on;
  $send.style.display = (!on && isStreaming) ? 'none' : '';
  $stop.style.display = (!on && isStreaming) ? 'block' : 'none';
  $thinkingBar.classList.toggle('active', !on && isStreaming && !usingInlineThinking);
  $attachBtn.disabled = !on;
  if(modelsLoaded) $modelSelect.disabled = !on;
  if(on && $welcome.style.display==='none') $input.focus();
}

/* ── message builders ────────────────────────────────── */
function addUser(text){
  const d = document.createElement('div');
  d.className='msg user';
  d.innerHTML='<div class="bubble">'+mdToHtml(text)+'</div>';
  d.appendChild(makeActionsRow(()=>text));
  $msgs.appendChild(d);
  scrollBottom();
}

function startAssistant(){
  curMsgDiv = document.createElement('div');
  curMsgDiv.className='msg assistant';

  curTools = document.createElement('div');
  curTools.className='tool-row';
  curMsgDiv.appendChild(curTools);

  curBubble = document.createElement('div');
  curBubble.className='bubble';
  curBubble.innerHTML='<span class="cursor"></span>';
  curMsgDiv.appendChild(curBubble);

  curText='';
  curToolList=[];
  curToolState={expanded:false};
  $msgs.appendChild(curMsgDiv);
  scrollBottom();
}

function startThinking(){
  curMsgDiv = document.createElement('div');
  curMsgDiv.className='msg assistant';
  curMsgDiv.innerHTML='<div class="thinking"><span class="dots"><span></span><span></span><span></span></span> thinking…</div>';
  $msgs.appendChild(curMsgDiv);
  scrollBottom();
}

// Everything since the last blank-line boundary — the paragraph/block
// currently being written. A blank line inside an unterminated code fence
// doesn't count as a boundary, so a snippet with blank lines inside it
// stays intact until its closing \`\`\`.
function currentChunk(text){
  const fenceCount = (text.match(/\`\`\`/g)||[]).length;
  const from = fenceCount % 2 === 1 ? text.lastIndexOf('\`\`\`') : text.length;
  const boundary = text.lastIndexOf('\\n\\n', from);
  return boundary === -1 ? text : text.slice(boundary+2);
}

// Splits full text into the same blank-line-delimited blocks currentChunk
// steps through live, re-merging any split that lands inside an open code
// fence — used to box up each block in the finalised bubble.
function splitBlocks(text){
  const parts = text.split(/\\n{2,}/).filter(p=>p.trim()!=='');
  const blocks = [];
  let i = 0;
  while(i < parts.length){
    let block = parts[i];
    while((block.match(/\`\`\`/g)||[]).length % 2 === 1 && i+1 < parts.length){
      i++;
      block += '\\n\\n' + parts[i];
    }
    blocks.push(block);
    i++;
  }
  return blocks;
}

function appendToken(text){
  if(!curBubble) startAssistant();
  curText += text;
  // Render only the in-progress block live, so the bubble shows one
  // thought/paragraph at a time instead of the whole response piling up
  // while streaming; finalise() reveals the full accumulated curText once
  // the turn ends.
  curBubble.innerHTML = mdToHtml(currentChunk(curText)) + '<span class="cursor"></span>';
  scrollBottom();
}

function _makeBadge(name, args){
  const hasArgs = args && Object.keys(args).length > 0;
  const badge = document.createElement('span');
  badge.className = 'tool-badge';
  badge.textContent = name;
  const full = hasArgs ? fmtArgsFull(args) : '(no arguments)';
  if(hasArgs){
    badge.addEventListener('mouseenter', e => tipShow(e, fmtArgsSummary(args)));
    badge.addEventListener('mousemove',  e => tipMove(e));
    badge.addEventListener('mouseleave',     tipHide);
  }
  badge.addEventListener('click', () => { tipHide(); toggleDetail(badge, full); });
  return badge;
}

// toolsRow/toolList/state are captured explicitly (rather than read from the
// current-message globals) so that each rendered pill's click handler keeps
// operating on the tool row it was built for, even after that message is
// finalised and the globals have moved on to a later turn.
function _renderToolRow(toolsRow, toolList, state){
  if(!toolsRow) return;
  collapseDetail();
  toolsRow.innerHTML='';
  const count = toolList.length;
  if(count <= TOOL_VISIBLE_MAX || state.expanded){
    for(const {name, args} of toolList){
      toolsRow.appendChild(_makeBadge(name, args));
    }
    if(count > TOOL_VISIBLE_MAX){
      const pill = document.createElement('span');
      pill.className='tool-badge tool-overflow';
      pill.textContent='▲ collapse';
      pill.addEventListener('click', ()=>{ state.expanded=false; _renderToolRow(toolsRow, toolList, state); scrollBottom(); });
      toolsRow.appendChild(pill);
    }
  } else {
    const pill = document.createElement('span');
    pill.className='tool-badge tool-overflow';
    pill.textContent=count+' tool calls ▶';
    pill.addEventListener('click', ()=>{ state.expanded=true; _renderToolRow(toolsRow, toolList, state); scrollBottom(); });
    toolsRow.appendChild(pill);
  }
}

function addToolBadge(name, args){
  if(!curTools){
    if(curMsgDiv && curMsgDiv.querySelector('.thinking')){
      curMsgDiv.innerHTML='';
      curTools = document.createElement('div');
      curTools.className='tool-row';
      curMsgDiv.appendChild(curTools);
      curBubble = document.createElement('div');
      curBubble.className='bubble';
      curBubble.innerHTML='<span class="cursor"></span>';
      curMsgDiv.appendChild(curBubble);
      curText='';
      curToolList=[];
      curToolState={expanded:false};
    } else {
      startAssistant();
    }
  }
  curToolList.push({name, args});
  _renderToolRow(curTools, curToolList, curToolState);
  scrollBottom();
}

/* ── tooltip ─────────────────────────────────────────── */
function tipShow(e, text){
  $tip.textContent = text;
  $tip.style.display = 'block';
  tipMove(e);
}
function tipMove(e){
  const pad = 10;
  const tw  = $tip.offsetWidth;
  const th  = $tip.offsetHeight;
  let x = e.clientX + 14;
  let y = e.clientY + 14;
  if(x + tw + pad > window.innerWidth)  x = e.clientX - tw - 6;
  if(y + th + pad > window.innerHeight) y = e.clientY - th - 6;
  $tip.style.left = x + 'px';
  $tip.style.top  = y + 'px';
}
function tipHide(){ $tip.style.display='none'; }

/* ── detail expand/collapse ──────────────────────────── */
function toggleDetail(badge, full){
  if(activeDetailBadge === badge){ collapseDetail(); return; }
  collapseDetail();
  const row = badge.closest('.tool-row');
  if(!row) return;
  const det = document.createElement('div');
  det.className = 'tool-detail';
  det.textContent = full;
  row.after(det);
  badge.classList.add('active');
  activeDetailBadge = badge;
  activeDetail      = det;
}
function collapseDetail(){
  activeDetail?.remove();
  activeDetailBadge?.classList.remove('active');
  activeDetailBadge = null;
  activeDetail      = null;
}

/* ── arg formatters ──────────────────────────────────── */
function fmtVal(v){
  return typeof v === 'string' ? v : JSON.stringify(v);
}
// Tooltip: one line per arg, values truncated at 120 chars.
function fmtArgsSummary(args){
  return Object.entries(args).map(([k,v])=>{
    const s = fmtVal(v).replace(/\\n/g,' ');
    return k + ': ' + (s.length > 120 ? s.slice(0,117)+'…' : s);
  }).join('\\n');
}
// Expanded: full values with newlines preserved.
function fmtArgsFull(args){
  return Object.entries(args).map(([k,v])=>{
    const s = fmtVal(v);
    // indent continuation lines
    const indented = s.replace(/\\n/g,'\\n  ');
    return k + ':\\n  ' + indented;
  }).join('\\n\\n');
}

function _collapseIntoCot(msgDiv, bubble, toolsRow){
  const toggle = document.createElement('div');
  toggle.className='cot-toggle';
  toggle.textContent='chain of thought';
  msgDiv.insertBefore(toggle, toolsRow||bubble);
  toolsRow.style.display='none';
  bubble.style.display='none';
  toggle.addEventListener('click',()=>{
    const open=toggle.classList.contains('open');
    toggle.classList.toggle('open',!open);
    toolsRow.style.display=open?'none':'';
    bubble.style.display=open?'none':'';
    scrollBottom();
  });
}

function finalise(){
  if(curBubble){
    const rendered = mdToHtml(curText);
    const text = curText;
    if(!rendered && (!curTools || !curTools.children.length)){
      curMsgDiv?.remove();
    } else if(curText.trim().endsWith(':')){
      curBubble.innerHTML = rendered || '';
      _collapseIntoCot(curMsgDiv, curBubble, curTools);
      curMsgDiv.appendChild(makeActionsRow(()=>text));
    } else {
      // Box each streamed block separately so the breaks between them —
      // where one chain-of-thought bubble replaced another while live —
      // stay visible after the message is done.
      curBubble.innerHTML = splitBlocks(text).map(b=>'<div class="cot-block">'+mdToHtml(b)+'</div>').join('');
      curBubble.classList.add('finalised');
      curMsgDiv.appendChild(makeActionsRow(()=>text));
    }
  } else if(curMsgDiv){
    curMsgDiv.remove();
  }
  curBubble=null; curTools=null; curText=''; curMsgDiv=null;
  curToolList=[]; curToolState={expanded:false};
  isStreaming=false;
  resetThinkingLabel();
  setEnabled(true);
  scrollBottom();
}

function addSystem(text){
  const d=document.createElement('div');
  d.className='msg system';
  d.innerHTML='<div class="bubble">'+esc(text)+'</div>';
  $msgs.appendChild(d);
  scrollBottom();
}

function addSystemHtml(html){
  const d=document.createElement('div');
  d.className='msg system';
  d.innerHTML='<div class="bubble">'+html+'</div>';
  $msgs.appendChild(d);
  scrollBottom();
}

function addWarning(text){
  const d=document.createElement('div');
  d.className='msg warning';
  d.innerHTML='<div class="bubble">⚠ '+esc(text)+'</div>';
  $msgs.appendChild(d);
  scrollBottom();
}

/* ── HITL shell-command approval ─────────────────────── */
let curApprovalDiv = null;

function addApproval(command){
  const d = document.createElement('div');
  d.className='msg system';
  const bubble = document.createElement('div');
  bubble.className='bubble approval-bubble';
  bubble.innerHTML =
    '<div class="approval-title">⏸ Shell command requested</div>' +
    '<pre class="approval-cmd">'+esc(command||'')+'</pre>';
  const actions = document.createElement('div');
  actions.className='approval-actions';
  const allowBtn = document.createElement('button');
  allowBtn.className='approval-btn approval-allow';
  allowBtn.textContent='Allow';
  allowBtn.addEventListener('click',()=>respondApproval(true));
  const denyBtn = document.createElement('button');
  denyBtn.className='approval-btn approval-deny';
  denyBtn.textContent='Deny';
  denyBtn.addEventListener('click',()=>respondApproval(false));
  actions.appendChild(allowBtn);
  actions.appendChild(denyBtn);
  bubble.appendChild(actions);
  d.appendChild(bubble);
  $msgs.appendChild(d);
  curApprovalDiv = d;
  setThinkingLabel('Waiting for approval…');
  scrollBottom();
}

function respondApproval(approved){
  if(!curApprovalDiv) return;
  settleApproval(curApprovalDiv, approved);
  curApprovalDiv = null;
  vscode.postMessage({type:'approval_response', approved});
}

// Removes the Allow/Deny buttons and appends a resolved-status line. Split out from
// respondApproval so an abandoned approval (session ended / turn cancelled while pending)
// can also be visually resolved without pretending a response was sent to the CLI.
function settleApproval(div, approved){
  const actions = div.querySelector('.approval-actions');
  if(actions) actions.remove();
  const status = document.createElement('div');
  status.className='approval-status';
  status.textContent = approved===null ? 'Cancelled' : (approved ? 'Allowed' : 'Denied');
  div.querySelector('.approval-bubble')?.appendChild(status);
}

function abandonPendingApproval(){
  if(!curApprovalDiv) return;
  settleApproval(curApprovalDiv, null);
  curApprovalDiv = null;
}

function addFileChanges(changes){
  if(!changes||!changes.length) return;
  const sigilLabel={'A':'added','M':'modified','D':'deleted','R':'renamed'};
  const lines=changes.map(c=>{
    const label=sigilLabel[c.sigil]||c.sigil;
    return esc(label)+': '+esc(c.path);
  });
  const d=document.createElement('div');
  d.className='msg file-changes';
  d.innerHTML='<div class="bubble">'+lines.join('<br>')+'</div>';
  $msgs.appendChild(d);
  scrollBottom();
}

/* ── welcome prompt ──────────────────────────────────── */
function dismissWelcome(){
  if($welcome.style.display==='none') return;
  $welcome.style.display='none';
  $footer.style.display='flex';
  mCtl.sync();
}

function sendFromWelcome(){
  const text=$wInput.value.trim();
  if(!text||isStreaming) return;
  dismissWelcome();
  $wInput.value='';
  wCtl.resetTab();
  wCtl.sync();
  addUser(text);
  isStreaming=true;
  usingInlineThinking = !text.startsWith('/');
  if(text.trim()==='/exit') setThinkingLabel('Ending your session…');
  setEnabled(false);
  if(usingInlineThinking) startThinking();
  vscode.postMessage({type:'user_input',text});
}

$wSend.addEventListener('click',sendFromWelcome);
$wInput.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendFromWelcome();}
});

/* ── send ────────────────────────────────────────────── */
function send(){
  const text = $input.value.trim();
  if(!text || isStreaming) return;
  $input.value='';
  mCtl.resetTab();
  mCtl.sync();
  addUser(text);
  isStreaming=true;
  usingInlineThinking = !text.startsWith('/');
  if(text.trim()==='/exit') setThinkingLabel('Ending your session…');
  setEnabled(false);
  if(usingInlineThinking) startThinking();
  let payload = text;
  if(attachedFiles.length){
    const list = attachedFiles.map((f,i)=>(i+1)+'. '+f.path).join('\\n');
    payload = 'The user referenced the following files which may be of interest in this message:\\n'+list+'\\n\\n'+text;
    attachedFiles=[];
    renderAttachments();
  }
  vscode.postMessage({type:'user_input',text:payload});
}

$send.addEventListener('click',send);
$stop.addEventListener('click',()=>{ vscode.postMessage({type:'interrupt'}); });
$attachBtn.addEventListener('click',()=>{ vscode.postMessage({type:'pick_files'}); });
$modelSelect.addEventListener('change',()=>{
  if(isStreaming) return;
  isStreaming=true;
  usingInlineThinking = false;
  setEnabled(false);
  vscode.postMessage({type:'model_change',model:$modelSelect.value});
});
$input.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}
});

/* ── event handler ───────────────────────────────────── */
window.addEventListener('message',evt=>{
  const msg=evt.data;
  switch(msg.type){
    case 'ready':
      document.getElementById('session-label').textContent=msg.sessionId?'· '+msg.sessionId:'';
      if(msg.model) selectModel(msg.model);
      $wInput.disabled=false;
      $wInputWrap.classList.remove('disabled');
      $wSend.disabled=false;
      $wInput.focus();
      setEnabled(true);
      break;

    case 'skills':
      skillNames = Array.isArray(msg.list) ? msg.list : [];
      wCtl.sync();
      mCtl.sync();
      break;

    case 'models':{
      $modelSelect.innerHTML='';
      for(const m of (msg.list||[])){
        const opt=document.createElement('option');
        opt.value=m; opt.textContent=m;
        $modelSelect.appendChild(opt);
      }
      modelsLoaded=true;
      // Prefer the model this session actually launched with (from 'ready')
      // over msg.current, which just reflects the persisted global default
      // and knows nothing about a per-session --model override.
      selectModel(activeModel || msg.current || '');
      $modelSelect.disabled=$input.disabled;
      break;
    }

    case 'token':
      if(!curBubble){
        // replace thinking indicator if present
        if(curMsgDiv&&curMsgDiv.querySelector('.thinking')){
          curMsgDiv.innerHTML='';
          curTools=document.createElement('div');
          curTools.className='tool-row';
          curMsgDiv.appendChild(curTools);
          curBubble=document.createElement('div');
          curBubble.className='bubble';
          curBubble.innerHTML='<span class="cursor"></span>';
          curMsgDiv.appendChild(curBubble);
          curText='';
        } else {
          startAssistant();
        }
      }
      appendToken(msg.text||'');
      break;

    case 'tool_call':
      addToolBadge(msg.name||'tool', msg.args||null);
      break;

    case 'approval_request':
      addApproval(msg.command||'');
      break;

    case 'message_end':
      finalise();
      break;

    case 'cancelled':
      abandonPendingApproval();
      if(curBubble){
        curBubble.innerHTML=mdToHtml(curText)||'<em>(cancelled)</em>';
      } else if(curMsgDiv){
        curMsgDiv.innerHTML='<div class="bubble"><em>(cancelled)</em></div>';
      }
      curBubble=null; curTools=null; curText=''; curMsgDiv=null;
      curToolList=[]; curToolState={expanded:false};
      isStreaming=false;
      resetThinkingLabel();
      setEnabled(true);
      scrollBottom();
      break;

    case 'compacted':
      addSystem('Session compacted — history replaced with handoff summary.');
      break;

    case 'text':
      addSystemHtml(mdToHtml(msg.text||''));
      break;

    case 'error':
      abandonPendingApproval();
      if(curMsgDiv){ curMsgDiv.remove(); curBubble=null; curTools=null; curText=''; curMsgDiv=null; }
      curToolList=[]; curToolState={expanded:false};
      addSystem('Error: '+(msg.text||'unknown error'));
      isStreaming=false;
      resetThinkingLabel();
      setEnabled(true);
      break;

    case 'plan':{
      const steps=msg.steps||[];
      const lines=['<strong>Plan captured</strong> ('+steps.length+' step'+(steps.length!==1?'s':'')+'). Type <code>/execute</code> to run.'];
      steps.forEach(s=>{
        lines.push((s.step)+'. '+esc(s.description||'')+(s.tool?' <span class="tool-badge">'+esc(s.tool)+'</span>':''));
      });
      addSystemHtml(lines.join('<br>'));
      break;
    }

    case 'step_status':{
      const icon = msg.status==='complete'?'✓':msg.status==='skipped'?'↷':'✗';
      const left = msg.stepsLeft>0?' · '+msg.stepsLeft+' remaining':'';
      addSystem(icon+' Step '+msg.step+' '+msg.status+left);
      break;
    }

    case 'warning':
      addWarning(msg.text||'');
      break;

    case 'retrying':
      addSystem('Retrying… (attempt '+(msg.attempt||'?')+' of '+(msg.max||'?')+')');
      break;

    case 'file_changes':
      if(Array.isArray(msg.changes)&&msg.changes.length)
        addFileChanges(msg.changes);
      break;

    case 'session_end':
      abandonPendingApproval();
      addSystem('Session ended.');
      isStreaming=false;
      setEnabled(false);
      break;

    case 'files_picked':
      for(const f of (msg.files||[])){
        if(!attachedFiles.find(a=>a.path===f.path))
          attachedFiles.push(f);
      }
      renderAttachments();
      break;
  }
});
</script>
</body>
</html>`;
    }
}
