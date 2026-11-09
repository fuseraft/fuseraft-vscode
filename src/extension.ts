import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReplSessionTreeProvider, ReplSessionItem, sessionTitle } from './replSessionTreeProvider';
import { MemoryTreeProvider, MemoryItemNode, readMemoryEntries } from './memoryTreeProvider';
import { SkillsTreeProvider, SkillItemNode, readSkills, getSkillsDir } from './skillsTreeProvider';
import { ReplPanelProvider } from './replPanelProvider';
import { registerDiffContentProvider } from './diffContentProvider';
import { EditorTracker, selectionAttachment, isDraft } from './editorContext';
import {
    getBinary, runInTerminal, shellQuote,
    runInstaller, runUpdate, checkCli, invalidateCliCache, disposeOutputChannel, pollForInstalledBinary,
    readReplSessions, formatRelativeTime, ReplSessionInfo,
    getMemoryReplDir, getFuseraftHome, getReplSessionsDir, writeReplSessionTitle,
} from './fuseraftUtils';
import { isConfigured, runSetupWizard } from './setupWizard';
import { chatToMarkdown, exportFileName } from './chatExport';

export function activate(context: vscode.ExtensionContext): void {
    const chatProvider = new ReplSessionTreeProvider();
    const memoryProvider = new MemoryTreeProvider();
    const skillsProvider = new SkillsTreeProvider();
    ReplPanelProvider.extensionUri = context.extensionUri;
    ReplPanelProvider.editors = new EditorTracker();
    ReplPanelProvider.memento = context.workspaceState;
    context.subscriptions.push(ReplPanelProvider.editors);
    registerDiffContentProvider(context);

    // A chat left open when the window reloads comes back, resumed.
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('fuseraftRepl', {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: { sessionId?: unknown } | undefined) {
                ReplPanelProvider.restore(panel, state, workspaceRoot());
            },
        })
    );
    context.subscriptions.push(ReplPanelProvider.watchForOrphans(workspaceRoot));

    // Tree views
    const chatView = vscode.window.createTreeView('fuseraft.chats', {
        treeDataProvider: chatProvider,
        showCollapseAll: false,
    });
    vscode.window.createTreeView('fuseraft.memory', {
        treeDataProvider: memoryProvider,
        showCollapseAll: false,
    });
    vscode.window.createTreeView('fuseraft.skills', {
        treeDataProvider: skillsProvider,
        showCollapseAll: false,
    });

    // Status bar
    // Follows the open chat, so a reply or an approval it's waiting on shows while you're in another file.
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    statusBar.command = 'fuseraft.repl';
    const renderStatusBar = () => {
        const live = ReplPanelProvider.liveStatus;
        statusBar.backgroundColor = live?.waiting ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
        if (!live) {
            statusBar.text = '$(comment-discussion) fuseraft';
            statusBar.tooltip = 'fuseraft: open a chat';
            return;
        }
        const pct = live.context !== undefined ? ` · ${Math.round(live.context * 100)}%` : '';
        statusBar.text = live.waiting === 'approval' ? '$(bell-dot) fuseraft: approval needed'
            : live.waiting === 'question' ? '$(bell-dot) fuseraft: question for you'
            : live.busy ? `$(loading~spin) ${live.model || 'fuseraft'}`
            : `$(comment-discussion) ${live.model || 'fuseraft'}${pct}`;
        const tip = new vscode.MarkdownString();
        tip.appendMarkdown(`**${live.title ? escapeMarkdown(live.title) : 'fuseraft chat'}**\n\n`);
        tip.appendMarkdown(`${escapeMarkdown(live.model)}${live.context !== undefined ? ` · ${Math.round(live.context * 100)}% of context used` : ''}\n\n`);
        tip.appendMarkdown(live.waiting ? 'Waiting for you. Click to answer.' : live.busy ? 'Working. Click to watch.' : 'Click to open the chat.');
        statusBar.tooltip = tip;
    };
    renderStatusBar();
    statusBar.show();
    context.subscriptions.push(statusBar, ReplPanelProvider.onDidChangeStatus(renderStatusBar));

    // First-run: two-phase check — CLI presence first, then config.
    (async () => {
        let cli = await checkCli();
        while (!cli.found) {
            const choice = await vscode.window.showErrorMessage(
                'fuseraft CLI not found. Install it and make sure it is on your PATH, then click Check again to continue.',
                { modal: false },
                'Install',
                'Install Instructions',
                'Set Binary Path',
                'Check again'
            );
            if (choice === 'Install') {
                vscode.commands.executeCommand('fuseraft.install');
            } else if (choice === 'Install Instructions') {
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/fuseraft/fuseraft-cli#install'));
            } else if (choice === 'Set Binary Path') {
                await vscode.commands.executeCommand('fuseraft.setBinaryPath');
                invalidateCliCache();
                cli = await checkCli();
            } else if (choice === 'Check again') {
                invalidateCliCache();
                cli = await checkCli();
            } else {
                // dismissed — stop looping
                break;
            }
        }
        if (cli.found && !isConfigured()) {
            vscode.commands.executeCommand('fuseraft.setup');
        }
    })();

    // Invalidate the CLI cache whenever the user changes the binary path setting.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('fuseraft.binaryPath')) {
                invalidateCliCache();
                void checkCli();
            }
        })
    );

    // Re-arm the global-state tree views whenever the home directory setting changes,
    // since they each watch a directory computed from it (~/.fuseraft/... by default).
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('fuseraft.homeDir')) {
                chatProvider.resetWatcher();
                memoryProvider.resetWatcher();
                skillsProvider.resetWatcher();
            }
        })
    );

    // ---- Commands ----

    // fuseraft.repl — bring the live chat into view, or start one with the configured model.
    // The keybinding passes 'toggle': pressed in the chat, it goes back to the file you were in.
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.repl', async (arg?: 'toggle') => {
            if (arg === 'toggle' && ReplPanelProvider.isActive) {
                if (!await ReplPanelProvider.editors.editor()) {
                    await vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
                }
                return;
            }
            ReplPanelProvider.show('', undefined, workspaceRoot());
        })
    );

    // fuseraft.addToChat — the editor's selection, or its whole file when nothing is selected
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.addToChat', () => {
            const editor = vscode.window.activeTextEditor;
            const uri = editor?.document.uri;
            if (!editor || !uri || isDraft(uri)) {
                vscode.window.showInformationMessage('Open a file and select some code to add it to the chat.');
                return;
            }
            const selection = selectionAttachment(editor);
            if (selection) {
                ReplPanelProvider.attach([], [selection], workspaceRoot());
            } else if (uri.scheme === 'file') {
                ReplPanelProvider.attach([{ name: path.basename(uri.fsPath), path: uri.fsPath }], [], workspaceRoot());
            } else {
                vscode.window.showInformationMessage(editor.selection.isEmpty
                    ? 'Select some code to add it to the chat, or save the file to add all of it.'
                    : 'That selection is too long to add from an unsaved file. Save it first, then add it.');
            }
        })
    );

    // fuseraft.addFileToChat — the Explorer's selected files and folders, or a tab's file
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.addFileToChat', (uri?: vscode.Uri, uris?: unknown) => {
            const picked = Array.isArray(uris) && uris.length > 0 ? uris as vscode.Uri[] : uri ? [uri] : [];
            const files = picked
                .filter(u => u instanceof vscode.Uri && u.scheme === 'file')
                .map(u => ({ name: path.basename(u.fsPath), path: u.fsPath }));
            if (files.length > 0) { ReplPanelProvider.attach(files, [], workspaceRoot()); }
        })
    );

    // fuseraft.fixDiagnostic — "Fix with fuseraft" on an error or warning: the code around it, and the problem as the prompt
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new FixWithFuseraft(), {
            providedCodeActionKinds: FixWithFuseraft.kinds,
        }),
        vscode.commands.registerCommand('fuseraft.fixDiagnostic', async (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
            const doc = await vscode.workspace.openTextDocument(uri);
            const start = Math.max(0, diagnostic.range.start.line - FIX_CONTEXT_LINES);
            const end = Math.min(doc.lineCount - 1, diagnostic.range.end.line + FIX_CONTEXT_LINES);
            const code = doc.getText(new vscode.Range(start, 0, end, doc.lineAt(end).text.length));
            const selection = {
                path: uri.fsPath, name: path.basename(uri.fsPath), startLine: start + 1, endLine: end + 1,
                language: doc.languageId, text: code,
            };
            ReplPanelProvider.attach([], [selection], workspaceRoot(), describeDiagnostic(diagnostic));
        })
    );

    // fuseraft.replNew — start a fresh chat, replacing a live one (which stays resumable)
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.replNew', () => {
            ReplPanelProvider.show('', undefined, workspaceRoot(), true);
        })
    );

    // fuseraft.replResume — resume the clicked chat, or pick one from every saved session
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.replResume', async (arg?: ReplSessionItem) => {
            if (arg?.session?.sessionId) {
                ReplPanelProvider.show(arg.session.modelId, arg.session.sessionId, workspaceRoot());
                return;
            }
            const sessions = readReplSessions();
            if (sessions.length === 0) {
                vscode.window.showInformationMessage('No saved chats found.');
                return;
            }
            await pickAndResumeReplSession(sessions, workspaceRoot());
        })
    );

    // fuseraft.replDelete — delete a saved chat's snapshot
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.replDelete', async (arg?: ReplSessionItem) => {
            if (!arg?.session?.sessionId) { return; }
            const { session } = arg;
            if (ReplPanelProvider.liveSessionId === session.sessionId) {
                vscode.window.showWarningMessage('That chat is still open. Close its panel before deleting it.');
                return;
            }
            const preview = session.firstUserMessage ? sessionTitle(session) : '';
            const confirm = await vscode.window.showWarningMessage(
                `Delete chat ${session.sessionId}?${preview ? `\n"${preview}"` : ''}`,
                { modal: true },
                'Delete'
            );
            if (confirm !== 'Delete') { return; }

            try {
                fs.unlinkSync(path.join(getReplSessionsDir(), `repl-${session.sessionId}.json`));
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Could not delete chat: ${err instanceof Error ? err.message : String(err)}`);
            }
            chatProvider.refresh();
        })
    );

    // fuseraft.replExport — a saved chat as Markdown, to read or share
    // fuseraft.replRename — name a chat; an empty name goes back to its first message
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.replExport', async (arg?: ReplSessionItem) => {
            const session = (arg ?? chatView.selection[0])?.session;
            if (!session?.sessionId) { return; }
            let markdown: string;
            try {
                markdown = chatToMarkdown(session);
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Couldn't read that chat: ${err instanceof Error ? err.message : String(err)}`);
                return;
            }
            const folder = workspaceRoot() ?? os.homedir();
            const target = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(folder, exportFileName(session))),
                filters: { Markdown: ['md'] },
                saveLabel: 'Export',
                title: 'Export chat to Markdown',
            });
            if (!target) { return; }
            await vscode.workspace.fs.writeFile(target, Buffer.from(markdown, 'utf8'));
            await vscode.window.showTextDocument(target, { preview: false });
        }),
        // F2 in the chat panel passes 'live': rename the chat that's open there.
        vscode.commands.registerCommand('fuseraft.replRename', async (arg?: ReplSessionItem | 'live') => {
            const session = arg === 'live' ? liveSessionInfo() : (arg ?? chatView.selection[0])?.session;
            if (!session?.sessionId) { return; }
            const input = await vscode.window.showInputBox({
                title:       'Rename Chat',
                value:       session.title ?? session.autoTitle ?? '',
                placeHolder: sessionTitle({ ...session, title: undefined }),
                prompt:      session.autoTitle
                    ? 'Leave empty to go back to the generated title.'
                    : 'Leave empty to go back to the chat\'s first message.',
            });
            if (input === undefined) { return; }
            const title = input.replace(/\s+/g, ' ').trim();
            // Accepting the generated title as it is isn't a rename.
            if (!session.title && title === session.autoTitle) { return; }

            // A live chat's CLI rewrites its snapshot every turn, so it has to make the change itself.
            if (ReplPanelProvider.liveSessionId === session.sessionId) {
                ReplPanelProvider.setLiveTitle(title);
                return;
            }
            try {
                writeReplSessionTitle(session.sessionId, title);
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Could not rename chat: ${err instanceof Error ? err.message : String(err)}`);
            }
            chatProvider.refresh();
        })
    );

    function liveSessionInfo(): ReplSessionInfo | undefined {
        const id = ReplPanelProvider.liveSessionId;
        if (!id) { return undefined; }
        const saved = readReplSessions().find(s => s.sessionId === id);
        const live = ReplPanelProvider.liveTitle;
        const base = saved ?? { sessionId: id, modelId: '', turnIndex: 0, startedAt: '', lastUpdatedAt: '', firstUserMessage: '', cwd: '' };
        return live ? { ...base, title: live.title ?? undefined, autoTitle: live.autoTitle ?? base.autoTitle } : base;
    }

    // fuseraft.refreshChats
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.refreshChats', () => {
            chatProvider.refresh();
        })
    );

    // Workspace folders changing re-scopes which chats belong here.
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => chatProvider.refresh())
    );

    // fuseraft.refreshMemory
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.refreshMemory', () => {
            memoryProvider.refresh();
        })
    );

    // fuseraft.memoryDelete — delete a single stored REPL memory
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.memoryDelete', async (arg?: MemoryItemNode) => {
            let name: string | undefined;
            if (arg?.entry?.name) {
                name = arg.entry.name;
            } else {
                const entries = readMemoryEntries(getMemoryReplDir());
                if (entries.length === 0) {
                    vscode.window.showInformationMessage('No memories to delete.');
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    entries.map(e => ({ label: e.name, description: e.description })),
                    { title: 'Delete Memory', placeHolder: 'Select a memory to delete' }
                );
                if (!picked) { return; }
                name = picked.label;
            }

            runInTerminal(`${getBinary()} memory delete ${shellQuote(name)}`, 'fuseraft memory', true);
            setTimeout(() => memoryProvider.refresh(), 1500);
        })
    );

    // fuseraft.memoryDeleteAll — wipe every stored REPL memory
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.memoryDeleteAll', async () => {
            const entries = readMemoryEntries(getMemoryReplDir());
            if (entries.length === 0) {
                vscode.window.showInformationMessage('No memories to delete.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Delete all ${entries.length} chat memor${entries.length === 1 ? 'y' : 'ies'}? This cannot be undone.`,
                { modal: true },
                'Delete All'
            );
            if (confirm !== 'Delete All') { return; }

            runInTerminal(`${getBinary()} memory delete --all --yes`, 'fuseraft memory', true);
            setTimeout(() => memoryProvider.refresh(), 1500);
        })
    );

    // fuseraft.refreshSkills
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.refreshSkills', () => {
            skillsProvider.refresh();
        })
    );

    // fuseraft.skillsAdd — pick a skill directory or SKILL.md file, run skills add
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.skillsAdd', async () => {
            const uris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                canSelectFiles: true,
                canSelectFolders: true,
                openLabel: 'Add Skill',
                title: 'Select a skill directory (containing SKILL.md) or a SKILL.md file',
            });
            if (!uris?.[0]) { return; }

            runInTerminal(`${getBinary()} skills add ${shellQuote(uris[0].fsPath)}`, 'fuseraft skills', true);
            setTimeout(() => skillsProvider.refresh(), 1500);
        })
    );

    // fuseraft.skillsRemove — remove an installed skill by slug
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.skillsRemove', async (arg?: SkillItemNode) => {
            let slug: string | undefined;
            if (arg?.skill?.slug) {
                slug = arg.skill.slug;
            } else {
                const skills = readSkills(getSkillsDir());
                if (skills.length === 0) {
                    vscode.window.showInformationMessage('No skills to remove.');
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    skills.map(s => ({ label: s.slug, description: s.description })),
                    { title: 'Remove Skill', placeHolder: 'Select a skill to remove' }
                );
                if (!picked) { return; }
                slug = picked.label;
            }

            runInTerminal(`${getBinary()} skills remove ${shellQuote(slug)}`, 'fuseraft skills', true);
            setTimeout(() => skillsProvider.refresh(), 1500);
        })
    );

    // fuseraft.install — run the platform-appropriate CLI installer in a terminal
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.install', async () => {
            runInstaller();
            vscode.window.showInformationMessage(
                'fuseraft installer running in terminal. When it finishes, click "Check again" in the setup wizard or run fuseraft.setup.',
                'Open Setup'
            ).then(choice => {
                if (choice === 'Open Setup') {
                    vscode.commands.executeCommand('fuseraft.setup');
                }
            });
            // Without the setup wizard open nothing else rechecks, and the Chats menu would keep offering Install.
            // The poll's own recheck covers a binary on PATH; one found off it is saved as binaryPath, as the
            // wizard does, which rechecks through the setting's change handler.
            if (!(await checkCli()).found) {
                pollForInstalledBinary(async (resolvedPath, wasOnPath) => {
                    if (!wasOnPath) {
                        await vscode.workspace.getConfiguration('fuseraft').update(
                            'binaryPath', resolvedPath, vscode.ConfigurationTarget.Global
                        );
                    }
                });
            }
        })
    );

    // fuseraft.update — update the CLI to the latest release via `fuseraft update`
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.update', () => {
            runUpdate();
            vscode.window.showInformationMessage(
                'fuseraft update running in terminal. When it finishes, open the setup wizard to verify the new version.',
                'Open Setup'
            ).then(choice => {
                if (choice === 'Open Setup') {
                    invalidateCliCache();
                    vscode.commands.executeCommand('fuseraft.setup');
                }
            });
        })
    );

    // fuseraft.setBinaryPath — pick the fuseraft binary with a file dialog or manual input
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.setBinaryPath', async () => {
            const current = getBinary();
            const choice = await vscode.window.showQuickPick(
                [
                    { label: '$(folder-opened) Browse for binary…', action: 'browse' as const },
                    { label: '$(edit) Enter path manually',          action: 'manual' as const },
                    { label: '$(discard) Reset to default',          action: 'reset'  as const, description: "Sets path back to 'fuseraft'" },
                ],
                { title: 'Set fuseraft binary path', placeHolder: `Current: ${current}` }
            );
            if (!choice) { return; }

            let newPath: string | undefined;
            if (choice.action === 'browse') {
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    canSelectFiles: true,
                    canSelectFolders: false,
                    title: 'Select fuseraft binary',
                    filters: process.platform === 'win32' ? { Executables: ['exe'] } : undefined,
                });
                if (!uris?.[0]) { return; }
                newPath = uris[0].fsPath;
            } else if (choice.action === 'manual') {
                newPath = await vscode.window.showInputBox({
                    title: 'fuseraft binary path',
                    prompt: "Full path to the binary, or just 'fuseraft' if it is on your PATH",
                    value: current,
                    ignoreFocusOut: true,
                });
                if (newPath === undefined) { return; }
                newPath = newPath.trim() || 'fuseraft';
            } else {
                newPath = 'fuseraft';
            }

            await vscode.workspace.getConfiguration('fuseraft').update(
                'binaryPath', newPath, vscode.ConfigurationTarget.Global
            );
            vscode.window.showInformationMessage(`fuseraft binary path set to: ${newPath}`);
        })
    );

    // fuseraft.setHomeDir — pick a folder or manually enter a path to override the fuseraft home directory
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.setHomeDir', async () => {
            const current = vscode.workspace.getConfiguration('fuseraft').get<string>('homeDir', '');
            const choice = await vscode.window.showQuickPick(
                [
                    { label: '$(folder-opened) Browse for folder…', action: 'browse' as const },
                    { label: '$(edit) Enter path manually',          action: 'manual' as const },
                    { label: '$(discard) Reset to default',          action: 'reset'  as const, description: "Uses ~/.fuseraft (or FUSERAFT_HOME if set in your shell)" },
                ],
                { title: 'Set fuseraft home directory', placeHolder: current ? `Current: ${current}` : `Current: ${getFuseraftHome()} (default)` }
            );
            if (!choice) { return; }

            let newDir: string | undefined;
            if (choice.action === 'browse') {
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    canSelectFiles: false,
                    canSelectFolders: true,
                    title: 'Select fuseraft home directory',
                });
                if (!uris?.[0]) { return; }
                newDir = uris[0].fsPath;
            } else if (choice.action === 'manual') {
                newDir = await vscode.window.showInputBox({
                    title: 'fuseraft home directory',
                    prompt: 'Overrides the default ~/.fuseraft — matches the FUSERAFT_HOME environment variable',
                    placeHolder: 'e.g. ~/work-fuseraft or Z:\\fuseraft-home',
                    value: current,
                    ignoreFocusOut: true,
                });
                if (newDir === undefined) { return; }
                newDir = newDir.trim();
            } else {
                newDir = '';
            }

            await vscode.workspace.getConfiguration('fuseraft').update(
                'homeDir', newDir, vscode.ConfigurationTarget.Global
            );
            vscode.window.showInformationMessage(
                newDir ? `fuseraft home directory set to: ${newDir}` : 'fuseraft home directory reset to default.'
            );
        })
    );

    // fuseraft.setup — first-run provider/model/API key wizard
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.setup', () => runSetupWizard(context.extensionUri))
    );

    context.subscriptions.push(chatProvider, memoryProvider, skillsProvider);
}

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function pickAndResumeReplSession(sessions: ReplSessionInfo[], cwd?: string): Promise<void> {
    const items = sessions.map(s => {
        const preview = s.firstUserMessage || s.title ? sessionTitle(s) : '';
        const turns   = `${s.turnIndex} turn${s.turnIndex === 1 ? '' : 's'}`;
        const ago     = formatRelativeTime(s.lastUpdatedAt);
        return {
            label:       `$(history) ${s.sessionId}`,
            description: `${s.modelId}  ·  ${turns}  ·  ${ago}`,
            detail:      preview || '(no messages)',
            sessionId:   s.sessionId,
            modelId:     s.modelId,
        };
    });

    const picked = await vscode.window.showQuickPick(items, {
        title:            'fuseraft — Resume chat',
        placeHolder:      'Select a chat to resume',
        matchOnDetail:    true,
        matchOnDescription: true,
    });
    if (!picked) { return; }

    ReplPanelProvider.show(picked.modelId, picked.sessionId, cwd);
}

export function deactivate(): void {
    disposeOutputChannel();
}

function escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

// Lines either side of a problem that go with it, so the agent sees the code around it without reading the file.
const FIX_CONTEXT_LINES = 5;

/** Offers "Fix with fuseraft" on the errors and warnings under the cursor. */
class FixWithFuseraft implements vscode.CodeActionProvider {
    static readonly kinds = [vscode.CodeActionKind.QuickFix];

    provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
        if (isDraft(doc.uri)) { return []; }
        const problems = ctx.diagnostics.filter(d => d.severity <= vscode.DiagnosticSeverity.Warning).slice(0, 3);
        return problems.map(d => {
            const short = d.message.split('\n')[0];
            const title = problems.length === 1 ? 'Fix with fuseraft'
                : `Fix with fuseraft: ${short.length > 50 ? short.slice(0, 49) + '…' : short}`;
            const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
            action.diagnostics = [d];
            action.command = { command: 'fuseraft.fixDiagnostic', title, arguments: [doc.uri, d] };
            return action;
        });
    }
}

/** The prompt for a fix: the problem as the editor reports it, and where it is. */
function describeDiagnostic(d: vscode.Diagnostic): string {
    const kind = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
    const code = typeof d.code === 'object' ? d.code.value : d.code;
    const from = [d.source, code !== undefined ? String(code) : ''].filter(Boolean).join(' ');
    const lines = d.range.start.line === d.range.end.line ? `line ${d.range.start.line + 1}`
        : `lines ${d.range.start.line + 1}-${d.range.end.line + 1}`;
    return `Fix this ${kind}${from ? ` (${from})` : ''} on ${lines}: ${d.message}`;
}
