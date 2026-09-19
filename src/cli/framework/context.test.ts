import { recoveryFacts } from "cli-for-agents";
import { describe, expect, it } from "vitest";
import { conversationTargetApiBase } from "@/lib/conversations/conversation-target";
import type { CcApplication } from "./family";
import {
  resolveCcConversation,
  resolveCcConversationTarget,
  resolveCcLane,
  resolveCcPrincipal,
  resolveCcProject,
  resolveCcProjectConversation,
  resolveCcSession,
  resolveCcServer,
  sessionReference,
} from "./context";

function application(overrides: Partial<CcApplication> = {}): CcApplication {
  return {
    host: {
      async fetch() {
        throw new Error("Context resolution must not fetch");
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
    },
    env: {
      CC_SERVER_URL: "http://cc.test",
      CC_PROJECT: "ambient-project",
      CC_SESSION: "ambient-session",
      CC_CONVERSATION_ID: "ambient-conversation",
      CC_API_TOKEN: "ambient-token",
    },
    globals: {},
    ...overrides,
  };
}

describe("native CC context resolution", () => {
  it("resolves server credentials without requiring a project", async () => {
    const app = application();
    delete app.env["CC_PROJECT"];
    expect(await resolveCcServer(app)).toEqual({
      ok: true,
      value: {
        server: "http://cc.test",
        token: "ambient-token",
        tokenSource: "env",
      },
    });
  });
  it("uses explicit target identities ahead of the environment", async () => {
    const app = application({
      globals: {
        server: "http://other.test",
        project: "other-project",
        session: "other-session",
        conversation: "other-conversation",
        token: "other-token",
      },
    });
    expect(await resolveCcConversation(app)).toEqual({
      ok: true,
      value: {
        server: "http://other.test",
        project: "other-project",
        session: "other-session",
        conversation: "other-conversation",
        token: "other-token",
        tokenSource: "flag",
      },
    });
  });

  it("resolves project-scoped conversations without a session and ignores stale ambient sessions", async () => {
    const app = application();
    app.env["CC_CONVERSATION_SCOPE"] = "project";
    const target = await resolveCcConversationTarget(app);
    expect(target).toMatchObject({
      ok: true,
      value: {
        target: {
          scope: "project",
          projectName: "ambient-project",
          conversationId: "ambient-conversation",
        },
      },
    });
    if (!target.ok) throw new Error("Expected project target");
    expect(conversationTargetApiBase(target.value.target)).toBe(
      "/api/projects/ambient-project/conversations/ambient-conversation",
    );
    expect(await resolveCcProjectConversation(app)).toMatchObject({
      ok: true,
      value: { conversation: "ambient-conversation" },
    });
  });

  it("allows an explicit session target from a neutralized project environment", async () => {
    const app = application({ globals: { session: "chosen-session" } });
    app.env["CC_CONVERSATION_SCOPE"] = "project";
    app.env["CC_SESSION"] = "";
    expect(await resolveCcConversationTarget(app)).toMatchObject({
      ok: true,
      value: { target: { scope: "session", sessionName: "chosen-session" } },
    });
  });

  it("refuses a missing required session instead of generating an empty route", async () => {
    const app = application();
    app.env["CC_SESSION"] = "";
    app.env["CC_CONVERSATION_SCOPE"] = "session";
    for (const resolve of [
      resolveCcSession,
      resolveCcConversation,
      resolveCcConversationTarget,
    ]) {
      expect(await resolve(app)).toMatchObject({
        ok: false,
        error: {
          code: "CC_USAGE",
          message: expect.stringContaining("CC_SESSION"),
        },
      });
    }
  });

  it("requires a conversation id and an addressable scope", async () => {
    const app = application();
    app.env["CC_CONVERSATION_ID"] = "";
    expect(await resolveCcConversation(app)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("CC_CONVERSATION_ID") },
    });
    app.env["CC_CONVERSATION_ID"] = "conversation";
    app.env["CC_SESSION"] = "";
    expect(await resolveCcConversationTarget(app)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("CC_CONVERSATION_SCOPE") },
    });
  });

  it("keeps caller principal identity separate from explicit routing flags", () => {
    const app = application({
      globals: {
        session: "target-session",
        conversation: "target-conversation",
      },
    });
    app.env["CC_CONVERSATION"] = "actual-caller";
    expect(resolveCcPrincipal(app)).toEqual({
      conversation: JSON.stringify({
        sessionName: "ambient-session",
        conversationId: "actual-caller",
      }),
    });
  });

  it("takes lane authority only from injected execution, context, and caller ids", async () => {
    const app = application({
      globals: { conversation: "target-conversation" },
    });
    app.env["CC_WORKFLOW_EXECUTION_ID"] = "execution";
    app.env["CC_WORKFLOW_CONTEXT_ID"] = "context";
    expect(await resolveCcLane(app)).toMatchObject({
      ok: true,
      value: {
        executionId: "execution",
        contextId: "context",
        session: "ambient-session",
      },
    });
    expect(resolveCcPrincipal(app)).toEqual({
      lane: JSON.stringify({
        laneKind: "implementer",
        executionId: "execution",
        contextId: "context",
        conversationId: "ambient-conversation",
      }),
    });
    delete app.env["CC_WORKFLOW_CONTEXT_ID"];
    expect(await resolveCcLane(app)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("CC_WORKFLOW_CONTEXT_ID") },
    });
    delete app.env["CC_WORKFLOW_EXECUTION_ID"];
    expect(await resolveCcLane(app)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("CC_WORKFLOW_EXECUTION_ID") },
    });
  });

  it("retains env and file token provenance for project context", async () => {
    const app = application();
    expect(await resolveCcProject(app)).toMatchObject({
      ok: true,
      value: { token: "ambient-token", tokenSource: "env" },
    });
    app.env["CC_API_TOKEN"] = "";
    app.env["CC_CONFIG_DIR"] = "/instance";
    app.host.readTextFile = async (file) =>
      file === "/instance/api-token" ? "file-token\n" : null;
    expect(await resolveCcProject(app)).toMatchObject({
      ok: true,
      value: { token: "file-token", tokenSource: "file" },
    });
  });
});

describe("sessionReference", () => {
  it("addresses a spaced session title as a recovery fact the kernel accepts", () => {
    const reference = sessionReference("Ticket: charter submit failed");
    expect(reference).toEqual({
      kind: "session",
      id: "Ticket%3A%20charter%20submit%20failed",
    });
    expect(() => recoveryFacts([reference])).not.toThrow();
  });
});
