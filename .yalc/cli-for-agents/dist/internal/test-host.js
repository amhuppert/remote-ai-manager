import { checkDuration, checkLimit, collisionError, hashBytes, overflow, sameBytes } from "./host.js";
function fileError(code) {
    return Object.assign(new Error(code), { code });
}
export function makeTestHost(options = {}) {
    let now = options.now ?? 0;
    if (!Number.isSafeInteger(now))
        throw new TypeError("Test clock requires safe integer milliseconds");
    const files = new Map();
    const directories = new Set(["/"]);
    const calls = [];
    let stdin = new TextEncoder().encode(options.stdin ?? "");
    const waits = [];
    let order = 0;
    function record(call) { calls.push(Object.freeze(call)); }
    // Virtual paths use a stable POSIX root, independent of the runner's cwd.
    function canonical(input) {
        if (typeof input !== "string" || input.includes("\0"))
            throw new TypeError("Invalid host path");
        const parts = [];
        let directoryOnly = false;
        for (const part of input.split("/")) {
            if (files.has(`/${parts.join("/")}`))
                throw fileError("ENOTDIR");
            directoryOnly = !part || part === "." || part === "..";
            if (!part || part === ".")
                continue;
            if (part === "..")
                parts.pop();
            else
                parts.push(part);
        }
        const path = `/${parts.join("/")}`;
        return directoryOnly && !directories.has(path) ? path + "/" : path;
    }
    function parent(path) { return path.slice(0, path.lastIndexOf("/")) || "/"; }
    function encoded(data) {
        if (typeof data === "string")
            return new TextEncoder().encode(data);
        if (!(data instanceof Uint8Array))
            throw new TypeError("Expected file bytes or text");
        return new Uint8Array(data);
    }
    for (const [input, value] of Object.entries(options.files ?? {})) {
        const path = canonical(input);
        if (path.endsWith("/"))
            throw fileError("EISDIR");
        if (directories.has(path) || files.has(path))
            throw collisionError();
        files.set(path, encoded(value));
        let ancestor = parent(path);
        while (!directories.has(ancestor)) {
            directories.add(ancestor);
            ancestor = parent(ancestor);
        }
    }
    function bounded(data, limit) {
        if (data.length > limit)
            throw overflow();
        return new Uint8Array(data);
    }
    const host = {
        get calls() { return Object.freeze([...calls]); },
        filesSnapshot() {
            return Object.freeze(Object.fromEntries([...files].map(([path, data]) => [path, new Uint8Array(data)])));
        },
        files: {
            async read(input, limit, signal) {
                record({ kind: "read", path: input });
                checkLimit(limit);
                signal.throwIfAborted();
                const path = canonical(input);
                const data = files.get(path);
                if (!data)
                    throw fileError(directories.has(path) ? "EISDIR" : "ENOENT");
                return bounded(data, limit);
            },
            async readStdin(limit, signal) {
                record({ kind: "stdin" });
                checkLimit(limit);
                signal.throwIfAborted();
                const data = stdin;
                stdin = new Uint8Array();
                return bounded(data, limit);
            },
            async canonicalPath(input) { record({ kind: "canonicalPath", path: input }); return canonical(input); },
            async kind(input) {
                record({ kind: "kind", path: input });
                const path = canonical(input);
                return files.has(path) ? "file" : directories.has(path) ? "directory" : "missing";
            },
            retention: {
                async list(directory) {
                    record({ kind: "retention-list", path: directory });
                    const root = canonical(directory);
                    if (!directories.has(root))
                        throw fileError("ENOENT");
                    return [...files.keys()].filter(path => parent(path) === root).map(path => path.slice(root.length + (root === "/" ? 0 : 1)));
                },
                async remove(input, expected) {
                    record({ kind: "retention-remove", path: input });
                    const path = canonical(input);
                    const existing = files.get(path);
                    if (path !== input || !existing || !sameBytes(existing, expected))
                        return false;
                    files.delete(path);
                    return true;
                },
            },
            async writeAtomic(input, data, collision) {
                record({ kind: "write", path: input });
                if (collision !== "reuse-identical-or-refuse")
                    throw new TypeError("Unsupported collision policy");
                if (!(data instanceof Uint8Array))
                    throw new TypeError("Expected file bytes");
                const snapshot = new Uint8Array(data);
                const path = canonical(input);
                if (path.endsWith("/"))
                    throw fileError("EISDIR");
                if (!directories.has(parent(path)))
                    throw fileError("ENOENT");
                if (directories.has(path))
                    throw collisionError();
                const existing = files.get(path);
                if (existing && !sameBytes(existing, snapshot))
                    throw collisionError();
                if (!existing)
                    files.set(path, snapshot);
            },
        },
        now() { record({ kind: "clock" }); return now; },
        sleep(duration, signal) {
            record({ kind: "sleep", duration });
            return new Promise((resolve, reject) => {
                checkDuration(duration);
                signal.throwIfAborted();
                const deadline = now + duration;
                if (!Number.isSafeInteger(deadline))
                    throw new TypeError("Test sleep deadline exceeds safe integer range");
                function remove() {
                    const index = waits.indexOf(wait);
                    if (index !== -1)
                        waits.splice(index, 1);
                    signal.removeEventListener("abort", aborted);
                }
                function aborted() { remove(); reject(signal.reason); }
                const wait = { deadline, order: order++, wake() { remove(); resolve(); } };
                waits.push(wait);
                signal.addEventListener("abort", aborted, { once: true });
                if (signal.aborted)
                    aborted();
            });
        },
        advance(duration) {
            checkDuration(duration);
            const target = now + duration;
            if (!Number.isSafeInteger(target))
                throw new TypeError("Test clock exceeds safe integer range");
            now = target;
            for (const wait of [...waits].sort((a, b) => a.deadline - b.deadline || a.order - b.order)) {
                if (wait.deadline <= now)
                    wait.wake();
            }
        },
        async sha256(data) { record({ kind: "sha256" }); return hashBytes(data); },
    };
    // This owner establishes the TestHost brand after constructing all capabilities.
    return host;
}
//# sourceMappingURL=test-host.js.map