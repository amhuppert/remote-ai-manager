import { describe, expect, it } from "vitest";
import { invocation } from "cli-for-agents";
import { createCli } from "cli-for-agents/runtime";
import { createTestHost, runForTest } from "cli-for-agents/testing";
import { BUILD_INFO, formatBuildStamp } from "@/lib/build-info";
import type { CliEnv, CliHost, FetchInit } from "../transport";
import { createDoctorCommand } from "./doctor.definition";
import { ccCommands } from "./family";

const stamp = formatBuildStamp(BUILD_INFO);

function fixture(
  input: {
    response?: (url: URL) => Response;
    files?: Record<string, string>;
  } = {},
) {
  const requests: Array<{ url: URL; init: FetchInit }> = [];
  const reads: string[] = [];
  const host: CliHost = {
    async fetch(url, init) {
      const parsed = new URL(url);
      requests.push({ url: parsed, init });
      return (
        input.response?.(parsed) ??
        Response.json({
          serverBuild: stamp,
          identity: {
            project: parsed.searchParams.get("project"),
            session: parsed.searchParams.get("session"),
            conversation: parsed.searchParams.get("conversation"),
          },
          tokenValid: true,
          cliPath: "/cc/bin/cctl",
          configDir: "/cc",
        })
      );
    },
    async readTextFile(file) {
      reads.push(file);
      return input.files?.[file] ?? null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    homedir: "/Users/test",
    platform: "darwin",
  };
  const doctor = createDoctorCommand(host);
  const cli = createCli({
    name: "cctl",
    version: "test",
    family: ccCommands,
    commands: [doctor],
    contexts: {
      cc: async () => {
        throw new Error("Doctor must not acquire app context");
      },
    },
    doctor: invocation(doctor, {}),
    output: { artifacts: { directory: "/artifacts", forbiddenRoots: [] } },
  });
  const env: CliEnv = {
    CC_SERVER_URL: "http://cc.test",
    CC_API_TOKEN: "ambient-token",
    CC_PROJECT: "project",
    CC_SESSION: "session",
    CC_CONVERSATION_ID: "conversation",
  };
  return {
    requests,
    reads,
    run: (
      argv: string[] = ["doctor"],
      overrides: CliEnv = {},
      format: "json" | "text" = "json",
    ) =>
      runForTest(cli, argv, {
        env: { ...env, ...overrides },
        format,
        host: createTestHost({ files: { "/artifacts/.keep": "" } }),
      }),
  };
}

describe("native doctor command", () => {
  it("reports server identity and neutralized project scope without acquiring app context", async () => {
    const test = fixture();
    const result = await test.run(["doctor"], {
      CC_CONVERSATION_SCOPE: "project",
      CC_SESSION: "",
    });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: {
        data: {
          server: "http://cc.test",
          serverBuild: stamp,
          cliBuild: stamp,
          buildMatch: true,
          tokenSource: "env",
          tokenValid: true,
          cliPath: "/cc/bin/cctl",
          configDir: "/cc",
          identity: {
            project: "project",
            session: null,
            conversation: "conversation",
          },
        },
      },
    });
    expect(test.requests[0]?.url.searchParams.has("session")).toBe(false);
    expect(test.requests[0]?.init.headers).toMatchObject({
      authorization: "Bearer ambient-token",
      "x-cc-cli-build": stamp,
    });
    expect(result.stderr).toBe("");
  });

  it("uses explicit target and token overrides", async () => {
    const test = fixture();
    const result = await test.run([
      "doctor",
      "--project",
      "other",
      "--session",
      "other-session",
      "--conversation",
      "other-conversation",
      "--token",
      "explicit-token",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: {
        data: {
          tokenSource: "flag",
          identity: {
            project: "other",
            session: "other-session",
            conversation: "other-conversation",
          },
        },
      },
    });
    expect(test.requests[0]?.init.headers.authorization).toBe(
      "Bearer explicit-token",
    );
    expect(test.reads).toEqual([]);
  });

  it("falls back to the instance token file", async () => {
    const test = fixture({ files: { "/instance/api-token": "file-token\n" } });
    const result = await test.run(["doctor"], {
      CC_API_TOKEN: "",
      CC_CONFIG_DIR: "/instance",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: { data: { tokenSource: "file" } },
    });
    expect(test.requests[0]?.init.headers.authorization).toBe(
      "Bearer file-token",
    );
    expect(test.reads).toEqual(["/instance/api-token"]);
  });

  it("reports build skew as a successful diagnosis with the server's published binary", async () => {
    const test = fixture({
      response: () =>
        Response.json({
          serverBuild: "different-build",
          identity: { project: null, session: null, conversation: null },
          tokenValid: true,
          cliPath: "/other/bin/cctl",
          configDir: "/other",
        }),
    });
    const json = await test.run();
    expect(json.exitCode, json.stdout).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      payload: { data: { buildMatch: false, cliPath: "/other/bin/cctl" } },
      issues: [{ code: "CC_BUILD_MISMATCH" }],
    });
    const text = await test.run(["doctor"], {}, "text");
    expect(text.stdout).toContain("/other/bin/cctl");
    expect(text.stdout).toContain("different-build");
  });

  it("names the other instance's credential on cross-instance auth refusal", async () => {
    const test = fixture({
      response: () => new Response(null, { status: 401 }),
    });
    const result = await test.run(["doctor", "--server", "http://other.test"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "CC_CONNECTION",
        message: expect.stringContaining("every CC instance mints its own"),
        details: { recovery: expect.stringContaining("that instance's token") },
      },
    });
    expect(result.stdout).not.toContain("ambient-token");
  });

  it.each([
    [
      "unreachable",
      () => {
        throw new Error("ECONNREFUSED");
      },
      3,
      "CC_CONNECTION",
    ],
    [
      "HTTP failure",
      () => new Response(null, { status: 503 }),
      1,
      "CC_OPERATION_FAILED",
    ],
    [
      "unexpected response",
      () => Response.json({ other: true }),
      1,
      "CC_INVALID_RESPONSE",
    ],
  ] as const)("classifies %s", async (_label, response, exitCode, code) => {
    const result = await fixture({ response }).run();
    expect(result.exitCode).toBe(exitCode);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code },
    });
  });

  it("fails locally when no server is configured", async () => {
    const test = fixture();
    const result = await test.run(["doctor"], { CC_SERVER_URL: "" });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: "CC_USAGE",
        message: expect.stringContaining("CC_SERVER_URL"),
      },
    });
    expect(test.requests).toEqual([]);
  });
});
