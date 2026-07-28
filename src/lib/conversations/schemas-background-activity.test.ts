import { describe, it, expect } from "vitest";
import {
  conversationBackgroundActivityEventSchema,
  conversationBackgroundActivitySchema,
} from "./schemas";

const TASK = {
  taskId: "task-1",
  description: "run the spec workflow",
  taskType: "local_workflow",
  workflowName: "spec",
  subagentType: null,
  lastToolName: "Read",
  totalTokens: 120,
  toolUses: 3,
  startedAt: "2026-07-28T10:00:00.000Z",
  lastActivityAt: "2026-07-28T10:04:00.000Z",
};

describe("conversationBackgroundActivitySchema", () => {
  it("parses a snapshot with at least one task", () => {
    const result = conversationBackgroundActivitySchema.safeParse({
      tasks: [TASK],
      updatedAt: "2026-07-28T10:04:01.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty task list (absence is expressed as a null snapshot)", () => {
    const result = conversationBackgroundActivitySchema.safeParse({
      tasks: [],
      updatedAt: "2026-07-28T10:04:01.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("requires the nullable metadata fields to be present", () => {
    const { subagentType: _omitted, ...withoutSubagentType } = TASK;
    const result = conversationBackgroundActivitySchema.safeParse({
      tasks: [withoutSubagentType],
      updatedAt: "2026-07-28T10:04:01.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("conversationBackgroundActivityEventSchema", () => {
  const activity = { tasks: [TASK], updatedAt: "2026-07-28T10:04:01.000Z" };

  it("parses the session variant", () => {
    expect(
      conversationBackgroundActivityEventSchema.safeParse({
        type: "conversation-background-activity",
        scope: "session",
        projectName: "demo",
        sessionName: "feature-x",
        conversationId: "conv-1",
        activity,
      }).success,
    ).toBe(true);
  });

  it("parses the project variant with no sessionName", () => {
    expect(
      conversationBackgroundActivityEventSchema.safeParse({
        type: "conversation-background-activity",
        scope: "project",
        projectName: "demo",
        conversationId: "conv-1",
        activity,
      }).success,
    ).toBe(true);
  });

  it("rejects a project variant carrying sessionName", () => {
    expect(
      conversationBackgroundActivityEventSchema.safeParse({
        type: "conversation-background-activity",
        scope: "project",
        projectName: "demo",
        sessionName: "feature-x",
        conversationId: "conv-1",
        activity,
      }).success,
    ).toBe(false);
  });

  it("carries a null activity to signal the set drained", () => {
    expect(
      conversationBackgroundActivityEventSchema.safeParse({
        type: "conversation-background-activity",
        scope: "session",
        projectName: "demo",
        sessionName: "feature-x",
        conversationId: "conv-1",
        activity: null,
      }).success,
    ).toBe(true);
  });

  it("tolerates the broadcaster's _sentAt envelope field on the session variant", () => {
    expect(
      conversationBackgroundActivityEventSchema.safeParse({
        type: "conversation-background-activity",
        scope: "session",
        projectName: "demo",
        sessionName: "feature-x",
        conversationId: "conv-1",
        activity,
        _sentAt: 1234567890,
      }).success,
    ).toBe(true);
  });
});
