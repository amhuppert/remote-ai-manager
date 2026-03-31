import { describe, expect, it, vi } from "vitest";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";

describe("graph workflow execution event publisher", () => {
  it("publishes diff-based execution events and appends them to execution history", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now() {
        return "2026-03-28T10:00:00.000Z";
      },
    });

    const previousExecution = createWorkflowExecution({
      status: "running",
      activeContextId: "context-plan",
      contextStates: {
        "context-plan": {
          contextId: "context-plan",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          lastValidationAt: null,
          lastValidationPass: null,
        },
        "context-implement": {
          contextId: "context-implement",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          lastValidationAt: null,
          lastValidationPass: null,
        },
        "context-verify": {
          contextId: "context-verify",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          lastValidationAt: null,
          lastValidationPass: null,
        },
      },
      taskStates: {
        "task-plan-1": {
          taskId: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          status: "running",
          summary: null,
          startedAt: "2026-03-28T09:58:00.000Z",
          completedAt: null,
          lastConversationId: "conversation-1",
          reopenedCount: 0,
          lastReopenedAt: null,
          failureMessage: null,
        },
        "task-implement-1": {
          taskId: "task-implement-1",
          contextId: "context-implement",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          reopenedCount: 0,
          lastReopenedAt: null,
          failureMessage: null,
        },
        "task-verify-1": {
          taskId: "task-verify-1",
          contextId: "context-verify",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          reopenedCount: 0,
          lastReopenedAt: null,
          failureMessage: null,
        },
      },
      retryState: {
        "context-plan": {
          contextId: "context-plan",
          attempt: 0,
          maxAttempts: 2,
        },
      },
    });

    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      status: "halted",
      activeContextId: "context-plan",
      haltReason: {
        type: "circuit_breaker",
        contextId: "context-plan",
        condition: "retry_exhaustion",
        failureCount: 3,
        summary: null,
      },
      contextStates: {
        ...previousExecution.contextStates,
        "context-plan": {
          ...previousExecution.contextStates["context-plan"]!,
          status: "halted",
          iterationCount: 1,
          consecutiveFailureCount: 3,
        },
      },
      taskStates: {
        ...previousExecution.taskStates,
        "task-plan-1": {
          ...previousExecution.taskStates["task-plan-1"]!,
          status: "failed",
          failureMessage: "Validation failed",
        },
      },
      retryState: {
        "context-plan": {
          contextId: "context-plan",
          attempt: 1,
          maxAttempts: 2,
        },
      },
      sharedDocuments: [
        {
          id: "doc-1",
          relativePath: ".cc/graph-workflow-docs/plan.md",
          description: "Updated implementation plan",
          readWhen: "Read before resuming the plan context.",
          createdAt: "2026-03-28T09:59:00.000Z",
          updatedAt: "2026-03-28T10:00:00.000Z",
          lastUpdatedByConversationId: "conversation-1",
        },
      ],
    });

    const publishedExecution = publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution,
      nextExecution,
    });

    expect(broadcast.mock.calls.map(([event]) => event.type)).toEqual([
      "graph-workflow-status",
      "graph-workflow-context-status",
      "graph-workflow-task-status",
      "graph-workflow-retry",
      "graph-workflow-circuit-breaker",
      "graph-workflow-shared-documents-updated",
    ]);
    expect(publishedExecution.history.map((entry) => entry.event.type)).toEqual(
      [
        "graph-workflow-status",
        "graph-workflow-context-status",
        "graph-workflow-task-status",
        "graph-workflow-retry",
        "graph-workflow-circuit-breaker",
        "graph-workflow-shared-documents-updated",
      ],
    );
    expect(publishedExecution.history[0]?.occurredAt).toBe(
      "2026-03-28T10:00:00.000Z",
    );
  });

  it("publishes validation result events and records them in execution history", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now() {
        return "2026-03-28T10:05:00.000Z";
      },
    });

    const execution = createWorkflowExecution({
      status: "running",
      activeContextId: "context-plan",
    });

    const updatedExecution = publisher.publishValidationResult({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
      validatorType: "context",
      pass: false,
      summary: "Validation failed because the fix task was incomplete.",
      reopenTaskIds: ["task-plan-1"],
      issues: [
        {
          title: "Fix task incomplete",
          description: "The remediation task did not update the plan document.",
        },
      ],
    });

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "graph-workflow-validation-result",
        projectName: "repo",
        sessionName: "session-1",
        contextId: "context-plan",
        pass: false,
      }),
    );
    expect(updatedExecution.history).toHaveLength(1);
    expect(updatedExecution.history[0]?.event).toEqual(
      expect.objectContaining({
        type: "graph-workflow-validation-result",
        validatorType: "context",
        reopenTaskIds: ["task-plan-1"],
      }),
    );
  });
});
