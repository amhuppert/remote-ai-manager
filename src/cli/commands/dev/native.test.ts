import { describe, expect, it, vi } from "vitest";
import { milliseconds } from "cli-for-agents";
import { createTestHost, runForTest } from "cli-for-agents/testing";
import { createCommandCenterCli } from "../../framework/application";
import type { CliHost, FetchInit } from "../../transport";
const env = {
  CC_SERVER_URL: "http://cc.test",
  CC_API_TOKEN: "managing-token",
  CC_PROJECT: "cc",
  CC_SESSION: "session-one",
  CC_CONVERSATION_ID: "actor-one",
};
const server = {
  serverName: "web",
  command: "bun run dev",
  status: "running",
  port: 5010,
  remoteUrl: null,
  startedAt: "2026-09-17T10:00:00Z",
  errorMessage: null,
  recentOutput: [],
  ownedByThisSession: true,
  worktreePath: "/worktree",
  ownerPid: 10,
  logFilePath: "/worktree/dev.log",
};
function fixture(
  respond: (url: string, init: FetchInit) => unknown,
  files: Record<string, string> = {},
) {
  const requests: Array<{ url: string; init: FetchInit }> = [];
  const host: CliHost = {
    async fetch(url, init) {
      requests.push({ url, init });
      return new Response(JSON.stringify(respond(url, init)), {
        headers: { "content-type": "application/json" },
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
  const runtimeHost = createTestHost({
    files: { "/artifacts/.keep": "", ...files },
  });
  return {
    requests,
    runtimeHost,
    run: (argv: string[], overrides: Record<string, string> = {}) =>
      runForTest(
        createCommandCenterCli(host, {
          artifacts: { directory: "/artifacts", forbiddenRoots: [] },
        }),
        ["dev", ...argv],
        { env: { ...env, ...overrides }, host: runtimeHost, format: "json" },
      ),
  };
}
describe("native dev commands", () => {
  it("keeps workflow target identity and derives URL from the returned port", async () => {
    const test = fixture(() => ({ servers: [server] }));
    const result = await test.run(["list"], {
      CC_WORKFLOW_EXECUTION_ID: "execution-one",
      CC_WORKFLOW_CONTEXT_ID: "context-one",
    });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests[0]?.url).toBe(
      "http://cc.test/api/projects/cc/sessions/session-one/dev-servers?executionId=execution-one&contextId=context-one",
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: {
        data: {
          servers: [
            {
              localUrl: "http://localhost:5010",
              logFilePath: server.logFilePath,
            },
          ],
        },
      },
    });
  });
  it("starts the chosen server and waits for actual running status", async () => {
    let polls = 0;
    const test = fixture((_url, init) =>
      init.method === "POST"
        ? { status: "accepted", server: { ...server, status: "starting" } }
        : {
            servers: [
              { ...server, status: ++polls === 1 ? "starting" : "running" },
            ],
          },
    );
    const pending = test.run(["ensure", "web"]);
    await vi.waitFor(() =>
      expect(test.runtimeHost.calls.some((call) => call.kind === "sleep")).toBe(
        true,
      ),
    );
    test.runtimeHost.advance(milliseconds(500));
    const result = await pending;
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests.map((r) => r.init.method)).toEqual([
      "POST",
      "GET",
      "GET",
    ]);
    expect(test.requests[0]?.url).toContain("/web/start");
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: {
        data: {
          server: { status: "running", localUrl: "http://localhost:5010" },
        },
      },
    });
  });
  it("retains an accepted start's log/error evidence on failure", async () => {
    const test = fixture((_url, init) =>
      init.method === "POST"
        ? { status: "accepted", server: { ...server, status: "starting" } }
        : {
            servers: [
              {
                ...server,
                status: "error",
                errorMessage: "port occupied",
                recentOutput: ["EADDRINUSE"],
              },
            ],
          },
    );
    const result = await test.run(["ensure", "web"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      error: {
        details: {
          server: {
            logFilePath: server.logFilePath,
            recentOutput: ["EADDRINUSE"],
          },
        },
      },
    });
  });
  it("stops the addressed server without polling", async () => {
    const test = fixture(() => ({ status: "ok" }));
    const result = await test.run(["stop", "web"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests[0]?.url).toContain("/web/stop");
    expect(test.requests).toHaveLength(1);
  });
  it("diagnoses both instances using the dev instance's own file token", async () => {
    const test = fixture(
      (url, init) => {
        if (url.includes("/dev-servers")) return { servers: [server] };
        const dev = url.startsWith("http://localhost:5010");
        expect(init.headers.authorization).toBe(
          dev ? "Bearer dev-token" : "Bearer managing-token",
        );
        return {
          serverBuild: dev ? "branch" : "installed",
          identity: {
            project: "cc",
            session: "session-one",
            conversation: "actor-one",
          },
          tokenValid: true,
          cliPath: dev ? "/worktree/cctl" : "/installed/cctl",
          configDir: dev ? "/worktree/.config" : "/config",
        };
      },
      { "/worktree/.config/api-token": "dev-token\n" },
    );
    const result = await test.run(["doctor"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: {
        data: {
          sameInstance: false,
          managing: { configDir: "/config" },
          dev: { configDir: "/worktree/.config" },
        },
      },
    });
  });
  it("rejects malformed registry bodies rather than reporting an empty configuration", async () => {
    const test = fixture(() => ({ wrong: [] }));
    expect((await test.run(["list"])).exitCode).toBe(1);
    expect((await test.run(["ensure"])).exitCode).toBe(1);
    expect(test.requests.every((r) => r.init.method === "GET")).toBe(true);
  });
});
