import { describe, it, expect } from "vitest";
import { conversationStateSchema } from "./schemas";

const baseConversation = {
  id: "00000000-0000-0000-0000-000000000000",
  transcriptPath: null,
  status: "awaiting" as const,
  promptCount: 0,
  createdAt: "2025-01-01T00:00:00.000Z",
  lastActivityAt: "2025-01-01T00:00:00.000Z",
};

describe("conversationStateSchema.id — path-safe validation", () => {
  it("accepts canonical UUIDs", () => {
    const result = conversationStateSchema.safeParse(baseConversation);
    expect(result.success).toBe(true);
  });

  it("accepts safe alphanumeric ids with dashes and underscores", () => {
    const result = conversationStateSchema.safeParse({
      ...baseConversation,
      id: "imported_session-123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects ids containing path separators", () => {
    const result = conversationStateSchema.safeParse({
      ...baseConversation,
      id: "../etc/passwd",
    });
    expect(result.success).toBe(false);
  });

  it("rejects ids containing dots (path traversal)", () => {
    const result = conversationStateSchema.safeParse({
      ...baseConversation,
      id: "..",
    });
    expect(result.success).toBe(false);
  });

  it("rejects ids containing backslashes", () => {
    const result = conversationStateSchema.safeParse({
      ...baseConversation,
      id: "abc\\def",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty ids", () => {
    const result = conversationStateSchema.safeParse({
      ...baseConversation,
      id: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects ids longer than 128 characters", () => {
    const result = conversationStateSchema.safeParse({
      ...baseConversation,
      id: "a".repeat(129),
    });
    expect(result.success).toBe(false);
  });
});
