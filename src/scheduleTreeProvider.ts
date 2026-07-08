import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseSimpleYaml, yamlString, yamlNestedUtcDate } from './simpleYaml';

export interface ScheduledJobInfo {
    name: string;
    description: string;
    cron: string;
    task: string;
    enabled: boolean;
    nextRunUtc?: string;
    lastRunUtc?: string;
    fileName: string;
}

export function getScheduleDir(): string {
    return path.join(os.homedir(), '.fuseraft', 'schedule');
}

/** Mirrors ScheduleListCommand in fuseraft-cli — reads every *.yaml job file. */
export function readScheduledJobs(dir: string): ScheduledJobInfo[] {
    if (!fs.existsSync(dir)) { return []; }
    const jobs: ScheduledJobInfo[] = [];
    try {
        for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.yaml'))) {
            try {
                const doc = parseSimpleYaml(fs.readFileSync(path.join(dir, file), 'utf8'));
                const name = yamlString(doc, 'name');
                if (!name) { continue; }
                jobs.push({
                    name,
                    description: yamlString(doc, 'description'),
                    cron: yamlString(doc, 'cron'),
                    task: yamlString(doc, 'task'),
                    enabled: yamlString(doc, 'enabled') !== 'false',
                    nextRunUtc: yamlNestedUtcDate(doc, 'next_run'),
                    lastRunUtc: yamlNestedUtcDate(doc, 'last_run'),
                    fileName: file,
                });
            } catch { /* skip malformed job */ }
        }
    } catch {
        return [];
    }
    return jobs.sort((a, b) => a.name.localeCompare(b.name));
}

export class ScheduleItemNode extends vscode.TreeItem {
    constructor(public readonly job: ScheduledJobInfo, dir: string) {
        super(job.name, vscode.TreeItemCollapsibleState.None);
        this.description = `${job.cron}${job.enabled ? '' : ' (disabled)'}`;
        this.tooltip = new vscode.MarkdownString(
            `**${job.name}** \`${job.cron}\`${job.enabled ? '' : ' _(disabled)_'}\n\n` +
            (job.description ? `${job.description}\n\n` : '') +
            `Task: ${job.task}\n\n` +
            `Next run (UTC): ${job.nextRunUtc ?? '—'}\n\n` +
            `Last run (UTC): ${job.lastRunUtc ?? 'never'}`
        );
        this.iconPath = new vscode.ThemeIcon(job.enabled ? 'clock' : 'circle-slash');
        this.contextValue = 'scheduleItem';
        const uri = vscode.Uri.file(path.join(dir, job.fileName));
        this.resourceUri = uri;
        this.command = { command: 'vscode.open', title: 'Open Job', arguments: [uri] };
    }
}

export class ScheduleTreeProvider implements vscode.TreeDataProvider<ScheduleItemNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ScheduleItemNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private watcher: fs.FSWatcher | undefined;

    constructor() {
        this.watchScheduleDir();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this.watcher?.close();
    }

    private watchScheduleDir(): void {
        const dir = getScheduleDir();
        try {
            if (!fs.existsSync(dir)) { return; }
            this.watcher = fs.watch(dir, () => this.refresh());
        } catch { /* ignore */ }
    }

    getTreeItem(element: ScheduleItemNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ScheduleItemNode): ScheduleItemNode[] {
        if (element) { return []; }
        const dir = getScheduleDir();
        return readScheduledJobs(dir).map(j => new ScheduleItemNode(j, dir));
    }
}
