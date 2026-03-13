import { describe, it, expect, beforeEach } from "vitest";
import { enableMapSet } from "immer";
import type {
  WorkflowStatusEvent,
  WorkflowIterationCompleteEvent,
  WorkflowFixPlanUpdatedEvent,
  WorkflowCircuitBreakerEvent,
} from "@/types";
import { _useWorkflowStore } from "./workflow.store";

enableMapSet();

function resetStore() {
  _useWorkflowStore.setState({
    workflows: new Map(),
    toastQueue: [],
  });
}

// ============================================================
// Helpers
// ============================================================

function makeStatusEvent(
  overrides: Partial<WorkflowStatusEvent> = {},
): WorkflowStatusEvent {
  return {
    type: "workflow-status",
    projectName: "my-project",
    sessionName: "my-session",
    workflowStatus: "running",
    iterationCount: 1,
    maxIterations: 10,
    taskProgress: { total: 5, completed: 0, skipped: 0, pending: 5 },
    haltReason: null,
    ...overrides,
  };
}

function makeIterationEvent(
  overrides: Partial<WorkflowIterationCompleteEvent> = {},
): WorkflowIterationCompleteEvent {
  return {
    type: "workflow-iteration-complete",
    projectName: "my-project",
    sessionName: "my-session",
    iteration: {
      iterationNumber: 1,
      conversationId: "conv-1",
      status: "completed",
      startedAt: "2024-01-01T00:00:00Z",
      completedAt: "2024-01-01T00:01:00Z",
      durationMs: 60000,
      costUsd: 0.1,
      turns: 5,
      gitMetrics: {
        filesChanged: 1,
        linesAdded: 10,
        linesRemoved: 2,
        changedFiles: ["src/app.ts"],
      },
      statusReport: null,
      tasksCompleted: [],
      tasksSkipped: [],
      tasksAdded: [],
      progressClassification: "progress",
      peakContextTokens: 50000,
    },
    ...overrides,
  };
}

function makeFixPlanEvent(
  overrides: Partial<WorkflowFixPlanUpdatedEvent> = {},
): WorkflowFixPlanUpdatedEvent {
  return {
    type: "workflow-fix-plan-updated",
    projectName: "my-project",
    sessionName: "my-session",
    fixPlan: [
      {
        id: "task-1",
        description: "Fix bug",
        group: 1,
        status: "pending",
        createdAt: "2024-01-01T00:00:00Z",
        completedAt: null,
        skipReason: null,
        addedByIteration: null,
      },
    ],
    source: "tool",
    ...overrides,
  };
}

function makeCircuitBreakerEvent(
  overrides: Partial<WorkflowCircuitBreakerEvent> = {},
): WorkflowCircuitBreakerEvent {
  return {
    type: "workflow-circuit-breaker",
    projectName: "my-project",
    sessionName: "my-session",
    circuitBreaker: {
      state: "closed",
      consecutiveNoProgress: 0,
      consecutiveSameError: 0,
      lastErrorPattern: null,
      lastProgressIteration: 0,
    },
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe("workflow.store — handleStatusEvent", () => {
  beforeEach(resetStore);

  it("adds a running workflow to the store", () => {
    const event = makeStatusEvent();
    _useWorkflowStore.getState().handleStatusEvent(event);

    const workflows = _useWorkflowStore.getState().workflows;
    expect(workflows.size).toBe(1);

    const key = "my-project::my-session";
    const tracked = workflows.get(key);
    expect(tracked).toBeDefined();
    expect(tracked?.status).toBe("running");
    expect(tracked?.projectName).toBe("my-project");
    expect(tracked?.sessionName).toBe("my-session");
    expect(tracked?.iterationCount).toBe(1);
    expect(tracked?.maxIterations).toBe(10);
    expect(tracked?.taskProgress.total).toBe(5);
    expect(tracked?.haltReason).toBeNull();
  });

  it("updates an existing workflow", () => {
    _useWorkflowStore.getState().handleStatusEvent(makeStatusEvent());
    _useWorkflowStore.getState().handleStatusEvent(
      makeStatusEvent({
        iterationCount: 3,
        taskProgress: { total: 5, completed: 2, skipped: 0, pending: 3 },
      }),
    );

    const tracked = _useWorkflowStore
      .getState()
      .workflows.get("my-project::my-session");
    expect(tracked?.iterationCount).toBe(3);
    expect(tracked?.taskProgress.completed).toBe(2);
  });

  it("pushes terminal statuses to the toast queue", () => {
    _useWorkflowStore
      .getState()
      .handleStatusEvent(makeStatusEvent({ workflowStatus: "completed" }));

    const toastQueue = _useWorkflowStore.getState().toastQueue;
    expect(toastQueue).toHaveLength(1);
    expect(toastQueue[0]!.status).toBe("completed");
    expect(toastQueue[0]!.projectName).toBe("my-project");
  });

  it("does not push running status to toast queue", () => {
    _useWorkflowStore
      .getState()
      .handleStatusEvent(makeStatusEvent({ workflowStatus: "running" }));

    expect(_useWorkflowStore.getState().toastQueue).toHaveLength(0);
  });

  it("pushes halted and stopped to toast queue", () => {
    _useWorkflowStore.getState().handleStatusEvent(
      makeStatusEvent({
        workflowStatus: "halted",
        haltReason: {
          type: "circuit_breaker",
          reason: "no_progress",
        },
      }),
    );
    _useWorkflowStore.getState().handleStatusEvent(
      makeStatusEvent({
        sessionName: "other",
        workflowStatus: "stopped",
      }),
    );

    expect(_useWorkflowStore.getState().toastQueue).toHaveLength(2);
  });

  it("preserves fixPlan and circuitBreaker from existing workflow", () => {
    _useWorkflowStore.getState().handleStatusEvent(makeStatusEvent());
    _useWorkflowStore.getState().handleFixPlanUpdated(makeFixPlanEvent());
    _useWorkflowStore
      .getState()
      .handleCircuitBreaker(makeCircuitBreakerEvent());

    // Now update status — should preserve fixPlan and circuitBreaker
    _useWorkflowStore
      .getState()
      .handleStatusEvent(makeStatusEvent({ iterationCount: 2 }));

    const tracked = _useWorkflowStore
      .getState()
      .workflows.get("my-project::my-session");
    expect(tracked?.fixPlan).not.toBeNull();
    expect(tracked?.circuitBreaker).not.toBeNull();
  });
});

describe("workflow.store — handleIterationComplete", () => {
  beforeEach(resetStore);

  it("updates latestIteration and iterationCount on existing workflow", () => {
    _useWorkflowStore.getState().handleStatusEvent(makeStatusEvent());
    _useWorkflowStore.getState().handleIterationComplete(
      makeIterationEvent({
        iteration: {
          ...makeIterationEvent().iteration,
          iterationNumber: 3,
        },
      }),
    );

    const tracked = _useWorkflowStore
      .getState()
      .workflows.get("my-project::my-session");
    expect(tracked?.latestIteration?.iterationNumber).toBe(3);
    expect(tracked?.iterationCount).toBe(3);
  });

  it("does nothing if workflow does not exist", () => {
    _useWorkflowStore.getState().handleIterationComplete(makeIterationEvent());
    expect(_useWorkflowStore.getState().workflows.size).toBe(0);
  });
});

describe("workflow.store — handleFixPlanUpdated", () => {
  beforeEach(resetStore);

  it("updates fixPlan on existing workflow", () => {
    _useWorkflowStore.getState().handleStatusEvent(makeStatusEvent());
    _useWorkflowStore.getState().handleFixPlanUpdated(makeFixPlanEvent());

    const tracked = _useWorkflowStore
      .getState()
      .workflows.get("my-project::my-session");
    expect(tracked?.fixPlan).toHaveLength(1);
    expect(tracked?.fixPlan?.[0]?.description).toBe("Fix bug");
  });

  it("does nothing if workflow does not exist", () => {
    _useWorkflowStore.getState().handleFixPlanUpdated(makeFixPlanEvent());
    expect(_useWorkflowStore.getState().workflows.size).toBe(0);
  });
});

describe("workflow.store — handleCircuitBreaker", () => {
  beforeEach(resetStore);

  it("updates circuitBreaker on existing workflow", () => {
    _useWorkflowStore.getState().handleStatusEvent(makeStatusEvent());
    _useWorkflowStore
      .getState()
      .handleCircuitBreaker(makeCircuitBreakerEvent());

    const tracked = _useWorkflowStore
      .getState()
      .workflows.get("my-project::my-session");
    expect(tracked?.circuitBreaker?.consecutiveNoProgress).toBe(0);
  });

  it("does nothing if workflow does not exist", () => {
    _useWorkflowStore
      .getState()
      .handleCircuitBreaker(makeCircuitBreakerEvent());
    expect(_useWorkflowStore.getState().workflows.size).toBe(0);
  });
});

describe("workflow.store — dismissToast", () => {
  beforeEach(resetStore);

  it("removes the first toast from the queue", () => {
    _useWorkflowStore
      .getState()
      .handleStatusEvent(makeStatusEvent({ workflowStatus: "completed" }));
    _useWorkflowStore.getState().handleStatusEvent(
      makeStatusEvent({
        sessionName: "other",
        workflowStatus: "halted",
        haltReason: { type: "circuit_breaker", reason: "no_progress" },
      }),
    );

    expect(_useWorkflowStore.getState().toastQueue).toHaveLength(2);

    _useWorkflowStore.getState().dismissToast();
    expect(_useWorkflowStore.getState().toastQueue).toHaveLength(1);
    expect(_useWorkflowStore.getState().toastQueue[0]!.sessionName).toBe(
      "other",
    );
  });

  it("does nothing when toast queue is empty", () => {
    _useWorkflowStore.getState().dismissToast();
    expect(_useWorkflowStore.getState().toastQueue).toHaveLength(0);
  });
});

describe("workflow.store — multiple workflows", () => {
  beforeEach(resetStore);

  it("tracks multiple workflows independently", () => {
    _useWorkflowStore.getState().handleStatusEvent(makeStatusEvent());
    _useWorkflowStore.getState().handleStatusEvent(
      makeStatusEvent({
        projectName: "other-project",
        sessionName: "other-session",
      }),
    );

    expect(_useWorkflowStore.getState().workflows.size).toBe(2);
  });
});
