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
        },
        "context-implement": {
          contextId: "context-implement",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
        },
        "context-verify": {
          contextId: "context-verify",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
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
          failureMessage: null,
          failureHistory: [],
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
          failureMessage: null,
          failureHistory: [],
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
          failureMessage: null,
          failureHistory: [],
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
      "graph-workflow-circuit-breaker",
      "graph-workflow-shared-documents-updated",
    ]);
    expect(publishedExecution.history.map((entry) => entry.event.type)).toEqual(
      [
        "graph-workflow-status",
        "graph-workflow-context-status",
        "graph-workflow-task-status",
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
      issues: [
        {
          taskId: "task-plan-1",
          title: "Fix task incomplete",
          description: "The remediation task did not update the plan document.",
        },
      ],
      reopenTaskIds: ["task-plan-1"],
    });

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "graph-workflow-validation-result",
        projectName: "repo",
        sessionName: "session-1",
        contextId: "context-plan",
        pass: false,
        reopenTaskIds: ["task-plan-1"],
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

  it("publishes task status events when task conversation metadata changes", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now() {
        return "2026-03-28T10:06:00.000Z";
      },
    });

    const previousExecution = createWorkflowExecution({
      status: "running",
      activeContextId: "context-plan",
      taskStates: {
        "task-plan-1": {
          taskId: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
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
          failureMessage: null,
          failureHistory: [],
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
          failureMessage: null,
          failureHistory: [],
        },
      },
    });
    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      taskStates: {
        ...previousExecution.taskStates,
        "task-plan-1": {
          ...previousExecution.taskStates["task-plan-1"]!,
          startedAt: "2026-03-28T10:05:00.000Z",
          lastConversationId: "conversation-live",
          failureMessage: "Need follow-up",
        },
      },
    });

    publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution,
      nextExecution,
    });

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "graph-workflow-task-status",
        taskId: "task-plan-1",
        lastConversationId: "conversation-live",
        startedAt: "2026-03-28T10:05:00.000Z",
        failureMessage: "Need follow-up",
      }),
    );
  });

  it("dispatches push notification when workflow completes", () => {
    const broadcast = vi.fn();
    const dispatchPush = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => "2026-03-28T10:00:00.000Z",
    });

    const prev = createWorkflowExecution({ status: "running" });
    const next = createWorkflowExecution({ ...prev, status: "completed" });

    publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "sess-1",
      previousExecution: prev,
      nextExecution: next,
    });

    expect(dispatchPush).toHaveBeenCalledWith({
      kind: "workflow-completed",
      projectName: "repo",
      sessionName: "sess-1",
    });
  });

  it("dispatches push notification when workflow is halted", () => {
    const broadcast = vi.fn();
    const dispatchPush = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => "2026-03-28T10:00:00.000Z",
    });

    const prev = createWorkflowExecution({ status: "running" });
    const next = createWorkflowExecution({ ...prev, status: "halted" });

    publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "sess-1",
      previousExecution: prev,
      nextExecution: next,
    });

    expect(dispatchPush).toHaveBeenCalledWith({
      kind: "workflow-halted",
      projectName: "repo",
      sessionName: "sess-1",
    });
  });

  it("dispatches push notification when circuit breaker trips", () => {
    const broadcast = vi.fn();
    const dispatchPush = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => "2026-03-28T10:00:00.000Z",
    });

    const prev = createWorkflowExecution({ status: "running" });
    const next = createWorkflowExecution({
      ...prev,
      status: "halted",
      haltReason: {
        type: "circuit_breaker",
        contextId: "context-plan",
        condition: "retry_exhaustion",
        failureCount: 3,
        summary: null,
      },
    });

    publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "sess-1",
      previousExecution: prev,
      nextExecution: next,
    });

    const pushKinds = dispatchPush.mock.calls.map(
      (args: unknown[]) => (args[0] as { kind: string }).kind,
    );
    expect(pushKinds).toContain("circuit-breaker");
    // Circuit-breaker push is more specific — generic workflow-halted should be suppressed
    expect(pushKinds).not.toContain("workflow-halted");
  });

  it("dispatches push notification when execution context completes", () => {
    const broadcast = vi.fn();
    const dispatchPush = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => "2026-03-28T10:00:00.000Z",
    });

    const prev = createWorkflowExecution({
      status: "running",
      activeContextId: "context-plan",
      contextStates: {
        "context-plan": {
          contextId: "context-plan",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 0,
        },
        "context-implement": {
          contextId: "context-implement",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
        },
        "context-verify": {
          contextId: "context-verify",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
        },
      },
    });
    const next = createWorkflowExecution({
      ...prev,
      contextStates: {
        ...prev.contextStates,
        "context-plan": {
          ...prev.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
        },
      },
    });

    publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "sess-1",
      previousExecution: prev,
      nextExecution: next,
    });

    expect(dispatchPush).toHaveBeenCalledWith({
      kind: "context-completed",
      projectName: "repo",
      sessionName: "sess-1",
      contextTitle: "Plan",
      completedContexts: 1,
      totalContexts: 3,
    });
  });

  it("does not dispatch push when dispatchPush dep is not provided", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-03-28T10:00:00.000Z",
    });

    const prev = createWorkflowExecution({ status: "running" });
    const next = createWorkflowExecution({ ...prev, status: "completed" });

    // Should not throw even without dispatchPush
    expect(() => {
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "sess-1",
        previousExecution: prev,
        nextExecution: next,
      });
    }).not.toThrow();
  });
});
