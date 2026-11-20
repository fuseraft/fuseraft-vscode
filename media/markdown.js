/* Markdown for replies: the subset the agent writes, rendered to HTML that is safe to insert. Everything is escaped
   before any markup is added, links are http, https, or mailto only, and images are never loaded. Loaded by the chat
   panel before repl.js, and by the tests through require(). */
function esc(s){
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const ICON_COPY  = '<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M4 4V2.5A1.5 1.5 0 0 1 5.5 1h7A1.5 1.5 0 0 1 14 2.5v7a1.5 1.5 0 0 1-1.5 1.5H11v1.5A1.5 1.5 0 0 1 9.5 14h-7A1.5 1.5 0 0 1 1 12.5v-7A1.5 1.5 0 0 1 2.5 4H4zm1 0h4.5A1.5 1.5 0 0 1 11 5.5V10h1.5a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-7a.5.5 0 0 0-.5.5V4zM2.5 5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-7z"/></svg>';
const ICON_INSERT = '<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8.5 1v8.3l2.65-2.65.7.7L8 11.2 4.15 7.35l.7-.7L7.5 9.3V1h1zM2 13h12v1H2v-1z"/></svg>';
const ICON_OPEN   = '<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M3 1h6.2L13 4.8V15H3V1zm1 1v12h8V5.5H8.5V2H4zm5.5.4V4.5h2.1L9.5 2.4z"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13.85 4.15a.5.5 0 0 1 0 .707l-7 7a.5.5 0 0 1-.707 0l-3.5-3.5a.5.5 0 1 1 .707-.707L6.5 10.793l6.646-6.647a.5.5 0 0 1 .707 0z"/></svg>';

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
    const btns='<div class="code-actions">'
      +'<button type="button" class="code-btn code-insert-btn" title="Insert at the cursor in the file you were in">'+ICON_INSERT+'</button>'
      +'<button type="button" class="code-btn code-open-btn" title="Open in a new editor">'+ICON_OPEN+'</button>'
      +'<button type="button" class="code-btn code-copy-btn" title="Copy code">'+ICON_COPY+'</button>'
      +'</div>';
    return stash('<pre'+attr+'>'+btns+'<code>'+esc(code.replace(/\n$/,''))+'</code></pre>');
  });
  s = esc(s);
  // inline code
  s = s.replace(/`([^`\n]+)`/g,'<code>$1</code>');
  // images (before links: image syntax is link syntax prefixed with !). Never loaded: a reply that names a remote
  // image would have the panel request it unasked, and the URL can carry whatever the model was steered to put in
  // it. It becomes a link you can choose to open.
  s = s.replace(/!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g,(_,alt,url)=>
    '<a class="md-image" href="'+url+'" title="'+url+'" target="_blank" rel="noopener noreferrer">Image: '+(alt||url)+'</a>');
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
  return markPaths(s);
}

/* ── file references in replies ──────────────────────────────────────────
   Anything in a reply that looks like a file path (src/foo.ts, README.md,
   src/foo.ts:42, foo.ts#L10-L20) is marked as a candidate; the extension
   says which ones are files, and those become links that open at the line.
   Code blocks and links are left alone. */
const PATH_RE = /(^|[\s(\[{"'“‘,;>])((?:[A-Za-z]:[\\/]|~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+[\\/])*[\w@+-][\w@.+-]*\.[A-Za-z]\w{0,9})(?::(\d+)(?:[-–](\d+)|:\d+)?|#L(\d+)(?:-L?(\d+))?)?(?=$|[\s)\]}"'”’,;:.!?<&])/g;
function pathSpan(text, file, line, end){
  return '<span class="path-ref" data-path="'+file+'"'+(line?' data-line="'+line+'"':'')+(end?' data-end="'+end+'"':'')+'>'+text+'</span>';
}
function markPaths(html){
  let skip = 0;
  return html.split(/(<[^>]+>)/).map((part, i, all)=>{
    if(part.startsWith('<')){
      if(/^<(pre|a)[\s>]/.test(part)) skip++;
      else if(/^<\/(pre|a)>/.test(part)) skip--;
      return part;
    }
    if(skip>0 || !part) return part;
    // Inline code that is wholly a path: the span goes inside the <code>.
    if(all[i-1]==='<code>' && all[i+1]==='</code>'){
      PATH_RE.lastIndex = 0;
      const m = PATH_RE.exec(part);
      return m && m.index===0 && !m[1] && m[0].length===part.length ? pathSpan(part, m[2], m[3]||m[5], m[4]||m[6]) : part;
    }
    return part.replace(PATH_RE, (whole, pre, file, l1, e1, l2, e2)=>
      pre + pathSpan(whole.slice(pre.length), file, l1||l2, e1||e2));
  }).join('');
}

if (typeof module !== 'undefined') module.exports = { esc, mdToHtml, markPaths };
