// cctl bundle entrypoint. All logic lives in the pure core (core.ts); this
// file only adapts process argv/env/stdio and must stay this thin.
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  fetch as undiciFetch,
  ProxyAgent,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from "undici";
import { createLogger } from "@/lib/logging";
import { sleep } from "@/lib/shared/sleep";
import { runCli } from "./core";
import { resolveSandboxProxyUrl } from "./sandbox-proxy";

const logger = createLogger("cli.transport");
const sandboxProxyDispatchers = new Map<string, Dispatcher>();
let loggedUnavailableSandboxProxy = false;

function sandboxProxyDispatcherFor(url: string): Dispatcher | undefined {
  const proxyUrl = resolveSandboxProxyUrl(process.env, url);
  if (proxyUrl === null) {
    if (
      process.env["SANDBOX_RUNTIME"] === "1" &&
      !loggedUnavailableSandboxProxy
    ) {
      loggedUnavailableSandboxProxy = true;
      logger.warn("cli.transport.sandbox_proxy_unavailable", {
        hasHttpProxy:
          process.env["HTTP_PROXY"] !== undefined ||
          process.env["http_proxy"] !== undefined,
        hasHttpsProxy:
          process.env["HTTPS_PROXY"] !== undefined ||
          process.env["https_proxy"] !== undefined,
      });
    }
    return undefined;
  }

  const existing = sandboxProxyDispatchers.get(proxyUrl);
  if (existing !== undefined) return existing;

  const dispatcher = new ProxyAgent(proxyUrl);
  sandboxProxyDispatchers.set(proxyUrl, dispatcher);
  const parsedProxyUrl = new URL(proxyUrl);
  logger.info("cli.transport.sandbox_proxy_enabled", {
    protocol: parsedProxyUrl.protocol,
    host: parsedProxyUrl.hostname,
  });
  return dispatcher;
}

const result = await runCli(process.argv.slice(2), process.env, {
  fetch: (url, init) => {
    const { timeoutMs, rawBody, ...requestInit } = init;
    const sandboxProxyDispatcher = sandboxProxyDispatcherFor(url);
    const nativeInit = {
      ...requestInit,
      ...(rawBody !== undefined ? { body: rawBody } : {}),
      ...(timeoutMs !== undefined
        ? { signal: AbortSignal.timeout(timeoutMs) }
        : {}),
      ...(sandboxProxyDispatcher !== undefined
        ? { dispatcher: sandboxProxyDispatcher }
        : {}),
    } satisfies UndiciRequestInit;
    return undiciFetch(url, nativeInit) as unknown as Promise<Response>;
  },
  async readTextFile(filePath) {
    // `--file -` reads the payload from stdin, so an agent can pipe a small
    // ops/plan JSON in a single Bash heredoc without a scratch file.
    if (filePath === "-") {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString("utf-8");
    }
    try {
      return await readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  },
  async readFileBytes(filePath) {
    try {
      return new Uint8Array(await readFile(filePath));
    } catch {
      return null;
    }
  },
  async writeFileBytes(filePath, bytes) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes, { mode: 0o600 });
  },
  async writeTextFile(filePath, content) {
    // Commands derive output paths (e.g. `spec export` into .cc/temp/), so the
    // parent directory is not guaranteed to exist yet.
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
  },
  async writePrivateTextFile(filePath, content) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
    await chmod(filePath, 0o600);
  },
  async removeFile(filePath) {
    try {
      await unlink(filePath);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  },
  writeStdout(text) {
    process.stdout.write(text);
  },
  onSignal(listener) {
    const onSigint = () => listener("SIGINT");
    const onSigterm = () => listener("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    return () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
  },
  sleep,
  now: Date.now,
  platform: os.platform(),
  homedir: os.homedir(),
});
/**
 * Resolve only once the stream reports the bytes accepted. On a pipe the kernel
 * buffer is ~64KB, so anything past it is still queued in-process when the
 * write call returns — exiting there truncates the output mid-envelope.
 */
const drain = (stream: NodeJS.WriteStream, text: string): Promise<void> =>
  new Promise((resolve) => {
    if (text === "") {
      resolve();
      return;
    }
    // A reader that closes the pipe early (`cctl … | head`) fails the pending
    // write with EPIPE, which node otherwise raises as an unhandled 'error'
    // event. A downstream reader leaving is not this process's failure.
    stream.once("error", () => resolve());
    stream.write(text, () => resolve());
  });

await Promise.all([
  drain(process.stdout, result.stdout),
  drain(process.stderr, result.stderr),
]);
// Explicit exit stays: undici keep-alive agents and signal listeners can hold
// the event loop open long after the output is delivered.
process.exit(result.exitCode);
