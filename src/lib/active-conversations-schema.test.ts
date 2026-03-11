import { describe, it, expect } from "vitest";
import {
  activeConversationSchema,
  activeConversationsResponseSchema,
} from "./api-client";

const BASE_CONVERSATION = {
  id: "conv-1",
  name: "Test conversation",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  projectName: "my-project",
  projectPath: "/home/user/my-project",
  sessionName: "my-session",
};

describe("activeConversationSchema", () => {
  it("accepts status 'running'", () => {
    const result = activeConversationSchema.safeParse({
      ...BASE_CONVERSATION,
      status: "running",
    });
    expect(result.success).toBe(true);
  });

  it("accepts status 'awaiting'", () => {
    const result = activeConversationSchema.safeParse({
      ...BASE_CONVERSATION,
      status: "awaiting",
    });
    expect(result.success).toBe(true);
  });

  it("accepts status 'waiting_for_input'", () => {
    const result = activeConversationSchema.safeParse({
      ...BASE_CONVERSATION,
      status: "waiting_for_input",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown status", () => {
    const result = activeConversationSchema.safeParse({
      ...BASE_CONVERSATION,
      status: "unknown",
    });
    expect(result.success).toBe(false);
  });
});

describe("activeConversationsResponseSchema", () => {
  it("parses a response with mixed statuses including waiting_for_input", () => {
    const result = activeConversationsResponseSchema.safeParse({
      conversations: [
        { ...BASE_CONVERSATION, id: "conv-1", status: "running" },
        { ...BASE_CONVERSATION, id: "conv-2", status: "awaiting" },
        { ...BASE_CONVERSATION, id: "conv-3", status: "waiting_for_input" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.conversations).toHaveLength(3);
      expect(result.data.conversations[2]!.status).toBe("waiting_for_input");
    }
  });
});
