import { runCli } from "../runtime/index.js";
import { hasCode } from "./host.js";
/** Own errors until exit: Node can emit error after the write callback fails. */
function output(stream) {
    let failure = stream.destroyed;
    let closed = stream.destroyed;
    let pending;
    const fail = (error) => {
        if (!hasCode(error, "EPIPE"))
            failure = true;
        closed = true;
        pending?.();
    };
    stream.on("error", fail);
    stream.on("close", () => { if (!closed)
        fail(new Error("Output closed")); });
    return {
        failed: () => failure,
        write: text => new Promise(resolve => {
            if (!text) {
                resolve();
                return;
            }
            if (closed) {
                resolve();
                return;
            }
            let returned = false;
            let flushed = false;
            let drained = false;
            const finish = () => {
                if (!closed && !(returned && flushed && drained))
                    return;
                stream.removeListener("drain", drain);
                pending = undefined;
                resolve();
            };
            const drain = () => { drained = true; finish(); };
            pending = finish;
            stream.on("drain", drain);
            try {
                const accepted = stream.write(text, error => {
                    if (error)
                        fail(error);
                    else {
                        flushed = true;
                        finish();
                    }
                });
                drained ||= accepted;
                returned = true;
                finish();
            }
            catch (error) {
                fail(error);
            }
        }),
    };
}
/** Only this process boundary owns streams and exit; application execution is never retried. */
export async function runMain(cli, options) {
    const { default: process } = await import("node:process");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    const stdout = output(process.stdout);
    const stderr = output(process.stderr);
    try {
        if (options?.compileCache) {
            // Acceleration is optional even when supported but unavailable (e.g. permissions).
            const loaded = { ...(await import("node:module")) };
            const enable = loaded["enableCompileCache"];
            try {
                if (typeof enable === "function")
                    enable();
            }
            catch { /* Continue without cache. */ }
        }
        const result = await runCli(cli, { argv: process.argv.slice(2), env: process.env, signal: controller.signal });
        await Promise.all([stdout.write(result.stdout), stderr.write(result.stderr)]);
        // No replacement response: bytes may already have reached the reader. Keep
        // domain classification and avoid a second envelope or a budget bypass.
        return process.exit(result.exitCode || (stdout.failed() || stderr.failed() ? 1 : 0));
    }
    finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
    }
}
//# sourceMappingURL=process.js.map