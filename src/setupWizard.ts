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

export async function isConfigured(): Promise<boolean> {
    // Check model configuration
    if (!fs.existsSync(CONFIG_PATH)) { return false; }
    try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        if (typeof cfg.modelId !== 'string' || cfg.modelId.trim().length === 0) {
            return false;
        }
    } catch {
        return false;
    }
    
    // Check binary path validity
    const binaryPath = vscode.workspace.getConfiguration('fuseraft').get<string>('binaryPath', 'fuseraft');
    const validation = await validateBinaryPath(binaryPath);
    return validation.valid;
}

export async function runSetupWizard(): Promise<void> {
    // Step 1: Binary Path
    const currentBinaryPath = vscode.workspace.getConfiguration('fuseraft').get<string>('binaryPath', 'fuseraft');
    const validation = await validateBinaryPath(currentBinaryPath);
    
    let binaryPath = currentBinaryPath;
    if (!validation.valid) {
        const binaryAction = await vscode.window.showQuickPick(
            [
                { label: '$(folder-opened) Browse for binary…', action: 'browse' },
                { label: '$(edit) Enter path manually…', action: 'manual' },
                { label: '$(arrow-right) Skip (use current: ' + currentBinaryPath + ')', action: 'skip' },
            ],
            {
                title: 'fuseraft setup  (1 / 4)  — Binary Path',
                placeHolder: `Current binary path is invalid: ${validation.error}`,
            }
        );
        
        if (!binaryAction || binaryAction.action === 'skip') {
            binaryPath = currentBinaryPath;
        } else if (binaryAction.action === 'browse') {
            const uris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                canSelectFiles: true,
                canSelectFolders: false,
                title: 'Select fuseraft binary',
                openLabel: 'Select Binary',
            });
            if (uris && uris[0]) {
                binaryPath = uris[0].fsPath;
                const newValidation = await validateBinaryPath(binaryPath);
                if (!newValidation.valid) {
                    vscode.window.showWarningMessage(`Selected binary is not valid: ${newValidation.error}`);
                    return;
                }
                await vscode.workspace.getConfiguration('fuseraft').update('binaryPath', binaryPath, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Binary path updated: ${binaryPath} (version ${newValidation.version})`);
            } else {
                return;
            }
        } else if (binaryAction.action === 'manual') {
            const manualPath = await vscode.window.showInputBox({
                title: 'fuseraft binary path',
                prompt: 'Enter absolute or relative path to fuseraft binary',
                value: currentBinaryPath,
                ignoreFocusOut: true,
            });
            if (manualPath === undefined) { return; }
            binaryPath = manualPath.trim();
            const newValidation = await validateBinaryPath(binaryPath);
            if (!newValidation.valid) {
                vscode.window.showWarningMessage(`Entered binary path is not valid: ${newValidation.error}`);
                return;
            }
            await vscode.workspace.getConfiguration('fuseraft').update('binaryPath', binaryPath, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Binary path updated: ${binaryPath} (version ${newValidation.version})`);
        }
    } else {
        const skipBinary = await vscode.window.showQuickPick(
            [
                { label: `$(check) Use current binary: ${currentBinaryPath}`, description: `version ${validation.version}`, action: 'continue' },
                { label: '$(edit) Change binary path…', action: 'change' },
            ],
            {
                title: 'fuseraft setup  (1 / 4)  — Binary Path',
                placeHolder: 'Binary path is valid',
            }
        );
        
        if (!skipBinary || skipBinary.action === 'continue') {
            // Continue with current binary
        } else {
            const changeAction = await vscode.window.showQuickPick(
                [
                    { label: '$(folder-opened) Browse for binary…', action: 'browse' },
                    { label: '$(edit) Enter path manually…', action: 'manual' },
                ],
                {
                    title: 'fuseraft setup  — Change Binary Path',
                    placeHolder: 'Select how to configure binary path',
                }
            );
            
            if (!changeAction) { return; }
            
            if (changeAction.action === 'browse') {
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    canSelectFiles: true,
                    canSelectFolders: false,
                    title: 'Select fuseraft binary',
                    openLabel: 'Select Binary',
                });
                if (uris && uris[0]) {
                    binaryPath = uris[0].fsPath;
                    const newValidation = await validateBinaryPath(binaryPath);
                    if (!newValidation.valid) {
                        vscode.window.showWarningMessage(`Selected binary is not valid: ${newValidation.error}`);
                        return;
                    }
                    await vscode.workspace.getConfiguration('fuseraft').update('binaryPath', binaryPath, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(`Binary path updated: ${binaryPath} (version ${newValidation.version})`);
                } else {
                    return;
                }
            } else {
                const manualPath = await vscode.window.showInputBox({
                    title: 'fuseraft binary path',
                    prompt: 'Enter absolute or relative path to fuseraft binary',
                    value: currentBinaryPath,
                    ignoreFocusOut: true,
                });
                if (manualPath === undefined) { return; }
                binaryPath = manualPath.trim();
                const newValidation = await validateBinaryPath(binaryPath);
                if (!newValidation.valid) {
                    vscode.window.showWarningMessage(`Entered binary path is not valid: ${newValidation.error}`);
                    return;
                }
                await vscode.workspace.getConfiguration('fuseraft').update('binaryPath', binaryPath, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Binary path updated: ${binaryPath} (version ${newValidation.version})`);
            }
        }
    }

    // Step 2: Provider
    const providerPick = await vscode.window.showQuickPick(
        PROVIDERS.map(p => ({ ...p })),
        {
            title: 'fuseraft setup  (2 / 4)  — Provider',
            placeHolder: 'Select your AI provider',
            matchOnDescription: true,
        }
    );
    if (!providerPick) { return; }

    let { endpoint, provider } = providerPick;

    if (provider === 'custom') {
        const customEndpoint = await vscode.window.showInputBox({
            title: 'fuseraft setup  — Custom Endpoint',
            prompt: 'Enter your provider endpoint URL',
            placeHolder: 'e.g. https://chat.mycompany.com/openai/v1',
            ignoreFocusOut: true,
        });
        if (customEndpoint === undefined) { return; }
        endpoint = customEndpoint.trim();
        provider = 'openai'; // treat custom as openai-compatible
    }

    // Step 2: Model
    const modelItems = [
        ...providerPick.models.map(m => ({ label: m, modelId: m })),
        { label: '$(edit) Enter model ID…', modelId: '' },
    ];

    const modelPick = await vscode.window.showQuickPick(modelItems, {
        title: 'fuseraft setup  (3 / 4)  — Model',
        placeHolder: 'Select a model',
    });
    if (!modelPick) { return; }

    let modelId = modelPick.modelId;
    if (!modelId) {
        const custom = await vscode.window.showInputBox({
            title: 'Model ID',
            placeHolder: 'e.g. claude-sonnet-4-6',
            ignoreFocusOut: true,
        });
        if (custom === undefined) { return; }
        modelId = custom.trim();
    }

    // Step 4: API key
    const apiKey = await vscode.window.showInputBox({
        title: 'fuseraft setup  (4 / 4)  — API Key',
        prompt: 'Stored temporarily in ~/.fuseraft/config; migrated to your OS keychain on the next fuseraft repl run.',
        placeHolder: 'Paste your API key here',
        password: true,
        ignoreFocusOut: true,
    });
    if (apiKey === undefined) { return; }

    // Final step: test or save (validate binary before testing connection)
    const summary = `${modelId}  ·  ${endpoint || '(default endpoint)'}`;
    let keepGoing = true;
    while (keepGoing) {
        const action = await vscode.window.showQuickPick(
            [
                { label: '$(check) Test Connection', description: 'Verify API key against the provider', action: 'test' },
                { label: '$(save) Save Configuration', description: summary, action: 'save' },
                { label: '$(close) Cancel', description: '', action: 'cancel' },
            ],
            {
                title: `fuseraft setup — ${summary}`,
                placeHolder: 'Test your connection or save',
            }
        );

        if (!action || action.action === 'cancel') { return; }

        if (action.action === 'test') {
            // Validate binary first
            const binValidation = await validateBinaryPath(binaryPath);
            if (!binValidation.valid) {
                vscode.window.showErrorMessage(`Cannot test connection: binary path is invalid (${binValidation.error})`);
                continue;
            }
            
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Testing connection…', cancellable: false },
                async () => {
                    const result = await testConnection(modelId, endpoint, provider, apiKey);
                    if (result.ok) {
                        vscode.window.showInformationMessage(`$(check) Connection successful — ${result.message}`);
                    } else {
                        vscode.window.showWarningMessage(`$(warning) Connection failed — ${result.message}`);
                    }
                }
            );
        } else {
            writeUserConfig(modelId, endpoint, provider, apiKey);
            vscode.window.showInformationMessage(
                `fuseraft configured with ${modelId}. Run fuseraft repl once to migrate your API key to the OS keychain.`
            );
            keepGoing = false;
        }
    }
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
