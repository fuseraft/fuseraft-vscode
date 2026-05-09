import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SessionInfo, formatRelativeTime } from './fuseraftUtils';

interface Message {
    AgentName: string;
    Role: string;
    Content: string;
    Timestamp: string;
    TurnIndex: number;
    IsCompactionSummary: boolean;
    Usage?: { InputTokens: number; OutputTokens: number; TotalTokens: number; CostUsd: number };
    ToolCalls?: { Name: string; ArgsSummary: string; Succeeded: boolean }[];
}

interface SessionData extends SessionInfo {
    Messages: Message[];
}

export class SessionViewPanel {
    static readonly viewType = 'fuseraft.sessionView';
    private static panels = new Map<string, SessionViewPanel>();

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly sessionId: string
    ) {
        panel.onDidDispose(() => SessionViewPanel.panels.delete(sessionId));
    }

    static show(session: SessionInfo): void {
        const existing = SessionViewPanel.panels.get(session.sessionId);
        if (existing) {
            existing.panel.reveal();
            return;
        }

        const sessionFile = path.join(
            require('os').homedir(), '.fuseraft', 'sessions', `${session.sessionId}.json`
        );

        let data: SessionData;
        try {
            data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        } catch {
            vscode.window.showErrorMessage(`Could not read session ${session.sessionId}`);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            SessionViewPanel.viewType,
            `Session ${session.sessionId}`,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        panel.webview.html = SessionViewPanel._html(data);
        const instance = new SessionViewPanel(panel, session.sessionId);
        SessionViewPanel.panels.set(session.sessionId, instance);
    }

    private static _html(data: SessionData): string {
        const nonce = nid();
        const status = data.isComplete
            ? '<span class="badge complete">Complete</span>'
            : '<span class="badge incomplete">Incomplete</span>';

        const totalTokens = data.Messages.reduce((sum, m) => sum + (m.Usage?.TotalTokens ?? 0), 0);
        const totalCost = data.Messages.reduce((sum, m) => sum + (m.Usage?.CostUsd ?? 0), 0);

        const agentColors = buildAgentColors(data.Messages);

        const messagesHtml = data.Messages.map(m => renderMessage(m, agentColors)).join('\n');

        const started = new Date(data.startedAt).toLocaleString();
        const updated = formatRelativeTime(data.lastUpdatedAt);

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    max-width: 900px;
    margin: 0 auto;
    padding: 24px 20px 48px;
    line-height: 1.6;
}
.header {
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    padding-bottom: 16px;
    margin-bottom: 24px;
}
.header h1 {
    font-size: 15px;
    font-weight: 600;
    margin-bottom: 6px;
    word-break: break-word;
}
.meta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 8px;
}
.meta span { display: flex; align-items: center; gap: 4px; }
.badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
}
.badge.complete   { background: var(--vscode-testing-iconPassed, #388a34); color: #fff; }
.badge.incomplete { background: var(--vscode-testing-iconQueued, #cca700); color: #000; }
.config-path {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
    word-break: break-all;
}
.messages { display: flex; flex-direction: column; gap: 16px; }
.turn {
    border: 1px solid var(--vscode-panel-border, #333);
    border-radius: 4px;
    overflow: hidden;
}
.turn-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.03em;
}
.turn-header .agent-name { font-size: 13px; }
.turn-header .turn-meta {
    font-weight: 400;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    gap: 10px;
}
.turn-body { padding: 12px; }
.content {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: var(--vscode-font-size);
    line-height: 1.6;
}
.compaction-banner {
    font-size: 11px;
    font-style: italic;
    color: var(--vscode-descriptionForeground);
    padding: 4px 0;
}
.tools { margin-top: 10px; }
.tools-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 4px;
}
.tool {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 12px;
    font-family: var(--vscode-editor-font-family, monospace);
    padding: 3px 0;
    border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a);
}
.tool:last-child { border-bottom: none; }
.tool-icon { flex-shrink: 0; font-size: 11px; }
.tool-icon.ok   { color: var(--vscode-testing-iconPassed, #388a34); }
.tool-icon.fail { color: var(--vscode-testing-iconFailed, #f14c4c); }
.tool-name { font-weight: 600; white-space: nowrap; }
.tool-args { color: var(--vscode-descriptionForeground); word-break: break-all; }
.usage {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--vscode-panel-border, #2a2a2a);
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
}
.footer {
    margin-top: 24px;
    padding-top: 12px;
    border-top: 1px solid var(--vscode-panel-border, #333);
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    gap: 20px;
    flex-wrap: wrap;
}
</style>
</head>
<body>

<div class="header">
    <h1>${esc(data.task.split('\n')[0].slice(0, 120))}${data.task.length > 120 ? '…' : ''}</h1>
    <div class="meta">
        <span>${status}</span>
        <span>Session <code>${esc(data.sessionId)}</code></span>
        <span>Started ${esc(started)}</span>
        <span>Updated ${esc(updated)}</span>
    </div>
    <div class="config-path">${esc(data.configPath)}</div>
</div>

<div class="messages">
${messagesHtml}
</div>

<div class="footer">
    <span>${data.Messages.length} turn${data.Messages.length !== 1 ? 's' : ''}</span>
    ${totalTokens ? `<span>${totalTokens.toLocaleString()} tokens</span>` : ''}
    ${totalCost ? `<span>~$${totalCost.toFixed(4)}</span>` : ''}
</div>

<script nonce="${nonce}">
// collapsible tool call sections
document.querySelectorAll('.tools-label').forEach(label => {
    const tools = label.nextElementSibling;
    label.style.cursor = 'pointer';
    label.addEventListener('click', () => {
        tools.style.display = tools.style.display === 'none' ? '' : 'none';
    });
});
</script>
</body>
</html>`;
    }
}

function renderMessage(m: Message, colors: Map<string, string>): string {
    const bg = colors.get(m.AgentName) ?? 'var(--vscode-editor-background)';
    const toolsHtml = m.ToolCalls?.length
        ? `<div class="tools">
            <div class="tools-label">▸ ${m.ToolCalls.length} tool call${m.ToolCalls.length !== 1 ? 's' : ''}</div>
            <div>${m.ToolCalls.map(t =>
                `<div class="tool">
                    <span class="tool-icon ${t.Succeeded ? 'ok' : 'fail'}">${t.Succeeded ? '✓' : '✗'}</span>
                    <span class="tool-name">${esc(t.Name)}</span>
                    <span class="tool-args">${esc(t.ArgsSummary)}</span>
                </div>`).join('')}
            </div>
           </div>`
        : '';

    const usageHtml = m.Usage
        ? `<div class="usage">
            <span>↑ ${m.Usage.InputTokens.toLocaleString()} in</span>
            <span>↓ ${m.Usage.OutputTokens.toLocaleString()} out</span>
            ${m.Usage.CostUsd ? `<span>$${m.Usage.CostUsd.toFixed(4)}</span>` : ''}
           </div>`
        : '';

    const contentHtml = m.IsCompactionSummary
        ? `<div class="compaction-banner">⟳ Compaction summary</div><div class="content">${esc(m.Content)}</div>`
        : `<div class="content">${esc(m.Content)}</div>`;

    const time = m.Timestamp ? new Date(m.Timestamp).toLocaleTimeString() : '';

    return `<div class="turn">
    <div class="turn-header" style="background:${bg};">
        <span class="agent-name">${esc(m.AgentName)}</span>
        <span class="turn-meta">
            ${time ? `<span>${time}</span>` : ''}
            <span>Turn ${m.TurnIndex}</span>
        </span>
    </div>
    <div class="turn-body">
        ${contentHtml}
        ${toolsHtml}
        ${usageHtml}
    </div>
</div>`;
}

function buildAgentColors(messages: Message[]): Map<string, string> {
    const palette = [
        'rgba(88,129,87,0.25)',
        'rgba(88,99,156,0.25)',
        'rgba(156,88,88,0.25)',
        'rgba(88,144,156,0.25)',
        'rgba(156,130,88,0.25)',
        'rgba(120,88,156,0.25)',
    ];
    const map = new Map<string, string>();
    let i = 0;
    for (const m of messages) {
        if (!map.has(m.AgentName)) {
            map.set(m.AgentName, palette[i++ % palette.length]);
        }
    }
    return map;
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function nid(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
