import { describe, it, expect } from "vitest";
import { transcriptMessageSchema } from "./schemas";

const baseMessage = {
  role: "user" as const,
  content: [{ type: "text" as const, text: "hi" }],
  timestamp: "2025-01-01T00:00:00.000Z",
};

describe("transcriptMessageSchema — optional origin field", () => {
  it("accepts a message with origin omitted (legacy shape)", () => {
    const result = transcriptMessageSchema.safeParse(baseMessage);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.origin).toBeUndefined();
    }
  });

  it("accepts a message with origin.source='user' and no workflow sub-object", () => {
    const result = transcriptMessageSchema.safeParse({
      ...baseMessage,
      origin: { source: "user" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.origin).toEqual({ source: "user" });
    }
  });

  it("accepts a message with origin.source='workflow' and a workflow sub-object", () => {
    const origin = {
      source: "workflow" as const,
      workflow: {
        executionId: "exec-1",
        nodeId: "node-a",
        iterationIndex: 0,
      },
    };
    const result = transcriptMessageSchema.safeParse({
      ...baseMessage,
      origin,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.origin).toEqual(origin);
    }
  });

  it("accepts a message with origin.source='workflow' missing the workflow sub-object", () => {
    const result = transcriptMessageSchema.safeParse({
      ...baseMessage,
      origin: { source: "workflow" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.origin).toEqual({ source: "workflow" });
    }
  });

  it("rejects an unknown origin.source value", () => {
    const result = transcriptMessageSchema.safeParse({
      ...baseMessage,
      origin: { source: "external" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a workflow sub-object missing required fields", () => {
    const result = transcriptMessageSchema.safeParse({
      ...baseMessage,
      origin: {
        source: "workflow",
        workflow: { executionId: "exec-1" },
      },
    });
    expect(result.success).toBe(false);
  });
});
