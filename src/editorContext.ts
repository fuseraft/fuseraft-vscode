import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

/** The file editor the user last worked in, as the chat panel shows it. Lines are 1-based; absent when nothing is selected. */
export interface ActiveFile {
    path: string;
    name: string;
    startLine?: number;
    endLine?: number;
}

/** A selection attached to a message: the code goes in the message itself, so the agent needn't read the file. */
export interface SelectionAttachment {
    /** Empty for a buffer that isn't saved to disk (Untitled-1), which `name` stands in for. */
    path: string;
    name: string;
    startLine: number;
    endLine: number;
    language: string;
    /** Absent when the selection is too long to inline; the message then names the lines instead. */
    text?: string;
}

const MAX_INLINE_SELECTION_CHARS = 20_000;
// Editors that aren't where you work: panels you glance at, and the approval diff the chat itself opens.
const NOT_WORKING_SCHEMES = new Set(['output', 'debug', 'fuseraft-diff']);

/**
 * Remembers the editor you last worked in (a file, or an Untitled buffer) and its selection. Focusing the chat panel leaves `activeTextEditor` undefined, so
 * the panel needs this to know which file you were in and where the cursor was.
 */
export class EditorTracker implements vscode.Disposable {
    private _uri: vscode.Uri | undefined;
    private _selection: vscode.Selection | undefined;
    private _column: vscode.ViewColumn | undefined;
    private _timer: NodeJS.Timeout | undefined;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;
    private readonly _subscriptions: vscode.Disposable[];

    constructor() {
        this._take(vscode.window.activeTextEditor);
        this._subscriptions = [
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (this._take(editor)) { this._fire(); }
            }),
            // Selections change on every arrow key and drag step; the panel only needs where they settle. One that moves in
            // a file you're not in (the agent rewriting a file open beside it) isn't you moving.
            vscode.window.onDidChangeTextEditorSelection(e => {
                const yours = e.textEditor === vscode.window.activeTextEditor
                    || e.textEditor.document.uri.toString() === this._uri?.toString();
                if (!yours || !this._take(e.textEditor)) { return; }
                clearTimeout(this._timer);
                this._timer = setTimeout(() => this._fire(), 150);
            }),
            vscode.window.tabGroups.onDidChangeTabs(() => {
                if (this._uri && !isOpenInTab(this._uri)) {
                    this._uri = this._selection = this._column = undefined;
                    this._take(vscode.window.activeTextEditor);
                    this._fire();
                }
            }),
            this._onDidChange,
        ];
    }

    /**
     * The file you were last in, if it's one of the workspace's own (its path would mean nothing to the agent
     * otherwise); none while you're in an Untitled buffer.
     */
    get activeFile(): ActiveFile | undefined {
        if (this._uri?.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(this._uri)) { return undefined; }
        const file: ActiveFile = { path: this._uri.fsPath, name: path.basename(this._uri.fsPath) };
        if (this._selection && !this._selection.isEmpty) {
            file.startLine = this._selection.start.line + 1;
            file.endLine = lastSelectedLine(this._selection) + 1;
        }
        return file;
    }

    /**
     * The editor to insert into: still visible if it's on screen, reopened where it was otherwise. Undefined when no
     * editor has been open since the extension started.
     */
    async editor(): Promise<vscode.TextEditor | undefined> {
        if (!this._uri) { return undefined; }
        const uri = this._uri;
        const visible = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
        if (visible) { return vscode.window.showTextDocument(visible.document, visible.viewColumn); }
        const editor = await vscode.window.showTextDocument(uri, { viewColumn: this._column, preview: false });
        if (this._selection) { editor.selection = this._selection; }
        return editor;
    }

    dispose(): void {
        clearTimeout(this._timer);
        this._subscriptions.forEach(d => d.dispose());
    }

    private _take(editor: vscode.TextEditor | undefined): boolean {
        if (!editor || !isWorkingEditor(editor.document.uri)) { return false; }
        this._uri = editor.document.uri;
        this._selection = editor.selection;
        this._column = editor.viewColumn;
        return true;
    }

    private _fire(): void {
        clearTimeout(this._timer);
        this._onDidChange.fire();
    }
}

/**
 * The editor's selection as a message attachment: undefined when nothing is selected, or when a buffer that isn't on
 * disk has more selected than a message carries (there's no file for the agent to read the lines from).
 */
export function selectionAttachment(editor: vscode.TextEditor): SelectionAttachment | undefined {
    const sel = editor.selection;
    if (sel.isEmpty) { return undefined; }
    const text = editor.document.getText(sel);
    if (!text.trim()) { return undefined; }
    const onDisk = editor.document.uri.scheme === 'file';
    const inline = text.length <= MAX_INLINE_SELECTION_CHARS;
    if (!onDisk && !inline) { return undefined; }
    return {
        path: onDisk ? editor.document.uri.fsPath : '',
        name: path.basename(editor.document.uri.path),
        startLine: sel.start.line + 1,
        endLine: lastSelectedLine(sel) + 1,
        language: editor.document.languageId,
        ...(inline ? { text } : {}),
    };
}

/** The context the chat panel puts ahead of a message (withContext in media/repl.js), taken back off; keep in sync with its stripContext. */
export function stripMessageContext(text: string): string {
    let s = text;
    for (;;) {
        let m: string | undefined = (
            /^The file open in the user's editor: [^\n]*\n\n/.exec(s)
            ?? /^The user referenced the following files which may be of interest in this message:\n(?:\d+\. [^\n]*\n)+\n/.exec(s)
            ?? /^The user selected [^\n]*; it is too long to include here, so read those lines\.\n\n/.exec(s)
        )?.[0];
        const sel = m === undefined ? /^The user selected this code from [^\n]*:\n(`{3,})[^\n]*\n/.exec(s) : null;
        if (sel) {
            const close = s.indexOf(`\n${sel[1]}\n\n`, sel[0].length - 1);
            if (close >= 0) { m = s.slice(0, close + sel[1].length + 3); }
        }
        if (m === undefined) { return s; }
        s = s.slice(m.length);
    }
}

// A selection made by dragging down to the start of the next line ends there, but takes nothing from it.
function lastSelectedLine(sel: vscode.Selection): number {
    return sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
}

/** The Ctrl+G draft lives in the temp dir and is the prompt itself, not a file to talk about. */
export function isDraft(uri: vscode.Uri): boolean {
    return uri.scheme === 'file'
        && path.dirname(uri.fsPath) === os.tmpdir() && path.basename(uri.fsPath).startsWith('fuseraft-draft-');
}

function isWorkingEditor(uri: vscode.Uri): boolean {
    return !NOT_WORKING_SCHEMES.has(uri.scheme) && !isDraft(uri);
}

// Either side of a diff counts, and a notebook cell is open while its notebook is (a cell's URI is the notebook's path
// with the cell in its fragment).
function isOpenInTab(uri: vscode.Uri): boolean {
    const key = uri.toString();
    const opens = (other: vscode.Uri) => other.toString() === key
        || (uri.scheme === 'vscode-notebook-cell' && other.path === uri.path);
    return vscode.window.tabGroups.all.some(g => g.tabs.some(t => {
        const input = t.input;
        return input instanceof vscode.TabInputText ? opens(input.uri)
            : input instanceof vscode.TabInputTextDiff ? opens(input.modified) || opens(input.original)
            : input instanceof vscode.TabInputNotebook ? opens(input.uri)
            : false;
    }));
}
