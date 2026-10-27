import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ReplSessionTreeProvider, ReplSessionItem } from './replSessionTreeProvider';
import { MemoryTreeProvider, MemoryItemNode, readMemoryEntries } from './memoryTreeProvider';
import { SkillsTreeProvider, SkillItemNode, readSkills, getSkillsDir } from './skillsTreeProvider';
import { ReplPanelProvider } from './replPanelProvider';
import { registerDiffContentProvider } from './diffContentProvider';
import {
    getBinary, runInTerminal, shellQuote,
    runInstaller, runUpdate, checkCli, invalidateCliCache, disposeOutputChannel,
    readReplSessions, formatRelativeTime, ReplSessionInfo,
    getMemoryReplDir, getFuseraftHome, getReplSessionsDir,
} from './fuseraftUtils';
import { isConfigured, runSetupWizard } from './setupWizard';

export function activate(context: vscode.ExtensionContext): void {
    const chatProvider = new ReplSessionTreeProvider();
    const memoryProvider = new MemoryTreeProvider();
    const skillsProvider = new SkillsTreeProvider();
    ReplPanelProvider.extensionUri = context.extensionUri;
    registerDiffContentProvider(context);

    // Tree views
    vscode.window.createTreeView('fuseraft.chats', {
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
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    statusBar.text = '$(comment-discussion) fuseraft';
    statusBar.tooltip = 'fuseraft: Open REPL';
    statusBar.command = 'fuseraft.repl';
    statusBar.show();
    context.subscriptions.push(statusBar);

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

    // fuseraft.repl — bring the live chat into view, or start one with the configured model
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.repl', () => {
            ReplPanelProvider.show('', undefined, workspaceRoot());
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
                vscode.window.showInformationMessage('No saved REPL sessions found.');
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
            const preview = session.firstUserMessage.split('\n')[0].slice(0, 60);
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
                `Delete all ${entries.length} REPL memor${entries.length === 1 ? 'y' : 'ies'}? This cannot be undone.`,
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
        vscode.commands.registerCommand('fuseraft.install', () => {
            runInstaller();
            vscode.window.showInformationMessage(
                'fuseraft installer running in terminal. When it finishes, click "Check again" in the setup wizard or run fuseraft.setup.',
                'Open Setup'
            ).then(choice => {
                if (choice === 'Open Setup') {
                    vscode.commands.executeCommand('fuseraft.setup');
                }
            });
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
        const preview = s.firstUserMessage.replace(/\n/g, ' ').slice(0, 72);
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
        title:            'fuseraft REPL — Resume session',
        placeHolder:      'Select a session to resume',
        matchOnDetail:    true,
        matchOnDescription: true,
    });
    if (!picked) { return; }

    ReplPanelProvider.show(picked.modelId, picked.sessionId, cwd);
}

export function deactivate(): void {
    disposeOutputChannel();
}
