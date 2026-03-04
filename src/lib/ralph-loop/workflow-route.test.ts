import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { SessionState, RalphLoopWorkflow } from "@/types";
import { createInitialCircuitBreakerState } from "./circuit-breaker";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/project-resolver", () => ({
  resolveProjectPath: vi.fn(),
}));

vi.mock("@/lib/state", () => ({
  getSession: vi.fn(),
  updateSession: vi.fn(),
  mutateSession: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  withTracing: (fn: (...args: unknown[]) => unknown) => fn,
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@/lib/workflows/ralph-loop/workflow-manager", () => ({
  startWorkflow: vi.fn(),
  resumeWorkflow: vi.fn(),
  sendEvent: vi.fn(),
  hasActiveWorkflow: vi.fn(),
}));

vi.mock("@/lib/ralph-loop/plan-generator", () => ({
  dispatchPlanGeneration: vi.fn(),
}));

vi.mock("@/lib/sse-broadcaster", () => ({
  broadcast: vi.fn(),
}));

vi.mock("@/lib/conversations", () => ({
  getConversation: vi.fn(),
}));

vi.mock("@/lib/prompt", () => ({
  executePromptStream: vi.fn(),
}));

vi.mock("@/lib/lock", () => ({
  isSessionBusy: vi.fn().mockReturnValue(false),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

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
    workflow,
  };
}

function makeWorkflow(
  overrides: Partial<RalphLoopWorkflow> = {},
): RalphLoopWorkflow {
  return {
    status: "planning",
    objective: "Test objective",
    fixPlan: [],
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
  it("creates a workflow in planning status", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession, mutateSession } = await import("@/lib/state");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
    const session = makeSession(null);
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(mutateSession).mockImplementation(async (_p, _n, _l, mutate) =>
      mutate(session, { rootPath: _p, roadmapItems: [], sessions: {} }),
    );

    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/route");

    const response = await POST(
      makeRequest("/api/workflow", "POST", {
        objective: "Build the feature",
      }),
      { params: routeParams },
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.workflow.status).toBe("planning");
    expect(body.workflow.objective).toBe("Build the feature");
    expect(mutateSession).toHaveBeenCalled();
  });

  it("rejects duplicate workflow creation", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession } = await import("@/lib/state");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
    vi.mocked(getSession).mockResolvedValue(makeSession(makeWorkflow()));

    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/route");

    const response = await POST(
      makeRequest("/api/workflow", "POST", { objective: "Duplicate" }),
      { params: routeParams },
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain("already has a workflow");
  });

  it("returns current workflow state via GET", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession } = await import("@/lib/state");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
    const workflow = makeWorkflow({ objective: "Active objective" });
    vi.mocked(getSession).mockResolvedValue(makeSession(workflow));

    const { GET } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/route");

    const response = await GET(makeRequest("/api/workflow", "GET"), {
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
  it("starts XState workflow for valid plan", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession } = await import("@/lib/state");
    const { startWorkflow } =
      await import("@/lib/workflows/ralph-loop/workflow-manager");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
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
    vi.mocked(getSession).mockResolvedValue(makeSession(workflow));

    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/confirm/route");

    const response = await POST(makeRequest("/api/confirm", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(202);
    expect(startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/tmp/projects/test" }),
    );
  });

  it("rejects empty objective", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession } = await import("@/lib/state");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
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
    vi.mocked(getSession).mockResolvedValue(makeSession(workflow));

    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/confirm/route");

    const response = await POST(makeRequest("/api/confirm", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Objective");
  });

  it("rejects empty fix plan", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession } = await import("@/lib/state");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
    const workflow = makeWorkflow({ objective: "Good objective", fixPlan: [] });
    vi.mocked(getSession).mockResolvedValue(makeSession(workflow));

    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/confirm/route");

    const response = await POST(makeRequest("/api/confirm", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("at least one task");
  });

  it("rejects confirm when not in planning phase", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession } = await import("@/lib/state");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
    const workflow = makeWorkflow({ status: "running" });
    vi.mocked(getSession).mockResolvedValue(makeSession(workflow));

    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/confirm/route");

    const response = await POST(makeRequest("/api/confirm", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Tests: Pause / Resume / Abort
// ---------------------------------------------------------------------------

describe("pause", () => {
  it("sends PAUSE event for running workflow with active actor", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession } = await import("@/lib/state");
    const { sendEvent, hasActiveWorkflow } =
      await import("@/lib/workflows/ralph-loop/workflow-manager");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
    vi.mocked(getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "running" })),
    );
    vi.mocked(hasActiveWorkflow).mockReturnValue(true);

    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/pause/route");

    const response = await POST(makeRequest("/api/pause", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(200);
    expect(sendEvent).toHaveBeenCalledWith(
      "/tmp/projects/test",
      "test-session",
      { type: "PAUSE" },
    );
  });

  it("rejects pause for non-running workflow", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession } = await import("@/lib/state");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
    vi.mocked(getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "paused" })),
    );

    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/pause/route");

    const response = await POST(makeRequest("/api/pause", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(409);
  });
});

describe("resume", () => {
  it("resumes a paused workflow via XState workflow manager", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession } = await import("@/lib/state");
    const { resumeWorkflow } =
      await import("@/lib/workflows/ralph-loop/workflow-manager");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
    vi.mocked(getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "paused" })),
    );

    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/resume/route");

    const response = await POST(makeRequest("/api/resume", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(202);
    expect(resumeWorkflow).toHaveBeenCalled();
  });

  it("resumes a halted workflow, clearing halt reason", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession, mutateSession } = await import("@/lib/state");
    const { resumeWorkflow } =
      await import("@/lib/workflows/ralph-loop/workflow-manager");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
    const session = makeSession(
      makeWorkflow({
        status: "halted",
        haltReason: { type: "circuit_breaker", reason: "no_progress" },
      }),
    );
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(mutateSession).mockImplementation(async (_p, _n, _l, mutate) =>
      mutate(session, { rootPath: _p, roadmapItems: [], sessions: {} }),
    );

    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/resume/route");

    const response = await POST(makeRequest("/api/resume", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(202);
    expect(resumeWorkflow).toHaveBeenCalled();
    expect(mutateSession).toHaveBeenCalled();
  });

  it("rejects resume for running workflow", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession } = await import("@/lib/state");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
    vi.mocked(getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "running" })),
    );

    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/resume/route");

    const response = await POST(makeRequest("/api/resume", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(409);
  });
});

describe("abort", () => {
  it("sends ABORT event for running workflow with active actor", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession } = await import("@/lib/state");
    const { sendEvent, hasActiveWorkflow } =
      await import("@/lib/workflows/ralph-loop/workflow-manager");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
    vi.mocked(getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "running" })),
    );
    vi.mocked(hasActiveWorkflow).mockReturnValue(true);

    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/abort/route");

    const response = await POST(makeRequest("/api/abort", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(200);
    expect(sendEvent).toHaveBeenCalledWith(
      "/tmp/projects/test",
      "test-session",
      { type: "ABORT" },
    );
  });

  it("aborts a paused workflow directly when no active actor", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession, mutateSession } = await import("@/lib/state");
    const { hasActiveWorkflow } =
      await import("@/lib/workflows/ralph-loop/workflow-manager");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
    const session = makeSession(makeWorkflow({ status: "paused" }));
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(hasActiveWorkflow).mockReturnValue(false);
    vi.mocked(mutateSession).mockImplementation(async (_p, _n, _l, mutate) =>
      mutate(session, { rootPath: _p, roadmapItems: [], sessions: {} }),
    );

    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/abort/route");

    const response = await POST(makeRequest("/api/abort", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(200);
    expect(mutateSession).toHaveBeenCalled();
  });

  it("rejects abort for completed workflow", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession } = await import("@/lib/state");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
    vi.mocked(getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "completed" })),
    );

    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/abort/route");

    const response = await POST(makeRequest("/api/abort", "POST"), {
      params: routeParams,
    });

    expect(response.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Tests: Fix Plan Update
// ---------------------------------------------------------------------------

describe("fix plan update", () => {
  it("updates fix plan during planning phase", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession, mutateSession } = await import("@/lib/state");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
    const session = makeSession(makeWorkflow({ status: "planning" }));
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(mutateSession).mockImplementation(async (_p, _n, _l, mutate) =>
      mutate(session, { rootPath: _p, roadmapItems: [], sessions: {} }),
    );

    const { PUT } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/fix-plan/route");

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

    const response = await PUT(
      makeRequest("/api/fix-plan", "PUT", { fixPlan: tasks }),
      { params: routeParams },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.fixPlan).toHaveLength(1);
    expect(body.fixPlan[0].description).toBe("New task");
    expect(mutateSession).toHaveBeenCalled();
  });

  it("rejects fix plan update during running phase", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession } = await import("@/lib/state");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
    vi.mocked(getSession).mockResolvedValue(
      makeSession(makeWorkflow({ status: "running" })),
    );

    const { PUT } =
      await import("@/app/api/projects/[name]/sessions/[session]/workflow/fix-plan/route");

    const response = await PUT(
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
  it("rejects prompts to iteration conversations", async () => {
    const { resolveProjectPath } = await import("@/lib/project-resolver");
    const { getSession } = await import("@/lib/state");
    const { getConversation } = await import("@/lib/conversations");
    vi.mocked(resolveProjectPath).mockResolvedValue("/tmp/projects/test");
    const session = makeSession(makeWorkflow({ status: "running" }));
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(getConversation).mockResolvedValue({
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

    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/prompt/route");

    const response = await POST(
      makeRequest("/api/prompt", "POST", { prompt: "Hello" }),
      { params: convRouteParams },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe("MANAGED_CONVERSATION");
  });
});
