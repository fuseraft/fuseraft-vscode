import * as vscode from 'vscode';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { validateBinaryPath } from './fuseraftUtils';

const CONFIG_DIR  = path.join(os.homedir(), '.fuseraft');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config');

interface ProviderDef {
    label: string;
    provider: string;
    endpoint: string;
    models: string[];
}

const PROVIDERS: ProviderDef[] = [
    {
        label: 'Anthropic',
        provider: 'anthropic',
        endpoint: 'https://api.anthropic.com',
        models: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
    },
    {
        label: 'OpenAI',
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1',
        models: ['gpt-4o', 'gpt-4o-mini'],
    },
    {
        label: 'xAI',
        provider: 'xai',
        endpoint: 'https://api.x.ai/v1',
        models: ['grok-4', 'grok-4-1-fast-reasoning'],
    },
    {
        label: 'Google',
        provider: 'google',
        endpoint: 'https://generativelanguage.googleapis.com',
        models: ['gemini-2.5-flash', 'gemini-2.0-flash'],
    },
    {
        label: 'Mistral',
        provider: 'mistral',
        endpoint: 'https://api.mistral.ai/v1',
        models: ['mistral-medium-latest', 'mistral-large-latest'],
    },
    {
        label: 'DeepSeek',
        provider: 'deepseek',
        endpoint: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat'],
    },
    {
        label: 'Custom / Self-hosted',
        provider: 'custom',
        endpoint: '',
        models: [],
    },
];

export async function isConfigured(): Promise<boolean> {
    if (!fs.existsSync(CONFIG_PATH)) { return false; }
    try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        if (typeof cfg.modelId !== 'string' || cfg.modelId.trim().length === 0) {
            return false;
        }
    } catch {
        return false;
    }

    const binaryPath = vscode.workspace.getConfiguration('fuseraft').get<string>('binaryPath', 'fuseraft');
    const validation = await validateBinaryPath(binaryPath);
    return validation.valid;
}

export async function runSetupWizard(): Promise<void> {
    // Read existing config to pre-populate the form
    let existingConfig: Record<string, string> = {};
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            existingConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch { /* start fresh */ }

    const currentBinaryPath = vscode.workspace.getConfiguration('fuseraft').get<string>('binaryPath', 'fuseraft');
    const binaryValidation = await validateBinaryPath(currentBinaryPath);

    const panel = vscode.window.createWebviewPanel(
        'fuseraftSetup',
        'fuseraft — Set Up Provider',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = buildFormHtml(
        currentBinaryPath,
        binaryValidation,
        existingConfig,
    );

    panel.webview.onDidReceiveMessage(async (msg: {
        command: string;
        binaryPath?: string;
        provider?: string;
        endpoint?: string;
        modelId?: string;
        apiKey?: string;
    }) => {
        if (msg.command === 'browseBinary') {
            const uris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                canSelectFiles: true,
                canSelectFolders: false,
                title: 'Select fuseraft binary',
                openLabel: 'Select Binary',
            });
            if (uris && uris[0]) {
                panel.webview.postMessage({ command: 'binaryPicked', path: uris[0].fsPath });
            }
            return;
        }

        if (msg.command === 'validateBinary') {
            const result = await validateBinaryPath(msg.binaryPath ?? '');
            panel.webview.postMessage({ command: 'binaryValidated', ...result });
            return;
        }

        if (msg.command === 'test') {
            const { provider = 'openai', endpoint = '', modelId = '', apiKey = '' } = msg;
            const result = await testConnection(modelId, endpoint, provider, apiKey);
            panel.webview.postMessage({ command: 'testResult', ...result });
            return;
        }

        if (msg.command === 'save') {
            const { binaryPath = currentBinaryPath, provider = 'openai', endpoint = '', modelId = '', apiKey = '' } = msg;

            // Save binary path to VS Code settings if changed
            if (binaryPath !== currentBinaryPath) {
                await vscode.workspace.getConfiguration('fuseraft').update(
                    'binaryPath', binaryPath, vscode.ConfigurationTarget.Global
                );
            }

            writeUserConfig(modelId, endpoint, provider, apiKey);
            panel.webview.postMessage({ command: 'saved' });
            vscode.window.showInformationMessage(
                `fuseraft configured: ${modelId}. Run fuseraft repl once to migrate your API key to the OS keychain.`
            );
        }
    });
}

function buildFormHtml(
    binaryPath: string,
    binaryValidation: { valid: boolean; version?: string; error?: string },
    existingConfig: Record<string, string>,
): string {
    const providersJson = JSON.stringify(PROVIDERS);
    const savedProvider  = existingConfig.provider  ?? '';
    const savedEndpoint  = existingConfig.endpoint  ?? '';
    const savedModelId   = existingConfig.modelId   ?? '';
    const savedApiKey    = existingConfig.apiKey    ?? '';

    const binaryStatus = binaryValidation.valid
        ? `<span class="status-ok">✓ v${binaryValidation.version ?? 'ok'}</span>`
        : `<span class="status-err">✗ ${binaryValidation.error ?? 'not found'}</span>`;

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>fuseraft Setup</title>
<style>
  :root {
    --gap: 14px;
    --radius: 4px;
  }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 28px 32px;
    max-width: 560px;
  }
  h2 {
    font-size: 1.15em;
    font-weight: 600;
    margin: 0 0 22px;
    color: var(--vscode-foreground);
  }
  .section {
    border: 1px solid var(--vscode-panel-border, #333);
    border-radius: var(--radius);
    padding: 16px 18px;
    margin-bottom: 18px;
  }
  .section-title {
    font-size: 0.78em;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    margin: 0 0 12px;
  }
  label {
    display: block;
    font-size: 0.88em;
    margin-bottom: 4px;
    color: var(--vscode-foreground);
  }
  input, select {
    width: 100%;
    box-sizing: border-box;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: var(--radius);
    padding: 6px 8px;
    font-size: var(--vscode-font-size);
    font-family: var(--vscode-font-family);
    outline: none;
    margin-bottom: var(--gap);
  }
  input:focus, select:focus {
    border-color: var(--vscode-focusBorder, #007fd4);
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .row input {
    flex: 1;
    margin-bottom: 0;
  }
  .row button {
    flex-shrink: 0;
    margin-bottom: 0;
    padding: 6px 12px;
  }
  .binary-meta {
    font-size: 0.82em;
    margin-bottom: var(--gap);
    margin-top: -8px;
  }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: var(--radius);
    padding: 7px 16px;
    font-size: var(--vscode-font-size);
    font-family: var(--vscode-font-family);
    cursor: pointer;
    margin-right: 8px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .actions { margin-top: 4px; display: flex; align-items: center; }
  .msg {
    font-size: 0.85em;
    margin-left: 12px;
    padding: 4px 10px;
    border-radius: var(--radius);
    display: none;
  }
  .msg.ok  { display: inline; background: var(--vscode-testing-iconPassed, #4caf50)22; color: var(--vscode-testing-iconPassed, #4caf50); }
  .msg.err { display: inline; background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-inputValidation-errorForeground, #f48771); }
  .msg.info { display: inline; background: var(--vscode-inputValidation-infoBackground); color: var(--vscode-inputValidation-infoForeground); }
  .status-ok  { color: var(--vscode-testing-iconPassed, #4caf50); }
  .status-err { color: var(--vscode-inputValidation-errorForeground, #f48771); }
  select option { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
</style>
</head>
<body>
<h2>ƒ Set Up Provider</h2>

<div class="section">
  <div class="section-title">Binary</div>
  <label for="binaryPath">fuseraft binary path</label>
  <div class="row">
    <input id="binaryPath" type="text" value="${escHtml(binaryPath)}" placeholder="fuseraft" spellcheck="false">
    <button class="secondary" onclick="browseBinary()">Browse…</button>
    <button class="secondary" onclick="validateBinary()">Validate</button>
  </div>
  <div class="binary-meta" id="binaryMeta">${binaryStatus}</div>
</div>

<div class="section">
  <div class="section-title">Provider</div>
  <label for="providerSelect">Preset</label>
  <select id="providerSelect" onchange="onProviderChange()">
    <option value="">— select a provider —</option>
  </select>

  <label for="endpoint">Endpoint URL</label>
  <input id="endpoint" type="text" placeholder="https://api.anthropic.com" spellcheck="false">

  <label for="modelId">Model</label>
  <input id="modelId" type="text" list="modelSuggestions" placeholder="e.g. claude-sonnet-4-6" spellcheck="false">
  <datalist id="modelSuggestions"></datalist>

  <label for="apiKey">API Key</label>
  <input id="apiKey" type="password" placeholder="Paste your API key" autocomplete="off">
</div>

<div class="actions">
  <button onclick="testConnection()">Test Connection</button>
  <button onclick="save()">Save</button>
  <span id="msg" class="msg"></span>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const PROVIDERS = ${providersJson};
  const savedProvider = ${JSON.stringify(savedProvider)};
  const savedEndpoint = ${JSON.stringify(savedEndpoint)};
  const savedModelId  = ${JSON.stringify(savedModelId)};
  const savedApiKey   = ${JSON.stringify(savedApiKey)};

  // Populate provider dropdown
  const sel = document.getElementById('providerSelect');
  PROVIDERS.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.provider;
    opt.textContent = p.label;
    sel.appendChild(opt);
  });

  // Pre-fill from saved config
  if (savedProvider) { sel.value = savedProvider; }
  if (savedEndpoint) { document.getElementById('endpoint').value = savedEndpoint; }
  if (savedModelId)  { document.getElementById('modelId').value  = savedModelId; }
  if (savedApiKey)   { document.getElementById('apiKey').value   = savedApiKey; }
  if (!savedEndpoint && savedProvider) { onProviderChange(true); }
  updateModelSuggestions();

  function onProviderChange(keepExisting) {
    const p = PROVIDERS.find(x => x.provider === sel.value);
    if (!p) { return; }
    if (!keepExisting || !document.getElementById('endpoint').value) {
      document.getElementById('endpoint').value = p.endpoint;
    }
    if (!keepExisting || !document.getElementById('modelId').value) {
      document.getElementById('modelId').value = p.models[0] ?? '';
    }
    updateModelSuggestions();
  }

  function updateModelSuggestions() {
    const p = PROVIDERS.find(x => x.provider === sel.value);
    const dl = document.getElementById('modelSuggestions');
    dl.innerHTML = '';
    (p?.models ?? []).forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      dl.appendChild(opt);
    });
  }

  function browseBinary() {
    vscode.postMessage({ command: 'browseBinary' });
  }

  function validateBinary() {
    showMsg('Validating…', 'info');
    vscode.postMessage({ command: 'validateBinary', binaryPath: document.getElementById('binaryPath').value.trim() });
  }

  function testConnection() {
    showMsg('Testing…', 'info');
    const provider = sel.value || 'openai';
    vscode.postMessage({
      command: 'test',
      provider,
      endpoint: document.getElementById('endpoint').value.trim(),
      modelId:  document.getElementById('modelId').value.trim(),
      apiKey:   document.getElementById('apiKey').value.trim(),
    });
  }

  function save() {
    const modelId = document.getElementById('modelId').value.trim();
    const endpoint = document.getElementById('endpoint').value.trim();
    if (!modelId) { showMsg('Model ID is required.', 'err'); return; }
    if (!endpoint) { showMsg('Endpoint URL is required.', 'err'); return; }
    vscode.postMessage({
      command: 'save',
      binaryPath: document.getElementById('binaryPath').value.trim(),
      provider:   sel.value || 'openai',
      endpoint,
      modelId,
      apiKey:     document.getElementById('apiKey').value.trim(),
    });
  }

  function showMsg(text, type) {
    const el = document.getElementById('msg');
    el.textContent = text;
    el.className = 'msg ' + type;
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.command === 'binaryPicked') {
      document.getElementById('binaryPath').value = msg.path;
      validateBinary();
    }
    if (msg.command === 'binaryValidated') {
      const meta = document.getElementById('binaryMeta');
      meta.innerHTML = msg.valid
        ? '<span class="status-ok">✓ v' + (msg.version ?? 'ok') + '</span>'
        : '<span class="status-err">✗ ' + (msg.error ?? 'invalid') + '</span>';
    }
    if (msg.command === 'testResult') {
      showMsg(msg.ok ? '✓ ' + msg.message : '✗ ' + msg.message, msg.ok ? 'ok' : 'err');
    }
    if (msg.command === 'saved') {
      showMsg('Saved!', 'ok');
    }
  });
</script>
</body>
</html>`;
}

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function writeUserConfig(modelId: string, endpoint: string, provider: string, apiKey: string): void {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const onDisk: Record<string, string> = { modelId, endpoint, provider };
    if (apiKey) { onDisk['apiKey'] = apiKey; }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(onDisk, null, 2), 'utf8');
}

async function testConnection(
    modelId: string,
    endpoint: string,
    provider: string,
    apiKey: string,
): Promise<{ ok: boolean; message: string }> {
    try {
        if (provider === 'google') {
            return await testGoogleConnection(modelId, endpoint, apiKey);
        }
        if (provider === 'anthropic') {
            return await testAnthropicConnection(modelId, endpoint, apiKey);
        }
        return await testOpenAICompatibleConnection(modelId, endpoint, apiKey);
    } catch (e: unknown) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
}

function httpPost(url: string, headers: Record<string, string>, body: object): Promise<{ status: number; data: string }> {
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(body);
        const parsed  = new URL(url);
        const req = https.request(
            {
                hostname: parsed.hostname,
                port:     parsed.port || 443,
                path:     parsed.pathname + parsed.search,
                method:   'POST',
                headers:  {
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(bodyStr),
                    ...headers,
                },
            },
            res => {
                let data = '';
                res.on('data', (chunk: string) => { data += chunk; });
                res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
            }
        );
        req.on('error', reject);
        req.setTimeout(10_000, () => req.destroy(new Error('Request timed out')));
        req.write(bodyStr);
        req.end();
    });
}

function parseErrorMessage(data: string, status: number): string {
    try {
        const parsed = JSON.parse(data);
        return parsed?.error?.message ?? `HTTP ${status}`;
    } catch {
        return `HTTP ${status}`;
    }
}

async function testAnthropicConnection(modelId: string, endpoint: string, apiKey: string): Promise<{ ok: boolean; message: string }> {
    const resp = await httpPost(
        `${endpoint}/v1/messages`,
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        { model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
    );
    return resp.status >= 200 && resp.status < 300
        ? { ok: true,  message: `HTTP ${resp.status}` }
        : { ok: false, message: parseErrorMessage(resp.data, resp.status) };
}

async function testOpenAICompatibleConnection(modelId: string, endpoint: string, apiKey: string): Promise<{ ok: boolean; message: string }> {
    const base = endpoint.replace(/\/$/, '');
    const resp = await httpPost(
        `${base}/chat/completions`,
        { 'Authorization': `Bearer ${apiKey}` },
        { model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
    );
    return resp.status >= 200 && resp.status < 300
        ? { ok: true,  message: `HTTP ${resp.status}` }
        : { ok: false, message: parseErrorMessage(resp.data, resp.status) };
}

async function testGoogleConnection(modelId: string, endpoint: string, apiKey: string): Promise<{ ok: boolean; message: string }> {
    const base = endpoint.replace(/\/$/, '');
    const resp = await httpPost(
        `${base}/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {},
        { contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } }
    );
    return resp.status >= 200 && resp.status < 300
        ? { ok: true,  message: `HTTP ${resp.status}` }
        : { ok: false, message: parseErrorMessage(resp.data, resp.status) };
}
