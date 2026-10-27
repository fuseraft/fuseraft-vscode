const vscode   = acquireVsCodeApi();
const $msgs    = document.getElementById('messages');
const $input   = document.getElementById('input');
const $send    = document.getElementById('send');
const $stop    = document.getElementById('stop');
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
let pastedImages     = []; // [{name, data}] — screenshots pasted from the clipboard, sent as base64 data URLs
let pastedImageCount = 0;
const MAX_PASTED_IMAGES = 8; // mirrors the CLI's per-message cap
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

function isImagePath(p){
  const l=String(p).toLowerCase();
  return ['.png','.jpg','.jpeg','.gif','.webp'].some(x=>l.endsWith(x));
}

function renderAttachments(){
  $attachRow.innerHTML='';
  if(!attachedFiles.length && !pastedImages.length){ $attachRow.classList.remove('has-files'); return; }
  $attachRow.classList.add('has-files');
  pastedImages.forEach((img,idx)=>{
    const chip=document.createElement('span');
    chip.className='attach-chip';
    const label=document.createElement('span');
    label.textContent='image: '+img.name;
    const rm=document.createElement('span');
    rm.className='attach-chip-remove';
    rm.textContent='✕';
    rm.title='Remove';
    rm.addEventListener('click',()=>{
      pastedImages.splice(idx,1);
      renderAttachments();
    });
    chip.appendChild(label);
    chip.appendChild(rm);
    $attachRow.appendChild(chip);
  });
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
// Mirrors ReplLineReader's SlashCommands/SubCommands in fuseraft-cli — keep in sync,
// except /run, which hands off to multi-agent orchestration and isn't offered here.
const SLASH_COMMANDS = [
  '/adversarial','/agent','/agents','/assist','/clear','/compact','/context',
  '/conversation','/delegate','/events','/execute','/exit','/explore',
  '/fork','/goal','/help','/hitl','/history','/image','/last','/locate',
  '/max-tokens','/mcp','/memory','/model','/models','/paste','/plan',
  '/provider','/reasoning','/recover','/resume','/retry','/rewind',
  '/safe-mode','/save','/seed','/sessions','/snapshot','/switch',
  '/system','/temperature','/tools','/top-p','/undo',
];
const SUB_COMMANDS = {
  '/adversarial':  ['off','on'],
  '/fork':         ['switch'],
  '/goal':         ['drop','resume'],
  '/hitl':         ['off','on'],
  '/max-tokens':   ['reset'],
  '/mcp':          ['add','login','logout','remove'],
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
      const m = rest.match(/^(\s+)(\S+)/);
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
// The prompt's height follows its text at its current width, which changes with the panel, and as Stop comes and goes.
if(window.ResizeObserver){
  new ResizeObserver(()=>mCtl.sync()).observe(document.getElementById('input-row'));
  new ResizeObserver(()=>wCtl.sync()).observe($wInputWrap.parentElement);
}

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

function makeActionsRow(getText,tokenInfo){
  const row=document.createElement('div');
  row.className='msg-actions';
  row.appendChild(makeCopyBtn(getText));
  if(tokenInfo && (tokenInfo.input||tokenInfo.output||tokenInfo.cached)){
    const parts=[];
    if(tokenInfo.input)  parts.push(tokenInfo.input.toLocaleString()+' in');
    if(tokenInfo.output) parts.push(tokenInfo.output.toLocaleString()+' out');
    if(tokenInfo.cached) parts.push('⚡ '+tokenInfo.cached.toLocaleString()+' cached');
    const badge=document.createElement('span');
    badge.className='cache-badge';
    badge.textContent=parts.join(' · ');
    badge.title='Token usage for this turn';
    row.appendChild(badge);
  }
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
  const lines=text.replace(/\n$/,'').split('\n');
  const root={children:[]};
  const stack=[{indent:-1,node:root}];
  for(const line of lines){
    const m=line.match(/^([ \t]*)(?:([-*+])|(\d+)\.)[ \t]+(.*)$/);
    if(!m) continue;
    const indent=m[1].replace(/\t/g,'    ').length;
    const ordered=m[3]!==undefined;
    const number=ordered?parseInt(m[3],10):null;
    let content=m[4];
    let task=null;
    const tm=content.match(/^\[([ xX])\][ \t]+(.*)$/);
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
    return '\n\n\x00'+i+'\x00\n\n';
  };
  // extract fenced code blocks
  let s = raw.replace(/```(\w*)\n?([\s\S]*?)```/g,(_,lang,code)=>{
    const attr=lang?' data-lang="'+esc(lang)+'"':'';
    const btn='<button type="button" class="code-copy-btn" title="Copy code">'+ICON_COPY+'</button>';
    return stash('<pre'+attr+'>'+btn+'<code>'+esc(code.replace(/\n$/,''))+'</code></pre>');
  });
  s = esc(s);
  // inline code
  s = s.replace(/`([^`\n]+)`/g,'<code>$1</code>');
  // images (before links: image syntax is link syntax prefixed with !)
  s = s.replace(/!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g,(_,alt,url)=>'<img src="'+url+'" alt="'+alt+'" loading="lazy">');
  // links (http/https/mailto only, to avoid javascript:/data: hrefs)
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,(_,text,url)=>'<a href="'+url+'" title="'+url+'" target="_blank" rel="noopener noreferrer">'+text+'</a>');
  // bold+italic, bold, italic
  s = s.replace(/\*\*\*([^*]+?)\*\*\*/g,'<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+?)\*\*/g,'<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g,'<em>$1</em>');
  // headers
  s = s.replace(/^###### (.+)$/gm,(_,t)=>stash('<h6>'+t+'</h6>'));
  s = s.replace(/^##### (.+)$/gm,(_,t)=>stash('<h5>'+t+'</h5>'));
  s = s.replace(/^#### (.+)$/gm,(_,t)=>stash('<h4>'+t+'</h4>'));
  s = s.replace(/^### (.+)$/gm,(_,t)=>stash('<h3>'+t+'</h3>'));
  s = s.replace(/^## (.+)$/gm,(_,t)=>stash('<h2>'+t+'</h2>'));
  s = s.replace(/^# (.+)$/gm,(_,t)=>stash('<h1>'+t+'</h1>'));
  // horizontal rule
  s = s.replace(/^ {0,3}(?:-{3,}|_{3,}|\*{3,})[ \t]*$/gm,()=>stash('<hr>'));
  // blockquote (consecutive lines merge into a single quote block)
  s = s.replace(/((?:^&gt; ?.*$\n?)+)/gm,m=>{
    const text=m.replace(/^&gt; ?/gm,'').replace(/\n$/,'');
    return stash('<blockquote>'+text.split('\n').join('<br>')+'</blockquote>');
  });
  // lists (unordered/ordered, arbitrarily nested by indentation)
  s = s.replace(/((?:^[ \t]*(?:[-*+]|\d+\.)[ \t]+.+$\n?)+)/gm,m=>stash(buildList(m)));
  // tables: match header row | separator row | one or more data rows
  s = s.replace(/((?:^[ \t]*\|.+\|[ \t]*$\n?){2,})/gm, m=>{
    const rows = m.trim().split('\n');
    if(rows.length < 2) return m;
    // A separator row's cells must each be dashes (with optional alignment colons) — checked
    // cell-by-cell rather than with a blanket character class, which would also accept an
    // all-blank header row like "| | |" (itself made only of pipes/spaces) as the separator.
    const isSep = r => {
      const t = r.trim();
      if(!/^\|.*\|$/.test(t)) return false;
      const cells = t.slice(1,-1).split('|');
      return cells.length>0 && cells.every(c=>/^:?-+:?$/.test(c.trim()));
    };
    const sepIdx = rows.findIndex(isSep);
    if(sepIdx < 1) return m;
    const parseRow = r => r.replace(/^[ \t]*\|/, '').replace(/\|[ \t]*$/, '').split('|').map(c=>c.trim());
    const headers = parseRow(rows[0]);
    const thead = '<thead><tr>' + headers.map(h=>'<th>'+h+'</th>').join('') + '</tr></thead>';
    const bodyRows = rows.slice(sepIdx+1).filter(r=>r.trim()).map(r=>{
      return '<tr>'+parseRow(r).map(c=>'<td>'+c+'</td>').join('')+'</tr>';
    });
    return stash('<table>'+thead+'<tbody>'+bodyRows.join('')+'</tbody></table>');
  });
  // paragraphs
  s = s.split(/\n{2,}/).filter(p=>p.trim()!=='').map(para=>{
    if(/^\x00\d+\x00$/.test(para.trim())) return para.trim();
    return '<p>'+para.replace(/\n/g,'<br>')+'</p>';
  }).join('\n');
  // restore stashed blocks
  s = s.replace(/\x00(\d+)\x00/g,(_,i)=>blocks[parseInt(i)]);
  return s;
}

// Follows new output unless you've scrolled up to read; Ctrl+End (or scrolling back down) follows again.
let following = true;
$msgs.addEventListener('scroll', ()=>{
  following = $msgs.scrollHeight - $msgs.scrollTop - $msgs.clientHeight < 40;
});
function scrollBottom(force){
  if(!force && !following) return;
  $msgs.scrollTop = $msgs.scrollHeight;
  following = true;
}

function setThinkingLabel(text){ $thinkingLabel.textContent = text; }
function resetThinkingLabel(){ $thinkingLabel.textContent = 'Thinking…'; }

// on = idle. As in the full-screen REPL, the prompt stays usable while a turn runs: a message joins the turn,
// a /command waits for it to end. Only a session that has ended (or not started) takes no input.
let sessionReady = false, sessionEnded = false;
function setEnabled(on){
  const closed = !sessionReady || sessionEnded;
  const busy = !on && isStreaming;
  $input.disabled = closed;
  $inputWrap.classList.toggle('disabled', closed);
  $send.disabled  = closed;
  $stop.style.display = busy ? 'block' : 'none';
  $input.placeholder = busy ? 'Add to the running turn, or queue a /command…' : 'Ask something or type a /command…';
  $thinkingBar.classList.toggle('active', busy && !usingInlineThinking && !pendingApproval && pendingQuestion===null);
  $attachBtn.disabled = closed;
  if(modelsLoaded) $modelSelect.disabled = closed || busy;
  setBusy(busy);
  if(on && !closed && $welcome.style.display==='none' && !viewerOpen() && !hsearchOpen()) $input.focus();
}

/* ── message builders ────────────────────────────────── */
function addUser(text, note){
  const d = document.createElement('div');
  d.className='msg user';
  d.innerHTML='<div class="bubble">'+mdToHtml(text)+'</div>';
  if(note){
    const n=document.createElement('div');
    n.className='msg-note';
    n.textContent=note;
    d.appendChild(n);
  }
  d.appendChild(makeActionsRow(()=>text));
  $msgs.appendChild(d);
  scrollBottom(true);
  return d;
}
function setNote(msgDiv, note){
  const n=msgDiv && msgDiv.querySelector('.msg-note');
  if(n) n.textContent=note;
}

function startAssistant(){
  curMsgDiv = document.createElement('div');
  curMsgDiv.className='msg assistant';

  buildAssistantInto(curMsgDiv);
  $msgs.appendChild(curMsgDiv);
  scrollBottom();
}

// An assistant message: what the turn did, in order (thinking, tool calls, changed files), above its reply.
function buildAssistantInto(div){
  curTools = document.createElement('div');
  curTools.className='activity';
  div.appendChild(curTools);
  curBubble = document.createElement('div');
  curBubble.className='bubble';
  curBubble.innerHTML='<span class="cursor"></span>';
  div.appendChild(curBubble);
  curText='';
  curToolList=[];
  curToolState={expanded:false};
  curThinking=null;
}

// The message the turn is writing into, replacing the inline "thinking…" placeholder if that's still up.
function ensureAssistant(){
  if(curMsgDiv && curMsgDiv.querySelector('.thinking')){
    curMsgDiv.innerHTML='';
    buildAssistantInto(curMsgDiv);
  } else if(!curBubble){
    startAssistant();
  }
  beginTurnIfIdle();
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
// stays intact until its closing ```.
function currentChunk(text){
  const fenceCount = (text.match(/```/g)||[]).length;
  const from = fenceCount % 2 === 1 ? text.lastIndexOf('```') : text.length;
  const boundary = text.lastIndexOf('\n\n', from);
  return boundary === -1 ? text : text.slice(boundary+2);
}

// Splits full text into the same blank-line-delimited blocks currentChunk
// steps through live, re-merging any split that lands inside an open code
// fence or an unclosed bold (**) span — used to box up each block in the
// finalised bubble. Fence content is stripped before counting **, so a
// pointer-heavy code sample (e.g. int **argv) can't look like an open bold
// span. A fence-triggered merge keeps the blank line (the code's original
// spacing must survive); a bold-triggered merge joins with no separator,
// since that blank line was itself an injected break (e.g. a round-boundary
// paragraph break landing mid-token — see ReplTurn.cs's isRoundBoundary),
// not an intentional paragraph the model wrote.
function splitBlocks(text){
  const parts = text.split(/\n{2,}/).filter(p=>p.trim()!=='');
  const blocks = [];
  let i = 0;
  while(i < parts.length){
    let block = parts[i];
    while(i+1 < parts.length){
      const openFence = (block.match(/```/g)||[]).length % 2 === 1;
      const strippedForBold = block.replace(/```[\s\S]*?```/g,'');
      const openBold = (strippedForBold.match(/\*\*/g)||[]).length % 2 === 1;
      if(!openFence && !openBold) break;
      i++;
      block += (openFence ? '\n\n' : '') + parts[i];
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

/* ── activity: thinking, tool calls, changed files ──────────────────────
   The full-screen REPL's transcript lines: "∴" thinking that folds to one
   line once the model moves on, "↳ tool summary" lines that turn ✓ or ✗
   when their result comes back (a failure shows its first line), a
   subagent's calls nested under it, and "✎ path +a -r" for each changed
   file. Clicking a tool line shows its arguments and output; Ctrl+O opens
   the viewer. Only the latest lines stay visible while a turn piles up. */
const ACTIVITY_VISIBLE_MAX = 6;
let curThinking = null;
let toolsById = new Map();
let sawFileChanged = false;

function summarizeArgs(args){
  if(!args) return '';
  const v = Object.values(args).find(x=>x!==null && x!==undefined && String(fmtVal(x)).trim());
  if(v===undefined) return '';
  const s = fmtVal(v).replace(/\s+/g,' ').trim();
  return s.length>100 ? s.slice(0,97)+'…' : s;
}

function collapseActivity(activity){
  if(!activity) return;
  const toggle = activity.querySelector(':scope > .activity-more');
  const items = [...activity.children].filter(c=>!c.classList.contains('activity-more') && !c.classList.contains('tool-detail'));
  const hidden = activity.dataset.expanded==='1' ? 0 : Math.max(0, items.length - ACTIVITY_VISIBLE_MAX);
  items.forEach((el,i)=>{ el.classList.toggle('collapsed', i < hidden); });
  activity.querySelectorAll(':scope > .tool-detail').forEach(d=>{
    const owner = d.previousElementSibling;
    d.classList.toggle('collapsed', !!owner && owner.classList.contains('collapsed'));
  });
  if(items.length <= ACTIVITY_VISIBLE_MAX){ toggle?.remove(); return; }
  let t = toggle;
  if(!t){
    t = document.createElement('div');
    t.className='activity-more';
    t.addEventListener('click',()=>{
      activity.dataset.expanded = activity.dataset.expanded==='1' ? '' : '1';
      collapseActivity(activity);
    });
    activity.prepend(t);
  }
  t.textContent = activity.dataset.expanded==='1'
    ? '▾ show only the latest'
    : '▸ '+hidden+' earlier step'+(hidden===1?'':'s');
}

function appendActivity(el, activity){
  const a = activity || curTools;
  a.appendChild(el);
  collapseActivity(a);
  scrollBottom();
}

// One tool call. t: {id, name, summary, args, agent, state: 'run'|'ok'|'fail'|'none', output, out}
function makeToolLine(t){
  const el = document.createElement('div');
  el.className = 'tool-line' + (t.agent ? ' sub' : '');
  el.innerHTML = '<span class="tl-icon"></span>'
    + (t.agent ? '<span class="tl-agent"></span>' : '')
    + '<span class="tl-name"></span><span class="tl-sum"></span>';
  if(t.agent) el.querySelector('.tl-agent').textContent = t.agent;
  el.querySelector('.tl-name').textContent = t.name;
  el.querySelector('.tl-sum').textContent = t.summary || '';
  el.title = 'Show arguments and output';
  el.addEventListener('click', ()=>toggleToolDetail(el, t));
  t.el = el;
  paintTool(t);
  return el;
}

function paintTool(t){
  const icon = t.el.querySelector('.tl-icon');
  icon.className = 'tl-icon ' + t.state;
  icon.textContent = t.state==='run' ? '' : t.state==='ok' ? '✓' : t.state==='fail' ? '✗' : t.state==='cancelled' ? '–' : '↳';
  t.el.querySelector('.tl-err')?.remove();
  if(t.state==='fail' && t.output){
    const first = t.output.split('\n').find(l=>l.trim()) || '';
    const err = document.createElement('span');
    err.className = 'tl-err';
    err.textContent = first.length>140 ? first.slice(0,137)+'…' : first;
    t.el.appendChild(err);
  }
}

function toolText(t){
  const args = t.args && Object.keys(t.args).length ? fmtArgsFull(t.args) : '(no arguments)';
  const out = t.output!==undefined ? t.output : (t.state==='run' ? '(still running)' : '(no output recorded)');
  return 'Arguments\n' + args + '\n\nOutput\n' + out;
}

function toggleToolDetail(el, t){
  const next = el.nextElementSibling;
  if(next && next.classList.contains('tool-detail')){ next.remove(); el.classList.remove('active'); return; }
  const det = document.createElement('div');
  det.className = 'tool-detail';
  const pre = document.createElement('pre');
  pre.textContent = toolText(t);
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'detail-open';
  open.textContent = '⤢ viewer';
  open.title = 'Open in the output viewer (Ctrl+O)';
  open.addEventListener('click', e=>{
    e.stopPropagation();
    if(t.out===undefined) t.out = keepOutput(toolTitle(t), toolText(t));
    openViewer(t.out);
  });
  det.appendChild(open);
  det.appendChild(pre);
  el.after(det);
  el.classList.add('active');
}

function toolTitle(t){
  return (t.agent ? '['+t.agent+'] ' : '') + t.name + (t.summary ? '  ' + t.summary : '');
}

function addToolCall(msg){
  foldThinking();
  ensureAssistant();
  const t = {
    id: msg.id || null,
    name: msg.name || 'tool',
    summary: msg.summary || summarizeArgs(msg.args),
    args: msg.args || null,
    agent: msg.agent || null,
    // A subagent's calls are reported as they start, without results; so are calls from an older CLI.
    state: msg.id && !msg.agent ? 'run' : 'none',
  };
  curToolList.push(t);
  if(t.id) toolsById.set(t.id, t);
  appendActivity(makeToolLine(t));
}

function finishToolCall(msg){
  const t = toolsById.get(msg.id);
  if(!t) return;
  t.state = msg.ok===false ? 'fail' : 'ok';
  t.output = typeof msg.output==='string' ? msg.output : '';
  t.out = keepOutput(toolTitle(t) + (t.state==='fail' ? '  ✗' : '  ✓'), toolText(t));
  paintTool(t);
  const det = t.el.nextElementSibling;
  if(det && det.classList.contains('tool-detail')) det.querySelector('pre').textContent = toolText(t);
  scrollBottom();
}

// Anything still spinning when the turn stops never got a result.
function settleRunningTools(state){
  for(const t of toolsById.values()) if(t.state==='run'){ t.state = state; paintTool(t); }
  toolsById = new Map();
}

function addFileChanged(msg){
  ensureAssistant();
  sawFileChanged = true;
  const el = document.createElement('div');
  el.className = 'file-line';
  const counts = (typeof msg.added==='number' ? '<span class="fl-add">+'+msg.added+'</span>' : '')
               + (typeof msg.removed==='number' ? '<span class="fl-del">-'+msg.removed+'</span>' : '');
  el.innerHTML = '<span class="fl-icon">✎</span><span class="fl-path"></span>' + counts;
  el.querySelector('.fl-path').textContent = msg.path || '';
  el.title = 'Open ' + (msg.path || 'file');
  el.addEventListener('click', ()=>vscode.postMessage({type:'open_file', path: msg.path}));
  appendActivity(el);
}

function addThinking(text){
  ensureAssistant();
  if(!curThinking){
    const el = document.createElement('div');
    el.className = 'think live';
    el.innerHTML = '<div class="think-head">∴ thinking…</div><div class="think-body"></div>';
    const t = { el, text:'', started: Date.now() };
    el.querySelector('.think-head').addEventListener('click', ()=>{
      if(el.classList.contains('live')) return;
      el.classList.toggle('open');
    });
    curThinking = t;
    appendActivity(el);
  }
  curThinking.text += text;
  const body = curThinking.el.querySelector('.think-body');
  body.textContent = curThinking.text;
  body.scrollTop = body.scrollHeight;
  scrollBottom();
}

// The model moved on (to its reply, or a tool): the thinking folds into one line you can open again.
function foldThinking(){
  if(!curThinking) return;
  const t = curThinking;
  curThinking = null;
  const secs = Math.max(1, Math.round((Date.now() - t.started) / 1000));
  t.el.classList.remove('live');
  t.el.querySelector('.think-head').textContent = '∴ thought for ' + secs + 's';
  keepOutput('Thinking (' + secs + 's)', t.text);
}

// Kept for the replayed turns of a resumed session (no results, so no ✓/✗).
function _renderToolRow(row, toolList){
  row.className = 'activity';
  for(const {name, args} of toolList){
    row.appendChild(makeToolLine({ name, args, summary: summarizeArgs(args), state:'none' }));
  }
  collapseActivity(row);
}

/* ── arg formatters ──────────────────────────────────── */
function fmtVal(v){
  return typeof v === 'string' ? v : JSON.stringify(v);
}
// Tooltip: one line per arg, values truncated at 120 chars.
function fmtArgsSummary(args){
  return Object.entries(args).map(([k,v])=>{
    const s = fmtVal(v).replace(/\n/g,' ');
    return k + ': ' + (s.length > 120 ? s.slice(0,117)+'…' : s);
  }).join('\n');
}
// Expanded: full values with newlines preserved.
function fmtArgsFull(args){
  return Object.entries(args).map(([k,v])=>{
    const s = fmtVal(v);
    // indent continuation lines
    const indented = s.replace(/\n/g,'\n  ');
    return k + ':\n  ' + indented;
  }).join('\n\n');
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

function finalise(tokenInfo){
  foldThinking();
  settleRunningTools('cancelled');
  if(curBubble){
    const rendered = mdToHtml(curText);
    const text = curText;
    if(!rendered && (!curTools || !curTools.children.length)){
      curMsgDiv?.remove();
    } else if(curText.trim().endsWith(':')){
      curBubble.innerHTML = rendered || '';
      _collapseIntoCot(curMsgDiv, curBubble, curTools);
      curMsgDiv.appendChild(makeActionsRow(()=>text,tokenInfo));
    } else {
      // Box each streamed block separately so the breaks between them —
      // where one chain-of-thought bubble replaced another while live —
      // stay visible after the message is done.
      curBubble.innerHTML = splitBlocks(text).map(b=>'<div class="cot-block">'+mdToHtml(b)+'</div>').join('');
      curBubble.classList.add('finalised');
      curMsgDiv.appendChild(makeActionsRow(()=>text,tokenInfo));
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

// Closes the assistant message being written so the rest of the turn continues in a new one further down.
function splitAssistant(){
  if(!curMsgDiv) return;
  foldThinking();
  if(curMsgDiv.querySelector('.thinking')){ curMsgDiv.remove(); }
  else {
    const text = curText;
    if(curBubble){
      if(text.trim()){
        curBubble.innerHTML = splitBlocks(text).map(b=>'<div class="cot-block">'+mdToHtml(b)+'</div>').join('');
        curMsgDiv.appendChild(makeActionsRow(()=>text));
      } else curBubble.remove();
    }
    if(!text.trim() && (!curTools || !curTools.children.length)) curMsgDiv.remove();
  }
  curMsgDiv=null; curBubble=null; curTools=null; curText=''; curThinking=null;
  curToolList=[]; curToolState={expanded:false};
}

// Output that arrives with no turn in progress (a message sent just as the last turn ended) starts one.
function beginTurnIfIdle(){
  if(isStreaming) return;
  isStreaming = true;
  usingInlineThinking = false;
  setEnabled(false);
}

function addSystem(text){
  const d=document.createElement('div');
  d.className='msg system';
  d.innerHTML='<div class="bubble">'+esc(text)+'</div>';
  $msgs.appendChild(d);
  scrollBottom();
}

// One-line audit entries (currently just resolved HITL approvals) merge into
// the trailing group instead of each becoming its own gapped/padded .msg —
// otherwise a multi-tool-call turn leaves a tall stack of near-identical
// "✓ Allowed — ..." cards. Any other message type breaks the group.
function addAuditLine(text){
  if(curTools && curMsgDiv && curMsgDiv.isConnected){
    const line=document.createElement('div');
    line.className='audit-line';
    line.textContent=text;
    appendActivity(line);
    return;
  }
  const last=$msgs.lastElementChild;
  let bubble;
  if(last && last.classList.contains('audit-group')){
    bubble=last.querySelector('.bubble');
  } else {
    const d=document.createElement('div');
    d.className='msg system audit-group';
    d.innerHTML='<div class="bubble"></div>';
    $msgs.appendChild(d);
    bubble=d.querySelector('.bubble');
  }
  const line=document.createElement('div');
  line.textContent=text;
  bubble.appendChild(line);
  scrollBottom();
}

function addSystemHtml(html){
  const d=document.createElement('div');
  d.className='msg system';
  d.innerHTML='<div class="bubble">'+html+'</div>';
  $msgs.appendChild(d);
  scrollBottom();
}

/* ── replayed history ────────────────────────────────────────────────
   A resumed/switched session (or /replay) arrives as one 'replay' event of
   finished turns. They are built as complete static messages rather than
   driven through the streaming cur* state, which belongs to whatever live
   turn might be in flight. */
function addAssistantHistorical(text, tools){
  const d=document.createElement('div');
  d.className='msg assistant';
  const row=document.createElement('div');
  row.className='activity';
  d.appendChild(row);
  const bubble=document.createElement('div');
  bubble.className='bubble';
  d.appendChild(bubble);
  if(tools.length) _renderToolRow(row, tools);
  if(!text){
    bubble.remove();
  } else if(text.trim().endsWith(':')){
    bubble.innerHTML=mdToHtml(text);
    _collapseIntoCot(d, bubble, row);
    d.appendChild(makeActionsRow(()=>text));
  } else {
    bubble.innerHTML=splitBlocks(text).map(b=>'<div class="cot-block">'+mdToHtml(b)+'</div>').join('');
    bubble.classList.add('finalised');
    d.appendChild(makeActionsRow(()=>text));
  }
  $msgs.appendChild(d);
}

function renderReplay(msg){
  const turns=Array.isArray(msg.turns)?msg.turns:[];
  if(!turns.length) return;
  dismissWelcome();
  const total=typeof msg.total==='number'?msg.total:turns.length;
  const scope=turns.length===total
    ? total+' turn'+(total===1?'':'s')
    : 'last '+turns.length+' of '+total+' turns';
  addSystem('Previous turns — '+scope+(msg.compacted?' · earlier context was compacted':''));
  for(const t of turns){
    addUser(t.user||'');
    rememberInput(t.user||'');
    const tools=(Array.isArray(t.toolCalls)?t.toolCalls:[]).map(c=>({name:c.name||'tool', args:c.args||null}));
    if(t.assistant || tools.length) addAssistantHistorical(t.assistant||'', tools);
    else addSystem('(no response recorded — the turn was interrupted)');
  }
  addSystem('End of previous turns');
}

function addWarning(text){
  const d=document.createElement('div');
  d.className='msg warning';
  d.innerHTML='<div class="bubble">⚠ '+esc(text)+'</div>';
  $msgs.appendChild(d);
  scrollBottom();
}

/* ── HITL approval bar ───────────────────────────────────────────────
   Anchored above the composer (a sibling of #thinking-bar, outside the
   scrolling #messages flow) instead of being inserted as a message: a
   message-list bubble (a) sits centered via .msg.system's align-items,
   reading like a modal dropped in the middle of the transcript, and
   (b) never goes away once resolved, so a multi-tool-call turn leaves a
   stack of dead cards shoving everything else down. The bar shows at
   most one pending request, replacing itself in place; a one-line
   entry still goes into the transcript once resolved, as an audit trail
   without the interactive chrome. */
const $approvalBar      = document.getElementById('approval-bar');
const $approvalTitle    = document.getElementById('approval-title');
const $approvalDetail   = document.getElementById('approval-detail');
const $approvalAllowBtn = document.getElementById('approval-allow-btn');
const $approvalDenyBtn  = document.getElementById('approval-deny-btn');
let pendingApproval = false;
let pendingApprovalLabel = '';

function showApproval(title, detail){
  pendingApprovalLabel = title || 'Action requested';
  $approvalTitle.textContent = pendingApprovalLabel;
  $approvalDetail.textContent = detail || '(no detail provided)';
  $thinkingBar.classList.remove('active'); // avoid two bottom bars at once
  $approvalBar.classList.add('active');
  pendingApproval = true;
}

function respondApproval(approved){
  if(!pendingApproval) return;
  hideApproval(approved);
  vscode.postMessage({type:'approval_response', approved});
}

// Resolves an approval that never got a real response (session ended / turn
// cancelled while pending) without pretending a reply was sent to the CLI.
function abandonPendingApproval(){
  if(!pendingApproval) return;
  hideApproval(null);
}

function hideApproval(approved){
  const icon  = approved===null ? '⚠' : (approved ? '✓' : '✕');
  const label = approved===null ? 'Cancelled' : (approved ? 'Allowed' : 'Denied');
  addAuditLine(icon+' '+label+' — '+pendingApprovalLabel);
  $approvalBar.classList.remove('active');
  pendingApproval = false;
  $thinkingBar.classList.toggle('active', isStreaming && !usingInlineThinking);
}

$approvalAllowBtn.addEventListener('click',()=>respondApproval(true));
$approvalDenyBtn.addEventListener('click',()=>respondApproval(false));

/* ── ask_user question bar ───────────────────────────────────────────
   The model's multiple-choice question, in the same anchored slot as the
   approval bar. The first option is the model's recommendation, so it gets
   the primary style. The CLI waits for exactly one question_response;
   answer null means skipped. */
const $questionBar      = document.getElementById('question-bar');
const $questionTitle    = document.getElementById('question-title');
const $questionOptions  = document.getElementById('question-options');
const $questionOther    = document.getElementById('question-other');
const $questionInput    = document.getElementById('question-other-input');
const $questionOtherBtn = document.getElementById('question-other-btn');
const $questionSkipBtn  = document.getElementById('question-skip-btn');
let pendingQuestion = null;

function showQuestion(msg){
  pendingQuestion = msg.question || 'Question';
  $questionTitle.textContent = pendingQuestion;
  $questionOptions.innerHTML = '';
  const options = Array.isArray(msg.options) ? msg.options.map(String) : [];
  options.forEach((o,i)=>{
    const b=document.createElement('button');
    b.className='approval-btn question-option '+(i===0?'approval-allow':'approval-deny');
    b.textContent=o;
    b.addEventListener('click',()=>respondQuestion(o));
    $questionOptions.appendChild(b);
  });
  const allowOther = msg.allowOther !== false;
  $questionInput.style.display    = allowOther ? '' : 'none';
  $questionOtherBtn.style.display = allowOther ? '' : 'none';
  $questionInput.value = '';
  $thinkingBar.classList.remove('active'); // avoid two bottom bars at once
  $questionBar.classList.add('active');
  const first = $questionOptions.querySelector('button');
  if(first) first.focus();
}

function respondQuestion(answer){
  if(pendingQuestion===null) return;
  hideQuestion(answer===null ? '↷ Skipped' : '→ '+answer);
  vscode.postMessage({type:'question_response', answer});
}

// Clears a question that never got a reply (turn cancelled / session ended).
function abandonPendingQuestion(){
  if(pendingQuestion===null) return;
  hideQuestion('⚠ Cancelled');
}

function hideQuestion(outcome){
  addAuditLine('? '+pendingQuestion+'  '+outcome);
  $questionBar.classList.remove('active');
  pendingQuestion = null;
  $thinkingBar.classList.toggle('active', isStreaming && !usingInlineThinking);
}

function sendTypedAnswer(){
  const typed = $questionInput.value.trim();
  if(typed) respondQuestion(typed);
}
$questionOtherBtn.addEventListener('click',sendTypedAnswer);
$questionSkipBtn.addEventListener('click',()=>respondQuestion(null));
$questionInput.addEventListener('keydown',e=>{
  if(e.key==='Enter'){ e.preventDefault(); sendTypedAnswer(); }
});
$questionBar.addEventListener('keydown',e=>{
  if(e.key==='Escape'){ e.preventDefault(); respondQuestion(null); }
});

function addFileChanges(changes){
  if(!changes||!changes.length) return;
  if(sawFileChanged){ sawFileChanged=false; return; }
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
  rememberInput(text);
  dispatch({ text, payload: text, images: [], display: text });
}

$wSend.addEventListener('click',sendFromWelcome);
$wInput.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendFromWelcome();}
});

/* ── sending while a turn runs ───────────────────────────────────────────
   As in the full-screen REPL: a plain message joins the running turn (the
   model reads it after its current tool calls; if the turn ends first, it
   starts the next one), while a /command, !command, $skill or a message
   with attachments waits here until the REPL is ready for it. */
const queued = [];          // messages waiting for the turn to end, in order
let interjected = [];       // user bubbles sent into the running turn, awaiting their fate

function dispatch(m){
  if(m.text.startsWith('!')){
    // The shell block shows the command; it needs no bubble of its own.
    isStreaming = true;
    usingInlineThinking = false;
    setThinkingLabel('Running '+m.text.slice(1).trim().split(/\s+/)[0]+'…');
    setEnabled(false);
  } else {
    addUser(m.display);
    isStreaming = true;
    usingInlineThinking = !m.text.startsWith('/');
    if(m.text==='/exit') setThinkingLabel('Ending your session…');
    setEnabled(false);
    if(usingInlineThinking) startThinking();
  }
  startTimer();
  vscode.postMessage(m.images.length ? {type:'user_input',text:m.payload,images:m.images} : {type:'user_input',text:m.payload});
}

// The REPL is waiting for its next message: send the first one that was held back.
function flushQueue(){
  if(isStreaming || !queued.length) return;
  const m = queued.shift();
  renderQueue();
  dispatch(m);
}

// Held messages wait as chips above the prompt (✕ takes one back) and join the transcript when they're sent.
const $queueRow = document.createElement('div');
$queueRow.id = 'queue-row';
document.getElementById('footer').insertBefore($queueRow, document.getElementById('attach-row'));
function renderQueue(){
  $queueRow.innerHTML = '';
  $queueRow.classList.toggle('has-items', queued.length > 0);
  queued.forEach((m, i)=>{
    const chip = document.createElement('span');
    chip.className = 'attach-chip queue-chip';
    chip.title = 'Sent when the running turn ends';
    const label = document.createElement('span');
    label.textContent = '⏳ ' + (m.display.length > 60 ? m.display.slice(0,57)+'…' : m.display);
    const rm = document.createElement('span');
    rm.className = 'attach-chip-remove';
    rm.textContent = '✕';
    rm.title = 'Don\'t send';
    rm.addEventListener('click', ()=>{ queued.splice(i,1); renderQueue(); });
    chip.appendChild(label);
    chip.appendChild(rm);
    $queueRow.appendChild(chip);
  });
}

/* ── send ────────────────────────────────────────────── */
/* ── pasted screenshots ──────────────────────────────── */
// Returns true when the paste carried at least one image (the default paste is then suppressed).
function addPastedImages(e){
  const items=(e.clipboardData&&e.clipboardData.items)?Array.from(e.clipboardData.items):[];
  const files=items.filter(it=>it.kind==='file'&&it.type&&it.type.indexOf('image/')===0)
                   .map(it=>it.getAsFile()).filter(Boolean);
  if(!files.length) return false;
  e.preventDefault();
  for(const f of files){
    if(pastedImages.length>=MAX_PASTED_IMAGES) break;
    const ext=(f.type.split('/')[1]||'png').replace('jpeg','jpg');
    const name='pasted-'+(++pastedImageCount)+'.'+ext;
    const reader=new FileReader();
    reader.onload=()=>{
      if(pastedImages.length>=MAX_PASTED_IMAGES) return;
      pastedImages.push({name,data:String(reader.result)});
      renderAttachments();
    };
    reader.readAsDataURL(f);
  }
  return true;
}

$input.addEventListener('paste',e=>{ addPastedImages(e); });
// On the welcome screen there is no attachment row, so reveal the footer (where chips render) first.
$wInput.addEventListener('paste',e=>{
  if(addPastedImages(e)){ dismissWelcome(); $input.focus(); }
});

function send(){
  const text = $input.value.trim();
  // A picture with no words is still a message — the CLI supplies a default prompt.
  if(!text && !pastedImages.length) return;
  $input.value='';
  mCtl.resetTab();
  mCtl.sync();
  hideSuggest();
  rememberInput(text);
  const imgCount = pastedImages.length;
  const display = text + (imgCount ? (text?'\n\n':'') + '[+'+imgCount+' image'+(imgCount>1?'s':'')+']' : '');
  const joinsTurn = isStreaming && text && !/^[\/!$]/.test(text) && !imgCount && !attachedFiles.length;
  if(joinsTurn){
    interjected.push(addUser(display, '↪ sent to the running turn'));
    vscode.postMessage({type:'user_input', text});
    return;
  }
  let payload = text;
  if(attachedFiles.length){
    // An image path is sent as @"path" so the CLI attaches the picture itself instead of just naming the file.
    const list = attachedFiles.map((f,i)=>(i+1)+'. '+(isImagePath(f.path)?'@"'+f.path+'"':f.path)).join('\n');
    payload = 'The user referenced the following files which may be of interest in this message:\n'+list+'\n\n'+text;
    attachedFiles=[];
    renderAttachments();
  }
  const images = pastedImages.map(i=>({name:i.name,data:i.data}));
  pastedImages=[];
  renderAttachments();
  const m = { text, payload, images, display };
  if(isStreaming){
    queued.push(m);
    renderQueue();
    return;
  }
  dispatch(m);
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
  if(e.key==='Enter'&&!e.shiftKey&&!e.altKey&&!e.isComposing){e.preventDefault();send();}
  else if(e.key==='Enter'&&e.altKey){
    // Alt+Enter starts a new line, as in the full-screen REPL.
    e.preventDefault();
    const at=$input.selectionStart;
    $input.setRangeText('\n', at, $input.selectionEnd, 'end');
    mCtl.sync();
  }
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
      sessionReady=true;
      setEnabled(!isStreaming);
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
      foldThinking();
      ensureAssistant();
      appendToken(msg.text||'');
      break;

    case 'thinking':
      addThinking(msg.text||'');
      break;

    case 'tool_call':
      addToolCall(msg);
      break;

    case 'tool_result':
      finishToolCall(msg);
      break;

    case 'file_changed':
      addFileChanged(msg);
      break;

    case 'status':
      // The REPL is waiting for its next message, so whatever was running is over.
      if(isStreaming){
        if(curMsgDiv) finalise();
        isStreaming=false;
        resetThinkingLabel();
      }
      stopTimer();
      for(const b of interjected) setNote(b, '↪ sent as the next message');
      interjected=[];
      statusInfo = msg;
      if(msg.model) selectModel(msg.model);
      renderStatus();
      setEnabled(!isStreaming);
      flushQueue();
      break;

    case 'turn_start':
      // What was sent during the last turn, which it never read, starts this one.
      for(const b of interjected) setNote(b, '↪ started this turn');
      interjected=[];
      isStreaming=true;
      usingInlineThinking=true;
      setEnabled(false);
      startThinking();
      startTimer();
      break;

    case 'interjection':{
      const n = Math.max(1, msg.count||1);
      // The model has read it: what it does next belongs below the message, not in the segment above.
      if(msg.status==='joined') splitAssistant();
      const fate = msg.status==='joined' ? '↪ joined the turn'
                 : msg.status==='carried' ? '↪ starts the next turn'
                 : '✕ dropped: the turn was cancelled';
      for(const b of interjected.splice(0, n)) setNote(b, fate);
      break;
    }

    case 'shell_start':
      startShell(msg.command||'!');
      break;

    case 'shell_output':
      shellLine(msg.text||'');
      break;

    case 'shell_end':
      endShell();
      break;

    case 'file_suggestions':
      receiveFileSuggestions(msg);
      break;

    case 'approval_request':
      if (msg.kind === 'file_write') {
        showApproval((msg.action||'write')+': '+(msg.displayPath||msg.path||''), 'Diff opened in the editor — review it, then Allow (y) or Deny (n) here.');
      } else if (msg.kind === 'tool_action') {
        showApproval((msg.plugin||'Tool')+': '+(msg.action||'action'), msg.detail||'');
      } else {
        showApproval('Run shell command', msg.command||'');
      }
      break;

    case 'question':
      showQuestion(msg);
      break;

    case 'message_end':
      finalise({
        input:  typeof msg.inputTokens==='number'       ? msg.inputTokens       : undefined,
        output: typeof msg.outputTokens==='number'      ? msg.outputTokens      : undefined,
        cached: typeof msg.cachedInputTokens==='number' ? msg.cachedInputTokens : undefined,
      });
      break;

    case 'cancelled':
      abandonPendingApproval();
      abandonPendingQuestion();
      foldThinking();
      settleRunningTools('cancelled');
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

    case 'replay':
      renderReplay(msg);
      break;

    case 'error':
      abandonPendingApproval();
      abandonPendingQuestion();
      foldThinking();
      settleRunningTools('cancelled');
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
      abandonPendingQuestion();
      addSystem('Session ended.');
      isStreaming=false;
      sessionEnded=true;
      stopTimer();
      settleRunningTools('cancelled');
      setEnabled(false);
      renderStatus();
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

/* ── status line ─────────────────────────────────────────────────────────
   The full-screen REPL's: the model, the turn, how full the context is
   (green, yellow as auto-compaction nears, red once past it), the modes,
   and a spinner with the time so far while something runs. */
const $stLeft  = document.getElementById('st-left');
const $stRight = document.getElementById('st-right');
let statusInfo = null;
let busySince = 0, busyTimer = null, busy = false;

function renderStatus(){
  if(!statusInfo){ $stLeft.innerHTML=''; }
  else {
    const pct = Math.round((statusInfo.context||0)*100);
    const parts = [
      '<span class="st-model">'+esc(statusInfo.model||activeModel||'')+'</span>',
      '<span>turn '+esc(statusInfo.turn||1)+'</span>',
      '<span class="st-ctx lvl-'+esc(statusInfo.level||'clear')+'" title="Context used; auto-compaction runs before it fills">'+pct+'% context</span>',
    ];
    for(const m of (statusInfo.modes||[])) parts.push('<span class="st-mode">'+esc(m)+'</span>');
    $stLeft.innerHTML = parts.join('<span class="st-sep">·</span>');
  }
  if(sessionEnded){ $stRight.textContent='session ended'; return; }
  if(!busy){ $stRight.innerHTML='<span class="st-hint">Ctrl+O output · Ctrl+R history · Ctrl+F find</span>'; return; }
  const secs = Math.floor((Date.now()-busySince)/1000);
  const t = secs<60 ? secs+'s' : Math.floor(secs/60)+'m '+String(secs%60).padStart(2,'0')+'s';
  $stRight.innerHTML = '<span class="st-spin"></span><span>'+t+'</span><span class="st-hint">Ctrl+C to stop</span>';
}
function startTimer(){
  if(busyTimer) return;
  busySince = Date.now();
  busyTimer = setInterval(renderStatus, 1000);
}
function stopTimer(){
  if(busyTimer){ clearInterval(busyTimer); busyTimer=null; }
}
function setBusy(on){
  if(on && !busyTimer) startTimer();
  if(!on) stopTimer();
  busy = on;
  renderStatus();
}

/* ── ! shell escape ──────────────────────────────────────────────────────
   You typed it, so it runs unsandboxed and the model never sees it; the
   output streams in as it's written. */
let curShell = null;
const SHELL_MAX_LINES = 5000;

function startShell(command){
  dismissWelcome();
  const d = document.createElement('div');
  d.className = 'msg shell';
  d.innerHTML = '<div class="shell-block"><div class="shell-head"></div><pre class="shell-out"></pre></div>';
  d.querySelector('.shell-head').textContent = command;
  $msgs.appendChild(d);
  curShell = { el: d, out: d.querySelector('.shell-out'), lines: [], command };
  scrollBottom(true);
}
function shellLine(text){
  if(!curShell) startShell('!');
  const sh = curShell;
  sh.lines.push(text);
  if(sh.lines.length <= SHELL_MAX_LINES){
    sh.out.appendChild(document.createTextNode((sh.lines.length>1?'\n':'')+text));
  } else if(sh.lines.length === SHELL_MAX_LINES+1){
    sh.out.appendChild(document.createTextNode('\n… (more output: Ctrl+O shows all of it)'));
  }
  scrollBottom();
}
function endShell(){
  if(!curShell) return;
  const sh = curShell;
  curShell = null;
  sh.el.classList.add('done');
  if(!sh.lines.length) sh.out.textContent = '(no output)';
  const idx = keepOutput(sh.command, sh.lines.join('\n') || '(no output)');
  sh.el.querySelector('.shell-head').addEventListener('click', ()=>openViewer(idx));
}

/* ── output viewer (Ctrl+O) ──────────────────────────────────────────────
   Any of the last 100 tool outputs (with the arguments they were called
   with), thoughts, or shell outputs, in full: ←/→ for older and newer,
   Esc to close, or open it in an editor tab. */
const MAX_OUTPUTS = 100;
const outputs = [];   // {title, text}
let outputBase = 0;   // index of outputs[0] among everything ever kept
let viewerAt = -1;
const $viewer = document.getElementById('viewer');
const $viewerTitle = document.getElementById('viewer-title');
const $viewerPos = document.getElementById('viewer-pos');
const $viewerBody = document.getElementById('viewer-body');

function keepOutput(title, text){
  outputs.push({ title, text });
  if(outputs.length > MAX_OUTPUTS){ outputs.shift(); outputBase++; }
  return outputBase + outputs.length - 1;
}
function viewerOpen(){ return $viewer.classList.contains('active'); }
function openViewer(index){
  if(!outputs.length){ addSystem('No tool output yet — Ctrl+O shows it once a tool has run.'); return; }
  const i = index===undefined ? outputs.length-1 : Math.min(outputs.length-1, Math.max(0, index-outputBase));
  viewerAt = i;
  const o = outputs[i];
  $viewerTitle.textContent = o.title;
  $viewerPos.textContent = (i+1)+' of '+outputs.length;
  $viewerBody.textContent = o.text;
  $viewerBody.scrollTop = 0;
  $viewer.classList.add('active');
  $viewerBody.focus();
}
function closeViewer(){
  $viewer.classList.remove('active');
  if(!$input.disabled && $welcome.style.display==='none') $input.focus();
}
function stepViewer(d){
  const i = viewerAt + d;
  if(i<0 || i>=outputs.length) return;
  openViewer(outputBase+i);
}
$viewerBody.tabIndex = 0;
document.getElementById('viewer-prev').addEventListener('click',()=>stepViewer(-1));
document.getElementById('viewer-next').addEventListener('click',()=>stepViewer(1));
document.getElementById('viewer-close').addEventListener('click',closeViewer);
document.getElementById('viewer-open').addEventListener('click',()=>{
  const o = outputs[viewerAt];
  if(o) vscode.postMessage({type:'open_text', title:o.title, text:o.title+'\n\n'+o.text});
});
$viewer.addEventListener('keydown',e=>{
  if(e.key==='ArrowLeft'){ e.preventDefault(); stepViewer(-1); }
  else if(e.key==='ArrowRight'){ e.preventDefault(); stepViewer(1); }
  else if(e.key==='Escape'){ e.preventDefault(); closeViewer(); }
});

/* ── input history (↑/↓, Ctrl+R) ─────────────────────────────────────────
   What you've sent in this panel (and the replayed turns of a resumed
   session): ↑/↓ on the first or last line walk it, Ctrl+R searches it. */
const MAX_HISTORY = 500;
const saved = (vscode.getState && vscode.getState()) || {};
const inputHistory = Array.isArray(saved.history) ? saved.history : [];
let historyAt = -1, historyDraft = '';

function rememberInput(text){
  const t = (text||'').trim();
  if(!t) return;
  if(inputHistory[inputHistory.length-1] !== t) inputHistory.push(t);
  if(inputHistory.length > MAX_HISTORY) inputHistory.splice(0, inputHistory.length-MAX_HISTORY);
  historyAt = -1;
  try { vscode.setState({ ...(vscode.getState()||{}), history: inputHistory }); } catch { /* state unavailable */ }
}
function setInput(text){
  $input.value = text;
  $input.selectionStart = $input.selectionEnd = text.length;
  mCtl.resetTab();
  mCtl.sync();
}
function historyStep(d){
  if(!inputHistory.length) return false;
  if(historyAt === -1){
    if(d > 0) return false;
    historyDraft = $input.value;
    historyAt = inputHistory.length;
  }
  const next = historyAt + d;
  if(next < 0) return true;
  if(next >= inputHistory.length){ historyAt = -1; setInput(historyDraft); return true; }
  historyAt = next;
  setInput(inputHistory[next]);
  return true;
}

const $hsearch = document.getElementById('hsearch');
const $hsInput = document.getElementById('hsearch-input');
const $hsList  = document.getElementById('hsearch-list');
let hsMatches = [], hsAt = 0;
function hsearchOpen(){ return $hsearch.classList.contains('active'); }
function openHistorySearch(){
  $hsearch.classList.add('active');
  $hsInput.value = '';
  renderHistorySearch();
  $hsInput.focus();
}
function closeHistorySearch(pick){
  $hsearch.classList.remove('active');
  if(pick !== undefined) setInput(pick);
  $input.focus();
}
function renderHistorySearch(){
  const q = $hsInput.value.toLowerCase();
  const seen = new Set();
  hsMatches = [];
  for(let i=inputHistory.length-1; i>=0 && hsMatches.length<50; i--){
    const h = inputHistory[i];
    if(seen.has(h) || (q && !h.toLowerCase().includes(q))) continue;
    seen.add(h);
    hsMatches.push(h);
  }
  hsAt = 0;
  $hsList.innerHTML = '';
  if(!hsMatches.length){
    $hsList.innerHTML = '<div class="hs-empty">'+(inputHistory.length ? 'No earlier message matches.' : 'Nothing sent yet.')+'</div>';
    return;
  }
  hsMatches.forEach((h,i)=>{
    const row = document.createElement('div');
    row.className = 'hs-item'+(i===0?' active':'');
    row.textContent = h.replace(/\s+/g,' ');
    row.addEventListener('mousedown', e=>{ e.preventDefault(); closeHistorySearch(h); });
    $hsList.appendChild(row);
  });
}
function moveHistorySearch(d){
  if(!hsMatches.length) return;
  hsAt = (hsAt + d + hsMatches.length) % hsMatches.length;
  [...$hsList.children].forEach((r,i)=>r.classList.toggle('active', i===hsAt));
  $hsList.children[hsAt]?.scrollIntoView({block:'nearest'});
}
$hsInput.addEventListener('input', renderHistorySearch);
$hsInput.addEventListener('keydown', e=>{
  if(e.key==='ArrowDown' || (e.key==='r' && e.ctrlKey)){ e.preventDefault(); moveHistorySearch(1); }
  else if(e.key==='ArrowUp'){ e.preventDefault(); moveHistorySearch(-1); }
  else if(e.key==='Enter'){ e.preventDefault(); closeHistorySearch(hsMatches[hsAt]); }
  else if(e.key==='Escape'){ e.preventDefault(); closeHistorySearch(); }
});
$hsInput.addEventListener('blur', ()=>setTimeout(()=>{ if(hsearchOpen()) closeHistorySearch(); }, 150));

/* ── suggestions (/commands, $skills, @paths) ────────────────────────────
   A list above the prompt, as in the full-screen REPL: ↑/↓ to choose,
   Enter or Tab to take one, Esc to hide. After @ it offers the entries one
   level down, then files anywhere whose name starts with what you typed
   (git-ignored files and .env aren't offered). */
const $suggest = document.createElement('div');
$suggest.id = 'suggest';
$suggest.setAttribute('role','listbox');
document.getElementById('footer').prepend($suggest);
let sgItems = [], sgAt = 0, sgKind = '', sgRange = null, sgQuery = null, sgTimer = null;
// The prompt the list is for: the main one, or the welcome box a new chat starts in.
let sgTa = $input, sgCtl = mCtl;

function suggestOpen(){ return $suggest.classList.contains('active') && sgItems.length>0; }
function hideSuggest(){ $suggest.classList.remove('active'); sgItems=[]; sgKind=''; }

// The @token the caret is in: {start, end, query}, or null.
function mentionAtCaret(){
  const text = sgTa.value, caret = sgTa.selectionStart;
  if(caret !== sgTa.selectionEnd) return null;
  let start = caret;
  while(start>0 && !/\s/.test(text[start-1])) start--;
  const token = text.slice(start, caret);
  if(!token.startsWith('@')) return null;
  let end = caret;
  while(end<text.length && !/\s/.test(text[end])) end++;
  return { start, end, query: token.slice(1).replace(/^"/,'') };
}

function updateSuggest(){
  const ta = document.activeElement;
  if(ta !== $input && ta !== $wInput){ hideSuggest(); return; }
  sgTa = ta; sgCtl = ta === $input ? mCtl : wCtl;
  const text = sgTa.value;
  if((text.startsWith('/') || text.startsWith('$')) && sgTa.selectionStart===text.length){
    const items = findCompletions(text).filter(c=>c.toLowerCase()!==text.trim().toLowerCase());
    showSuggest('cmd', items.map(c=>({label:c, value:c})), null);
    return;
  }
  const m = mentionAtCaret();
  if(!m){ hideSuggest(); return; }
  sgRange = m;
  if(sgQuery === m.query && sgKind==='file') return;
  clearTimeout(sgTimer);
  sgTimer = setTimeout(()=>{ sgQuery = m.query; vscode.postMessage({type:'file_suggest', query:m.query}); }, 60);
}

function receiveFileSuggestions(msg){
  const m = mentionAtCaret();
  if(!m || m.query !== msg.query) return;
  sgRange = m;
  const items = (msg.items||[]).map(it=>({ label: it.path+(it.dir?'/':''), value: it.path+(it.dir?'/':''), dir: it.dir }));
  showSuggest('file', items, m);
}

function showSuggest(kind, items, range){
  sgKind = kind; sgItems = items.slice(0,12); sgAt = 0; sgRange = range;
  if(!sgItems.length){ $suggest.classList.remove('active'); $suggest.innerHTML=''; return; }
  // Above the main prompt; below the welcome box, which sits mid-panel.
  const home = sgTa === $wInput ? $wInputWrap.parentElement : document.getElementById('footer');
  if($suggest.parentElement !== home) home.prepend($suggest);
  $suggest.classList.toggle('below', sgTa === $wInput);
  $suggest.style.top = sgTa === $wInput ? ($wInputWrap.offsetTop + $wInputWrap.offsetHeight + 4)+'px' : '';
  $suggest.innerHTML = '';
  sgItems.forEach((it,i)=>{
    const row = document.createElement('div');
    row.className = 'sg-item'+(i===0?' active':'')+(it.dir?' dir':'');
    row.textContent = it.label;
    row.addEventListener('mousedown', e=>{ e.preventDefault(); sgAt=i; acceptSuggest(); });
    $suggest.appendChild(row);
  });
  $suggest.classList.add('active');
}

function moveSuggest(d){
  sgAt = (sgAt + d + sgItems.length) % sgItems.length;
  [...$suggest.children].forEach((r,i)=>r.classList.toggle('active', i===sgAt));
  $suggest.children[sgAt]?.scrollIntoView({block:'nearest'});
}

function acceptSuggest(){
  const it = sgItems[sgAt];
  if(!it) return;
  if(sgKind==='cmd'){
    sgTa.value = it.value + ' ';
    sgTa.selectionStart = sgTa.selectionEnd = sgTa.value.length;
    sgCtl.resetTab();
    sgCtl.sync();
    hideSuggest();
  } else if(sgRange){
    const text = sgTa.value;
    const value = /\s/.test(it.value) ? '@"'+it.value+'"' : '@'+it.value;
    // A directory stays open so you can keep going down; a file ends the mention.
    const insert = value + (it.dir ? '' : ' ');
    sgTa.value = text.slice(0, sgRange.start) + insert + text.slice(sgRange.end);
    sgTa.selectionStart = sgTa.selectionEnd = sgRange.start + insert.length;
    sgCtl.sync();
    sgQuery = null;
    hideSuggest();
    if(it.dir) updateSuggest();
  }
}

$input.addEventListener('input', ()=>{ historyAt=-1; updateSuggest(); });
for(const ta of [$input, $wInput]){
  if(ta !== $input) ta.addEventListener('input', updateSuggest);
  ta.addEventListener('click', updateSuggest);
  ta.addEventListener('blur', ()=>setTimeout(hideSuggest, 100));
  // Runs before the prompt's own handlers (Enter to send, Tab to complete), so an open list gets the keys first.
  ta.addEventListener('keydown', e=>{
    if(!suggestOpen() || sgTa !== ta) return;
    const stop = ()=>{ e.preventDefault(); e.stopImmediatePropagation(); };
    if(e.key==='ArrowDown'){ stop(); moveSuggest(1); }
    else if(e.key==='ArrowUp'){ stop(); moveSuggest(-1); }
    else if((e.key==='Enter' && !e.shiftKey && !e.altKey) || e.key==='Tab'){ stop(); acceptSuggest(); }
    else if(e.key==='Escape'){ stop(); hideSuggest(); }
  }, true);
}

// History and line editing in the main prompt.
$input.addEventListener('keydown', e=>{
  const stop = ()=>{ e.preventDefault(); e.stopImmediatePropagation(); };
  if(suggestOpen()) return;
  if(e.key==='ArrowUp' && !e.shiftKey && !e.altKey && !$input.value.slice(0,$input.selectionStart).includes('\n')){
    if(historyStep(-1)) stop();
    return;
  }
  if(e.key==='ArrowDown' && !e.shiftKey && !e.altKey && historyAt!==-1 && !$input.value.slice($input.selectionEnd).includes('\n')){
    if(historyStep(1)) stop();
    return;
  }
  if(e.key==='r' && e.ctrlKey && !e.shiftKey){ stop(); openHistorySearch(); return; }
  if(e.key==='u' && e.ctrlKey && !e.shiftKey){
    stop();
    const at = $input.selectionStart;
    const lineStart = $input.value.lastIndexOf('\n', at-1) + 1;
    $input.setRangeText('', lineStart, at, 'end');
    mCtl.sync();
    return;
  }
}, true);

/* ── keys anywhere in the panel ────────────────────────────────────────── */
function typingInField(t){
  return t && (t.tagName==='TEXTAREA' || (t.tagName==='INPUT' && t.type==='text'));
}
document.addEventListener('keydown', e=>{
  const ctrl = e.ctrlKey || e.metaKey;
  if(ctrl && !e.shiftKey && (e.key==='o' || e.key==='O')){
    e.preventDefault();
    if(viewerOpen()) closeViewer(); else openViewer();
    return;
  }
  // Ctrl+C with nothing selected stops the running turn (Cmd+C stays copy on macOS).
  if(e.ctrlKey && !e.metaKey && (e.key==='c' || e.key==='C') && isStreaming && !String(window.getSelection())){
    e.preventDefault();
    vscode.postMessage({type:'interrupt'});
    return;
  }
  if(e.key==='Escape'){
    if(viewerOpen()){ e.preventDefault(); closeViewer(); return; }
    if(pendingApproval){ e.preventDefault(); respondApproval(false); return; }
  }
  if(ctrl && e.key==='End'){ e.preventDefault(); scrollBottom(true); return; }
  if(ctrl && e.key==='Home' && !typingInField(e.target)){ e.preventDefault(); $msgs.scrollTop = 0; following=false; return; }
  if(e.key==='PageUp' || e.key==='PageDown'){
    if(typingInField(e.target) && e.target !== $input) return;
    e.preventDefault();
    $msgs.scrollBy({ top: (e.key==='PageUp'?-1:1) * $msgs.clientHeight * 0.9 });
    return;
  }
  // An approval takes one key, as in the full-screen REPL, unless you're typing a message.
  if(pendingApproval && !typingInField(e.target) && !ctrl && !e.altKey){
    if(e.key==='y' || e.key==='Y'){ e.preventDefault(); respondApproval(true); }
    else if(e.key==='n' || e.key==='N'){ e.preventDefault(); respondApproval(false); }
  }
});

renderStatus();
