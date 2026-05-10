import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface ContextEntry {
    name: string;
    description?: string;
    sourcePath: string;
    importedAt: string;
    files: { relativePath: string }[];
}

interface ContextIndex {
    items: Record<string, ContextEntry>;
}

export function getContextDir(): string | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? path.join(root, '.fuseraft', 'context') : undefined;
}

export function readContextIndex(): ContextEntry[] {
    const dir = getContextDir();
    if (!dir) { return []; }
    const indexPath = path.join(dir, 'index.json');
    if (!fs.existsSync(indexPath)) { return []; }
    try {
        const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ContextIndex;
        return Object.values(raw.items ?? {});
    } catch {
        return [];
    }
}

export class ContextItemNode extends vscode.TreeItem {
    constructor(public readonly entry: ContextEntry) {
        super(entry.name, vscode.TreeItemCollapsibleState.None);
        this.description = entry.description ?? '';
        this.tooltip = new vscode.MarkdownString(
            `**${entry.name}**\n\n` +
            (entry.description ? `${entry.description}\n\n` : '') +
            `Source: \`${entry.sourcePath}\`\n\n` +
            `Imported: ${new Date(entry.importedAt).toLocaleString()}\n\n` +
            `${entry.files.length} file${entry.files.length !== 1 ? 's' : ''}`
        );
        this.iconPath = new vscode.ThemeIcon('book');
        this.contextValue = 'contextItem';
    }
}

export class ContextTreeProvider implements vscode.TreeDataProvider<ContextItemNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ContextItemNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private watcher: fs.FSWatcher | undefined;

    constructor() {
        this.watchContextDir();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this.watcher?.close();
    }

    private watchContextDir(): void {
        const dir = getContextDir();
        if (!dir) { return; }
        try {
            if (!fs.existsSync(dir)) { return; }
            this.watcher = fs.watch(dir, () => this.refresh());
        } catch { /* ignore */ }
    }

    getTreeItem(element: ContextItemNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ContextItemNode): ContextItemNode[] {
        if (element) { return []; }
        return readContextIndex().map(e => new ContextItemNode(e));
    }
}
