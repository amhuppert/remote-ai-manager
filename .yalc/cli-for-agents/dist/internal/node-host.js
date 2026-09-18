import { checkDuration, checkLimit, collisionError, hasCode, hashBytes, overflow, sameBytes } from "./host.js";
function readStream(stream, limit, signal, owned) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let length = 0;
        let settled = false;
        let complete;
        function finish(error) {
            if (settled)
                return;
            settled = true;
            stream.pause();
            stream.removeListener("data", data);
            stream.removeListener("end", end);
            signal.removeEventListener("abort", aborted);
            complete = () => {
                if (error !== undefined) {
                    reject(error);
                    return;
                }
                const result = new Uint8Array(length);
                let offset = 0;
                for (const chunk of chunks) {
                    result.set(chunk, offset);
                    offset += chunk.length;
                }
                resolve(result);
            };
            if (owned) {
                // Opening can still fail after abort. Retain the error listener until
                // close and settle only once the owned file descriptor has closed.
                stream.destroy();
            }
            else {
                stream.removeListener("error", failed);
                stream.removeListener("close", closed);
                complete();
            }
        }
        function data(chunk) {
            if (!(chunk instanceof Uint8Array)) {
                finish(new TypeError("Host input must supply raw bytes"));
                return;
            }
            if (chunk.length > limit - length) {
                finish(overflow());
                return;
            }
            chunks.push(new Uint8Array(chunk));
            length += chunk.length;
        }
        function end() { finish(); }
        function failed(error) { finish(error); }
        function closed() {
            if (!settled)
                finish(new Error("Input closed before end"));
            stream.removeListener("error", failed);
            stream.removeListener("close", closed);
            complete?.();
        }
        function aborted() { finish(signal.reason); }
        stream.on("error", failed);
        stream.on("end", end);
        stream.on("close", closed);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) {
            aborted();
            return;
        }
        if (stream.readableEnded) {
            end();
            return;
        }
        if (stream.destroyed) {
            closed();
            return;
        }
        stream.on("data", data);
        stream.resume();
    });
}
export async function createNodeHost() {
    const [fs, streams, path, process] = await Promise.all([
        import("node:fs/promises"), import("node:fs"), import("node:path"), import("node:process"),
    ]);
    async function canonicalPath(input) {
        const absolute = path.isAbsolute(input) ? input : `${process.cwd()}${path.sep}${input}`;
        let current = path.parse(absolute).root;
        let remaining = absolute.slice(current.length).split(path.sep);
        let links = 0;
        let directoryOnly = false;
        while (remaining.length) {
            const part = remaining.shift();
            directoryOnly = !part || part === "." || part === "..";
            if (!part || part === ".")
                continue;
            if (part === "..") {
                current = path.dirname(current);
                continue;
            }
            const candidate = path.join(current, part);
            try {
                const info = await fs.lstat(candidate);
                if (info.isSymbolicLink()) {
                    if (++links > 40)
                        throw new Error("Too many symlinks (ELOOP)");
                    const target = await fs.readlink(candidate);
                    if (path.isAbsolute(target))
                        current = path.parse(target).root;
                    remaining = [...target.slice(path.isAbsolute(target) ? current.length : 0).split(path.sep), ...remaining];
                }
                else {
                    if (remaining.length > 0 && !info.isDirectory()) {
                        // Let the OS supply its native ENOTDIR error.
                        await fs.lstat(`${candidate}${path.sep}.`);
                    }
                    current = candidate;
                }
            }
            catch (error) {
                if (!hasCode(error, "ENOENT"))
                    throw error;
                current = candidate;
            }
        }
        if (directoryOnly) {
            try {
                await fs.lstat(`${current}${path.sep}.`);
            }
            catch (error) {
                if (!hasCode(error, "ENOENT"))
                    throw error;
                // Preserve a missing destination's directory requirement for callers.
                return current.endsWith(path.sep) ? current : current + path.sep;
            }
        }
        return current;
    }
    async function read(input, limit, signal) {
        checkLimit(limit);
        signal.throwIfAborted();
        let handle;
        try {
            // Nonblocking open also lets us reject FIFOs without waiting for a writer.
            // Inspect the opened descriptor, so a path swap cannot bypass this check.
            handle = await fs.open(input, streams.constants.O_RDONLY | streams.constants.O_NONBLOCK);
            signal.throwIfAborted();
            const info = await handle.stat();
            if (info.isDirectory())
                throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
            if (!info.isFile())
                throw new Error("Bounded file input requires a regular file");
            signal.throwIfAborted();
            return await readStream(handle.createReadStream({ highWaterMark: Math.min(65536, limit + 1) }), limit, signal, true);
        }
        catch (error) {
            signal.throwIfAborted();
            throw error;
        }
        finally {
            await handle?.close();
        }
    }
    return {
        files: {
            read,
            async readStdin(limit, signal) {
                checkLimit(limit);
                signal.throwIfAborted();
                return readStream(process.stdin, limit, signal, false);
            },
            canonicalPath,
            async kind(input) {
                try {
                    const info = await fs.stat(input);
                    if (info.isFile())
                        return "file";
                    if (info.isDirectory())
                        return "directory";
                    throw new Error("Unsupported filesystem entry kind");
                }
                catch (error) {
                    if (hasCode(error, "ENOENT"))
                        return "missing";
                    throw error;
                }
            },
            async writeAtomic(input, data, collision) {
                if (collision !== "reuse-identical-or-refuse")
                    throw new TypeError("Unsupported collision policy");
                const snapshot = new Uint8Array(data);
                const destination = await canonicalPath(input);
                if (destination.endsWith(path.sep))
                    throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
                const parent = path.dirname(destination);
                const temporary = await fs.mkdtemp(path.join(parent, ".agent-cli-"));
                try {
                    const staged = path.join(temporary, "content");
                    const handle = await fs.open(staged, "wx", 0o600);
                    try {
                        await handle.writeFile(snapshot);
                        await handle.sync();
                    }
                    finally {
                        await handle.close();
                    }
                    try {
                        await fs.link(staged, destination);
                    }
                    catch (error) {
                        if (!hasCode(error, "EEXIST"))
                            throw error;
                        if (!(await fs.lstat(destination)).isFile())
                            throw collisionError();
                        let existing;
                        try {
                            existing = await read(destination, snapshot.length, new AbortController().signal);
                        }
                        catch (error) {
                            if (error instanceof RangeError)
                                throw collisionError();
                            throw error;
                        }
                        if (!sameBytes(existing, snapshot))
                            throw collisionError();
                    }
                    const directory = await fs.open(parent, "r");
                    try {
                        await directory.sync();
                    }
                    finally {
                        await directory.close();
                    }
                }
                finally {
                    await fs.rm(temporary, { recursive: true, force: true });
                }
            },
        },
        now: () => Date.now(),
        async sleep(duration, signal) {
            checkDuration(duration);
            signal.throwIfAborted();
            // Node clamps long timeouts to 1ms; schedule safe chunks instead.
            let remaining = duration;
            do {
                const chunk = Math.min(remaining, 2147483647);
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, chunk);
                    function aborted() { clearTimeout(timer); signal.removeEventListener("abort", aborted); reject(signal.reason); }
                    signal.addEventListener("abort", aborted, { once: true });
                    if (signal.aborted)
                        aborted();
                });
                remaining -= chunk;
                signal.throwIfAborted();
            } while (remaining > 0);
        },
        sha256: hashBytes,
    };
}
//# sourceMappingURL=node-host.js.map