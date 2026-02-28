import { describe, it, expect } from "vitest";
import {
  sessionCreationModeSchema,
  createSessionRequestSchema,
  sessionStateSchema,
} from "./schemas";

describe("sessionCreationModeSchema — optimistic variant", () => {
  it('should accept "optimistic" as a valid creation mode', () => {
    const result = sessionCreationModeSchema.safeParse("optimistic");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("optimistic");
    }
  });

  it('should still accept "fast" as a valid creation mode', () => {
    const result = sessionCreationModeSchema.safeParse("fast");
    expect(result.success).toBe(true);
  });

  it('should still accept "focus" as a valid creation mode', () => {
    const result = sessionCreationModeSchema.safeParse("focus");
    expect(result.success).toBe(true);
  });

  it("should reject invalid creation modes", () => {
    const result = sessionCreationModeSchema.safeParse("invalid");
    expect(result.success).toBe(false);
  });
});

describe("createSessionRequestSchema — optimistic variant", () => {
  it("should accept a valid optimistic request with instructions", () => {
    const result = createSessionRequestSchema.safeParse({
      mode: "optimistic",
      instructions: "Fix the typo in README.md",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        mode: "optimistic",
        instructions: "Fix the typo in README.md",
      });
    }
  });

  it("should trim whitespace from instructions", () => {
    const result = createSessionRequestSchema.safeParse({
      mode: "optimistic",
      instructions: "  Fix the bug  ",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.mode === "optimistic") {
      expect(result.data.instructions).toBe("Fix the bug");
    }
  });

  it("should reject optimistic request with empty instructions", () => {
    const result = createSessionRequestSchema.safeParse({
      mode: "optimistic",
      instructions: "",
    });
    expect(result.success).toBe(false);
  });

  it("should reject optimistic request with whitespace-only instructions", () => {
    const result = createSessionRequestSchema.safeParse({
      mode: "optimistic",
      instructions: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("should reject optimistic request without instructions field", () => {
    const result = createSessionRequestSchema.safeParse({
      mode: "optimistic",
    });
    expect(result.success).toBe(false);
  });

  it("should still accept valid fast mode requests", () => {
    const result = createSessionRequestSchema.safeParse({
      mode: "fast",
      sessionName: "my-session",
    });
    expect(result.success).toBe(true);
  });

  it("should still accept valid focus mode requests", () => {
    const result = createSessionRequestSchema.safeParse({
      mode: "focus",
      objective: "Implement the auth system",
    });
    expect(result.success).toBe(true);
  });
});

describe("sessionStateSchema — optimistic creationMode", () => {
  const baseSession = {
    sessionName: "test-session",
    worktreePath: "/tmp/test",
    branchName: "csm/test",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    archived: false,
    conversations: [],
  };

  it("should accept a session with creationMode: optimistic", () => {
    const result = sessionStateSchema.safeParse({
      ...baseSession,
      creationMode: "optimistic",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.creationMode).toBe("optimistic");
    }
  });

  it('should default creationMode to "fast" when not specified', () => {
    const result = sessionStateSchema.safeParse(baseSession);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.creationMode).toBe("fast");
    }
  });

  it("should accept sessions with existing fast/focus modes", () => {
    const fastResult = sessionStateSchema.safeParse({
      ...baseSession,
      creationMode: "fast",
    });
    const focusResult = sessionStateSchema.safeParse({
      ...baseSession,
      creationMode: "focus",
    });
    expect(fastResult.success).toBe(true);
    expect(focusResult.success).toBe(true);
  });
});
