import { describe, expect, it } from "vitest";
import { runCli } from "./core";
import { ccTempPayloadAdvisory, type CliEnv, type CliHost } from "./shared";

describe("ccTempPayloadAdvisory", () => {
  it("nudges a bare relative payload written to the worktree root", () => {
    const advisory = ccTempPayloadAdvisory("doc.json");
    expect(advisory).toBeDefined();
    expect(advisory).toContain(".cc/temp/");
    expect(advisory).toContain("doc.json");
  });

  it("nudges a relative payload in a non-.cc subdirectory", () => {
    expect(ccTempPayloadAdvisory("payloads/plan.json")).toContain(".cc/temp/");
  });

  it("stays silent for a payload already under the .cc/ namespace", () => {
    expect(ccTempPayloadAdvisory(".cc/temp/doc.json")).toBeUndefined();
    expect(
      ccTempPayloadAdvisory(".cc/graph-workflow-docs/api.json"),
    ).toBeUndefined();
    expect(ccTempPayloadAdvisory("./.cc/temp/doc.json")).toBeUndefined();
  });

  it("stays silent for an absolute path (worktree root is unknown here)", () => {
    expect(ccTempPayloadAdvisory("/tmp/plan.json")).toBeUndefined();
  });

  it("stays silent for stdin", () => {
    expect(ccTempPayloadAdvisory("-")).toBeUndefined();
  });
});

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
};

function payloadHost(): CliHost {
  return {
    async fetch() {
      return new Response(JSON.stringify({ runId: "run-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async readTextFile(filePath) {
      return filePath.endsWith(".json")
        ? JSON.stringify({ prompt: "do the thing" })
        : null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

describe("cctl --file payload location advisory (integration)", () => {
  it("prints the .cc/temp advisory on stderr for a worktree-root payload, without touching stdout or exit code", async () => {
    const result = await runCli(
      ["codex", "run", "--file", "doc.json"],
      baseEnv,
      payloadHost(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(".cc/temp/");
    expect(result.stdout).toContain("run-1");
  });

  it("stays silent when the payload already lives under .cc/temp/", async () => {
    const result = await runCli(
      ["codex", "run", "--file", ".cc/temp/doc.json"],
      baseEnv,
      payloadHost(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});
