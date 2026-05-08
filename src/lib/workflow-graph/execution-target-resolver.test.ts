import { describe, expect, it } from "vitest";
import type { GraphWorkflowExecution, SessionState } from "@/types";
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
    objective: null,
    creationMode: "fast",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    graphWorkflowExecutionHistory: [],
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
});
