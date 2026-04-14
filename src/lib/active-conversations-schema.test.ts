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
  agentBackend: "claude" as const,
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

  it("accepts status 'new'", () => {
    const result = activeConversationSchema.safeParse({
      ...BASE_CONVERSATION,
      status: "new",
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
  it("parses a response with mixed statuses including new and waiting_for_input", () => {
    const result = activeConversationsResponseSchema.safeParse({
      conversations: [
        { ...BASE_CONVERSATION, id: "conv-1", status: "running" },
        { ...BASE_CONVERSATION, id: "conv-2", status: "awaiting" },
        { ...BASE_CONVERSATION, id: "conv-3", status: "waiting_for_input" },
        { ...BASE_CONVERSATION, id: "conv-4", status: "new" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.conversations).toHaveLength(4);
      expect(result.data.conversations[3]!.status).toBe("new");
    }
  });
});
