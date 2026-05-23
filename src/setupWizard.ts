import * as vscode from 'vscode';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { checkCli, invalidateCliCache } from './fuseraftUtils';

const CONFIG_DIR  = path.join(os.homedir(), '.fuseraft');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config');

interface ProviderDef {
    label: string;
    description: string;
    provider: string;
    endpoint: string;
    models: string[];
}

const PROVIDERS: ProviderDef[] = [
    {
        label: 'Anthropic',
        description: 'Claude models',
        provider: 'anthropic',
        endpoint: 'https://api.anthropic.com',
        models: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
    },
    {
        label: 'OpenAI',
        description: 'GPT models',
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1',
        models: ['gpt-4o', 'gpt-4o-mini'],
    },
    {
        label: 'xAI',
        description: 'Grok models',
        provider: 'xai',
        endpoint: 'https://api.x.ai/v1',
        models: ['grok-4', 'grok-4-1-fast-reasoning'],
    },
    {
        label: 'Google',
        description: 'Gemini models',
        provider: 'google',
        endpoint: 'https://generativelanguage.googleapis.com',
        models: ['gemini-2.5-flash', 'gemini-2.0-flash'],
    },
    {
        label: 'Mistral',
        description: 'Mistral models',
        provider: 'mistral',
        endpoint: 'https://api.mistral.ai/v1',
        models: ['mistral-medium-latest', 'mistral-large-latest'],
    },
    {
        label: 'DeepSeek',
        description: 'DeepSeek models',
        provider: 'deepseek',
        endpoint: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat'],
    },
    {
        label: '$(edit) Custom / Self-hosted',
        description: 'OpenAI-compatible endpoint',
        provider: 'custom',
        endpoint: '',
        models: [],
    },
];

export function isConfigured(): boolean {
    if (!fs.existsSync(CONFIG_PATH)) { return false; }
    try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return typeof cfg.modelId === 'string' && cfg.modelId.trim().length > 0;
    } catch {
        return false;
    }
}

function readSavedConfig(): { modelId: string; endpoint: string; provider: string; apiKey: string; hasPlaintextKey: boolean } {
    const empty = { modelId: '', endpoint: '', provider: 'anthropic', apiKey: '', hasPlaintextKey: false };
    if (!fs.existsSync(CONFIG_PATH)) { return empty; }
    try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return {
            modelId:        cfg.modelId   || '',
            endpoint:       cfg.endpoint  || '',
            provider:       cfg.provider  || 'anthropic',
            apiKey:         cfg.apiKey    || '',
            hasPlaintextKey: typeof cfg.apiKey === 'string' && cfg.apiKey.trim().length > 0,
        };
    } catch {
        return empty;
    }
}

export async function runSetupWizard(): Promise<void> {
    const [cli, saved] = await Promise.all([checkCli(), Promise.resolve(readSavedConfig())]);

    const panel = vscode.window.createWebviewPanel(
        'fuseraftSetup',
        'fuseraft setup',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    panel.webview.html = getSetupWebviewHtml(
        panel.webview,
        cli.found,
        cli.version,
        saved.hasPlaintextKey,
        saved.provider,
        saved.endpoint,
        saved.modelId,
        saved.apiKey
    );

    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.action === 'openInstallDocs') {
            vscode.env.openExternal(vscode.Uri.parse('https://github.com/fuseraft/fuseraft-cli#install'));
            return;
        }

        if (msg.action === 'openBinaryPathSetting') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'fuseraft.binaryPath');
            return;
        }

        if (msg.action === 'recheckCli') {
            invalidateCliCache();
            const newCli = await checkCli();
            const newSaved = readSavedConfig();
            panel.webview.html = getSetupWebviewHtml(
                panel.webview,
                newCli.found,
                newCli.version,
                newSaved.hasPlaintextKey,
                newSaved.provider,
                newSaved.endpoint,
                newSaved.modelId,
                newSaved.apiKey
            );
            return;
        }

        if (msg.action === 'migrateKey') {
            const { runInTerminal } = await import('./fuseraftUtils');
            const { getBinary } = await import('./fuseraftUtils');
            vscode.window.showInformationMessage(
                'Opening fuseraft repl to secure your API key. The key will be moved to your OS keychain automatically. Type exit and press Enter when done.',
                { modal: false }
            );
            runInTerminal(`${getBinary()} repl`, 'fuseraft — secure key');
            return;
        }

        const actualProvider = msg.provider === 'custom' ? 'openai' : msg.provider;

        if (msg.action === 'test') {
            const result = await testConnection(msg.modelId, msg.endpoint, actualProvider, msg.apiKey);
            panel.webview.postMessage({ type: 'testResult', result });
        } else if (msg.action === 'save') {
            writeUserConfig(msg.modelId, msg.endpoint, actualProvider, msg.apiKey);
            panel.dispose();
            const next = await vscode.window.showInformationMessage(
                `fuseraft configured with ${msg.modelId}. Next, create an orchestration config to define your agent team.`,
                'Create Config Now',
                'Do It Later'
            );
            if (next === 'Create Config Now') {
                vscode.commands.executeCommand('fuseraft.init');
            }
        }
    });
}

function getSetupWebviewHtml(
    webview: vscode.Webview,
    cliFound: boolean,
    cliVersion: string,
    hasPlaintextKey: boolean,
    curProv: string,
    curEnd: string,
    curMod: string,
    curKey: string
): string {
    const nonce = Math.random().toString(36).substring(2, 15);
    const providersJson = JSON.stringify(PROVIDERS);

    const cliRow = cliFound
        ? `<div class="preflight-row ok"><span class="pi">✅</span><span>fuseraft CLI detected${cliVersion ? ' — ' + escHtml(cliVersion) : ''}</span></div>`
        : `<div class="preflight-row error"><span class="pi">❌</span><span>fuseraft CLI not found on PATH.
            <a href="#" id="installLink">Install instructions</a> &nbsp;|&nbsp;
            <a href="#" id="binaryPathLink">Set binary path</a> &nbsp;|&nbsp;
            <a href="#" id="recheckCliLink">Check again</a>
           </span></div>`;

    const keychainRow = hasPlaintextKey
        ? `<div class="preflight-row warn"><span class="pi">⚠️</span><span>Your API key is stored in plaintext in <code>~/.fuseraft/config</code>.
            Run <code>fuseraft repl</code> once to migrate it to the OS keychain.</span></div>`
        : '';

    const preflightSection = `
    <div class="preflight">
        <div class="preflight-title">Pre-flight checklist</div>
        ${cliRow}
        ${keychainRow}
    </div>`;

    const disabledAttr = cliFound ? '' : 'disabled';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
    body {
        font-family: var(--vscode-font-family);
        padding: 20px;
        color: var(--vscode-foreground);
        max-width: 620px;
        margin: 0 auto;
    }
    h2 { margin-bottom: 16px; font-weight: 400; }

    /* ── Pre-flight ── */
    .preflight {
        border: 1px solid var(--vscode-panel-border, var(--vscode-input-border, #444));
        border-radius: 4px;
        padding: 12px 14px;
        margin-bottom: 24px;
        background: var(--vscode-editor-inactiveSelectionBackground, transparent);
    }
    .preflight-title {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 8px;
    }
    .preflight-row {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        font-size: 13px;
        margin-bottom: 6px;
        line-height: 1.5;
    }
    .preflight-row:last-child { margin-bottom: 0; }
    .preflight-row.error { color: var(--vscode-errorForeground, #f48771); }
    .preflight-row.warn  { color: var(--vscode-editorWarning-foreground, #cca700); }
    .preflight-row.ok    { color: var(--vscode-terminal-ansiGreen, #89d185); }
    .pi { flex-shrink: 0; }
    .preflight-row a {
        color: inherit;
        text-decoration: underline;
        cursor: pointer;
    }
    code {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.2));
        padding: 1px 4px;
        border-radius: 3px;
    }

    /* ── Form ── */
    .form-group { margin-bottom: 16px; }
    label {
        display: block;
        margin-bottom: 6px;
        font-weight: 600;
        font-size: 13px;
    }
    .description {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 6px;
    }
    select, input[type="text"], input[type="password"] {
        width: 100%;
        padding: 6px 8px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px;
        font-family: inherit;
        font-size: 13px;
        outline: none;
        box-sizing: border-box;
    }
    select:focus, input:focus {
        border-color: var(--vscode-focusBorder);
    }
    select:disabled, input:disabled { opacity: 0.5; cursor: not-allowed; }
    .actions {
        margin-top: 32px;
        display: flex;
        gap: 10px;
    }
    button {
        padding: 8px 14px;
        border: none;
        border-radius: 2px;
        cursor: pointer;
        font-family: inherit;
        font-size: 13px;
        font-weight: 500;
    }
    button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    #testResult {
        margin-top: 16px;
        padding: 10px;
        border-radius: 4px;
        display: none;
        font-size: 13px;
    }
    .success { background: #1b5e20; color: white; border-left: 4px solid #4caf50; }
    .error-result { background: #b71c1c; color: white; border-left: 4px solid #f44336; }
</style>
</head>
<body>
    <h2>fuseraft setup</h2>

    ${preflightSection}

    <div class="form-group">
        <label for="provider">AI Provider</label>
        <div class="description">Select the provider you want to use for agent orchestrations.</div>
        <select id="provider" ${disabledAttr}></select>
    </div>

    <div class="form-group" id="endpointGroup">
        <label for="endpoint">Endpoint URL</label>
        <div class="description">The base URL for the provider's API.</div>
        <input type="text" id="endpoint" placeholder="e.g. https://api.openai.com/v1" ${disabledAttr} />
    </div>

    <div class="form-group">
        <label for="model">Model ID</label>
        <div class="description">Select or type the model you wish to use.</div>
        <select id="modelSelect" ${disabledAttr}></select>
        <input type="text" id="modelInput" style="display: none; margin-top: 8px;" placeholder="Enter custom model ID" ${disabledAttr} />
    </div>

    <div class="form-group">
        <label for="apiKey">API Key</label>
        <div class="description">Paste your API key from your provider's dashboard.</div>
        <input type="password" id="apiKey" placeholder="Paste your API key here" value="${escHtml(curKey)}" ${disabledAttr} />
        ${hasPlaintextKey ? `<div style="margin-top:8px;">
            <button id="migrateKeyBtn" class="secondary" style="font-size:12px;padding:5px 10px;">Secure my API key</button>
            <span style="font-size:11px;color:var(--vscode-descriptionForeground);margin-left:8px;">Moves your key from this file into the OS keychain</span>
        </div>` : ''}
    </div>

    <div id="testResult"></div>

    <div class="actions">
        <button id="testBtn" class="secondary" ${disabledAttr}>Test Connection</button>
        <button id="saveBtn" class="primary" ${disabledAttr}>Save Configuration</button>
    </div>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const providers = ${providersJson};
    const cliFound = ${cliFound};

    const providerEl    = document.getElementById('provider');
    const endpointEl    = document.getElementById('endpoint');
    const modelSelectEl = document.getElementById('modelSelect');
    const modelInputEl  = document.getElementById('modelInput');
    const apiKeyEl      = document.getElementById('apiKey');
    const testBtn       = document.getElementById('testBtn');
    const saveBtn       = document.getElementById('saveBtn');
    const testResultEl  = document.getElementById('testResult');

    const curProv = ${JSON.stringify(curProv)};
    const curEnd  = ${JSON.stringify(curEnd)};
    const curMod  = ${JSON.stringify(curMod)};

    // Pre-flight link handlers
    const installLink = document.getElementById('installLink');
    if (installLink) {
        installLink.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({ action: 'openInstallDocs' });
        });
    }
    const binaryPathLink = document.getElementById('binaryPathLink');
    if (binaryPathLink) {
        binaryPathLink.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({ action: 'openBinaryPathSetting' });
        });
    }
    const recheckCliLink = document.getElementById('recheckCliLink');
    if (recheckCliLink) {
        recheckCliLink.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({ action: 'recheckCli' });
        });
    }
    const migrateKeyBtn = document.getElementById('migrateKeyBtn');
    if (migrateKeyBtn) {
        migrateKeyBtn.addEventListener('click', () => {
            vscode.postMessage({ action: 'migrateKey' });
        });
    }

    // Populate providers
    providers.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.provider;
        const cleanLabel = p.label.replace(/\\\$\\\(.*?\\\)\\\s*/g, '');
        opt.textContent = cleanLabel + ' (' + p.description + ')';
        providerEl.appendChild(opt);
    });

    if (curProv) {
        const matches = providers.some(x => x.provider === curProv);
        if (matches) { providerEl.value = curProv; }
    }

    function updateForm() {
        const p = providers.find(x => x.provider === providerEl.value) || providers[0];

        // Endpoint
        if (p.provider === 'custom') {
            endpointEl.value = curEnd || '';
            if (cliFound) { endpointEl.disabled = false; }
        } else {
            endpointEl.value = p.endpoint;
            endpointEl.disabled = true;
        }

        // Models
        modelSelectEl.innerHTML = '';
        if (p.models && p.models.length > 0) {
            p.models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = m;
                modelSelectEl.appendChild(opt);
            });
            const customOpt = document.createElement('option');
            customOpt.value = '__custom__';
            customOpt.textContent = 'Enter custom model...';
            modelSelectEl.appendChild(customOpt);

            modelSelectEl.style.display = 'block';

            if (p.models.includes(curMod)) {
                modelSelectEl.value = curMod;
                modelInputEl.style.display = 'none';
                modelInputEl.value = '';
            } else if (curMod && curMod.trim() !== '') {
                modelSelectEl.value = '__custom__';
                modelInputEl.style.display = 'block';
                modelInputEl.value = curMod;
            } else {
                modelSelectEl.value = p.models[0];
                modelInputEl.style.display = 'none';
            }
        } else {
            modelSelectEl.style.display = 'none';
            modelInputEl.style.display = 'block';
            modelInputEl.value = curMod || '';
        }
    }

    providerEl.addEventListener('change', updateForm);

    modelSelectEl.addEventListener('change', () => {
        if (modelSelectEl.value === '__custom__') {
            modelInputEl.style.display = 'block';
            if (cliFound) { modelInputEl.focus(); }
        } else {
            modelInputEl.style.display = 'none';
        }
    });

    updateForm();

    function getFormData() {
        const provider = providerEl.value;
        const endpoint = endpointEl.value.trim();
        let modelId = '';
        if (modelSelectEl.style.display !== 'none' && modelSelectEl.value !== '__custom__') {
            modelId = modelSelectEl.value;
        } else {
            modelId = modelInputEl.value.trim();
        }
        const apiKey = apiKeyEl.value.trim();
        return { provider, endpoint, modelId, apiKey };
    }

    testBtn.addEventListener('click', () => {
        const data = getFormData();
        if (!data.modelId) {
            showResult(false, 'Please specify a model ID');
            return;
        }
        if (data.provider === 'custom' && !data.endpoint) {
            showResult(false, 'Please specify a custom endpoint');
            return;
        }
        testBtn.disabled = true;
        testBtn.textContent = 'Testing…';
        testResultEl.style.display = 'none';
        vscode.postMessage({ action: 'test', ...data });
    });

    saveBtn.addEventListener('click', () => {
        const data = getFormData();
        if (!data.modelId) {
            showResult(false, 'Please specify a model ID before saving');
            return;
        }
        vscode.postMessage({ action: 'save', ...data });
    });

    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'testResult') {
            testBtn.disabled = false;
            testBtn.textContent = 'Test Connection';
            showResult(
                message.result.ok,
                (message.result.ok ? 'Connection successful — ' : 'Connection failed — ') + message.result.message
            );
        }
    });

    function showResult(isOk, text) {
        testResultEl.textContent = text;
        testResultEl.style.display = 'block';
        testResultEl.className = isOk ? 'success' : 'error-result';
    }
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
