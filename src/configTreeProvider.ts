import * as vscode from 'vscode';
import { ConfigInfo, findFuseraftConfigs } from './fuseraftUtils';

export class ConfigTreeProvider implements vscode.TreeDataProvider<ConfigItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ConfigItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private watcher: vscode.FileSystemWatcher | undefined;

    constructor() {
        this.watcher = vscode.workspace.createFileSystemWatcher('**/*.{yaml,yml,json}');
        this.watcher.onDidCreate(() => this.refresh());
        this.watcher.onDidDelete(() => this.refresh());
        this.watcher.onDidChange(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
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

        const configs = await findFuseraftConfigs();
        if (configs.length === 0) {
            return [new ConfigItem({
                label: 'No fuseraft configs found',
                fsPath: '',
                workspaceRelative: '',
            }, true)];
        }

        return configs.map(c => new ConfigItem(c, false));
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
