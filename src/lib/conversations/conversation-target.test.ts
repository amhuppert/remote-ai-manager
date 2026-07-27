import { describe, it, expect } from "vitest";
import {
  conversationTargetApiBase,
  conversationTargetKey,
  conversationTargetLogFields,
  conversationTargetSchema,
  conversationTargetScopeLabel,
  conversationTargetStoreSessionName,
  projectConversationTarget,
  sessionConversationTarget,
  targetFromStoreSessionName,
  type ConversationTarget,
} from "./conversation-target";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "./project-conversation-scope";

const session = sessionConversationTarget("demo", "feature/x", "conv-1");
const project = projectConversationTarget("demo", "conv-1");

describe("ConversationTarget variants", () => {
  it("carries project, session and conversation on the session variant", () => {
    expect(session).toEqual({
      scope: "session",
      projectName: "demo",
      sessionName: "feature/x",
      conversationId: "conv-1",
    });
  });

  it("carries project and conversation only on the project variant", () => {
    expect(project).toEqual({
      scope: "project",
      projectName: "demo",
      conversationId: "conv-1",
    });
    expect("sessionName" in project).toBe(false);
  });

  it("rejects a project variant that smuggles a session name", () => {
    const parsed = conversationTargetSchema.safeParse({
      ...project,
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a session variant addressed by the internal sentinel", () => {
    const parsed = conversationTargetSchema.safeParse({
      scope: "session",
      projectName: "demo",
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      conversationId: "conv-1",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("public identity surfaces", () => {
  it("builds the session-shaped API base", () => {
    expect(conversationTargetApiBase(session)).toBe(
      "/api/projects/demo/sessions/feature%2Fx/conversations/conv-1",
    );
  });

  it("builds the session-less project-shaped API base", () => {
    expect(conversationTargetApiBase(project)).toBe(
      "/api/projects/demo/conversations/conv-1",
    );
  });

  it("derives scope-tagged query keys that never collide across scopes", () => {
    expect(conversationTargetKey(session)).toEqual([
      "session",
      "demo",
      "feature/x",
      "conv-1",
    ]);
    expect(conversationTargetKey(project)).toEqual([
      "project",
      "demo",
      "conv-1",
    ]);
  });

  it("omits sessionName from project diagnostic identity", () => {
    expect(conversationTargetLogFields(session)).toEqual({
      scope: "session",
      projectName: "demo",
      sessionName: "feature/x",
      conversationId: "conv-1",
    });
    expect(conversationTargetLogFields(project)).toEqual({
      scope: "project",
      projectName: "demo",
      conversationId: "conv-1",
    });
  });

  it("labels the project scope without exposing the sentinel", () => {
    expect(conversationTargetScopeLabel(session)).toBe("feature/x");
    expect(conversationTargetScopeLabel(project)).toBe("project");
  });

  it("emits no sentinel on any public surface for a project target", () => {
    const emitted = JSON.stringify([
      conversationTargetApiBase(project),
      conversationTargetKey(project),
      conversationTargetLogFields(project),
      conversationTargetScopeLabel(project),
      conversationTargetSchema.parse(project),
    ]);
    expect(emitted).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
  });
});

describe("internal store adapter", () => {
  it("maps a project target onto the session-keyed sentinel", () => {
    expect(conversationTargetStoreSessionName(project)).toBe(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
    expect(conversationTargetStoreSessionName(session)).toBe("feature/x");
  });

  it("round-trips a sentinel call site back into the project variant", () => {
    expect(
      targetFromStoreSessionName(
        "demo",
        PROJECT_CONVERSATION_SESSION_SENTINEL,
        "conv-1",
      ),
    ).toEqual(project);
    expect(targetFromStoreSessionName("demo", "feature/x", "conv-1")).toEqual(
      session,
    );
  });
});

describe("public builders refuse the sentinel", () => {
  it("sessionConversationTarget rejects the sentinel as a session name", () => {
    expect(() =>
      sessionConversationTarget("demo", PROJECT_CONVERSATION_SESSION_SENTINEL, "conv-1"),
    ).toThrow();
  });

  it("conversationTargetApiBase refuses to emit a sentinel-bearing session URL", () => {
    // Guards the object-literal path a builder cannot see: the type permits
    // `{ scope: "session", sessionName: <sentinel> }` written by hand.
    const handWritten: ConversationTarget = {
      scope: "session",
      projectName: "demo",
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      conversationId: "conv-1",
    };

    expect(() => conversationTargetApiBase(handWritten)).toThrow();
  });

  it("still builds an ordinary session URL", () => {
    expect(conversationTargetApiBase(session)).toBe(
      "/api/projects/demo/sessions/feature%2Fx/conversations/conv-1",
    );
  });
});
