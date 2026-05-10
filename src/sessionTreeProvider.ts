import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SessionInfo, readSessions, formatTaskPreview, formatRelativeTime, getSessionsDir } from './fuseraftUtils';

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private watcher: fs.FSWatcher | undefined;

    constructor() {
        this.watchSessionsDir();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this.watcher?.close();
    }

    private watchSessionsDir(): void {
        const dir = getSessionsDir();
        try {
            if (!fs.existsSync(dir)) { return; }
            this.watcher = fs.watch(dir, () => this.refresh());
        } catch {
            // sessions dir not available
        }
    }

    getTreeItem(element: SessionItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SessionItem): Promise<SessionItem[]> {
        if (element) { return []; }

        const sessions = readSessions();
        if (sessions.length === 0) {
            return [new SessionItem({
                sessionId: '',
                task: 'No sessions found',
                configPath: '',
                startedAt: '',
                lastUpdatedAt: '',
                isComplete: true,
            }, true)];
        }

        return sessions.map(s => new SessionItem(s, false));
    }
}

export class SessionItem extends vscode.TreeItem {
    constructor(
        public readonly session: SessionInfo,
        private readonly isEmpty: boolean
    ) {
        super(
            isEmpty ? 'No sessions found' : `${session.sessionId}  ${formatTaskPreview(session.task)}`,
            vscode.TreeItemCollapsibleState.None
        );

        if (isEmpty) {
            this.contextValue = 'empty';
            this.description = '';
            return;
        }

        const relTime = formatRelativeTime(session.lastUpdatedAt);
        const status = session.isComplete ? '$(check)' : '$(loading~spin)';
        const statusLabel = session.isComplete ? 'complete' : 'incomplete';

        this.contextValue = session.isComplete ? 'session-complete' : 'session-incomplete';
        this.description = `${relTime} · ${statusLabel}`;
        this.tooltip = new vscode.MarkdownString(
            `**${session.sessionId}**\n\n` +
            `${session.task.slice(0, 300)}${session.task.length > 300 ? '…' : ''}\n\n` +
            `---\n` +
            `Config: \`${session.configPath}\`\n\n` +
            `Started: ${new Date(session.startedAt).toLocaleString()}\n\n` +
            `Status: ${statusLabel}`
        );
        this.iconPath = new vscode.ThemeIcon(
            session.isComplete ? 'pass-filled' : 'circle-large-outline',
            session.isComplete
                ? new vscode.ThemeColor('testing.iconPassed')
                : new vscode.ThemeColor('testing.iconQueued')
        );

    }
}
