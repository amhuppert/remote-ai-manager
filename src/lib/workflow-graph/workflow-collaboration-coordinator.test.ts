import { describe, expect, it, vi } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type {
  ResolvedCollaborationConfig,
  WorkflowCollaborationResult,
} from "@/lib/workflow-graph/collaboration-schemas";
import { createWorkflowExecution } from "./test-fixtures";
import { createGraphWorkflowCollaborationCoordinator } from "./workflow-collaboration-coordinator";

function resolvedConfigFixture(): ResolvedCollaborationConfig {
  return {
    secondAgent: {
      value: { backend: "codex", model: "gpt-5.4", reasoningEffort: "medium" },
      source: "global",
    },
    negotiationRounds: { value: 4, source: "global" },
    autonomousResolutionThreshold: { value: "minor", source: "global" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createGraphWorkflowCollaborationCoordinator", () => {
  it("records pending state, returns immediately, and queues converged results for continuation", async () => {
    let current = createWorkflowExecution({
      id: "exec-1",
      activeContextIds: ["context-implement"],
      contextStates: {
        ...createWorkflowExecution().contextStates,
        "context-implement": {
          ...createWorkflowExecution().contextStates["context-implement"]!,
          status: "running",
        },
      },
    });
    const runDeferred = deferred<{
      result: WorkflowCollaborationResult;
      roundsConsumed: number;
    }>();
    const mutateActive = vi.fn(
      async (
        _projectPath: string,
        _sessionName: string,
        fn: (execution: GraphWorkflowExecution) => GraphWorkflowExecution,
      ) => {
        current = await fn(current);
        return current;
      },
    );
    const recordPendingHaltReason = vi.fn();
    const coordinator = createGraphWorkflowCollaborationCoordinator({
      workflowManager: {
        mutateActive,
        recordPendingHaltReason,
      },
      now: () => "2026-03-27T12:10:00.000Z",
      createWorkflowId: () => "collab-1",
    });

    const triggerResult = await coordinator.trigger({
      projectPath: "/repo",
      sessionName: "session-1",
      executionId: "exec-1",
      contextId: "context-implement",
      conversationId: "conv-1",
      parentImplementerTurnId: "turn-1",
      iterationIndex: 0,
      brief: "Choose the queue.",
      resolvedConfig: resolvedConfigFixture(),
      runCollaboration: async () => runDeferred.promise,
    });

    expect(triggerResult).toEqual({ workflowId: "collab-1" });
    expect(current.pendingCollaborations["context-implement"]).toMatchObject({
      workflowId: "collab-1",
      brief: "Choose the queue.",
      conversationId: "conv-1",
    });
    expect(
      current.collaborationContinuations["context-implement"],
    ).toBeUndefined();

    runDeferred.resolve({
      result: {
        status: "converged",
        finalAnswer: "Use the existing queue.",
        openConflicts: [],
      },
      roundsConsumed: 1,
    });
    await flushMicrotasks();

    expect(current.pendingCollaborations["context-implement"]).toBeUndefined();
    expect(current.contextStates["context-implement"]?.status).toBe("ready");
    expect(current.collaborationContinuations["context-implement"]).toEqual([
      {
        workflowId: "collab-1",
        brief: "Choose the queue.",
        result: {
          status: "converged",
          finalAnswer: "Use the existing queue.",
          openConflicts: [],
        },
        roundsConsumed: 1,
        completedAt: "2026-03-27T12:10:00.000Z",
        deliveredAt: null,
      },
    ]);
    expect(recordPendingHaltReason).not.toHaveBeenCalled();
  });

  it("records a collaboration_failure halt and clears pending state when collaborators do not converge", async () => {
    let current = createWorkflowExecution({
      id: "exec-1",
      activeContextIds: ["context-implement"],
      contextStates: {
        ...createWorkflowExecution().contextStates,
        "context-implement": {
          ...createWorkflowExecution().contextStates["context-implement"]!,
          status: "running",
        },
      },
    });
    const runDeferred = deferred<{
      result: WorkflowCollaborationResult;
      roundsConsumed: number;
    }>();
    const coordinator = createGraphWorkflowCollaborationCoordinator({
      workflowManager: {
        mutateActive: async (_projectPath, _sessionName, fn) => {
          current = await fn(current);
          return current;
        },
        recordPendingHaltReason: async (input) => {
          const next = structuredClone(current);
          input.applyAdditionalMutation?.(next);
          next.pendingHaltReason = input.reason;
          current = next;
          return { execution: current, accepted: true };
        },
      },
      createWorkflowId: () => "collab-2",
    });

    await coordinator.trigger({
      projectPath: "/repo",
      sessionName: "session-1",
      executionId: "exec-1",
      contextId: "context-implement",
      conversationId: "conv-1",
      parentImplementerTurnId: "turn-1",
      iterationIndex: 0,
      brief: "Choose the store.",
      resolvedConfig: resolvedConfigFixture(),
      runCollaboration: async () => runDeferred.promise,
    });

    runDeferred.resolve({
      result: {
        status: "objective_disagreement",
        finalAnswer: null,
        openConflicts: [
          {
            rejectingAgent: "agent_two",
            disputedPoint: "Use Postgres for metrics.",
            severity: "major",
            category: "objective",
          },
        ],
      },
      roundsConsumed: 2,
    });
    await flushMicrotasks();

    expect(current.pendingCollaborations["context-implement"]).toBeUndefined();
    const haltReason = current.pendingHaltReason as GraphWorkflowHaltReason;
    expect(haltReason).toMatchObject({
      type: "collaboration_failure",
      status: "objective_disagreement",
      brief: "Choose the store.",
      executionContextId: "context-implement",
      conversationId: "conv-1",
    });
  });
});
