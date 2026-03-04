import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState, RalphLoopWorkflow } from "@/types";

/**
 * Tests for the Ralph Loop initialization MCP tool server.
 *
 * We mock createSdkMcpServer and tool to capture the handler function,
 * then test it directly with valid/invalid inputs.
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

// Mock dependencies
const mockGetSession = vi.fn();
const mockMutateSession = vi.fn();
const mockBroadcast = vi.fn();
const mockDispatchPlanGeneration = vi.fn();

vi.mock("@/lib/state", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  mutateSession: (...args: unknown[]) => mockMutateSession(...args),
}));

vi.mock("@/lib/ralph-loop/plan-generator", () => ({
  dispatchPlanGeneration: (...args: unknown[]) =>
    mockDispatchPlanGeneration(...args),
}));

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
    workflow: null,
    finished: false,
    ...overrides,
  } as SessionState;
}

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
    });

    expect(server).toBeDefined();
    expect(getCapturedTools().has("initialize_ralph_loop")).toBe(true);
  });

  it("creates a workflow in planning status when no workflow exists", async () => {
    const { createInitToolServer } = await import("./init-tool");

    const session = makeSession({ workflow: null });
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
    });

    const handler = getHandler("initialize_ralph_loop");
    const result = (await handler({
      objective: "Implement user authentication",
    })) as { content: Array<{ text: string }> };

    // Verify workflow creation
    expect(mockMutateSession).toHaveBeenCalledWith(
      "/projects/test",
      "test-session",
      "initTool.createWorkflow",
      expect.any(Function),
    );

    // Verify success response
    expect(result.content[0]?.text).toContain(
      "Ralph Loop workflow created successfully",
    );
    expect(result.content[0]?.text).toContain("Implement user authentication");
  });

  it("dispatches plan generation after creating the workflow", async () => {
    const { createInitToolServer } = await import("./init-tool");

    const session = makeSession({ workflow: null });
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
    });

    const handler = getHandler("initialize_ralph_loop");
    await handler({ objective: "Build API endpoints" });

    expect(mockDispatchPlanGeneration).toHaveBeenCalledWith({
      projectPath: "/projects/test",
      session: expect.objectContaining({ sessionName: "test-session" }),
      workflow: expect.objectContaining({
        status: "planning",
        objective: "Build API endpoints",
      }),
    });
  });

  it("broadcasts a workflow-status SSE event on creation", async () => {
    const { createInitToolServer } = await import("./init-tool");

    const session = makeSession({ workflow: null });
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
    });

    const handler = getHandler("initialize_ralph_loop");
    await handler({ objective: "Fix bug" });

    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "workflow-status",
        projectName: "test",
        sessionName: "test-session",
        workflowStatus: "planning",
        iterationCount: 0,
        maxIterations: 20,
        taskProgress: { total: 0, completed: 0, skipped: 0, pending: 0 },
        haltReason: null,
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
    });

    const handler = getHandler("initialize_ralph_loop");
    const result = (await handler({
      objective: "New workflow",
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("already exists");
    expect(mockMutateSession).not.toHaveBeenCalled();
    expect(mockDispatchPlanGeneration).not.toHaveBeenCalled();
  });

  it("returns error when session is not found", async () => {
    const { createInitToolServer } = await import("./init-tool");

    mockGetSession.mockResolvedValue(null);

    createInitToolServer({
      projectPath: "/projects/test",
      sessionName: "test-session",
      projectName: "test",
      broadcast: mockBroadcast,
    });

    const handler = getHandler("initialize_ralph_loop");
    const result = (await handler({
      objective: "Some objective",
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Session not found");
  });

  it("creates workflow with correct default config shape", async () => {
    const { createInitToolServer } = await import("./init-tool");

    const session = makeSession({ workflow: null });
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
    });

    const handler = getHandler("initialize_ralph_loop");
    await handler({ objective: "Test objective" });

    expect(capturedWorkflow).not.toBeNull();
    expect(capturedWorkflow!.status).toBe("planning");
    expect(capturedWorkflow!.objective).toBe("Test objective");
    expect(capturedWorkflow!.fixPlan).toEqual([]);
    expect(capturedWorkflow!.generatingPlan).toBe(true);
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
});
