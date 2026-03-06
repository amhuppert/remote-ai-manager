import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState, RalphLoopWorkflow, FixPlanTask } from "@/types";
import type { InitToolDeps } from "./init-tool";

/**
 * Tests for the Ralph Loop initialization MCP tool server.
 *
 * We mock createSdkMcpServer and tool to capture the handler function,
 * then test it directly with valid/invalid inputs.
 *
 * Internal deps (getSession, mutateSession, dispatchPlanGeneration,
 * createInitialCircuitBreakerState) are injected via the context.deps
 * parameter — no vi.mock calls needed for those modules.
 */

// Store captured tool handlers on globalThis for cross-scope access
const TOOLS_KEY = "__test_init_tool_captured";

function getCapturedTools(): Map<
  string,
  { name: string; handler: (args: unknown) => Promise<unknown> }
> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[TOOLS_KEY]) {
    g[TOOLS_KEY] = new Map();
  }
  return g[TOOLS_KEY] as Map<
    string,
    { name: string; handler: (args: unknown) => Promise<unknown> }
  >;
}

// SDK mock is still needed to capture the tool handler registered via createSdkMcpServer/tool
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const TOOLS_KEY_INNER = "__test_init_tool_captured";
  function getTools(): Map<
    string,
    { name: string; handler: (args: unknown) => Promise<unknown> }
  > {
    const g = globalThis as unknown as Record<string, unknown>;
    if (!g[TOOLS_KEY_INNER]) {
      g[TOOLS_KEY_INNER] = new Map();
    }
    return g[TOOLS_KEY_INNER] as Map<
      string,
      { name: string; handler: (args: unknown) => Promise<unknown> }
    >;
  }

  return {
    createSdkMcpServer: vi.fn(
      (config: {
        tools: Array<{
          name: string;
          handler: (args: unknown) => Promise<unknown>;
        }>;
      }) => {
        const tools = getTools();
        for (const t of config.tools) {
          tools.set(t.name, t);
        }
        return { __mock: true, tools: config.tools };
      },
    ),
    tool: vi.fn(
      (
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) => ({
        name,
        handler,
      }),
    ),
  };
});

// Injected mock deps — no vi.mock calls for internal modules
const mockGetSession = vi.fn();
const mockMutateSession = vi.fn();
const mockBroadcast = vi.fn();
const mockDispatchPlanGeneration = vi.fn();
const mockCreateInitialCircuitBreakerState = vi.fn().mockReturnValue({
  state: "closed",
  consecutiveNoProgress: 0,
  consecutiveSameError: 0,
  lastErrorPattern: null,
  lastProgressIteration: 0,
});

function createTestDeps(): InitToolDeps {
  return {
    getSession: mockGetSession,
    mutateSession: mockMutateSession,
    dispatchPlanGeneration: mockDispatchPlanGeneration,
    createInitialCircuitBreakerState: mockCreateInitialCircuitBreakerState,
  };
}

function getHandler(name: string): (args: unknown) => Promise<unknown> {
  const t = getCapturedTools().get(name);
  if (!t) throw new Error(`Tool ${name} not found in captured tools`);
  return t.handler;
}

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionName: "test-session",
    worktreePath: "/tmp/worktree",
    branchName: "csm/test-session",
    createdAt: new Date().toISOString(),
    creationMode: "fast",
    conversations: [],
    tddEnabled: true,
    workflow: null,
    finished: false,
    ...overrides,
  } as SessionState;
}

const sampleTasks = [
  { description: "Set up database schema", group: 1 },
  { description: "Implement API endpoints", group: 2 },
  { description: "Add integration tests", group: 3 },
];

describe("init-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCapturedTools().clear();
  });

  it("creates an MCP server with the initialize_ralph_loop tool", async () => {
    const { createInitToolServer } = await import("./init-tool");

    const server = createInitToolServer({
      projectPath: "/projects/test",
      sessionName: "test-session",
      projectName: "test",
      broadcast: mockBroadcast,
      deps: createTestDeps(),
    });

    expect(server).toBeDefined();
    expect(getCapturedTools().has("initialize_ralph_loop")).toBe(true);
  });

  it("creates a workflow in planning status with pre-populated fixPlan", async () => {
    const { createInitToolServer } = await import("./init-tool");

    const session = makeSession({ tddEnabled: true, workflow: null });
    mockGetSession.mockResolvedValue(session);
    mockMutateSession.mockImplementation(
      async (
        _path: string,
        _name: string,
        _label: string,
        mutator: (s: SessionState) => unknown,
      ) => {
        const result = mutator(session);
        return result;
      },
    );

    createInitToolServer({
      projectPath: "/projects/test",
      sessionName: "test-session",
      projectName: "test",
      broadcast: mockBroadcast,
      deps: createTestDeps(),
    });

    const handler = getHandler("initialize_ralph_loop");
    const result = (await handler({
      objective: "Implement user authentication",
      tasks: sampleTasks,
    })) as { content: Array<{ text: string }> };

    // Verify workflow creation
    expect(mockMutateSession).toHaveBeenCalledWith(
      "/projects/test",
      "test-session",
      "initTool.createWorkflow",
      expect.any(Function),
    );

    // Verify success response includes task count
    expect(result.content[0]?.text).toContain(
      "Ralph Loop workflow created successfully",
    );
    expect(result.content[0]?.text).toContain("Implement user authentication");
    expect(result.content[0]?.text).toContain("3 tasks");
  });

  it("does not dispatch background plan generation", async () => {
    const { createInitToolServer } = await import("./init-tool");

    const session = makeSession({ tddEnabled: true, workflow: null });
    mockGetSession.mockResolvedValue(session);
    mockMutateSession.mockImplementation(
      async (
        _path: string,
        _name: string,
        _label: string,
        mutator: (s: SessionState) => unknown,
      ) => {
        mutator(session);
        return session.workflow;
      },
    );

    createInitToolServer({
      projectPath: "/projects/test",
      sessionName: "test-session",
      projectName: "test",
      broadcast: mockBroadcast,
      deps: createTestDeps(),
    });

    const handler = getHandler("initialize_ralph_loop");
    await handler({
      objective: "Build API endpoints",
      tasks: [{ description: "Create REST routes", group: 1 }],
    });

    // getSession should only be called once (for the guard check),
    // not a second time for dispatching plan generation
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it("broadcasts workflow-status SSE event with accurate task counts", async () => {
    const { createInitToolServer } = await import("./init-tool");

    const session = makeSession({ tddEnabled: true, workflow: null });
    mockGetSession.mockResolvedValue(session);
    mockMutateSession.mockImplementation(
      async (
        _path: string,
        _name: string,
        _label: string,
        mutator: (s: SessionState) => unknown,
      ) => {
        mutator(session);
        return session.workflow;
      },
    );

    createInitToolServer({
      projectPath: "/projects/test",
      sessionName: "test-session",
      projectName: "test",
      broadcast: mockBroadcast,
      deps: createTestDeps(),
    });

    const handler = getHandler("initialize_ralph_loop");
    await handler({
      objective: "Fix bug",
      tasks: sampleTasks,
    });

    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "workflow-status",
        projectName: "test",
        sessionName: "test-session",
        workflowStatus: "planning",
        iterationCount: 0,
        maxIterations: 20,
        taskProgress: { total: 3, completed: 0, skipped: 0, pending: 3 },
        haltReason: null,
      }),
    );
  });

  it("broadcasts workflow-fix-plan-updated SSE event with full plan", async () => {
    const { createInitToolServer } = await import("./init-tool");

    const session = makeSession({ tddEnabled: true, workflow: null });
    mockGetSession.mockResolvedValue(session);
    mockMutateSession.mockImplementation(
      async (
        _path: string,
        _name: string,
        _label: string,
        mutator: (s: SessionState) => unknown,
      ) => {
        mutator(session);
        return session.workflow;
      },
    );

    createInitToolServer({
      projectPath: "/projects/test",
      sessionName: "test-session",
      projectName: "test",
      broadcast: mockBroadcast,
      deps: createTestDeps(),
    });

    const handler = getHandler("initialize_ralph_loop");
    await handler({
      objective: "Add feature",
      tasks: [{ description: "Implement feature X", group: 1 }],
    });

    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "workflow-fix-plan-updated",
        projectName: "test",
        sessionName: "test-session",
        source: "tool",
        fixPlan: expect.arrayContaining([
          expect.objectContaining({
            description: "Implement feature X",
            group: 1,
            status: "pending",
          }),
        ]),
      }),
    );
  });

  it("returns an error when a workflow already exists (race condition guard)", async () => {
    const { createInitToolServer } = await import("./init-tool");

    const existingWorkflow = {
      status: "running",
      objective: "Already running",
    } as RalphLoopWorkflow;
    const session = makeSession({ workflow: existingWorkflow });
    mockGetSession.mockResolvedValue(session);

    createInitToolServer({
      projectPath: "/projects/test",
      sessionName: "test-session",
      projectName: "test",
      broadcast: mockBroadcast,
      deps: createTestDeps(),
    });

    const handler = getHandler("initialize_ralph_loop");
    const result = (await handler({
      objective: "New workflow",
      tasks: [{ description: "Task 1", group: 1 }],
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("already exists");
    expect(mockMutateSession).not.toHaveBeenCalled();
  });

  it("returns error when session is not found", async () => {
    const { createInitToolServer } = await import("./init-tool");

    mockGetSession.mockResolvedValue(null);

    createInitToolServer({
      projectPath: "/projects/test",
      sessionName: "test-session",
      projectName: "test",
      broadcast: mockBroadcast,
      deps: createTestDeps(),
    });

    const handler = getHandler("initialize_ralph_loop");
    const result = (await handler({
      objective: "Some objective",
      tasks: [{ description: "Task 1", group: 1 }],
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Session not found");
  });

  it("creates workflow with generatingPlan: false and populated fixPlan", async () => {
    const { createInitToolServer } = await import("./init-tool");

    const session = makeSession({ tddEnabled: true, workflow: null });
    mockGetSession.mockResolvedValue(session);

    let capturedWorkflow: RalphLoopWorkflow | null = null;
    mockMutateSession.mockImplementation(
      async (
        _path: string,
        _name: string,
        _label: string,
        mutator: (s: SessionState) => unknown,
      ) => {
        mutator(session);
        capturedWorkflow = session.workflow ?? null;
        return capturedWorkflow;
      },
    );

    createInitToolServer({
      projectPath: "/projects/test",
      sessionName: "test-session",
      projectName: "test",
      broadcast: mockBroadcast,
      deps: createTestDeps(),
    });

    const handler = getHandler("initialize_ralph_loop");
    await handler({
      objective: "Test objective",
      tasks: sampleTasks,
    });

    expect(capturedWorkflow).not.toBeNull();
    expect(capturedWorkflow!.status).toBe("planning");
    expect(capturedWorkflow!.objective).toBe("Test objective");
    expect(capturedWorkflow!.generatingPlan).toBe(false);
    expect(capturedWorkflow!.fixPlan).toHaveLength(3);
    expect(capturedWorkflow!.config.maxIterations).toBe(20);
    expect(capturedWorkflow!.config.circuitBreaker).toEqual({
      noProgressThreshold: 3,
      sameErrorThreshold: 5,
    });
    expect(capturedWorkflow!.circuitBreaker.state).toBe("closed");
    expect(capturedWorkflow!.iterations).toEqual([]);
    expect(capturedWorkflow!.haltReason).toBeNull();
    expect(capturedWorkflow!.totalCostUsd).toBe(0);
    expect(capturedWorkflow!.totalDurationMs).toBe(0);
  });

  it("converts submitted tasks to FixPlanTask entries with correct fields", async () => {
    const { createInitToolServer } = await import("./init-tool");

    const session = makeSession({ tddEnabled: true, workflow: null });
    mockGetSession.mockResolvedValue(session);

    let capturedWorkflow: RalphLoopWorkflow | null = null;
    mockMutateSession.mockImplementation(
      async (
        _path: string,
        _name: string,
        _label: string,
        mutator: (s: SessionState) => unknown,
      ) => {
        mutator(session);
        capturedWorkflow = session.workflow ?? null;
        return capturedWorkflow;
      },
    );

    createInitToolServer({
      projectPath: "/projects/test",
      sessionName: "test-session",
      projectName: "test",
      broadcast: mockBroadcast,
      deps: createTestDeps(),
    });

    const handler = getHandler("initialize_ralph_loop");
    await handler({
      objective: "Build feature",
      tasks: [
        { description: "Create schema", group: 1 },
        { description: "Build API", group: 2 },
      ],
    });

    const plan = capturedWorkflow!.fixPlan as FixPlanTask[];
    expect(plan).toHaveLength(2);

    for (const task of plan) {
      // Each task should have a UUID id
      expect(task.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(task.status).toBe("pending");
      expect(task.createdAt).toBeTruthy();
      expect(task.completedAt).toBeNull();
      expect(task.skipReason).toBeNull();
      expect(task.addedByIteration).toBeNull();
    }

    expect(plan[0]!.description).toBe("Create schema");
    expect(plan[0]!.group).toBe(1);
    expect(plan[1]!.description).toBe("Build API");
    expect(plan[1]!.group).toBe(2);
  });

  it("stores references in the created workflow", async () => {
    const { createInitToolServer } = await import("./init-tool");

    const session = makeSession({ tddEnabled: true, workflow: null });
    mockGetSession.mockResolvedValue(session);

    let capturedWorkflow: RalphLoopWorkflow | null = null;
    mockMutateSession.mockImplementation(
      async (
        _path: string,
        _name: string,
        _label: string,
        mutator: (s: SessionState) => unknown,
      ) => {
        mutator(session);
        capturedWorkflow = session.workflow ?? null;
        return capturedWorkflow;
      },
    );

    createInitToolServer({
      projectPath: "/projects/test",
      sessionName: "test-session",
      projectName: "test",
      broadcast: mockBroadcast,
      deps: createTestDeps(),
    });

    const handler = getHandler("initialize_ralph_loop");
    await handler({
      objective: "Fix testing issues",
      tasks: [{ description: "Refactor config tests", group: 1 }],
      references: [
        {
          filePath: "/tmp/worktree/memory-bank/ralph-reference/audit.md",
          description: "DI audit findings — read when implementing DI changes",
        },
      ],
    });

    expect(capturedWorkflow!.references).toEqual([
      {
        filePath: "/tmp/worktree/memory-bank/ralph-reference/audit.md",
        description: "DI audit findings — read when implementing DI changes",
      },
    ]);
  });

  it("defaults references to empty array when omitted", async () => {
    const { createInitToolServer } = await import("./init-tool");

    const session = makeSession({ tddEnabled: true, workflow: null });
    mockGetSession.mockResolvedValue(session);

    let capturedWorkflow: RalphLoopWorkflow | null = null;
    mockMutateSession.mockImplementation(
      async (
        _path: string,
        _name: string,
        _label: string,
        mutator: (s: SessionState) => unknown,
      ) => {
        mutator(session);
        capturedWorkflow = session.workflow ?? null;
        return capturedWorkflow;
      },
    );

    createInitToolServer({
      projectPath: "/projects/test",
      sessionName: "test-session",
      projectName: "test",
      broadcast: mockBroadcast,
      deps: createTestDeps(),
    });

    const handler = getHandler("initialize_ralph_loop");
    await handler({
      objective: "Build feature",
      tasks: [{ description: "Create schema", group: 1 }],
    });

    expect(capturedWorkflow!.references).toEqual([]);
  });
});
