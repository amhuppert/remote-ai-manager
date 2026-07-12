// cctl bundle entrypoint. All logic lives in the pure core (core.ts); this
// file only adapts process argv/env/stdio and must stay this thin.
import { readFile } from "node:fs/promises";
import os from "node:os";
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
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  platform: os.platform(),
  homedir: os.homedir(),
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
