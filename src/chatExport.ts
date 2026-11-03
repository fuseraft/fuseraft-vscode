import * as fs from 'fs';
import * as path from 'path';
import { getReplSessionsDir, ReplSessionInfo, sessionTitle } from './fuseraftUtils';
import { stripMessageContext } from './editorContext';

interface SnapshotContent {
    Type?: string;
    Text?: string;
    FunctionName?: string;
    ArgumentsJson?: string;
}

interface SnapshotMessage {
    Role?: string;
    Contents?: SnapshotContent[];
}

// The argument that says what a tool call was about, in the order they're looked for.
const KEY_ARGS = ['path', 'command', 'pattern', 'query', 'url', 'skillName', 'name'];

/**
 * A saved chat as Markdown to read or share: what you asked, and each reply with the tools it used. The system prompt,
 * tool output and the editor context the panel adds to messages are left out.
 */
export function chatToMarkdown(session: ReplSessionInfo): string {
    const file = path.join(getReplSessionsDir(), `repl-${session.sessionId}.json`);
    const history = (JSON.parse(fs.readFileSync(file, 'utf8')).History ?? []) as SnapshotMessage[];
    const started = session.startedAt ? new Date(session.startedAt).toLocaleString() : '';
    const out = [`# ${sessionTitle(session)}`, '', `*fuseraft chat · ${[session.modelId, started].filter(Boolean).join(' · ')}*`];

    let tools: string[] = [];
    let reply: string[] = [];
    const flushReply = () => {
        if (tools.length === 0 && reply.length === 0) { return; }
        out.push('', '## fuseraft', '');
        if (tools.length > 0) { out.push(`> Used ${tools.map(t => `\`${t}\``).join(', ')}`, ''); }
        if (reply.length > 0) { out.push(reply.join('\n\n')); }
        tools = [];
        reply = [];
    };

    for (const msg of history) {
        const contents = msg.Contents ?? [];
        if (msg.Role === 'user') {
            const text = contents.filter(c => c.Type === 'text').map(c => stripMessageContext(c.Text ?? '')).join('\n\n').trim();
            const images = contents.filter(c => c.Type === 'data' || c.Type === 'uri').length;
            if (!text && images === 0) { continue; }
            flushReply();
            out.push('', '## You', '');
            if (text) { out.push(text); }
            if (images > 0) { out.push(`${text ? '\n' : ''}*(${images} image${images === 1 ? '' : 's'} attached)*`); }
        } else if (msg.Role === 'assistant') {
            for (const c of contents) {
                if (c.Type === 'function_call' && c.FunctionName) {
                    tools.push(toolLabel(c.FunctionName, c.ArgumentsJson, session.cwd));
                } else if (c.Type === 'text' && c.Text?.trim()) {
                    reply.push(c.Text.trim());
                }
            }
        }
    }
    flushReply();
    return out.join('\n') + '\n';
}

/** A file name for the export, from the chat's title. */
export function exportFileName(session: ReplSessionInfo): string {
    const slug = sessionTitle(session).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return `${slug || `chat-${session.sessionId}`}.md`;
}

function toolLabel(name: string, argsJson: string | undefined, cwd: string): string {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsJson ?? '{}') as Record<string, unknown>; } catch { /* unreadable arguments: name only */ }
    const key = KEY_ARGS.find(k => typeof args[k] === 'string' && (args[k] as string).trim());
    if (!key) { return name; }
    let value = (args[key] as string).replace(/\s+/g, ' ').trim();
    if (key === 'path' && cwd && path.isAbsolute(value)) {
        const rel = path.relative(cwd, value);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { value = rel; }
    }
    if (value.length > 80) { value = value.slice(0, 79) + '…'; }
    return `${name} ${value}`.replace(/`/g, "'");
}
