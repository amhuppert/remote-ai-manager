import { describe, it, expect } from "vitest";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { pendingPromptRequestSchema } from "./schemas";

const baseConversation = {
  id: "00000000-0000-0000-0000-000000000000",
  transcriptPath: null,
  status: "awaiting" as const,
  promptCount: 0,
  createdAt: "2025-01-01T00:00:00.000Z",
  lastActivityAt: "2025-01-01T00:00:00.000Z",
};

describe("conversationStateSchema.pendingPromptText", () => {
  it("round-trips a non-null string value", () => {
    const parsed = conversationStateSchema.parse({
      ...baseConversation,
      pendingPromptText: "draft prompt text",
    });
    expect(parsed.pendingPromptText).toBe("draft prompt text");
  });

  it("round-trips a null value", () => {
    const parsed = conversationStateSchema.parse({
      ...baseConversation,
      pendingPromptText: null,
    });
    expect(parsed.pendingPromptText).toBeNull();
  });

  it("preserves multi-line text", () => {
    const value = "line one\nline two\n\nline four";
    const parsed = conversationStateSchema.parse({
      ...baseConversation,
      pendingPromptText: value,
    });
    expect(parsed.pendingPromptText).toBe(value);
  });

  it("defaults to null when the field is omitted", () => {
    const parsed = conversationStateSchema.parse(baseConversation);
    expect(parsed.pendingPromptText).toBeNull();
  });

  it("rejects non-string non-null values", () => {
    const result = conversationStateSchema.safeParse({
      ...baseConversation,
      pendingPromptText: 42,
    });
    expect(result.success).toBe(false);
  });
});

describe("pendingPromptRequestSchema", () => {
  it("accepts a non-empty string", () => {
    const result = pendingPromptRequestSchema.safeParse({ text: "hello" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.text).toBe("hello");
  });

  it("accepts an empty string", () => {
    const result = pendingPromptRequestSchema.safeParse({ text: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.text).toBe("");
  });

  it("accepts null", () => {
    const result = pendingPromptRequestSchema.safeParse({ text: null });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.text).toBeNull();
  });

  it("rejects a missing text field", () => {
    const result = pendingPromptRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects a number value", () => {
    const result = pendingPromptRequestSchema.safeParse({ text: 42 });
    expect(result.success).toBe(false);
  });

  it("rejects an undefined text field", () => {
    const result = pendingPromptRequestSchema.safeParse({ text: undefined });
    expect(result.success).toBe(false);
  });
});
