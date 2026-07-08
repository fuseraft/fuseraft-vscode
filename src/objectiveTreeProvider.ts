import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseSimpleYaml, yamlString, yamlArray } from './simpleYaml';

export interface ObjectiveInfo {
    id: string;
    title: string;
    description: string;
    status: string;
    completedTasks: string[];
    remainingTasks: string[];
    fileName: string;
}

export function getObjectivesDir(): string | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? path.join(root, '.fuseraft', 'knowledge', 'objectives') : undefined;
}

/** Mirrors ObjectiveStore.LoadAllAsync in fuseraft-cli — reads OBJ-*.yaml files. */
export function readObjectives(dir: string): ObjectiveInfo[] {
    if (!fs.existsSync(dir)) { return []; }
    const objectives: ObjectiveInfo[] = [];
    try {
        for (const file of fs.readdirSync(dir).filter(f => /^OBJ-.*\.ya?ml$/i.test(f))) {
            try {
                const doc = parseSimpleYaml(fs.readFileSync(path.join(dir, file), 'utf8'));
                const id = yamlString(doc, 'Id');
                if (!id) { continue; }
                objectives.push({
                    id,
                    title: yamlString(doc, 'Title'),
                    description: yamlString(doc, 'Description'),
                    status: yamlString(doc, 'Status') || 'Active',
                    completedTasks: yamlArray(doc, 'CompletedTasks'),
                    remainingTasks: yamlArray(doc, 'RemainingTasks'),
                    fileName: file,
                });
            } catch { /* skip malformed objective */ }
        }
    } catch {
        return [];
    }
    return objectives.sort((a, b) => a.id.localeCompare(b.id));
}

function statusIcon(status: string): string {
    switch (status.toLowerCase()) {
        case 'completed': return 'check';
        case 'paused':     return 'debug-pause';
        case 'abandoned':  return 'circle-slash';
        default:           return 'play';
    }
}

export class ObjectiveItemNode extends vscode.TreeItem {
    constructor(public readonly objective: ObjectiveInfo, dir: string) {
        super(`${objective.id} — ${objective.title}`, vscode.TreeItemCollapsibleState.None);
        const total = objective.completedTasks.length + objective.remainingTasks.length;
        const pct = total > 0 ? Math.round((objective.completedTasks.length / total) * 100) : undefined;
        this.description = pct !== undefined ? `${objective.status} · ${pct}%` : objective.status;
        this.tooltip = new vscode.MarkdownString(
            `**${objective.id}** — ${objective.title}\n\n` +
            `Status: ${objective.status}\n\n` +
            (objective.description ? `${objective.description}\n\n` : '') +
            (total > 0 ? `Progress: ${pct}% (${objective.completedTasks.length}/${total} tasks)` : '')
        );
        this.iconPath = new vscode.ThemeIcon(statusIcon(objective.status));
        this.contextValue = 'objectiveItem';
        this.resourceUri = vscode.Uri.file(path.join(dir, objective.fileName));
    }
}

export class ObjectiveTreeProvider implements vscode.TreeDataProvider<ObjectiveItemNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ObjectiveItemNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private watcher: fs.FSWatcher | undefined;

    constructor() {
        this.watchObjectivesDir();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this.watcher?.close();
    }

    private watchObjectivesDir(): void {
        const dir = getObjectivesDir();
        if (!dir) { return; }
        try {
            if (!fs.existsSync(dir)) { return; }
            this.watcher = fs.watch(dir, () => this.refresh());
        } catch { /* ignore */ }
    }

    getTreeItem(element: ObjectiveItemNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ObjectiveItemNode): ObjectiveItemNode[] {
        if (element) { return []; }
        const dir = getObjectivesDir();
        if (!dir) { return []; }
        return readObjectives(dir).map(o => new ObjectiveItemNode(o, dir));
    }
}
