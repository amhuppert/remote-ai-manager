// cctl bundle entrypoint. All logic lives in the pure core (core.ts); this
// file only adapts process argv/env/stdio and must stay this thin.
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sleep } from "@/lib/shared/sleep";
import { runCli } from "./core";

const result = await runCli(process.argv.slice(2), process.env, {
  fetch: (url, init) => {
    const { timeoutMs, rawBody, ...requestInit } = init;
    return fetch(url, {
      ...requestInit,
      ...(rawBody !== undefined ? { body: rawBody } : {}),
      ...(timeoutMs !== undefined
        ? { signal: AbortSignal.timeout(timeoutMs) }
        : {}),
    });
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
  platform: os.platform(),
  homedir: os.homedir(),
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
