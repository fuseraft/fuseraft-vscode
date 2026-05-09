import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SessionTreeProvider, SessionItem } from './sessionTreeProvider';
import { ConfigTreeProvider, ConfigItem } from './configTreeProvider';
import { FuseraftCodeLensProvider, isFuseraftConfig } from './codeLensProvider';
import {
    getBinary, getRunFlags, findFuseraftConfigs, pickConfig,
    promptForTask, buildRunCommand, runInTerminal,
    getSessionsDir,
} from './fuseraftUtils';

export function activate(context: vscode.ExtensionContext): void {
    const sessionProvider = new SessionTreeProvider();
    const configProvider = new ConfigTreeProvider();
    const codeLensProvider = new FuseraftCodeLensProvider();

    // Tree views
    vscode.window.createTreeView('fuseraft.sessions', {
        treeDataProvider: sessionProvider,
        showCollapseAll: false,
    });
    vscode.window.createTreeView('fuseraft.configs', {
        treeDataProvider: configProvider,
        showCollapseAll: false,
    });

    // CodeLens for YAML/JSON config files
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            [
                { language: 'yaml', scheme: 'file' },
                { language: 'json', scheme: 'file' },
            ],
            codeLensProvider
        )
    );

    // Status bar
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    statusBar.text = '$(robot) Fuseraft';
    statusBar.tooltip = 'Fuseraft: Run Task';
    statusBar.command = 'fuseraft.run';
    statusBar.show();
    context.subscriptions.push(statusBar);

    // Track context key for editor/context menu
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (!editor) { return; }
            const text = editor.document.getText();
            vscode.commands.executeCommand(
                'setContext',
                'fuseraft.isFuseraftConfig',
                isFuseraftConfig(text)
            );
        })
    );

    // ---- Commands ----

    // fuseraft.run — prompt for task, pick config, run
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.run', async () => {
            const task = await promptForTask();
            if (!task?.trim()) { return; }

            const configs = await findFuseraftConfigs();
            const config = await pickConfig(configs);

            const cmd = buildRunCommand(getBinary(), task, config?.fsPath, getRunFlags());
            runInTerminal(cmd);
        })
    );

    // fuseraft.runFromConfig — run using a specific config (from tree or codelens)
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.runFromConfig', async (arg?: ConfigItem | string) => {
            let configPath: string | undefined;

            if (typeof arg === 'string') {
                configPath = arg;
            } else if (arg instanceof ConfigItem && arg.config.fsPath) {
                configPath = arg.config.fsPath;
            } else {
                const configs = await findFuseraftConfigs();
                const picked = await pickConfig(configs);
                configPath = picked?.fsPath;
            }

            const task = await promptForTask();
            if (!task?.trim()) { return; }

            const cmd = buildRunCommand(getBinary(), task, configPath, getRunFlags());
            runInTerminal(cmd);
        })
    );

    // fuseraft.init — generate a new config
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.init', async () => {
            const templates = [
                { label: 'dev-team', description: 'Planner → Developer → Tester → Reviewer pipeline' },
                { label: 'minimal', description: 'Single-agent minimal setup' },
                { label: 'graph', description: 'Directed-graph pipeline with parallel fan-out' },
                { label: 'brownfield', description: 'Brownfield codebase with recon phase' },
                { label: 'designer', description: 'AI-assisted config designer (interactive)' },
                { label: 'interactive', description: 'Run interactive wizard in terminal' },
            ];

            const picked = await vscode.window.showQuickPick(templates, {
                title: 'Fuseraft — Initialize Config',
                placeHolder: 'Select a template',
            });
            if (!picked) { return; }

            if (picked.label === 'interactive') {
                runInTerminal(`${getBinary()} init`, 'Fuseraft Init');
                return;
            }

            const outputPath = await vscode.window.showInputBox({
                title: 'Output path',
                prompt: 'Config file path (relative to workspace root)',
                value: 'config/orchestration.yaml',
                ignoreFocusOut: true,
            });
            if (!outputPath) { return; }

            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.';
            const fullPath = path.isAbsolute(outputPath)
                ? outputPath
                : path.join(workspaceRoot, outputPath);

            runInTerminal(
                `${getBinary()} init '${fullPath}' --template ${picked.label} --no-interactive`,
                'Fuseraft Init'
            );

            // Refresh configs tree after a short delay
            setTimeout(() => configProvider.refresh(), 3000);
        })
    );

    // fuseraft.validate — validate a config file
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.validate', async (arg?: ConfigItem | string) => {
            const configPath = await resolveConfigPath(arg);
            if (!configPath) { return; }
            runInTerminal(`${getBinary()} validate '${configPath}'`, 'Fuseraft Validate', true);
        })
    );

    // fuseraft.validateDiagram — validate + show Mermaid diagram
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.validateDiagram', async (arg?: ConfigItem | string) => {
            const configPath = await resolveConfigPath(arg);
            if (!configPath) { return; }
            runInTerminal(`${getBinary()} validate '${configPath}' --diagram`, 'Fuseraft Validate', true);
        })
    );

    // fuseraft.repl — open interactive REPL
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.repl', async () => {
            const models = [
                'claude-sonnet-4-6',
                'claude-opus-4-7',
                'claude-haiku-4-5',
                'gpt-4o',
                'gpt-4o-mini',
                'grok-4-1-fast-reasoning',
                'gemini-2.0-flash',
            ];

            const picked = await vscode.window.showQuickPick(
                [
                    { label: '$(settings-gear) Use configured default', description: 'from ~/.fuseraft/config' },
                    ...models.map(m => ({ label: m, description: '' })),
                    { label: '$(edit) Enter model ID…', description: '' },
                ],
                { title: 'Fuseraft REPL — Select model', placeHolder: 'Pick a model or use default' }
            );
            if (!picked) { return; }

            let cmd = `${getBinary()} repl`;
            if (picked.label === '$(edit) Enter model ID…') {
                const modelId = await vscode.window.showInputBox({
                    title: 'Model ID',
                    placeHolder: 'e.g. claude-sonnet-4-6',
                    ignoreFocusOut: true,
                });
                if (!modelId) { return; }
                cmd += ` --model ${modelId}`;
            } else if (!picked.label.startsWith('$(')) {
                cmd += ` --model ${picked.label}`;
            }

            runInTerminal(cmd, 'Fuseraft REPL');
        })
    );

    // fuseraft.resumeSession — resume an incomplete session
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.resumeSession', async (arg?: SessionItem) => {
            let sessionId: string | undefined;

            if (arg?.session?.sessionId) {
                sessionId = arg.session.sessionId;
            } else {
                // Pick from incomplete sessions
                const { readSessions } = await import('./fuseraftUtils');
                const sessions = readSessions().filter(s => !s.isComplete);
                if (sessions.length === 0) {
                    vscode.window.showInformationMessage('No incomplete sessions to resume.');
                    return;
                }
                const items = sessions.map(s => ({
                    label: s.sessionId,
                    description: s.task.split('\n')[0].slice(0, 80),
                    sessionId: s.sessionId,
                }));
                const picked = await vscode.window.showQuickPick(items, {
                    title: 'Resume Session',
                    placeHolder: 'Pick a session to resume',
                });
                sessionId = picked?.sessionId;
            }

            if (!sessionId) { return; }
            runInTerminal(`${getBinary()} run --resume ${sessionId}`, 'Fuseraft');
        })
    );

    // fuseraft.deleteSession — delete a session
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.deleteSession', async (arg?: SessionItem) => {
            if (!arg?.session?.sessionId) { return; }
            const { session } = arg;
            const preview = session.task.split('\n')[0].slice(0, 60);

            const confirm = await vscode.window.showWarningMessage(
                `Delete session ${session.sessionId}?\n"${preview}"`,
                { modal: true },
                'Delete'
            );
            if (confirm !== 'Delete') { return; }

            runInTerminal(
                `${getBinary()} sessions --delete ${session.sessionId}`,
                'Fuseraft Sessions',
                true
            );
            setTimeout(() => sessionProvider.refresh(), 1500);
        })
    );

    // fuseraft.openSessionConfig — open the config associated with a session
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.openSessionConfig', async (arg?: SessionItem) => {
            if (!arg?.session?.configPath) { return; }
            const configPath = arg.session.configPath;
            if (!fs.existsSync(configPath)) {
                vscode.window.showWarningMessage(`Config not found: ${configPath}`);
                return;
            }
            vscode.window.showTextDocument(vscode.Uri.file(configPath));
        })
    );

    // fuseraft.openConfig — open a config file from the configs tree
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.openConfig', async (arg?: ConfigItem) => {
            if (!arg?.config?.fsPath) { return; }
            vscode.window.showTextDocument(vscode.Uri.file(arg.config.fsPath));
        })
    );

    // fuseraft.refreshSessions
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.refreshSessions', () => {
            sessionProvider.refresh();
        })
    );

    // fuseraft.refreshConfigs
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.refreshConfigs', () => {
            configProvider.refresh();
        })
    );

    context.subscriptions.push(sessionProvider, configProvider);
}

async function resolveConfigPath(arg?: ConfigItem | string): Promise<string | undefined> {
    if (typeof arg === 'string') { return arg; }
    if (arg instanceof ConfigItem && arg.config.fsPath) { return arg.config.fsPath; }

    // Try active editor first
    const editor = vscode.window.activeTextEditor;
    if (editor && isFuseraftConfig(editor.document.getText())) {
        return editor.document.uri.fsPath;
    }

    const configs = await findFuseraftConfigs();
    const picked = await pickConfig(configs);
    return picked?.fsPath;
}

export function deactivate(): void {}
