import * as vscode from 'vscode';
import { ConfigInfo, findFuseraftConfigs } from './fuseraftUtils';

export class ConfigTreeProvider implements vscode.TreeDataProvider<ConfigItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ConfigItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private watcher: vscode.FileSystemWatcher | undefined;
    private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

    constructor() {
        // Exclude node_modules from the watcher pattern to avoid cascading refreshes
        // during npm installs or other heavy file activity.
        this.watcher = vscode.workspace.createFileSystemWatcher(
            '**/{*.fuseraft,orchestration}.{yaml,yml,json}'
        );
        this.watcher.onDidCreate(() => this._scheduleRefresh());
        this.watcher.onDidDelete(() => this._scheduleRefresh());
        this.watcher.onDidChange(() => this._scheduleRefresh());
    }

    private _scheduleRefresh(): void {
        if (this._debounceTimer !== undefined) {
            clearTimeout(this._debounceTimer);
        }
        this._debounceTimer = setTimeout(() => {
            this._debounceTimer = undefined;
            this._onDidChangeTreeData.fire();
        }, 300);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        if (this._debounceTimer !== undefined) {
            clearTimeout(this._debounceTimer);
        }
        this.watcher?.dispose();
    }

    getTreeItem(element: ConfigItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ConfigItem): Promise<ConfigItem[]> {
        if (element) { return []; }
        if (!vscode.workspace.workspaceFolders?.length) {
            return [new ConfigItem({
                label: 'Open a folder to discover configs',
                fsPath: '',
                workspaceRelative: '',
            }, true)];
        }

        try {
            const configs = await findFuseraftConfigs();
            if (configs.length === 0) {
                return [new ConfigItem({
                    label: 'No fuseraft configs found',
                    fsPath: '',
                    workspaceRelative: '',
                }, true)];
            }
            return configs.map(c => new ConfigItem(c, false));
        } catch {
            return [new ConfigItem({
                label: 'Error loading configs — click Refresh to retry',
                fsPath: '',
                workspaceRelative: '',
            }, true)];
        }
    }
}

export class ConfigItem extends vscode.TreeItem {
    constructor(
        public readonly config: ConfigInfo,
        private readonly isEmpty: boolean
    ) {
        super(config.label, vscode.TreeItemCollapsibleState.None);

        if (isEmpty) {
            this.contextValue = 'empty';
            return;
        }

        this.contextValue = 'config';
        this.description = config.workspaceRelative !== config.label
            ? config.workspaceRelative
            : undefined;
        this.tooltip = config.fsPath;
        this.iconPath = new vscode.ThemeIcon('settings-gear');
        this.resourceUri = vscode.Uri.file(config.fsPath);
        this.command = {
            command: 'vscode.open',
            title: 'Open Config',
            arguments: [vscode.Uri.file(config.fsPath)],
        };
    }
}
