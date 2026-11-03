import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileIndex } from './fileSuggestions';
import { getBinary, readApiKeyFromConfig, fetchModelsViaCli, getFuseraftHomeEnvOverride, readReplSessions } from './fuseraftUtils';
import { readSkills, getSkillsDir } from './skillsTreeProvider';
import { showDiffPreview, closeDiffPreview } from './diffContentProvider';
import { EditorTracker, SelectionAttachment } from './editorContext';
import { isConfigured } from './setupWizard';

const VIEW_TYPE = 'fuseraftRepl';

function sameTab(a: vscode.Tab, b: vscode.Tab): boolean {
    return a === b || (a.group.viewColumn === b.group.viewColumn && a.label === b.label);
}

// A tab's webview view type carries a prefix VS Code adds (mainThreadWebview-fuseraftRepl).
function isChatTab(tab: vscode.Tab): boolean {
    return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(VIEW_TYPE);
}
const SESSION_KEY = 'fuseraft.chatSession';

/** How many file paths one check_paths message may ask about; the webview sends them in batches of this size. */
const MAX_PATH_CHECKS = 200;

interface ReplEvent {
    type: string;
    [key: string]: unknown;
}

export class ReplPanelProvider {
    private static _current: ReplPanelProvider | undefined;
    static extensionUri: vscode.Uri;
    static editors: EditorTracker;
    /** The workspace's state, where the chat's session is kept for a reload (see show). */
    static memento: vscode.Memento | undefined;

    /** Whether the chat panel is the active editor tab. */
    static get isActive(): boolean {
        return ReplPanelProvider._current?._panel.active ?? false;
    }

    static get liveSessionId(): string | undefined {
        const cur = ReplPanelProvider._current;
        return cur?._alive ? cur._sessionId : undefined;
    }

    /** The live chat's titles as its CLI last reported them (null: none), ahead of the snapshot that saves them; undefined when unknown. */
    static get liveTitle(): { title: string | null; autoTitle: string | null } | undefined {
        const cur = ReplPanelProvider._current;
        return cur?._alive && cur._title !== undefined ? { title: cur._title, autoTitle: cur._autoTitle } : undefined;
    }

    private static readonly _onDidChangeLiveTitle = new vscode.EventEmitter<void>();
    static readonly onDidChangeLiveTitle = ReplPanelProvider._onDidChangeLiveTitle.event;

    /** Renames the open chat through its CLI; an empty title clears it. */
    static setLiveTitle(title: string): void {
        ReplPanelProvider._current?._send({ type: 'user_input', text: title ? `/title ${title}` : '/title --clear' });
    }

    /** `fresh` replaces a live chat instead of revealing it; the replaced chat stays resumable from its snapshot. */
    static show(model: string, resumeId?: string, cwd?: string, fresh = false, column = vscode.ViewColumn.Beside): void {
        if (ReplPanelProvider._opening) { return; }
        // Without a provider the CLI exits as soon as it starts, leaving a chat you can't type in; set one up first.
        // The wizard offers to start a chat once it's saved.
        if ((!ReplPanelProvider._current || ReplPanelProvider._current._exited) && !isConfigured()) {
            void vscode.commands.executeCommand('fuseraft.setup');
            return;
        }
        if (ReplPanelProvider._current) {
            const cur = ReplPanelProvider._current;
            if (!fresh && (!resumeId || cur._sessionId === resumeId)) {
                if (!cur._exited) {
                    // Same live session — just bring it into view, in the column it's already in.
                    cur._panel.reveal();
                    cur._post({ type: 'focus_input' });
                    return;
                }
                // Session has ended — dispose the stale panel and fall through to open a fresh one.
            } else {
                // Different session requested — close the current panel.
                cur._proc?.kill();
            }
            ReplPanelProvider._current = undefined;
            cur._panel.dispose();
        } else {
            // VS Code restores a chat tab kept across a reload only once the tab is shown. Until then it's this
            // workspace's chat all the same, so rather than start a second chat beside it, it's closed and its chat
            // resumed here.
            const stale = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(isChatTab);
            if (stale.length > 0) {
                const id = !fresh && !resumeId ? ReplPanelProvider.memento?.get<string>(SESSION_KEY) : undefined;
                const saved = id ? readReplSessions().find(s => s.sessionId === id) : undefined;
                const opening: { then: ((cur: ReplPanelProvider) => void)[] } = { then: [] };
                ReplPanelProvider._opening = opening;
                // The old tab is closed before the new panel opens: closed after, it can take the new one with it.
                void Promise.resolve(vscode.window.tabGroups.close(stale)).then(() => true, () => false).then(() => {
                    ReplPanelProvider._opening = undefined;
                    const cur = ReplPanelProvider._open(saved?.modelId ?? model, saved?.sessionId ?? resumeId, cwd, column);
                    opening.then.forEach(f => f(cur));
                });
                return;
            }
        }
        ReplPanelProvider._open(model, resumeId, cwd, column);
    }

    /** While show waits for an old chat tab to close: what to do with the new chat once it's open. */
    private static _opening: { then: ((cur: ReplPanelProvider) => void)[] } | undefined;

    private static _open(model: string, resumeId: string | undefined, cwd: string | undefined, column: vscode.ViewColumn): ReplPanelProvider {
        const panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            resumeId ? `fuseraft REPL · ${resumeId}` : 'fuseraft REPL',
            column,
            { ...ReplPanelProvider._webviewOptions(), retainContextWhenHidden: true, enableFindWidget: true }
        );
        return ReplPanelProvider._current = new ReplPanelProvider(panel, model, resumeId, cwd);
    }

    /**
     * A chat panel VS Code kept across a window reload: its chat is resumed in it. One that never got as far as a
     * saved session starts a new chat instead, since there's nothing to resume.
     */
    static restore(panel: vscode.WebviewPanel, state: { sessionId?: unknown } | undefined, cwd?: string): void {
        // A chat was opened (or is opening) before this tab was shown: there's one chat at a time, and it's that one.
        if (ReplPanelProvider._current || ReplPanelProvider._opening) {
            panel.dispose();
            ReplPanelProvider._current?._panel.reveal();
            return;
        }
        panel.webview.options = ReplPanelProvider._webviewOptions();
        const id = typeof state?.sessionId === 'string' ? state.sessionId : undefined;
        const saved = id ? readReplSessions().find(s => s.sessionId === id) : undefined;
        ReplPanelProvider._current = new ReplPanelProvider(panel, saved?.modelId ?? '', saved?.sessionId, cwd);
    }

    /**
     * Restarting the extension host (as updating an extension does) leaves the chat tab showing its conversation with
     * nothing behind it, and VS Code never restores it. A chat tab that's on screen but still isn't the live chat a
     * moment later is one of those: it's closed, and the chat goes on in a working panel where it was.
     */
    static watchForOrphans(cwd: () => string | undefined): vscode.Disposable {
        let timer: NodeJS.Timeout | undefined;
        const check = () => {
            clearTimeout(timer);
            timer = setTimeout(() => ReplPanelProvider._replaceOrphans(cwd()), 1500);
        };
        check();
        return vscode.Disposable.from(
            vscode.window.tabGroups.onDidChangeTabs(check),
            vscode.window.tabGroups.onDidChangeTabGroups(check),
            new vscode.Disposable(() => clearTimeout(timer)),
        );
    }

    private static _replaceOrphans(cwd: string | undefined): void {
        const cur = ReplPanelProvider._current;
        const shown = vscode.window.tabGroups.all.map(g => g.activeTab).filter((t): t is vscode.Tab => !!t && isChatTab(t));
        // Which shown tab is the live chat's: a panel's viewColumn is unknown until it first moves, so it's found as the
        // active tab, or by its title. When that can't be told, nothing is closed.
        let mine: vscode.Tab | undefined;
        if (cur?._panel.visible) {
            const titled = shown.filter(t => t.label === cur._panel.title);
            mine = cur._panel.active ? vscode.window.tabGroups.activeTabGroup.activeTab
                : titled.length === 1 ? titled[0] : undefined;
            if (!mine || !isChatTab(mine)) { return; }
        }
        const orphans = shown.filter(t => !mine || !sameTab(t, mine));
        if (orphans.length === 0) { return; }
        if (cur) {
            void vscode.window.tabGroups.close(orphans);
            cur._panel.reveal();
        } else {
            // show closes every chat tab nothing is behind before it opens the chat again.
            ReplPanelProvider.show('', undefined, cwd, false, orphans[0].group.viewColumn);
        }
    }

    /** Adds files and selections to the message being written, opening a chat first if none is live. */
    static attach(files: { name: string; path: string }[], selections: SelectionAttachment[], cwd?: string): void {
        const deliver = (cur: ReplPanelProvider) => {
            cur._panel.reveal();
            cur._post({
                type: 'attach',
                files,
                selections: selections.map(s => ({ ...s, rel: s.path ? cur._display(s.path) : s.name })),
            });
        };
        if (!ReplPanelProvider._current || ReplPanelProvider._current._exited) { ReplPanelProvider.show('', undefined, cwd); }
        if (ReplPanelProvider._opening) { ReplPanelProvider._opening.then.push(deliver); }
        else if (ReplPanelProvider._current && !ReplPanelProvider._current._exited) { deliver(ReplPanelProvider._current); }
    }

    private static _webviewOptions(): vscode.WebviewOptions {
        return {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(ReplPanelProvider.extensionUri, 'media')],
        };
    }

    private readonly _panel: vscode.WebviewPanel;
    private _proc: cp.ChildProcess | undefined;
    private _buf = '';
    private _alive = false;
    /** Set once the CLI process has gone; before that a chat counts as live, even while it's still starting. */
    private _exited = false;
    /** Session ID of the currently running session (set to resumeId when resuming). */
    private _sessionId: string | undefined;
    /** Set once the CLI's own session_end event has been relayed, so the exit handler doesn't send a second one. */
    private _sessionEndSent = false;
    private _title: string | null | undefined;
    private _autoTitle: string | null = null;
    private readonly _cwd: string | undefined;
    private _files: FileIndex | undefined;
    /** When the user last sent something; a reply or question after a while away gets a notification. */
    private _lastInputAt = Date.now();
    private _draft: vscode.Disposable | undefined;
    /** Messages for the webview held until its script is listening; ones posted before then would be lost. */
    private _pending: object[] | undefined = [];

    private constructor(panel: vscode.WebviewPanel, model: string, resumeId?: string, cwd?: string) {
        this._panel    = panel;
        this._sessionId = resumeId;   // refined to actual sessionId once CLI emits 'ready'
        this._cwd      = cwd;
        panel.iconPath = vscode.Uri.joinPath(ReplPanelProvider.extensionUri, 'media', 'icon.png');
        panel.webview.html = this._html();
        const editorWatch = vscode.Disposable.from(
            ReplPanelProvider.editors?.onDidChange(() => this._postActiveFile()) ?? new vscode.Disposable(() => {}),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('fuseraft.includeActiveFile')) { this._postActiveFile(); }
            }),
        );

        panel.webview.onDidReceiveMessage((msg: {
            type: string; text?: string; model?: string; approved?: boolean; answer?: string | null;
            images?: { name: string; data: string }[]; path?: string; query?: string; title?: string;
            line?: number; endLine?: number; lang?: string; paths?: unknown; uris?: unknown; on?: boolean;
        }) => {
            if (msg.type === 'user_input' || msg.type === 'approval_response' || msg.type === 'question_response') {
                this._lastInputAt = Date.now();
            }
            if (msg.type === 'user_input' && msg.text !== undefined) {
                // Pasted screenshots ride along as base64 (data URLs); the CLI re-validates the bytes itself.
                const images = Array.isArray(msg.images)
                    ? msg.images.filter(i => i && typeof i.data === 'string' && typeof i.name === 'string')
                    : [];
                this._send(images.length > 0
                    ? { type: 'user_input', text: msg.text, images }
                    : { type: 'user_input', text: msg.text });
            } else if (msg.type === 'approval_response' && typeof msg.approved === 'boolean') {
                this._send({ type: 'approval_response', approved: msg.approved });
                void closeDiffPreview();
            } else if (msg.type === 'question_response') {
                this._send({ type: 'question_response', answer: typeof msg.answer === 'string' ? msg.answer : null });
            } else if (msg.type === 'interrupt') {
                if (process.platform === 'win32') {
                    // Windows has no equivalent of SIGINT for child processes; send the
                    // interrupt as a JSON message over stdin so the CLI can cancel the
                    // active request without terminating the session.
                    this._proc?.stdin?.write(JSON.stringify({ type: 'interrupt' }) + '\n');
                } else {
                    this._proc?.kill('SIGINT');
                }
            } else if (msg.type === 'model_change' && msg.model) {
                this._send({ type: 'user_input', text: `/model ${msg.model}` });
            } else if (msg.type === 'pick_files') {
                vscode.window.showOpenDialog({
                    canSelectMany: true,
                    openLabel: 'Attach',
                    title: 'Attach files to message',
                }).then(uris => {
                    if (uris && uris.length > 0) {
                        this._panel.webview.postMessage({
                            type: 'files_picked',
                            files: uris.map(u => ({
                                name: u.fsPath.split(/[/\\]/).pop() ?? u.fsPath,
                                path: u.fsPath,
                            })),
                        });
                    }
                });
            } else if (msg.type === 'open_setup') {
                void vscode.commands.executeCommand('fuseraft.setup');
            } else if (msg.type === 'webview_ready') {
                const pending = this._pending ?? [];
                this._pending = undefined;
                this._postActiveFile();
                pending.forEach(m => this._panel.webview.postMessage(m));
            } else if (msg.type === 'open_file' && typeof msg.path === 'string') {
                this._openFile(msg.path, msg.line, msg.endLine);
            } else if (msg.type === 'check_paths' && Array.isArray(msg.paths)) {
                const results: Record<string, boolean> = {};
                for (const p of msg.paths.slice(0, MAX_PATH_CHECKS)) {
                    if (typeof p === 'string') { results[p] = this._resolve(p) !== undefined; }
                }
                this._panel.webview.postMessage({ type: 'paths_checked', results });
            } else if (msg.type === 'include_active_file' && typeof msg.on === 'boolean') {
                void vscode.workspace.getConfiguration('fuseraft')
                    .update('includeActiveFile', msg.on, vscode.ConfigurationTarget.Global);
            } else if (msg.type === 'insert_code' && typeof msg.text === 'string') {
                void this._insertCode(msg.text);
            } else if (msg.type === 'open_code' && typeof msg.text === 'string') {
                void this._openCode(msg.text, typeof msg.lang === 'string' ? msg.lang : '');
            } else if (msg.type === 'drop_uris' && Array.isArray(msg.uris)) {
                const files = msg.uris
                    .filter((u): u is string => typeof u === 'string')
                    .map(u => { try { return vscode.Uri.parse(u, true); } catch { return undefined; } })
                    .filter((u): u is vscode.Uri => u?.scheme === 'file' && fs.existsSync(u.fsPath))
                    .map(u => ({ name: path.basename(u.fsPath), path: u.fsPath }));
                if (files.length > 0) { this._post({ type: 'attach', files, selections: [] }); }
            } else if (msg.type === 'open_text' && typeof msg.text === 'string') {
                void vscode.workspace.openTextDocument({ content: msg.text, language: 'plaintext' })
                    .then(doc => vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active }));
            } else if (msg.type === 'edit_draft' && typeof msg.text === 'string') {
                void this._editDraft(msg.text);
            } else if (msg.type === 'file_suggest' && typeof msg.query === 'string') {
                const query = msg.query;
                this._files ??= this._cwd ? new FileIndex(this._cwd) : undefined;
                void (this._files?.suggest(query) ?? Promise.resolve([])).then(items =>
                    this._panel.webview.postMessage({ type: 'file_suggestions', query, items }));
            }
        });

        panel.onDidDispose(() => {
            editorWatch.dispose();
            this._draft?.dispose();
            this._proc?.kill();
            // A panel replaced by another can go after its successor has opened.
            if (ReplPanelProvider._current === this) { ReplPanelProvider._current = undefined; }
        });

        this._spawn(model, resumeId, cwd);
        this._fetchModels(cwd);
        this._fetchSkills();
    }

    private _spawn(model: string, resumeId?: string, cwd?: string): void {
        const args = ['repl', '--vscode', '--no-banner'];
        if (model) { args.push('--model', model); }
        if (resumeId) { args.push('--resume', resumeId); }

        // The REPL is sandboxed to its launch directory (cwd = the first workspace folder), so any
        // additional folders in a multi-root workspace would otherwise need a per-access approval.
        // Pass them as --include roots. The CLI aborts startup if an --include path is missing,
        // so only pass folders that exist locally; it skips any already inside the sandbox root.
        if (cwd) {
            for (const folder of vscode.workspace.workspaceFolders ?? []) {
                const root = folder.uri.fsPath;
                if (folder.uri.scheme === 'file' && root !== cwd && fs.existsSync(root)) {
                    args.push('--include', root);
                }
            }
        }

        // Inherit the full environment. Inject FUSERAFT_API_KEY from the saved
        // config only when the variable is not already present — an explicitly
        // set env var always takes priority.  On Windows the CLI subprocess may
        // not resolve ~/.fuseraft/config through the same home-directory path
        // that the extension used when writing it, so the env var is the
        // reliable channel for the key.
        const configKey = readApiKeyFromConfig();
        const env: NodeJS.ProcessEnv = { ...process.env, ...getFuseraftHomeEnvOverride() };
        // Tells the CLI this panel answers ask_user `question` events; a CLI that predates them ignores it.
        env['FUSERAFT_VSCODE_QUESTIONS'] = '1';
        if (configKey && !env['FUSERAFT_API_KEY']) { env['FUSERAFT_API_KEY'] = configKey; }

        this._proc = cp.spawn(getBinary(), args, {
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            ...(cwd ? { cwd } : {}),
        });

        this._proc.stdout?.on('data', (chunk: Buffer) => {
            this._buf += chunk.toString();
            const lines = this._buf.split('\n');
            this._buf = lines.pop() ?? '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) { continue; }
                try {
                    const evt = JSON.parse(trimmed) as ReplEvent;
                    if (evt.type) {
                        // Capture the authoritative session ID from the CLI's ready event
                        // so that same-session reveal works correctly for new sessions too.
                        if (evt.type === 'ready' && typeof evt.sessionId === 'string') {
                            this._sessionId = evt.sessionId as string;
                            this._alive = true;
                        }
                        // A title event also follows a /switch or /fork switch, naming the session the chat now runs as.
                        if (evt.type === 'title' && typeof evt.sessionId === 'string') {
                            this._sessionId = evt.sessionId;
                        }
                        if ((evt.type === 'ready' || evt.type === 'title') && this._sessionId) {
                            void ReplPanelProvider.memento?.update(SESSION_KEY, this._sessionId);
                        }
                        if (evt.type === 'ready' || evt.type === 'title') {
                            this._title = typeof evt.title === 'string' ? evt.title : null;
                            this._autoTitle = typeof evt.autoTitle === 'string' ? evt.autoTitle : null;
                            this._setTabTitle(this._title ?? this._autoTitle ?? undefined);
                            if (evt.type === 'title') { ReplPanelProvider._onDidChangeLiveTitle.fire(); }
                        }
                        if (evt.type === 'session_end') {
                            this._sessionEndSent = true;
                        }
                        if (evt.type === 'copy' && typeof evt.text === 'string') {
                            void vscode.env.clipboard.writeText(evt.text);
                        }
                        this._notifyIfAway(evt);
                        // write_file/patch_file approvals carry full before/after file content —
                        // open it as a native diff editor tab (syntax-highlighted, side-by-side)
                        // rather than trying to cram it into the webview's compact approval bar.
                        if (evt.type === 'approval_request' && evt.kind === 'file_write') {
                            const filePath    = typeof evt.path === 'string' ? evt.path : 'file';
                            const oldContent  = typeof evt.oldContent === 'string' ? evt.oldContent : '';
                            const newContent  = typeof evt.newContent === 'string' ? evt.newContent : '';
                            const actionLabel = typeof evt.action === 'string' ? evt.action : 'write';
                            showDiffPreview(filePath, oldContent, newContent, actionLabel);
                            const rel = this._cwd ? path.relative(this._cwd, filePath) : '';
                            if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { evt.displayPath = rel; }
                        }
                        this._post(evt);
                    }
                } catch {
                    // non-JSON line — informational output from the CLI, ignore
                }
            }
        });

        this._proc.on('exit', () => {
            this._alive = false;
            this._exited = true;
            if (this._sessionEndSent) { return; }
            try { this._post({ type: 'session_end' }); } catch { /* panel disposed */ }
        });

        this._proc.on('error', (err: Error) => {
            // A CLI that couldn't be started emits no exit.
            this._exited = true;
            try {
                this._post({ type: 'error', text: err.message });
                if (!this._sessionEndSent) { this._sessionEndSent = true; this._post({ type: 'session_end' }); }
            } catch { /* panel disposed */ }
        });
    }

    /**
     * Ctrl+G: the draft in an editor tab beside the panel, as $EDITOR is in the terminal. Each save puts it back in
     * the prompt; closing the tab ends the edit.
     */
    private async _editDraft(text: string): Promise<void> {
        this._draft?.dispose();
        const file = path.join(os.tmpdir(), `fuseraft-draft-${process.pid}.md`);
        fs.writeFileSync(file, text);
        const uri = vscode.Uri.file(file);
        const same = (doc: vscode.TextDocument) => doc.uri.fsPath === uri.fsPath;
        const subscriptions = [
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (same(doc)) {
                    this._panel.webview.postMessage({ type: 'draft', text: doc.getText().replace(/\r\n/g, '\n').replace(/\n+$/, '') });
                }
            }),
            vscode.workspace.onDidCloseTextDocument(doc => { if (same(doc)) { this._draft?.dispose(); } }),
        ];
        const draft = new vscode.Disposable(() => {
            subscriptions.forEach(d => d.dispose());
            fs.rmSync(file, { force: true });
            if (this._draft === draft) { this._draft = undefined; }
        });
        this._draft = draft;
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
        void vscode.window.setStatusBarMessage('fuseraft: save to put the draft back in the prompt; close the tab when done', 6000);
    }

    private _openFile(file: string, line?: number, endLine?: number): void {
        const full = this._resolve(file);
        if (!full) {
            vscode.window.showWarningMessage(`${file} no longer exists.`);
            return;
        }
        const options: vscode.TextDocumentShowOptions = { preview: true, viewColumn: vscode.ViewColumn.One };
        if (typeof line === 'number' && line >= 1) {
            const last = typeof endLine === 'number' && endLine >= line ? endLine : line;
            options.selection = last === line ? new vscode.Range(line - 1, 0, line - 1, 0) : new vscode.Range(line - 1, 0, last, 0);
        }
        void vscode.window.showTextDocument(vscode.Uri.file(full), options);
    }

    /** A path as the agent or the user wrote it — absolute, ~/, or relative to the chat's directory or another workspace folder — when it names a file. */
    private _resolve(file: string): string | undefined {
        if (file.startsWith('~/') || file.startsWith('~\\')) { file = path.join(os.homedir(), file.slice(2)); }
        const candidates = path.isAbsolute(file) ? [file]
            : [this._cwd, ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)]
                .filter((d): d is string => !!d)
                .map(d => path.join(d, file));
        return candidates.find(c => { try { return fs.statSync(c).isFile(); } catch { return false; } });
    }

    /** A path relative to the chat's directory when it's inside it, absolute otherwise. */
    private _display(file: string): string {
        const rel = this._cwd ? path.relative(this._cwd, file) : '';
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : file;
    }

    private _postActiveFile(): void {
        if (this._pending) { return; }
        const file = ReplPanelProvider.editors?.activeFile;
        const include = vscode.workspace.getConfiguration('fuseraft').get<boolean>('includeActiveFile', true);
        this._panel.webview.postMessage({ type: 'active_file', include, file: file ? { ...file, rel: this._display(file.path) } : null });
    }

    /** A reply's code block, in place of the selection (or at the cursor) in the file you were last in. */
    private async _insertCode(text: string): Promise<void> {
        const editor = await ReplPanelProvider.editors?.editor();
        if (!editor) {
            vscode.window.showWarningMessage('Open a file to insert the code into.');
            return;
        }
        if (!await editor.edit(edit => edit.replace(editor.selection, text))) {
            vscode.window.showWarningMessage(`Couldn't insert the code into ${path.basename(editor.document.fileName)}; it may be read-only.`);
        }
    }

    private async _openCode(text: string, lang: string): Promise<void> {
        const languages = await vscode.languages.getLanguages();
        const id = languageId(lang);
        const doc = await vscode.workspace.openTextDocument({ content: text, ...(languages.includes(id) ? { language: id } : {}) });
        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
    }

    // The full-screen REPL rings the bell when a turn ends or a question waits after 10 s away from the keyboard;
    // here that's a notification, when the panel isn't what you're looking at.
    private _notifyIfAway(evt: ReplEvent): void {
        const waiting = evt.type === 'approval_request' || evt.type === 'question';
        if (!waiting && evt.type !== 'message_end') { return; }
        if (!vscode.workspace.getConfiguration('fuseraft').get<boolean>('notifications', true)) { return; }
        if (this._panel.active && vscode.window.state.focused) { return; }
        if (Date.now() - this._lastInputAt < 10_000) { return; }
        const text = evt.type === 'approval_request' ? 'fuseraft is waiting for your approval.'
                   : evt.type === 'question'         ? 'fuseraft has a question for you.'
                   :                                   'fuseraft finished its reply.';
        void vscode.window.showInformationMessage(text, 'Show').then(choice => {
            if (choice === 'Show') { this._panel.reveal(); }
        });
    }

    private _fetchModels(cwd?: string): void {
        fetchModelsViaCli(cwd).then(result => {
            if (result && result.list.length > 0) {
                this._post({ type: 'models', list: result.list, current: result.current });
            }
        });
    }

    /** Feeds the webview the $skill-name completion list — matched against the skill's frontmatter
     *  `name` (not its directory slug), mirroring how ReplTurn resolves `$<skill-name>` invocations. */
    private _fetchSkills(): void {
        try {
            const names = readSkills(getSkillsDir()).map(s => s.name);
            this._post({ type: 'skills', list: names });
        } catch { /* skills dir missing/unreadable — webview just gets no skill completions */ }
    }

    private _setTabTitle(title: string | undefined): void {
        this._panel.title = title ? `fuseraft · ${title}`
            : this._sessionId ? `fuseraft REPL · ${this._sessionId}` : 'fuseraft REPL';
    }

    private _post(msg: object): void {
        if (this._pending) { this._pending.push(msg); } else { this._panel.webview.postMessage(msg); }
    }

    private _send(msg: object): void {
        this._proc?.stdin?.write(JSON.stringify(msg) + '\n');
    }

    private _mark(className: string, gradId: string): string {
        return `<svg class="${className}" viewBox="0 0 1500 1500" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="#c4452e"/><stop offset="100%" stop-color="#d98c4f"/>
  </linearGradient></defs>
  <rect width="1500" height="1500" fill="url(#${gradId})"/>
  <rect x="675" y="150" width="150" height="1200" fill="#fff"/>
  <rect x="1200" y="150" width="150" height="525" fill="#fff"/>
  <rect x="150" y="825" width="150" height="525" fill="#fff"/>
  <rect x="675" y="150" width="675" height="150" fill="#fff"/>
  <rect x="150" y="1200" width="675" height="150" fill="#fff"/>
  <rect x="300" y="675" width="900" height="150" fill="#fff"/>
</svg>`;
    }

    private _html(): string {
        const webview = this._panel.webview;
        const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(ReplPanelProvider.extensionUri, 'media', file));
        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${media('repl.css')}">
</head>
<body>
<div id="header">
  <span class="brand">${this._mark('icon-mark', 'fr-mark-header')}fuseraft REPL</span>
  <select id="model-select" disabled title="Switch model"></select>
  <span class="session" id="session-label"></span>
</div>
<div id="messages">
  <div id="welcome">
    <div id="welcome-inner">
      <div id="welcome-title">${this._mark('icon-mark', 'fr-mark-welcome')}fuseraft</div>
      <div id="welcome-hint">What would you like to work on?</div>
      <div id="welcome-input-wrap" class="disabled">
        <div id="welcome-highlight" aria-hidden="true">&nbsp;</div>
        <textarea id="welcome-input" rows="3" placeholder="Ask something or type a /command…" disabled></textarea>
      </div>
      <div id="welcome-context"></div>
      <button id="welcome-send" disabled>Send</button>
    </div>
  </div>
</div>
<div id="thinking-bar">
  <span class="dots"><span></span><span></span><span></span></span>
  <span id="thinking-label">Thinking…</span>
</div>
<div id="approval-bar">
  <div id="approval-info">
    <div id="approval-title"></div>
    <pre id="approval-detail"></pre>
  </div>
  <div class="approval-actions">
    <button class="approval-btn approval-allow" id="approval-allow-btn">Allow</button>
    <button class="approval-btn approval-deny" id="approval-deny-btn">Deny</button>
  </div>
</div>
<div id="question-bar">
  <div id="question-title"></div>
  <div id="question-options"></div>
  <div id="question-other">
    <input id="question-other-input" type="text" placeholder="Or type your own answer…">
    <button class="approval-btn approval-allow" id="question-other-btn">Send</button>
    <button class="approval-btn approval-deny" id="question-skip-btn" title="Let the agent decide">Skip</button>
  </div>
</div>
<div id="footer" style="display:none">
  <div id="attach-row"></div>
  <div id="input-row">
    <button id="attach-btn" title="Attach files (or hold Shift and drop them on the chat)" disabled>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M4.5 3a2.5 2.5 0 0 1 5 0v9a1.5 1.5 0 0 1-3 0V5a.5.5 0 0 1 1 0v7a.5.5 0 0 0 1 0V3a1.5 1.5 0 1 0-3 0v9a2.5 2.5 0 0 0 5 0V5a.5.5 0 0 1 1 0v7a3.5 3.5 0 1 1-7 0z"/>
      </svg>
    </button>
    <div id="input-wrap" class="disabled">
      <div id="input-highlight" aria-hidden="true">&nbsp;</div>
      <textarea id="input" rows="1" placeholder="Ask something or type a /command…" disabled></textarea>
    </div>
    <button id="stop">Stop</button>
    <button id="send" disabled>Send</button>
  </div>
</div>
<div id="status-line" aria-live="polite">
  <span id="st-left"></span>
  <span id="st-right"></span>
</div>
<div id="viewer" role="dialog" aria-label="Output viewer">
  <div id="viewer-head">
    <span id="viewer-title"></span>
    <span id="viewer-pos"></span>
    <span class="viewer-spacer"></span>
    <button type="button" id="viewer-prev" title="Older (←)">←</button>
    <button type="button" id="viewer-next" title="Newer (→)">→</button>
    <button type="button" id="viewer-open" title="Open in an editor tab">Open in Editor</button>
    <button type="button" id="viewer-close" title="Close (Esc)">✕</button>
  </div>
  <pre id="viewer-body"></pre>
</div>
<div id="hsearch" role="dialog" aria-label="Search earlier messages">
  <input id="hsearch-input" type="text" placeholder="Search earlier messages…" autocomplete="off">
  <div id="hsearch-list"></div>
</div>
<script src="${media('repl.js')}"></script>
</body>
</html>`;
    }
}

// Code-fence tags as models write them, for the ones whose VS Code language ID is spelled differently.
const LANGUAGE_ALIASES: Record<string, string> = {
    ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', py: 'python',
    rb: 'ruby', rs: 'rust', cs: 'csharp', 'c#': 'csharp', fs: 'fsharp', 'f#': 'fsharp', kt: 'kotlin',
    sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', shell: 'shellscript', console: 'shellscript',
    ps1: 'powershell', pwsh: 'powershell', yml: 'yaml', md: 'markdown', golang: 'go', 'c++': 'cpp',
    objc: 'objective-c', text: 'plaintext', txt: 'plaintext', plain: 'plaintext',
};

function languageId(lang: string): string {
    const l = lang.toLowerCase();
    return LANGUAGE_ALIASES[l] ?? l;
}
