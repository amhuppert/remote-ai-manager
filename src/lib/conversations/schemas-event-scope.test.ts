import { describe, it, expect } from "vitest";
import {
  conversationStatusEventSchema,
  conversationCreatedEventSchema,
  conversationOpenEventSchema,
  askQuestionEventSchema,
  messageQueuedEventSchema,
} from "./schemas";

describe("conversation SSE events — scope discrimination", () => {
  it("parses today's session-event payload when scope:session is stamped", () => {
    const result = conversationStatusEventSchema.safeParse({
      type: "conversation-status",
      scope: "session",
      projectName: "demo",
      sessionName: "feature-x",
      conversationId: "conv-1",
      status: "running",
    });
    expect(result.success).toBe(true);
  });

  it("tolerates the broadcaster's _sentAt envelope field on the session variant", () => {
    const result = conversationStatusEventSchema.safeParse({
      type: "conversation-status",
      scope: "session",
      projectName: "demo",
      sessionName: "feature-x",
      conversationId: "conv-1",
      status: "running",
      _sentAt: 1234567890,
    });
    expect(result.success).toBe(true);
  });

  it("parses a project-variant event with no sessionName", () => {
    const result = conversationStatusEventSchema.safeParse({
      type: "conversation-status",
      scope: "project",
      projectName: "demo",
      conversationId: "conv-1",
      status: "running",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a project-variant event that carries sessionName", () => {
    const result = conversationStatusEventSchema.safeParse({
      type: "conversation-status",
      scope: "project",
      projectName: "demo",
      sessionName: "feature-x",
      conversationId: "conv-1",
      status: "running",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an event missing scope (producers must stamp it)", () => {
    const result = conversationStatusEventSchema.safeParse({
      type: "conversation-status",
      projectName: "demo",
      sessionName: "feature-x",
      conversationId: "conv-1",
      status: "running",
    });
    expect(result.success).toBe(false);
  });

  it("discriminates conversation-created across scopes", () => {
    const conversation = {
      id: "conv-1",
      scope: "project" as const,
      transcriptPath: null,
      status: "new" as const,
      promptCount: 0,
      createdAt: "2025-01-01T00:00:00.000Z",
      lastActivityAt: "2025-01-01T00:00:00.000Z",
    };
    expect(
      conversationCreatedEventSchema.safeParse({
        type: "conversation-created",
        scope: "project",
        projectName: "demo",
        conversation,
      }).success,
    ).toBe(true);
    expect(
      conversationCreatedEventSchema.safeParse({
        type: "conversation-created",
        scope: "project",
        projectName: "demo",
        sessionName: "feature-x",
        conversation,
      }).success,
    ).toBe(false);
  });

  it("discriminates ask-question and message-queued", () => {
    expect(
      askQuestionEventSchema.safeParse({
        type: "ask-question",
        scope: "project",
        projectName: "demo",
        conversationId: "conv-1",
        questionId: "q-1",
        questions: [],
      }).success,
    ).toBe(true);
    expect(
      messageQueuedEventSchema.safeParse({
        type: "message-queued",
        scope: "session",
        projectName: "demo",
        sessionName: "feature-x",
        conversationId: "conv-1",
        text: "hi",
      }).success,
    ).toBe(true);
  });

  it("accepts the project-only conversation-open event", () => {
    expect(
      conversationOpenEventSchema.safeParse({
        type: "conversation-open",
        scope: "project",
        projectName: "demo",
        conversationId: "conv-1",
        open: false,
      }).success,
    ).toBe(true);
  });
});
