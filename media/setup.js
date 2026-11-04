(function () {
  const vscode = acquireVsCodeApi();
  const init = JSON.parse(document.getElementById('init').textContent);
  const providers = init.providers;

  const $ = (id) => document.getElementById(id);
  const tilesEl       = $('tiles');
  const endpointLine  = $('endpointLine');
  const endpointField = $('endpointField');
  const endpointEl    = $('endpoint');
  const keyField      = $('keyField');
  const keyHint       = $('keyHint');
  const keyNote       = $('keyNote');
  const apiKeyEl      = $('apiKey');
  const showKeyBtn    = $('showKeyBtn');
  const keyStatus     = $('keyStatus');
  const modelSelectEl = $('modelSelect');
  const modelInputEl  = $('modelInput');
  const refreshBtn    = $('refreshModelsBtn');
  const modelStatus   = $('modelStatus');
  const resultEl      = $('result');
  const summaryEl     = $('summary');
  const testBtn       = $('testBtn');
  const saveBtn       = $('saveBtn');

  // How each provider's model list was filled: 'live' or 'failed'; otherwise it's the suggested list.
  const modelSource = {};

  // Whether the CLI has a key saved for each endpoint checked so far. Only CLIs that keep a key
  // per endpoint (init.scopedKeys) can say; an older one holds a single key for every provider.
  const keySaved = new Map();
  if (init.curEnd) { keySaved.set(init.curEnd, init.hasKeychainKey); }
  function checkKey(endpoint) {
    if (!init.scopedKeys || !endpoint || keySaved.has(endpoint)) { return; }
    vscode.postMessage({ action: 'checkKey', endpoint });
  }
  let checkTimer;
  if (init.liveModelCount > 0) { modelSource[init.curProv] = 'live'; }

  const current = () => providers.find(p => p.provider === selectedProvider()) || providers[0];
  function selectedProvider() {
    const checked = tilesEl.querySelector('input:checked');
    return checked ? checked.value : providers[0].provider;
  }

  function link(id, action, busyText) {
    const el = $(id);
    if (!el) { return; }
    el.addEventListener('click', (e) => {
      e.preventDefault();
      if (busyText) { el.textContent = busyText; el.classList.add('busy'); }
      vscode.postMessage(typeof action === 'string' ? { action } : action());
    });
  }
  link('installBtn', 'runInstaller');
  link('updateLink', 'runUpdate', 'Updating…');
  link('installDocsLink', 'openInstallDocs');
  link('binaryPathLink', 'openBinaryPathSetting');
  link('recheckLink', 'recheckCli');
  link('secureKeyLink', 'migrateKey', 'Moving…');
  link('keyUrlLink', () => ({ action: 'openKeyPage', provider: selectedProvider() }));
  $('installBtn')?.addEventListener('click', () => { $('installBtn').disabled = true; });

  // ── Providers ──
  providers.forEach(p => {
    const tile = document.createElement('label');
    tile.className = 'tile';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'provider';
    input.value = p.provider;
    const name = document.createElement('span');
    name.className = 'tile-name';
    name.textContent = p.label;
    const desc = document.createElement('span');
    desc.className = 'tile-desc';
    desc.textContent = p.description;
    tile.append(input, name, desc);
    tilesEl.appendChild(tile);
    input.addEventListener('change', () => {
      hideResult();
      updateForm(false);
    });
  });
  const initial = tilesEl.querySelector(`input[value="${CSS.escape(init.curProv)}"]`) || tilesEl.querySelector('input');
  initial.checked = true;

  // keep: models arrived from the provider; keep what's been typed rather than going back to the saved values.
  function updateForm(keep) {
    const p = current();
    const isSaved = p.provider === init.curProv;
    const end = keep ? endpointEl.value : (isSaved ? init.curEnd : '');
    const mod = keep ? getFormData().modelId : (isSaved ? init.curMod : '');

    // Endpoint: only Custom is editable; the rest are shown for reference.
    const custom = p.provider === 'custom';
    endpointField.hidden = !custom;
    endpointLine.hidden = custom;
    if (custom) {
      endpointEl.value = end || '';
    } else {
      endpointEl.value = p.endpoint;
      endpointLine.querySelector('code').textContent = p.endpoint;
    }

    // API key: Ollama needs none; Custom may not.
    const noKey = p.provider === 'ollama';
    keyField.hidden = noKey;
    keyNote.hidden = !noKey;
    keyHint.hidden = !custom;
    $('keyUrlLink').hidden = !p.keyUrl;
    if (!keep && !isSaved) { apiKeyEl.value = ''; }
    else if (!keep) { apiKeyEl.value = init.curKey; }
    checkKey(endpointEl.value.trim());

    // Models
    modelSelectEl.innerHTML = '';
    const hasList = p.models && p.models.length > 0;
    modelSelectEl.hidden = !hasList;
    if (hasList) {
      p.models.forEach(m => modelSelectEl.appendChild(new Option(m, m)));
      modelSelectEl.appendChild(new Option('Other model…', '__custom__'));
      if (p.models.includes(mod)) {
        modelSelectEl.value = mod;
        modelInputEl.value = '';
      } else if (mod && mod.trim() !== '') {
        modelSelectEl.value = '__custom__';
        modelInputEl.value = mod;
      } else {
        modelSelectEl.value = p.models[0];
      }
    } else {
      modelInputEl.value = mod || '';
    }
    // With no list the ID field takes the select's place beside the refresh button.
    if (hasList) { refreshBtn.parentElement.after(modelInputEl); }
    else { refreshBtn.before(modelInputEl); }
    modelInputEl.classList.toggle('alone', !hasList);
    modelInputEl.hidden = hasList && modelSelectEl.value !== '__custom__';
    refresh();
  }

  function getFormData() {
    const provider = selectedProvider();
    const endpoint = endpointEl.value.trim();
    const modelId = (!modelSelectEl.hidden && modelSelectEl.value !== '__custom__')
      ? modelSelectEl.value
      : modelInputEl.value.trim();
    const apiKey = keyField.hidden ? '' : apiKeyEl.value.trim();
    return { provider, endpoint, modelId, apiKey };
  }

  /** Status lines, step checkmarks and the footer summary, from the form as it stands. */
  function refresh() {
    const p = current();
    const data = getFormData();
    const isSaved = p.provider === init.curProv;
    const savedKeyApplies = init.scopedKeys
      ? keySaved.get(data.endpoint) === true
      : init.hasKeychainKey && isSaved;

    // Key status
    let keyDone = keyField.hidden || data.apiKey.length > 0 || savedKeyApplies || (init.hasPlaintextKey && isSaved);
    if (init.hasPlaintextKey && isSaved && (!data.apiKey || data.apiKey === init.curKey)) {
      setStatus(keyStatus, 'warn', 'Your key is saved in plaintext in the config file.', 'secureKeyLink');
    } else if (data.apiKey) {
      setStatus(keyStatus, '', init.scopedKeys
        ? 'Saved to your OS keychain for this server only, not to a file.'
        : 'Saved to your OS keychain, not to a file.');
    } else if (savedKeyApplies) {
      setStatus(keyStatus, 'ok', 'Saved in your OS keychain. Leave blank to keep it.');
    } else if (!init.scopedKeys && init.hasKeychainKey) {
      const savedLabel = (providers.find(x => x.provider === init.curProv) || { label: 'another provider' }).label;
      // An older CLI holds one key: saving with this blank keeps the old provider's key for this endpoint.
      setStatus(keyStatus, 'warn', p.provider === 'custom'
        ? `If you save with this blank, your ${savedLabel} key will be sent to this server.`
        : `The saved key is for ${savedLabel}. Paste a key for ${p.label}.`);
      keyDone = false;
    } else {
      setStatus(keyStatus, '', init.scopedKeys && p.provider === 'custom'
        ? "Keys for your other providers aren't sent to this server."
        : 'Saved to your OS keychain, not to a file.');
      keyDone = keyDone || p.provider === 'custom';
    }
    // Model status
    const n = p.models ? p.models.length : 0;
    const source = modelSource[p.provider];
    if (modelSelectEl.hidden) {
      setStatus(modelStatus, source === 'failed' ? 'bad' : '',
        source === 'failed' ? "Couldn't load models. Enter the model ID your server serves."
                                 : 'Enter the model ID your server serves, or refresh to list them.');
    } else if (source === 'live') {
      setStatus(modelStatus, 'ok', `${n} ${n === 1 ? 'model' : 'models'} available from ${p.provider === 'custom' ? 'your server' : p.label}.`);
    } else if (source === 'failed') {
      setStatus(modelStatus, 'bad', "Couldn't load models. Check the API key and endpoint.");
    } else {
      setStatus(modelStatus, '', p.provider === 'custom'
        ? "Refresh to list this server's models."
        : `Suggested models. Refresh to load ${p.label}'s full list.`);
    }

    const ready = init.cliFound;
    $('step-provider').classList.toggle('done', ready && (p.provider !== 'custom' || !!data.endpoint));
    $('step-key').classList.toggle('done', ready && keyDone);
    $('step-model').classList.toggle('done', ready && !!data.modelId);

    summaryEl.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = p.label;
    summaryEl.append(strong, document.createTextNode(data.modelId ? ' · ' + data.modelId : ' · no model chosen'));
    saveBtn.disabled = !init.cliFound || !data.modelId;
  }

  function setStatus(el, kind, text, linkId) {
    el.className = 'status' + (kind ? ' ' + kind : '');
    el.querySelector('.text').textContent = text;
    el.querySelectorAll('a[data-for]').forEach(a => { a.hidden = a.id !== linkId; });
  }

  modelSelectEl.addEventListener('change', () => {
    modelInputEl.hidden = modelSelectEl.value !== '__custom__';
    if (!modelInputEl.hidden) { modelInputEl.focus(); }
    refresh();
  });
  [modelInputEl, apiKeyEl, endpointEl].forEach(el => el.addEventListener('input', refresh));
  endpointEl.addEventListener('input', () => {
    // Models listed for the previous URL may not be this server's.
    if (modelSource.custom) { delete modelSource.custom; refresh(); }
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => checkKey(endpointEl.value.trim()), 400);
  });

  showKeyBtn.addEventListener('click', () => {
    const show = apiKeyEl.type === 'password';
    apiKeyEl.type = show ? 'text' : 'password';
    showKeyBtn.textContent = show ? 'Hide' : 'Show';
  });

  refreshBtn.addEventListener('click', () => {
    const data = getFormData();
    if (data.provider === 'custom' && !data.endpoint) {
      showResult(false, 'Enter your server’s endpoint URL first.');
      return;
    }
    refreshBtn.disabled = true;
    refreshBtn.classList.add('spinning');
    vscode.postMessage({ action: 'fetchModels', endpoint: data.endpoint, apiKey: data.apiKey, provider: data.provider });
  });

  testBtn.addEventListener('click', () => {
    const data = getFormData();
    if (data.provider === 'custom' && !data.endpoint) {
      showResult(false, 'Enter your server’s endpoint URL first.');
      return;
    }
    testBtn.disabled = true;
    testBtn.textContent = 'Testing…';
    hideResult();
    vscode.postMessage({ action: 'test', ...data });
  });

  saveBtn.addEventListener('click', () => {
    const data = getFormData();
    if (!data.modelId) {
      showResult(false, 'Choose a model before saving.');
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    vscode.postMessage({ action: 'save', ...data });
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'testResult') {
      testBtn.disabled = false;
      testBtn.textContent = 'Test connection';
      const { ok, message: text } = message.result;
      const detail = ok && /^HTTP \d+$/.test(text) ? `${getFormData().modelId} responded.` : text;
      showResult(ok, detail, ok ? 'Connected.' : 'Couldn’t connect.');
    }
    if (message.type === 'saveError') {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      showResult(false, message.message, 'Couldn’t save.');
    }
    if (message.type === 'modelsLoaded') {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('spinning');
      const loaded = message.models;
      if (loaded && loaded.length > 0) {
        current().models = loaded;
        modelSource[current().provider] = 'live';
      } else if (modelSource[current().provider] !== 'live') {
        modelSource[current().provider] = 'failed';
      }
      updateForm(true);
    }
    if (message.type === 'keyStatus') {
      keySaved.set(message.endpoint, message.saved);
      refresh();
    }
    if (message.type === 'installerLaunched') {
      showProgress('Installing in the terminal. This screen updates when it’s done.');
    }
    if (message.type === 'updaterLaunched') {
      showProgress('Updating in the terminal. Click Check again when it finishes.');
    }
  });

  function showProgress(text) {
    const el = $('cliProgress');
    el.querySelector('.text').textContent = text;
    el.hidden = false;
  }

  function showResult(ok, text, title) {
    resultEl.innerHTML = '';
    if (title) {
      const strong = document.createElement('strong');
      strong.textContent = title + ' ';
      resultEl.appendChild(strong);
    }
    resultEl.appendChild(document.createTextNode(text.charAt(0).toUpperCase() + text.slice(1)));
    resultEl.className = ok ? 'ok' : 'bad';
    resultEl.hidden = false;
    resultEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function hideResult() { resultEl.hidden = true; }

  updateForm(false);
})();
