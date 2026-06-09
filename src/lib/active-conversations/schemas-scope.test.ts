import { describe, it, expect } from "vitest";
import {
  activeConversationSchema,
  activeConversationsResponseSchema,
} from "./schemas";

const sessionVariant = {
  scope: "session" as const,
  id: "c1",
  name: "Feature work",
  status: "running" as const,
  lastActivityAt: "2025-01-01T00:00:00.000Z",
  projectName: "demo",
  projectPath: "/repo",
  sessionName: "feature-x",
  agentBackend: "claude" as const,
  summary: null,
  pendingQuestion: null,
  pendingQuestionId: null,
  pendingQuestions: null,
  forkedFrom: null,
  debugActive: false,
  role: null,
  branchName: "csm/feature-x",
  worktreePath: "/repo/.worktrees/feature-x",
  lastActivitySummary: null,
  unread: false,
};

const projectVariant = {
  scope: "project" as const,
  id: "p1",
  name: "Repo chat",
  status: "awaiting" as const,
  lastActivityAt: "2025-01-02T00:00:00.000Z",
  projectName: "demo",
  projectPath: "/repo",
  agentBackend: "claude" as const,
  summary: null,
  pendingQuestion: null,
  pendingQuestionId: null,
  pendingQuestions: null,
  forkedFrom: null,
  debugActive: false,
  role: null,
  worktreePath: "/repo",
  lastActivitySummary: null,
  unread: false,
  open: true,
};

describe("activeConversationSchema scope union", () => {
  it("parses today's session active-conversation object (session variant)", () => {
    const result = activeConversationSchema.safeParse(sessionVariant);
    expect(result.success).toBe(true);
    if (result.success && result.data.scope === "session") {
      expect(result.data.sessionName).toBe("feature-x");
      expect(result.data.branchName).toBe("csm/feature-x");
    }
  });

  it("parses a project-variant object without sessionName", () => {
    const result = activeConversationSchema.safeParse(projectVariant);
    expect(result.success).toBe(true);
    expect(result.success && result.data.scope).toBe("project");
    expect(
      result.success && result.data.scope === "project" && result.data.open,
    ).toBe(true);
  });

  it("rejects a project-variant object missing open state", () => {
    const { open: _omit, ...withoutOpen } = projectVariant;
    void _omit;
    expect(activeConversationSchema.safeParse(withoutOpen).success).toBe(false);
  });

  it("rejects a session-scope object missing sessionName", () => {
    const { sessionName: _omit, ...withoutSession } = sessionVariant;
    void _omit;
    expect(activeConversationSchema.safeParse(withoutSession).success).toBe(
      false,
    );
  });

  it("accepts a mixed conversations[] array in the response", () => {
    const result = activeConversationsResponseSchema.safeParse({
      conversations: [sessionVariant, projectVariant],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.conversations).toHaveLength(2);
  });
});
