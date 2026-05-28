import * as vscode from 'vscode';
import * as cp from 'child_process';
import { getBinary, readApiKeyFromConfig } from './fuseraftUtils';

interface ReplEvent {
    type: string;
    [key: string]: unknown;
}

export class ReplPanelProvider {
    private static _current: ReplPanelProvider | undefined;

    static show(model: string, resumeId?: string, cwd?: string): void {
        if (ReplPanelProvider._current) {
            const cur = ReplPanelProvider._current;
            // Same session or a brand-new session (no resumeId) → just reveal.
            if (!resumeId || cur._sessionId === resumeId) {
                cur._panel.reveal(vscode.ViewColumn.Beside);
                return;
            }
            // Different session requested — close the current panel and open the new one.
            const old = ReplPanelProvider._current;
            ReplPanelProvider._current = undefined;
            old._proc?.kill();
            old._panel.dispose();
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
    /** Session ID of the currently running session (set to resumeId when resuming). */
    private _sessionId: string | undefined;

    private constructor(panel: vscode.WebviewPanel, model: string, resumeId?: string, cwd?: string) {
        this._panel    = panel;
        this._sessionId = resumeId;   // refined to actual sessionId once CLI emits 'ready'
        panel.webview.html = this._html();

        panel.webview.onDidReceiveMessage((msg: { type: string; text?: string }) => {
            if (msg.type === 'user_input' && msg.text !== undefined) {
                this._send({ type: 'user_input', text: msg.text });
            }
        });

        panel.onDidDispose(() => {
            this._proc?.kill();
            ReplPanelProvider._current = undefined;
        });

        this._spawn(model, resumeId, cwd);
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
                        }
                        this._panel.webview.postMessage(evt);
                    }
                } catch {
                    // non-JSON line — informational output from the CLI, ignore
                }
            }
        });

        this._proc.on('exit', () => {
            this._panel.webview.postMessage({ type: 'session_end' });
        });

        this._proc.on('error', (err: Error) => {
            this._panel.webview.postMessage({ type: 'error', text: err.message });
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
#header .model{font-weight:600;color:var(--vscode-editor-foreground)}
#header .session{opacity:.6}
#messages{
  flex:1;overflow-y:auto;padding:12px;
  display:flex;flex-direction:column;gap:10px
}
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
.tool-row{display:flex;flex-wrap:wrap;gap:3px;padding-bottom:2px}
.tool-badge{
  padding:1px 6px;border-radius:3px;font-size:10px;
  background:var(--vscode-badge-background);
  color:var(--vscode-badge-foreground);
  cursor:default;user-select:none;transition:filter .12s
}
.tool-badge.has-args{cursor:pointer}
.tool-badge.has-args:hover{filter:brightness(1.25)}
.tool-badge.active{
  outline:1px solid var(--vscode-focusBorder);outline-offset:1px
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
.cursor{
  display:inline-block;width:2px;height:1em;
  background:var(--vscode-editor-foreground);
  animation:blink 1s step-end infinite;
  vertical-align:text-bottom;margin-left:1px
}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.thinking{
  display:flex;align-items:center;gap:6px;
  color:var(--vscode-descriptionForeground);font-size:11px;
  padding:4px 0;animation:fadein .2s ease
}
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
  padding:8px;display:flex;gap:6px;align-items:flex-end;flex-shrink:0
}
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
</style>
</head>
<body>
<div id="header">
  <span>fuseraft REPL</span>
  <span class="model" id="model-label"></span>
  <span class="session" id="session-label"></span>
</div>
<div id="tip"></div>
<div id="messages"></div>
<div id="footer">
  <textarea id="input" rows="1" placeholder="Ask something or type a /command…" disabled></textarea>
  <button id="send" disabled>Send</button>
</div>
<script>
const vscode = acquireVsCodeApi();
const $msgs  = document.getElementById('messages');
const $input = document.getElementById('input');
const $send  = document.getElementById('send');
const $tip   = document.getElementById('tip');

let curBubble   = null;
let curTools    = null;
let curText     = '';
let curMsgDiv   = null;
let isStreaming  = false;

// Tool-detail expand state — at most one expanded at a time.
let activeDetailBadge = null;
let activeDetail      = null;

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
    const items=m.replace(/^[ \\t]*\\d+\\. (.+)$/gm,'<li>$1</li>');
    return '<ol>'+items+'</ol>';
  });
  // paragraphs
  s = s.split('\\n\\n').map(para=>{
    if(/^<(h[1-3]|ul|ol|blockquote|pre|\\x00)/.test(para.trimStart())) return para;
    return '<p>'+para.replace(/\\n/g,'<br>')+'</p>';
  }).join('\\n');
  // restore code blocks
  s = s.replace(/\\x00(\\d+)\\x00/g,(_,i)=>blocks[parseInt(i)]);
  return s;
}

function scrollBottom(){
  $msgs.scrollTop = $msgs.scrollHeight;
}

function setEnabled(on){
  $input.disabled = !on;
  $send.disabled  = !on;
  if(on) $input.focus();
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

function addToolBadge(name, args){
  if(!curTools){
    // thinking indicator → replace with proper assistant message
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
    } else {
      startAssistant();
    }
  }
  const badge = document.createElement('span');
  badge.className='tool-badge';
  badge.textContent=name;

  if(args && Object.keys(args).length > 0){
    badge.classList.add('has-args');
    const summary = fmtArgsSummary(args);
    const full    = fmtArgsFull(args);

    badge.addEventListener('mouseenter', e => tipShow(e, summary));
    badge.addEventListener('mousemove',  e => tipMove(e));
    badge.addEventListener('mouseleave',     tipHide);
    badge.addEventListener('click', () => {
      tipHide();
      toggleDetail(badge, full);
    });
  }

  curTools.appendChild(badge);
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
  scrollBottom();
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

function finalise(){
  if(curBubble){
    const rendered = mdToHtml(curText);
    curBubble.innerHTML = rendered || '';
    if(!rendered && (!curTools || !curTools.children.length)){
      // empty response — remove the whole message div
      curMsgDiv?.remove();
    }
  } else if(curMsgDiv){
    curMsgDiv.remove();
  }
  curBubble=null; curTools=null; curText=''; curMsgDiv=null;
  isStreaming=false;
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

/* ── send ────────────────────────────────────────────── */
function send(){
  const text = $input.value.trim();
  if(!text || isStreaming) return;
  $input.value='';
  $input.style.height='36px';
  addUser(text);
  isStreaming=true;
  setEnabled(false);
  // Only start the streaming bubble for non-slash-commands.
  if(text.startsWith('/')){
    // slash commands output is handled CLI-side; we just wait for message_end
  } else {
    startThinking();
  }
  vscode.postMessage({type:'user_input',text});
}

$send.addEventListener('click',send);
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
      document.getElementById('model-label').textContent=msg.model||'';
      document.getElementById('session-label').textContent=msg.sessionId?'· '+msg.sessionId:'';
      setEnabled(true);
      break;

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
      isStreaming=false;
      setEnabled(true);
      scrollBottom();
      break;

    case 'error':
      if(curMsgDiv){ curMsgDiv.remove(); curBubble=null; curTools=null; curText=''; curMsgDiv=null; }
      addSystem('Error: '+(msg.text||'unknown error'));
      isStreaming=false;
      setEnabled(true);
      break;

    case 'plan':{
      const steps=msg.steps||[];
      const lines=['<strong>Plan captured</strong> ('+steps.length+' step'+(steps.length!==1?'s':'')+'). Type <code>/execute</code> to run.'];
      steps.forEach(s=>{
        lines.push((s.step)+'. '+esc(s.description||'')+(s.tool?' <span class="tool-badge">'+esc(s.tool)+'</span>':''));
      });
      addSystem(lines.join('<br>'));
      break;
    }

    case 'step_status':{
      const icon = msg.status==='complete'?'✓':msg.status==='skipped'?'↷':'✗';
      const left = msg.stepsLeft>0?' · '+msg.stepsLeft+' remaining':'';
      addSystem(icon+' Step '+msg.step+' '+msg.status+left);
      break;
    }

    case 'session_end':
      addSystem('Session ended.');
      setEnabled(false);
      break;
  }
});
</script>
</body>
</html>`;
    }
}
