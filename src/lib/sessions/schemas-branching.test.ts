import { describe, it, expect } from "vitest";
import { sessionStateSchema, createSessionRequestSchema } from "./schemas";

// ===========================================================================
// sessionStateSchema — branching fields
// ===========================================================================

describe("sessionStateSchema — branching fields", () => {
  const baseSession = {
    sessionName: "test-session",
    worktreePath: "/tmp/test",
    branchName: "csm/test",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    archived: false,
    conversations: [],
  };

  it("defaults targetBranch to 'main' when not provided", () => {
    const result = sessionStateSchema.safeParse(baseSession);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targetBranch).toBe("main");
    }
  });

  it("defaults parentSessionName to null when not provided", () => {
    const result = sessionStateSchema.safeParse(baseSession);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parentSessionName).toBe(null);
    }
  });

  it("preserves explicit targetBranch value", () => {
    const result = sessionStateSchema.safeParse({
      ...baseSession,
      targetBranch: "csm/parent-session",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targetBranch).toBe("csm/parent-session");
    }
  });

  it("preserves explicit parentSessionName value", () => {
    const result = sessionStateSchema.safeParse({
      ...baseSession,
      parentSessionName: "parent-session",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parentSessionName).toBe("parent-session");
    }
  });

  it("accepts null for parentSessionName", () => {
    const result = sessionStateSchema.safeParse({
      ...baseSession,
      parentSessionName: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parentSessionName).toBe(null);
    }
  });

  it("parses both branching fields together", () => {
    const result = sessionStateSchema.safeParse({
      ...baseSession,
      targetBranch: "csm/parent-branch",
      parentSessionName: "parent-session",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targetBranch).toBe("csm/parent-branch");
      expect(result.data.parentSessionName).toBe("parent-session");
    }
  });

  it("backward compat: existing session data without branching fields parses with defaults", () => {
    // Simulate a state file entry that was created before branching was added
    const legacySession = {
      sessionName: "legacy-session",
      worktreePath: "/tmp/legacy",
      branchName: "csm/legacy",
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      archived: false,
      finished: false,
      conversations: [],
      source: "cc",
      creationMode: "normal",
      tddEnabled: true,
    };

    const result = sessionStateSchema.safeParse(legacySession);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targetBranch).toBe("main");
      expect(result.data.parentSessionName).toBe(null);
    }
  });
});

// ===========================================================================
// createSessionRequestSchema — parentSessionName field
// ===========================================================================

describe("createSessionRequestSchema — parentSessionName", () => {
  it("accepts normal mode request with parentSessionName", () => {
    const result = createSessionRequestSchema.safeParse({
      mode: "normal",
      sessionName: "child-session",
      parentSessionName: "parent-session",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parentSessionName).toBe("parent-session");
    }
  });

  it("accepts optimistic mode request with parentSessionName", () => {
    const result = createSessionRequestSchema.safeParse({
      mode: "optimistic",
      instructions: "Fix the bug",
      parentSessionName: "parent-session",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parentSessionName).toBe("parent-session");
    }
  });

  it("allows omitting parentSessionName (optional)", () => {
    const result = createSessionRequestSchema.safeParse({
      mode: "normal",
      sessionName: "standalone-session",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parentSessionName).toBeUndefined();
    }
  });

  it("trims whitespace from parentSessionName", () => {
    const result = createSessionRequestSchema.safeParse({
      mode: "normal",
      sessionName: "child",
      parentSessionName: "  parent-session  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parentSessionName).toBe("parent-session");
    }
  });

  it("rejects empty string parentSessionName", () => {
    const result = createSessionRequestSchema.safeParse({
      mode: "normal",
      sessionName: "child",
      parentSessionName: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only parentSessionName", () => {
    const result = createSessionRequestSchema.safeParse({
      mode: "normal",
      sessionName: "child",
      parentSessionName: "   ",
    });
    expect(result.success).toBe(false);
  });
});
