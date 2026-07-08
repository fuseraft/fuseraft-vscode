import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getMemoryReplDir } from './fuseraftUtils';

export interface MemoryEntryInfo {
    guid: string;
    name: string;
    description: string;
    type: string;
    body: string;
    /** File name (not full path) of the entry's markdown file, relative to the memory dir. */
    fileName: string;
}

/**
 * Parse a single memory markdown file (YAML-ish frontmatter + body).
 * Mirrors MemoryStore.ParseFile in fuseraft-cli exactly: requires the file to
 * open with a bare "---" line and locates the first "\n---" that occupies its
 * own line as the close delimiter (so a body containing "---old-section" or a
 * git-diff style "--- a/Foo.cs" line isn't mistaken for the terminator).
 */
export function parseMemoryFile(text: string, fileName: string): MemoryEntryInfo | null {
    const OPEN = '---';
    const CLOSE_TAG = '\n---';
    if (!text.startsWith(OPEN)) { return null; }

    let closeIdx = -1;
    let search = OPEN.length;
    for (;;) {
        const candidate = text.indexOf(CLOSE_TAG, search);
        if (candidate < 0) { break; }
        const after = candidate + CLOSE_TAG.length;
        if (after >= text.length || text[after] === '\n' || text[after] === '\r') {
            closeIdx = candidate;
            break;
        }
        search = candidate + 1;
    }
    if (closeIdx < 0) { return null; }

    let guid = '', name = '', description = '', type = 'project';
    for (const line of text.slice(OPEN.length, closeIdx).split('\n')) {
        const c = line.indexOf(':');
        if (c < 0) { continue; }
        const value = line.slice(c + 1).trim();
        switch (line.slice(0, c).trim().toLowerCase()) {
            case 'guid':        guid = value; break;
            case 'name':        name = value; break;
            case 'description': description = value; break;
            case 'type':        type = value; break;
        }
    }
    if (!name) { return null; }

    return { guid, name, description, type, body: text.slice(closeIdx + CLOSE_TAG.length).trim(), fileName };
}

/**
 * Read all memory entries for a store directory (e.g. ~/.fuseraft/memory/repl)
 * by walking its MEMORY.md index, same as MemoryStore.LoadAllAsync.
 */
export function readMemoryEntries(dir: string): MemoryEntryInfo[] {
    const indexPath = path.join(dir, 'MEMORY.md');
    if (!fs.existsSync(indexPath)) { return []; }

    const entries: MemoryEntryInfo[] = [];
    try {
        const lines = fs.readFileSync(indexPath, 'utf8').split('\n');
        for (const line of lines) {
            const m = line.match(/^\s*-\s+\[([^\]]+)\]\(([^)]+)\)/);
            if (!m) { continue; }
            const filePath = path.join(dir, m[2]);
            if (!fs.existsSync(filePath)) { continue; }
            try {
                const entry = parseMemoryFile(fs.readFileSync(filePath, 'utf8'), m[2]);
                if (entry) { entries.push(entry); }
            } catch { /* skip malformed entry */ }
        }
    } catch {
        return [];
    }
    return entries;
}

export class MemoryItemNode extends vscode.TreeItem {
    constructor(public readonly entry: MemoryEntryInfo, dir: string) {
        super(entry.name, vscode.TreeItemCollapsibleState.None);
        this.description = entry.description;
        this.tooltip = new vscode.MarkdownString(
            `**${entry.name}** _(${entry.type})_\n\n${entry.description}\n\n---\n\n${entry.body}`
        );
        this.iconPath = new vscode.ThemeIcon('lightbulb');
        this.contextValue = 'memoryItem';
        const uri = vscode.Uri.file(path.join(dir, entry.fileName));
        this.resourceUri = uri;
        this.command = { command: 'vscode.open', title: 'Open Memory', arguments: [uri] };
    }
}

export class MemoryTreeProvider implements vscode.TreeDataProvider<MemoryItemNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<MemoryItemNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private watcher: fs.FSWatcher | undefined;

    constructor() {
        this.watchMemoryDir();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this.watcher?.close();
    }

    /** Re-arms the watcher against the current memory dir (e.g. after fuseraft.homeDir changes) and refreshes. */
    resetWatcher(): void {
        this.watcher?.close();
        this.watcher = undefined;
        this.watchMemoryDir();
        this.refresh();
    }

    private watchMemoryDir(): void {
        const dir = getMemoryReplDir();
        try {
            if (!fs.existsSync(dir)) { return; }
            this.watcher = fs.watch(dir, () => this.refresh());
        } catch { /* ignore */ }
    }

    getTreeItem(element: MemoryItemNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: MemoryItemNode): MemoryItemNode[] {
        if (element) { return []; }
        const dir = getMemoryReplDir();
        return readMemoryEntries(dir)
            .sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type.localeCompare(b.type))
            .map(e => new MemoryItemNode(e, dir));
    }
}
