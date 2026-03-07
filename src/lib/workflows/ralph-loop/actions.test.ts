import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  broadcastIterationComplete,
  broadcastFixPlanUpdated,
  broadcastCircuitBreaker,
  type BroadcastIterationCompleteParams,
  type BroadcastFixPlanUpdatedParams,
  type BroadcastCircuitBreakerParams,
} from "./actions";
import {
  setActionDeps,
  _resetDepsForTesting,
  type WorkflowActionDeps,
} from "../actions";

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

describe("ralph-loop/actions", () => {
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
            changedFiles: ["a.ts"],
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
});
