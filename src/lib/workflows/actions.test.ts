import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  broadcastStatus,
  broadcastIterationComplete,
  broadcastFixPlanUpdated,
  broadcastCircuitBreaker,
  persistSnapshot,
  createNotificationAction,
  setActionDeps,
  _resetDepsForTesting,
  type WorkflowActionDeps,
  type BroadcastStatusParams,
  type BroadcastIterationCompleteParams,
  type BroadcastFixPlanUpdatedParams,
  type BroadcastCircuitBreakerParams,
  type PersistSnapshotParams,
  type CreateNotificationParams,
} from "./actions";

// Create mock deps via dependency injection (no jest.mock needed)
const mockBroadcast = vi.fn();
const mockPersistSnapshot = vi.fn();
const mockCreateNotification = vi.fn();

const mockDeps: WorkflowActionDeps = {
  broadcast: mockBroadcast,
  persistSnapshot: mockPersistSnapshot,
  createNotification: mockCreateNotification,
};

beforeEach(() => {
  vi.clearAllMocks();
  setActionDeps(mockDeps);
});

afterEach(() => {
  _resetDepsForTesting();
});

describe("broadcastStatus", () => {
  it("broadcasts a workflow-status event with all params", () => {
    const params: BroadcastStatusParams = {
      projectName: "my-project",
      sessionName: "session-1",
      workflowStatus: "running",
      iterationCount: 3,
      maxIterations: 20,
      taskProgress: { total: 10, completed: 3, skipped: 1, pending: 6 },
      haltReason: null,
    };

    broadcastStatus({}, params);

    expect(mockBroadcast).toHaveBeenCalledOnce();
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "workflow-status",
      ...params,
    });
  });

  it("includes haltReason when workflow is halted", () => {
    const params: BroadcastStatusParams = {
      projectName: "proj",
      sessionName: "sess",
      workflowStatus: "halted",
      iterationCount: 20,
      maxIterations: 20,
      taskProgress: { total: 5, completed: 2, skipped: 0, pending: 3 },
      haltReason: { type: "iteration_cap", maxIterations: 20 },
    };

    broadcastStatus({}, params);

    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "workflow-status",
        haltReason: { type: "iteration_cap", maxIterations: 20 },
      }),
    );
  });
});

describe("broadcastIterationComplete", () => {
  it("broadcasts a workflow-iteration-complete event", () => {
    const params: BroadcastIterationCompleteParams = {
      projectName: "proj",
      sessionName: "sess",
      iteration: {
        iterationNumber: 1,
        conversationId: "conv-123",
        status: "completed",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-01-01T00:05:00Z",
        durationMs: 300000,
        costUsd: 0.5,
        turns: 12,
        gitMetrics: {
          filesChanged: 3,
          linesAdded: 50,
          linesRemoved: 10,
          changedFiles: ["a.ts", "b.ts", "c.ts"],
        },
        statusReport: null,
        tasksCompleted: ["task-1"],
        tasksSkipped: [],
        tasksAdded: [],
        progressClassification: "progress",
        peakContextTokens: 50000,
      },
    };

    broadcastIterationComplete({}, params);

    expect(mockBroadcast).toHaveBeenCalledOnce();
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "workflow-iteration-complete",
      ...params,
    });
  });
});

describe("broadcastFixPlanUpdated", () => {
  it("broadcasts a workflow-fix-plan-updated event", () => {
    const params: BroadcastFixPlanUpdatedParams = {
      projectName: "proj",
      sessionName: "sess",
      fixPlan: [
        {
          id: "task-1",
          description: "Do thing",
          group: 1,
          status: "completed",
          createdAt: "2024-01-01",
          completedAt: "2024-01-01",
          skipReason: null,
          addedByIteration: null,
        },
      ],
      source: "tool",
    };

    broadcastFixPlanUpdated({}, params);

    expect(mockBroadcast).toHaveBeenCalledOnce();
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "workflow-fix-plan-updated",
      ...params,
    });
  });
});

describe("broadcastCircuitBreaker", () => {
  it("broadcasts a workflow-circuit-breaker event", () => {
    const params: BroadcastCircuitBreakerParams = {
      projectName: "proj",
      sessionName: "sess",
      circuitBreaker: {
        state: "half_open",
        consecutiveNoProgress: 3,
        consecutiveSameError: 0,
        lastErrorPattern: null,
        lastProgressIteration: 2,
      },
    };

    broadcastCircuitBreaker({}, params);

    expect(mockBroadcast).toHaveBeenCalledOnce();
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "workflow-circuit-breaker",
      ...params,
    });
  });
});

describe("persistSnapshot", () => {
  it("persists snapshot with project path and session name", () => {
    const params: PersistSnapshotParams = {
      projectPath: "/projects/my-app",
      sessionName: "sess-1",
      snapshot: { value: "running", context: {} },
    };

    persistSnapshot({}, params);

    expect(mockPersistSnapshot).toHaveBeenCalledOnce();
    expect(mockPersistSnapshot).toHaveBeenCalledWith(
      "/projects/my-app",
      "sess-1",
      { value: "running", context: {} },
      { immediate: undefined },
    );
  });

  it("passes immediate flag through", () => {
    const params: PersistSnapshotParams = {
      projectPath: "/proj",
      sessionName: "sess",
      snapshot: { value: "completed" },
      immediate: true,
    };

    persistSnapshot({}, params);

    expect(mockPersistSnapshot).toHaveBeenCalledWith(
      "/proj",
      "sess",
      { value: "completed" },
      { immediate: true },
    );
  });
});

describe("createNotificationAction", () => {
  it("creates a notification with all fields", () => {
    const params: CreateNotificationParams = {
      type: "merge-completed",
      title: "Merge complete",
      message: "Branch merged successfully",
      projectName: "proj",
      sessionName: "sess",
      branchName: "csm/sess",
      jobId: "job-123",
      jobType: "merge",
    };

    createNotificationAction({}, params);

    expect(mockCreateNotification).toHaveBeenCalledOnce();
    expect(mockCreateNotification).toHaveBeenCalledWith(params);
  });

  it("passes optional error message", () => {
    const params: CreateNotificationParams = {
      type: "merge-failed",
      title: "Merge failed",
      message: "Something went wrong",
      projectName: "proj",
      sessionName: "sess",
      branchName: "csm/sess",
      jobId: "job-456",
      jobType: "merge",
      errorMessage: "Conflict in index.ts",
    };

    createNotificationAction({}, params);

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "Conflict in index.ts",
      }),
    );
  });
});
