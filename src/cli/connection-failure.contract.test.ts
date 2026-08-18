import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "./core";
import { connectionFailure, type CliEnv, type CliHost } from "./shared";
import { readCliSources } from "./testing/source-scan";

const CLI_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".",
);

/**
 * Files allowed to name the exit-3 constant, and why. Everything else composes
 * `connectionFailure`, so the doctor pointer cannot be forgotten at a new call
 * site (docs/design/cc-cli/09 §10).
 */
const EXIT_CONNECTION_SITES: Readonly<Record<string, string>> = {
  "exit-taxonomy.ts":
    "declares the constant as taxonomy data; constructs no result",
  "shared.ts": "re-exports the constant and owns `connectionFailure`",
  "core.ts": "re-exports the exit constants as the CLI's public surface",
  "commands/workflow.ts":
    "the approved survivor: `workflow wait`'s disconnect carries the continuation receipt instead of the doctor pointer",
};

const env: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
  CC_CONVERSATION_ID: "conv-1",
};

function hostWith(fetchImpl: CliHost["fetch"]): CliHost {
  return {
    fetch: fetchImpl,
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

const unreachable = () =>
  hostWith(async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:3000");
  });

const unauthorized = () =>
  hostWith(
    async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  );

/** The fixture dev-server pair: the CC server answers, the dev server does not. */
function fixtureHost(): CliHost {
  const devServersUrl =
    "http://127.0.0.1:3000/api/projects/cc/sessions/my-session/dev-servers";
  return hostWith(async (url) => {
    if (url === devServersUrl) {
      return new Response(
        JSON.stringify({
          servers: [
            {
              serverName: "nextjs",
              command: "bun run dev",
              status: "running",
              port: 3001,
              remoteUrl: null,
              startedAt: "2026-01-01T00:00:00Z",
              errorMessage: null,
              recentOutput: [],
              ownedByThisSession: true,
              worktreePath: "/wt",
              ownerPid: 123,
              logFilePath: "/wt/.cc/dev.log",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error("ECONNREFUSED 127.0.0.1:3001");
  });
}

describe("exit 3 names its diagnosis", () => {
  it("appends the doctor pointer when a caller has no recovery of its own", () => {
    const result = connectionFailure({
      message: "cannot reach the CC server",
      json: false,
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("hint: run `cctl doctor`");
  });

  it("keeps a caller's more specific recovery and still names doctor", () => {
    const result = connectionFailure({
      message: "cannot reach the dev server",
      hint: "start it with `cctl dev ensure`",
      json: true,
    });

    const envelope: unknown = JSON.parse(result.stdout);
    const hint = (envelope as { hint?: unknown }).hint;
    expect(hint).toBe(
      "start it with `cctl dev ensure` — run `cctl doctor` to check the CC server connection",
    );
  });

  it("does not repeat the pointer a caller already wrote", () => {
    const result = connectionFailure({
      message: "the server rejected the API token",
      hint: "run `cctl doctor` to check connectivity and auth",
      json: false,
    });

    expect(result.stderr.match(/cctl doctor/gu)).toHaveLength(1);
  });

  const invocations: { name: string; argv: string[]; host: () => CliHost }[] = [
    { name: "unreachable server", argv: ["notify", "done"], host: unreachable },
    { name: "rejected token", argv: ["notify", "done"], host: unauthorized },
    { name: "doctor unreachable", argv: ["doctor"], host: unreachable },
    { name: "doctor rejected token", argv: ["doctor"], host: unauthorized },
    {
      name: "fixture prompt dev server",
      argv: [
        "fixture",
        "prompt",
        "scratch",
        "fx-test",
        "--conversation",
        "c9",
        "--text",
        "go",
      ],
      host: fixtureHost,
    },
  ];

  for (const invocation of invocations) {
    it(`points ${invocation.name} at cctl doctor`, async () => {
      const result = await runCli(invocation.argv, env, invocation.host());

      expect(
        result.exitCode,
        `${invocation.name} should be the connection/auth class`,
      ).toBe(3);
      expect(
        result.stderr,
        `${invocation.name} exits 3 without naming the command that diagnoses it`,
      ).toContain("cctl doctor");
    });
  }

  it("lets workflow wait keep its continuation receipt instead", async () => {
    // The one approved survivor. A lost long-poll is not a diagnosis problem:
    // the execution is still running server-side, and the useful next command
    // is the resume that carries this caller's cursor. `cctl doctor` would
    // report a healthy server and lose the cursor, so the receipt wins here.
    const result = await runCli(
      ["workflow", "wait", "exec-7", "--cursor", "42"],
      env,
      unreachable(),
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("continue: cctl workflow wait exec-7");
    expect(result.stderr).toContain("--cursor 42");
  });

  it("routes every other exit-3 construction through the helper", async () => {
    const sources = await readCliSources(CLI_ROOT);
    const mentions = sources
      .filter((file) => file.source.includes("EXIT_CONNECTION"))
      .map((file) => file.relativePath)
      .sort();

    const unexpected = mentions.filter(
      (file) => EXIT_CONNECTION_SITES[file] === undefined,
    );
    expect(
      unexpected,
      "these files build an exit-3 result by hand — compose `connectionFailure` so the doctor pointer travels with it",
    ).toEqual([]);

    const stale = Object.keys(EXIT_CONNECTION_SITES)
      .filter((file) => !mentions.includes(file))
      .sort();
    expect(
      stale,
      "these files no longer name EXIT_CONNECTION — drop them from the list",
    ).toEqual([]);
  });
});
