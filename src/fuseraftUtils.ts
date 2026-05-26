import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('fuseraft');
    }
    return outputChannel;
}

export interface SessionInfo {
    sessionId: string;
    task: string;
    configPath: string;
    startedAt: string;
    lastUpdatedAt: string;
    isComplete: boolean;
}

export interface ConfigInfo {
    label: string;
    fsPath: string;
    workspaceRelative: string;
}

export interface CliCheckResult {
    found: boolean;
    version: string;
}

// Cache the result so we only probe once per session.
let _cliCheckCache: CliCheckResult | undefined;

export function invalidateCliCache(): void {
    _cliCheckCache = undefined;
}

export async function checkCli(): Promise<CliCheckResult> {
    if (_cliCheckCache !== undefined) {
        return _cliCheckCache;
    }

    const binary = getBinary();
    return new Promise(resolve => {
        execFile(binary, ['--version'], { timeout: 5000 }, (err, stdout) => {
            if (err) {
                _cliCheckCache = { found: false, version: '' };
            } else {
                _cliCheckCache = { found: true, version: stdout.trim() };
            }
            resolve(_cliCheckCache!);
        });
    });
}

export function getBinary(): string {
    return vscode.workspace.getConfiguration('fuseraft').get<string>('binaryPath', 'fuseraft');
}

/**
 * Read the plaintext API key from ~/.fuseraft/config, if one is stored there.
 * Returns an empty string when the file is absent, unreadable, or has no key.
 * Used to inject FUSERAFT_API_KEY into child processes and terminals so the
 * CLI can always find the key even when it can't locate the config file
 * (common on Windows where home-directory resolution differs between shells).
 */
export function readApiKeyFromConfig(): string {
    const configPath = path.join(os.homedir(), '.fuseraft', 'config');
    try {
        if (!fs.existsSync(configPath)) { return ''; }
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
    } catch {
        return '';
    }
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

export function getRunFlags(): string {
    return vscode.workspace.getConfiguration('fuseraft').get<string>('runFlags', '');
}

export function getSessionsDir(): string {
    return path.join(os.homedir(), '.fuseraft', 'sessions');
}

export function getReplSessionsDir(): string {
    return path.join(os.homedir(), '.fuseraft', 'repl-sessions');
}

export interface ReplSessionInfo {
    sessionId: string;
    modelId: string;
    turnIndex: number;
    startedAt: string;
    lastUpdatedAt: string;
    /** Plain-text preview of the first user message in the session. */
    firstUserMessage: string;
    cwd: string;
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
                        firstMsg = textContent?.Text ?? '';
                    }
                }
                sessions.push({
                    sessionId:        d.SessionId ?? '',
                    modelId:          d.ModelId   ?? '',
                    turnIndex:        d.TurnIndex  ?? 0,
                    startedAt:        d.StartedAt     ?? '',
                    lastUpdatedAt:    d.LastUpdatedAt ?? '',
                    firstUserMessage: firstMsg,
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

export function readSessions(): SessionInfo[] {
    const dir = getSessionsDir();
    if (!fs.existsSync(dir)) {
        return [];
    }

    const sessions: SessionInfo[] = [];
    try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        for (const file of files) {
            try {
                const raw = fs.readFileSync(path.join(dir, file), 'utf8');
                const data = JSON.parse(raw);
                sessions.push({
                    sessionId: data.SessionId ?? file.replace('.json', ''),
                    task: data.Task ?? '',
                    configPath: data.ConfigPath ?? '',
                    startedAt: data.StartedAt ?? '',
                    lastUpdatedAt: data.LastUpdatedAt ?? '',
                    isComplete: data.IsComplete ?? false,
                });
            } catch {
                // skip malformed session files
            }
        }
    } catch {
        return [];
    }

    return sessions.sort((a, b) =>
        new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime()
    );
}

export function filterSessionsToWorkspace(sessions: SessionInfo[]): SessionInfo[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return sessions; }
    const roots = folders.map(f => f.uri.fsPath);
    return sessions.filter(s => s.configPath && roots.some(r => s.configPath.startsWith(r + path.sep) || s.configPath.startsWith(r + '/')));
}

export async function findFuseraftConfigs(): Promise<ConfigInfo[]> {
    const configs: ConfigInfo[] = [];
    const seen = new Set<string>();

    const uris = await vscode.workspace.findFiles(
        '**/{orchestration,*.fuseraft}.{yaml,yml,json}',
        '**/node_modules/**'
    );

    // also find any YAML/JSON with Orchestration: key (broader search, limited)
    const broadUris = await vscode.workspace.findFiles(
        '**/*.{yaml,yml}',
        '**/node_modules/**',
        100
    );

    for (const uri of [...uris, ...broadUris]) {
        if (seen.has(uri.fsPath)) { continue; }
        try {
            const content = fs.readFileSync(uri.fsPath, 'utf8');
            if (!/^Orchestration:/m.test(content) && !/"Orchestration"/.test(content)) {
                continue;
            }
            seen.add(uri.fsPath);
            const rel = vscode.workspace.asRelativePath(uri.fsPath);
            configs.push({
                label: path.basename(uri.fsPath),
                fsPath: uri.fsPath,
                workspaceRelative: rel,
            });
        } catch {
            // skip unreadable files
        }
    }

    return configs.sort((a, b) => a.workspaceRelative.localeCompare(b.workspaceRelative));
}

export function formatTaskPreview(task: string, maxLen = 60): string {
    const first = task.split('\n')[0].trim();
    return first.length > maxLen ? first.slice(0, maxLen - 1) + '…' : first;
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
 * Poll well-known install locations and PATH until the fuseraft binary appears.
 * Calls `onFound(resolvedPath, wasOnPath)` once it is detected.
 *  - `resolvedPath` is the absolute path when found off-PATH, or the current
 *    getBinary() value when already reachable via PATH.
 *  - `wasOnPath` is true when it was found via PATH (no settings change needed).
 * Returns a cancel function that stops polling early (e.g. when the UI closes).
 */
export function pollForInstalledBinary(
    onFound: (resolvedPath: string, wasOnPath: boolean) => void,
    intervalMs = 2000,
    timeoutMs  = 120_000
): () => void {
    const knownPaths = getKnownInstallPaths();
    const start = Date.now();
    let done = false;

    const timer = setInterval(async () => {
        if (done || Date.now() - start > timeoutMs) {
            clearInterval(timer);
            return;
        }

        // 1. Check known FS paths first — cheap and catches the off-PATH case.
        for (const p of knownPaths) {
            if (fs.existsSync(p)) {
                done = true;
                clearInterval(timer);
                onFound(p, false);
                return;
            }
        }

        // 2. Invalidate cache and try the configured binary — catches the on-PATH case.
        invalidateCliCache();
        const cli = await checkCli();
        if (cli.found) {
            done = true;
            clearInterval(timer);
            onFound(getBinary(), true);
        }
    }, intervalMs);

    return () => {
        done = true;
        clearInterval(timer);
    };
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
 * After it finishes they should click "Check again" in the setup wizard
 * or dismiss/re-open it to recheck the CLI.
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
    const openOnRun = vscode.workspace.getConfiguration('fuseraft').get<boolean>('openTerminalOnRun', true);

    let terminal: vscode.Terminal | undefined;
    if (reuse) {
        terminal = vscode.window.terminals.find(t => t.name === name);
    }
    if (!terminal) {
        // Inject the saved API key as FUSERAFT_API_KEY so the CLI can always
        // find it, even on Windows where shell-based home-directory expansion
        // may resolve differently from the Node.js os.homedir() path used when
        // writing the config file.
        const apiKey = readApiKeyFromConfig();
        terminal = vscode.window.createTerminal({
            name,
            env: apiKey ? { FUSERAFT_API_KEY: apiKey } : undefined,
        });
    }

    if (openOnRun) {
        terminal.show(false);
    }
    terminal.sendText(command);
}

export async function pickConfig(configs: ConfigInfo[]): Promise<ConfigInfo | undefined> {
    if (configs.length === 0) {
        const choice = await vscode.window.showWarningMessage(
            'No fuseraft config files found in this workspace.',
            'Browse for config…',
            'Use fuseraft default'
        );
        if (choice === 'Browse for config…') {
            const uris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'Config files': ['yaml', 'yml', 'json'] },
                title: 'Select fuseraft config',
            });
            if (uris && uris[0]) {
                return {
                    label: path.basename(uris[0].fsPath),
                    fsPath: uris[0].fsPath,
                    workspaceRelative: vscode.workspace.asRelativePath(uris[0].fsPath),
                };
            }
        }
        return undefined;
    }

    if (configs.length === 1) {
        return configs[0];
    }

    const items = configs.map(c => ({
        label: c.label,
        description: c.workspaceRelative,
        config: c,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Select fuseraft config',
        placeHolder: 'Pick a config to run against',
    });

    return picked?.config;
}

export async function promptForTask(): Promise<string | undefined> {
    return vscode.window.showInputBox({
        title: 'fuseraft — Run Task',
        prompt: 'Describe the task for the agent team',
        placeHolder: 'e.g. Add pagination to the user list endpoint',
        ignoreFocusOut: true,
    });
}

/**
 * Quote a shell argument in a way that is safe for both PowerShell (win32)
 * and bash / zsh (all other platforms).
 */
function shellQuote(arg: string): string {
    if (process.platform === 'win32') {
        // PowerShell: wrap in double-quotes, escape inner double-quotes as `"
        return '"' + arg.replace(/"/g, '`"') + '"';
    }
    // bash/zsh: wrap in single-quotes, escape inner single-quotes as '\''
    return "'" + arg.replace(/'/g, `'\\''`) + "'";
}

export function buildRunCommand(
    binary: string,
    task: string,
    configPath?: string,
    extraFlags?: string,
    taskFilePath?: string
): string {
    const configFlag = configPath ? ` -c ${shellQuote(configPath)}` : '';
    const flags = extraFlags ? ` ${extraFlags}` : '';
    if (taskFilePath) {
        return `${binary} run --vscode${configFlag}${flags} -f ${shellQuote(taskFilePath)}`;
    }
    return `${binary} run --vscode${configFlag}${flags} ${shellQuote(task)}`;
}

/** Build a shell-safe init command. */
export function buildInitCommand(
    binary: string,
    outputPath: string,
    template: string,
    modelFlag?: string,
    endpointFlag?: string
): string {
    let cmd = `${binary} init ${shellQuote(outputPath)} --template ${template} --no-interactive`;
    if (modelFlag) { cmd += ` --model ${modelFlag}`; }
    if (endpointFlag) { cmd += ` --endpoint ${shellQuote(endpointFlag)}`; }
    return cmd;
}
