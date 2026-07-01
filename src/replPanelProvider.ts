import * as vscode from 'vscode';
import * as cp from 'child_process';
import { getBinary, readApiKeyFromConfig, fetchModelsViaCli } from './fuseraftUtils';

interface ReplEvent {
    type: string;
    [key: string]: unknown;
}

export class ReplPanelProvider {
    private static _current: ReplPanelProvider | undefined;

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
        ReplPanelProvider._current = new ReplPanelProvider(panel, model, resumeId, cwd);
    }

    private readonly _panel: vscode.WebviewPanel;
    private _proc: cp.ChildProcess | undefined;
    private _buf = '';
    private _alive = false;
    /** Session ID of the currently running session (set to resumeId when resuming). */
    private _sessionId: string | undefined;

    private constructor(panel: vscode.WebviewPanel, model: string, resumeId?: string, cwd?: string) {
        this._panel    = panel;
        this._sessionId = resumeId;   // refined to actual sessionId once CLI emits 'ready'
        panel.webview.html = this._html();

        panel.webview.onDidReceiveMessage((msg: { type: string; text?: string; model?: string }) => {
            if (msg.type === 'user_input' && msg.text !== undefined) {
                this._send({ type: 'user_input', text: msg.text });
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
        const env: NodeJS.ProcessEnv = { ...process.env };
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
                        this._panel.webview.postMessage(evt);
                    }
                } catch {
                    // non-JSON line — informational output from the CLI, ignore
                }
            }
        });

        this._proc.on('exit', () => {
            this._alive = false;
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

    private _send(msg: object): void {
        this._proc?.stdin?.write(JSON.stringify(msg) + '\n');
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
  color:var(--vscode-editor-foreground)
}
#welcome-hint{
  font-size:.92em;text-align:center;
  color:var(--vscode-descriptionForeground)
}
#welcome-input{
  width:100%;min-height:72px;max-height:200px;
  padding:10px 14px;resize:none;outline:none;
  background:var(--vscode-input-background);
  color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border,var(--vscode-panel-border));
  border-radius:8px;
  font-family:var(--vscode-font-family);
  font-size:var(--vscode-font-size);
  line-height:1.5
}
#welcome-input:focus{border-color:var(--vscode-focusBorder)}
#welcome-input:disabled{opacity:.45;cursor:not-allowed}
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
.bubble h1,.bubble h2,.bubble h3{margin:8px 0 4px;font-weight:600}
.bubble h1{font-size:1.2em}
.bubble h2{font-size:1.1em}
.bubble h3{font-size:1em}
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
  position:absolute;top:4px;right:8px;
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
#input{
  flex:1;min-height:36px;max-height:120px;
  padding:7px 10px;resize:none;outline:none;
  background:var(--vscode-input-background);
  color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border,var(--vscode-panel-border));
  border-radius:6px;
  font-family:var(--vscode-font-family);
  font-size:var(--vscode-font-size);
  line-height:1.4
}
#input:focus{border-color:var(--vscode-focusBorder)}
#input:disabled{opacity:.45;cursor:not-allowed}
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
  <span>fuseraft REPL</span>
  <select id="model-select" disabled title="Switch model"></select>
  <span class="session" id="session-label"></span>
</div>
<div id="tip"></div>
<div id="messages">
  <div id="welcome">
    <div id="welcome-inner">
      <div id="welcome-title">fuseraft</div>
      <div id="welcome-hint">What would you like to work on?</div>
      <textarea id="welcome-input" rows="3" placeholder="Ask something or type a /command…" disabled></textarea>
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
    <textarea id="input" rows="1" placeholder="Ask something or type a /command…" disabled></textarea>
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
const $wSend        = document.getElementById('welcome-send');
const $modelSelect  = document.getElementById('model-select');
const $thinkingBar   = document.getElementById('thinking-bar');
const $thinkingLabel = document.getElementById('thinking-label');
const $footer        = document.getElementById('footer');
const $attachBtn     = document.getElementById('attach-btn');
const $attachRow     = document.getElementById('attach-row');
let modelsLoaded     = false;
let attachedFiles    = []; // [{name, path}]

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

let curBubble   = null;
let curTools    = null;
let curText     = '';
let curMsgDiv   = null;
let isStreaming  = false;
let curToolList     = [];
let curToolExpanded = false;

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

function mdToHtml(raw){
  if(!raw) return '';
  const blocks=[];
  // extract fenced code blocks
  let s = raw.replace(/\`\`\`(\\w*)\\n?([\\s\\S]*?)\`\`\`/g,(_,lang,code)=>{
    const i=blocks.length;
    const attr=lang?' data-lang="'+esc(lang)+'"':'';
    blocks.push('<pre'+attr+'><code>'+esc(code.replace(/\\n$/,''))+'</code></pre>');
    return '\\x00'+i+'\\x00';
  });
  s = esc(s);
  // inline code
  s = s.replace(/\`([^\`\\n]+)\`/g,'<code>$1</code>');
  // bold+italic, bold, italic
  s = s.replace(/\\*\\*\\*([^*]+?)\\*\\*\\*/g,'<strong><em>$1</em></strong>');
  s = s.replace(/\\*\\*([^*]+?)\\*\\*/g,'<strong>$1</strong>');
  s = s.replace(/(?<!\\*)\\*([^*\\n]+?)\\*(?!\\*)/g,'<em>$1</em>');
  // headers
  s = s.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm,'<h1>$1</h1>');
  // blockquote
  s = s.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');
  // unordered list
  s = s.replace(/((?:^[ \\t]*[-*+] .+$\\n?)+)/gm,m=>{
    const items=m.replace(/^[ \\t]*[-*+] (.+)$/gm,'<li>$1</li>');
    return '<ul>'+items+'</ul>';
  });
  // ordered list
  s = s.replace(/((?:^[ \\t]*\\d+\\. .+$\\n?)+)/gm,m=>{
    const startMatch=m.match(/^[ \\t]*(\\d+)\\./);
    const start=startMatch?parseInt(startMatch[1]):1;
    const items=m.replace(/^[ \\t]*\\d+\\. (.+)$/gm,'<li>$1</li>');
    return '<ol'+(start>1?' start="'+start+'"':'')+'>'+items+'</ol>';
  });
  // tables: match header row | separator row | one or more data rows
  s = s.replace(/((?:^[ \\t]*\\|.+\\|[ \\t]*$\\n?){2,})/gm, m=>{
    const rows = m.trim().split('\\n');
    if(rows.length < 2) return m;
    const isSep = r => /^[ \\t]*\\|[-| :\\t]+\\|[ \\t]*$/.test(r);
    const sepIdx = rows.findIndex(isSep);
    if(sepIdx < 1) return m;
    const parseRow = r => r.replace(/^[ \\t]*\\|/, '').replace(/\\|[ \\t]*$/, '').split('|').map(c=>c.trim());
    const headers = parseRow(rows[0]);
    const thead = '<thead><tr>' + headers.map(h=>'<th>'+h+'</th>').join('') + '</tr></thead>';
    const bodyRows = rows.slice(sepIdx+1).filter(r=>r.trim()).map(r=>{
      return '<tr>'+parseRow(r).map(c=>'<td>'+c+'</td>').join('')+'</tr>';
    });
    return '<table>'+thead+'<tbody>'+bodyRows.join('')+'</tbody></table>';
  });
  // paragraphs
  s = s.split('\\n\\n').map(para=>{
    if(/^<(h[1-3]|ul|ol|blockquote|pre|table|\\x00)/.test(para.trimStart())) return para;
    return '<p>'+para.replace(/\\n/g,'<br>')+'</p>';
  }).join('\\n');
  // restore code blocks
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
  $send.disabled  = !on;
  $send.style.display = (!on && isStreaming) ? 'none' : '';
  $stop.style.display = (!on && isStreaming) ? 'block' : 'none';
  $thinkingBar.classList.toggle('active', !on && isStreaming);
  $attachBtn.disabled = !on;
  if(modelsLoaded) $modelSelect.disabled = !on;
  if(on && $welcome.style.display==='none') $input.focus();
}

/* ── message builders ────────────────────────────────── */
function addUser(text){
  const d = document.createElement('div');
  d.className='msg user';
  d.innerHTML='<div class="bubble">'+esc(text).replace(/\\n/g,'<br>')+'</div>';
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
  curToolExpanded=false;
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

function appendToken(text){
  if(!curBubble) startAssistant();
  curText += text;
  curBubble.innerHTML = mdToHtml(curText) + '<span class="cursor"></span>';
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

function _renderToolRow(){
  if(!curTools) return;
  collapseDetail();
  curTools.innerHTML='';
  const count = curToolList.length;
  if(count <= TOOL_VISIBLE_MAX || curToolExpanded){
    for(const {name, args} of curToolList){
      curTools.appendChild(_makeBadge(name, args));
    }
    if(count > TOOL_VISIBLE_MAX){
      const pill = document.createElement('span');
      pill.className='tool-badge tool-overflow';
      pill.textContent='▲ collapse';
      pill.addEventListener('click', ()=>{ curToolExpanded=false; _renderToolRow(); scrollBottom(); });
      curTools.appendChild(pill);
    }
  } else {
    const pill = document.createElement('span');
    pill.className='tool-badge tool-overflow';
    pill.textContent=count+' tool calls ▶';
    pill.addEventListener('click', ()=>{ curToolExpanded=true; _renderToolRow(); scrollBottom(); });
    curTools.appendChild(pill);
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
      curToolExpanded=false;
    } else {
      startAssistant();
    }
  }
  curToolList.push({name, args});
  _renderToolRow();
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
    curBubble.innerHTML = rendered || '';
    if(!rendered && (!curTools || !curTools.children.length)){
      curMsgDiv?.remove();
    } else if(curText.trim().endsWith(':')){
      _collapseIntoCot(curMsgDiv, curBubble, curTools);
    } else {
      curBubble.classList.add('finalised');
    }
  } else if(curMsgDiv){
    curMsgDiv.remove();
  }
  curBubble=null; curTools=null; curText=''; curMsgDiv=null;
  curToolList=[]; curToolExpanded=false;
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
}

function sendFromWelcome(){
  const text=$wInput.value.trim();
  if(!text||isStreaming) return;
  dismissWelcome();
  $wInput.value='';
  addUser(text);
  isStreaming=true;
  if(text.trim()==='/exit') setThinkingLabel('Ending your session…');
  setEnabled(false);
  if(!text.startsWith('/')) startThinking();
  vscode.postMessage({type:'user_input',text});
}

$wSend.addEventListener('click',sendFromWelcome);
$wInput.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendFromWelcome();}
});
$wInput.addEventListener('input',()=>{
  $wInput.style.height='auto';
  $wInput.style.height=Math.min($wInput.scrollHeight,200)+'px';
});

/* ── send ────────────────────────────────────────────── */
function send(){
  const text = $input.value.trim();
  if(!text || isStreaming) return;
  $input.value='';
  $input.style.height='36px';
  addUser(text);
  isStreaming=true;
  if(text.trim()==='/exit') setThinkingLabel('Ending your session…');
  setEnabled(false);
  if(!text.startsWith('/')) startThinking();
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
  setEnabled(false);
  vscode.postMessage({type:'model_change',model:$modelSelect.value});
});
$input.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}
});
$input.addEventListener('input',()=>{
  $input.style.height='auto';
  $input.style.height=Math.min($input.scrollHeight,120)+'px';
});

/* ── event handler ───────────────────────────────────── */
window.addEventListener('message',evt=>{
  const msg=evt.data;
  switch(msg.type){
    case 'ready':
      document.getElementById('session-label').textContent=msg.sessionId?'· '+msg.sessionId:'';
      if(!modelsLoaded && msg.model){
        const opt=document.createElement('option');
        opt.value=msg.model; opt.textContent=msg.model; opt.selected=true;
        $modelSelect.appendChild(opt);
      }
      $wInput.disabled=false;
      $wSend.disabled=false;
      $wInput.focus();
      setEnabled(true);
      break;

    case 'models':{
      const cur=msg.current||'';
      $modelSelect.innerHTML='';
      for(const m of (msg.list||[])){
        const opt=document.createElement('option');
        opt.value=m; opt.textContent=m;
        if(m===cur) opt.selected=true;
        $modelSelect.appendChild(opt);
      }
      modelsLoaded=true;
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

    case 'message_end':
      finalise();
      break;

    case 'cancelled':
      if(curBubble){
        curBubble.innerHTML=mdToHtml(curText)||'<em>(cancelled)</em>';
      } else if(curMsgDiv){
        curMsgDiv.innerHTML='<div class="bubble"><em>(cancelled)</em></div>';
      }
      curBubble=null; curTools=null; curText=''; curMsgDiv=null;
      curToolList=[]; curToolExpanded=false;
      isStreaming=false;
      resetThinkingLabel();
      setEnabled(true);
      scrollBottom();
      break;

    case 'error':
      if(curMsgDiv){ curMsgDiv.remove(); curBubble=null; curTools=null; curText=''; curMsgDiv=null; }
      curToolList=[]; curToolExpanded=false;
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
