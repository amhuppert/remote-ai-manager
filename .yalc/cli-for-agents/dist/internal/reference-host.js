/** Tool-only capability: declaration imports never load this module or Node fs. */
export async function createReferenceHost() {
    const { createNodeHost } = await import("./node-host.js");
    const host = await createNodeHost();
    return { files: { ...host.files, async replace(path, data, signal) {
                signal.throwIfAborted();
                const fs = await import("node:fs/promises");
                const paths = await import("node:path");
                const target = paths.resolve(path);
                const info = await fs.lstat(target);
                if (!info.isFile())
                    throw new TypeError("Reference target must be a regular file, not a symlink.");
                const mode = info.mode & 0o777;
                const staging = await fs.mkdtemp(paths.join(paths.dirname(target), ".reference-"));
                try {
                    const candidate = paths.join(staging, "document");
                    const handle = await fs.open(candidate, "wx", 0o600);
                    try {
                        await handle.writeFile(data);
                        await handle.chmod(mode);
                        await handle.sync();
                    }
                    finally {
                        await handle.close();
                    }
                    signal.throwIfAborted();
                    await fs.rename(candidate, target);
                }
                finally {
                    await fs.rm(staging, { recursive: true, force: true });
                }
            } } };
}
//# sourceMappingURL=reference-host.js.map