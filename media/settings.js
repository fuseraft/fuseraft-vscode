(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const sectionsEl = $('sections');
  const noticeEl   = $('notice');
  const searchEl   = $('search');
  const changedEl  = $('onlyChanged');
  const noMatchEl  = $('noMatch');

  // Keys group by the part before the dot; skills and skillCuration share a section.
  const SECTIONS = [
    { id: 'provider',  title: 'Model and provider', prefixes: ['provider'],
      note: 'The API key and the model list are in <a href="#" data-action="openSetup">Setup</a>.' },
    { id: 'sampling',  title: 'Sampling',   prefixes: ['sampling'] },
    { id: 'repl',      title: 'Chat',       prefixes: ['repl'],
      note: 'Theme, dock, bell and banner only apply to fuseraft in the terminal.' },
    { id: 'memory',    title: 'Memory',     prefixes: ['memory'] },
    { id: 'subagent',  title: 'Sub-agents', prefixes: ['subagent'] },
    { id: 'skills',    title: 'Skills',     prefixes: ['skills', 'skillCuration'] },
    { id: 'telemetry', title: 'Telemetry',  prefixes: ['telemetry'] },
  ];

  const LABELS = {
    'skillCuration.enabled': 'Skill curation',
    'repl.hitlAutoApproveReadOnly': 'Auto-approve read-only commands',
    'repl.yolo': 'YOLO mode',
  };
  const WORDS = { api: 'API', id: 'ID', otlp: 'OTLP', hitl: 'HITL', env: 'environment', var: 'variable', top: 'Top', p: 'P' };

  /** "maxTurnInputTokens" → "Max turn input tokens". */
  function labelFor(key) {
    if (LABELS[key]) return LABELS[key];
    const words = key.slice(key.indexOf('.') + 1).split(/(?=[A-Z])/).map(w => w.toLowerCase());
    const text = words.map(w => WORDS[w] || w).join(' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  let settings = [];
  const errors = {};

  // A setting that can't be cleared and has no default (the model ID) has nothing to go back to.
  const canReset = (s) => s.value !== null && (s.clearable || (s.default !== null && s.value !== s.default));
  const isModified = canReset;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function rangeText(s) {
    if (s.min !== null && s.max !== null) return `${s.min}–${s.max}`;
    if (s.min !== null) return `${s.min} or more`;
    if (s.max !== null) return `up to ${s.max}`;
    return '';
  }

  function placeholderFor(s) {
    if (s.default !== null) return `Default: ${s.default}`;
    if (s.key.startsWith('sampling.')) return "Provider's default";
    if (s.key === 'provider.endpoint' || s.key === 'provider.type' || s.key.endsWith('.provider')) return 'Detected';
    if (s.key.endsWith('.model')) return 'Chat model';
    if (s.key === 'repl.contextBudget') return "Model's estimate";
    return 'Not set';
  }

  function controlHtml(s) {
    const id = `ctl-${s.key}`;
    const effective = s.value ?? s.default;
    switch (s.kind) {
      case 'bool': {
        const on = (effective ?? 'false') === 'true';
        return `<label class="toggle"><input type="checkbox" id="${esc(id)}" ${on ? 'checked' : ''}><span class="track"></span><span class="state">${on ? 'On' : 'Off'}</span></label>`;
      }
      case 'choice':
        return `<select id="${esc(id)}">${(s.choices || []).map(c =>
          `<option value="${esc(c)}" ${c === effective ? 'selected' : ''}>${esc(c)}${c === s.default ? ' (default)' : ''}</option>`).join('')}</select>`;
      case 'integer':
      case 'number': {
        const attrs = [
          s.min !== null ? `min="${s.min}"` : '',
          s.max !== null ? `max="${s.max}"` : '',
          `step="${s.kind === 'integer' ? 1 : 'any'}"`,
        ].join(' ');
        const range = rangeText(s);
        return `<input type="number" id="${esc(id)}" ${attrs} value="${esc(s.value ?? '')}" placeholder="${esc(placeholderFor(s))}">` +
          (range ? `<span class="range">${esc(range)}</span>` : '');
      }
      default:
        return `<input type="text" id="${esc(id)}" value="${esc(s.value ?? '')}" placeholder="${esc(placeholderFor(s))}" spellcheck="false">`;
    }
  }

  function rowHtml(s) {
    const error = errors[s.key];
    return `<div class="setting${isModified(s) ? ' modified' : ''}${error ? ' invalid' : ''}" data-key="${esc(s.key)}">
      <div class="setting-head">
        <label class="label" for="${esc(`ctl-${s.key}`)}">${esc(labelFor(s.key))}</label>
        <code class="key">${esc(s.key)}</code>
        <span class="dot" title="Changed from the default"></span>
      </div>
      <div class="desc">${esc(s.description)}</div>
      <div class="control">${controlHtml(s)}<a href="#" class="reset" data-reset="${esc(s.key)}" ${canReset(s) ? '' : 'hidden'}>Reset</a><span class="status"></span></div>
      <div class="error" ${error ? '' : 'hidden'}>${esc(error || '')}</div>
    </div>`;
  }

  function sectionFor(key) {
    const prefix = key.slice(0, key.indexOf('.'));
    return SECTIONS.find(sec => sec.prefixes.includes(prefix)) || null;
  }

  function render() {
    const bySection = new Map();
    for (const s of settings) {
      const sec = sectionFor(s.key);
      const id = sec ? sec.id : 'other';
      if (!bySection.has(id)) bySection.set(id, []);
      bySection.get(id).push(s);
    }
    const all = [...SECTIONS, { id: 'other', title: 'Other', prefixes: [] }];
    sectionsEl.innerHTML = all.filter(sec => bySection.has(sec.id)).map(sec => `
      <section data-section="${sec.id}">
        <h2>${esc(sec.title)}</h2>
        ${sec.note ? `<p class="section-note">${sec.note}</p>` : ''}
        ${bySection.get(sec.id).map(rowHtml).join('')}
      </section>`).join('');
    filter();
  }

  function rerenderRow(key) {
    const row = sectionsEl.querySelector(`.setting[data-key="${CSS.escape(key)}"]`);
    const s = settings.find(x => x.key === key);
    if (!row || !s) return;
    row.outerHTML = rowHtml(s);
    filter();
  }

  function filter() {
    const q = searchEl.value.trim().toLowerCase();
    const onlyChanged = changedEl.checked;
    let shown = 0;
    for (const section of sectionsEl.querySelectorAll('section')) {
      let any = 0;
      for (const row of section.querySelectorAll('.setting')) {
        const s = settings.find(x => x.key === row.dataset.key);
        const hay = `${labelFor(s.key)} ${s.key} ${s.description}`.toLowerCase();
        const visible = (!q || hay.includes(q)) && (!onlyChanged || isModified(s));
        row.hidden = !visible;
        if (visible) any++;
      }
      section.hidden = any === 0;
      shown += any;
    }
    noMatchEl.hidden = shown > 0 || settings.length === 0;
  }

  function save(key, value) {
    const row = sectionsEl.querySelector(`.setting[data-key="${CSS.escape(key)}"]`);
    if (row) {
      row.classList.add('saving');
      row.querySelector('.status').textContent = 'Saving…';
    }
    vscode.postMessage({ action: 'set', key, value });
  }

  function valueOf(s, el) {
    if (s.kind === 'bool') return el.checked ? 'true' : 'false';
    return el.value.trim();
  }

  sectionsEl.addEventListener('change', (e) => {
    const row = e.target.closest('.setting');
    if (!row || !e.target.id || !e.target.id.startsWith('ctl-')) return;
    const s = settings.find(x => x.key === row.dataset.key);
    const value = valueOf(s, e.target);
    if (s.kind === 'bool') row.querySelector('.state').textContent = value === 'true' ? 'On' : 'Off';
    // An empty box means "unset"; there's nothing to do when that's what the file already holds.
    if (value === (s.value ?? '') || (value === '' && s.value === null)) return;
    save(s.key, value);
  });

  sectionsEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input[type=text], input[type=number]')) e.target.blur();
  });

  document.addEventListener('click', (e) => {
    const reset = e.target.closest('[data-reset]');
    if (reset) {
      e.preventDefault();
      const s = settings.find(x => x.key === reset.dataset.reset);
      save(s.key, s.clearable ? '' : (s.default ?? ''));
      return;
    }
    const action = e.target.closest('[data-action]');
    if (action) {
      e.preventDefault();
      vscode.postMessage({ action: action.dataset.action });
    }
  });

  $('configLink').addEventListener('click', (e) => { e.preventDefault(); vscode.postMessage({ action: 'openConfig' }); });
  $('extensionSettingsLink').addEventListener('click', (e) => { e.preventDefault(); vscode.postMessage({ action: 'openExtensionSettings' }); });
  searchEl.addEventListener('input', filter);
  changedEl.addEventListener('change', filter);

  function showNotice(html) {
    noticeEl.innerHTML = html;
    noticeEl.hidden = false;
    $('toolbar').hidden = true;
    sectionsEl.innerHTML = '';
    settings = [];
    filter();
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'settings': {
        noticeEl.hidden = true;
        $('toolbar').hidden = false;
        const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.setting');
        const keep = focused ? focused.dataset.key : null;
        const hadRows = sectionsEl.querySelector('.setting');
        settings = msg.settings;
        if (!hadRows) { render(); return; }
        // A reload from the file leaves the field being edited alone; every other row shows what's saved, so an error
        // about a value that never reached the file no longer applies.
        for (const s of settings) {
          if (s.key === keep) continue;
          delete errors[s.key];
          rerenderRow(s.key);
        }
        return;
      }
      case 'saved': {
        delete errors[msg.key];
        settings = settings.map(s => s.key === msg.key ? msg.setting : s);
        rerenderRow(msg.key);
        const row = sectionsEl.querySelector(`.setting[data-key="${CSS.escape(msg.key)}"]`);
        if (row) {
          const status = row.querySelector('.status');
          status.textContent = 'Saved';
          setTimeout(() => { if (status.textContent === 'Saved') status.textContent = ''; }, 1500);
        }
        return;
      }
      case 'saveFailed': {
        errors[msg.key] = msg.error;
        const row = sectionsEl.querySelector(`.setting[data-key="${CSS.escape(msg.key)}"]`);
        if (row) {
          row.classList.remove('saving');
          row.classList.add('invalid');
          row.querySelector('.status').textContent = '';
          const err = row.querySelector('.error');
          err.textContent = msg.error;
          err.hidden = false;
        }
        return;
      }
      case 'state':
        if (msg.state === 'missing') {
          showNotice(`<p>The fuseraft CLI isn't installed, or isn't on your PATH. These settings belong to it.</p>
            <button class="primary" data-action="install">Install the CLI</button>`);
        } else if (msg.state === 'outdated') {
          showNotice(`<p>Editing settings here needs a newer fuseraft CLI than the one installed${msg.version ? ` (${esc(msg.version)})` : ''}.</p>
            <button class="primary" data-action="update">Update the CLI</button>`);
        } else {
          showNotice(`<p>The CLI couldn't read its settings: ${esc(msg.error || 'unknown error')}</p>`);
        }
        return;
    }
  });

  vscode.postMessage({ action: 'ready' });
})();
