import { describe, expect, it } from "vitest";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflows/schemas";
import { createWorkflowExecution } from "./test-fixtures";
import {
  createExecutionTargetResolver,
  type ExecutionTarget,
} from "./execution-target-resolver";

function createSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionName: "session-1",
    worktreePath: "/repo/.worktrees/session-1",
    branchName: "csm/session-1",
    createdAt: "2026-03-27T12:00:00.000Z",
    lastActivityAt: "2026-03-27T12:00:00.000Z",
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
    ...overrides,
  };
}

function withContextWorktree(
  execution: GraphWorkflowExecution,
  contextId: string,
  worktreePath: string,
  branchName: string,
): GraphWorkflowExecution {
  const existing = execution.contextStates[contextId];
  if (!existing) {
    throw new Error(`fixture missing contextId=${contextId}`);
  }
  return {
    ...execution,
    contextStates: {
      ...execution.contextStates,
      [contextId]: {
        ...existing,
        worktreePath,
        branchName,
        isolation: "worktree",
      },
    },
  };
}

describe("ExecutionTargetResolver", () => {
  it("returns the per-context worktree target when both worktreePath and branchName are populated", () => {
    const baseExecution = createWorkflowExecution();
    const execution = withContextWorktree(
      baseExecution,
      "context-plan",
      "/repo/.worktrees/session-1.context-plan",
      "csm/session-1-context-plan",
    );
    const session = createSession();
    const resolver = createExecutionTargetResolver();

    const result = resolver.resolve({
      execution,
      contextId: "context-plan",
      session,
    });

    const expected: ExecutionTarget = {
      worktreePath: "/repo/.worktrees/session-1.context-plan",
      branchName: "csm/session-1-context-plan",
      isolation: "worktree",
      laneId: null,
    };
    expect(result).toEqual(expected);
  });

  it("falls back to the session target when the context has no per-context worktree", () => {
    const execution = createWorkflowExecution();
    const session = createSession({
      worktreePath: "/repo/.worktrees/session-1",
      branchName: "csm/session-1",
    });
    const resolver = createExecutionTargetResolver();

    const result = resolver.resolve({
      execution,
      contextId: "context-plan",
      session,
    });

    const expected: ExecutionTarget = {
      worktreePath: "/repo/.worktrees/session-1",
      branchName: "csm/session-1",
      isolation: "session",
      laneId: null,
    };
    expect(result).toEqual(expected);
  });

  it("falls back to the session target when only worktreePath is set without branchName", () => {
    const baseExecution = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...baseExecution,
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          worktreePath: "/repo/.worktrees/session-1.context-plan",
          branchName: null,
        },
      },
    };
    const session = createSession();
    const resolver = createExecutionTargetResolver();

    const result = resolver.resolve({
      execution,
      contextId: "context-plan",
      session,
    });

    expect(result).toEqual<ExecutionTarget>({
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      isolation: "session",
      laneId: null,
    });
  });

  it("falls back to the session target when only branchName is set without worktreePath", () => {
    const baseExecution = createWorkflowExecution();
    const execution: GraphWorkflowExecution = {
      ...baseExecution,
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          worktreePath: null,
          branchName: "csm/session-1-context-plan",
        },
      },
    };
    const session = createSession();
    const resolver = createExecutionTargetResolver();

    const result = resolver.resolve({
      execution,
      contextId: "context-plan",
      session,
    });

    expect(result).toEqual<ExecutionTarget>({
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      isolation: "session",
      laneId: null,
    });
  });

  it("throws when the contextId is not present in execution.contextStates", () => {
    const execution = createWorkflowExecution();
    const session = createSession();
    const resolver = createExecutionTargetResolver();

    expect(() =>
      resolver.resolve({
        execution,
        contextId: "context-missing",
        session,
      }),
    ).toThrow(/context-missing/);
  });

  it("resolves through the assigned worktree-kind lane when contextState.laneId is set", () => {
    const baseExecution = createWorkflowExecution();
    const existing = baseExecution.contextStates["context-plan"]!;
    const execution: GraphWorkflowExecution = {
      ...baseExecution,
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...existing,
          laneId: "lane-plan",
          isolation: "worktree",
        },
      },
      executionLanes: {
        "lane-plan": {
          laneId: "lane-plan",
          kind: "worktree",
          status: "active",
          worktreePath: "/repo/.worktrees/session-1.lane-plan",
          branchName: "csm/session-1-lane-plan",
          includedContextIds: ["context-plan"],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
        },
      },
    };
    const session = createSession();
    const resolver = createExecutionTargetResolver();

    const result = resolver.resolve({
      execution,
      contextId: "context-plan",
      session,
    });

    expect(result).toEqual<ExecutionTarget>({
      worktreePath: "/repo/.worktrees/session-1.lane-plan",
      branchName: "csm/session-1-lane-plan",
      isolation: "worktree",
      laneId: "lane-plan",
    });
  });

  it("resolves to the session target when the assigned lane is kind=session", () => {
    const baseExecution = createWorkflowExecution();
    const existing = baseExecution.contextStates["context-plan"]!;
    const execution: GraphWorkflowExecution = {
      ...baseExecution,
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...existing,
          laneId: "lane-session",
          isolation: "session",
        },
      },
      executionLanes: {
        "lane-session": {
          laneId: "lane-session",
          kind: "session",
          status: "active",
          worktreePath: null,
          branchName: "csm/session-1",
          includedContextIds: ["context-plan"],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
        },
      },
    };
    const session = createSession();
    const resolver = createExecutionTargetResolver();

    const result = resolver.resolve({
      execution,
      contextId: "context-plan",
      session,
    });

    expect(result).toEqual<ExecutionTarget>({
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      isolation: "session",
      laneId: "lane-session",
    });
  });

  it("throws when contextState.laneId is set but the lane is missing from executionLanes", () => {
    const baseExecution = createWorkflowExecution();
    const existing = baseExecution.contextStates["context-plan"]!;
    const execution: GraphWorkflowExecution = {
      ...baseExecution,
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": { ...existing, laneId: "lane-missing" },
      },
      executionLanes: {},
    };
    const session = createSession();
    const resolver = createExecutionTargetResolver();

    expect(() =>
      resolver.resolve({
        execution,
        contextId: "context-plan",
        session,
      }),
    ).toThrow(/lane-missing/);
  });

  it("returns laneId: null when no lane is assigned (legacy per-context worktree)", () => {
    const baseExecution = createWorkflowExecution();
    const execution = withContextWorktree(
      baseExecution,
      "context-plan",
      "/repo/.worktrees/session-1.context-plan",
      "csm/session-1-context-plan",
    );
    const session = createSession();
    const resolver = createExecutionTargetResolver();

    const result = resolver.resolve({
      execution,
      contextId: "context-plan",
      session,
    });

    expect(result.laneId).toBeNull();
    expect(result.isolation).toBe("worktree");
  });
});
