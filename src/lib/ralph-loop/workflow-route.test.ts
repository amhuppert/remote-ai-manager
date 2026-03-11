import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { SessionState, RalphLoopWorkflow } from "@/types";
import { createInitialCircuitBreakerState } from "./circuit-breaker";
import {
  createWorkflowRouteHandlers,
  type WorkflowRouteDeps,
} from "./workflow-route-handlers";

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

function makeDeps(
  overrides: Partial<WorkflowRouteDeps> = {},
): WorkflowRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/tmp/projects/test"),
    getSession: vi.fn().mockResolvedValue(null),
    mutateSession: vi.fn().mockImplementation(async (_p, _n, _l, mutate) => {
      const session = makeSession(null);
      return mutate(session, { rootPath: _p, roadmapItems: [], sessions: {} });
    }),
    startWorkflow: vi.fn(),
    resumeWorkflow: vi.fn(),
    sendEvent: vi.fn(),
    hasActiveWorkflow: vi.fn().mockReturnValue(false),
    dispatchPlanGeneration: vi.fn(),
    getConversation: vi.fn().mockResolvedValue(null),
    executePromptStream: vi.fn().mockResolvedValue(undefined),
    isSessionBusy: vi.fn().mockReturnValue(false),
    broadcast: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(workflow: RalphLoopWorkflow | null = null): SessionState {
  return {
    sessionName: "test-session",
    worktreePath: "/tmp/test-worktree",
    branchName: "csm/test-session",
    createdAt: "2025-01-01T00:00:00Z",
    lastActivityAt: "2025-01-01T00:00:00Z",
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    objective: null,
    creationMode: "fast",
    tddEnabled: true,
    workflow,
    workflowHistory: [],
  };
}

function makeWorkflow(
  overrides: Partial<RalphLoopWorkflow> = {},
): RalphLoopWorkflow {
  return {
    status: "planning",
    objective: "Test objective",
    fixPlan: [],
    references: [],
    config: {
      maxIterations: 20,
      iterationTimeoutMs: 3_600_000,
      contextSoftLimitTokens: 160_000,
      contextHardLimitTokens: 180_000,
      circuitBreaker: { noProgressThreshold: 3, sameErrorThreshold: 5 },
    },
    circuitBreaker: createInitialCircuitBreakerState(),
    iterations: [],
    haltReason: null,
    generatingPlan: false,
    createdAt: "2025-01-01T00:00:00Z",
    startedAt: null,
    completedAt: null,
    totalCostUsd: 0,
    totalDurationMs: 0,
    currentIterationConversationId: null,
    ...overrides,
  };
}

function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  const init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
  } = { method };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new NextRequest(`http://localhost${url}`, init);
}

const routeParams = Promise.resolve({
  name: "test-project",
  session: "test-session",
});

// ---------------------------------------------------------------------------
// Tests: Workflow Lifecycle
// ---------------------------------------------------------------------------

describe("workflow lifecycle", () => {
  let deps: WorkflowRouteDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("creates a workflow in planning status", async () => {
    const session = makeSession(null);
    vi.mocked(deps.getSession).mockResolvedValue(session);
    vi.mocked(deps.mutateSession).mockImplementation(
      async (_p, _n, _l, mutate) =>
        mutate(session, { rootPath: _p, roadmapItems: [], sessions: {} }),
    );

    const { workflowPOST } = createWorkflowRouteHandlers(deps);

    const response = await workflowPOST(
      makeRequest("/api/workflow", "POST", {
        objective: "Build the feature",
      }),
      { params: routeParams },
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.workflow.status).toBe("planning");
    expect(body.workflow.objective).toBe("Build the feature");
    expect(deps.mutateSession).toHaveBeenCalled();
  });

  it("rejects duplicate workflow creation", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(makeSession(makeWorkflow()));

    const { workflowPOST } = createWorkflowRouteHandlers(deps);

    const response = await workflowPOST(
      makeRequest("/api/workflow", "POST", { objective: "Duplicate" }),
      { params: routeParams },
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain("already has a workflow");
  });

  it("returns current workflow state via GET", async () => {
    const workflow = makeWorkflow({ objective: "Active objective" });
    vi.mocked(deps.getSession).mockResolvedValue(makeSession(workflow));

    const { workflowGET } = createWorkflowRouteHandlers(deps);

    const response = await workflowGET(makeRequest("/api/workflow", "GET"), {
      params: routeParams,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workflow.objective).toBe("Active objective");
  });
});

// ---------------------------------------------------------------------------
// Tests: Confirm and Start
// ---------------------------------------------------------------------------

describe("confirm and start", () => {
  let deps: WorkflowRouteDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("starts XState workflow for valid plan", async () => {
    const workflow = makeWorkflow({
      objective: "Do the thing",
      fixPlan: [
        {
          id: "t1",
          description: "First task",
          group: 1,
          status: "pending",
          createdAt: "2025-01-01T00:00:00Z",
          completedAt: null,
          skipReason: null,
          addedByIteration: null,
        },
      ],
    });
    vi.mocked(deps.getSession).mockResolvedValue(makeSession(workflow));

    const { confirmPOST } = createWorkflowRouteHandlers(deps);

    const response = await confirmPOST(makeRequest("/api/confirm", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(202);
    expect(deps.startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/tmp/projects/test" }),
    );
  });

  it("rejects empty objective", async () => {
    const workflow = makeWorkflow({
      objective: "",
      fixPlan: [
        {
          id: "t1",
          description: "Task",
          group: 1,
          status: "pending",
          createdAt: "2025-01-01T00:00:00Z",
          completedAt: null,
          skipReason: null,
          addedByIteration: null,
        },
      ],
    });
    vi.mocked(deps.getSession).mockResolvedValue(makeSession(workflow));

    const { confirmPOST } = createWorkflowRouteHandlers(deps);

    const response = await confirmPOST(makeRequest("/api/confirm", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Objective");
  });

  it("rejects empty fix plan", async () => {
    const workflow = makeWorkflow({ objective: "Good objective", fixPlan: [] });
    vi.mocked(deps.getSession).mockResolvedValue(makeSession(workflow));

    const { confirmPOST } = createWorkflowRouteHandlers(deps);

    const response = await confirmPOST(makeRequest("/api/confirm", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("at least one task");
  });

  it("rejects confirm when not in planning phase", async () => {
    const workflow = makeWorkflow({ status: "running" });
    vi.mocked(deps.getSession).mockResolvedValue(makeSession(workflow));

    const { confirmPOST } = createWorkflowRouteHandlers(deps);

    const response = await confirmPOST(makeRequest("/api/confirm", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Tests: Pause / Resume / Abort
// ---------------------------------------------------------------------------

describe("pause", () => {
  let deps: WorkflowRouteDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("sends PAUSE event for running workflow with active actor", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "running" })),
    );
    vi.mocked(deps.hasActiveWorkflow).mockReturnValue(true);

    const { pausePOST } = createWorkflowRouteHandlers(deps);

    const response = await pausePOST(makeRequest("/api/pause", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(200);
    expect(deps.sendEvent).toHaveBeenCalledWith(
      "/tmp/projects/test",
      "test-session",
      { type: "PAUSE" },
    );
  });

  it("rejects pause for non-running workflow", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "paused" })),
    );

    const { pausePOST } = createWorkflowRouteHandlers(deps);

    const response = await pausePOST(makeRequest("/api/pause", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(409);
  });
});

describe("resume", () => {
  let deps: WorkflowRouteDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("resumes a paused workflow via XState workflow manager", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "paused" })),
    );

    const { resumePOST } = createWorkflowRouteHandlers(deps);

    const response = await resumePOST(makeRequest("/api/resume", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(202);
    expect(deps.resumeWorkflow).toHaveBeenCalled();
  });

  it("resumes a halted workflow, clearing halt reason", async () => {
    const session = makeSession(
      makeWorkflow({
        status: "halted",
        haltReason: { type: "circuit_breaker", reason: "no_progress" },
      }),
    );
    vi.mocked(deps.getSession).mockResolvedValue(session);
    vi.mocked(deps.mutateSession).mockImplementation(
      async (_p, _n, _l, mutate) =>
        mutate(session, { rootPath: _p, roadmapItems: [], sessions: {} }),
    );

    const { resumePOST } = createWorkflowRouteHandlers(deps);

    const response = await resumePOST(makeRequest("/api/resume", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(202);
    expect(deps.resumeWorkflow).toHaveBeenCalled();
    expect(deps.mutateSession).toHaveBeenCalled();
  });

  it("rejects resume for running workflow", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "running" })),
    );

    const { resumePOST } = createWorkflowRouteHandlers(deps);

    const response = await resumePOST(makeRequest("/api/resume", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(409);
  });
});

describe("abort", () => {
  let deps: WorkflowRouteDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("sends ABORT event for running workflow with active actor", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "running" })),
    );
    vi.mocked(deps.hasActiveWorkflow).mockReturnValue(true);

    const { abortPOST } = createWorkflowRouteHandlers(deps);

    const response = await abortPOST(makeRequest("/api/abort", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(200);
    expect(deps.sendEvent).toHaveBeenCalledWith(
      "/tmp/projects/test",
      "test-session",
      { type: "ABORT" },
    );
  });

  it("aborts a paused workflow directly when no active actor", async () => {
    const session = makeSession(makeWorkflow({ status: "paused" }));
    vi.mocked(deps.getSession).mockResolvedValue(session);
    vi.mocked(deps.hasActiveWorkflow).mockReturnValue(false);
    vi.mocked(deps.mutateSession).mockImplementation(
      async (_p, _n, _l, mutate) =>
        mutate(session, { rootPath: _p, roadmapItems: [], sessions: {} }),
    );

    const { abortPOST } = createWorkflowRouteHandlers(deps);

    const response = await abortPOST(makeRequest("/api/abort", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(200);
    expect(deps.mutateSession).toHaveBeenCalled();
  });

  it("rejects abort for completed workflow", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "completed" })),
    );

    const { abortPOST } = createWorkflowRouteHandlers(deps);

    const response = await abortPOST(makeRequest("/api/abort", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Tests: Fix Plan Update
// ---------------------------------------------------------------------------

describe("fix plan update", () => {
  let deps: WorkflowRouteDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("updates fix plan during planning phase", async () => {
    const session = makeSession(makeWorkflow({ status: "planning" }));
    vi.mocked(deps.getSession).mockResolvedValue(session);
    vi.mocked(deps.mutateSession).mockImplementation(
      async (_p, _n, _l, mutate) =>
        mutate(session, { rootPath: _p, roadmapItems: [], sessions: {} }),
    );

    const { fixPlanPUT } = createWorkflowRouteHandlers(deps);

    const tasks = [
      {
        id: "t1",
        description: "New task",
        group: 1,
        status: "pending",
        createdAt: "2025-01-01T00:00:00Z",
        completedAt: null,
        skipReason: null,
        addedByIteration: null,
      },
    ];

    const response = await fixPlanPUT(
      makeRequest("/api/fix-plan", "PUT", { fixPlan: tasks }),
      { params: routeParams },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.fixPlan).toHaveLength(1);
    expect(body.fixPlan[0].description).toBe("New task");
    expect(deps.mutateSession).toHaveBeenCalled();
  });

  it("rejects fix plan update during running phase", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "running" })),
    );

    const { fixPlanPUT } = createWorkflowRouteHandlers(deps);

    const response = await fixPlanPUT(
      makeRequest("/api/fix-plan", "PUT", { fixPlan: [] }),
      { params: routeParams },
    );

    expect(response.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Tests: Prompt Guards
// ---------------------------------------------------------------------------

describe("prompt route workflow guards", () => {
  let deps: WorkflowRouteDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("rejects prompts to iteration conversations", async () => {
    const session = makeSession(makeWorkflow({ status: "running" }));
    vi.mocked(deps.getSession).mockResolvedValue(session);
    vi.mocked(deps.getConversation).mockResolvedValue({
      id: "conv-1",
      role: "iteration",
      status: "awaiting",
      promptCount: 1,
      createdAt: "2025-01-01T00:00:00Z",
      lastActivityAt: "2025-01-01T00:00:00Z",
      archived: false,
      name: null,
      summary: null,
      claudeSessionId: null,
      transcriptPath: "/tmp/transcript.jsonl",
      totalCostUsd: 0,
      totalDurationMs: 0,
      totalTurns: 0,
      source: "cc",
      pendingQuestionId: null,
      pendingQuestions: null,
      forkedFrom: null,
    });

    const convRouteParams = Promise.resolve({
      name: "test-project",
      session: "test-session",
      conversationId: "conv-1",
    });

    const { conversationPromptPOST } = createWorkflowRouteHandlers(deps);

    const response = await conversationPromptPOST(
      makeRequest("/api/prompt", "POST", { prompt: "Hello" }),
      { params: convRouteParams },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe("MANAGED_CONVERSATION");
  });
});

// ---------------------------------------------------------------------------
// Tests: Reset Workflow
// ---------------------------------------------------------------------------

describe("reset", () => {
  let deps: WorkflowRouteDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("resets a completed workflow, archiving to history", async () => {
    const workflow = makeWorkflow({
      status: "completed",
      haltReason: { type: "plan_complete" },
      completedAt: "2025-01-01T01:00:00Z",
    });
    const session = makeSession(workflow);
    vi.mocked(deps.getSession).mockResolvedValue(session);
    vi.mocked(deps.mutateSession).mockImplementation(
      async (_p, _n, _l, mutate) =>
        mutate(session, { rootPath: _p, roadmapItems: [], sessions: {} }),
    );

    const { resetPOST } = createWorkflowRouteHandlers(deps);

    const response = await resetPOST(makeRequest("/api/reset", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("reset");
    expect(deps.mutateSession).toHaveBeenCalled();
    // Verify the mutation archived the workflow
    expect(session.workflow).toBeNull();
    expect(session.workflowHistory).toHaveLength(1);
    expect(session.workflowHistory[0]!.status).toBe("completed");
  });

  it("resets a halted workflow", async () => {
    const workflow = makeWorkflow({
      status: "halted",
      haltReason: { type: "circuit_breaker", reason: "no_progress" },
    });
    const session = makeSession(workflow);
    vi.mocked(deps.getSession).mockResolvedValue(session);
    vi.mocked(deps.mutateSession).mockImplementation(
      async (_p, _n, _l, mutate) =>
        mutate(session, { rootPath: _p, roadmapItems: [], sessions: {} }),
    );

    const { resetPOST } = createWorkflowRouteHandlers(deps);

    const response = await resetPOST(makeRequest("/api/reset", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(200);
  });

  it("resets an aborted workflow", async () => {
    const workflow = makeWorkflow({
      status: "aborted",
      haltReason: { type: "aborted" },
    });
    const session = makeSession(workflow);
    vi.mocked(deps.getSession).mockResolvedValue(session);
    vi.mocked(deps.mutateSession).mockImplementation(
      async (_p, _n, _l, mutate) =>
        mutate(session, { rootPath: _p, roadmapItems: [], sessions: {} }),
    );

    const { resetPOST } = createWorkflowRouteHandlers(deps);

    const response = await resetPOST(makeRequest("/api/reset", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(200);
  });

  it("rejects reset when no workflow exists", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(makeSession(null));

    const { resetPOST } = createWorkflowRouteHandlers(deps);

    const response = await resetPOST(makeRequest("/api/reset", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(404);
  });

  it("rejects reset for running workflow", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "running" })),
    );

    const { resetPOST } = createWorkflowRouteHandlers(deps);

    const response = await resetPOST(makeRequest("/api/reset", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(409);
  });

  it("rejects reset for paused workflow", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "paused" })),
    );

    const { resetPOST } = createWorkflowRouteHandlers(deps);

    const response = await resetPOST(makeRequest("/api/reset", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(409);
  });

  it("rejects reset when active actor exists", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "completed" })),
    );
    vi.mocked(deps.hasActiveWorkflow).mockReturnValue(true);

    const { resetPOST } = createWorkflowRouteHandlers(deps);

    const response = await resetPOST(makeRequest("/api/reset", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(409);
  });
});
