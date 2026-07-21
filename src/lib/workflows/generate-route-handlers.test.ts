import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "@/lib/workflow-graph/test-fixtures";
import { createWorkflowGenerateRouteHandlers } from "./generate-route-handlers";
import type { SessionState } from "@/lib/sessions/schemas";
import { PLANNER_SESSION_NAME } from "@/lib/sessions/service";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/projects/repo/workflows/generate",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

function makeContext(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function makePlannerSession(
  overrides: Partial<SessionState> & { conversationId?: string } = {},
): SessionState {
  const conversationId = overrides.conversationId ?? "planner-conv-1";
  const now = "2024-01-01T00:00:00.000Z";
  return {
    sessionName: PLANNER_SESSION_NAME,
    worktreePath: "/repo/.worktrees/__planner__",
    branchName: `csm/${PLANNER_SESSION_NAME}`,
    createdAt: now,
    lastActivityAt: now,
    archived: false,
    finished: false,
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
    conversations: [
      {
        id: conversationId,
        scope: "session",
        name: `${PLANNER_SESSION_NAME} 1`,
        transcriptPath: null,
        status: "new",
        promptCount: 0,
        createdAt: now,
        lastActivityAt: now,
        source: "cc",
        summary: null,
        archived: false,
        totalCostUsd: null,
        totalDurationMs: null,
        totalTurns: null,
        pendingQuestionId: null,
        pendingQuestions: null,
        pendingPromptText: null,
        forkedFrom: null,
        role: null,
        activeTurnSource: null,
        contextTokens: null,
        contextWindowMax: null,
        debugMode: null,
        agentBackend: "claude",
        backendRef: null,
        unread: false,
        pendingQueue: [],
        lastSeenAlignmentVersion: null,
        pendingAgentNotices: [],
      },
    ],
    ...overrides,
  };
}

describe("workflow graph generate route handlers", () => {
  const resolveProjectPath = vi.fn<(_name: string) => Promise<string | null>>();
  const ensurePlannerSession =
    vi.fn<(_projectPath: string) => Promise<SessionState>>();
  const generateDraft = vi.fn();

  const handlers = createWorkflowGenerateRouteHandlers({
    resolveProjectPath,
    ensurePlannerSession,
    generateDraft,
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("ensures the planner session and binds the draft to __planner__", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    ensurePlannerSession.mockResolvedValue(
      makePlannerSession({ conversationId: "planner-conv-xyz" }),
    );
    generateDraft.mockResolvedValue({
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
      validationErrors: [],
    });

    const response = await handlers.POST(
      makeRequest({
        objective: "Create a workflow draft",
        references: [],
      }),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(200);
    expect(ensurePlannerSession).toHaveBeenCalledWith("/repo");
    expect(generateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/repo",
        sessionName: PLANNER_SESSION_NAME,
        conversationId: "planner-conv-xyz",
        objective: "Create a workflow draft",
      }),
    );
  });

  it("returns 400 for an invalid planning request", async () => {
    resolveProjectPath.mockResolvedValue("/repo");

    const response = await handlers.POST(
      makeRequest({
        objective: "",
      }),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(400);
    expect(ensurePlannerSession).not.toHaveBeenCalled();
  });

  it("returns 404 when the project is missing", async () => {
    resolveProjectPath.mockResolvedValue(null);

    const response = await handlers.POST(
      makeRequest({
        objective: "Create a workflow draft",
        references: [],
      }),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(404);
    expect(ensurePlannerSession).not.toHaveBeenCalled();
  });
});
