// @vitest-inputs src/cli/**/*.ts src/lib/**/*.ts
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Process-level proof for the `cctl` egress adapter. The defect class lives in
 * process teardown, which no in-process test can observe, and whose semantics
 * differ per runtime — so this builds the shipped artifact (a node ESM bundle,
 * as `build:cli` does) and drives it through a real pipe.
 *
 * The pipe buffer is ~64KB, so only a payload past it distinguishes a
 * write-then-exit adapter from one that waits for the bytes to be accepted.
 */
const PIPE_BUFFER_BYTES = 65_536;
const PAYLOAD_BYTES = 300_000;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const cliEntry = path.join(repoRoot, "src", "cli", "index.ts");

function largePayload(): string {
  const lines: string[] = ["BEGIN-MARKER"];
  let bytes = "BEGIN-MARKER\n".length;
  let index = 0;
  while (bytes < PAYLOAD_BYTES) {
    const line = `line ${String(index).padStart(6, "0")} ${"x".repeat(48)}`;
    lines.push(line);
    bytes += line.length + 1;
    index += 1;
  }
  lines.push("END-MARKER", "");
  return lines.join("\n");
}

/** The ambient CC agent env would supply an identity the test does not control. */
function hermeticEnv(): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && !entry[0].startsWith("CC_"),
  );
  return {
    ...Object.fromEntries(inherited),
    NODE_ENV: process.env.NODE_ENV,
    CC_LOG_SILENT: "1",
  };
}

interface ChildOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ChildStreams {
  stdout: Readable;
  stderr: Readable;
}

/**
 * A consumer that lags behind the writer, like the `jq` on the far side of the
 * recorded `cctl … --json | jq` truncation: it leaves the pipe full, so the
 * child cannot hand off its output in one non-blocking write.
 */
async function readSlowly(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  await delay(200);
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
    await delay(20);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function readFully(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function exitCodeOf(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve(code ?? (signal === null ? -1 : -2)),
    );
  });
}

describe("cctl process egress", () => {
  let bundleDir = "";
  let bundlePath = "";
  let server: Server;
  let serverUrl = "";
  let respond: (req: IncomingMessage, res: ServerResponse) => void = () => {};

  async function runBundled(
    args: string[],
    read: (streams: ChildStreams) => Promise<[string, string]>,
  ): Promise<ChildOutcome> {
    const child = spawn(process.execPath, [bundlePath, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: hermeticEnv(),
    });
    const { stdout, stderr } = child;
    if (stdout === null || stderr === null) {
      throw new Error("child stdio was not piped");
    }
    const [[outText, errText], exitCode] = await Promise.all([
      read({ stdout, stderr }),
      exitCodeOf(child),
    ]);
    return { exitCode, stdout: outText, stderr: errText };
  }

  function conversationReadArgs(extra: string[]): string[] {
    return [
      "conversation",
      "read",
      "conv-egress",
      "--format",
      "markdown",
      ...extra,
      "--server",
      serverUrl,
      "--project",
      "egress-project",
      "--session",
      "egress-session",
      "--token",
      "egress-token",
    ];
  }

  beforeAll(async () => {
    bundleDir = await mkdtemp(path.join(os.tmpdir(), "cctl-egress-"));
    bundlePath = path.join(bundleDir, "cctl.mjs");
    const built = spawnSync(
      "bun",
      [
        "build",
        cliEntry,
        "--target=node",
        "--format=esm",
        `--outfile=${bundlePath}`,
      ],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    if (built.status !== 0) {
      throw new Error(
        `bun build of the cctl entry failed (status ${String(built.status)}): ${built.error?.message ?? built.stderr}`,
      );
    }

    server = createServer((req, res) => respond(req, res));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("stub server did not bind a TCP port");
    }
    serverUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(bundleDir, { recursive: true, force: true });
  });

  it("delivers a >64KB stdout envelope byte-complete to a slow pipe reader", async () => {
    const payload = largePayload();
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(payload);
    };

    const outcome = await runBundled(
      conversationReadArgs(["--json"]),
      async ({ stdout, stderr }) =>
        await Promise.all([readSlowly(stdout), readSlowly(stderr)]),
    );

    expect(outcome.stderr).toBe("");
    expect(outcome.exitCode).toBe(0);
    expect(Buffer.byteLength(outcome.stdout, "utf-8")).toBeGreaterThan(
      PIPE_BUFFER_BYTES,
    );

    const envelope: unknown = JSON.parse(outcome.stdout);
    expect(envelope).toMatchObject({ ok: true, markdown: payload });
  }, 30_000);

  it("delivers a >64KB stderr failure byte-complete to a slow pipe reader", async () => {
    const payload = largePayload();
    respond = (_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: payload }));
    };

    const outcome = await runBundled(
      conversationReadArgs([]),
      async ({ stdout, stderr }) =>
        await Promise.all([readSlowly(stdout), readSlowly(stderr)]),
    );

    expect(outcome.exitCode).toBe(1);
    expect(Buffer.byteLength(outcome.stderr, "utf-8")).toBeGreaterThan(
      PIPE_BUFFER_BYTES,
    );
    expect(outcome.stderr).toBe(`${payload}\n`);
  }, 30_000);

  it("exits quietly when the reader closes the pipe early", async () => {
    const payload = largePayload();
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(payload);
    };

    // `cctl … | head` closes the read end mid-write: the pending write fails
    // with EPIPE, which must stay invisible — quiet exit, empty stderr.
    const outcome = await runBundled(
      conversationReadArgs(["--json"]),
      async ({ stdout, stderr }) => {
        const collectedStderr = readFully(stderr);
        const head = await new Promise<string>((resolve) => {
          stdout.once("data", (chunk: Buffer) =>
            resolve(chunk.toString("utf-8")),
          );
        });
        stdout.destroy();
        return [head, await collectedStderr];
      },
    );

    expect(outcome.stderr).toBe("");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.startsWith('{"ok":true')).toBe(true);
  }, 30_000);
});
