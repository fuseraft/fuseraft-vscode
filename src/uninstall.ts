import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { checkCli, getFuseraftHome, getFuseraftHomeEnvOverride, invalidateCliCache, resolveCliPath, shellQuote } from './fuseraftUtils';
import { ReplPanelProvider } from './replPanelProvider';

const EXTENSION_ID = 'fuseraft.fuseraft';
const MANUAL_STEPS = 'https://fuseraft.ai/fuseraft-cli/cli-reference/#fuseraft-uninstall';

/** Whether the CLI at <binary> can uninstall itself (`fuseraft uninstall`). */
function cliHasUninstall(binary: string): Promise<boolean> {
    return new Promise(resolve => {
        execFile(binary, ['uninstall', '--help'], { timeout: 15_000 }, (err, stdout) => {
            resolve(!err && /--purge/.test(stdout ?? ''));
        });
    });
}

/**
 * Runs `fuseraft uninstall` (with `--purge` if asked) in a terminal, where the user sees what goes and confirms it,
 * then offers to uninstall the extension too.
 */
export async function uninstallFuseraft(): Promise<void> {
    const home = tilde(getFuseraftHome());
    const binary = resolveCliPath();
    if (!binary) {
        const choice = await vscode.window.showInformationMessage(
            'The fuseraft CLI isn\'t installed, so there\'s no CLI to remove.',
            {
                modal: true,
                detail: `Your chats and settings may still be in ${home}, and API keys in your OS keychain. ` +
                    'Install the CLI and run this again to remove them, or remove them by hand.',
            },
            'Uninstall Extension', 'Remove by Hand'
        );
        if (choice === 'Uninstall Extension') { await uninstallExtension(); }
        else if (choice === 'Remove by Hand') { void vscode.env.openExternal(vscode.Uri.parse(MANUAL_STEPS)); }
        return;
    }

    if (!await cliHasUninstall(binary)) {
        const choice = await vscode.window.showWarningMessage(
            'This fuseraft CLI is too old to uninstall itself. Update it, then run Uninstall again.', 'Update CLI'
        );
        if (choice === 'Update CLI') { void vscode.commands.executeCommand('fuseraft.update'); }
        return;
    }

    const pick = await vscode.window.showQuickPick([
        {
            label: 'Remove the CLI',
            detail: `Keeps your chats, settings, skills and saved API keys in ${home}.`,
            purge: false,
        },
        {
            label: 'Remove the CLI and all my data',
            detail: `Also deletes ${home} (chats, settings, memory, skills) and the API keys and MCP sign-ins fuseraft saved in your keychain.`,
            purge: true,
        },
    ], { title: 'Uninstall fuseraft', placeHolder: 'The terminal lists everything first and asks before removing anything' });
    if (!pick) { return; }

    // A running chat keeps the CLI open: Windows can't delete it, and it would write new data as the old goes.
    if (ReplPanelProvider.hasChat) {
        const ok = await vscode.window.showWarningMessage(
            'Uninstalling closes your fuseraft chat.', { modal: true }, 'Close Chat and Continue'
        );
        if (!ok) { return; }
        await ReplPanelProvider.closeChat();
    }

    const args = pick.purge ? ['uninstall', '--purge'] : ['uninstall'];
    const terminal = vscode.window.createTerminal({ name: 'fuseraft uninstall', env: getFuseraftHomeEnvOverride() });
    terminal.show();

    const shell = await shellIntegration(terminal);
    if (!shell) {
        terminal.sendText([binary, ...args].map(shellQuote).join(' '));
        const choice = await vscode.window.showInformationMessage(
            'Confirm in the terminal. Once fuseraft is removed, you can uninstall this extension too.', 'Uninstall Extension'
        );
        if (choice === 'Uninstall Extension') { await uninstallExtension(); }
        return;
    }

    const execution = shell.executeCommand(binary, args);
    const ended = vscode.window.onDidEndTerminalShellExecution(async e => {
        if (e.execution !== execution) { return; }
        ended.dispose();
        if (e.exitCode !== 0) { return; }   // declined, refused or partly done: the terminal says which

        invalidateCliCache();
        void checkCli();
        if (pick.purge) { ReplPanelProvider.forgetChat(); }
        await resetBinaryPath();
        const choice = await vscode.window.showInformationMessage(
            pick.purge ? 'fuseraft and all of its data were removed.' : `The fuseraft CLI was removed. Your data is still in ${home}.`,
            'Uninstall Extension'
        );
        if (choice === 'Uninstall Extension') { await uninstallExtension(); }
    });
}

/** The terminal's shell integration, once its shell reports in; undefined when it doesn't (VS Code before 1.93, or a shell without it). */
function shellIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
    if (typeof vscode.window.onDidChangeTerminalShellIntegration !== 'function') { return Promise.resolve(undefined); }
    if (terminal.shellIntegration) { return Promise.resolve(terminal.shellIntegration); }
    return new Promise(resolve => {
        const timer = setTimeout(() => { sub.dispose(); resolve(undefined); }, 5000);
        const sub = vscode.window.onDidChangeTerminalShellIntegration(e => {
            if (e.terminal !== terminal) { return; }
            clearTimeout(timer);
            sub.dispose();
            resolve(e.shellIntegration);
        });
    });
}

function tilde(p: string): string {
    const userHome = os.homedir();
    return process.platform !== 'win32' && p.startsWith(userHome + path.sep) ? '~' + p.slice(userHome.length) : p;
}

// A binaryPath naming the removed CLI would keep pointing at nothing.
async function resetBinaryPath(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('fuseraft');
    const inspected = cfg.inspect<string>('binaryPath');
    if (inspected?.globalValue !== undefined) { await cfg.update('binaryPath', undefined, vscode.ConfigurationTarget.Global); }
    if (inspected?.workspaceValue !== undefined) { await cfg.update('binaryPath', undefined, vscode.ConfigurationTarget.Workspace); }
}

async function uninstallExtension(): Promise<void> {
    await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', EXTENSION_ID);
}
