import * as vscode from 'vscode';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { stripMessageContext } from './editorContext';

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('fuseraft');
    }
    return outputChannel;
}

export interface CliCheckResult {
    found: boolean;
    version: string;
}

// Only a found CLI is cached: a miss is probed again on the next check, so a CLI installed (or slow to
// start the first time) mid-session is picked up without the user having to click Check again.
let _cliCheckCache: CliCheckResult | undefined;
let _cliProbe: { binary: string; promise: Promise<CliCheckResult> } | undefined;

// A just-installed binary's first launch can sit behind an antivirus or Gatekeeper scan for several seconds.
const CLI_PROBE_TIMEOUT_MS = 15_000;

export function invalidateCliCache(): void {
    _cliCheckCache = undefined;
    _cliProbe = undefined;
    _scopedKeysCache = undefined;
}

function probeCliVersion(binary: string): Promise<CliCheckResult> {
    return new Promise(resolve => {
        execFile(binary, ['--version'], { timeout: CLI_PROBE_TIMEOUT_MS }, (err, stdout) => {
            resolve(err ? { found: false, version: '' } : { found: true, version: stdout.trim() });
        });
    });
}

/**
 * Store an API key in the CLI's OS keychain by calling `fuseraft keychain --set`
 * with FUSERAFT_API_KEY injected into the subprocess environment.
 * Returns true on success, false if the CLI is not found or the write failed.
 */
export async function storeApiKeyToCliKeychain(apiKey: string): Promise<boolean> {
    return new Promise(resolve => {
        const binary = getBinary();
        const env: NodeJS.ProcessEnv = { ...process.env, FUSERAFT_API_KEY: apiKey, ...getFuseraftHomeEnvOverride() };
        execFile(binary, ['keychain', '--set'], { env, timeout: 5000 }, (err) => {
            resolve(!err);
        });
    });
}

/**
 * Retrieve the API key from the CLI's OS keychain by calling `fuseraft keychain --get`: the configured
 * provider's key, or with `endpoint` the key saved for that server (needs {@link cliHasScopedKeys}).
 * Returns the key on success, or an empty string if no key is stored or the CLI is unavailable.
 */
export async function getApiKeyFromCliKeychain(endpoint?: string): Promise<string> {
    return new Promise(resolve => {
        const binary = getBinary();
        const env: NodeJS.ProcessEnv = { ...process.env, ...getFuseraftHomeEnvOverride() };
        const args = endpoint ? ['keychain', '--get', '--endpoint', endpoint] : ['keychain', '--get'];
        execFile(binary, args, { env, timeout: 5000 }, (err, stdout) => {
            if (err || !stdout) { resolve(''); return; }
            resolve(stdout.trim());
        });
    });
}

let _scopedKeysCache: boolean | undefined;

/**
 * Whether the CLI keeps a key per endpoint and sends it only there (`fuseraft keychain --endpoint`).
 * Older CLIs keep one key and send it to whatever endpoint is configured.
 */
export async function cliHasScopedKeys(): Promise<boolean> {
    if (_scopedKeysCache !== undefined) { return _scopedKeysCache; }
    return new Promise(resolve => {
        execFile(getBinary(), ['keychain', '--help'], { timeout: 5000 }, (err, stdout) => {
            _scopedKeysCache = !err && /--endpoint/.test(stdout ?? '');
            resolve(_scopedKeysCache);
        });
    });
}

export async function checkCli(): Promise<CliCheckResult> {
    if (_cliCheckCache !== undefined) {
        return _cliCheckCache;
    }

    const binary = getBinary();
    if (_cliProbe?.binary === binary) {
        return _cliProbe.promise;
    }
    const probe = {
        binary,
        promise: probeCliVersion(binary).then(result => {
            // A probe superseded by invalidateCliCache (or a new binaryPath) must not overwrite a newer answer.
            if (_cliProbe === probe) {
                _cliProbe = undefined;
                if (result.found) { _cliCheckCache = result; }
                // Swaps Update for Install in the Chats view's menu. Set only when missing, so Update shows until checked.
                void vscode.commands.executeCommand('setContext', 'fuseraft.cliMissing', !result.found);
            }
            return result;
        }),
    };
    _cliProbe = probe;
    return probe.promise;
}

export function getBinary(): string {
    return vscode.workspace.getConfiguration('fuseraft').get<string>('binaryPath', 'fuseraft');
}

/**
 * Resolves the fuseraft home directory, mirroring FuseraftPaths.GlobalRoot in
 * fuseraft-cli: the fuseraft.homeDir setting takes priority (so it can be
 * configured without touching shell env — useful when the OS home directory
 * isn't durable, e.g. roaming/ephemeral profiles), then a FUSERAFT_HOME
 * already present in this process's environment, then the ~/.fuseraft default.
 */
export function getFuseraftHome(): string {
    const configured = vscode.workspace.getConfiguration('fuseraft').get<string>('homeDir', '').trim();
    const raw = configured || process.env['FUSERAFT_HOME'] || '';
    if (!raw) { return path.join(os.homedir(), '.fuseraft'); }

    const expanded = (raw === '~' || raw.startsWith('~/'))
        ? path.join(os.homedir(), raw.slice(1))
        : raw;
    return path.resolve(expanded);
}

/**
 * Returns { FUSERAFT_HOME: <dir> } when fuseraft.homeDir is configured, so
 * CLI subprocesses/terminals pick it up even without a real FUSERAFT_HOME
 * environment variable set. Empty object when unconfigured, so an existing
 * FUSERAFT_HOME in the parent environment passes through untouched.
 */
export function getFuseraftHomeEnvOverride(): NodeJS.ProcessEnv {
    const configured = vscode.workspace.getConfiguration('fuseraft').get<string>('homeDir', '').trim();
    return configured ? { FUSERAFT_HOME: getFuseraftHome() } : {};
}

/**
 * Read the plaintext API key from <fuseraft home>/config, if one is stored there.
 * Returns an empty string when the file is absent, unreadable, or has no key.
 * Used to inject FUSERAFT_API_KEY into child processes and terminals so the
 * CLI can always find the key even when it can't locate the config file
 * (common on Windows where home-directory resolution differs between shells).
 */
export function readApiKeyFromConfig(): string {
    const configPath = path.join(getFuseraftHome(), 'config');
    try {
        if (!fs.existsSync(configPath)) { return ''; }
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
    } catch {
        return '';
    }
}

export interface ProviderConfig {
    endpoint: string;
    apiKey: string;
    provider: string;
    modelId: string;
}

export interface ProviderFields {
    modelId: string;
    endpoint: string;
    provider: string;
    apiKeyEnvVar: string;
}

/**
 * Extracts provider connection fields from a parsed ~/.fuseraft/config object.
 * Supports both the current sectioned shape (`{ provider: { modelId, endpoint, type,
 * apiKeyEnvVar } }`) and the pre-sectioning flat shape (`{ modelId, endpoint, provider,
 * apiKeyEnvVar }` at the root) that fuseraft-cli migrates to the sectioned shape the
 * next time any `fuseraft` command runs. Reading both here means the extension keeps
 * working correctly regardless of whether the CLI has migrated the file yet.
 */
export function parseProviderSection(cfg: unknown): ProviderFields {
    const root = (cfg && typeof cfg === 'object') ? cfg as Record<string, unknown> : {};
    const section = (root.provider && typeof root.provider === 'object')
        ? root.provider as Record<string, unknown>
        : null;
    const str = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
    return {
        modelId:      str(section ? section.modelId      : root.modelId),
        endpoint:     str(section ? section.endpoint     : root.endpoint),
        provider:     str(section ? section.type         : root.provider),
        apiKeyEnvVar: str(section ? section.apiKeyEnvVar : root.apiKeyEnvVar),
    };
}

/**
 * Read provider connection fields from ~/.fuseraft/config.
 * Returns null when the file is absent, unreadable, or lacks an endpoint.
 */
export function readProviderConfig(): ProviderConfig | null {
    const configPath = path.join(getFuseraftHome(), 'config');
    try {
        if (!fs.existsSync(configPath)) { return null; }
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const { modelId, endpoint, provider } = parseProviderSection(cfg);
        if (!modelId || !endpoint) { return null; }
        return {
            endpoint,
            apiKey: typeof (cfg as Record<string, unknown>).apiKey === 'string'
                ? ((cfg as Record<string, unknown>).apiKey as string).trim()
                : '',
            provider,
            modelId,
        };
    } catch {
        return null;
    }
}

/**
 * Sets the modelId/endpoint/provider-type fields via `fuseraft settings set`, one call
 * per field, run sequentially against the same file. Delegating the write to the CLI
 * (rather than hand-writing the JSON here, as this used to do) means the extension never
 * has to track fuseraft-cli's on-disk schema — every other section the file already has
 * (sampling, repl, mcpServers, telemetry, skillCuration) is left untouched by `settings
 * set`, instead of being wiped out by a naive full-file overwrite.
 * Returns true only if every field was set successfully.
 */
export async function writeProviderConfigViaCli(modelId: string, endpoint: string, provider: string): Promise<boolean> {
    const fields: Array<[string, string]> = [
        ['provider.modelId', modelId],
        ['provider.endpoint', endpoint],
        ['provider.type', provider],
    ];
    for (const [key, value] of fields) {
        // Sequential, not Promise.all — each call is its own read-modify-write of the
        // same file, so running them concurrently would race.
        const ok = await runSettingsSet(key, value);
        if (!ok) { return false; }
    }
    return true;
}

function runSettingsSet(key: string, value: string): Promise<boolean> {
    return new Promise(resolve => {
        const binary = getBinary();
        const env: NodeJS.ProcessEnv = { ...process.env, ...getFuseraftHomeEnvOverride() };
        execFile(binary, ['settings', 'set', key, value], { env, timeout: 5000 }, (err) => {
            resolve(!err);
        });
    });
}

/** A global setting, as `fuseraft settings show --json` and `settings set --json` describe it. */
export interface CliSetting {
    key: string;
    kind: 'text' | 'bool' | 'integer' | 'number' | 'choice' | 'list';
    description: string;
    value: string | null;
    default: string | null;
    min: number | null;
    max: number | null;
    choices: string[] | null;
    clearable: boolean;
}

/**
 * Runs a `--json` command of the CLI's wire protocol: its `items`/`item`, the error it reported, or
 * `unsupported` when the output isn't an envelope (a CLI from before the command took `--json`).
 */
function runCliJson<T>(args: string[]): Promise<{ data: T } | { error: string } | { unsupported: true }> {
    return new Promise(resolve => {
        const env: NodeJS.ProcessEnv = { ...process.env, ...getFuseraftHomeEnvOverride() };
        execFile(getBinary(), [...args, '--json'], { env, timeout: 10000 }, (_err, stdout) => {
            const line = stdout.trim().split(/\r?\n/).pop() ?? '';
            try {
                const doc = JSON.parse(line);
                if (typeof doc.error === 'string') { resolve({ error: doc.error }); return; }
                const data = doc.items ?? doc.item;
                resolve(data === undefined ? { unsupported: true } : { data });
            } catch {
                resolve({ unsupported: true });
            }
        });
    });
}

export const listCliSettings = () => runCliJson<CliSetting[]>(['settings', 'show']);

// Each call is a read-modify-write of the same file, so they run one at a time.
let settingsWrites: Promise<unknown> = Promise.resolve();
export function setCliSetting(key: string, value: string) {
    const write = settingsWrites.then(() => runCliJson<CliSetting>(['settings', 'set', key, value]));
    settingsWrites = write.catch(() => undefined);
    return write;
}

/** The provider's model IDs, or null when they couldn't be listed. */
export async function fetchProviderModels(
    endpoint: string,
    apiKey: string,
    provider: 'ollama' | 'anthropic' | string,
    timeoutMs = 8000
): Promise<string[] | null> {
    const result = await listProviderModels(endpoint, apiKey, provider, timeoutMs);
    return 'models' in result ? result.models : null;
}

interface ModelList {
    data?: { id?: string }[];
    models?: { name?: string; supportedGenerationMethods?: string[] }[];
    error?: string | { message?: string };
}

/** Lists the provider's models, or says why it couldn't: proof the endpoint and key work, without picking a model. */
export function listProviderModels(
    endpoint: string,
    apiKey: string,
    provider: 'ollama' | 'anthropic' | string,
    timeoutMs = 8000
): Promise<{ models: string[] } | { error: string; status?: number }> {
    return new Promise(resolve => {
        const base = endpoint.replace(/\/$/, '');
        // Ollama's own listing is at its root; through its OpenAI-compatible /v1 it lists like OpenAI.
        const ollamaNative = provider === 'ollama' && !/\/v1$/.test(base);
        // Anthropic's base endpoint has no bare /models route and doesn't take Bearer auth.
        const isAnthropic = provider === 'anthropic';
        const isGoogle = provider === 'google';
        const urlStr = ollamaNative ? `${base}/api/tags`
            : isAnthropic ? `${base}/v1/models?limit=1000`
            : isGoogle ? `${base}/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`
            : `${base}/models`;

        let parsed: URL;
        try { parsed = new URL(urlStr); }
        catch { resolve({ error: `Invalid endpoint URL: ${endpoint || '(empty)'}` }); return; }

        const lib = parsed.protocol === 'https:' ? https : http;
        const headers: Record<string, string> = isAnthropic
            ? { ...(apiKey ? { 'x-api-key': apiKey } : {}), 'anthropic-version': '2023-06-01' }
            : isGoogle ? {}
            : (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
        const options: https.RequestOptions = {
            hostname: parsed.hostname,
            port:     parsed.port ? parseInt(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80),
            path:     parsed.pathname + parsed.search,
            method:   'GET',
            headers,
        };

        const req = lib.request(options, res => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => {
                let json: ModelList | undefined;
                try { json = JSON.parse(data) as ModelList; } catch { json = undefined; }
                if (res.statusCode !== 200) {
                    const status = res.statusCode ?? 0;
                    const detail = typeof json?.error === 'string' ? json.error : json?.error?.message;
                    resolve({ error: detail ?? `HTTP ${status}`, status });
                    return;
                }
                if (!json || typeof json !== 'object') { resolve({ error: 'The endpoint answered, but not with a model list.' }); return; }
                const ids: string[] = ollamaNative
                    ? (json.models ?? []).map(m => m.name ?? '').filter(Boolean)
                    : isGoogle
                        ? (json.models ?? [])
                            .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
                            .map(m => (m.name ?? '').replace(/^models\//, ''))
                            .filter(Boolean)
                        : (json.data ?? []).map(m => m.id ?? '').filter(Boolean);
                resolve({ models: ids.sort() });
            });
        });

        req.on('error',   (err: Error) => resolve({ error: describeRequestError(err, endpoint) }));
        req.on('timeout', () => { req.destroy(); resolve({ error: 'Request timed out' }); });
        req.setTimeout(timeoutMs);
        req.end();
    });
}

/** A refused connection to localhost is an AggregateError (IPv4 and IPv6 attempts) with an empty message. */
export function describeRequestError(e: unknown, endpoint: string): string {
    const errors = (e as { errors?: unknown[] } | null)?.errors;
    const first = Array.isArray(errors) && errors.length > 0 ? errors[0] : e;
    const code = (first as NodeJS.ErrnoException)?.code;
    if (code === 'ECONNREFUSED') { return `nothing answered at ${endpoint}. Is the server running?`; }
    if (code === 'ENOTFOUND') { return `couldn't find the host for ${endpoint}.`; }
    const message = first instanceof Error ? first.message : String(first);
    return message || code || 'the request failed.';
}

/**
 * Run `fuseraft models` and return the list of available model IDs plus the
 * currently configured model. Returns null if the command fails or returns no
 * models (e.g. no provider configured yet).
 */
export function fetchModelsViaCli(cwd?: string): Promise<{ list: string[]; current: string } | null> {
    return new Promise(resolve => {
        const configKey = readApiKeyFromConfig();
        const env: NodeJS.ProcessEnv = { ...process.env, ...getFuseraftHomeEnvOverride() };
        if (configKey && !env['FUSERAFT_API_KEY']) { env['FUSERAFT_API_KEY'] = configKey; }
        execFile(getBinary(), ['models'], { env, ...(cwd ? { cwd } : {}) }, (_err, stdout) => {
            if (!stdout?.trim()) { resolve(null); return; }
            const lines = stdout.split('\n').map((l: string) => l.trim()).filter(Boolean);
            // Model IDs never contain spaces, which drops the header and the trailing usage hint.
            const modelLines = lines.filter((l: string) => !/\s/.test(l.replace(/\s*←\s*current\s*$/, '')));
            const list = modelLines.map((l: string) => l.replace(/\s*←\s*current\s*$/, '').trim()).filter(Boolean);
            const current = modelLines.find((l: string) => l.includes('← current'))
                ?.replace(/\s*←\s*current\s*$/, '').trim() ?? '';
            resolve(list.length > 0 ? { list, current } : null);
        });
    });
}

export function logToChannel(msg: string): void {
    getOutputChannel().appendLine(`[${new Date().toISOString()}] ${msg}`);
}

export function disposeOutputChannel(): void {
    if (outputChannel) {
        outputChannel.dispose();
        outputChannel = undefined;
    }
}

export function getReplSessionsDir(): string {
    return path.join(getFuseraftHome(), 'repl-sessions');
}

export function getMemoryReplDir(): string {
    return path.join(getFuseraftHome(), 'memory', 'repl');
}

export interface ReplSessionInfo {
    sessionId: string;
    modelId: string;
    turnIndex: number;
    startedAt: string;
    lastUpdatedAt: string;
    /** Plain-text preview of the first user message in the session. */
    firstUserMessage: string;
    /** The name the user gave the chat with /title, if any. */
    title?: string;
    /** A name the CLI generated from the first exchange; shown when there's no title. */
    autoTitle?: string;
    cwd: string;
}

/**
 * Set or (with an empty title) remove a saved chat's Title in its snapshot. Only for chats no
 * CLI has open — a running one rewrites its snapshot every turn; send it /title instead.
 */
export function writeReplSessionTitle(sessionId: string, title: string): void {
    const file = path.join(getReplSessionsDir(), `repl-${sessionId}.json`);
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (title) { d.Title = title; } else { delete d.Title; }
    fs.writeFileSync(file, JSON.stringify(d, null, 2));
}

/**
 * Read all REPL session snapshots from ~/.fuseraft/repl-sessions/, sorted
 * newest-first by lastUpdatedAt.
 */
export function readReplSessions(): ReplSessionInfo[] {
    const dir = getReplSessionsDir();
    if (!fs.existsSync(dir)) { return []; }

    const sessions: ReplSessionInfo[] = [];
    try {
        const files = fs.readdirSync(dir).filter(f => f.startsWith('repl-') && f.endsWith('.json'));
        for (const file of files) {
            try {
                const raw = fs.readFileSync(path.join(dir, file), 'utf8');
                const d = JSON.parse(raw);
                // Find the first user-role message's text content.
                let firstMsg = '';
                if (Array.isArray(d.History)) {
                    const userMsg = d.History.find((m: { Role?: string }) => m.Role === 'user');
                    if (userMsg && Array.isArray(userMsg.Contents)) {
                        const textContent = (userMsg.Contents as Array<{ Type?: string; Text?: string }>)
                            .find(c => c.Type === 'text');
                        firstMsg = stripMessageContext(textContent?.Text ?? '');
                    }
                }
                sessions.push({
                    sessionId:        d.SessionId ?? '',
                    modelId:          d.ModelId   ?? '',
                    turnIndex:        d.TurnIndex  ?? 0,
                    startedAt:        d.StartedAt     ?? '',
                    lastUpdatedAt:    d.LastUpdatedAt ?? '',
                    firstUserMessage: firstMsg,
                    title:            typeof d.Title === 'string' && d.Title.trim() ? d.Title : undefined,
                    autoTitle:        typeof d.AutoTitle === 'string' && d.AutoTitle.trim() ? d.AutoTitle : undefined,
                    cwd:              d.Cwd ?? '',
                });
            } catch {
                // skip malformed snapshot files
            }
        }
    } catch {
        return [];
    }

    return sessions.sort((a, b) =>
        new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime()
    );
}

/** Sessions started inside one of the open workspace folders; every session when no folder is open. */
export function filterReplSessionsToWorkspace(sessions: ReplSessionInfo[]): ReplSessionInfo[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return sessions; }
    const roots = folders.map(f => path.resolve(f.uri.fsPath));
    return sessions.filter(s => {
        if (!s.cwd) { return false; }
        const cwd = path.resolve(s.cwd);
        return roots.some(r => cwd === r || cwd.startsWith(r + path.sep));
    });
}

/** The chat's title: the user's, else the generated one, else its first message. */
export function sessionTitle(session: ReplSessionInfo): string {
    if (session.title) { return session.title; }
    if (session.autoTitle) { return session.autoTitle; }
    const first = session.firstUserMessage.replace(/\s+/g, ' ').trim();
    if (!first) { return session.sessionId || '(empty chat)'; }
    return first.length > 60 ? first.slice(0, 59) + '…' : first;
}

export function formatRelativeTime(isoDate: string): string {
    if (!isoDate) { return ''; }
    const ms = Date.now() - new Date(isoDate).getTime();
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) { return 'just now'; }
    if (minutes < 60) { return `${minutes}m ago`; }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) { return `${hours}h ago`; }
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

/** Known install locations produced by the bundled install scripts. */
function getKnownInstallPaths(): string[] {
    if (process.platform === 'win32') {
        const localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
        return [path.join(localAppData, 'fuseraft', 'bin', 'fuseraft.exe')];
    }
    return [
        path.join(os.homedir(), '.local', 'bin', 'fuseraft'),
        '/usr/local/bin/fuseraft',
    ];
}

/**
 * Poll well-known install locations and PATH until the fuseraft binary appears and answers `--version`.
 * Calls `onFound(resolvedPath, wasOnPath)` once it does.
 *  - `resolvedPath` is the absolute path when found off-PATH, or the current
 *    getBinary() value when already reachable via PATH.
 *  - `wasOnPath` is true when it was found via PATH (no settings change needed).
 * Returns a cancel function that stops polling early (e.g. when the UI closes).
 */
export function pollForInstalledBinary(
    onFound: (resolvedPath: string, wasOnPath: boolean) => void,
    intervalMs = 2000,
    timeoutMs  = 600_000  // the release archives are 50-90 MB, so allow for a slow download
): () => void {
    const knownPaths = getKnownInstallPaths();
    const start = Date.now();
    let done = false;
    let busy = false;  // a probe can outlast the interval; don't stack them

    const stop = () => {
        done = true;
        clearInterval(timer);
    };

    const timer = setInterval(async () => {
        if (done || busy) { return; }
        if (Date.now() - start > timeoutMs) { stop(); return; }
        busy = true;
        try {
            // 1. Known install locations catch the off-PATH case. The file existing isn't enough: its first
            //    launch can be held up by a scan, and reporting it then left the CLI marked missing.
            const installed = knownPaths.find(p => fs.existsSync(p));
            if (installed && (await probeCliVersion(installed)).found) {
                if (!done) { stop(); onFound(installed, false); }
                return;
            }

            // 2. The configured binary catches the on-PATH case.
            if ((await checkCli()).found && !done) { stop(); onFound(getBinary(), true); }
        } finally {
            busy = false;
        }
    }, intervalMs);

    return stop;
}

/**
 * Run `fuseraft update` in a dedicated terminal to fetch and replace the
 * running binary with the latest GitHub release.
 *
 * After the terminal finishes the caller should invalidate the CLI cache
 * and re-check the version.
 */
export function runUpdate(): void {
    const binary = getBinary();
    const terminal = vscode.window.createTerminal({ name: 'fuseraft update' });
    terminal.show(false);
    terminal.sendText(`${binary} update`);
}

/**
 * Run the appropriate fuseraft CLI installer in a dedicated terminal:
 *   Linux / macOS  → curl -fsSL …/install.sh | bash
 *   Windows        → irm …/install.ps1 | iex  (opened in PowerShell)
 *
 * The terminal is shown immediately so the user can watch progress.
 * Callers detect the finished install with {@link pollForInstalledBinary}.
 */
export function runInstaller(): void {
    const BASE = 'https://raw.githubusercontent.com/fuseraft/fuseraft-cli/main';

    let terminal: vscode.Terminal;
    let cmd: string;

    if (process.platform === 'win32') {
        // Explicitly open PowerShell so irm / iex are available
        terminal = vscode.window.createTerminal({
            name: 'fuseraft install',
            shellPath: 'powershell.exe',
            shellArgs: ['-NoLogo'],
        });
        cmd = `irm ${BASE}/install.ps1 | iex`;
    } else {
        terminal = vscode.window.createTerminal({ name: 'fuseraft install' });
        cmd = `curl -fsSL ${BASE}/install.sh | bash`;
    }

    terminal.show(false);   // show but don't steal focus from the setup panel
    terminal.sendText(cmd);
}

export function runInTerminal(command: string, name = 'fuseraft', reuse = false): void {
    let terminal: vscode.Terminal | undefined;
    if (reuse) {
        terminal = vscode.window.terminals.find(t => t.name === name);
    }
    if (!terminal) {
        // Inject FUSERAFT_API_KEY from the saved config only when the variable
        // is not already present — an explicitly set env var always takes
        // priority.  On Windows the CLI subprocess may not resolve
        // ~/.fuseraft/config through the same home-directory path that the
        // extension used when writing it, so the env var is the reliable
        // channel for the key.
        const apiKey = readApiKeyFromConfig();
        const injectKey = apiKey && !process.env['FUSERAFT_API_KEY'];
        const env: NodeJS.ProcessEnv = {
            ...(injectKey ? { FUSERAFT_API_KEY: apiKey } : {}),
            ...getFuseraftHomeEnvOverride(),
        };
        terminal = vscode.window.createTerminal({
            name,
            env: Object.keys(env).length > 0 ? env : undefined,
        });
    }

    terminal.show(false);
    terminal.sendText(command);
}

/**
 * Quote a shell argument in a way that is safe for both PowerShell (win32)
 * and bash / zsh (all other platforms).
 */
export function shellQuote(arg: string): string {
    if (process.platform === 'win32') {
        // PowerShell: wrap in double-quotes, escape inner double-quotes as `"
        return '"' + arg.replace(/"/g, '`"') + '"';
    }
    // bash/zsh: wrap in single-quotes, escape inner single-quotes as '\''
    return "'" + arg.replace(/'/g, `'\\''`) + "'";
}
