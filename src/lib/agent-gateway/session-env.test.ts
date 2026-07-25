import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  projectConversationTarget,
  sessionConversationTarget,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { buildSessionEnvContract } from "./session-env";

const IDENTITY = {
  target: sessionConversationTarget("command-center", "my-session", "conv-123"),
  configDir: "/cfg",
};

const PROJECT_IDENTITY = {
  target: projectConversationTarget("command-center", "conv-123"),
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

  it("neutralizes every inherited CC_* var with an empty-string override when the contract omits it", () => {
    // Presence (not deletion) matters: the Claude Agent SDK merges this env
    // over process.env, so a deleted key resurrects the parent's ambient
    // value — only "" wins under both merge and replace semantics.
    const env = buildSessionEnvContract({
      ...IDENTITY,
      baseEnv: {
        CC_SERVER_URL: "http://127.0.0.1:3000",
        CC_API_TOKEN: "prod-tok",
        CC_WORKFLOW_EXECUTION_ID: "outer-exec",
        CC_WORKFLOW_CONTEXT_ID: "outer-ctx",
        CC_CONFIG_DIR: "/prod/cfg",
      },
      serverUrl: null,
      apiToken: null,
    });

    for (const key of [
      "CC_SERVER_URL",
      "CC_API_TOKEN",
      "CC_WORKFLOW_EXECUTION_ID",
      "CC_WORKFLOW_CONTEXT_ID",
      "CC_CONFIG_DIR",
    ]) {
      expect(key in env, `${key} must be present`).toBe(true);
      expect(env[key], `${key} must be neutralized`).toBe("");
    }
  });

  it("lets intended contract values win over ambient CC_* vars", () => {
    const env = buildSessionEnvContract({
      ...IDENTITY,
      baseEnv: {
        CC_SERVER_URL: "http://127.0.0.1:3000",
        CC_API_TOKEN: "prod-tok",
        CC_PROJECT: "other-project",
        CC_SESSION: "other-session",
        CC_CONVERSATION_ID: "other-conv",
        CC_WORKFLOW_EXECUTION_ID: "outer-exec",
        CC_WORKFLOW_CONTEXT_ID: "outer-ctx",
      },
      serverUrl: "http://127.0.0.1:3071",
      apiToken: "dev-tok",
      workflowExecutionId: "exec-9",
      workflowContextId: "context-plan",
    });

    expect(env["CC_SERVER_URL"]).toBe("http://127.0.0.1:3071");
    expect(env["CC_API_TOKEN"]).toBe("dev-tok");
    expect(env["CC_PROJECT"]).toBe("command-center");
    expect(env["CC_SESSION"]).toBe("my-session");
    expect(env["CC_CONVERSATION_ID"]).toBe("conv-123");
    expect(env["CC_WORKFLOW_EXECUTION_ID"]).toBe("exec-9");
    expect(env["CC_WORKFLOW_CONTEXT_ID"]).toBe("context-plan");
  });

  it("leaves non-CC keys untouched while neutralizing the CC_ namespace", () => {
    const env = buildSessionEnvContract({
      ...IDENTITY,
      baseEnv: {
        PATH: "/usr/bin",
        HOME: "/Users/alex",
        NODE_ENV: "development",
        BASH_MAX_TIMEOUT_MS: "3600000",
        CC_ENV: "production",
      },
      serverUrl: null,
      apiToken: null,
    });

    expect(env["HOME"]).toBe("/Users/alex");
    expect(env["NODE_ENV"]).toBe("development");
    expect(env["BASH_MAX_TIMEOUT_MS"]).toBe("3600000");
    expect(env["PATH"]).toContain("/usr/bin");
    expect(env["CC_ENV"]).toBe("");
  });
  it("exports the session scope discriminator for a session conversation", () => {
    const env = buildSessionEnvContract({
      ...IDENTITY,
      baseEnv: {},
      serverUrl: null,
      apiToken: null,
    });

    expect(env["CC_CONVERSATION_SCOPE"]).toBe("session");
    expect(env["CC_SESSION"]).toBe("my-session");
  });

  it("exports the project scope discriminator for a project conversation", () => {
    const env = buildSessionEnvContract({
      ...PROJECT_IDENTITY,
      baseEnv: {},
      serverUrl: null,
      apiToken: null,
    });

    expect(env["CC_CONVERSATION_SCOPE"]).toBe("project");
    expect(env["CC_PROJECT"]).toBe("command-center");
    expect(env["CC_CONVERSATION_ID"]).toBe("conv-123");
  });

  it("exports CC_SESSION as an explicitly neutralized empty value for a project conversation", () => {
    // Presence, not omission: the contract is merged OVER process.env, so a
    // deleted CC_SESSION resurrects the ambient value.
    const env = buildSessionEnvContract({
      ...PROJECT_IDENTITY,
      baseEnv: {},
      serverUrl: null,
      apiToken: null,
    });

    expect("CC_SESSION" in env).toBe(true);
    expect(env["CC_SESSION"]).toBe("");
  });

  it("never leaks the project sentinel into the agent environment", () => {
    const env = buildSessionEnvContract({
      ...PROJECT_IDENTITY,
      baseEnv: {},
      serverUrl: null,
      apiToken: null,
    });

    for (const [key, value] of Object.entries(env)) {
      expect(value, `${key} must not carry the sentinel`).not.toContain(
        "__project__",
      );
    }
  });

  it("neutralizes an ambient CC_SESSION rather than letting it survive for a project conversation", () => {
    const env = buildSessionEnvContract({
      ...PROJECT_IDENTITY,
      baseEnv: { CC_SESSION: "outer-session" },
      serverUrl: null,
      apiToken: null,
    });

    expect(env["CC_SESSION"]).toBe("");
  });

  it("refuses a hand-written session target carrying the sentinel instead of exporting it as CC_SESSION", () => {
    // The builders validate, but `ConversationTarget` is a structural type: a
    // caller holding a STORE session name can spell the session variant with the
    // sentinel. `conversationTargetApiBase` throws for exactly this so no public
    // URL can emit it; the env contract is the same kind of public surface (the
    // agent reads CC_SESSION and routes with it), so it needs the same last line
    // of defence rather than exporting `CC_SESSION=__project__`.
    const smuggled: ConversationTarget = {
      scope: "session",
      projectName: "command-center",
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      conversationId: "conv-123",
    };

    const build = () =>
      buildSessionEnvContract({
        target: smuggled,
        configDir: "/cfg",
        baseEnv: {},
        serverUrl: null,
        apiToken: null,
      });

    expect(build).toThrow(/sentinel/);
    // The refusal must not echo the value it refuses — the same rule the other
    // sentinel refusal guards follow, since this message reaches logs.
    expect(build).not.toThrow(
      new RegExp(PROJECT_CONVERSATION_SESSION_SENTINEL),
    );
  });
});
