export type YamlValue = string | string[] | Record<string, string>;
export type YamlDoc = Record<string, YamlValue>;

/**
 * Minimal reader for the flat / one-level-nested YAML shapes fuseraft-cli's
 * YamlDotNet serializers emit for schedule jobs and objectives: top-level
 * scalar fields, block sequences of scalars ("Key:\n- a\n- b"), and
 * one-level-deep nested maps (the DateTimeOffset breakdown YamlDotNet emits
 * for timestamp fields). This is deliberately not a general YAML parser —
 * it only needs to survive what these two stores actually write.
 */
export function parseSimpleYaml(text: string): YamlDoc {
    const lines = text.split('\n');
    const doc: YamlDoc = {};
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim() || line.startsWith('#') || /^\s/.test(line)) { i++; continue; }

        const m = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
        if (!m) { i++; continue; }
        const key = m[1];
        const rest = m[2].trim();
        if (rest.length > 0) {
            doc[key] = unquote(rest);
            i++;
            continue;
        }

        let j = i + 1;
        if (j < lines.length && lines[j].startsWith('- ')) {
            const arr: string[] = [];
            while (j < lines.length && lines[j].startsWith('- ')) {
                arr.push(unquote(lines[j].slice(2).trim()));
                j++;
            }
            doc[key] = arr;
            i = j;
            continue;
        }

        if (j < lines.length && /^\s+\S/.test(lines[j])) {
            const nested: Record<string, string> = {};
            while (j < lines.length && /^\s+\S/.test(lines[j])) {
                const nm = lines[j].match(/^\s+([A-Za-z_][\w]*):\s*(.*)$/);
                if (nm) { nested[nm[1]] = unquote(nm[2].trim()); }
                j++;
            }
            doc[key] = nested;
            i = j;
            continue;
        }

        doc[key] = '';
        i++;
    }
    return doc;
}

export function yamlString(doc: YamlDoc, key: string): string {
    const v = doc[key];
    return typeof v === 'string' ? v : '';
}

export function yamlArray(doc: YamlDoc, key: string): string[] {
    const v = doc[key];
    return Array.isArray(v) ? v : [];
}

/** Reads the UTC timestamp out of a nested DateTimeOffset field (e.g. "next_run"/"NextRun"). */
export function yamlNestedUtcDate(doc: YamlDoc, key: string): string | undefined {
    const v = doc[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        return v['UtcDateTime'] ?? v['utc_date_time'];
    }
    return undefined;
}

function unquote(s: string): string {
    if (s.length >= 2 && ((s[0] === "'" && s[s.length - 1] === "'") || (s[0] === '"' && s[s.length - 1] === '"'))) {
        return s.slice(1, -1);
    }
    return s;
}
