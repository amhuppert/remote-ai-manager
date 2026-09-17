import { describe, expect, it } from "vitest";
import { createTestHost, runForTest } from "cli-for-agents/testing";
import type { CliHost, FetchInit } from "../transport";
import { createCcRuntimeFixture, jsonReply } from "../testing/framework";
import { createCommandCenterCli } from "./application";
import { BUILD_INFO, formatBuildStamp } from "@/lib/build-info";

describe("Command Center application wiring", () => {
  it("retains an authenticated notification refusal instruction without claiming the write applied", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply(
          {
            error: "Notification requires attention.",
            instruction: "Stop and read the pending decision.",
          },
          409,
        ),
    });
    const result = await fixture.run(["notify", "Build finished"]);
    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({
      ok: false,
      effect: "not_applied",
      instruction: "Stop and read the pending decision.",
    });
    expect(fixture.requests).toHaveLength(1);
  });
  it("loads doctor transport once with the invocation environment", async () => {
    const environments: unknown[] = [];
    const cli = createCommandCenterCli(
      async (env) => {
        environments.push(env);
        return {
          async fetch() {
            return Response.json({
              serverBuild: formatBuildStamp(BUILD_INFO),
              identity: { project: null, session: null, conversation: null },
              tokenValid: true,
              cliPath: "/cc/cctl",
              configDir: "/cc",
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
      },
      { artifacts: { directory: "/artifacts", forbiddenRoots: [] } },
    );
    const result = await runForTest(cli, ["doctor"], {
      format: "json",
      env: { CC_SERVER_URL: "http://cc.test", CC_API_TOKEN: "test-token" },
      host: createTestHost({ files: { "/artifacts/.keep": "" } }),
    });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(environments).toEqual([
      { CC_SERVER_URL: "http://cc.test", CC_API_TOKEN: "test-token" },
    ]);
  });

  it("submits a notification with its target recovery fact", async () => {
    const requests: Array<{ url: string; init: FetchInit }> = [];
    const host: CliHost = {
      async fetch(url, init) {
        requests.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), {
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
    const result = await runForTest(
      createCommandCenterCli(host, {
        artifacts: { directory: "/artifacts", forbiddenRoots: [] },
      }),
      ["notify", "Build finished"],
      {
        host: createTestHost({ files: { "/artifacts/.keep": "" } }),
        format: "json",
        env: {
          CC_SERVER_URL: "http://cc.test",
          CC_API_TOKEN: "test-token",
          CC_PROJECT: "project-one",
          CC_SESSION: "session-one",
        },
      },
    );

    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: { data: { notified: true } },
      recovery: {
        references: [{ kind: "session", id: "session-one" }],
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "http://cc.test/api/projects/project-one/sessions/session-one/notifications",
    );
    expect(requests[0]?.init.method).toBe("POST");
    expect(JSON.parse(requests[0]?.init.body ?? "null")).toEqual({
      message: "Build finished",
    });
  });
});
