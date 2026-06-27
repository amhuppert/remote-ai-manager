import { describe, it, expect } from "vitest";
import { conversationScopeSchema, conversationStateSchema } from "./schemas";
import {
  PROJECT_CONVERSATION_SESSION_SENTINEL,
  isProjectSentinel,
  conversationEventScopeFields,
} from "./project-conversation-scope";
import { sessionStateSchema } from "@/lib/sessions/schemas";

describe("conversationEventScopeFields", () => {
  it("returns the session variant for a real session name", () => {
    expect(conversationEventScopeFields("proj", "feature-x", "c1")).toEqual({
      scope: "session",
      projectName: "proj",
      sessionName: "feature-x",
      conversationId: "c1",
    });
  });

  it("returns the project variant (no sessionName) for the sentinel", () => {
    expect(
      conversationEventScopeFields(
        "proj",
        PROJECT_CONVERSATION_SESSION_SENTINEL,
        "c1",
      ),
    ).toEqual({ scope: "project", projectName: "proj", conversationId: "c1" });
  });
});

const baseConversation = {
  id: "00000000-0000-0000-0000-000000000000",
  transcriptPath: null,
  status: "awaiting" as const,
  promptCount: 0,
  createdAt: "2025-01-01T00:00:00.000Z",
  lastActivityAt: "2025-01-01T00:00:00.000Z",
};

describe("conversationScopeSchema", () => {
  it("defaults to session when scope is absent", () => {
    expect(conversationScopeSchema.parse(undefined)).toBe("session");
  });

  it("accepts session and project", () => {
    expect(conversationScopeSchema.parse("session")).toBe("session");
    expect(conversationScopeSchema.parse("project")).toBe("project");
  });

  it("rejects unknown scope values", () => {
    expect(conversationScopeSchema.safeParse("global").success).toBe(false);
  });
});

describe("conversationStateSchema scope field", () => {
  it("decodes a legacy conversation (no scope) as scope:session", () => {
    const parsed = conversationStateSchema.parse(baseConversation);
    expect(parsed.scope).toBe("session");
  });

  it("decodes an explicit project record as scope:project", () => {
    const parsed = conversationStateSchema.parse({
      ...baseConversation,
      scope: "project",
    });
    expect(parsed.scope).toBe("project");
  });

  it("rejects an unknown scope on a conversation", () => {
    const result = conversationStateSchema.safeParse({
      ...baseConversation,
      scope: "nope",
    });
    expect(result.success).toBe(false);
  });
});

describe("conversationStateSchema lastSeenAlignmentVersion field", () => {
  it("defaults lastSeenAlignmentVersion to null when absent", () => {
    const parsed = conversationStateSchema.parse(baseConversation);
    expect(parsed.lastSeenAlignmentVersion).toBe(null);
  });

  it("preserves an explicit integer lastSeenAlignmentVersion", () => {
    const parsed = conversationStateSchema.parse({
      ...baseConversation,
      lastSeenAlignmentVersion: 3,
    });
    expect(parsed.lastSeenAlignmentVersion).toBe(3);
  });

  it("accepts an explicit null lastSeenAlignmentVersion", () => {
    const parsed = conversationStateSchema.parse({
      ...baseConversation,
      lastSeenAlignmentVersion: null,
    });
    expect(parsed.lastSeenAlignmentVersion).toBe(null);
  });

  it("rejects a non-integer lastSeenAlignmentVersion", () => {
    const result = conversationStateSchema.safeParse({
      ...baseConversation,
      lastSeenAlignmentVersion: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("sessionStateSchema with embedded conversations", () => {
  it("still parses a legacy session, defaulting nested conversations to scope:session", () => {
    const parsed = sessionStateSchema.parse({
      sessionName: "feature-x",
      worktreePath: "/repo/.worktrees/feature-x",
      branchName: "csm/feature-x",
      createdAt: "2025-01-01T00:00:00.000Z",
      lastActivityAt: "2025-01-01T00:00:00.000Z",
      conversations: [baseConversation],
    });
    expect(parsed.conversations[0]?.scope).toBe("session");
  });
});

describe("project-conversation sentinel", () => {
  it("exposes the reserved sentinel value", () => {
    expect(PROJECT_CONVERSATION_SESSION_SENTINEL).toBe("__project__");
  });

  it("matches only the sentinel", () => {
    expect(isProjectSentinel(PROJECT_CONVERSATION_SESSION_SENTINEL)).toBe(true);
    expect(isProjectSentinel("feature-x")).toBe(false);
    expect(isProjectSentinel("__planner__")).toBe(false);
  });
});
