import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ReplSessionInfo, readReplSessions, formatRelativeTime, getReplSessionsDir } from './fuseraftUtils';
import { ReplPanelProvider } from './replPanelProvider';

export class ReplSessionTreeProvider implements vscode.TreeDataProvider<ReplSessionItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ReplSessionItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private watcher: fs.FSWatcher | undefined;
    private readonly titleListener: vscode.Disposable;

    constructor() {
        this.watchSessionsDir();
        // A chat renamed mid-reply only reaches its snapshot when the reply ends.
        this.titleListener = ReplPanelProvider.onDidChangeLiveTitle(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this.watcher?.close();
        this.titleListener.dispose();
    }

    /** Re-arms the watcher against the current sessions dir (e.g. after fuseraft.homeDir changes) and refreshes. */
    resetWatcher(): void {
        this.watcher?.close();
        this.watcher = undefined;
        this.watchSessionsDir();
        this.refresh();
    }

    private watchSessionsDir(): void {
        const dir = getReplSessionsDir();
        try {
            // The CLI creates the dir on the first save, so make it now to have something to watch.
            fs.mkdirSync(dir, { recursive: true });
            this.watcher = fs.watch(dir, () => this.refresh());
        } catch {
            // sessions dir not available
        }
    }

    getTreeItem(element: ReplSessionItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ReplSessionItem): ReplSessionItem[] {
        if (element) { return []; }
        // The CLI snapshots a chat even if it was closed before anything was sent; those aren't worth listing.
        // An empty list lets the viewsWelcome content show instead.
        return filterReplSessionsToWorkspace(readReplSessions())
            .filter(s => s.turnIndex > 0 || s.firstUserMessage)
            .map(s => new ReplSessionItem(withLiveTitle(s)));
    }
}

function withLiveTitle(session: ReplSessionInfo): ReplSessionInfo {
    const live = ReplPanelProvider.liveTitle;
    if (live === undefined || ReplPanelProvider.liveSessionId !== session.sessionId) { return session; }
    return { ...session, title: live.title ?? undefined, autoTitle: live.autoTitle ?? session.autoTitle };
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

export class ReplSessionItem extends vscode.TreeItem {
    constructor(public readonly session: ReplSessionInfo) {
        super(sessionTitle(session), vscode.TreeItemCollapsibleState.None);

        const turns = `${session.turnIndex} turn${session.turnIndex === 1 ? '' : 's'}`;
        this.contextValue = 'replSession';
        this.description = `${formatRelativeTime(session.lastUpdatedAt)} · ${turns}`;
        this.iconPath = new vscode.ThemeIcon('comment-discussion');
        this.tooltip = new vscode.MarkdownString(
            `**${session.sessionId}** · \`${session.modelId || 'default model'}\`\n\n` +
            `${session.firstUserMessage.slice(0, 300)}${session.firstUserMessage.length > 300 ? '…' : ''}\n\n` +
            `---\n` +
            `${turns} · last active ${session.lastUpdatedAt ? new Date(session.lastUpdatedAt).toLocaleString() : 'unknown'}\n\n` +
            `Folder: \`${session.cwd}\``
        );
        this.command = {
            command: 'fuseraft.replResume',
            title: 'Resume Chat',
            arguments: [this],
        };
    }
}

/** The chat's title: the user's, else the generated one, else its first message. */
export function sessionTitle(session: ReplSessionInfo): string {
    if (session.title) { return session.title; }
    if (session.autoTitle) { return session.autoTitle; }
    const first = session.firstUserMessage.replace(/\s+/g, ' ').trim();
    if (!first) { return session.sessionId || '(empty chat)'; }
    return first.length > 60 ? first.slice(0, 59) + '…' : first;
}
