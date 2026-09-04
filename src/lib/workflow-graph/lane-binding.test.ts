import { describe, expect, it } from "vitest";

import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

import {
  findLaneBindingForConversation,
  resolveBoundConversationId,
} from "./lane-binding";
import { createWorkflowExecution } from "./test-fixtures";

function laneState(
  contextId: string,
  lane: "implementer" | "context_validator",
  workflowConversationId: string,
): NonNullable<GraphWorkflowExecution["laneStates"][string]>[string] {
  return {
    lane,
    contextId,
    backend: "claude",
    refKind: "conversation",
    workflowConversationId,
    metrics: { rotateBeforeNextTurn: false },
    limitEvaluation: "disabled",
    lastUsedAt: "2026-09-01T10:00:00.000Z",
  };
}

function execution(): GraphWorkflowExecution {
  const base = createWorkflowExecution();
  return createWorkflowExecution({
    id: "exec-1",
    taskStates: {
      ...base.taskStates,
      "task-implement-1": {
        ...base.taskStates["task-implement-1"]!,
        status: "running",
        lastConversationId: "conv-implementer",
      },
    },
    laneStates: {
      "context-verify": {
        general: laneState(
          "context-verify",
          "context_validator",
          "conv-validator",
        ),
      },
      "context-implement": {
        implementer: laneState(
          "context-implement",
          "implementer",
          "conv-implementer",
        ),
      },
    },
  });
}

describe("findLaneBindingForConversation", () => {
  it("is the inverse of the forward binding: a bound conversation resolves to its context", () => {
    const exec = execution();

    expect(findLaneBindingForConversation(exec, "conv-implementer")).toEqual({
      executionId: "exec-1",
      contextId: "context-implement",
    });
    expect(resolveBoundConversationId(exec, "context-implement")).toBe(
      "conv-implementer",
    );
  });

  it("places a validator lane by its lane record, which the forward binding also reads", () => {
    const exec = execution();

    expect(findLaneBindingForConversation(exec, "conv-validator")).toEqual({
      executionId: "exec-1",
      contextId: "context-verify",
    });
  });

  it("returns null for a conversation no running task and no lane names", () => {
    expect(findLaneBindingForConversation(execution(), "conv-elsewhere")).toBe(
      null,
    );
  });
});
