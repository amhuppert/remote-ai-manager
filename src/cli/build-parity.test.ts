import { describe, expect, it } from "vitest";

import { BUILD_MISMATCH_HEADER } from "@/lib/agent-gateway/build-parity";
import { BUILD_INFO, formatBuildStamp } from "@/lib/build-info";

import { runCcWithHost } from "./testing/domain-runtime";
import type { CliHost } from "./transport";

const CLI_BUILD = formatBuildStamp(BUILD_INFO);
const SERVER_BUILD = "server-sha-from-another-tree";
const SERVER_URL = "http://127.0.0.1:3000";

const baseEnv = {
  CC_SERVER_URL: SERVER_URL,
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
  CC_CONVERSATION_SCOPE: "session",
  CC_CONVERSATION_ID: "conv-1",
};

const SERVER_CLI_PATH = "/Users/test/Library/Application Support/cc/bin/cctl";

function hostRefusing(
  body: unknown,
  headers: Record<string, string> = {},
): CliHost {
  return {
    async fetch() {
      return new Response(JSON.stringify(body), {
        status: 409,
        headers: { "content-type": "application/json", ...headers },
      });
    },
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

function hostReturning(headers: Record<string, string>): CliHost {
  return {
    async fetch() {
      return new Response(JSON.stringify({ ok: true, servers: [] }), {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
      });
    },
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

describe("cctl build parity", () => {
  it("refuses to act on a server built from a different tree", async () => {
    // The failure this prevents: a cctl from the main build talking to a
    // worktree dev server reads a surface that predates the worktree's
    // changes, and reports the feature as missing.
    const host = hostReturning({
      [BUILD_MISMATCH_HEADER]: `server=${SERVER_BUILD} cli=${CLI_BUILD}`,
    });

    const result = await runCcWithHost(["dev", "list"], baseEnv, host);

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain(SERVER_BUILD);
    expect(result.stderr).toContain(CLI_BUILD);
    // The recovery must name the binary to use, not just the problem.
    expect(result.stderr).toContain("cctl doctor");
  });

  // A read is side-effect-free, so the refusal states plainly that nothing
  // happened rather than hedging about what the result might describe.
  it("states that the read was discarded and nothing changed", async () => {
    const host = hostReturning({
      [BUILD_MISMATCH_HEADER]: `server=${SERVER_BUILD} cli=${CLI_BUILD}`,
    });

    const result = await runCcWithHost(["dev", "list"], baseEnv, host);

    expect(result.stderr).toContain("effect: read");
    expect(result.stderr).not.toContain("effect: applied");
  });

  it("acts normally when the server published this binary", async () => {
    const host = hostReturning({});
    const result = await runCcWithHost(["dev", "list"], baseEnv, host);
    expect(result.exitCode).toBe(0);
  });
});

describe("cctl build skew — the server's pre-execution mutation refusal", () => {
  const refusalBody = {
    error: `cctl build ${CLI_BUILD} does not match server build ${SERVER_BUILD}`,
    code: "build_skew",
    details: { serverBuild: SERVER_BUILD, serverCliPath: SERVER_CLI_PATH },
  };

  it("exits 4 and states truthfully that no changes were made", async () => {
    const result = await runCcWithHost(
      ["notify", "hello"],
      baseEnv,
      hostRefusing(refusalBody),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("no changes were made");
    expect(result.stderr).toContain(SERVER_BUILD);
    expect(result.stderr).toContain(CLI_BUILD);
    expect(result.stderr).toContain(SERVER_CLI_PATH);
  });

  // The 409 carries the recovery path and the guarantee that nothing ran, so it
  // must win over the header-only signal on the same response.
  it("prefers the refusal body over the mismatch header on the same response", async () => {
    const result = await runCcWithHost(
      ["notify", "hello"],
      baseEnv,
      hostRefusing(refusalBody, {
        [BUILD_MISMATCH_HEADER]: `server=${SERVER_BUILD} cli=${CLI_BUILD}`,
      }),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("no changes were made");
  });

  it("carries the code and details on the --json envelope", async () => {
    const result = await runCcWithHost(
      ["notify", "hello", "--json"],
      baseEnv,
      hostRefusing(refusalBody),
    );

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      effect: "not_applied",
      error: {
        code: "CC_BUILD_MISMATCH",
        details: {
          serverCode: "build_skew",
          serverDetails: {
            serverBuild: SERVER_BUILD,
            serverCliPath: SERVER_CLI_PATH,
          },
        },
      },
    });
  });

  it("falls back to the doctor pointer when the server publishes no cctl path", async () => {
    const result = await runCcWithHost(
      ["notify", "hello"],
      baseEnv,
      hostRefusing({
        ...refusalBody,
        details: { serverBuild: SERVER_BUILD, serverCliPath: null },
      }),
    );

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("no changes were made");
    expect(result.stderr).toContain("cctl doctor");
  });

  // Any other 409 keeps the ordinary "server said no" mapping.
  it("leaves an unrelated 409 at exit 1", async () => {
    const result = await runCcWithHost(
      ["notify", "hello"],
      baseEnv,
      hostRefusing({ error: "already sent", code: "duplicate" }),
    );

    expect(result.exitCode).toBe(1);
  });
});
