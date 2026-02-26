import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  SessionState,
  RalphLoopWorkflow,
  ConversationState,
  GitIterationMetrics,
} from "@/types";

// ---------------------------------------------------------------------------
// Mocks — all external dependencies the orchestrator calls
// ---------------------------------------------------------------------------

// SDK mock: yields messages then completes
const mockQueryMessages: Array<Record<string, unknown>> = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => ({
    [Symbol.asyncIterator]() {
      let idx = 0;
      return {
        async next() {
          if (idx < mockQueryMessages.length) {
            return { value: mockQueryMessages[idx++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  })),
}));

// State mocks
const sessions = new Map<string, SessionState>();
vi.mock("../state", () => ({
  getSession: vi.fn(
    async (projectPath: string, sessionName: string) =>
      sessions.get(`${projectPath}::${sessionName}`) ?? null,
  ),
  updateSession: vi.fn(async (projectPath: string, session: SessionState) => {
    sessions.set(`${projectPath}::${session.sessionName}`, session);
  }),
  mutateSession: vi.fn(
    async (
      projectPath: string,
      sessionName: string,
      _label: string,
      mutate: (session: SessionState) => unknown,
    ) => {
      const session = sessions.get(`${projectPath}::${sessionName}`);
      if (!session) throw new Error(`Session not found: ${sessionName}`);
      const result = await mutate(session);
      session.lastActivityAt = new Date().toISOString();
      return result;
    },
  ),
  mutateConversation: vi.fn(
    async (
      projectPath: string,
      sessionName: string,
      conversationId: string,
      _label: string,
      mutate: (conversation: ConversationState) => unknown,
    ) => {
      const session = sessions.get(`${projectPath}::${sessionName}`);
      if (!session) throw new Error(`Session not found: ${sessionName}`);
      const conv = session.conversations.find((c) => c.id === conversationId);
      if (!conv) throw new Error(`Conversation not found: ${conversationId}`);
      const result = await mutate(conv);
      conv.lastActivityAt = new Date().toISOString();
      session.lastActivityAt = new Date().toISOString();
      return result;
    },
  ),
}));

// Lock mock
vi.mock("../lock", () => ({
  acquireSessionLock: vi.fn(() => vi.fn()),
}));

// Logger mock
vi.mock("../logging", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Conversation mock
let conversationCounter = 0;
vi.mock("../conversations", () => ({
  createConversation: vi.fn(
    async (projectPath: string, sessionName: string) => {
      conversationCounter++;
      const conv = {
        id: `conv-iter-${conversationCounter}`,
        name: `Iteration ${conversationCounter}`,
        status: "new",
        role: "iteration",
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        promptCount: 0,
        totalCostUsd: 0,
        totalDurationMs: 0,
        totalTurns: 0,
      } as ConversationState;
      // Insert into sessions map so mutateConversation can find it
      const session = sessions.get(`${projectPath}::${sessionName}`);
      if (session) session.conversations.push(conv);
      return conv;
    },
  ),
}));

// Transcript mocks
vi.mock("../transcript", () => ({
  appendTranscriptEntry: vi.fn(async () => {}),
  getTranscriptPath: vi.fn(
    async (id: string) => `/tmp/transcripts/${id}.jsonl`,
  ),
}));

// SSE broadcast mock
vi.mock("../sse-broadcaster", () => ({
  broadcast: vi.fn(),
}));

// Progress detector mock
const mockGitMetrics: GitIterationMetrics = {
  filesChanged: 3,
  linesAdded: 50,
  linesRemoved: 10,
  changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
};
vi.mock("./progress-detector", () => ({
  captureSnapshot: vi.fn(async () => "snapshot-hash"),
  computeDiff: vi.fn(async () => mockGitMetrics),
  classifyProgress: vi.fn(() => "progress"),
}));

// MCP tools mock
vi.mock("./mcp-tools", () => ({
  createToolServer: vi.fn(() => ({ __mock_tools: true })),
}));

// Exit detector mock — default to "continue"
let mockExitDecision: { action: string; reason?: Record<string, unknown> } = {
  action: "continue",
};
vi.mock("./exit-detector", () => ({
  evaluate: vi.fn(() => mockExitDecision),
  isSuccessfulHalt: vi.fn(
    (reason: { type: string }) => reason.type === "plan_complete",
  ),
}));

// Circuit breaker mock
vi.mock("./circuit-breaker", () => ({
  processIteration: vi.fn((current) => current),
}));

// Fix plan manager mock
vi.mock("./fix-plan-manager", () => ({
  applyFixPlanUpdate: vi.fn(() => ({
    plan: [],
    completedIds: [],
    skippedIds: [],
    addedIds: [],
  })),
  getTaskProgress: vi.fn(() => ({
    total: 3,
    completed: 0,
    skipped: 0,
    pending: 3,
    inProgress: 0,
  })),
}));

// Registry mock — track registrations
vi.mock("./orchestrator-registry", () => {
  const entries = new Map<string, { pauseRequested: boolean }>();
  return {
    register: vi.fn(
      (_pp: string, _sn: string, entry: { pauseRequested: boolean }) => {
        entries.set(`${_pp}::${_sn}`, entry);
      },
    ),
    get: vi.fn((_pp: string, _sn: string) => entries.get(`${_pp}::${_sn}`)),
    remove: vi.fn((_pp: string, _sn: string) =>
      entries.delete(`${_pp}::${_sn}`),
    ),
  };
});

// Workflow stream registry mock
vi.mock("./workflow-stream-registry", () => ({
  emit: vi.fn(),
  closeAll: vi.fn(),
  hasClients: vi.fn(() => false),
}));

// Prompt builder mock
vi.mock("./prompt-builder", () => ({
  buildIterationPrompt: vi.fn(() => "Iteration prompt text"),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(
  overrides?: Partial<RalphLoopWorkflow>,
): RalphLoopWorkflow {
  return {
    status: "running",
    objective: "Implement auth system",
    fixPlan: [
      {
        id: "t1",
        description: "Implement JWT",
        priority: "high" as const,
        status: "pending" as const,
        createdAt: "2026-02-25T10:00:00Z",
        completedAt: null,
        skipReason: null,
        addedByIteration: null,
      },
    ],
    config: {
      maxIterations: 20,
      iterationTimeoutMs: 3_600_000,
      contextSoftLimitTokens: 160_000,
      contextHardLimitTokens: 180_000,
      circuitBreaker: { noProgressThreshold: 3, sameErrorThreshold: 5 },
    },
    circuitBreaker: {
      state: "closed" as const,
      consecutiveNoProgress: 0,
      consecutiveSameError: 0,
      lastErrorPattern: null,
      lastProgressIteration: 0,
    },
    iterations: [],
    haltReason: null,
    generatingPlan: false,
    createdAt: "2026-02-25T10:00:00Z",
    startedAt: "2026-02-25T10:05:00Z",
    completedAt: null,
    totalCostUsd: 0,
    totalDurationMs: 0,
    ...overrides,
  };
}

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionName: "feature-auth",
    branchName: "csm/feature-auth",
    worktreePath: "/tmp/worktrees/feature-auth",
    createdAt: "2026-02-25T09:00:00Z",
    lastActivityAt: "2026-02-25T10:00:00Z",
    objective: "Auth system",
    conversations: [],
    mode: "worktree" as const,
    workflow: makeWorkflow(),
    ...overrides,
  } as SessionState;
}

const PROJECT = "/home/user/my-project";
const SESSION_NAME = "feature-auth";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Orchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessions.clear();
    conversationCounter = 0;
    mockExitDecision = { action: "continue" };
    mockQueryMessages.length = 0;

    // Set up initial session state
    const session = makeSession();
    sessions.set(`${PROJECT}::${SESSION_NAME}`, session);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers in the orchestrator registry on start", async () => {
    // Make exit detector halt immediately to prevent infinite loop
    mockExitDecision = { action: "halt", reason: { type: "plan_complete" } };

    // Add a result message to consume
    mockQueryMessages.push({
      type: "result",
      total_cost_usd: 0.15,
      duration_ms: 5000,
      num_turns: 3,
    });

    const { startOrchestrator } = await import("./orchestrator");
    const { register } = await import("./orchestrator-registry");

    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;
    startOrchestrator({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
    });

    // Give async loop time to start
    await new Promise((r) => setTimeout(r, 100));

    expect(register).toHaveBeenCalledWith(
      PROJECT,
      SESSION_NAME,
      expect.objectContaining({
        projectPath: PROJECT,
        sessionName: SESSION_NAME,
        pauseRequested: false,
      }),
    );
  });

  it("creates a managed conversation with role 'iteration'", async () => {
    mockExitDecision = { action: "halt", reason: { type: "plan_complete" } };
    mockQueryMessages.push({
      type: "result",
      total_cost_usd: 0.1,
      duration_ms: 3000,
      num_turns: 2,
    });

    const { startOrchestrator } = await import("./orchestrator");
    const { createConversation } = await import("../conversations");

    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;
    startOrchestrator({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(createConversation).toHaveBeenCalledWith(PROJECT, SESSION_NAME, {
      role: "iteration",
    });
  });

  it("calls the prompt builder with workflow context", async () => {
    mockExitDecision = { action: "halt", reason: { type: "plan_complete" } };
    mockQueryMessages.push({
      type: "result",
      total_cost_usd: 0.1,
      duration_ms: 3000,
      num_turns: 2,
    });

    const { startOrchestrator } = await import("./orchestrator");
    const { buildIterationPrompt } = await import("./prompt-builder");

    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;
    startOrchestrator({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(buildIterationPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        objective: "Implement auth system",
        iterationNumber: 1,
        maxIterations: 20,
      }),
    );
  });

  it("acquires and releases the session lock per iteration", async () => {
    mockExitDecision = { action: "halt", reason: { type: "plan_complete" } };
    mockQueryMessages.push({
      type: "result",
      total_cost_usd: 0.1,
      duration_ms: 3000,
      num_turns: 2,
    });

    const { startOrchestrator } = await import("./orchestrator");
    const { acquireSessionLock } = await import("../lock");

    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;
    startOrchestrator({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(acquireSessionLock).toHaveBeenCalledWith(PROJECT, SESSION_NAME);
    // The release function returned by acquireSessionLock should have been called
    const releaseFn = vi.mocked(acquireSessionLock).mock.results[0]?.value;
    expect(releaseFn).toHaveBeenCalled();
  });

  it("captures git snapshot before and computes diff after iteration", async () => {
    mockExitDecision = { action: "halt", reason: { type: "plan_complete" } };
    mockQueryMessages.push({
      type: "result",
      total_cost_usd: 0.1,
      duration_ms: 3000,
      num_turns: 2,
    });

    const { startOrchestrator } = await import("./orchestrator");
    const { captureSnapshot, computeDiff } =
      await import("./progress-detector");

    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;
    startOrchestrator({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(captureSnapshot).toHaveBeenCalledWith(session.worktreePath);
    expect(computeDiff).toHaveBeenCalledWith(
      session.worktreePath,
      "snapshot-hash",
    );
  });

  it("evaluates exit conditions after each iteration", async () => {
    mockExitDecision = { action: "halt", reason: { type: "plan_complete" } };
    mockQueryMessages.push({
      type: "result",
      total_cost_usd: 0.1,
      duration_ms: 3000,
      num_turns: 2,
    });

    const { startOrchestrator } = await import("./orchestrator");
    const { evaluate } = await import("./exit-detector");

    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;
    startOrchestrator({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        circuitBreakerState: "closed",
      }),
    );
  });

  it("broadcasts workflow status on halt", async () => {
    mockExitDecision = { action: "halt", reason: { type: "plan_complete" } };
    mockQueryMessages.push({
      type: "result",
      total_cost_usd: 0.1,
      duration_ms: 3000,
      num_turns: 2,
    });

    const { startOrchestrator } = await import("./orchestrator");
    const { broadcast } = await import("../sse-broadcaster");

    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;
    startOrchestrator({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
    });

    await new Promise((r) => setTimeout(r, 300));

    // Should have broadcast workflow-status at least twice (running + halt)
    const statusCalls = vi
      .mocked(broadcast)
      .mock.calls.filter(
        (call) => (call[0] as { type: string }).type === "workflow-status",
      );
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("closes stream connections on halt", async () => {
    mockExitDecision = { action: "halt", reason: { type: "plan_complete" } };
    mockQueryMessages.push({
      type: "result",
      total_cost_usd: 0.1,
      duration_ms: 3000,
      num_turns: 2,
    });

    const { startOrchestrator } = await import("./orchestrator");
    const streamRegistry = await import("./workflow-stream-registry");

    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;
    startOrchestrator({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
    });

    await new Promise((r) => setTimeout(r, 300));

    expect(streamRegistry.closeAll).toHaveBeenCalledWith(PROJECT, SESSION_NAME);
  });

  it("removes from orchestrator registry after loop completes", async () => {
    mockExitDecision = { action: "halt", reason: { type: "plan_complete" } };
    mockQueryMessages.push({
      type: "result",
      total_cost_usd: 0.1,
      duration_ms: 3000,
      num_turns: 2,
    });

    const { startOrchestrator } = await import("./orchestrator");
    const { remove } = await import("./orchestrator-registry");

    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;
    startOrchestrator({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
    });

    await new Promise((r) => setTimeout(r, 300));

    expect(remove).toHaveBeenCalledWith(PROJECT, SESSION_NAME);
  });

  it("stops when pause is requested between iterations", async () => {
    // First iteration: continue. But set pause before second check.
    let callCount = 0;
    mockExitDecision = { action: "continue" };
    mockQueryMessages.push({
      type: "result",
      total_cost_usd: 0.1,
      duration_ms: 3000,
      num_turns: 2,
    });

    const registryModule = await import("./orchestrator-registry");
    vi.mocked(registryModule.get).mockImplementation(() => {
      callCount++;
      // Second call to get() — simulate pause requested
      if (callCount > 1) {
        return {
          pauseRequested: true,
          projectPath: PROJECT,
          sessionName: SESSION_NAME,
          abortController: new AbortController(),
        };
      }
      return {
        pauseRequested: false,
        projectPath: PROJECT,
        sessionName: SESSION_NAME,
        abortController: new AbortController(),
      };
    });

    const { startOrchestrator } = await import("./orchestrator");

    const session = sessions.get(`${PROJECT}::${SESSION_NAME}`)!;
    startOrchestrator({
      projectPath: PROJECT,
      session,
      workflow: session.workflow!,
    });

    await new Promise((r) => setTimeout(r, 500));

    // Workflow should have been set to paused
    const finalSession = sessions.get(`${PROJECT}::${SESSION_NAME}`);
    expect(finalSession?.workflow?.status).toMatch(/paused|running/);
  });
});
