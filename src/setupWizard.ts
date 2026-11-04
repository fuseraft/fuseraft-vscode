import * as vscode from 'vscode';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { checkCli, invalidateCliCache, runInstaller, runUpdate, pollForInstalledBinary, storeApiKeyToCliKeychain, getApiKeyFromCliKeychain, fetchProviderModels, listProviderModels, describeRequestError, cliHasScopedKeys, getFuseraftHome, parseProviderSection, writeProviderConfigViaCli } from './fuseraftUtils';

/** Re-resolved on every call (not cached) so it reflects live changes to fuseraft.homeDir. */
function getConfigDir(): string { return getFuseraftHome(); }
function getConfigPath(): string { return path.join(getConfigDir(), 'config'); }

interface ProviderDef {
    label: string;
    description: string;
    provider: string;
    endpoint: string;
    models: string[];
    /** Where to create an API key; opened from "Get a key". */
    keyUrl?: string;
}

const PROVIDERS: ProviderDef[] = [
    {
        label: 'Anthropic',
        description: 'Claude',
        keyUrl: 'https://console.anthropic.com/settings/keys',
        provider: 'anthropic',
        endpoint: 'https://api.anthropic.com',
        models: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
    },
    {
        label: 'OpenAI',
        description: 'GPT',
        keyUrl: 'https://platform.openai.com/api-keys',
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1',
        models: ['gpt-4o', 'gpt-4o-mini'],
    },
    {
        label: 'xAI',
        description: 'Grok',
        keyUrl: 'https://console.x.ai',
        provider: 'xai',
        endpoint: 'https://api.x.ai/v1',
        models: ['grok-4', 'grok-4-1-fast-reasoning'],
    },
    {
        label: 'Google',
        description: 'Gemini',
        keyUrl: 'https://aistudio.google.com/apikey',
        provider: 'google',
        endpoint: 'https://generativelanguage.googleapis.com',
        models: ['gemini-2.5-flash', 'gemini-2.0-flash'],
    },
    {
        label: 'Mistral',
        description: 'Mistral, Codestral',
        keyUrl: 'https://console.mistral.ai/api-keys',
        provider: 'mistral',
        endpoint: 'https://api.mistral.ai/v1',
        models: ['mistral-medium-latest', 'mistral-large-latest'],
    },
    {
        label: 'DeepSeek',
        description: 'Chat, reasoner',
        keyUrl: 'https://platform.deepseek.com/api_keys',
        provider: 'deepseek',
        endpoint: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat'],
    },
    {
        label: 'Ollama',
        description: 'Local, no key',
        provider: 'ollama',
        endpoint: 'http://localhost:11434/v1',
        models: ['llama3.2', 'phi4', 'mistral', 'gemma3', 'qwen2.5-coder'],
    },
    {
        label: 'Custom',
        description: 'OpenAI-compatible',
        provider: 'custom',
        endpoint: '',
        models: [],
    },
];

export function isConfigured(): boolean {
    if (!fs.existsSync(getConfigPath())) { return false; }
    try {
        const cfg = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
        return parseProviderSection(cfg).modelId.length > 0;
    } catch {
        return false;
    }
}

/**
 * Canonical base endpoints for each named provider.
 * When we save "Custom / Self-hosted" we write provider='openai' for CLI
 * compatibility, but we also store the custom URL.  On the way back out we
 * detect that the saved endpoint doesn't match the canonical OpenAI URL and
 * restore the UI selection to 'custom' so the field is editable again.
 */
const CANONICAL_ENDPOINTS: Record<string, string> = {
    openai:   'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com',
    xai:       'https://api.x.ai/v1',
    google:    'https://generativelanguage.googleapis.com',
    mistral:   'https://api.mistral.ai/v1',
    deepseek:  'https://api.deepseek.com/v1',
};

/** Read the plaintext API key from the config file without throwing (sync). */
function readPlaintextKey(): string {
    if (!fs.existsSync(getConfigPath())) { return ''; }
    try {
        const cfg = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
        return typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
    } catch { return ''; }
}

/** Read fields from an existing config file, including keychain key status. */
async function readSavedConfig(): Promise<{ modelId: string; endpoint: string; provider: string; apiKey: string; hasPlaintextKey: boolean; hasKeychainKey: boolean }> {
    const empty = { modelId: '', endpoint: '', provider: 'anthropic', apiKey: '', hasPlaintextKey: false, hasKeychainKey: false };
    if (!fs.existsSync(getConfigPath())) { return empty; }
    try {
        const cfg = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
        const parsed = parseProviderSection(cfg);
        let provider = parsed.provider || 'anthropic';
        const savedEndpoint: string = parsed.endpoint;

        // When the user chose "Custom / Self-hosted" we convert the UI value
        // 'custom' → 'openai' before writing (so the CLI recognises the protocol),
        // but the custom base URL is preserved.  Detect that round-trip here by
        // checking whether the saved endpoint differs from the canonical URL for
        // the recorded provider.  If it does, restore 'custom' for the UI.
        if (
            savedEndpoint &&
            provider in CANONICAL_ENDPOINTS &&
            savedEndpoint.toLowerCase().replace(/\/$/, '') !==
                CANONICAL_ENDPOINTS[provider].toLowerCase().replace(/\/$/, '')
        ) {
            // Restore 'ollama' when the saved endpoint matches the Ollama default,
            // otherwise fall back to 'custom'.
            provider = savedEndpoint.toLowerCase().replace(/\/$/, '') === 'http://localhost:11434/v1'
                ? 'ollama'
                : 'custom';
        }

        const hasPlaintextKey = typeof cfg.apiKey === 'string' && cfg.apiKey.trim().length > 0;
        // Only check the CLI keychain when there's no plaintext key — avoids a
        // CLI round-trip for users who haven't migrated yet.
        const hasKeychainKey = !hasPlaintextKey
            ? (await getApiKeyFromCliKeychain()).length > 0
            : false;

        return {
            modelId:         parsed.modelId,
            endpoint:        savedEndpoint,
            provider,
            apiKey:          cfg.apiKey  || '',   // only the plaintext key; keychain key is not exposed
            hasPlaintextKey,
            hasKeychainKey,
        };
    } catch {
        return empty;
    }
}

/** Singleton panel — reuse if already open. */
let _setupPanel: vscode.WebviewPanel | undefined;

export async function runSetupWizard(extensionUri: vscode.Uri): Promise<void> {
    // If the panel is already open, just bring it to the front.
    if (_setupPanel) {
        _setupPanel.reveal();
        return;
    }

    // Run the CLI check and config read in parallel before building the UI.
    const [cli, saved] = await Promise.all([checkCli(), readSavedConfig()]);
    let scopedKeys = cli.found && await cliHasScopedKeys();

    // Try to pre-fetch the model list from the configured provider.
    let liveModels: string[] | null = null;
    let liveFor = saved.provider;
    // A saved key belongs to one server; never send it to another. A CLI that keeps a key per
    // endpoint answers for any server; an older one holds only the saved provider's.
    let savedProvider = saved.provider;
    const keyFor = async (provider: string, endpoint: string, typed: string) =>
        typed || (scopedKeys ? (endpoint ? await getApiKeyFromCliKeychain(endpoint) : '')
                             : provider === savedProvider ? await getApiKeyFromCliKeychain() : '');
    if (saved.endpoint) {
        const apiKey = saved.apiKey || await getApiKeyFromCliKeychain();
        liveModels = await fetchProviderModels(saved.endpoint, apiKey, saved.provider);
    }

    const panel = vscode.window.createWebviewPanel(
        'fuseraftSetup',
        'fuseraft setup',
        vscode.ViewColumn.One,
        { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] }
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');

    _setupPanel = panel;
    let cancelPoll: (() => void) | undefined;
    panel.onDidDispose(() => {
        _setupPanel = undefined;
        cancelPoll?.();
        cancelPoll = undefined;
    });

    const render = (c: { found: boolean; version: string }, sv: typeof saved) => {
        panel.webview.html = getSetupWebviewHtml(
            panel.webview, extensionUri, c.found, c.version,
            sv.hasPlaintextKey, sv.hasKeychainKey,
            sv.provider, sv.endpoint, sv.modelId, sv.apiKey,
            liveFor === sv.provider ? liveModels : null, scopedKeys
        );
    };
    const rerender = async () => {
        const [c, sv] = await Promise.all([checkCli(), readSavedConfig()]);
        scopedKeys = c.found && await cliHasScopedKeys();
        savedProvider = sv.provider;
        render(c, sv);
    };
    render(cli, saved);

    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.action === 'checkKey') {
            // Only whether a key exists goes to the webview, never the key.
            const has = scopedKeys && !!msg.endpoint && (await getApiKeyFromCliKeychain(msg.endpoint)).length > 0;
            panel.webview.postMessage({ type: 'keyStatus', endpoint: msg.endpoint, saved: has });
            return;
        }

        if (msg.action === 'openKeyPage') {
            const url = PROVIDERS.find(p => p.provider === msg.provider)?.keyUrl;
            if (url) { vscode.env.openExternal(vscode.Uri.parse(url)); }
            return;
        }

        if (msg.action === 'openInstallDocs') {
            vscode.env.openExternal(vscode.Uri.parse('https://github.com/fuseraft/fuseraft-cli#install'));
            return;
        }

        if (msg.action === 'openBinaryPathSetting') {
            await vscode.commands.executeCommand('fuseraft.setBinaryPath');
            invalidateCliCache();
            await rerender();
            return;
        }

        if (msg.action === 'recheckCli') {
            invalidateCliCache();
            await rerender();
            return;
        }

        if (msg.action === 'fetchModels') {
            const apiKey = await keyFor(msg.provider, msg.endpoint, msg.apiKey);
            const models = await fetchProviderModels(msg.endpoint as string, apiKey, msg.provider as string);
            if (models) { liveModels = models; liveFor = msg.provider; }
            panel.webview.postMessage({ type: 'modelsLoaded', models: models ?? [] });
            return;
        }

        if (msg.action === 'runInstaller') {
            cancelPoll?.();  // cancel any previous poll
            runInstaller();
            // Tell the webview the installer is running so it can update its UI
            panel.webview.postMessage({ type: 'installerLaunched' });

            // Auto-detect the binary once it lands on disk, then update
            // settings and rebuild the panel — no manual steps needed.
            cancelPoll = pollForInstalledBinary(async (resolvedPath, wasOnPath) => {
                cancelPoll = undefined;
                if (!_setupPanel) { return; }  // panel was closed — nothing to do

                // If found at a known FS location that isn't already on PATH,
                // write it into the binaryPath setting so the extension can use it.
                if (!wasOnPath) {
                    await vscode.workspace.getConfiguration('fuseraft').update(
                        'binaryPath', resolvedPath, vscode.ConfigurationTarget.Global
                    );
                }

                invalidateCliCache();
                await rerender();
            });
            return;
        }

        if (msg.action === 'runUpdate') {
            runUpdate();
            // Tell the webview the updater is running so it can update its UI
            panel.webview.postMessage({ type: 'updaterLaunched' });
            return;
        }

        if (msg.action === 'migrateKey') {
            // Migrate the plaintext key directly to the OS keychain without opening a terminal.
            const plaintextKey = readPlaintextKey();
            if (plaintextKey) {
                const stored = await storeApiKeyToCliKeychain(plaintextKey);
                if (stored) {
                    try {
                        const raw = fs.readFileSync(getConfigPath(), 'utf8');
                        const cfg = JSON.parse(raw);
                        delete cfg.apiKey;
                        fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), 'utf8');
                    } catch { /* ignore — worst case the plaintext key lingers */ }
                }
            }
            // Refresh the wizard to reflect the new keychain status.
            await rerender();
            return;
        }

        const actualProvider = (msg.provider === 'custom' || msg.provider === 'ollama') ? 'openai' : msg.provider;

        if (msg.action === 'test') {
            // As with loading models: a blank key field means the saved key, for its own provider only.
            const apiKey = await keyFor(msg.provider, msg.endpoint, msg.apiKey);
            if (!msg.modelId) {
                const result = await testByListingModels(msg.endpoint, actualProvider, apiKey);
                if (result.models) {
                    liveModels = result.models;
                    liveFor = msg.provider;
                    panel.webview.postMessage({ type: 'modelsLoaded', models: result.models });
                }
                panel.webview.postMessage({ type: 'testResult', result: { ok: result.ok, message: result.message } });
                return;
            }
            const result = await testConnection(msg.modelId, msg.endpoint, actualProvider, apiKey);
            panel.webview.postMessage({ type: 'testResult', result });
        } else if (msg.action === 'save') {
            try {
                await writeUserConfig(msg.modelId, msg.endpoint, actualProvider, msg.apiKey);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                panel.webview.postMessage({ type: 'saveError', message });
                return;
            }
            panel.dispose();
            const next = await vscode.window.showInformationMessage(
                `fuseraft configured with ${msg.modelId}.`,
                'Start a Chat'
            );
            if (next === 'Start a Chat') {
                vscode.commands.executeCommand('fuseraft.replNew');
            }
        }
    });
}

function getSetupWebviewHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    cliFound: boolean,
    cliVersion: string,
    hasPlaintextKey: boolean,
    hasKeychainKey: boolean,
    curProv: string,
    curEnd: string,
    curMod: string,
    curKey: string,
    liveModels: string[] | null = null,
    scopedKeys = false
): string {
    const nonce = Math.random().toString(36).substring(2, 15);
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
    // When live models were fetched for the current provider, inject them into
    // that provider's entry so the select is populated with the real list.
    const providers = (liveModels && liveModels.length > 0)
        ? PROVIDERS.map(p => p.provider === curProv ? { ...p, models: liveModels } : p)
        : PROVIDERS;
    const init = {
        providers, cliFound, hasPlaintextKey, hasKeychainKey,
        curProv, curEnd, curMod, curKey, scopedKeys,
        liveModelCount: liveModels ? liveModels.length : 0,
    };
    // Inside a <script> block, "</script>" in a value (an endpoint, say) would end it.
    const initJson = JSON.stringify(init).replace(/</g, '\\u003c');

    // `fuseraft --version` prints "fuseraft 1.16.0+<commit>"; the number is enough here.
    const shortVersion = cliVersion.replace(/^fuseraft\s+/i, '').replace(/\+.*$/, '');
    const cliStep = cliFound
        ? `<div class="cli-status">
            <span class="dot"></span>
            <span>fuseraft CLI is installed${shortVersion ? ` <span class="cli-version">${escHtml(shortVersion)}</span>` : ''}</span>
            <span class="links">
                <a href="#" id="updateLink">Update</a>
                <a href="#" id="binaryPathLink">Change path</a>
                <a href="#" id="recheckLink">Check again</a>
            </span>
           </div>`
        : `<div class="cli-missing">
            <div class="cli-status"><span class="dot bad"></span><span>The fuseraft CLI isn't installed, or isn't on your PATH.</span></div>
            <div class="hint">The extension runs your chats through it. Installing takes a few seconds.</div>
            <div class="step-content"><button id="installBtn" class="primary">Install the CLI</button></div>
            <div class="links">
                <a href="#" id="installDocsLink">Install it yourself</a>
                <a href="#" id="binaryPathLink">Set the path to it</a>
                <a href="#" id="recheckLink">Check again</a>
            </div>
           </div>`;

    const refreshIcon = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.45 5.17A6 6 0 1 0 14 8h-1.5a4.5 4.5 0 1 1-.5-2.06L10 6v1.5h4.5V3L13 4.5z"/></svg>`;

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${media('setup.css')}">
</head>
<body>
<main class="${cliFound ? '' : 'locked'}">
    <header>
        ${fuseraftMarkSvg('icon-mark', 'fr-mark-setup')}
        <div>
            <h1>Set up fuseraft</h1>
            <p>${curMod ? 'Change the model your chats use.' : 'Connect a model to start chatting. It takes about a minute.'}</p>
        </div>
    </header>

    <section class="step ${cliFound ? 'done' : 'attention'}" id="step-cli">
        <div class="num"><span>1</span></div>
        <div class="step-body">
            <h2>fuseraft CLI</h2>
            <div class="step-content">${cliStep}</div>
            <div class="progress" id="cliProgress" hidden><span class="spinner"></span><span class="text"></span></div>
        </div>
    </section>

    <section class="step" id="step-provider">
        <div class="num"><span>2</span></div>
        <div class="step-body">
            <h2>Provider</h2>
            <div class="hint">Where your chats send requests. You can switch models per chat later.</div>
            <div class="step-content">
                <div class="tiles" id="tiles" role="radiogroup" aria-label="Provider"></div>
                <div class="endpoint-line" id="endpointLine">Endpoint <code></code></div>
                <div class="field" id="endpointField" hidden>
                    <label class="field-label" for="endpoint">Endpoint URL</label>
                    <input type="text" id="endpoint" placeholder="https://my-server.example.com/v1" spellcheck="false" />
                    <div class="hint">The base URL of an OpenAI-compatible API, usually ending in <code>/v1</code>.</div>
                </div>
            </div>
        </div>
    </section>

    <section class="step" id="step-key">
        <div class="num"><span>3</span></div>
        <div class="step-body">
            <div class="step-head"><h2>API key</h2><a href="#" id="keyUrlLink">Get a key</a></div>
            <div class="hint" id="keyHint" hidden>Optional. Leave it blank if your server doesn't need one.</div>
            <div class="step-content">
                <div id="keyField">
                    <div class="row">
                        <input type="password" id="apiKey" autocomplete="off" spellcheck="false" aria-label="API key" />
                        <button type="button" class="secondary" id="showKeyBtn">Show</button>
                    </div>
                    <div class="status" id="keyStatus">
                        <span class="text"></span>
                        <a href="#" id="secureKeyLink" data-for hidden>Move it to the keychain</a>
                    </div>
                </div>
                <div class="note" id="keyNote" hidden>Ollama runs on your machine, so no API key is needed.</div>
            </div>
        </div>
    </section>

    <section class="step" id="step-model">
        <div class="num"><span>4</span></div>
        <div class="step-body">
            <h2>Model</h2>
            <div class="step-content">
                <div class="row">
                    <select id="modelSelect" aria-label="Model"></select>
                    <button type="button" class="icon" id="refreshModelsBtn" title="Load models from the provider" aria-label="Load models from the provider">${refreshIcon}</button>
                </div>
                <input type="text" id="modelInput" placeholder="Model ID, e.g. llama3.2" spellcheck="false" aria-label="Model ID" />
                <div class="status" id="modelStatus"><span class="text"></span></div>
            </div>
        </div>
    </section>

    <div id="result" role="status" hidden></div>
</main>

<footer>
    <div class="inner">
        <span class="summary" id="summary"></span>
        <button id="testBtn" class="secondary" ${cliFound ? '' : 'disabled'}>Test connection</button>
        <button id="saveBtn" class="primary" disabled>Save</button>
    </div>
</footer>

<script id="init" type="application/json">${initJson}</script>
<script nonce="${nonce}" src="${media('setup.js')}"></script>
</body>
</html>`;
}

/** Simple HTML entity escaping for injecting strings into HTML attributes. */
function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline fuseraft brand mark (matches media/icon-source.svg) for use next to the wordmark in webview content. */
function fuseraftMarkSvg(className: string, gradId: string): string {
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

async function writeUserConfig(modelId: string, endpoint: string, provider: string, apiKey: string): Promise<void> {
    // Delegates to `fuseraft settings set` (see writeProviderConfigViaCli) rather than
    // writing the file directly — a direct write here used to overwrite the whole file
    // with just {modelId, endpoint, provider}, silently destroying every other section
    // (sampling, repl, mcpServers, telemetry, skillCuration) once those existed.
    const saved = await writeProviderConfigViaCli(modelId, endpoint, provider);
    if (!saved) {
        throw new Error('Failed to save provider settings via the fuseraft CLI (`fuseraft settings set`). Make sure the CLI is installed and up to date, then try again.');
    }
    if (apiKey) {
        const stored = await storeApiKeyToCliKeychain(apiKey);
        if (!stored) {
            throw new Error('Failed to store the API key in the OS keychain. Your key was not saved.');
        }
    }
}

/** With no model chosen yet, listing the provider's models shows the endpoint and key work, and offers the models to pick from. */
async function testByListingModels(
    endpoint: string,
    provider: string,
    apiKey: string,
): Promise<{ ok: boolean; message: string; models?: string[] }> {
    const result = await listProviderModels(endpoint, apiKey, provider, 10_000);
    if ('models' in result) {
        return result.models.length > 0
            ? { ok: true, message: `${result.models.length} models available. Pick one above.`, models: result.models }
            : { ok: true, message: 'the provider listed no models. Enter a model ID above.' };
    }
    // Some OpenAI-compatible servers only serve chat completions.
    if (result.status === 404 || result.status === 405) {
        return { ok: false, message: "this endpoint doesn't list its models. Enter a model ID and test again." };
    }
    return { ok: false, message: result.error };
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
        return { ok: false, message: describeRequestError(e, endpoint) };
    }
}

function httpPost(url: string, headers: Record<string, string>, body: object): Promise<{ status: number; data: string }> {
    return new Promise((resolve, reject) => {
        const bodyStr  = JSON.stringify(body);
        const parsed   = new URL(url);
        const isHttps  = parsed.protocol === 'https:';
        const transport = isHttps ? https : http;
        const req = transport.request(
            {
                hostname: parsed.hostname,
                port:     parsed.port || (isHttps ? 443 : 80),
                path:     parsed.pathname + parsed.search,
                method:   'POST',
                headers:  {
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(bodyStr),
                    ...headers,
                },
            },
            (res: http.IncomingMessage) => {
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
    const base    = endpoint.replace(/\/$/, '');
    const headers: Record<string, string> = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};
    const resp = await httpPost(
        `${base}/chat/completions`,
        headers,
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
