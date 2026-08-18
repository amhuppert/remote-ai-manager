import { describe, expect, it } from "vitest";
import { BUILD_MISMATCH_HEADER } from "@/lib/agent-gateway/build-parity";
import { BUILD_INFO, formatBuildStamp } from "@/lib/build-info";
import { runCli } from "./core";
import {
  EXIT_CONNECTION,
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_TAXONOMY,
  EXIT_USAGE,
  EXIT_VERSION_MISMATCH,
  type CliEnv,
  type CliHost,
} from "./shared";

const CLI_BUILD = formatBuildStamp(BUILD_INFO);

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

function respond(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): CliHost {
  return hostWith(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
  );
}

function rowFor(code: number) {
  const row = EXIT_TAXONOMY.find((entry) => entry.code === code);
  if (row === undefined) throw new Error(`no taxonomy row for exit ${code}`);
  return row;
}

/**
 * The taxonomy is the CLI's promise about what an exit code asserts, so it is
 * checked against what the CLI actually does — a row is documentation only for
 * as long as the behaviour behind it still matches (docs/design/cc-cli/09 §4).
 */
describe("exit taxonomy", () => {
  it("covers every exit constant exactly once", () => {
    expect(EXIT_TAXONOMY.map((row) => row.code)).toEqual([
      EXIT_OK,
      EXIT_OPERATION_FAILED,
      EXIT_USAGE,
      EXIT_CONNECTION,
      EXIT_VERSION_MISMATCH,
    ]);
    for (const row of EXIT_TAXONOMY) {
      expect(row.meaning.trim().length, `exit ${row.code}`).toBeGreaterThan(20);
      expect(row.recovery?.trim() ?? "cctl").toContain("cctl");
    }
  });

  it("exits 0 when the command did what was asked", async () => {
    const result = await runCli(["version"], env, respond({ ok: true }, 200));
    expect(result.exitCode).toBe(EXIT_OK);
  });

  it("exits 1 when the server refuses the operation", async () => {
    const result = await runCli(
      ["notify", "hello"],
      env,
      respond({ error: "queue is full" }, 500),
    );
    expect(result.exitCode).toBe(EXIT_OPERATION_FAILED);
    expect(result.stderr).toContain("queue is full");
  });

  it("exits 2 on a local check, before any request", async () => {
    let requests = 0;
    const result = await runCli(
      ["notify", "hello", "--nope", "x"],
      env,
      hostWith(async () => {
        requests += 1;
        return new Response("{}", { status: 200 });
      }),
    );
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(requests, "a usage refusal must not reach the server").toBe(0);
    expect(result.stderr).toContain("--help");
  });

  it("exits 3 naming the recovery its row promises", async () => {
    const result = await runCli(
      ["notify", "hello"],
      env,
      hostWith(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    expect(result.exitCode).toBe(EXIT_CONNECTION);
    expect(result.stderr).toContain(rowFor(EXIT_CONNECTION).recovery ?? "");
  });

  it("exits 4 on build skew and scopes the nothing-changed claim to reads", async () => {
    // A read that reaches a skewed server is hard-failed and its response
    // discarded, so "nothing changed" holds. The row cannot promise the same
    // for every path — a server that predates the mutation gate runs the
    // handler before stamping the header — so it defers to the failure text.
    const result = await runCli(
      ["dev", "list"],
      env,
      respond({ ok: true, servers: [] }, 200, {
        [BUILD_MISMATCH_HEADER]: `server=other-tree cli=${CLI_BUILD}`,
      }),
    );

    expect(result.exitCode).toBe(EXIT_VERSION_MISMATCH);
    expect(result.stdout, "a refused command reports no result").toBe("");
    expect(result.stderr).toContain("nothing changed");
    expect(rowFor(EXIT_VERSION_MISMATCH).meaning).toContain(
      "unless the failure text warns",
    );
  });
});
