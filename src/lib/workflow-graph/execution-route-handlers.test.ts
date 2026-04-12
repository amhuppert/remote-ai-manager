import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@/types";
import { createWorkflowExecution } from "./test-fixtures";
import { createGraphWorkflowExecutionRouteHandlers } from "./execution-route-handlers";

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
          activeContextId: "context-plan",
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
              reopenedCount: 0,
              lastReopenedAt: null,
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
        activeContextId: "context-plan",
        activeContextTitle: "Plan",
        haltReason: null,
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
          activeContextId: null,
          activeContextTitle: null,
          haltReason: { type: "aborted" },
          archived: true,
        },
      ],
    });
  });

  it("normalizes an in-flight iteration before returning status", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          status: "running",
          activeContextId: "context-plan",
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
              reopenedCount: 0,
              lastReopenedAt: null,
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
        activeContextId: "context-plan",
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
            reopenedCount: 0,
            lastReopenedAt: null,
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
          activeContextId: "context-plan",
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
              reopenedCount: 0,
              lastReopenedAt: null,
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
          activeContextId: "context-plan",
          activeContextTitle: "Plan",
          haltReason: {
            type: "circuit_breaker",
            contextId: "context-plan",
            condition: "retry_exhaustion",
            summary: "validator blocked completion",
            failureCount: 2,
          },
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
        activeContextId: "context-plan",
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
            reopenedCount: 0,
            lastReopenedAt: null,
            failureMessage: null,
            failureHistory: [],
          },
        },
      }),
    );
    resumeExecution.mockResolvedValue(
      createWorkflowExecution({
        status: "running",
        activeContextId: "context-plan",
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
            reopenedCount: 0,
            lastReopenedAt: null,
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
        activeContextId: "context-plan",
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
            reopenedCount: 0,
            lastReopenedAt: null,
            failureMessage: null,
            failureHistory: [],
          },
        },
      }),
    );
    resumeExecution.mockResolvedValue(
      createWorkflowExecution({
        status: "running",
        activeContextId: "context-plan",
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
            reopenedCount: 0,
            lastReopenedAt: null,
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
        activeContextId: "context-plan",
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
