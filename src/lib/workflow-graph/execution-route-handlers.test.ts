import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@/types";
import { createWorkflowExecution } from "./test-fixtures";
import {
  createGraphWorkflowExecutionRouteHandlers,
  createGraphWorkflowRouteScriptValidatorService,
} from "./execution-route-handlers";

function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
  });
}

function makeContext(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
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

describe("graph workflow execution route handlers", () => {
  const resolveProjectPath = vi.fn<(_name: string) => Promise<string | null>>();
  const getSession =
    vi.fn<
      (
        _projectPath: string,
        _sessionName: string,
      ) => Promise<SessionState | null>
    >();
  const startExecution = vi.fn();
  const pauseExecution = vi.fn();
  const resumeExecution = vi.fn();
  const abortExecution = vi.fn();
  const archiveExecution = vi.fn();
  const normalizeExecutionAfterRestart = vi.fn();
  const kickOffExecutionLoop = vi.fn();
  const resetExecutionContext = vi.fn();

  const handlers = createGraphWorkflowExecutionRouteHandlers({
    resolveProjectPath,
    getSession,
    startExecution,
    pauseExecution,
    resumeExecution,
    abortExecution,
    archiveExecution,
    normalizeExecutionAfterRestart,
    kickOffExecutionLoop,
    resetExecutionContext,
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("starts an execution and archives a previous terminal run first", async () => {
    const archivedExecution = createWorkflowExecution({
      id: "execution-archived",
      status: "completed",
      completedAt: "2026-03-27T13:00:00.000Z",
    });
    const startedExecution = createWorkflowExecution({
      id: "execution-active",
      status: "running",
    });

    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: archivedExecution,
      }),
    );
    startExecution.mockResolvedValue(startedExecution);

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(202);
    expect(archiveExecution).toHaveBeenCalledWith("/repo", "session-1");
    expect(startExecution).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      definitionId: "workflow-1",
    });
    expect(kickOffExecutionLoop).toHaveBeenCalledWith({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      execution: startedExecution,
    });
    await expect(response.json()).resolves.toMatchObject({
      execution: {
        executionId: "execution-active",
        status: "running",
        archived: false,
      },
    });
  });

  it("returns active status with interrupted task details and archived history summaries", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          status: "paused",
          activeContextIds: ["context-plan"],
          taskStates: {
            "task-plan-1": {
              taskId: "task-plan-1",
              contextId: "context-plan",
              order: 1,
              status: "interrupted",
              summary: null,
              startedAt: "2026-03-27T12:05:00.000Z",
              completedAt: null,
              lastConversationId: "conversation-1",
              failureMessage: null,
              failureHistory: [],
            },
          },
        }),
        graphWorkflowExecutionHistory: [
          createWorkflowExecution({
            id: "execution-history-1",
            status: "aborted",
            completedAt: "2026-03-27T11:00:00.000Z",
            haltReason: { type: "aborted" },
          }),
        ],
      }),
    );

    const response = await handlers.STATUS(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      execution: {
        executionId: "execution-1",
        definitionId: "workflow-1",
        definitionRevision: 1,
        status: "paused",
        startedAt: "2026-03-27T12:00:00.000Z",
        completedAt: null,
        activeContextIds: ["context-plan"],
        activeContextTitles: ["Plan"],
        activeBatchIds: [],
        haltReason: null,
        pendingHaltReason: null,
        contextMergeProgress: [],
        archived: false,
      },
      archivedExecutions: [
        {
          executionId: "execution-history-1",
          definitionId: "workflow-1",
          definitionRevision: 1,
          status: "aborted",
          startedAt: "2026-03-27T12:00:00.000Z",
          completedAt: "2026-03-27T11:00:00.000Z",
          activeContextIds: [],
          activeContextTitles: [],
          activeBatchIds: [],
          haltReason: { type: "aborted" },
          pendingHaltReason: null,
          contextMergeProgress: [],
          archived: true,
        },
      ],
    });
  });

  it("orders contextMergeProgress by activeContextIds, not workflow definition order", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    const baseExecution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-verify", "context-plan"],
    });
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: {
          ...baseExecution,
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "running",
              isolation: "worktree",
              branchName: "csm/session-1-context-plan",
              batchId: "batch-9",
              mergeStatus: "in-progress",
              cleanupStatus: "pending",
              lastMergeError: null,
            },
            "context-verify": {
              ...baseExecution.contextStates["context-verify"]!,
              status: "running",
              isolation: "worktree",
              branchName: "csm/session-1-context-verify",
              batchId: "batch-9",
              mergeStatus: "pending",
              cleanupStatus: "pending",
              lastMergeError: null,
            },
          },
        },
      }),
    );
    normalizeExecutionAfterRestart.mockResolvedValue(null);

    const response = await handlers.STATUS(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      execution: {
        contextMergeProgress: Array<{ contextId: string }>;
      };
    };
    expect(json.execution.contextMergeProgress.map((m) => m.contextId)).toEqual(
      ["context-verify", "context-plan"],
    );
  });

  it("summarizes two simultaneously active contexts with mixed merge progress", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    const baseExecution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan", "context-implement"],
    });
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: {
          ...baseExecution,
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "running",
              isolation: "worktree",
              worktreePath: "/repo/.worktrees/session-1.context-plan",
              branchName: "csm/session-1-context-plan",
              batchId: "batch-1",
              mergeStatus: "in-progress",
              cleanupStatus: "pending",
              lastMergeError: null,
            },
            "context-implement": {
              ...baseExecution.contextStates["context-implement"]!,
              status: "running",
              isolation: "worktree",
              worktreePath: "/repo/.worktrees/session-1.context-implement",
              branchName: "csm/session-1-context-implement",
              batchId: "batch-1",
              mergeStatus: "merged-success",
              cleanupStatus: "removed",
              lastMergeError: null,
            },
          },
        },
      }),
    );
    normalizeExecutionAfterRestart.mockResolvedValue(null);

    const response = await handlers.STATUS(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      execution: {
        activeContextIds: string[];
        activeContextTitles: string[];
        activeBatchIds: string[];
        contextMergeProgress: Array<{
          contextId: string;
          mergeStatus: string;
          cleanupStatus: string;
          branchName: string | null;
        }>;
      };
    };
    expect(json.execution.activeContextIds).toEqual([
      "context-plan",
      "context-implement",
    ]);
    expect(json.execution.activeContextTitles).toEqual(["Plan", "Implement"]);
    expect(json.execution.activeBatchIds).toEqual(["batch-1"]);
    expect(json.execution.contextMergeProgress).toEqual([
      {
        contextId: "context-plan",
        branchName: "csm/session-1-context-plan",
        mergeStatus: "in-progress",
        cleanupStatus: "pending",
        lastMergeError: null,
      },
      {
        contextId: "context-implement",
        branchName: "csm/session-1-context-implement",
        mergeStatus: "merged-success",
        cleanupStatus: "removed",
        lastMergeError: null,
      },
    ]);
  });

  it("normalizes an in-flight iteration before returning status", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          status: "running",
          activeContextIds: ["context-plan"],
          taskStates: {
            "task-plan-1": {
              taskId: "task-plan-1",
              contextId: "context-plan",
              order: 1,
              status: "running",
              summary: null,
              startedAt: "2026-03-27T12:05:00.000Z",
              completedAt: null,
              lastConversationId: "conversation-1",
              failureMessage: null,
              failureHistory: [],
            },
          },
          machineSnapshot: {
            schemaVersion: 1,
            lifecycleStatus: "running",
            activeContextId: "context-plan",
            recoveryMode: "none",
            hasLiveIteration: true,
          },
        }),
      }),
    );
    normalizeExecutionAfterRestart.mockResolvedValue(
      createWorkflowExecution({
        status: "paused",
        activeContextIds: ["context-plan"],
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "interrupted",
            summary: null,
            startedAt: "2026-03-27T12:05:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "paused",
          activeContextId: "context-plan",
          recoveryMode: "restart_normalized",
          hasLiveIteration: false,
        },
      }),
    );

    const response = await handlers.STATUS(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(normalizeExecutionAfterRestart).toHaveBeenCalledWith(
      "/repo",
      "session-1",
    );
    await expect(response.json()).resolves.toMatchObject({
      execution: {
        status: "paused",
      },
    });
  });

  it("returns history items that include the current terminal execution for review", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-halted",
          status: "halted",
          completedAt: "2026-03-27T13:30:00.000Z",
          activeContextIds: ["context-plan"],
          taskStates: {
            "task-plan-1": {
              taskId: "task-plan-1",
              contextId: "context-plan",
              order: 1,
              status: "interrupted",
              summary: null,
              startedAt: "2026-03-27T13:10:00.000Z",
              completedAt: null,
              lastConversationId: "conversation-2",
              failureMessage: "validation blocked completion",
              failureHistory: [],
            },
          },
          haltReason: {
            type: "circuit_breaker",
            contextId: "context-plan",
            condition: "retry_exhaustion",
            summary: "validator blocked completion",
            failureCount: 2,
          },
        }),
      }),
    );

    const response = await handlers.HISTORY(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/history",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        {
          executionId: "execution-halted",
          definitionId: "workflow-1",
          definitionRevision: 1,
          status: "halted",
          startedAt: "2026-03-27T12:00:00.000Z",
          completedAt: "2026-03-27T13:30:00.000Z",
          activeContextIds: ["context-plan"],
          activeContextTitles: ["Plan"],
          activeBatchIds: [],
          haltReason: {
            type: "circuit_breaker",
            contextId: "context-plan",
            condition: "retry_exhaustion",
            summary: "validator blocked completion",
            failureCount: 2,
          },
          pendingHaltReason: null,
          contextMergeProgress: [],
          archived: false,
        },
      ],
    });
  });

  it("maps pause, resume, and abort control routes to the workflow manager", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    normalizeExecutionAfterRestart.mockResolvedValue(null);
    pauseExecution.mockResolvedValue(
      createWorkflowExecution({
        status: "paused",
        activeContextIds: ["context-plan"],
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "interrupted",
            summary: null,
            startedAt: "2026-03-27T12:05:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
      }),
    );
    resumeExecution.mockResolvedValue(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "interrupted",
            summary: null,
            startedAt: "2026-03-27T12:05:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
      }),
    );
    abortExecution.mockResolvedValue(
      createWorkflowExecution({
        status: "aborted",
        completedAt: "2026-03-27T12:10:00.000Z",
        haltReason: { type: "aborted" },
      }),
    );

    const pauseResponse = await handlers.PAUSE(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/pause",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );
    expect(pauseResponse.status).toBe(200);

    const resumeResponse = await handlers.RESUME(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/resume",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );
    expect(resumeResponse.status).toBe(200);

    const abortResponse = await handlers.ABORT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/abort",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );
    expect(abortResponse.status).toBe(200);

    expect(pauseExecution).toHaveBeenCalledWith("/repo", "session-1");
    expect(resumeExecution).toHaveBeenCalledWith("/repo", "session-1");
    expect(abortExecution).toHaveBeenCalledWith("/repo", "session-1");
  });

  it("normalizes stale running executions before resuming them", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    normalizeExecutionAfterRestart.mockResolvedValue(
      createWorkflowExecution({
        status: "paused",
        activeContextIds: ["context-plan"],
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "interrupted",
            summary: null,
            startedAt: "2026-03-27T12:05:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
      }),
    );
    resumeExecution.mockResolvedValue(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "interrupted",
            summary: null,
            startedAt: "2026-03-27T12:05:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
      }),
    );

    const response = await handlers.RESUME(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/resume",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(normalizeExecutionAfterRestart).toHaveBeenCalledWith(
      "/repo",
      "session-1",
    );
    expect(resumeExecution).toHaveBeenCalledWith("/repo", "session-1");
    expect(kickOffExecutionLoop).toHaveBeenCalledWith({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      execution: expect.objectContaining({
        status: "running",
        activeContextIds: ["context-plan"],
      }),
    });
  });

  it("clears a terminal execution by archiving it", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          status: "halted",
          completedAt: "2026-03-27T13:30:00.000Z",
          haltReason: {
            type: "circuit_breaker",
            contextId: "context-plan",
            condition: "retry_exhaustion",
            summary: "tests failed",
            failureCount: 2,
          },
        }),
      }),
    );

    const response = await handlers.CLEAR(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/clear",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(archiveExecution).toHaveBeenCalledWith("/repo", "session-1");
  });

  it("resets a selected context and returns the execution summary without kicking off the loop", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-reset",
          status: "paused",
          activeContextIds: ["context-implement"],
        }),
      }),
    );
    resetExecutionContext.mockResolvedValue(
      createWorkflowExecution({
        id: "execution-reset",
        status: "paused",
        activeContextIds: [],
      }),
    );

    const response = await handlers.RESET_CONTEXT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/reset-context",
        "POST",
        { executionId: "execution-reset", contextId: "context-implement" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(resetExecutionContext).toHaveBeenCalledWith(
      "/repo",
      "session-1",
      "context-implement",
    );
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      execution: {
        executionId: "execution-reset",
        status: "paused",
        activeContextIds: [],
        archived: false,
      },
    });
  });

  it("returns 400 when the reset-context request body is invalid", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());

    const response = await handlers.RESET_CONTEXT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/reset-context",
        "POST",
        { executionId: "" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(400);
    expect(resetExecutionContext).not.toHaveBeenCalled();
  });

  it("returns 409 when the workflow manager rejects a reset against a running execution", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-reset",
          status: "running",
        }),
      }),
    );
    resetExecutionContext.mockRejectedValue(
      new Error(
        "Reset only allowed when the workflow is paused or halted (current status: running).",
      ),
    );

    const response = await handlers.RESET_CONTEXT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/reset-context",
        "POST",
        { executionId: "execution-reset", contextId: "context-implement" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
  });

  it("returns 409 when the request executionId does not match the active execution", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-current",
          status: "paused",
        }),
      }),
    );

    const response = await handlers.RESET_CONTEXT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/reset-context",
        "POST",
        { executionId: "execution-stale", contextId: "context-implement" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
    expect(resetExecutionContext).not.toHaveBeenCalled();
  });

  it("returns 404 when the session has no active execution to reset", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession({ graphWorkflowExecution: null }));

    const response = await handlers.RESET_CONTEXT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/reset-context",
        "POST",
        { executionId: "execution-current", contextId: "context-implement" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(404);
    expect(resetExecutionContext).not.toHaveBeenCalled();
  });

  it("rejects clearing a non-terminal execution", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          status: "running",
        }),
      }),
    );

    const response = await handlers.CLEAR(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/clear",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
    expect(archiveExecution).not.toHaveBeenCalled();
  });
});

describe("graph workflow route script validator service", () => {
  it("maps session and config state into the script validator runner input", async () => {
    const getSession = vi.fn(async () =>
      makeSession({
        worktreePath: "/repo/.worktrees/session-1",
        branchName: "csm/session-1",
      }),
    );
    const readConfig = vi.fn(async () => ({
      preMergeTimeoutMs: 123_000,
    }));
    const runScriptValidator = vi.fn(async () => ({ kind: "pass" as const }));

    const service = createGraphWorkflowRouteScriptValidatorService({
      getSession,
      readConfig,
      runScriptValidator,
    });

    const execution = createWorkflowExecution({
      id: "execution-script-1",
      status: "running",
    });

    const result = await service.runScriptValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
    });

    expect(result).toEqual({ kind: "pass" });
    expect(getSession).toHaveBeenCalledWith("/repo", "session-1");
    expect(readConfig).toHaveBeenCalledTimes(1);
    expect(runScriptValidator).toHaveBeenCalledWith({
      projectPath: "/repo",
      worktreePath: "/repo/.worktrees/session-1",
      sessionName: "session-1",
      branchName: "csm/session-1",
      executionId: "execution-script-1",
      contextId: "context-plan",
      timeoutMs: 123_000,
    });
  });
});

// -- Implementer runner wiring: unified executePromptStream path ---------------
// These tests exercise the same wiring pattern used by execution-route-handlers.ts
// to wire implementer turns through createGraphWorkflowImplementerRunner, verifying
// that both Claude and Codex backends use executePromptStream and that no
// implementer-only in-memory resume cache is needed.

import { createGraphWorkflowImplementerRunner } from "./implementer-runner";
import {
  createGraphWorkflowIterationOrchestrator,
  type GraphWorkflowRunAgentIterationInput,
} from "@/lib/workflows/graph-workflow/iteration-orchestrator";
import { createResolvedWorkflowDefinition } from "./test-fixtures";
import type { GraphWorkflowExecution } from "@/types";

function createCodexWorkflowExecution(): GraphWorkflowExecution {
  const definition = createResolvedWorkflowDefinition({
    executionContexts: [
      {
        id: "context-codex",
        title: "Codex Implement",
        acceptanceCriteria: "TBD",
        implementer: {
          backend: "codex",
          model: "gpt-5.4-mini",
          reasoningEffort: "medium",
        },
        contextValidator: null,
        scriptValidator: { enabled: false },
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
      },
    ],
    tasks: [
      {
        id: "task-codex-1",
        contextId: "context-codex",
        order: 1,
        title: "Build feature",
        instructions: "Implement the feature.",
        source: "user",
      },
    ],
    edges: [],
  });

  return createWorkflowExecution({
    status: "running",
    activeContextIds: ["context-codex"],
    workingDefinition: definition,
    contextStates: {
      "context-codex": {
        contextId: "context-codex",
        status: "running",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
    },
    taskStates: {
      "task-codex-1": {
        taskId: "task-codex-1",
        contextId: "context-codex",
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
}

describe("implementer runner wiring (unified executePromptStream path)", () => {
  it("codex implementer turns flow through executePromptStream without a resume cache", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conv-codex-1",
      contextTokens: null,
      contextWindowMax: null,
    }));
    const implementerRunner = createGraphWorkflowImplementerRunner({
      executePromptStream,
      getConversation: vi.fn(async () => ({
        backendRef: {
          backend: "codex" as const,
          threadId: "thread-codex-1",
        },
      })) as never,
    });

    const execution = createCodexWorkflowExecution();
    let activeExecution = execution;

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: {
        async getActive() {
          return activeExecution;
        },
        async mutateActive(_p, _s, fn) {
          const next = await fn(structuredClone(activeExecution));
          activeExecution = next;
          return next;
        },
      },
      createConversation: vi.fn(async () => ({ id: "conv-codex-1" })),
      createToolServer: vi.fn(() => ({ server: { servers: [] } })),
      // Wire runAgentIteration the same way execution-route-handlers.ts does
      async runAgentIteration(input: GraphWorkflowRunAgentIterationInput) {
        return implementerRunner.runIteration({
          projectPath: input.projectPath,
          session: makeSession(),
          prompt: input.prompt,
          conversationId: input.conversationId,
          contextId: input.contextId,
          backend: input.backend,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          toolServer: input.toolServer,
          emitStreamFrame: input.emitStreamFrame,
        });
      },
      now: () => "2026-03-27T16:00:00.000Z",
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-codex",
    });

    // executePromptStream must be called with codex backend — no task runner fallback
    expect(executePromptStream).toHaveBeenCalledWith(
      expect.anything(), // projectPath
      expect.anything(), // session
      expect.anything(), // prompt
      expect.anything(), // emit
      expect.anything(), // conversationId
      "gpt-5.4-mini", // modelId
      undefined, // images
      expect.objectContaining({ backend: "codex", autonomous: true }),
    );
  });

  it("consecutive codex implementer turns each go through executePromptStream (no in-memory cache)", async () => {
    let callCount = 0;
    const executePromptStream = vi.fn(async () => {
      callCount++;
      return {
        conversationId: `conv-codex-${callCount}`,
        contextTokens: null,
        contextWindowMax: null,
      };
    });
    const implementerRunner = createGraphWorkflowImplementerRunner({
      executePromptStream,
      getConversation: vi.fn(async () => ({
        backendRef: {
          backend: "codex" as const,
          threadId: "thread-codex-seeded",
        },
      })) as never,
    });

    const execution = createCodexWorkflowExecution();
    let activeExecution = execution;

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: {
        async getActive() {
          return activeExecution;
        },
        async mutateActive(_p, _s, fn) {
          const next = await fn(structuredClone(activeExecution));
          activeExecution = next;
          return next;
        },
      },
      createConversation: vi.fn(async () => ({ id: "conv-codex-1" })),
      createToolServer: vi.fn(() => ({ server: { servers: [] } })),
      async runAgentIteration(input: GraphWorkflowRunAgentIterationInput) {
        return implementerRunner.runIteration({
          projectPath: input.projectPath,
          session: makeSession(),
          prompt: input.prompt,
          conversationId: input.conversationId,
          contextId: input.contextId,
          backend: input.backend,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          toolServer: input.toolServer,
          emitStreamFrame: input.emitStreamFrame,
        });
      },
      now: () => "2026-03-27T16:00:00.000Z",
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-codex",
    });

    // Initial call + 2 follow-ups = 3 calls, all through executePromptStream.
    // Each call proves no in-memory resume cache is used — the runner delegates
    // every turn to executePromptStream rather than caching a backend ref.
    expect(executePromptStream).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      expect(executePromptStream).toHaveBeenNthCalledWith(
        i + 1,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        "gpt-5.4-mini",
        undefined,
        expect.objectContaining({ backend: "codex", autonomous: true }),
      );
    }
  });
});
