import { describe, it, expect } from "vitest";
import {
  activeConversationSchema,
  activeConversationsResponseSchema,
} from "./schemas";

const BASE_CONVERSATION = {
  id: "conv-1",
  name: "Test conversation",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  projectName: "my-project",
  projectPath: "/home/user/my-project",
  sessionName: "my-session",
  agentBackend: "claude" as const,
  summary: null,
  pendingQuestion: null,
  forkedFrom: null,
  debugActive: false,
  role: null,
  branchName: null,
  worktreePath: "/tmp/my-session",
  lastActivitySummary: null,
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

  describe("new fields", () => {
    it("accepts a populated summary string", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "running",
        summary: "Implementing the sidebar",
      });
      expect(result.success).toBe(true);
    });

    it("accepts pendingQuestion as a string", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "awaiting",
        pendingQuestion: "Do you want to proceed?",
      });
      expect(result.success).toBe(true);
    });

    it("rejects pendingQuestion as a non-string value", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "awaiting",
        pendingQuestion: 42,
      });
      expect(result.success).toBe(false);
    });

    it("accepts a forkedFrom object with mode 'synthetic'", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "running",
        forkedFrom: {
          conversationId: "parent-conv",
          messageIndex: 4,
          mode: "synthetic",
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts a forkedFrom object with mode 'native'", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "running",
        forkedFrom: {
          conversationId: "parent-conv",
          messageIndex: 4,
          mode: "native",
        },
      });
      expect(result.success).toBe(true);
    });

    it("rejects forkedFrom with an unknown mode", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "running",
        forkedFrom: {
          conversationId: "parent-conv",
          messageIndex: 4,
          mode: "bogus",
        },
      });
      expect(result.success).toBe(false);
    });

    it("rejects forkedFrom missing required fields", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "running",
        forkedFrom: { conversationId: "parent-conv" },
      });
      expect(result.success).toBe(false);
    });

    it("accepts debugActive=true", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "running",
        debugActive: true,
      });
      expect(result.success).toBe(true);
    });

    it("rejects debugActive as a non-boolean", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "running",
        debugActive: "yes",
      });
      expect(result.success).toBe(false);
    });

    it("accepts role 'initialization'", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "running",
        role: "initialization",
      });
      expect(result.success).toBe(true);
    });

    it("accepts role 'iteration' (schema-permitted; runtime filter excludes)", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "running",
        role: "iteration",
      });
      expect(result.success).toBe(true);
    });

    it("accepts role 'validator' (schema-permitted; runtime filter excludes)", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "running",
        role: "validator",
      });
      expect(result.success).toBe(true);
    });

    it("rejects an unknown role", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "running",
        role: "owner",
      });
      expect(result.success).toBe(false);
    });

    it("accepts branchName as a string", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "running",
        branchName: "csm/my-session",
      });
      expect(result.success).toBe(true);
    });

    it("rejects branchName as a non-string non-null value", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "running",
        branchName: 7,
      });
      expect(result.success).toBe(false);
    });

    it("accepts lastActivitySummary as a string", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "running",
        lastActivitySummary: "Editing src/foo.ts",
      });
      expect(result.success).toBe(true);
    });

    it("rejects lastActivitySummary as a non-string non-null value", () => {
      const result = activeConversationSchema.safeParse({
        ...BASE_CONVERSATION,
        status: "running",
        lastActivitySummary: { text: "Editing" },
      });
      expect(result.success).toBe(false);
    });
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
