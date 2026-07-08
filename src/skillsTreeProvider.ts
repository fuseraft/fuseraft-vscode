import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SkillInfo {
    /** Directory name under ~/.fuseraft/skills — also the identifier used by 'skills remove'. */
    slug: string;
    name: string;
    description: string;
}

export function getSkillsDir(): string {
    return path.join(os.homedir(), '.fuseraft', 'skills');
}

const NAME_RE = /^name:\s*(.+)$/im;
const DESCRIPTION_RE = /^description:\s*(.+)$/im;

function stripQuotes(s: string): string {
    const t = s.trim();
    if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
        return t.slice(1, -1);
    }
    return t;
}

/** Mirrors SkillsHelpers.ExtractDescription in fuseraft-cli — reads the "description:" frontmatter line. */
export function readSkills(dir: string): SkillInfo[] {
    if (!fs.existsSync(dir)) { return []; }
    const skills: SkillInfo[] = [];
    try {
        for (const slug of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!slug.isDirectory()) { continue; }
            const mdPath = path.join(dir, slug.name, 'SKILL.md');
            if (!fs.existsSync(mdPath)) { continue; }
            try {
                const content = fs.readFileSync(mdPath, 'utf8');
                const nameMatch = content.match(NAME_RE);
                const descMatch = content.match(DESCRIPTION_RE);
                skills.push({
                    slug: slug.name,
                    name: nameMatch ? stripQuotes(nameMatch[1]) : slug.name,
                    description: descMatch ? stripQuotes(descMatch[1]) : '',
                });
            } catch { /* skip malformed skill */ }
        }
    } catch {
        return [];
    }
    return skills.sort((a, b) => a.slug.localeCompare(b.slug));
}

export class SkillItemNode extends vscode.TreeItem {
    constructor(public readonly skill: SkillInfo, dir: string) {
        super(skill.slug, vscode.TreeItemCollapsibleState.None);
        this.description = skill.description;
        this.tooltip = new vscode.MarkdownString(`**${skill.name}**\n\n${skill.description}`);
        this.iconPath = new vscode.ThemeIcon('tools');
        this.contextValue = 'skillItem';
        const uri = vscode.Uri.file(path.join(dir, skill.slug, 'SKILL.md'));
        this.resourceUri = uri;
        this.command = { command: 'vscode.open', title: 'Open Skill', arguments: [uri] };
    }
}

export class SkillsTreeProvider implements vscode.TreeDataProvider<SkillItemNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SkillItemNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private watcher: fs.FSWatcher | undefined;

    constructor() {
        this.watchSkillsDir();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this.watcher?.close();
    }

    private watchSkillsDir(): void {
        const dir = getSkillsDir();
        try {
            if (!fs.existsSync(dir)) { return; }
            // Non-recursive: catches skill add/remove (subdirectory create/delete) but not
            // edits inside an existing SKILL.md. Explicit refresh() calls after our own
            // add/remove commands cover the rest.
            this.watcher = fs.watch(dir, () => this.refresh());
        } catch { /* ignore */ }
    }

    getTreeItem(element: SkillItemNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SkillItemNode): SkillItemNode[] {
        if (element) { return []; }
        const dir = getSkillsDir();
        return readSkills(dir).map(s => new SkillItemNode(s, dir));
    }
}
