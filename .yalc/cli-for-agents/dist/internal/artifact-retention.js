import { bytes } from "../values.js";
import { assertFields, assertRecord, frozenJson } from "./validation.js";
const suffix = ".agent-cli-retention.json";
const keepSuffix = ".agent-cli-keep";
const encoder = new TextEncoder();
const permanent = encoder.encode("Explicit output; do not expire.\n");
export function retentionMetadataName(name) { return name.endsWith(suffix) || name.endsWith(keepSuffix); }
async function currentForbiddenRoots(policy, host) {
    return [...policy.forbiddenRoots, ...await Promise.all(policy.forbiddenRoots.map(root => host.files.canonicalPath(root)))];
}
function allowed(path, roots) {
    return !roots.some(root => {
        const normalized = root.replace(/\/+$/, "") || "/";
        return path === normalized || path.startsWith(normalized === "/" ? "/" : normalized + "/");
    });
}
async function recordAt(path, host, signal) {
    try {
        if (await host.files.canonicalPath(path) !== path || await host.files.kind(path) !== "file")
            return;
        const raw = await host.files.read(path, bytes(2048), signal);
        const value = frozenJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
        assertRecord(value);
        assertFields(value, ["version", "createdAt", "name", "bytes", "sha256"]);
        if (value["version"] !== 1 || !Number.isSafeInteger(value["createdAt"]) || typeof value["name"] !== "string"
            || !/^[a-f0-9]{64}-[^/\\]+$/.test(value["name"]) || retentionMetadataName(value["name"])
            || typeof value["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(value["sha256"])
            || !value["name"].startsWith(value["sha256"] + "-"))
            return;
        bytes(value["bytes"]);
        return { value: value, raw };
    }
    catch {
        signal.throwIfAborted();
        return;
    }
}
/** User-approved opt-in sweep: direct managed children only, never recursive. */
export async function expireArtifacts(policy, host, signal, keep) {
    if (!policy.retention)
        return;
    const cleanup = host.files.retention;
    if (!cleanup)
        throw new TypeError("Host does not support artifact retention.");
    const now = host.now();
    if (!Number.isSafeInteger(now))
        throw new TypeError("Invalid host clock.");
    const forbidden = await currentForbiddenRoots(policy, host);
    for (const name of await cleanup.list(policy.directory)) {
        signal.throwIfAborted();
        if (!name.endsWith(suffix) || /[/\\]/.test(name))
            continue;
        const marker = `${policy.directory.replace(/\/+$/, "")}/${name}`;
        const target = marker.slice(0, -suffix.length);
        if (target === keep || !allowed(marker, forbidden) || !allowed(target, forbidden)
            || await host.files.canonicalPath(target) !== target || await host.files.kind(target + keepSuffix) !== "missing")
            continue;
        const record = await recordAt(marker, host, signal);
        if (!record || record.value.name !== name.slice(0, -suffix.length)
            || record.value.createdAt > now || now - record.value.createdAt < policy.retention.maxAgeMs)
            continue;
        let data;
        try {
            data = await host.files.read(target, bytes(record.value.bytes), signal);
        }
        catch {
            signal.throwIfAborted();
            continue;
        }
        if (data.length !== record.value.bytes || await host.sha256(data) !== record.value.sha256)
            continue;
        signal.throwIfAborted();
        // Re-read ownership/protection immediately before the host's checked removal.
        const current = await recordAt(marker, host, signal);
        if (!current || JSON.stringify(current.value) !== JSON.stringify(record.value)
            || await host.files.kind(target + keepSuffix) !== "missing")
            continue;
        if (await cleanup.remove(target, data))
            await cleanup.remove(marker, record.raw);
    }
}
/** Protect automatic-looking explicit paths before writing them; never expire --out. */
export async function protectExplicit(path, policy, host) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!/^[a-f0-9]{64}-/.test(name))
        return;
    if (!allowed(path + keepSuffix, await currentForbiddenRoots(policy, host)))
        throw new TypeError("Retention protection path is forbidden.");
    if (await host.files.canonicalPath(path + keepSuffix) !== path + keepSuffix)
        throw new TypeError("Retention metadata must have a canonical path without symlinks.");
    await host.files.writeAtomic(path + keepSuffix, permanent, "reuse-identical-or-refuse");
}
export async function trackArtifact(manifest, policy, host, signal) {
    if (!policy.retention || await host.files.kind(manifest.path + keepSuffix) !== "missing")
        return;
    const marker = manifest.path + suffix;
    if (!allowed(marker, await currentForbiddenRoots(policy, host)))
        throw new TypeError("Artifact retention record is forbidden.");
    if (await host.files.canonicalPath(marker) !== marker)
        throw new TypeError("Retention metadata must have a canonical path without symlinks.");
    const existing = await recordAt(marker, host, signal);
    if (existing && existing.value.name === manifest.path.slice(manifest.path.lastIndexOf("/") + 1) && existing.value.sha256 === manifest.sha256 && existing.value.bytes === manifest.bytes)
        return;
    const createdAt = host.now();
    if (!Number.isSafeInteger(createdAt))
        throw new TypeError("Invalid host clock.");
    const value = { version: 1, createdAt, name: manifest.path.slice(manifest.path.lastIndexOf("/") + 1), bytes: manifest.bytes, sha256: manifest.sha256 };
    await host.files.writeAtomic(marker, encoder.encode(JSON.stringify(value)), "reuse-identical-or-refuse");
}
//# sourceMappingURL=artifact-retention.js.map