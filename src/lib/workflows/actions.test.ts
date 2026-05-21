import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  broadcastWorkflowEvent,
  persistSnapshot,
  createNotificationAction,
  setActionDeps,
  _resetDepsForTesting,
  type WorkflowActionDeps,
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

describe("broadcastWorkflowEvent", () => {
  it("broadcasts the given SSE event", () => {
    const event = {
      type: "graph-workflow-status" as const,
      projectName: "proj",
      sessionName: "sess",
      executionId: "exec-1",
      workflowStatus: "running" as const,
      activeContextIds: [],
      activeBatchIds: [],
      activeJoinIds: [],
      haltReason: null,
      pendingHaltReason: null,
      secondaryHaltReasons: [],
    };

    broadcastWorkflowEvent({}, { event });

    expect(mockBroadcast).toHaveBeenCalledOnce();
    expect(mockBroadcast).toHaveBeenCalledWith(event);
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
