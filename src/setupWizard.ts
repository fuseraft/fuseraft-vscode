import * as vscode from 'vscode';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

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

export async function runSetupWizard(): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
        'fuseraftSetup',
        'fuseraft setup',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    let currentModel = '';
    let currentEndpoint = '';
    let currentProvider = 'anthropic';
    let currentApiKey = '';

    if (fs.existsSync(CONFIG_PATH)) {
        try {
            const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            currentModel = cfg.modelId || '';
            currentEndpoint = cfg.endpoint || '';
            currentProvider = cfg.provider || 'anthropic';
            currentApiKey = cfg.apiKey || '';
        } catch {}
    }

    panel.webview.html = getSetupWebviewHtml(panel.webview, currentProvider, currentEndpoint, currentModel, currentApiKey);

    panel.webview.onDidReceiveMessage(async (msg) => {
        const actualProvider = msg.provider === 'custom' ? 'openai' : msg.provider;

        if (msg.action === 'test') {
            const result = await testConnection(msg.modelId, msg.endpoint, actualProvider, msg.apiKey);
            panel.webview.postMessage({ type: 'testResult', result });
        } else if (msg.action === 'save') {
            writeUserConfig(msg.modelId, msg.endpoint, actualProvider, msg.apiKey);
            vscode.window.showInformationMessage(
                `fuseraft configured with ${msg.modelId}. Run fuseraft repl once to migrate your API key to the OS keychain.`
            );
            panel.dispose();
        }
    });
}

function getSetupWebviewHtml(webview: vscode.Webview, curProv: string, curEnd: string, curMod: string, curKey: string): string {
    const nonce = Math.random().toString(36).substring(2, 15);
    const providersJson = JSON.stringify(PROVIDERS);
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
    body {
        font-family: var(--vscode-font-family);
        padding: 20px;
        color: var(--vscode-foreground);
        max-width: 600px;
        margin: 0 auto;
    }
    h2 { margin-bottom: 24px; font-weight: 400; }
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
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    
    #testResult {
        margin-top: 16px;
        padding: 10px;
        border-radius: 4px;
        display: none;
        font-size: 13px;
    }
    .success { background: #1b5e20; color: white; border-left: 4px solid #4caf50; }
    .error { background: #b71c1c; color: white; border-left: 4px solid #f44336; }
</style>
</head>
<body>
    <h2>fuseraft setup</h2>
    
    <div class="form-group">
        <label for="provider">AI Provider</label>
        <div class="description">Select the provider you want to use for agent orchestrations.</div>
        <select id="provider"></select>
    </div>
    
    <div class="form-group" id="endpointGroup">
        <label for="endpoint">Endpoint URL</label>
        <div class="description">The base URL for the provider's API.</div>
        <input type="text" id="endpoint" placeholder="e.g. https://api.openai.com/v1" />
    </div>
    
    <div class="form-group">
        <label for="model">Model ID</label>
        <div class="description">Select or type the model you wish to use.</div>
        <select id="modelSelect"></select>
        <input type="text" id="modelInput" style="display: none; margin-top: 8px;" placeholder="Enter custom model ID" />
    </div>
    
    <div class="form-group">
        <label for="apiKey">API Key</label>
        <div class="description">Stored temporarily in ~/.fuseraft/config; migrated to OS keychain on first run.</div>
        <input type="password" id="apiKey" placeholder="Paste your API key here" value="${curKey}" />
    </div>
    
    <div id="testResult"></div>
    
    <div class="actions">
        <button id="testBtn" class="secondary">Test Connection</button>
        <button id="saveBtn" class="primary">Save Configuration</button>
    </div>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const providers = ${providersJson};
    
    const providerEl = document.getElementById('provider');
    const endpointEl = document.getElementById('endpoint');
    const modelSelectEl = document.getElementById('modelSelect');
    const modelInputEl = document.getElementById('modelInput');
    const apiKeyEl = document.getElementById('apiKey');
    
    const testBtn = document.getElementById('testBtn');
    const saveBtn = document.getElementById('saveBtn');
    const testResultEl = document.getElementById('testResult');
    
    const curProv = "${curProv}";
    const curEnd = "${curEnd}";
    const curMod = "${curMod}";
    
    // Populate providers
    providers.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.provider;
        
        // Remove markdown icons for clean label
        const cleanLabel = p.label.replace(/\\$\\(.*?\\)\\s*/g, '');
        opt.textContent = cleanLabel + ' (' + p.description + ')';
        providerEl.appendChild(opt);
    });
    
    if (curProv) {
        // Handle case where saved provider is 'openai' but user was previously on 'custom'
        // If we don't know for sure, let's just set the exact match if it exists.
        const matches = providers.some(x => x.provider === curProv);
        if (matches) providerEl.value = curProv;
    }
    
    function updateForm() {
        const p = providers.find(x => x.provider === providerEl.value) || providers[0];
        
        // Endpoint
        if (p.provider === 'custom') {
            endpointEl.value = curEnd || '';
            endpointEl.disabled = false;
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
    
    providerEl.addEventListener('change', () => {
        // Don't carry over endpoint unless custom
        updateForm();
    });
    
    modelSelectEl.addEventListener('change', () => {
        if (modelSelectEl.value === '__custom__') {
            modelInputEl.style.display = 'block';
            modelInputEl.focus();
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
        testBtn.textContent = 'Testing...';
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
            showResult(message.result.ok, (message.result.ok ? 'Connection successful — ' : 'Connection failed — ') + message.result.message);
        }
    });
    
    function showResult(isOk, text) {
        testResultEl.textContent = text;
        testResultEl.style.display = 'block';
        testResultEl.className = isOk ? 'success' : 'error';
    }
</script>
</body>
</html>`;
}

function writeUserConfig(modelId: string, endpoint: string, provider: string, apiKey: string): void {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const onDisk: Record<string, string> = { modelId, endpoint, provider };
    if (apiKey) { onDisk['apiKey'] = apiKey; } // legacy field — CLI migrates to OS keychain on next run
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
