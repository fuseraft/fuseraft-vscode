import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SessionTreeProvider, SessionItem } from './sessionTreeProvider';
import { ConfigTreeProvider, ConfigItem } from './configTreeProvider';
import { ContextTreeProvider, ContextItemNode, getContextDir, readContextIndex } from './contextTreeProvider';
import { FuseraftCodeLensProvider, isFuseraftConfig } from './codeLensProvider';
import { TaskPanelProvider } from './taskPanelProvider';
import { SessionViewPanel } from './sessionViewPanel';
import {
    getBinary, getRunFlags, findFuseraftConfigs, pickConfig,
    promptForTask, buildRunCommand, runInTerminal,
    getSessionsDir, validateBinaryPath, resetBinaryValidation, disposeOutputChannel,
} from './fuseraftUtils';
import { isConfigured, runSetupWizard } from './setupWizard';

export function activate(context: vscode.ExtensionContext): void {
    const sessionProvider = new SessionTreeProvider();
    const configProvider = new ConfigTreeProvider();
    const contextProvider = new ContextTreeProvider();
    const codeLensProvider = new FuseraftCodeLensProvider();
    const taskPanel = new TaskPanelProvider(context.extensionUri);

    // Tree views
    vscode.window.createTreeView('fuseraft.sessions', {
        treeDataProvider: sessionProvider,
        showCollapseAll: false,
    });
    vscode.window.createTreeView('fuseraft.configs', {
        treeDataProvider: configProvider,
        showCollapseAll: false,
    });
    vscode.window.createTreeView('fuseraft.context', {
        treeDataProvider: contextProvider,
        showCollapseAll: false,
    });

    // Task panel webview (sidebar)
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(TaskPanelProvider.viewType, taskPanel)
    );

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
    statusBar.text = '$(circuit-board) fuseraft';
    statusBar.tooltip = 'fuseraft: Run Task';
    statusBar.command = 'fuseraft.run';
    statusBar.show();
    context.subscriptions.push(statusBar);

    // Restore FUSERAFT_API_KEY in every VS Code terminal (survives extension restart).
    context.secrets.get('fuseraft.apiKey').then(key => {
        if (key) { context.environmentVariableCollection.replace('FUSERAFT_API_KEY', key); }
    });

    // First-run: validate binary and configuration
    isConfigured().then(configured => {
        if (!configured) {
            validateBinaryPath(getBinary()).then(validation => {
                if (!validation.valid) {
                    vscode.window.showWarningMessage(
                        `fuseraft binary not found or invalid: ${validation.error}`,
                        'Configure Binary',
                        'Set Up Extension'
                    ).then(choice => {
                        if (choice === 'Configure Binary' || choice === 'Set Up Extension') {
                            vscode.commands.executeCommand('fuseraft.setup');
                        }
                    });
                } else {
                    vscode.window.showInformationMessage(
                        'fuseraft is not configured. Set up your provider and API key to get started.',
                        'Set Up Now'
                    ).then(choice => {
                        if (choice === 'Set Up Now') {
                            vscode.commands.executeCommand('fuseraft.setup');
                        }
                    });
                }
            });
        }
    });

    // Track context key for editor/context menu — seed immediately and on every tab change
    const setConfigContext = (editor: vscode.TextEditor | undefined) => {
        vscode.commands.executeCommand(
            'setContext',
            'fuseraft.isFuseraftConfig',
            editor ? isFuseraftConfig(editor.document.getText()) : false
        );
    };
    setConfigContext(vscode.window.activeTextEditor);
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(setConfigContext),
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document === vscode.window.activeTextEditor?.document) {
                setConfigContext(vscode.window.activeTextEditor);
            }
        })
    );

    // Listen for binary path configuration changes and reset validation state
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('fuseraft.binaryPath')) {
                resetBinaryValidation();
            }
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

    // fuseraft.runFromConfig — run using a specific config (from tree, codelens, or explorer)
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.runFromConfig', async (arg?: ConfigItem | string | vscode.Uri) => {
            let configPath: string | undefined;

            if (typeof arg === 'string') {
                configPath = arg;
            } else if (arg instanceof vscode.Uri) {
                configPath = arg.fsPath;
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

    // fuseraft.init — multi-step wizard: template → model → endpoint → output path → run
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.init', async () => {
            // Step 1: template
            const TEMPLATES = [
                { label: 'dev-team',        description: 'Planner → Developer → Tester → Reviewer with keyword routing and a periodic Verifier' },
                { label: 'graph',           description: 'Same four-agent pipeline as a declarative directed graph with back-edges for revision cycles' },
                { label: 'brownfield',      description: 'Archaeologist recons the codebase first, then Planner → Developer → Reviewer' },
                { label: 'brownfield-graph',description: 'Brownfield pipeline as a directed graph; Reviewer has separate back-edges to Developer and Planner' },
                { label: 'magentic',        description: 'Manager LLM dynamically coordinates Researcher + Developer agents (no fixed routing)' },
                { label: 'research',        description: 'Researcher gathers information, Writer produces the final report' },
                { label: 'devops',          description: 'Three-agent pipeline for infrastructure and deployment tasks' },
                { label: 'content',         description: 'Writer drafts, Editor refines and approves' },
                { label: 'minimal',         description: 'Single general-purpose agent — simplest possible setup' },
                { label: 'designer',        description: 'Describe your use case in plain language and get a validated config back' },
                { label: '$(terminal) Interactive wizard', description: 'Run the full fuseraft init wizard in the terminal' },
            ];

            const templatePick = await vscode.window.showQuickPick(TEMPLATES, {
                title: 'fuseraft init  (1 / 4)  — Template',
                placeHolder: 'Select a template',
                matchOnDescription: true,
            });
            if (!templatePick) { return; }

            if (templatePick.label.startsWith('$(terminal)')) {
                runInTerminal(`${getBinary()} init`, 'fuseraft init');
                return;
            }

            const template = templatePick.label;

            // Step 2: model
            const MODEL_ITEMS = [
                { label: '$(settings-gear) Auto-detect from API keys', description: 'uses ~/.fuseraft/config or env vars', modelFlag: '' },
                { label: 'claude-sonnet-4-6',       description: 'Anthropic',  modelFlag: 'claude-sonnet-4-6' },
                { label: 'claude-opus-4-7',          description: 'Anthropic',  modelFlag: 'claude-opus-4-7' },
                { label: 'claude-haiku-4-5',         description: 'Anthropic',  modelFlag: 'claude-haiku-4-5' },
                { label: 'gpt-4o',                   description: 'OpenAI',     modelFlag: 'gpt-4o' },
                { label: 'gpt-4o-mini',              description: 'OpenAI',     modelFlag: 'gpt-4o-mini' },
                { label: 'grok-4',                   description: 'xAI',        modelFlag: 'grok-4' },
                { label: 'grok-4-1-fast-reasoning',  description: 'xAI',        modelFlag: 'grok-4-1-fast-reasoning' },
                { label: 'gemini-2.5-flash',         description: 'Google',     modelFlag: 'gemini-2.5-flash' },
                { label: 'mistral-medium-latest',    description: 'Mistral',    modelFlag: 'mistral-medium-latest' },
                { label: 'deepseek-chat',            description: 'DeepSeek',   modelFlag: 'deepseek-chat' },
                { label: '$(edit) Enter model ID…',  description: '',           modelFlag: '' },
            ] as const;

            const modelPick = await vscode.window.showQuickPick([...MODEL_ITEMS], {
                title: 'fuseraft init  (2 / 4)  — Model',
                placeHolder: 'Pick a model or use auto-detection',
            });
            if (!modelPick) { return; }

            let modelFlag = (modelPick as { modelFlag: string }).modelFlag;
            if (modelPick.label === '$(edit) Enter model ID…') {
                const custom = await vscode.window.showInputBox({
                    title: 'Model ID',
                    placeHolder: 'e.g. claude-sonnet-4-6',
                    ignoreFocusOut: true,
                });
                if (custom === undefined) { return; }
                modelFlag = custom.trim();
            }

            // Step 3: endpoint (optional)
            const endpointPick = await vscode.window.showQuickPick(
                [
                    { label: '$(settings-gear) Use saved endpoint', description: 'from ~/.fuseraft/config', endpoint: '' },
                    { label: 'https://api.anthropic.com',            description: 'Anthropic',   endpoint: 'https://api.anthropic.com' },
                    { label: 'https://api.openai.com/v1',            description: 'OpenAI',      endpoint: 'https://api.openai.com/v1' },
                    { label: 'https://api.x.ai/v1',                  description: 'xAI',         endpoint: 'https://api.x.ai/v1' },
                    { label: 'https://generativelanguage.googleapis.com', description: 'Google', endpoint: 'https://generativelanguage.googleapis.com' },
                    { label: 'https://api.mistral.ai/v1',            description: 'Mistral',     endpoint: 'https://api.mistral.ai/v1' },
                    { label: 'https://api.deepseek.com/v1',          description: 'DeepSeek',    endpoint: 'https://api.deepseek.com/v1' },
                    { label: '$(edit) Enter endpoint URL…',          description: '',            endpoint: '' },
                ],
                {
                    title: 'fuseraft init  (3 / 4)  — Provider Endpoint',
                    placeHolder: 'Pick a provider endpoint or use saved default',
                }
            );
            if (!endpointPick) { return; }

            let endpointFlag = (endpointPick as { endpoint: string }).endpoint;
            if (endpointPick.label === '$(edit) Enter endpoint URL…') {
                const custom = await vscode.window.showInputBox({
                    title: 'Provider endpoint URL',
                    placeHolder: 'e.g. https://chat.mycompany.com/openai/',
                    ignoreFocusOut: true,
                });
                if (custom === undefined) { return; }
                endpointFlag = custom.trim();
            }

            // Step 4: output path
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const outputPath = await vscode.window.showInputBox({
                title: 'fuseraft init  (4 / 4)  — Output Path',
                prompt: 'Config file path (relative to workspace root, or absolute)',
                value: 'config/orchestration.yaml',
                ignoreFocusOut: true,
            });
            if (!outputPath) { return; }

            const fullPath = path.isAbsolute(outputPath)
                ? outputPath
                : path.join(workspaceRoot ?? '.', outputPath);

            // Build command
            let cmd = `${getBinary()} init '${fullPath}' --template ${template} --no-interactive`;
            if (modelFlag) { cmd += ` --model ${modelFlag}`; }
            if (endpointFlag) { cmd += ` --endpoint '${endpointFlag}'`; }

            runInTerminal(cmd, 'fuseraft init');

            // Open the generated file once it appears on disk (poll up to 15 s)
            openWhenReady(fullPath, configProvider);
        })
    );

    // fuseraft.runTaskFile — run fuseraft with a task file (-f flag)
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.runTaskFile', async (arg?: vscode.Uri) => {
            const taskFilePath = arg?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
            if (!taskFilePath) { return; }

            const configs = await findFuseraftConfigs();
            const config = await pickConfig(configs);

            const configFlag = config ? ` -c '${config.fsPath}'` : '';
            const flags = getRunFlags() ? ` ${getRunFlags()}` : '';
            runInTerminal(`${getBinary()} run --vscode${configFlag}${flags} -f '${taskFilePath}'`);
        })
    );

    // fuseraft.validate — validate a config file
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.validate', async (arg?: ConfigItem | string | vscode.Uri) => {
            const configPath = await resolveConfigPath(arg);
            if (!configPath) { return; }
            runInTerminal(`${getBinary()} validate '${configPath}'`, 'fuseraft validate', true);
        })
    );

    // fuseraft.validateDiagram — validate + show Mermaid diagram
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.validateDiagram', async (arg?: ConfigItem | string | vscode.Uri) => {
            const configPath = await resolveConfigPath(arg);
            if (!configPath) { return; }
            runInTerminal(`${getBinary()} validate '${configPath}' --diagram`, 'fuseraft validate', true);
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
                'grok-code-fast-1',
                'gemini-2.0-flash',
            ];

            const picked = await vscode.window.showQuickPick(
                [
                    { label: '$(settings-gear) Use configured default', description: 'from ~/.fuseraft/config' },
                    ...models.map(m => ({ label: m, description: '' })),
                    { label: '$(edit) Enter model ID…', description: '' },
                ],
                { title: 'fuseraft repl — Select model', placeHolder: 'Pick a model or use default' }
            );
            if (!picked) { return; }

            let cmd = `${getBinary()} repl --vscode`;
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

            runInTerminal(cmd, 'fuseraft repl');
        })
    );

    // fuseraft.viewSession — open session transcript in a webview panel
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.viewSession', (arg?: SessionItem) => {
            if (arg?.session?.sessionId) {
                SessionViewPanel.show(arg.session);
            }
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
            runInTerminal(`${getBinary()} run --vscode --resume ${sessionId}`, 'fuseraft');
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
                'fuseraft sessions',
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

    // fuseraft.refreshContext
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.refreshContext', () => {
            contextProvider.refresh();
        })
    );

    // fuseraft.contextAdd — pick file/folder, optional name + description, run context add
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.contextAdd', async () => {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                vscode.window.showWarningMessage('Open a workspace folder to manage context.');
                return;
            }

            const uris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                canSelectFiles: true,
                canSelectFolders: true,
                title: 'Select file or folder to add to context',
            });
            if (!uris?.[0]) { return; }

            const sourcePath = uris[0].fsPath;
            const defaultName = path.basename(sourcePath, path.extname(sourcePath));

            const name = await vscode.window.showInputBox({
                title: 'Context item name',
                prompt: 'Short alias used to reference this item (leave blank to use filename)',
                value: defaultName,
                ignoreFocusOut: true,
            });
            if (name === undefined) { return; }

            const description = await vscode.window.showInputBox({
                title: 'Description (optional)',
                prompt: 'Human-readable description appended to agent prompts',
                placeHolder: 'e.g. Product specifications',
                ignoreFocusOut: true,
            });
            if (description === undefined) { return; }

            const binary = getBinary();
            const nameFlag = name.trim() ? ` --name '${name.trim()}'` : '';
            const descFlag = description.trim() ? ` --description '${description.trim()}'` : '';
            runInTerminal(
                `${binary} context add '${sourcePath}'${nameFlag}${descFlag} --dir '${workspaceRoot}'`,
                'fuseraft context'
            );
            setTimeout(() => contextProvider.refresh(), 2000);
        })
    );

    // fuseraft.contextRemove — remove a context item by name
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.contextRemove', async (arg?: ContextItemNode) => {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) { return; }

            let name: string | undefined;
            if (arg?.entry?.name) {
                name = arg.entry.name;
            } else {
                const entries = readContextIndex();
                if (entries.length === 0) {
                    vscode.window.showInformationMessage('No context items to remove.');
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    entries.map(e => ({ label: e.name, description: e.description ?? e.sourcePath })),
                    { title: 'Remove Context Item', placeHolder: 'Select an item to remove' }
                );
                if (!picked) { return; }
                name = picked.label;
            }

            const binary = getBinary();
            runInTerminal(
                `${binary} context remove '${name}' --dir '${workspaceRoot}'`,
                'fuseraft context'
            );
            setTimeout(() => contextProvider.refresh(), 1500);
        })
    );

    // fuseraft.setup — first-run provider/model/API key wizard
    context.subscriptions.push(
        vscode.commands.registerCommand('fuseraft.setup', () => runSetupWizard(context))
    );

    context.subscriptions.push(sessionProvider, configProvider, contextProvider);
}

async function resolveConfigPath(arg?: ConfigItem | string | vscode.Uri): Promise<string | undefined> {
    if (typeof arg === 'string') { return arg; }
    if (arg instanceof vscode.Uri) { return arg.fsPath; }
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

function openWhenReady(filePath: string, configProvider: ConfigTreeProvider, timeoutMs = 15_000): void {
    const start = Date.now();
    const interval = setInterval(() => {
        if (fs.existsSync(filePath)) {
            clearInterval(interval);
            configProvider.refresh();
            vscode.window.showTextDocument(vscode.Uri.file(filePath));
        } else if (Date.now() - start > timeoutMs) {
            clearInterval(interval);
            configProvider.refresh();
        }
    }, 500);
}

export function deactivate(): void {
    disposeOutputChannel();
}
