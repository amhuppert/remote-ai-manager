import { bytes } from "../values.js";
import { sameBytes } from "./host.js";
/** Tool-only capability: declaration imports never load this module or Node fs. */
export async function createReferenceHost() {
    const { createNodeHost } = await import("./node-host.js");
    const host = await createNodeHost();
    return { files: { ...host.files, async replace(path, data, expected, signal) {
                signal.throwIfAborted();
                const fs = await import("node:fs/promises");
                const paths = await import("node:path");
                const target = paths.resolve(path);
                const checkCurrent = async () => {
                    signal.throwIfAborted();
                    if (!(await fs.lstat(target)).isFile())
                        throw new TypeError("Reference target must be a regular file, not a symlink.");
                    const current = await host.files.read(target, bytes(expected.byteLength), signal);
                    if (!sameBytes(current, expected))
                        throw new Error("Reference changed during generation; retry against current content.");
                };
                await checkCurrent();
                const mode = (await fs.lstat(target)).mode & 0o777;
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
                    await checkCurrent();
                    signal.throwIfAborted();
                    await fs.rename(candidate, target);
                }
                finally {
                    await fs.rm(staging, { recursive: true, force: true });
                }
            } } };
}
//# sourceMappingURL=reference-host.js.map