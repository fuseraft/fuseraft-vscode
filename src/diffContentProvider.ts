import * as vscode from 'vscode';

/**
 * Backs the virtual documents used to preview a pending write_file/patch_file HITL
 * approval as a native VS Code diff editor tab (see ReplPanelProvider's handling of the
 * `file_write` approval_request kind) instead of squeezing a text diff into the small
 * approval bar in the REPL webview — the native diff editor gives syntax highlighting
 * and a proper side-by-side view for free.
 *
 * Only one approval is ever pending at a time (the CLI blocks on the response before
 * continuing), so the provider only needs to hold the most recent old/new pair — a new
 * pair replaces the previous one rather than accumulating in the content store. The
 * *editor tab* for an older pair can still outlive that replacement though — e.g. VS
 * Code un-previews (pins) a diff tab if the user so much as clicks into it, so a later
 * showDiffPreview() call opens a second tab instead of reusing the first — which is why
 * closeDiffPreview() below sweeps every fuseraft-diff tab rather than tracking just one.
 */
class FuseraftDiffContentProvider implements vscode.TextDocumentContentProvider {
    private readonly _content = new Map<string, string>();

    setContent(uri: vscode.Uri, text: string): void {
        this._content.set(uri.toString(), text);
    }

    clear(): void {
        this._content.clear();
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this._content.get(uri.toString()) ?? '';
    }
}

export const DIFF_SCHEME = 'fuseraft-diff';

const provider = new FuseraftDiffContentProvider();
let counter = 0;

export function registerDiffContentProvider(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, provider)
    );
}

/**
 * Opens a native diff editor for a pending write_file/patch_file HITL approval.
 * `filePath` is used only to pick a display basename (for the tab title and
 * language-mode syntax highlighting) — the virtual documents are content-addressed
 * from the approval_request payload, never read from disk, so the diff always reflects
 * exactly what the CLI is about to write rather than whatever the file happens to hold.
 * Uses `preview: true` so a second approval reuses/replaces the same editor tab instead
 * of piling up a new one per write_file/patch_file call.
 */
export function showDiffPreview(filePath: string, oldContent: string, newContent: string, actionLabel: string): void {
    provider.clear();
    const id = ++counter;
    const base = filePath.replace(/\\/g, '/').split('/').pop() || 'file';
    const oldUri = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${id}/before/${base}` });
    const newUri = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${id}/after/${base}` });
    provider.setContent(oldUri, oldContent);
    provider.setContent(newUri, newContent);

    const title = `${base} — ${actionLabel} (pending approval)`;
    vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title, { preview: true });
}

/**
 * Closes every open fuseraft-diff tab, called once the webview's Allow/Deny buttons
 * resolve an approval so diffs don't linger once a decision has been made. By the time
 * an approval_response is being handled, the CLI is still blocked waiting for it, so no
 * new file_write approval (and thus no new fuseraft-diff tab) can have opened yet —
 * every matching tab found here belongs to an approval that has already been resolved,
 * so sweeping all of them is safe. Scheme-matching (rather than tracking specific URIs)
 * also catches a tab that got orphaned by an earlier approval in the same turn — e.g.
 * because VS Code un-previewed (pinned) it before the next write_file's diff replaced it.
 * Never touches a diff the user opened themselves (different scheme).
 */
export async function closeDiffPreview(): Promise<void> {
    const matches: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input;
            if (input instanceof vscode.TabInputTextDiff &&
                input.original.scheme === DIFF_SCHEME &&
                input.modified.scheme === DIFF_SCHEME) {
                matches.push(tab);
            }
        }
    }
    if (matches.length > 0) {
        await vscode.window.tabGroups.close(matches);
    }
}
