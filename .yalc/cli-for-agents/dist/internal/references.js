import { bytes } from "../values.js";
import { renderCommandReference } from "./help.js";
import { sameBytes } from "./host.js";
import { cliConfiguration, cliRegistry, registryState } from "./registry.js";
export async function referenceHost(options) {
    options.signal.throwIfAborted();
    if (options.host)
        return typeof options.host === "function" ? options.host() : options.host;
    const { createReferenceHost } = await import("./reference-host.js");
    return createReferenceHost();
}
export async function checkReferences(cli, options) {
    options.signal.throwIfAborted();
    const config = cliConfiguration(cli);
    const refs = Object.values(registryState(cliRegistry(cli)).nodes).filter(node => node.kind !== "validation")
        .flatMap(node => (node.group ?? node.model?.spec)?.skills?.map(skill => ({ commandPath: node.path, reference: skill.path })) ?? []);
    if (!refs.length)
        return { ok: true, checked: 0, issues: [] };
    const host = await referenceHost(options);
    const path = await import("node:path");
    const issues = [];
    const directory = config.documentation?.directory;
    let root;
    if (directory) {
        root = await host.files.canonicalPath(directory);
        if (await host.files.kind(root) !== "directory")
            root = undefined;
    }
    for (const ref of refs) {
        options.signal.throwIfAborted();
        if (!root) {
            issues.push({ ...ref, code: "missing_documentation_root" });
            continue;
        }
        // Canonical paths use native separators; a POSIX backslash is a filename byte.
        const prefix = root.endsWith(path.sep) ? root : root + path.sep;
        try {
            const canonical = await host.files.canonicalPath(path.join(root, ref.reference));
            if (!canonical.startsWith(prefix))
                issues.push({ ...ref, code: "outside_documentation_root" });
            else if (await host.files.kind(canonical) !== "file")
                issues.push({ ...ref, code: "missing_reference" });
        }
        catch {
            options.signal.throwIfAborted();
            issues.push({ ...ref, code: "invalid_reference" });
        }
    }
    options.signal.throwIfAborted();
    return issues.length ? { ok: false, checked: refs.length, issues: [issues[0], ...issues.slice(1)] } : { ok: true, checked: refs.length, issues: [] };
}
/** Only the selected, unique whole-line marker pair is replaceable. */
export function replaceMarker(document, marker, generated) {
    if (!/^[A-Z][A-Z0-9 _-]{0,63}$/.test(marker))
        throw new TypeError("Invalid reference marker name.");
    let active;
    const seen = new Set();
    for (const match of document.matchAll(/^<!-- (BEGIN|END) GENERATED ([A-Z][A-Z0-9 _-]{0,63}) -->\r?$/gm)) {
        const name = match[2];
        if (match[1] === "BEGIN") {
            if (active !== undefined || seen.has(name))
                throw new TypeError("Nested or duplicate reference markers.");
            active = name;
            seen.add(name);
        }
        else {
            if (active !== name)
                throw new TypeError("Stale or mismatched reference markers.");
            active = undefined;
        }
    }
    if (active !== undefined)
        throw new TypeError("Unclosed reference marker.");
    const start = `<!-- BEGIN GENERATED ${marker} -->`;
    const end = `<!-- END GENERATED ${marker} -->`;
    const starts = [...document.matchAll(new RegExp(`^${start}\\r?$`, "gm"))];
    const ends = [...document.matchAll(new RegExp(`^${end}\\r?$`, "gm"))];
    if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index)
        throw new TypeError("Missing, duplicate or stale reference markers.");
    const first = starts[0];
    const last = ends[0];
    const offset = first.index + first[0].length;
    if (document[offset] !== "\n")
        throw new TypeError("Reference marker needs a following line.");
    const existing = document.slice(offset + 1, last.index);
    if (/<!-- (?:BEGIN|END) GENERATED /u.test(existing) || /<!-- (?:BEGIN|END) GENERATED /u.test(generated))
        throw new TypeError("Nested reference markers are forbidden.");
    const newline = first[0].endsWith("\r") ? "\r\n" : "\n";
    const content = generated.replace(/\r?\n/g, newline);
    return document.slice(0, offset + 1) + content + (content.endsWith(newline) ? "" : newline) + document.slice(last.index);
}
export async function writeReference(cli, options) {
    if (options.mode !== "write" && options.mode !== "check")
        throw new TypeError("Invalid reference mode.");
    const limit = bytes(options.maxBytes ?? 1048576);
    const host = await referenceHost(options);
    const validation = await checkReferences(cli, { ...options, host });
    if (!validation.ok)
        return { ...validation, changed: false };
    options.signal.throwIfAborted();
    const original = await host.files.read(options.path, limit, options.signal);
    const document = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original);
    const updated = replaceMarker(document, options.marker, renderCommandReference(cli));
    const data = new TextEncoder().encode(updated);
    if (data.byteLength > limit)
        throw new RangeError("Generated reference exceeds byte limit.");
    const changed = !sameBytes(original, data);
    options.signal.throwIfAborted();
    if (changed && options.mode === "write") {
        if (!host.files.replace)
            throw new TypeError("Reference write requires a replacement-capable host.");
        await host.files.replace(options.path, data, original, options.signal);
    }
    return { ...validation, changed };
}
//# sourceMappingURL=references.js.map