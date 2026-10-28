import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FileIndex } from './fileSuggestions';
import { getBinary, readApiKeyFromConfig, fetchModelsViaCli, getFuseraftHomeEnvOverride } from './fuseraftUtils';
import { readSkills, getSkillsDir } from './skillsTreeProvider';
import { showDiffPreview, closeDiffPreview } from './diffContentProvider';

interface ReplEvent {
    type: string;
    [key: string]: unknown;
}

export class ReplPanelProvider {
    private static _current: ReplPanelProvider | undefined;
    static extensionUri: vscode.Uri;

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
    static show(model: string, resumeId?: string, cwd?: string, fresh = false): void {
        if (ReplPanelProvider._current) {
            const cur = ReplPanelProvider._current;
            if (!fresh && (!resumeId || cur._sessionId === resumeId)) {
                if (cur._alive) {
                    // Same live session — just bring it into view.
                    cur._panel.reveal(vscode.ViewColumn.Beside);
                    return;
                }
                // Session is dead — dispose the stale panel and fall through to open a fresh one.
            } else {
                // Different session requested — close the current panel.
                cur._proc?.kill();
            }
            ReplPanelProvider._current = undefined;
            cur._panel.dispose();
        }
        const panel = vscode.window.createWebviewPanel(
            'fuseraftRepl',
            resumeId ? `fuseraft REPL · ${resumeId}` : 'fuseraft REPL',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                enableFindWidget: true,
                localResourceRoots: [vscode.Uri.joinPath(ReplPanelProvider.extensionUri, 'media')],
            }
        );
        panel.iconPath = vscode.Uri.joinPath(ReplPanelProvider.extensionUri, 'media', 'icon.png');
        ReplPanelProvider._current = new ReplPanelProvider(panel, model, resumeId, cwd);
    }

    private readonly _panel: vscode.WebviewPanel;
    private _proc: cp.ChildProcess | undefined;
    private _buf = '';
    private _alive = false;
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

    private constructor(panel: vscode.WebviewPanel, model: string, resumeId?: string, cwd?: string) {
        this._panel    = panel;
        this._sessionId = resumeId;   // refined to actual sessionId once CLI emits 'ready'
        this._cwd      = cwd;
        panel.webview.html = this._html();

        panel.webview.onDidReceiveMessage((msg: {
            type: string; text?: string; model?: string; approved?: boolean; answer?: string | null;
            images?: { name: string; data: string }[]; path?: string; query?: string; title?: string;
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
            } else if (msg.type === 'open_file' && typeof msg.path === 'string') {
                this._openFile(msg.path);
            } else if (msg.type === 'open_text' && typeof msg.text === 'string') {
                void vscode.workspace.openTextDocument({ content: msg.text, language: 'plaintext' })
                    .then(doc => vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active }));
            } else if (msg.type === 'file_suggest' && typeof msg.query === 'string') {
                const query = msg.query;
                this._files ??= this._cwd ? new FileIndex(this._cwd) : undefined;
                void (this._files?.suggest(query) ?? Promise.resolve([])).then(items =>
                    this._panel.webview.postMessage({ type: 'file_suggestions', query, items }));
            }
        });

        panel.onDidDispose(() => {
            this._proc?.kill();
            ReplPanelProvider._current = undefined;
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
                        this._panel.webview.postMessage(evt);
                    }
                } catch {
                    // non-JSON line — informational output from the CLI, ignore
                }
            }
        });

        this._proc.on('exit', () => {
            this._alive = false;
            if (this._sessionEndSent) { return; }
            try { this._panel.webview.postMessage({ type: 'session_end' }); } catch { /* panel disposed */ }
        });

        this._proc.on('error', (err: Error) => {
            try { this._panel.webview.postMessage({ type: 'error', text: err.message }); } catch { /* panel disposed */ }
        });
    }

    private _openFile(file: string): void {
        const full = path.isAbsolute(file) ? file : path.join(this._cwd ?? '', file);
        if (!fs.existsSync(full)) {
            vscode.window.showWarningMessage(`${file} no longer exists.`);
            return;
        }
        void vscode.window.showTextDocument(vscode.Uri.file(full), { preview: true, viewColumn: vscode.ViewColumn.One });
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
                this._panel.webview.postMessage({ type: 'models', list: result.list, current: result.current });
            }
        });
    }

    /** Feeds the webview the $skill-name completion list — matched against the skill's frontmatter
     *  `name` (not its directory slug), mirroring how ReplTurn resolves `$<skill-name>` invocations. */
    private _fetchSkills(): void {
        try {
            const names = readSkills(getSkillsDir()).map(s => s.name);
            this._panel.webview.postMessage({ type: 'skills', list: names });
        } catch { /* skills dir missing/unreadable — webview just gets no skill completions */ }
    }

    private _setTabTitle(title: string | undefined): void {
        this._panel.title = title ? `fuseraft · ${title}`
            : this._sessionId ? `fuseraft REPL · ${this._sessionId}` : 'fuseraft REPL';
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
    <button id="attach-btn" title="Attach files" disabled>
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
