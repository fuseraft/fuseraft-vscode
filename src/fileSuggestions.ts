import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

/** A suggestion for an @path mention: the path relative to the REPL's directory, and whether it's a directory. */
export interface FileSuggestion {
    path: string;
    dir: boolean;
}

const MAX_SUGGESTIONS = 12;
const INDEX_TTL_MS = 30_000;

// The CLI refuses to attach these by default, so offering them would only lead to an error.
const SECRET_FILE = /^\.env(\..+)?$/i;
const SECRET_OK = /^\.env\.(example|sample|template|dist)$/i;

/** Workspace files for @path completion, re-read at most every 30 s; follows .gitignore when the folder is a git repo. */
export class FileIndex {
    private _files: string[] = [];
    private _dirs: string[] = [];
    private _builtAt = 0;
    private _building: Promise<void> | undefined;

    constructor(private readonly _root: string) {}

    async suggest(query: string): Promise<FileSuggestion[]> {
        await this._ensure();
        return suggestPaths(this._files, this._dirs, query);
    }

    private _ensure(): Promise<void> {
        if (Date.now() - this._builtAt < INDEX_TTL_MS) { return Promise.resolve(); }
        this._building ??= this._build().finally(() => { this._building = undefined; });
        return this._building;
    }

    private async _build(): Promise<void> {
        const files = (await gitFiles(this._root)) ?? (await searchFiles(this._root));
        this._files = files.filter(f => !isSecret(f));
        const dirs = new Set<string>();
        for (const f of this._files) {
            for (let d = path.posix.dirname(f); d !== '.' && d !== '/'; d = path.posix.dirname(d)) {
                if (dirs.has(d)) { break; }
                dirs.add(d);
            }
        }
        this._dirs = [...dirs];
        this._builtAt = Date.now();
    }
}

function isSecret(file: string): boolean {
    const name = path.posix.basename(file);
    return SECRET_FILE.test(name) && !SECRET_OK.test(name);
}

function gitFiles(root: string): Promise<string[] | undefined> {
    return new Promise(resolve => {
        cp.execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
            { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
                if (err) { resolve(undefined); return; }
                resolve(stdout.split('\0').filter(Boolean));
            });
    });
}

async function searchFiles(root: string): Promise<string[]> {
    const pattern = new vscode.RelativePattern(root, '**/*');
    const uris = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git,bin,obj,out,dist}/**', 20_000);
    return uris.map(u => path.relative(root, u.fsPath).split(path.sep).join('/'));
}

/**
 * What the full-screen REPL offers after an @: the entries one level down from the directory typed so far, then files
 * anywhere whose name starts with what was typed.
 */
export function suggestPaths(files: string[], dirs: string[], query: string): FileSuggestion[] {
    const q = query.replace(/^\.\//, '');
    const slash = q.lastIndexOf('/');
    const dir = slash >= 0 ? q.slice(0, slash) : '';
    const leaf = q.slice(slash + 1).toLowerCase();
    const out: FileSuggestion[] = [];
    const seen = new Set<string>();
    const add = (p: string, isDir: boolean) => {
        if (out.length >= MAX_SUGGESTIONS || seen.has(p)) { return; }
        seen.add(p);
        out.push({ path: p, dir: isDir });
    };
    const childOf = (p: string) => (dir ? p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/')
                                        : !p.includes('/'));
    const named = (p: string) => path.posix.basename(p).toLowerCase().startsWith(leaf);

    for (const d of dirs.filter(d => childOf(d) && named(d)).sort()) { add(d, true); }
    for (const f of files.filter(f => childOf(f) && named(f)).sort()) { add(f, false); }
    if (!dir && leaf) {
        for (const f of files.filter(named).sort((a, b) => a.length - b.length || a.localeCompare(b))) { add(f, false); }
    }
    return out;
}
