import { describe, expect, it } from "vitest";

import { BUILD_MISMATCH_HEADER } from "@/lib/agent-gateway/build-parity";
import { BUILD_INFO, formatBuildStamp } from "@/lib/build-info";

import { runCli } from "./core";
import type { CliHost } from "./shared";

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

    const result = await runCli(["dev", "list"], baseEnv, host);

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain(SERVER_BUILD);
    expect(result.stderr).toContain(CLI_BUILD);
    // The recovery must name the binary to use, not just the problem.
    expect(result.stderr).toMatch(/bin\/cctl/);
    expect(result.stderr).toContain("cctl doctor");
  });

  it("acts normally when the server published this binary", async () => {
    const host = hostReturning({});
    const result = await runCli(["dev", "list"], baseEnv, host);
    expect(result.exitCode).toBe(0);
  });
});
