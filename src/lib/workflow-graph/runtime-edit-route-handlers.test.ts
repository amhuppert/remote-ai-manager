import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@/types";
import { createWorkflowExecution } from "./test-fixtures";
import { createGraphWorkflowRuntimeEditRouteHandlers } from "./runtime-edit-route-handlers";

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
    workflow: null,
    workflowHistory: [],
    graphWorkflowExecution: null,
    graphWorkflowExecutionHistory: [],
    referenceDocuments: [],
    ...overrides,
  };
}

describe("graph workflow runtime edit route handlers", () => {
  const resolveProjectPath = vi.fn<(_name: string) => Promise<string | null>>();
  const getSession =
    vi.fn<
      (
        _projectPath: string,
        _sessionName: string,
      ) => Promise<SessionState | null>
    >();
  const applyRuntimeEdits = vi.fn();

  const handlers = createGraphWorkflowRuntimeEditRouteHandlers({
    resolveProjectPath,
    getSession,
    applyRuntimeEdits,
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("applies runtime task edits and returns the updated execution", async () => {
    const updatedExecution = createWorkflowExecution({
      workingDefinition: {
        ...createWorkflowExecution().workingDefinition,
        tasks: [
          {
            id: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            title: "Inspect code deeply",
            instructions: "Read the relevant files carefully.",
            source: "user",
          },
          ...createWorkflowExecution().workingDefinition.tasks.filter(
            (task) => task.id !== "task-plan-1",
          ),
        ],
      },
    });

    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          status: "running",
        }),
      }),
    );
    applyRuntimeEdits.mockResolvedValue(updatedExecution);

    const response = await handlers.POST(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/runtime-edits",
        "POST",
        {
          operations: [
            {
              type: "update",
              taskId: "task-plan-1",
              title: "Inspect code deeply",
            },
          ],
        },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(applyRuntimeEdits).toHaveBeenCalledWith("/repo", "session-1", {
      operations: [
        {
          type: "update",
          taskId: "task-plan-1",
          title: "Inspect code deeply",
        },
      ],
    });
    await expect(response.json()).resolves.toMatchObject({
      execution: {
        id: "execution-1",
      },
    });
  });

  it("returns structured validation errors for rejected runtime edits", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          status: "running",
        }),
      }),
    );
    applyRuntimeEdits.mockRejectedValue({
      name: "GraphWorkflowRuntimeEditValidationError",
      message: "Runtime edit validation failed",
      errors: [
        {
          code: "runtime-edit-task-locked",
          message: 'Task "task-plan-1" cannot be changed in status "completed"',
          taskId: "task-plan-1",
          contextId: "context-plan",
          operationIndex: 0,
        },
      ],
    });

    const response = await handlers.POST(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/runtime-edits",
        "POST",
        {
          operations: [
            {
              type: "update",
              taskId: "task-plan-1",
              title: "Blocked change",
            },
          ],
        },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "Runtime edit validation failed",
      errors: [
        {
          code: "runtime-edit-task-locked",
          message: 'Task "task-plan-1" cannot be changed in status "completed"',
          taskId: "task-plan-1",
          contextId: "context-plan",
          operationIndex: 0,
        },
      ],
    });
  });
});
