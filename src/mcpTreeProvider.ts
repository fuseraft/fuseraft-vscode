import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getFuseraftHome } from './fuseraftUtils';

/** The variable fuseraft reads servers from when whatever launched it provides them (fuseraft 1.24+). */
export const LAUNCHER_ENV_VAR = 'FUSERAFT_MCP_SERVERS';

export interface McpServerInfo {
    name: string;
    transport: 'stdio' | 'http';
    /** The URL, or the command a stdio server runs. */
    target: string;
    oauth: boolean;
    /** Only the names: a header's value is often a token. */
    headerNames: string[];
    /** 'saved' by /mcp add in ~/.fuseraft/config; 'launcher' from FUSERAFT_MCP_SERVERS. */
    source: 'saved' | 'launcher';
}

export function getConfigPath(): string {
    return path.join(getFuseraftHome(), 'config');
}

// The CLI writes these entries with PascalCase names but reads them case-insensitively, so this does too.
function field(obj: Record<string, unknown>, key: string): unknown {
    const k = Object.keys(obj).find(n => n.toLowerCase() === key.toLowerCase());
    return k === undefined ? undefined : obj[k];
}

function toServer(raw: unknown, source: McpServerInfo['source']): McpServerInfo | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return undefined; }
    const o = raw as Record<string, unknown>;
    const name = field(o, 'Name');
    if (typeof name !== 'string' || !name.trim()) { return undefined; }
    const url = field(o, 'Url');
    const command = field(o, 'Command');
    const http = String(field(o, 'Transport') ?? 'stdio').toLowerCase() === 'http';
    const headers = field(o, 'Headers');
    return {
        name: name.trim(),
        transport: http ? 'http' : 'stdio',
        target: http ? (typeof url === 'string' ? url : '') : (typeof command === 'string' ? command : ''),
        oauth: !!field(o, 'OAuth'),
        headerNames: headers && typeof headers === 'object' ? Object.keys(headers as object) : [],
        source,
    };
}

function parseList(json: string | undefined, source: McpServerInfo['source']): McpServerInfo[] {
    if (!json?.trim()) { return []; }
    try {
        const parsed: unknown = JSON.parse(json);
        const list = source === 'saved' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? field(parsed as Record<string, unknown>, 'mcpServers')
            : parsed;
        if (!Array.isArray(list)) { return []; }
        return list.map(s => toServer(s, source)).filter((s): s is McpServerInfo => !!s);
    } catch {
        return [];
    }
}

/**
 * The servers a new chat connects, as the CLI merges them: saved ones first, then the launcher's
 * whose names aren't taken (a saved server of the same name wins).
 */
export function readMcpServers(configJson: string | undefined, launcherJson: string | undefined): McpServerInfo[] {
    const saved = parseList(configJson, 'saved');
    const taken = new Set(saved.map(s => s.name.toLowerCase()));
    const launcher = parseList(launcherJson, 'launcher').filter(s => {
        const key = s.name.toLowerCase();
        if (taken.has(key)) { return false; }
        taken.add(key);
        return true;
    });
    return [...saved, ...launcher];
}

function readConfigFile(): string | undefined {
    try { return fs.readFileSync(getConfigPath(), 'utf8'); } catch { return undefined; }
}

export class McpServerNode extends vscode.TreeItem {
    constructor(public readonly server: McpServerInfo) {
        super(server.name, vscode.TreeItemCollapsibleState.None);
        // The label goes first: a long URL would cut it off.
        this.description = server.source === 'launcher' ? `provided by the launcher · ${server.target}` : server.target;
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${server.name}**\n\n`);
        md.appendMarkdown(server.transport === 'http' ? 'Streamable HTTP: ' : 'Runs: ');
        md.appendCodeblock(server.target || '(not set)', 'text');
        if (server.headerNames.length) { md.appendMarkdown(`\nHeaders: ${server.headerNames.join(', ')}\n`); }
        if (server.oauth) { md.appendMarkdown('\nSigns in with OAuth.\n'); }
        md.appendMarkdown(server.source === 'launcher'
            ? `\nProvided by whatever launched VS Code, in ${LAUNCHER_ENV_VAR}. It can't be removed here.`
            : '\nSaved by /mcp add. Every new chat connects it.');
        this.tooltip = md;
        this.iconPath = new vscode.ThemeIcon(server.transport === 'http' ? 'globe' : 'terminal');
        // Menus key off these: remove is for saved servers, log in/out for OAuth ones, the stderr log for stdio.
        this.contextValue = ['mcpServer', server.source, server.transport, ...(server.oauth ? ['oauth'] : [])].join('.');
    }
}

export class McpTreeProvider implements vscode.TreeDataProvider<McpServerNode>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<McpServerNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private watcher: vscode.FileSystemWatcher | undefined;

    constructor() {
        this.watchConfig();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /** Re-arms the watcher against the current config file (e.g. after fuseraft.homeDir changes) and refreshes. */
    resetWatcher(): void {
        this.watcher?.dispose();
        this.watchConfig();
        this.refresh();
    }

    servers(): McpServerInfo[] {
        return readMcpServers(readConfigFile(), process.env[LAUNCHER_ENV_VAR]);
    }

    dispose(): void {
        this.watcher?.dispose();
        this._onDidChangeTreeData.dispose();
    }

    // /mcp add and /mcp remove in any chat, the terminal REPL and `fuseraft settings` all write this file.
    private watchConfig(): void {
        const configPath = getConfigPath();
        this.watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(path.dirname(configPath)), path.basename(configPath)));
        this.watcher.onDidChange(() => this.refresh());
        this.watcher.onDidCreate(() => this.refresh());
        this.watcher.onDidDelete(() => this.refresh());
    }

    getTreeItem(element: McpServerNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: McpServerNode): McpServerNode[] {
        if (element) { return []; }
        return this.servers().map(s => new McpServerNode(s));
    }
}
