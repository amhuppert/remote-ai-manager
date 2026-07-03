import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSessionEnvContract } from "./session-env";

const IDENTITY = {
  project: "command-center",
  session: "my-session",
  conversationId: "conv-123",
  configDir: "/cfg",
};

describe("buildSessionEnvContract", () => {
  it("injects every contract var for a fully-resolved server", () => {
    const env = buildSessionEnvContract({
      ...IDENTITY,
      baseEnv: { PATH: "/usr/bin", HOME: "/Users/alex" },
      serverUrl: "http://127.0.0.1:3000",
      apiToken: "tok-1",
    });

    expect(env["CC_SERVER_URL"]).toBe("http://127.0.0.1:3000");
    expect(env["CC_API_TOKEN"]).toBe("tok-1");
    expect(env["CC_PROJECT"]).toBe("command-center");
    expect(env["CC_SESSION"]).toBe("my-session");
    expect(env["CC_CONVERSATION_ID"]).toBe("conv-123");
    expect(env["BASH_MAX_TIMEOUT_MS"]).toBe("1800000");
  });

  it("prepends <configDir>/bin to PATH without clobbering the existing PATH", () => {
    const env = buildSessionEnvContract({
      ...IDENTITY,
      baseEnv: { PATH: "/usr/bin:/bin" },
      serverUrl: null,
      apiToken: null,
    });

    expect(env["PATH"]).toBe(
      `${path.join("/cfg", "bin")}${path.delimiter}/usr/bin:/bin`,
    );
  });

  it("sets PATH to the bin dir alone when the base env has no PATH", () => {
    const env = buildSessionEnvContract({
      ...IDENTITY,
      baseEnv: {},
      serverUrl: null,
      apiToken: null,
    });

    expect(env["PATH"]).toBe(path.join("/cfg", "bin"));
  });

  it("does not prepend the bin dir twice", () => {
    const binDir = path.join("/cfg", "bin");
    const env = buildSessionEnvContract({
      ...IDENTITY,
      baseEnv: { PATH: `${binDir}${path.delimiter}/usr/bin` },
      serverUrl: null,
      apiToken: null,
    });

    expect(env["PATH"]).toBe(`${binDir}${path.delimiter}/usr/bin`);
  });

  it("omits CC_SERVER_URL / CC_API_TOKEN when unresolved rather than setting empty strings", () => {
    const env = buildSessionEnvContract({
      ...IDENTITY,
      baseEnv: {},
      serverUrl: null,
      apiToken: null,
    });

    expect("CC_SERVER_URL" in env).toBe(false);
    expect("CC_API_TOKEN" in env).toBe(false);
  });

  it("respects a BASH_MAX_TIMEOUT_MS already present in the base env", () => {
    const env = buildSessionEnvContract({
      ...IDENTITY,
      baseEnv: { BASH_MAX_TIMEOUT_MS: "3600000" },
      serverUrl: null,
      apiToken: null,
    });

    expect(env["BASH_MAX_TIMEOUT_MS"]).toBe("3600000");
  });

  it("does not mutate the base env", () => {
    const baseEnv = { PATH: "/usr/bin" };
    buildSessionEnvContract({
      ...IDENTITY,
      baseEnv,
      serverUrl: "http://127.0.0.1:3000",
      apiToken: "tok",
    });

    expect(baseEnv).toEqual({ PATH: "/usr/bin" });
  });

  it("preserves unrelated base env vars", () => {
    const env = buildSessionEnvContract({
      ...IDENTITY,
      baseEnv: { HOME: "/Users/alex", NODE_ENV: "development" },
      serverUrl: null,
      apiToken: null,
    });

    expect(env["HOME"]).toBe("/Users/alex");
    expect(env["NODE_ENV"]).toBe("development");
  });

  it("injects both lane identity vars for a graph-workflow lane conversation", () => {
    const env = buildSessionEnvContract({
      ...IDENTITY,
      baseEnv: {},
      serverUrl: "http://127.0.0.1:3000",
      apiToken: "tok",
      workflowExecutionId: "exec-9",
      workflowContextId: "context-plan",
    });

    expect(env["CC_WORKFLOW_EXECUTION_ID"]).toBe("exec-9");
    expect(env["CC_WORKFLOW_CONTEXT_ID"]).toBe("context-plan");
  });

  it("omits both lane identity vars for a non-lane session", () => {
    const env = buildSessionEnvContract({
      ...IDENTITY,
      baseEnv: {},
      serverUrl: "http://127.0.0.1:3000",
      apiToken: "tok",
    });

    expect("CC_WORKFLOW_EXECUTION_ID" in env).toBe(false);
    expect("CC_WORKFLOW_CONTEXT_ID" in env).toBe(false);
  });
});
