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

export function runInTerminal(command: string, name = 'fuseraft', reuse = false): void {
    const openOnRun = vscode.workspace.getConfiguration('fuseraft').get<boolean>('openTerminalOnRun', true);

    let terminal: vscode.Terminal | undefined;
    if (reuse) {
        terminal = vscode.window.terminals.find(t => t.name === name);
    }
    if (!terminal) {
        terminal = vscode.window.createTerminal({ name });
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

function shellQuote(arg: string): string {
    if (process.platform === 'win32') {
        return '"' + arg.replace(/"/g, '`"') + '"';
    }
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
