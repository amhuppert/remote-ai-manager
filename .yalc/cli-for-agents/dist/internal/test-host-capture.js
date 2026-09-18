/** Wrap capabilities per invocation, so a shared host's history cannot leak into
 * a concurrent run's evidence. Calls retain the original receiver and behavior. */
export function captureHost(host, calls) {
    const record = (call) => { calls.push(Object.freeze(call)); };
    const files = {
        read(...args) { record({ kind: "read", path: args[0] }); return host.files.read(...args); },
        readStdin(...args) { record({ kind: "stdin" }); return host.files.readStdin(...args); },
        canonicalPath(path) { record({ kind: "canonicalPath", path }); return host.files.canonicalPath(path); },
        kind(path) { record({ kind: "kind", path }); return host.files.kind(path); },
        writeAtomic(...args) { record({ kind: "write", path: args[0] }); return host.files.writeAtomic(...args); },
    };
    return { files,
        now() { record({ kind: "clock" }); return host.now(); },
        sleep(...args) { record({ kind: "sleep", duration: args[0] }); return host.sleep(...args); },
        sha256(data) { record({ kind: "sha256" }); return host.sha256(data); },
    };
}
//# sourceMappingURL=test-host-capture.js.map