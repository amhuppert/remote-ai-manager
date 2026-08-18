import { describe, expect, it } from "vitest";
import { runCli } from "./core";
import {
  CLIENT_ADVISORIES,
  ccTempPayloadAdvisory,
  type CliEnv,
  type CliHost,
} from "./shared";

// Declare-or-fail: client-authored reminders are the enumerated exception to
// "the server authors reminders", so each one must name the failure it earned.
describe("CLIENT_ADVISORIES", () => {
  it("carries an evidence line for every enumerated entry", () => {
    const entries = Object.entries(CLIENT_ADVISORIES);
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, advisory] of entries) {
      expect(advisory.evidence.length, id).toBeGreaterThan(20);
    }
  });
});

describe("ccTempPayloadAdvisory", () => {
  it("nudges a bare relative payload written to the worktree root", () => {
    const advisory = ccTempPayloadAdvisory("doc.json");
    expect(advisory).toBeDefined();
    expect(advisory).toContain(".cc/temp/");
    expect(advisory).toContain("doc.json");
  });

  // The renderer owns the reminder prefix and the line break, so the advisory
  // text must carry neither.
  it("is a bare single-line reminder body", () => {
    const advisory = ccTempPayloadAdvisory("doc.json");
    expect(advisory).not.toContain("\n");
    expect(advisory?.startsWith("note:")).toBe(false);
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
  it("renders the .cc/temp advisory as a reminder line, without touching the exit code", async () => {
    const result = await runCli(
      ["agent", "run", "--file", "doc.json"],
      baseEnv,
      payloadHost(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("run-1");
    expect(result.stdout).toContain("reminder: ");
    expect(result.stdout).toContain(".cc/temp/");
    expect(result.stderr).toBe("");
  });

  // --json consumers see only the envelope, so the advisory must travel in
  // its reminders array.
  it("carries the advisory in the --json envelope's reminders", async () => {
    const result = await runCli(
      ["agent", "run", "--file", "doc.json", "--json"],
      baseEnv,
      payloadHost(),
    );
    expect(result.exitCode).toBe(0);
    const envelope: unknown = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ ok: true });
    const reminders = (envelope as { reminders?: unknown }).reminders;
    expect(Array.isArray(reminders)).toBe(true);
    expect((reminders as string[])[0]).toContain(".cc/temp/");
  });

  it("stays silent when the payload already lives under .cc/temp/", async () => {
    const result = await runCli(
      ["agent", "run", "--file", ".cc/temp/doc.json"],
      baseEnv,
      payloadHost(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("reminder: ");
  });
});
